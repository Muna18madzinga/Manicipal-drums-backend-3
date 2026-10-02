/**
 * Cross-department workflow notifications
 * Emitted whenever a permit application changes status so all role dashboards
 * can display real-time updates without polling every endpoint individually.
 *
 * GET  /api/notifications              — list notifications visible to the caller
 * POST /api/notifications              — create notification (internal, staff-only)
 * PATCH /api/notifications/:id/read   — mark one read (only one the caller can see)
 * PATCH /api/notifications/read-all   — mark all read for caller
 * GET  /api/notifications/unread-count
 *
 * Visibility (security audit 2026-09-29):
 *   - staff see notifications addressed to them, to their role, or to 'all';
 *   - clients (citizens) see ONLY notifications addressed to them personally
 *     (recipient_user_id). Role broadcasts and 'all' are staff workflow traffic:
 *     every citizen shares the 'registered' role, so a role/'all' row shown to
 *     citizens would leak one applicant's case to every other applicant.
 *   - the applicant name joined from the permit is returned to staff only.
 * Every route used to pass the guard factory itself as the hook, so each request
 * hung until timeout (the routes were unreachable for everyone).
 */

const { requireAuth, requireRole } = require('../middleware/jwtAuth')

const STAFF_ROLES = ['admin', 'planner', 'planning_clerk', 'building_inspector', 'eo',
  'env_officer', 'surveyor', 'gis_officer']

const isStaff = (user) => STAFF_ROLES.includes(user?.role)

/** SQL predicate (alias n) + params for the rows the caller may see. $1/$2 are role and user id. */
function visibleTo(user) {
  return isStaff(user)
    ? { where: `(n.recipient_role = $1 OR n.recipient_user_id = $2 OR n.recipient_role = 'all')`, params: [user.role, user.id] }
    : { where: `(n.recipient_user_id = $2 AND $1::text IS NOT NULL)`, params: [user.role, user.id] }
}

async function notificationsRoutes(fastify) {
  // ── GET /notifications ──────────────────────────────────────────────
  fastify.get('/notifications', { preHandler: requireAuth(fastify) }, async (req, reply) => {
    const { unread_only = false } = req.query
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50))
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0)
    const { where, params } = visibleTo(req.user)
    const staff = isStaff(req.user)
    try {
      let q = `
        SELECT n.*, pa.dev_register_no${staff ? ', pa.applicant_name' : ''}
        FROM workflow_notifications n
        LEFT JOIN spatial_planning.permit_application pa ON pa.id = n.permit_application_id
        WHERE ${where}`
      if (unread_only === 'true' || unread_only === true) q += ' AND n.read_at IS NULL'
      q += ' ORDER BY n.created_at DESC LIMIT $3 OFFSET $4'
      const result = await fastify.pg.query(q, [...params, limit, offset])
      return reply.send({ success: true, data: result.rows })
    } catch (err) {
      fastify.log.error(err, 'notifications list error')
      return reply.code(500).send({ success: false, error: 'db_error' })
    }
  })

  // ── GET /notifications/unread-count ─────────────────────────────────
  fastify.get('/notifications/unread-count', { preHandler: requireAuth(fastify) }, async (req, reply) => {
    const { where, params } = visibleTo(req.user)
    try {
      const r = await fastify.pg.query(
        `SELECT COUNT(*) AS cnt FROM workflow_notifications n WHERE ${where} AND n.read_at IS NULL`,
        params,
      )
      return reply.send({ success: true, data: { count: parseInt(r.rows[0].cnt) } })
    } catch {
      return reply.send({ success: true, data: { count: 0 } })
    }
  })

  // ── POST /notifications ─────────────────────────────────────────────
  fastify.post('/notifications', { preHandler: requireRole(fastify, STAFF_ROLES) },
    async (req, reply) => {
      const { permit_application_id, title, message, recipient_role, recipient_user_id, kind } = req.body || {}
      if (!title || !message) {
        return reply.code(400).send({ success: false, error: 'title and message required' })
      }
      try {
        const r = await fastify.pg.query(
          `INSERT INTO workflow_notifications
             (permit_application_id, title, message, kind, recipient_role, recipient_user_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [permit_application_id || null, title, message, kind || 'info',
           recipient_role || 'all', recipient_user_id || null, req.user.id]
        )
        return reply.code(201).send({ success: true, data: r.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.code(500).send({ success: false, error: 'db_error' })
      }
    })

  // ── PATCH /notifications/read-all ───────────────────────────────────
  fastify.patch('/notifications/read-all', { preHandler: requireAuth(fastify) }, async (req, reply) => {
    const { where, params } = visibleTo(req.user)
    try {
      await fastify.pg.query(
        `UPDATE workflow_notifications n SET read_at = NOW() WHERE ${where} AND n.read_at IS NULL`,
        params,
      )
      return reply.send({ success: true })
    } catch {
      return reply.send({ success: true })
    }
  })

  // ── PATCH /notifications/:id/read ───────────────────────────────────
  // Only a notification the caller can see; anything else is 404 (was: any id at all).
  fastify.patch('/notifications/:id/read', { preHandler: requireAuth(fastify) }, async (req, reply) => {
    const { where, params } = visibleTo(req.user)
    try {
      const r = await fastify.pg.query(
        `UPDATE workflow_notifications n SET read_at = NOW() WHERE n.id::text = $3 AND ${where} RETURNING n.id`,
        [...params, String(req.params.id)],
      )
      if (!r.rows.length) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true })
    } catch (err) {
      fastify.log.error(err, 'notification read error')
      return reply.code(500).send({ success: false, error: 'db_error' })
    }
  })
}

module.exports = { notificationsRoutes, visibleTo }
