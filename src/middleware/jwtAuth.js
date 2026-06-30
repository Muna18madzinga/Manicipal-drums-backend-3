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
 */

const jwt = require('jsonwebtoken')

const ACCESS_TTL  = '12h'
const REFRESH_TTL = '14d'

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
    { sub: payload.id, role: payload.role, email: payload.email, type: 'access' },
    getSecret(),
    { expiresIn: ACCESS_TTL, issuer: 'vungu-portal' },
  )
}

function signRefreshToken(payload) {
  return jwt.sign(
    { sub: payload.id, type: 'refresh' },
    getSecret(),
    { expiresIn: REFRESH_TTL, issuer: 'vungu-portal' },
  )
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
 * Read & verify the bearer token, then re-load the user.
 * Returns the user row, or sends a typed error reply and returns null.
 */
async function authenticate(fastify, request, reply) {
  const authHeader = request.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ success: false, error: 'unauthenticated', message: 'Authentication required' })
    return null
  }

  const token = authHeader.slice(7).trim()

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

module.exports = {
  signAccessToken,
  signRefreshToken,
  signApiToken,
  verifyToken,
  authenticate,
  requireAuth,
  requireRole,
  requireAdmin,
  ACCESS_TTL,
  REFRESH_TTL,
}
