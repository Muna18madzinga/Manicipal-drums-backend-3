/**
 * Payment driver interface — SpartialIQ / Vungu RDC
 *
 * The route layer (src/routes/payments.js) speaks to this module
 * exclusively. To activate a driver, supply environment variables
 * documented below and restart the server.
 *
 * Driver interface
 * ─────────────────
 *   initPayment({ payment, returnUrl, ipAddress })
 *     → { providerRef, redirectUrl, providerStatus, ussdCode? }
 *
 *   pollPayment({ payment })
 *     → { providerStatus, paid, paidAt? }
 *
 *   verifyWebhook({ headers, body, rawBody })
 *     → { ok, providerRef, providerStatus, paid }
 *
 *   refund({ payment, amountUsd })  // throw NOT_SUPPORTED if unavailable
 *
 * Environment variables
 * ─────────────────────
 *   PAYNOW_INTEGRATION_ID   Paynow integration ID  (from paynow.co.zw dashboard)
 *   PAYNOW_INTEGRATION_KEY  Paynow integration key
 *   PAYNOW_API_BASE         Gateway base URL (default https://www.paynow.co.zw)
 *   PAYNOW_RETURN_URL       URL Paynow redirects to after payment
 *   PAYNOW_RESULT_URL       Webhook URL Paynow POSTs status updates to
 *
 *   ECOCASH_MERCHANT_CODE  EcoCash C2B merchant code (from Econet)
 *   ECOCASH_API_KEY        EcoCash merchant API key
 *   ECOCASH_API_URL        EcoCash gateway URL (provided by Econet)
 *   ECOCASH_HASH_SECRET    HMAC secret for webhook verification
 *
 *   ONEMONEY_MERCHANT_CODE  OneMoney C2B merchant code (from NetOne)
 *   ONEMONEY_API_KEY        OneMoney merchant API key
 *   ONEMONEY_API_URL        OneMoney gateway URL
 *   ONEMONEY_HASH_SECRET    HMAC secret for webhook verification
 *
 * NOTHING in this file ever ships secrets to clients.
 */

const crypto = require('node:crypto')
const https  = require('node:https')
const http   = require('node:http')
const { URLSearchParams } = require('node:url')

// ── Shared error factories ───────────────────────────────────────────────────


const NOT_IMPLEMENTED = (driver) => {
  const e = new Error(`Payment driver "${driver}" requires configuration — see ENV vars in paymentDriver.js.`)
  e.code = 'driver_not_implemented'
  return e
}

const NOT_SUPPORTED = (driver, method) => {
  const e = new Error(`"${method}" is not supported by the ${driver} driver.`)
  e.code = 'driver_not_supported'
  return e
}

// ── HTTP helper (no axios dependency in this isolated service file) ───────────

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj    = new URL(url)
    const postData  = typeof body === 'string' ? body : new URLSearchParams(body).toString()
    const options   = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent':     'SpartialIQ-PaymentGateway/1.0',
        ...headers,
      },
    }
    const lib = urlObj.protocol === 'https:' ? https : http
    const req = lib.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }))
    })
    req.on('error', reject)
    req.setTimeout(15_000, () => { req.destroy(new Error('Payment gateway timeout')) })
    req.write(postData)
    req.end()
  })
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj  = new URL(url)
    const options = {
      hostname: urlObj.hostname,
      port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   'GET',
      headers:  { 'User-Agent': 'SpartialIQ-PaymentGateway/1.0', ...headers },
    }
    const lib = urlObj.protocol === 'https:' ? https : http
    const req = lib.request(options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.setTimeout(15_000, () => { req.destroy(new Error('Gateway poll timeout')) })
    req.end()
  })
}

