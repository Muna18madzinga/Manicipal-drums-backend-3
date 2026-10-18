/**
 * Custodian boundary scaffolds — X4 (SG plan submission) and X7 (Deeds notices).
 * Council-side registers until Surveyor-General / Deeds Registry expose APIs.
 */
const { requireRole, requireAuth } = require('../middleware/jwtAuth')

const STAFF = [
  'admin', 'planner', 'planning_clerk', 'eo', 'gis_officer', 'surveyor',
]
const WRITERS = ['admin', 'planner', 'planning_clerk', 'eo', 'gis_officer']

const isStr = (v, max = 500) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max

async function custodianBoundaryRoutes(fastify) {
  const pg = fastify.pg
  const staff = { preHandler: requireRole(fastify, STAFF) }
  const write = { preHandler: requireRole(fastify, WRITERS) }

  // ── X4 Surveyor-General outbound ────────────────────────────────────
  fastify.get('/custodian/sg-submissions', staff, async (_req, reply) => {
    const { rows } = await pg.query(
      `SELECT * FROM council_ops.sg_plan_submission ORDER BY created_at DESC LIMIT 200`,
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.post('/custodian/sg-submissions', write, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.title, 300) || !isStr(b.plan_type, 40)) {
      return reply.code(400).send({ success: false, error: 'title and plan_type required' })
    }
    const { rows } = await pg.query(
      `INSERT INTO council_ops.sg_plan_submission
         (stand_number, parcel_ref, plan_type, title, status, notes, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5,'draft'),$6,$7) RETURNING *`,
      [b.stand_number || null, b.parcel_ref || null, b.plan_type, b.title.trim(),
        b.status || 'draft', b.notes || null, request.user.id],
    )
    return reply.code(201).send({ success: true, data: rows[0] })
  })

  fastify.patch('/custodian/sg-submissions/:id', write, async (request, reply) => {
    const b = request.body || {}
    const { rows } = await pg.query(
      `UPDATE council_ops.sg_plan_submission SET
         status = COALESCE($2, status),
         sg_reference = COALESCE($3, sg_reference),
         sent_at = CASE WHEN $2 = 'sent' THEN COALESCE(sent_at, now()) ELSE sent_at END,
         notes = COALESCE($4, notes),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [request.params.id, b.status || null, b.sg_reference || null, b.notes || null],
    )
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    return reply.send({ success: true, data: rows[0] })
  })

  // ── X7 Deeds Registry inbound (manual until API exists) ─────────────
  fastify.get('/custodian/deeds-notices', staff, async (_req, reply) => {
    const { rows } = await pg.query(
      `SELECT * FROM council_ops.deeds_transfer_notice ORDER BY created_at DESC LIMIT 200`,
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.post('/custodian/deeds-notices', write, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.notice_kind, 40)) {
      return reply.code(400).send({ success: false, error: 'notice_kind required' })
    }
    const { rows } = await pg.query(
      `INSERT INTO council_ops.deeds_transfer_notice
         (stand_number, deed_number, notice_kind, transferor_name, transferee_name,
          noticed_at, status, source, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE),COALESCE($7,'received'),
               COALESCE($8,'manual'),$9,$10) RETURNING *`,
      [b.stand_number || null, b.deed_number || null, b.notice_kind,
        b.transferor_name || null, b.transferee_name || null,
        b.noticed_at || null, b.status || 'received', b.source || 'manual',
        b.notes || null, request.user.id],
    )
    return reply.code(201).send({ success: true, data: rows[0] })
  })

  fastify.patch('/custodian/deeds-notices/:id', write, async (request, reply) => {
    const b = request.body || {}
    const { rows } = await pg.query(
      `UPDATE council_ops.deeds_transfer_notice SET
         status = COALESCE($2, status),
         notes = COALESCE($3, notes),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [request.params.id, b.status || null, b.notes || null],
    )
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    return reply.send({ success: true, data: rows[0] })
  })
}

module.exports = { custodianBoundaryRoutes }
