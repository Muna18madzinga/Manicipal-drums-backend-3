// src/middleware/maintenanceMode.js
// ─────────────────────────────────────────────────────────────────────────
// Makes `system.maintenance_mode` mean something.
//
// When the council's IT Admin turns it on, every request that would CHANGE a
// council record is refused with 503 and the council's own message. Reads stay
// open, so a citizen checking their application still sees it and a planner
// can still open a case — the point of a maintenance window is to stop writes
// landing mid-migration, not to take the district offline.
//
// WHO IS EXEMPT
// The IT Admin, and only them. Someone has to be able to turn it back off,
// finish the data fix it was declared for, and verify the result. Every other
// role — including the EO — is held, because "everyone except the person doing
// the work" is the whole idea.
//
// COST
// One getSetting() per mutating request, served from the 30-second cache in
// adminSettings.js. GETs return before touching it, which is the great
// majority of the traffic.
//
// FAILURE POSTURE
// Fails OPEN. If the setting cannot be read, the request proceeds: a council
// unable to record an inspection because the settings table is unreachable is
// a worse outcome than a write landing during a window.
// ─────────────────────────────────────────────────────────────────────────

const { getSettings } = require('../services/adminSettings')
const { verifyToken } = require('./jwtAuth')
const fp = require('fastify-plugin')

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Paths that stay open even during a window.
 *
 * Sign-in has to work or the admin cannot get in to turn it off; sign-out has
 * to work or a session cannot be ended; and the admin console's own endpoints
 * are how the window is managed. Note this is a prefix list on the FULL url,
 * which carries the /api prefix.
 */
const ALWAYS_OPEN = [
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/refresh',
  '/api/auth/mfa',
  '/api/admin/',
]

async function maintenanceMode(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    if (!MUTATING.has(request.method)) return
    const url = request.url || ''
    if (ALWAYS_OPEN.some((p) => url.startsWith(p))) return

    let on = false
    let message = ''
    try {
      const s = await getSettings(fastify, ['system.maintenance_mode', 'system.maintenance_message'])
      on = s['system.maintenance_mode'] === true
      message = s['system.maintenance_message']
    } catch (err) {
      fastify.log.warn({ err }, 'maintenance mode check failed; allowing request')
      return
    }
    if (!on) return

    // The exemption has to be worked out here rather than read off
    // request.user: an instance-level preHandler runs BEFORE each route's own,
    // so request.user is not populated yet and `request.user?.role === 'admin'`
    // would be false for everyone — including the admin trying to turn the
    // window back off.
    //
    // The role is re-read from the database rather than taken from the token's
    // `role` claim, because an access token lives 12 hours and an admin
    // demoted an hour ago would still carry `role: 'admin'` in it. This costs
    // one indexed lookup, and only on mutating requests while a window is
    // actually open.
    if (await isAdmin(fastify, request)) return

    return reply.code(503).send({
      success: false,
      error: 'maintenance',
      message: message || 'The portal is under maintenance. Please try again shortly.',
    })
  })
}

/**
 * Whether the caller is a live IT Admin. Any doubt — no token, an expired one,
 * a database that will not answer — is NOT an admin, so the window holds.
 */
async function isAdmin(fastify, request) {
  try {
    const header = request.headers.authorization
    const token = request.cookies?.vungu_at
      || (header && header.startsWith('Bearer ') ? header.slice(7).trim() : null)
    if (!token) return false

    const claims = verifyToken(token)
    if (claims.type !== 'access' || !claims.sub) return false

    const { rows } = await fastify.pg.query(
      'SELECT role FROM public.users WHERE id = $1 AND deleted_at IS NULL AND active',
      [claims.sub],
    )
    return rows[0]?.role === 'admin'
  } catch {
    return false
  }
}

// fp(), for the same reason auditLog.js needs it: a bare plugin's hooks are
// encapsulated to a scope that holds no routes, so the window would never close
// on anything.
const maintenanceModePlugin = fp(maintenanceMode, { name: 'vungu-maintenance-mode' })

module.exports = { maintenanceModePlugin, ALWAYS_OPEN }