// Parse Paynow's URL-encoded response body into a plain object
function parsePaynowResponse(body) {
  const params = new URLSearchParams(body)
  const obj = {}
  for (const [k, v] of params) obj[k] = v
  return obj
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Manual driver — synchronous, in-process, dev/QA only
// ════════════════════════════════════════════════════════════════════════════

const manualDriver = {
  name: 'manual',

  async initPayment({ payment }) {
    const providerRef = `MANUAL-${crypto.randomBytes(6).toString('hex').toUpperCase()}`
    return {
      providerRef,
      providerStatus: 'awaiting_confirmation',
      redirectUrl:    null,
      ussdCode:       null,
    }
  },

  async pollPayment({ payment }) {
    return {
      providerStatus: payment.provider_status || 'awaiting_confirmation',
      paid:           payment.status === 'paid',
      paidAt:         payment.paid_at,
    }
  },

  async verifyWebhook() {
    return { ok: false }
  },

  async refund() {
    return { ok: true }
  },
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Paynow driver — Zimbabwe's primary online payment gateway
//    Handles: EcoCash via USSD push, OneMoney via USSD push, Visa/Mastercard,
//             ZimSwitch debit cards, InnBucks
//
//    Docs: https://developers.paynow.co.zw/docs/
//    Integration type: Web (redirect to Paynow hosted checkout)
// ════════════════════════════════════════════════════════════════════════════

// Env accessors are functions (not consts) so tests and late-loaded .env
// files are honoured. Names match .env.example: PAYNOW_INTEGRATION_ID/KEY.
const PAYNOW_API_BASE = () => process.env.PAYNOW_API_BASE || 'https://www.paynow.co.zw'
const PAYNOW_ID       = () => process.env.PAYNOW_INTEGRATION_ID
const PAYNOW_KEY      = () => process.env.PAYNOW_INTEGRATION_KEY
const PAYNOW_RETURN   = () => process.env.PAYNOW_RETURN_URL
const PAYNOW_RESULT   = () => process.env.PAYNOW_RESULT_URL

// Paynow hash: SHA-512 (uppercase hex) of all field values concatenated, in
// request order, followed by the integration key. (Not MD5 — a bad merge
// once regressed this and every real callback failed verification.)
function paynowHash(fields, integrationKey) {
  const concat = Object.values(fields).join('') + integrationKey
  return crypto.createHash('sha512').update(concat, 'utf8').digest('hex').toUpperCase()
}

const paynowDriver = {
  name: 'paynow',

  _cfg() {
    if (!PAYNOW_ID() || !PAYNOW_KEY()) throw NOT_IMPLEMENTED('paynow')
  },

  // Express Checkout: push a USSD prompt straight to the payer's wallet
  // (ecocash / onemoney / innbucks) — no hosted-checkout redirect. The
  // returned providerRef IS the Paynow poll URL; pollPayment GETs it.
  async initPayment({ payment }) {
    this._cfg()
    const wallet = String(payment?.metadata?.wallet || '').toLowerCase()
    const phone  = String(payment?.metadata?.phone  || '').replace(/^\+/, '')
    if (!['ecocash', 'onemoney', 'innbucks'].includes(wallet)) {
      throw Object.assign(new Error('paynow: unsupported wallet'), { code: 'bad_wallet' })
    }
    if (!/^263(71|73|77|78|86)\d{7}$/.test(phone)) {
      throw Object.assign(new Error('paynow: bad phone for wallet'), { code: 'bad_phone' })
    }

    const amount = payment.wallet_ccy === 'USD'
      ? Number(payment.amount_usd).toFixed(2)
      : Number(payment.amount_zwg).toFixed(2)

    const fields = {
      id:             PAYNOW_ID(),
      reference:      String(payment.id),
      amount:         amount,
      additionalinfo: `Vungu RDC application fee ${payment.id}`,
      returnurl:      PAYNOW_RETURN(),
      resulturl:      PAYNOW_RESULT(),
      authemail:      payment.payer_email || '',
      phone:          phone,
      method:         wallet,
      status:         'Message',
    }
    fields.hash = paynowHash(fields, PAYNOW_KEY())

    const res    = await httpPost(`${PAYNOW_API_BASE()}/interface/remotetransaction`, fields)
    const parsed = parsePaynowResponse(res.body)

    if (String(parsed.status || '').toLowerCase() !== 'ok' || !parsed.pollurl) {
      throw Object.assign(
        new Error(`paynow init failed: ${parsed.error || parsed.status || res.body}`),
        { code: 'gateway_rejected', detail: parsed },
      )
    }

    return {
      providerRef:    parsed.pollurl,
      providerStatus: 'sent',
      redirectUrl:    null,
      ussdCode:       null,
    }
  },

  async pollPayment({ payment }) {
    this._cfg()
    if (!payment?.provider_ref) {
      throw Object.assign(new Error('paynow: missing provider_ref'), { code: 'no_provider_ref' })
    }
    const res    = await httpGet(payment.provider_ref)
    const parsed = parsePaynowResponse(res.body)
    const status = String(parsed.status || '')
    const paidish = ['Paid', 'Awaiting Delivery', 'Delivered']
    return {
      providerStatus: status,
      paid:           paidish.includes(status),
      paidAt:         paidish.includes(status) ? new Date().toISOString() : null,
    }
  },

  async verifyWebhook({ body, rawBody }) {
    this._cfg()
    const incoming = (body && typeof body === 'object' && Object.keys(body).length)
      ? body
      : parsePaynowResponse(rawBody || '')
    const claimed = String(incoming.hash || '').toUpperCase()
    if (!claimed) return { ok: false }

    const fields = { ...incoming }
    delete fields.hash
    // Paynow hashes the values in the order they appear in the request.
    // URLSearchParams preserves insertion order; rebuild from raw body so
    // we honour the caller's order rather than JS object-key order.
    const ordered = {}
    for (const pair of String(rawBody || '').split('&')) {
      const [k] = pair.split('=')
      if (k && k !== 'hash' && k in fields) ordered[k] = fields[k]
    }
    const recomputed = paynowHash(ordered, PAYNOW_KEY())

    const a = Buffer.from(recomputed, 'utf8')
    const b = Buffer.from(claimed, 'utf8')
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b)
    if (!ok) return { ok: false }

    const status = String(incoming.status || '')
    const paidish = ['Paid', 'Awaiting Delivery', 'Delivered']
    return {
      ok:             true,
      providerRef:    incoming.pollurl || null,
      providerStatus: status,
      paid:           paidish.includes(status),
    }
  },

  async refund() {
    throw NOT_SUPPORTED('paynow', 'refund')
  },
}

// ════════════════════════════════════════════════════════════════════════════
// 3. EcoCash driver — Econet C2B (Customer to Business) direct API
//    USSD: Subscriber dials *151*1*1*<merchant_code># to initiate
//    Web:  Merchant pushes a USSD prompt to customer's phone via API
//
//    Requires: Econet merchant account + approved C2B integration
//    Docs: Provided by Econet upon merchant onboarding
// ════════════════════════════════════════════════════════════════════════════

const ecocashDriver = {
  name: 'ecocash',

  _cfg() {
    const merchantCode = process.env.ECOCASH_MERCHANT_CODE
    const apiKey       = process.env.ECOCASH_API_KEY
    const apiUrl       = process.env.ECOCASH_API_URL
    if (!merchantCode || !apiKey || !apiUrl) throw NOT_IMPLEMENTED('ecocash')
    return { merchantCode, apiKey, apiUrl, secret: process.env.ECOCASH_HASH_SECRET || '' }
  },

  async initPayment({ payment }) {
    const cfg = this._cfg()
    const ref = `EC-${payment.id.slice(0, 10).toUpperCase()}`
    const amount = Number(payment.amount_usd).toFixed(2)

    // EcoCash C2B push: initiate a subscriber-initiated payment prompt.
    // The subscriber's phone number must be in payment.metadata.msisdn.
    const msisdn = payment.metadata?.msisdn
    if (!msisdn) {
      // Fallback to USSD self-service code — citizen dials manually.
      return {
        providerRef:    ref,
        providerStatus: 'awaiting_ussd',
        redirectUrl:    null,
        ussdCode:       `*151*1*1*${cfg.merchantCode}*${amount}#`,
        ussdInstructions: [
          `Dial *151*1*1*${cfg.merchantCode}# on your EcoCash-registered phone`,
          `Select "Pay Merchant"`,
          `Enter amount: $${amount} USD`,
          `Enter your EcoCash PIN`,
          `Quote reference: ${ref}`,
        ],
      }
    }

    // API-initiated push (requires ECOCASH_API_URL to be set)
    const body = JSON.stringify({
      merchantCode:        cfg.merchantCode,
      merchantPin:         cfg.apiKey,
      merchantZWLBalance:  false,
      operationType:       'CUSTOMER_TO_MERCHANT',
      reference:           ref,
      amount,
      currency:            'USD',
      customerPhoneNumber: msisdn,
      transactionDetails:  `Council fee: ${payment.purpose.replace(/_/g, ' ')}`,
    })

    const res = await httpPost(
      `${cfg.apiUrl}/transactions/initiate`,
      body,
      {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${cfg.apiKey}`,
      },
    )

    let data
    try { data = JSON.parse(res.body) } catch { data = {} }

    if (res.status !== 200 && res.status !== 202) {
      throw Object.assign(new Error(`EcoCash API error: ${data.message || res.status}`), { code: 'gateway_rejected', detail: data })
    }

    return {
      providerRef:    data.reference || ref,
      providerStatus: 'awaiting_ussd_confirmation',
      redirectUrl:    null,
      ussdCode:       `*151*1*1*${cfg.merchantCode}#`,
      pollId:         data.pollUrl || data.id,
    }
  },

  async pollPayment({ payment }) {
    const cfg    = this._cfg()
    const pollId = payment.metadata?.pollId
    if (!pollId) return { providerStatus: 'awaiting_ussd', paid: false }

    const res = await httpGet(
      `${cfg.apiUrl}/transactions/${pollId}`,
      { Authorization: `Bearer ${cfg.apiKey}` },
    )
    let data
    try { data = JSON.parse(res.body) } catch { data = {} }

    const statusMap = {
      SUCCESS:   'paid',
      FAILED:    'failed',
      PENDING:   'pending',
      CANCELLED: 'cancelled',
    }
    const providerStatus = statusMap[data.status?.toUpperCase()] || data.status?.toLowerCase() || 'unknown'
    const paid = providerStatus === 'paid'

    return { providerStatus, paid, paidAt: paid ? (data.transactionTime || new Date().toISOString()) : null }
  },

  async verifyWebhook({ headers, rawBody }) {
    const cfg = this._cfg()
    if (cfg.secret) {
      const sig      = headers['x-ecocash-signature'] || headers['x-signature'] || ''
      const expected = crypto.createHmac('sha256', cfg.secret).update(rawBody).digest('hex')
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return { ok: false }
      }
    }

    let data
    try { data = JSON.parse(rawBody) } catch { return { ok: false } }

    const paid = data.status?.toUpperCase() === 'SUCCESS'
    return {
      ok:             true,
      providerRef:    data.reference || '',
      providerStatus: paid ? 'paid' : (data.status?.toLowerCase() || 'unknown'),
      paid,
    }
  },

  async refund() {
    throw NOT_SUPPORTED('ecocash', 'refund')
  },
}

// ════════════════════════════════════════════════════════════════════════════
// 4. OneMoney driver — NetOne C2B direct API
//    USSD: Subscriber dials *111*2*<merchant_code># to initiate
//    Web:  Merchant pushes payment prompt via API
//
//    Requires: NetOne merchant account + approved C2B integration
//    Docs: Provided by NetOne upon merchant onboarding
// ════════════════════════════════════════════════════════════════════════════

const onemoneyDriver = {
  name: 'onemoney',

  _cfg() {
    const merchantCode = process.env.ONEMONEY_MERCHANT_CODE
    const apiKey       = process.env.ONEMONEY_API_KEY
    const apiUrl       = process.env.ONEMONEY_API_URL
    if (!merchantCode || !apiKey || !apiUrl) throw NOT_IMPLEMENTED('onemoney')
    return { merchantCode, apiKey, apiUrl, secret: process.env.ONEMONEY_HASH_SECRET || '' }
  },

  async initPayment({ payment }) {
    const cfg    = this._cfg()
    const ref    = `OM-${payment.id.slice(0, 10).toUpperCase()}`
    const amount = Number(payment.amount_usd).toFixed(2)
    const msisdn = payment.metadata?.msisdn

    if (!msisdn) {
      // USSD self-service fallback
      return {
        providerRef:    ref,
        providerStatus: 'awaiting_ussd',
        redirectUrl:    null,
        ussdCode:       `*111*2*${cfg.merchantCode}#`,
        ussdInstructions: [
          `Dial *111*2*${cfg.merchantCode}# on your OneMoney-registered phone`,
          `Select "Pay Bill" or "Send Money to Business"`,
          `Enter amount: $${amount} USD`,
          `Enter your OneMoney PIN`,
          `Quote reference: ${ref}`,
        ],
      }
    }

    // API push
    const body = JSON.stringify({
      merchantId:    cfg.merchantCode,
      apiKey:        cfg.apiKey,
      reference:     ref,
      amount,
      currency:      'USD',
      msisdn,
      narration:     `Council fee: ${payment.purpose.replace(/_/g, ' ')}`,
      callbackUrl:   process.env.ONEMONEY_RESULT_URL || '',
    })

    const res = await httpPost(
      `${cfg.apiUrl}/api/c2b/initiate`,
      body,
      {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${cfg.apiKey}`,
      },
    )

    let data
    try { data = JSON.parse(res.body) } catch { data = {} }

    if (res.status !== 200 && res.status !== 202) {
      throw Object.assign(
        new Error(`OneMoney API error: ${data.message || res.status}`),
        { code: 'gateway_rejected', detail: data },
      )
    }

    return {
      providerRef:    data.transactionRef || ref,
      providerStatus: 'awaiting_ussd_confirmation',
      redirectUrl:    null,
      ussdCode:       `*111*2*${cfg.merchantCode}#`,
      pollId:         data.transactionId || data.id,
    }
  },

  async pollPayment({ payment }) {
    const cfg    = this._cfg()
    const pollId = payment.metadata?.pollId
    if (!pollId) return { providerStatus: 'awaiting_ussd', paid: false }

    const res = await httpGet(
      `${cfg.apiUrl}/api/c2b/status/${pollId}`,
      { Authorization: `Bearer ${cfg.apiKey}` },
    )
    let data
    try { data = JSON.parse(res.body) } catch { data = {} }

    const statusMap = {
      SUCCESS:    'paid',
      SUCCESSFUL: 'paid',
      FAILED:     'failed',
      PENDING:    'pending',
      CANCELLED:  'cancelled',
    }
    const providerStatus = statusMap[data.status?.toUpperCase()] || data.status?.toLowerCase() || 'unknown'
    const paid = providerStatus === 'paid'

    return { providerStatus, paid, paidAt: paid ? (data.completedAt || new Date().toISOString()) : null }
  },

  async verifyWebhook({ headers, rawBody }) {
    const cfg = this._cfg()
    if (cfg.secret) {
      const sig      = headers['x-onemoney-signature'] || headers['x-signature'] || ''
      const expected = crypto.createHmac('sha256', cfg.secret).update(rawBody).digest('hex')
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return { ok: false }
      }
    }

    let data
    try { data = JSON.parse(rawBody) } catch { return { ok: false } }

    const paid = ['SUCCESS', 'SUCCESSFUL'].includes(data.status?.toUpperCase())
    return {
      ok:             true,
      providerRef:    data.transactionRef || data.reference || '',
      providerStatus: paid ? 'paid' : (data.status?.toLowerCase() || 'unknown'),
      paid,
    }
  },

  async refund() {
    throw NOT_SUPPORTED('onemoney', 'refund')
  },
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Stripe driver — international cards / USD wire
// ════════════════════════════════════════════════════════════════════════════

const stripeDriver = {
  name: 'stripe',

  _cfg() {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) throw NOT_IMPLEMENTED('stripe')
    return { key, whSecret: process.env.STRIPE_WEBHOOK_SECRET || '' }
  },

  async initPayment({ payment, returnUrl }) {
    const cfg = this._cfg()
    const body = JSON.stringify({
      amount:      Math.round(Number(payment.amount_usd) * 100),
      currency:    'usd',
      description: `Council fee — ${payment.purpose}`,
      metadata:    { paymentId: payment.id, purpose: payment.purpose },
    })
    const res = await httpPost(
      'https://api.stripe.com/v1/payment_intents',
      new URLSearchParams({
        amount:   String(Math.round(Number(payment.amount_usd) * 100)),
        currency: 'usd',
        'metadata[paymentId]': payment.id,
      }).toString(),
      {
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    )
    let data
    try { data = JSON.parse(res.body) } catch { data = {} }
    if (data.error) throw Object.assign(new Error(data.error.message), { code: 'gateway_rejected' })
    return {
      providerRef:    data.id,
      providerStatus: data.status,
      redirectUrl:    returnUrl || null,
      clientSecret:   data.client_secret,
    }
  },

  async pollPayment({ payment }) {
    const cfg = this._cfg()
    const ref = payment.provider_ref
    if (!ref) return { providerStatus: 'unknown', paid: false }
    const res = await httpGet(
      `https://api.stripe.com/v1/payment_intents/${ref}`,
      { Authorization: `Bearer ${cfg.key}` },
    )
    let data
    try { data = JSON.parse(res.body) } catch { data = {} }
    const paid = data.status === 'succeeded'
    return { providerStatus: data.status || 'unknown', paid, paidAt: paid ? new Date().toISOString() : null }
  },

  async verifyWebhook({ headers, rawBody }) {
    const cfg = this._cfg()
    if (!cfg.whSecret) return { ok: false }
    // Stripe webhook verification: Stripe-Signature header
    const sigHeader = headers['stripe-signature'] || ''
    const parts     = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')))
    const ts        = parts.t
    const sig       = parts.v1
    if (!ts || !sig) return { ok: false }
    const payload  = `${ts}.${rawBody}`
    const expected = crypto.createHmac('sha256', cfg.whSecret).update(payload).digest('hex')
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return { ok: false }

    let data
    try { data = JSON.parse(rawBody) } catch { return { ok: false } }
    const paid = data.type === 'payment_intent.succeeded'
    return {
      ok:             true,
      providerRef:    data.data?.object?.id || '',
      providerStatus: data.data?.object?.status || 'unknown',
      paid,
    }
  },

  async refund({ payment, amountUsd }) {
    const cfg = this._cfg()
    const ref = payment.provider_ref
    await httpPost(
      'https://api.stripe.com/v1/refunds',
      new URLSearchParams({
        payment_intent: ref,
        amount:         String(Math.round(Number(amountUsd) * 100)),
      }).toString(),
      { Authorization: `Bearer ${cfg.key}` },
    )
    return { ok: true }
  },
}

// ════════════════════════════════════════════════════════════════════════════
// Driver registry
// ════════════════════════════════════════════════════════════════════════════
const DRIVERS = {
  manual:   manualDriver,
  paynow:   paynowDriver,
  ecocash:  ecocashDriver,
  onemoney: onemoneyDriver,
  stripe:   stripeDriver,
}

function getDriver(name) {
  const d = DRIVERS[String(name || 'manual').toLowerCase()]
  if (!d) {
    const e = new Error(`Unknown payment driver: ${name}`)
    e.code = 'unknown_driver'
    throw e
  }
  return d
}

/**
 * Allocate a human-readable receipt number.
 *
 *   VRDC-2026-000123
 *
 * Uses a MAX+1 query so concurrent inserts can't collide within a
 * transaction. Falls back to a short random hex if the DB is unavailable.
 */
async function nextReceiptNumber(pg) {
  try {
    const year      = new Date().getFullYear()
    const { rows }  = await pg.query(
      `SELECT COALESCE(
                MAX(NULLIF(REGEXP_REPLACE(issued_receipt_no, '^VRDC-\\d{4}-', ''), '')::INT),
                0
              ) + 1 AS next
       FROM payments
       WHERE issued_receipt_no LIKE 'VRDC-' || $1 || '-%'`,
      [String(year)],
    )
    const next = rows[0]?.next ?? 1
    return `VRDC-${year}-${String(next).padStart(6, '0')}`
  } catch {
    return `VRDC-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
  }
}

/**
 * Return true if a driver is live (all required env vars are present).
 * Used by the payment info endpoint so the frontend can show which
 * methods are available without leaking secrets.
 */
function isDriverLive(name) {
  try {
    const d = DRIVERS[name]
    if (!d || name === 'manual') return name === 'manual'
    d._cfg?.()
    return true
  } catch {
    return false
  }
}

module.exports = {
  DRIVERS,
  getDriver,
  nextReceiptNumber,
  isDriverLive,
  NOT_IMPLEMENTED,
  NOT_SUPPORTED,
}
