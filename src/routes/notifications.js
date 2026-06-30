/**
 * Cross-department workflow notifications
 * Emitted whenever a permit application changes status so all role dashboards
 * can display real-time updates without polling every endpoint individually.
 *
 * GET  /api/notifications              — list unread notifications for the caller
 * POST /api/notifications              — create notification (internal, staff-only)
 * PATCH /api/notifications/:id/read   — mark one read
 * PATCH /api/notifications/read-all   — mark all read for caller
 * GET  /api/notifications/unread-count
 */

const { requireAuth, requireRole } = require('../middleware/jwtAuth')

const STAFF_ROLES = ['admin', 'planner', 'planning_clerk', 'building_inspector', 'eo',
  'env_officer', 'surveyor', 'gis_officer']

async function notificationsRoutes(fastify) {
  // ── GET /notifications ──────────────────────────────────────────────
  fastify.get('/notifications', { preHandler: requireAuth }, async (req, reply) => {
    const { unread_only = false, limit = 50, offset = 0 } = req.query
    const userId = req.user.id
    try {
      let q = `
        SELECT n.*, pa.dev_register_no, pa.applicant_name
        FROM workflow_notifications n
        LEFT JOIN spatial_planning.permit_applications pa ON pa.id = n.permit_application_id
        WHERE n.recipient_role = $1
        OR n.recipient_user_id = $2
        OR n.recipient_role = 'all'
      `
      const params = [req.user.role, userId]
      if (unread_only === 'true' || unread_only === true) {
        q += ' AND n.read_at IS NULL'
      }
      q += ' ORDER BY n.created_at DESC LIMIT $3 OFFSET $4'
      params.push(parseInt(limit), parseInt(offset))
      const result = await fastify.pg.query(q, params)
      return reply.send({ success: true, data: result.rows })
    } catch (err) {
      fastify.log.error(err, 'notifications list error')
      return reply.code(500).send({ success: false, error: 'db_error' })
    }
  })

  // ── GET /notifications/unread-count ─────────────────────────────────
  fastify.get('/notifications/unread-count', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.user.id
    try {
      const r = await fastify.pg.query(
        `SELECT COUNT(*) AS cnt FROM workflow_notifications
         WHERE (recipient_role = $1 OR recipient_user_id = $2 OR recipient_role = 'all')
         AND read_at IS NULL`,
        [req.user.role, userId]
      )
      return reply.send({ success: true, data: { count: parseInt(r.rows[0].cnt) } })
    } catch {
      return reply.send({ success: true, data: { count: 0 } })
    }
  })

  // ── POST /notifications ─────────────────────────────────────────────
  fastify.post('/notifications', { preHandler: [requireAuth, requireRole(STAFF_ROLES)] },
    async (req, reply) => {
      const { permit_application_id, title, message, recipient_role, recipient_user_id, kind } = req.body
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
  fastify.patch('/notifications/read-all', { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.user.id
    try {
      await fastify.pg.query(
        `UPDATE workflow_notifications SET read_at = NOW()
         WHERE (recipient_role = $1 OR recipient_user_id = $2 OR recipient_role = 'all')
         AND read_at IS NULL`,
        [req.user.role, userId]
      )
      return reply.send({ success: true })
    } catch {
      return reply.send({ success: true })
    }
  })

  // ── PATCH /notifications/:id/read ───────────────────────────────────
  fastify.patch('/notifications/:id/read', { preHandler: requireAuth }, async (req, reply) => {
    try {
      await fastify.pg.query(
        `UPDATE workflow_notifications SET read_at = NOW() WHERE id = $1`,
        [req.params.id]
      )
      return reply.send({ success: true })
    } catch {
      return reply.send({ success: true })
    }
  })
}

module.exports = { notificationsRoutes }
