/**
 * Launch tokens: how VunGIS hands a surveyor, and the job they are working on, to SurveyPro.
 *
 * A compact JWT signed with Ed25519 (alg "EdDSA"). VunGIS holds the private key; SurveyPro holds only the public key, so SurveyPro
 * can check a token is genuine but can never make one. It is short-lived (10 minutes by default) and carries a unique id (jti) that
 * SurveyPro records on first use, so a token that leaks cannot be replayed.
 *
 * Nothing here talks to the network or the database: it signs, verifies and builds the claims. docs/SURVEYPRO-INTEGRATION.md is the
 * contract; src/routes/surveyor.js issues one (POST /surveyor/jobs/:id/launch).
 *
 * Configuration (environment):
 *   SURVEYPRO_LAUNCH_PRIVATE_KEY   the private key, PEM (PKCS#8). Newlines may be written as \n.
 *   SURVEYPRO_LAUNCH_KEY_FILE      or the path of a file holding it (scripts/generate-launch-keys.js writes one)
 *   SURVEYPRO_LAUNCH_KEY_ID        names the key in the token header (kid), so a key can be rotated; default "vungis-1"
 *   SURVEYPRO_URL                  where SurveyPro's web application is served, e.g. https://survey.example.org
 */
const crypto = require('node:crypto')
const fs = require('node:fs')

const ISSUER = 'vungis'
const AUDIENCE = 'surveypro'
const DEFAULT_TTL_SECONDS = 600

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const fromB64u = (s) => Buffer.from(s, 'base64url')

/** The signing key from the environment, or null if none is configured. */
function loadPrivateKey(env = process.env) {
  let pem = env.SURVEYPRO_LAUNCH_PRIVATE_KEY
  if (!pem && env.SURVEYPRO_LAUNCH_KEY_FILE && fs.existsSync(env.SURVEYPRO_LAUNCH_KEY_FILE)) pem = fs.readFileSync(env.SURVEYPRO_LAUNCH_KEY_FILE, 'utf8')
  if (!pem) return null
  return crypto.createPrivateKey(pem.replace(/\\n/g, '\n'))
}

const keyId = (env = process.env) => env.SURVEYPRO_LAUNCH_KEY_ID || 'vungis-1'

/** Sign claims. `now` is seconds since the epoch (injectable for tests). Returns { token, claims }. */
function sign(claims, { privateKey, kid = 'vungis-1', now = Math.floor(Date.now() / 1000), ttl = DEFAULT_TTL_SECONDS } = {}) {
  if (!privateKey) throw new Error('no launch signing key is configured (SURVEYPRO_LAUNCH_PRIVATE_KEY or SURVEYPRO_LAUNCH_KEY_FILE)')
  const full = { iss: ISSUER, aud: AUDIENCE, iat: now, nbf: now, exp: now + ttl, jti: crypto.randomUUID(), ...claims }
  const header = { alg: 'EdDSA', typ: 'JWT', kid }
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(full))}`
  const signature = crypto.sign(null, Buffer.from(input), privateKey)
  return { token: `${input}.${b64u(signature)}`, claims: full }
}

/**
 * Verify a token with a public key. Throws an Error whose message says what is wrong; returns the claims when it is good.
 * (VunGIS never needs this at run time; SurveyPro has the same logic in its own repository. It lives here so the contract is tested
 * from both ends and so a key pair can be checked with scripts/generate-launch-keys.js --check.)
 */
function verify(token, { publicKey, now = Math.floor(Date.now() / 1000), skew = 60, audience = AUDIENCE } = {}) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) throw new Error('not a token')
  const [h, p, s] = parts
  let header, claims
  try { header = JSON.parse(fromB64u(h).toString()); claims = JSON.parse(fromB64u(p).toString()) } catch { throw new Error('not a token') }
  if (header.alg !== 'EdDSA') throw new Error('wrong algorithm')   // never accept "none" or a symmetric alg here
  if (!crypto.verify(null, Buffer.from(`${h}.${p}`), publicKey, fromB64u(s))) throw new Error('bad signature')
  if (claims.iss !== ISSUER) throw new Error('wrong issuer')
  if (claims.aud !== audience) throw new Error('wrong audience')
  if (typeof claims.exp !== 'number' || now > claims.exp + skew) throw new Error('expired')
  if (typeof claims.nbf === 'number' && now + skew < claims.nbf) throw new Error('not yet valid')
  if (!claims.jti) throw new Error('no token id')
  return claims
}

/** A calendar date as YYYY-MM-DD. The driver returns a DATE column as a Date at LOCAL midnight, so read it with local parts. */
function isoDate(v) {
  if (!v) return null
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0')
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v))
  return m ? m[1] : null
}

/**
 * The claims for one job and the person launching it. `task` is a row of spatial_planning.v_survey_task (joined to its authority);
 * `user` is the signed-in VunGIS user. Only what SurveyPro needs to open the job, nothing about the applicant.
 */
function claimsForJob(task, user) {
  return {
    sub: String(user.email).toLowerCase(),
    name: user.name || user.full_name || user.email,
    authority: { code: task.authority_code, name: task.authority_name },
    job: {
      id: task.id,
      task_type: task.task_type,
      stand_number: task.stand_number || null,
      suburb_ward: task.suburb_ward || null,
      gauss_lo: task.gauss_lo,
      instructions: task.instructions || null,
      due_date: isoDate(task.due_date),
      location: task.lon != null && task.lat != null ? { lon: Number(task.lon), lat: Number(task.lat) } : null,
      permit_ref: task.permit_ref || null,
    },
  }
}

/** Where to send the surveyor: SurveyPro's /launch page with the token. */
function launchUrl(token, env = process.env) {
  const base = String(env.SURVEYPRO_URL || '').replace(/\/+$/, '')
  if (!base) throw new Error('SURVEYPRO_URL is not set: VunGIS does not know where SurveyPro is')
  return `${base}/launch?token=${encodeURIComponent(token)}`
}

module.exports = { sign, verify, claimsForJob, launchUrl, loadPrivateKey, keyId, ISSUER, AUDIENCE, DEFAULT_TTL_SECONDS }
