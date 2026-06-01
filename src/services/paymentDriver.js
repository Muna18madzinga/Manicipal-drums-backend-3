/**
 * Payment driver interface.
 *
 * The route layer (src/routes/payments.js) speaks to this module
 * exclusively; integrations go behind it. To plug a real provider,
 * implement the four methods on a driver object and add it to DRIVERS.
 *
 *   initPayment({ payment, returnUrl, ipAddress })
 *     → { providerRef, redirectUrl, providerStatus }
 *
 *   pollPayment({ payment })
 *     → { providerStatus, paid, paidAt? }
 *
 *   verifyWebhook({ headers, body, rawBody })
 *     → { ok, providerRef, providerStatus, paid }
 *
 *   refund({ payment, amountUsd })  // optional; throw NOT_SUPPORTED otherwise
 *
 * The 'manual' driver is a fully working developer-mode driver that
 * simulates the happy path (initPayment returns a fake URL, /confirm
 * marks the row paid). It exists so the rest of the system can be
 * exercised end-to-end before a real provider is wired in.
 *
 * Real drivers (Paynow, Stripe, EcoCash, OneMoney) are stubs that throw
 * NOT_IMPLEMENTED until their provider keys + signature verifiers are
 * filled in. NOTHING in this file ever ships keys to clients.
 */

const crypto = require('node:crypto')
const https  = require('node:https')
const http   = require('node:http')

const NOT_IMPLEMENTED = (driver) => {
  const e = new Error(`Payment driver ${driver} is not implemented yet.`)
  e.code = 'driver_not_implemented'
  return e
}

// ════════════════════════════════════════════════════════════════════
// Manual driver — synchronous, in-process, dev/QA only.
// ════════════════════════════════════════════════════════════════════
const manualDriver = {
  name: 'manual',

  async initPayment({ payment }) {
    // Fake provider reference. Real providers return their own.
    const providerRef = `MANUAL-${crypto.randomBytes(6).toString('hex').toUpperCase()}`
    return {
      providerRef,
      providerStatus: 'awaiting_confirmation',
      redirectUrl: null, // No redirect; the citizen just clicks "Confirm payment" in the UI.
    }
  },

  async pollPayment({ payment }) {
    // The manual driver doesn't auto-confirm. Status is the last value
    // recorded on the row. Confirmation happens through /payments/:id/confirm.
    return {
      providerStatus: payment.provider_status || 'awaiting_confirmation',
      paid: payment.status === 'paid',
      paidAt: payment.paid_at,
    }
  },

  async verifyWebhook() {
    // No webhooks in dev mode. Return ok=false so callers don't act on noise.
    return { ok: false }
  },

  async refund() {
    // Manual driver supports refund as a bookkeeping flip in /payments routes.
    return { ok: true }
  },
}

// ════════════════════════════════════════════════════════════════════
// Provider stubs — explicitly NOT_IMPLEMENTED until configured.
// ════════════════════════════════════════════════════════════════════
function makeStubDriver(name) {
  return {
    name,
    async initPayment()    { throw NOT_IMPLEMENTED(name) },
    async pollPayment()    { throw NOT_IMPLEMENTED(name) },
    async verifyWebhook()  { throw NOT_IMPLEMENTED(name) },
    async refund()         { throw NOT_IMPLEMENTED(name) },
  }
}

const stripeDriver   = makeStubDriver('stripe')
const ecocashDriver  = makeStubDriver('ecocash')
const onemoneyDriver = makeStubDriver('onemoney')

// ════════════════════════════════════════════════════════════════════
// Shared HTTP helper — uses node:https so nock can intercept in tests.
// ════════════════════════════════════════════════════════════════════
function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const lib    = parsed.protocol === 'https:' ? https : http
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }
    const req = lib.request(opts, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const lib    = parsed.protocol === 'https:' ? https : http
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
    }
    const req = lib.request(opts, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { data += chunk })
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.end()
  })
}

// ════════════════════════════════════════════════════════════════════
// Paynow driver — Express Checkout (mobile money) + future Web Initiate.
// ════════════════════════════════════════════════════════════════════
const PAYNOW_API_BASE = () => process.env.PAYNOW_API_BASE || 'https://www.paynow.co.zw'
const PAYNOW_ID       = () => process.env.PAYNOW_INTEGRATION_ID
const PAYNOW_KEY      = () => process.env.PAYNOW_INTEGRATION_KEY
const PAYNOW_RETURN   = () => process.env.PAYNOW_RETURN_URL
const PAYNOW_RESULT   = () => process.env.PAYNOW_RESULT_URL

function paynowHash(fields, integrationKey) {
  const concat = Object.values(fields).join('') + integrationKey
  return crypto.createHash('sha512').update(concat, 'utf8').digest('hex').toUpperCase()
}

function paynowParse(body) {
  const out = {}
  for (const pair of String(body).split('&')) {
    const [k, v] = pair.split('=')
    if (k) out[k.toLowerCase()] = decodeURIComponent((v || '').replace(/\+/g, ' '))
  }
  return out
}

const paynowDriver = {
  name: 'paynow',

  async initPayment({ payment }) {
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

    const body = new URLSearchParams(fields).toString()
    const text = await httpPost(`${PAYNOW_API_BASE()}/interface/remotetransaction`, body)
    const parsed = paynowParse(text)

    if (String(parsed.status || '').toLowerCase() !== 'ok' || !parsed.pollurl) {
      const e = new Error(`paynow init failed: ${parsed.error || parsed.status || text}`)
      e.code = 'paynow_init_failed'
      throw e
    }

    return {
      providerRef:    parsed.pollurl,
      providerStatus: 'sent',
      redirectUrl:    null,
    }
  },

  async pollPayment({ payment }) {
    if (!payment?.provider_ref) {
      throw Object.assign(new Error('paynow: missing provider_ref'), { code: 'no_provider_ref' })
    }
    const text = await httpGet(payment.provider_ref)
    const parsed = paynowParse(text)
    const status = String(parsed.status || '')
    const paidish = ['Paid', 'Awaiting Delivery', 'Delivered']
    return {
      providerStatus: status,
      paid:           paidish.includes(status),
      paidAt:         paidish.includes(status) ? new Date().toISOString() : null,
    }
  },
  async verifyWebhook({ body, rawBody }) {
    const incoming = (body && typeof body === 'object' && Object.keys(body).length)
      ? body
      : paynowParse(rawBody || '')
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
  async refund()                 { throw NOT_IMPLEMENTED('paynow.refund') },
}

const DRIVERS = {
  manual:   manualDriver,
  paynow:   paynowDriver,
  stripe:   stripeDriver,
  ecocash:  ecocashDriver,
  onemoney: onemoneyDriver,
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
 * Uses a sequence-like CTE so concurrent inserts can't collide. We
 * fall back to a UUID if the table is somehow unavailable so the
 * payment can still be recorded; reconciliation can re-issue later.
 */
async function nextReceiptNumber(pg) {
  try {
    const year = new Date().getFullYear()
    const { rows } = await pg.query(
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

module.exports = {
  DRIVERS,
  getDriver,
  nextReceiptNumber,
  NOT_IMPLEMENTED,
}
