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
    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const { rows } = await client.query(
        `UPDATE council_ops.deeds_transfer_notice SET
           status = COALESCE($2, status),
           notes = COALESCE($3, notes),
           child_stand_number = COALESCE($4, child_stand_number),
           cancelled_at = CASE WHEN $2 = 'cancelled' THEN COALESCE(cancelled_at, now()) ELSE cancelled_at END,
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [request.params.id, b.status || null, b.notes || null, b.child_stand_number || null],
      )
      if (!rows[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ success: false, error: 'not_found' })
      }
      let lineage = null
      const notice = rows[0]
      const child = notice.child_stand_number
      const kind = notice.notice_kind
      if (notice.status === 'actioned' && child && notice.stand_number
          && ['sale', 'subdivision_lease'].includes(kind)) {
        const action = kind === 'sale' ? 'transfer' : 'subdivision'
        const ins = await client.query(
          `INSERT INTO council_ops.parcel_identity_lineage
             (parent_stand, child_stand, action, deeds_notice_id, created_by)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (parent_stand, child_stand, action) DO UPDATE
             SET deeds_notice_id = EXCLUDED.deeds_notice_id
           RETURNING *`,
          [notice.stand_number, child, action, notice.id, request.user.id],
        )
        lineage = ins.rows[0]
        await client.query('SAVEPOINT property_lineage')
        try {
          await client.query(
            `INSERT INTO spatial_planning.parcel_lineage (parent_property_id, child_property_id, action)
             SELECT p.id, c.id, $3
               FROM spatial_planning.property p
               JOIN spatial_planning.property c ON upper(c.stand_number) = upper($2)
              WHERE upper(p.stand_number) = upper($1)
             ON CONFLICT (parent_property_id, child_property_id) DO NOTHING`,
            [notice.stand_number, child, action],
          )
          await client.query('RELEASE SAVEPOINT property_lineage')
        } catch {
          await client.query('ROLLBACK TO SAVEPOINT property_lineage')
        }
      }
      await client.query('COMMIT')
      return reply.send({ success: true, data: { ...notice, lineage } })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      request.log.error({ err }, 'deeds notice update failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    } finally {
      client.release()
    }
  })

  fastify.get('/custodian/lineage', staff, async (_req, reply) => {
    const { rows } = await pg.query(
      `SELECT * FROM council_ops.parcel_identity_lineage ORDER BY created_at DESC LIMIT 200`,
    )
    return reply.send({ success: true, data: rows })
  })
}

module.exports = { custodianBoundaryRoutes }
