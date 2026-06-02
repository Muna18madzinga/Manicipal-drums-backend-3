/**
 * KYC / Identity Verification routes
 * Citizens submit their ID details when registering a development application.
 * IT Admin reviews and approves or rejects each submission.
 *
 * POST   /api/kyc                          — citizen submits KYC
 * GET    /api/kyc                          — admin / staff lists all submissions
 * GET    /api/kyc/my                       — citizen views own submission
 * PATCH  /api/kyc/:id/approve              — admin approves
 * PATCH  /api/kyc/:id/reject               — admin rejects
 * GET    /api/kyc/status/:userId           — check verification status for user
 */

const { requireAuth, requireRole } = require('../middleware/jwtAuth')

async function kycRoutes(fastify) {
  // ── POST /kyc — citizen submits ─────────────────────────────────────
  fastify.post('/kyc', { preHandler: requireAuth }, async (req, reply) => {
    const { id_type, id_number, full_name } = req.body
    if (!id_type || !id_number || !full_name) {
      return reply.code(400).send({ success: false, error: 'id_type, id_number and full_name required' })
    }
    const VALID_TYPES = ['national_id', 'passport', 'drivers_licence']
    if (!VALID_TYPES.includes(id_type)) {
      return reply.code(400).send({ success: false, error: 'invalid id_type' })
    }
    try {
      // Upsert — one submission per user
      const r = await fastify.pg.query(
        `INSERT INTO kyc_verifications (user_id, id_type, id_number, full_name, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (user_id) DO UPDATE
           SET id_type=EXCLUDED.id_type, id_number=EXCLUDED.id_number,
               full_name=EXCLUDED.full_name, status='pending', reviewer_notes=NULL,
               reviewed_at=NULL, updated_at=NOW()
         RETURNING *`,
        [req.user.id, id_type, id_number, full_name]
      )
      return reply.code(201).send({ success: true, data: r.rows[0] })
    } catch (err) {
      fastify.log.error(err)
      return reply.code(500).send({ success: false, error: 'db_error' })
    }
  })

  // ── GET /kyc — admin/staff lists ────────────────────────────────────
  fastify.get('/kyc', { preHandler: [requireAuth, requireRole(['admin', 'planner'])] },
    async (req, reply) => {
      const { status } = req.query
      try {
        let q = `SELECT k.*, u.name AS user_name, u.email AS user_email
                 FROM kyc_verifications k
                 JOIN users u ON u.id = k.user_id`
        const params = []
        if (status) { q += ' WHERE k.status = $1'; params.push(status) }
        q += ' ORDER BY k.created_at DESC'
        const r = await fastify.pg.query(q, params)
        return reply.send({ success: true, data: r.rows })
      } catch (err) {
        fastify.log.error(err)
        // Return empty array so UI can show demo data
        return reply.send({ success: true, data: [] })
      }
    })

  // ── GET /kyc/my — citizen's own ─────────────────────────────────────
  fastify.get('/kyc/my', { preHandler: requireAuth }, async (req, reply) => {
    try {
      const r = await fastify.pg.query(
        'SELECT * FROM kyc_verifications WHERE user_id = $1', [req.user.id])
      return reply.send({ success: true, data: r.rows[0] || null })
    } catch {
      return reply.send({ success: true, data: null })
    }
  })

  // ── PATCH /kyc/:id/approve ───────────────────────────────────────────
  fastify.patch('/kyc/:id/approve', { preHandler: [requireAuth, requireRole(['admin'])] },
    async (req, reply) => {
      const { reviewer_notes } = req.body || {}
      try {
        const r = await fastify.pg.query(
          `UPDATE kyc_verifications SET status='approved', reviewer_notes=$1,
           reviewed_by=$2, reviewed_at=NOW(), updated_at=NOW()
           WHERE id=$3 RETURNING *`,
          [reviewer_notes || 'Approved by IT Admin.', req.user.id, req.params.id]
        )
        if (!r.rows.length) return reply.code(404).send({ success: false, error: 'not_found' })
        // Emit notification to planner so newly verified users appear
        await fastify.pg.query(
          `INSERT INTO workflow_notifications
             (title, message, kind, recipient_role, created_by)
           VALUES ('KYC verified', 'Identity verified for user ID ' || $1, 'success', 'planner', $2)`,
          [r.rows[0].user_id, req.user.id]
        ).catch(() => {})
        return reply.send({ success: true, data: r.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.code(500).send({ success: false, error: 'db_error' })
      }
    })

  // ── PATCH /kyc/:id/reject ────────────────────────────────────────────
  fastify.patch('/kyc/:id/reject', { preHandler: [requireAuth, requireRole(['admin'])] },
    async (req, reply) => {
      const { reviewer_notes } = req.body || {}
      try {
        const r = await fastify.pg.query(
          `UPDATE kyc_verifications SET status='rejected', reviewer_notes=$1,
           reviewed_by=$2, reviewed_at=NOW(), updated_at=NOW()
           WHERE id=$3 RETURNING *`,
          [reviewer_notes || 'ID could not be verified.', req.user.id, req.params.id]
        )
        if (!r.rows.length) return reply.code(404).send({ success: false, error: 'not_found' })
        return reply.send({ success: true, data: r.rows[0] })
      } catch (err) {
        fastify.log.error(err)
        return reply.code(500).send({ success: false, error: 'db_error' })
      }
    })

  // ── GET /kyc/status/:userId ──────────────────────────────────────────
  fastify.get('/kyc/status/:userId', { preHandler: [requireAuth, requireRole(['admin', 'planner'])] },
    async (req, reply) => {
      try {
        const r = await fastify.pg.query(
          'SELECT status FROM kyc_verifications WHERE user_id = $1', [req.params.userId])
        return reply.send({ success: true, data: { status: r.rows[0]?.status || 'not_submitted' } })
      } catch {
        return reply.send({ success: true, data: { status: 'unknown' } })
      }
    })
}

module.exports = { kycRoutes }
