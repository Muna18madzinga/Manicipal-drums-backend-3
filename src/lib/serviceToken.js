/**
 * Service tokens: how SurveyPro (a separate system) asks VunGIS a question on behalf of a person.
 *
 * The mirror of the launch token (src/lib/launchToken.js): a compact JWT signed with Ed25519 ("EdDSA"). SurveyPro holds the private key;
 * VunGIS holds only the public key, so it can check a token is genuine but can never make one. It is short-lived (five minutes) and names
 *   sub        the person (their email, lower-case): SurveyPro vouches that they are signed in there
 *   authority  the council's code: SurveyPro vouches that the person is appointed to it
 *   scp        what the token is for ("check-layout"); a token for one purpose is refused for another
 * VunGIS does not know SurveyPro's appointments and does not need to: SurveyPro vouches for the person, VunGIS checks everything it can see for
 * itself (the council exists, the data asked about is the council's). Read-only questions only; nothing in this token lets SurveyPro write.
 *
 * Configuration (environment):
 *   SURVEYPRO_SERVICE_PUBLIC_KEY   SurveyPro's public key, PEM (SPKI). Newlines may be written as \n.
 *   SURVEYPRO_SERVICE_KEY_FILE     or the path of a file holding it
 * docs/HARMONIZATION-SCOPE.md, "Authentication SurveyPro to VunGIS".
 */
const crypto = require('node:crypto')
const fs = require('node:fs')

const ISSUER = 'surveypro'
const AUDIENCE = 'vungis'
const MAX_LIFETIME_SECONDS = 600       // a token claiming to live longer than this is refused, whatever its signature

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const fromB64u = (s) => Buffer.from(s, 'base64url')

/** SurveyPro's public key from the environment, or null if none is configured. */
function loadPublicKey(env = process.env) {
  let pem = env.SURVEYPRO_SERVICE_PUBLIC_KEY
  if (!pem && env.SURVEYPRO_SERVICE_KEY_FILE && fs.existsSync(env.SURVEYPRO_SERVICE_KEY_FILE)) pem = fs.readFileSync(env.SURVEYPRO_SERVICE_KEY_FILE, 'utf8')
  if (!pem) return null
  return crypto.createPublicKey(pem.replace(/\\n/g, '\n'))
}

/**
 * Verify a token. Throws an Error whose message says what is wrong; returns the claims when it is good.
 *   scope  the purpose this endpoint serves; the token must carry exactly it
 */
function verify(token, { publicKey, scope, now = Math.floor(Date.now() / 1000), skew = 60 } = {}) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) throw new Error('not a token')
  const [h, p, s] = parts
  let header, claims
  try { header = JSON.parse(fromB64u(h).toString()); claims = JSON.parse(fromB64u(p).toString()) } catch { throw new Error('not a token') }
  if (header.alg !== 'EdDSA') throw new Error('wrong algorithm')       // never accept "none" or a symmetric alg here
  if (!publicKey) throw new Error('no key')
  if (!crypto.verify(null, Buffer.from(`${h}.${p}`), publicKey, fromB64u(s))) throw new Error('bad signature')
  if (claims.iss !== ISSUER) throw new Error('wrong issuer')
  if (claims.aud !== AUDIENCE) throw new Error('wrong audience')
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') throw new Error('no lifetime')
  if (now > claims.exp + skew) throw new Error('expired')
  if (now + skew < claims.iat) throw new Error('not yet valid')
  if (claims.exp - claims.iat > MAX_LIFETIME_SECONDS) throw new Error('lifetime too long')
  if (!claims.jti) throw new Error('no token id')
  if (!claims.sub || !claims.authority) throw new Error('no person or authority')
  if (scope && claims.scp !== scope) throw new Error('wrong purpose')
  return claims
}

/** Sign claims. SurveyPro does this in its own repository; it lives here so the contract is tested from both ends. */
function sign(claims, { privateKey, kid = 'surveypro-1', now = Math.floor(Date.now() / 1000), ttl = 300 } = {}) {
  if (!privateKey) throw new Error('no signing key')
  const full = { iss: ISSUER, aud: AUDIENCE, iat: now, exp: now + ttl, jti: crypto.randomUUID(), ...claims }
  const input = `${b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }))}.${b64u(JSON.stringify(full))}`
  return { token: `${input}.${b64u(crypto.sign(null, Buffer.from(input), privateKey))}`, claims: full }
}

module.exports = { ISSUER, AUDIENCE, MAX_LIFETIME_SECONDS, loadPublicKey, verify, sign }
