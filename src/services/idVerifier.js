/**
 * Identity / document verification.
 *
 * Same shape as paymentDriver.js — a verifier interface, with a working
 * 'manual' implementation (operator marks pass/fail) and provider stubs
 * (Smile ID, Onfido) that throw NOT_IMPLEMENTED until configured.
 *
 * Verifier contract:
 *   verify({ doc, fileBuffer })
 *     → {
 *         status:      'verified' | 'rejected' | 'under_review',
 *         confidence:  number in [0,1] | null,
 *         provider:    string,
 *         payload:     object,
 *         extracted: { name?, idNumber?, dob?, expiry? }  // optional
 *       }
 *
 * The route layer never inspects the raw provider response except to
 * persist it for audit; downstream business rules read only `status`
 * and the optional `extracted` fields.
 */

const NOT_IMPLEMENTED = (verifier) => {
  const e = new Error(`Document verifier ${verifier} is not implemented yet.`)
  e.code = 'verifier_not_implemented'
  return e
}

// ════════════════════════════════════════════════════════════════════
// Manual verifier — staff approve through /documents/:id/verify.
// verify() is a no-op that leaves the doc in 'under_review' so a human
// can review.
// ════════════════════════════════════════════════════════════════════
const manualVerifier = {
  name: 'manual',
  async verify({ doc }) {
    return {
      status: 'under_review',
      confidence: null,
      provider: 'manual',
      payload: { note: 'Awaiting staff review' },
      extracted: {},
    }
  },
}

const smileIdVerifier = {
  name: 'smile_id',
  async verify() { throw NOT_IMPLEMENTED('smile_id') },
}
const onfidoVerifier = {
  name: 'onfido',
  async verify() { throw NOT_IMPLEMENTED('onfido') },
}

const VERIFIERS = {
  manual:    manualVerifier,
  smile_id:  smileIdVerifier,
  onfido:    onfidoVerifier,
}

function getVerifier(name) {
  const v = VERIFIERS[String(name || 'manual').toLowerCase()]
  if (!v) {
    const e = new Error(`Unknown verifier: ${name}`)
    e.code = 'unknown_verifier'
    throw e
  }
  return v
}

module.exports = { VERIFIERS, getVerifier, NOT_IMPLEMENTED }
