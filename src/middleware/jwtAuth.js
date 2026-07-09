/**
 * JWT authentication middleware.
 *
 * Replaces the legacy `getUserIdFromToken('jwt_<ts>_<uuid>')` parser, which
 * was a string split with no signature and no expiry — anyone could forge a
 * token by guessing or learning a user UUID. This module:
 *   - Signs tokens with HS256 using process.env.JWT_SECRET (required).
 *   - Verifies signature + expiry on every request.
 *   - Re-validates the user against the DB so revoked / suspended users
 *     are kicked out immediately, not at next login.
 *   - Exposes preHandlers usable directly with `fastify.route(..., { preHandler })`.
 *
 * Session-tied access tokens (added for logout invalidation / device
 * revocation / inactivity timeout): access + refresh tokens carry a `sid`
 * claim referencing a row in public.user_session (migration 097). A purely
 * stateless JWT can never support real logout — the token stays valid until
 * it naturally expires. Tying every request to a live session row means
 * logout, admin suspension, and "revoke this device" take effect immediately,
 * and idle sessions can be timed out server-side. Tokens without a `sid`
 * (the long-lived 'api' plugin token, or any token issued before this change)
 * skip the session check and behave exactly as before — no breaking change
 * for the 20+ route files that just call requireAuth/requireRole/requireAdmin.
 */

const jwt = require('jsonwebtoken')
const crypto = require('crypto')

const ACCESS_TTL  = '12h'
const REFRESH_TTL = '14d'
const REFRESH_TTL_MS = 14 * 24 * 60 * 60 * 1000
const SESSION_IDLE_MINUTES = Number(process.env.SESSION_IDLE_MINUTES) || 45

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * Hard-fail at boot if the JWT secret is the placeholder shipped with the
 * repo. This catches the most common mis-deploy where production runs with
 * the example key.
 */
function getSecret() {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < 32) {
    throw new Error(
      '[auth] JWT_SECRET must be set and at least 32 characters. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"'
    )
  }
  if (process.env.NODE_ENV === 'production' && secret.includes('change-in-production')) {
    throw new Error('[auth] Refusing to run in production with the placeholder JWT secret.')
  }
  return secret
}

function signAccessToken(payload) {
  return jwt.sign(
    { sub: payload.id, role: payload.role, email: payload.email, type: 'access', sid: payload.sid || null },
    getSecret(),
    { expiresIn: ACCESS_TTL, issuer: 'vungu-portal' },
  )
}

function signRefreshToken(payload) {
  return jwt.sign(
    { sub: payload.id, type: 'refresh', sid: payload.sid || null },
    getSecret(),
    { expiresIn: REFRESH_TTL, issuer: 'vungu-portal' },
  )
}

/**
 * Start a new session: insert the user_session row, then sign a matching
 * access + refresh token pair carrying that session's id. Call this from
 * login / MFA challenge / invite-accept / register — anywhere a fresh pair
 * of tokens is issued.
 */
async function createSession(fastify, user, request) {
  // Placeholder hash reserves the row so we have a sid to embed in the real
  // tokens; overwritten below with the actual refresh token's hash.
  const placeholder = crypto.randomBytes(32).toString('hex')
  const { rows } = await fastify.pg.query(
    `INSERT INTO public.user_session (user_id, refresh_token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '14 days')
     RETURNING id`,
    [user.id, placeholder, request?.headers?.['user-agent'] || null,
     request?.headers?.['x-forwarded-for']?.split(',')[0] || request?.ip || null],
  )
  const sid = rows[0].id
  const refreshToken = signRefreshToken({ id: user.id, sid })
  await fastify.pg.query(
    'UPDATE public.user_session SET refresh_token_hash = $1 WHERE id = $2',
    [hashToken(refreshToken), sid],
  )
  const accessToken = signAccessToken({ id: user.id, role: user.role, email: user.email, sid })
  return { accessToken, refreshToken, sid }
}

/** Revoke one session row (logout, or admin/self "revoke this device"). */
async function revokeSession(fastify, sessionId) {
  await fastify.pg.query(
    'UPDATE public.user_session SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL',
    [sessionId],
  )
}

/** List a user's own active (non-revoked, non-expired) sessions. */
async function listSessions(fastify, userId) {
  const { rows } = await fastify.pg.query(
    `SELECT id, user_agent, ip, created_at, last_used_at, expires_at
       FROM public.user_session
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
      ORDER BY last_used_at DESC`,
    [userId],
  )
  return rows
}

// Short-lived token proving "password already verified, MFA still owed".
// Deliberately a distinct type so it can never be accepted by requireAuth.
function signMfaPendingToken(userId) {
  return jwt.sign({ sub: userId, type: 'mfa_pending' }, getSecret(),
    { expiresIn: '5m', issuer: 'vungu-portal' })
}

function verifyMfaPendingToken(token) {
  const claims = verifyToken(token)
  if (claims.type !== 'mfa_pending') throw new Error('wrong_token_type')
  return claims
}

// Long-lived, signed token for the QGIS plugin / API integrations.
// Replaces the old guessable `vungu-api-<random>` format that any client
// could forge. Carries type:'api' so it can never be used as a user session.
function signApiToken(payload) {
  return jwt.sign(
    { sub: payload.id, type: 'api', plugin: payload.pluginName || null },
    getSecret(),
    { expiresIn: '365d', issuer: 'vungu-portal' },
  )
}

function verifyToken(token) {
  return jwt.verify(token, getSecret(), { issuer: 'vungu-portal' })
}

