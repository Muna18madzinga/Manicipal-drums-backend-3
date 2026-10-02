/**
 * Bot check for the public auth endpoints: Cloudflare Turnstile (free tier).
 *
 * The browser widget earns a token from Cloudflare, usually without any
 * puzzle; this module redeems it at siteverify. Cloudflare refuses a token
 * the second time it is redeemed (`timeout-or-duplicate`), so a solve works
 * once without any table of our own. Tokens live for 300 s.
 *
 * Fails closed: if siteverify cannot be reached the request is refused, the
 * same as a bad token. Pair with the honeypot field on the client for bots
 * that skip the UI.
 */

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
// Cloudflare's published always-pass test secret, for local development only.
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const TEST_SECRET = '1x0000000000000000000000000000000AA'

function secret() {
  const resolved = process.env.TURNSTILE_SECRET_KEY
  if (resolved) return resolved
  if (process.env.NODE_ENV === 'production') {
    // The test secret passes every token; in production that is no check at all.
    throw new Error('[captcha] TURNSTILE_SECRET_KEY must be set in production')
  }
  return TEST_SECRET
}

/**
 * Redeem a Turnstile token.
 * @param {string} token     the `captcha_token` field from the form
 * @param {string} [remoteip] the caller's IP, passed on as an extra signal
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function verifyCaptchaChallenge(token, remoteip) {
  // Turnstile tokens are at most 2048 characters.
  if (typeof token !== 'string' || !token || token.length > 2048) {
    return { ok: false, reason: 'missing_challenge' }
  }
  let data
  try {
    const res = await fetch(SITEVERIFY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: secret(), response: token, remoteip }),
      signal: AbortSignal.timeout(8000),
    })
    data = await res.json()
  } catch (err) {
    console.error('[captcha] siteverify failed:', err.message)
    return { ok: false, reason: 'unavailable' }
  }
  if (data?.success === true) return { ok: true }
  const codes = Array.isArray(data?.['error-codes']) ? data['error-codes'] : []
  return { ok: false, reason: codes.includes('timeout-or-duplicate') ? 'expired' : 'wrong_answer' }
}

/** True when bots filled the honeypot. */
function honeypotTripped(body) {
  const hp = body?.website ?? body?.company_url ?? body?.fax
  return typeof hp === 'string' && hp.trim().length > 0
}

module.exports = {
  verifyCaptchaChallenge,
  honeypotTripped,
}
