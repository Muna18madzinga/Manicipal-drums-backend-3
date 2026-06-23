/**
 * Application status transitions — single canonical endpoint that emits
 * notifications + writes to application_status_history.
 *
 *   POST /api/applications/:appId/status
 *     Body: { toStatus: 'under_review' | 'approved' | 'rejected' | ..., notes? }
 *     Auth: planner | eo | admin | building_inspector | planning_clerk
 *
 * This deliberately lives separately from /development-applications/*
 * (which is tied up with the older legacy CRUD). Anything that wants to
 * change an application's status should call this instead of UPDATE-ing
 * directly, so the citizen always gets an email and the timeline is
 * captured.
 *
 * Statuses are deliberately a free-form string to match the existing
 * VARCHAR(50) column; we only validate they are non-empty and below the
 * column limit. The frontend ApplicationsListView already uses values
 * like 'submitted', 'under_review', 'approved', 'rejected', 'queried'.
 */

const { requireRole } = require('../middleware/jwtAuth')
const notifier = require('../services/notifier')

const STAFF_ROLES = ['admin', 'planner', 'eo', 'env_officer', 'building_inspector', 'planning_clerk', 'surveyor', 'gis_officer']

const isString = (v, max = 4096) =>
  typeof v === 'string' && v.length > 0 && v.length <= max

async function applicationStatusRoutes(fastify) {
  fastify.post(
    '/applications/:appId/status',
    { preHandler: requireRole(fastify, STAFF_ROLES) },
    async (request, reply) => {
      try {
        const { appId } = request.params
        const { toStatus, notes } = request.body || {}

        if (!isString(toStatus, 50)) {
          return reply.code(400).send({ success: false, error: 'bad_status' })
        }

        // Read current row + citizen contact in one query.
        const { rows } = await fastify.pg.query(
          `SELECT da.id, da.user_id, da.status,
                  u.email, COALESCE(u.full_name, u.name) AS citizen_name
           FROM development_applications da
           LEFT JOIN users u ON u.id::text = da.user_id
           WHERE da.id = $1`,
          [appId],
        )
        const app = rows[0]
        if (!app) return reply.code(404).send({ success: false, error: 'not_found' })

        if (app.status === toStatus) {
          // Idempotent: nothing to do.
          return reply.send({ success: true, data: { id: app.id, status: app.status, unchanged: true } })
        }

        // Run the actual update + audit + notification atomically.
        const client = await fastify.pg.connect()
        try {
          await client.query('BEGIN')

          await client.query(
            `UPDATE development_applications
                SET status = $1, updated_at = NOW()
              WHERE id = $2`,
            [toStatus, appId],
          )

          await notifier.recordApplicationStatusChange(client, {
            applicationId: appId,
            fromStatus:    app.status,
            toStatus,
            changedBy:     request.user.id,
            citizenUserId: app.user_id,
            citizenEmail:  app.email,
            citizenName:   app.citizen_name,
            notes:         isString(notes, 1000) ? notes : null,
          })

          // Also append to the existing free-text application_timeline
          // for back-compat with any frontend already reading from it.
          await client.query(
            `INSERT INTO application_timeline
               (application_id, event_type, event_description, event_date)
             VALUES ($1, 'status_change', $2, NOW())`,
            [appId, `${app.status || 'unknown'} → ${toStatus}` + (notes ? ` — ${notes}` : '')],
          )

          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {})
          throw err
        } finally {
          client.release()
        }

        return reply.send({
          success: true,
          data: { id: appId, fromStatus: app.status, toStatus },
        })
      } catch (err) {
        request.log.error({ err }, 'application status change failed')
        return reply.code(500).send({ success: false, error: 'internal' })
      }
    },
  )

  // Read history (citizen + staff).
  fastify.get('/applications/:appId/status-history', async (request, reply) => {
    try {
      const { appId } = request.params
      const { rows } = await fastify.pg.query(
        `SELECT id, application_id, from_status, to_status, changed_by, notes, changed_at
         FROM application_status_history
         WHERE application_id = $1
         ORDER BY changed_at DESC`,
        [appId],
      )
      return reply.send({ success: true, data: rows })
    } catch (err) {
      request.log.error({ err }, 'status history failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

module.exports = { applicationStatusRoutes }