/**
 * Read & verify the access token (httpOnly cookie, falling back to the
 * Bearer header for non-browser clients like the QGIS plugin), then
 * re-load the user. Returns the user row, or sends a typed error reply
 * and returns null.
 */
async function authenticate(fastify, request, reply) {
  const authHeader = request.headers.authorization
  const token = request.cookies?.vungu_at
    || (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null)

  if (!token) {
    reply.code(401).send({ success: false, error: 'unauthenticated', message: 'Authentication required' })
    return null
  }

  let claims
  try {
    claims = verifyToken(token)
  } catch (err) {
    const message = err.name === 'TokenExpiredError'
      ? 'Session expired'
      : 'Invalid token'
    reply.code(401).send({ success: false, error: 'unauthenticated', message })
    return null
  }

  if (claims.type !== 'access') {
    reply.code(401).send({ success: false, error: 'unauthenticated', message: 'Wrong token type' })
    return null
  }

  // Session liveness + inactivity timeout. Tokens minted before this change
  // (or the long-lived 'api' token, which never carries sid) skip this check.
  if (claims.sid) {
    const { rows: sessionRows } = await fastify.pg.query(
      `SELECT id, revoked_at, expires_at, last_used_at FROM public.user_session WHERE id = $1`,
      [claims.sid],
    )
    const session = sessionRows[0]
    if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
      reply.code(401).send({ success: false, error: 'unauthenticated', message: 'Session ended' })
      return null
    }
    const idleMs = Date.now() - new Date(session.last_used_at).getTime()
    if (idleMs > SESSION_IDLE_MINUTES * 60 * 1000) {
      await revokeSession(fastify, claims.sid)
      reply.code(401).send({
        success: false, error: 'session_idle_timeout',
        message: `Signed out after ${SESSION_IDLE_MINUTES} minutes of inactivity.`,
      })
      return null
    }
    // Best-effort activity ping; a failure here must not block the request.
    fastify.pg.query('UPDATE public.user_session SET last_used_at = NOW() WHERE id = $1', [claims.sid])
      .catch((err) => request.log.error({ err }, 'session activity update failed'))
  }

  // Re-validate against DB: catches suspension, deletion, role changes.
  const { rows } = await fastify.pg.query(
    `SELECT id, email, COALESCE(full_name, name) AS name, role, organization,
            job_title, department, phone, applicant_type,
            national_id, physical_address, active, status
     FROM users WHERE id = $1`,
    [claims.sub],
  )
  if (rows.length === 0) {
    reply.code(401).send({ success: false, error: 'unauthenticated', message: 'User no longer exists' })
    return null
  }
  const user = rows[0]
  if (!user.active || user.status === 'suspended') {
    reply.code(403).send({ success: false, error: 'account_suspended', message: 'Account suspended' })
    return null
  }

  request.user = user
  request.sessionId = claims.sid || null
  return user
}

/**
 * Fastify preHandler: requires a valid access token.
 * Use as: `{ preHandler: requireAuth }`
 */
function requireAuth(fastify) {
  return async (request, reply) => {
    await authenticate(fastify, request, reply)
  }
}

/**
 * Fastify preHandler: requires the user to have one of the allowed roles.
 */
function requireRole(fastify, allowed) {
  const allowedSet = new Set(Array.isArray(allowed) ? allowed : [allowed])
  return async (request, reply) => {
    const user = await authenticate(fastify, request, reply)
    if (!user) return
    if (!allowedSet.has(user.role)) {
      reply.code(403).send({
        success: false,
        error: 'forbidden',
        message: 'Insufficient permissions for this action',
      })
    }
  }
}

const requireAdmin = (fastify) => requireRole(fastify, 'admin')

// ── Cookie helpers ──────────────────────────────────────────────────────
// httpOnly + Secure (outside dev) + SameSite=Lax. Lax (not Strict) so a
// citizen following an external link (e.g. a payment gateway redirect back)
// still carries the cookie on that top-level GET navigation.
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
}

function setAuthCookies(reply, { accessToken, refreshToken }) {
  reply.setCookie('vungu_at', accessToken, { ...COOKIE_OPTS, maxAge: 12 * 60 * 60 })
  reply.setCookie('vungu_rt', refreshToken, { ...COOKIE_OPTS, maxAge: REFRESH_TTL_MS / 1000, path: '/api/auth' })
}

function clearAuthCookies(reply) {
  reply.clearCookie('vungu_at', { path: '/' })
  reply.clearCookie('vungu_rt', { path: '/api/auth' })
}

// ── MFA (TOTP) ──────────────────────────────────────────────────────────
const { authenticator } = require('otplib')

function generateMfaSecret(email) {
  const secret = authenticator.generateSecret()
  return { secret, otpauthUrl: authenticator.keyuri(email, 'Vungu RDC', secret) }
}

function verifyMfaToken(secret, token) {
  if (!secret || !token) return false
  try {
    return authenticator.verify({ token: String(token).trim(), secret })
  } catch {
    return false
  }
}

function generateBackupCodes(count = 8) {
  return Array.from({ length: count }, () => crypto.randomBytes(5).toString('hex'))
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  signApiToken,
  verifyToken,
  authenticate,
  requireAuth,
  requireRole,
  requireAdmin,
  createSession,
  revokeSession,
  listSessions,
  hashToken,
  setAuthCookies,
  clearAuthCookies,
  generateMfaSecret,
  verifyMfaToken,
  generateBackupCodes,
  signMfaPendingToken,
  verifyMfaPendingToken,
  ACCESS_TTL,
  REFRESH_TTL,
}
