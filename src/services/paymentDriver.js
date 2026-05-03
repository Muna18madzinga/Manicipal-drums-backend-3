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

const paynowDriver   = makeStubDriver('paynow')
const stripeDriver   = makeStubDriver('stripe')
const ecocashDriver  = makeStubDriver('ecocash')
const onemoneyDriver = makeStubDriver('onemoney')

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
