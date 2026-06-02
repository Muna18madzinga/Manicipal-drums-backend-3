/**
 * Audit logging middleware for SpartialIQ.
 * Writes a row to security_audit_log for every mutating request
 * (POST/PUT/PATCH/DELETE) from authenticated users.
 *
 * Critical for Zimbabwe municipal compliance — any change to
 * permit data, user accounts, KYC decisions, or enforcement orders
 * must be traceable to a specific officer.
 *
 * Tables required (migration 075+):
 *   security_audit_log (id SERIAL, event_type, severity, user_id, ip_address,
 *     user_agent, details JSONB, created_at)
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// Map URL prefixes to audit event categories
function categorize(method, url) {
  if (url.includes('/auth'))            return { event: 'AUTH',        severity: 'medium' }
  if (url.includes('/admin/users'))     return { event: 'USER_MGMT',   severity: 'high' }
  if (url.includes('/kyc'))             return { event: 'KYC',         severity: 'high' }
  if (url.includes('/permit-app'))      return { event: 'PERMIT',      severity: 'medium' }
  if (url.includes('/enforcement'))     return { event: 'ENFORCEMENT', severity: 'high' }
  if (url.includes('/payments'))        return { event: 'PAYMENT',     severity: 'high' }
  if (url.includes('/documents'))       return { event: 'DOCUMENT',    severity: 'medium' }
  if (url.includes('/notifications'))   return { event: 'NOTIF',       severity: 'low' }
  if (url.includes('/stage-insp'))      return { event: 'INSPECTION',  severity: 'high' }
  if (url.includes('/occupation-cert')) return { event: 'CERTIFICATE', severity: 'high' }
  if (method === 'DELETE')              return { event: 'DELETE',       severity: 'high' }
  return { event: 'MUTATION', severity: 'low' }
}

/**
 * Fastify plugin. Register once in server.js.
 * Adds an onResponse hook that writes a compact audit row after the response
 * is sent, so it never slows down the request path.
 */
async function auditLogPlugin(fastify) {
  fastify.addHook('onResponse', async (req, reply) => {
    try {
      // Only log mutating requests from authenticated users
      if (!MUTATING_METHODS.has(req.method)) return
      const userId = req.user?.id ?? null
      if (!userId) return  // unauthenticated mutations logged separately

      const { event, severity } = categorize(req.method, req.url)
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || null
      const ua = req.headers['user-agent'] || null

      const details = {
        method:  req.method,
        url:     req.url,
        status:  reply.statusCode,
        role:    req.user?.role,
        ms:      reply.elapsedTime?.toFixed(0),
      }

      await fastify.pg.query(
        `INSERT INTO security_audit_log
           (event_type, severity, user_id, ip_address, user_agent, details)
         VALUES ($1, $2, $3, $4::INET, $5, $6::JSONB)`,
        [event, severity, userId, ip, ua, JSON.stringify(details)]
      )
    } catch (err) {
      // Never crash the request if audit logging fails; just warn
      fastify.log.warn({ err }, 'audit-log write failed')
    }
  })
}

module.exports = { auditLogPlugin }
