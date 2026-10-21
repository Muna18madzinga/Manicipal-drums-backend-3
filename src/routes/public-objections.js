/**
 * C8 — a person who is not the applicant reads a published notice and lodges
 * an objection while the period is open. Staff still consider it on the case.
 */
const { requireAuth } = require('../middleware/jwtAuth')

const isStr = (v, max = 4000) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max

async function publicObjectionRoutes(fastify) {
  const pg = fastify.pg

  fastify.get('/public-notices', async (_req, reply) => {
    const { rows } = await pg.query(
      `SELECT pa.id AS permit_app_id,
              COALESCE(pa.dev_register_no, pa.tpd_reference, pa.dev_app_id) AS reference,
              pa.stand_number, pa.suburb_ward, pa.development_type,
              pn.objection_period_start::text AS objection_start,
              pn.objection_period_end::text AS objection_end
         FROM spatial_planning.public_notice pn
         JOIN spatial_planning.permit_application pa ON pa.id = pn.permit_app_id
        WHERE NOT COALESCE(pn.objection_period_closed, FALSE)
          AND (pn.objection_period_end IS NULL OR pn.objection_period_end >= CURRENT_DATE)
        ORDER BY pn.objection_period_end NULLS LAST
        LIMIT 200`,
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.post('/public-notices/:id/objections', {
    preHandler: requireAuth(fastify),
  }, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.grounds_detail, 4000)) {
      return reply.code(400).send({ success: false, error: 'grounds_detail required' })
    }
    const { rows: open } = await pg.query(
      `SELECT pa.id
         FROM spatial_planning.public_notice pn
         JOIN spatial_planning.permit_application pa ON pa.id = pn.permit_app_id
        WHERE pa.id = $1
          AND NOT COALESCE(pn.objection_period_closed, FALSE)
          AND (pn.objection_period_end IS NULL OR pn.objection_period_end >= CURRENT_DATE)`,
      [request.params.id],
    )
    if (!open[0]) return reply.code(409).send({ success: false, error: 'objection_period_closed' })

    const { rows: who } = await pg.query('SELECT name FROM public.users WHERE id = $1', [request.user.id])
    const name = who[0]?.name || request.user.email
    const { rows } = await pg.query(
      `INSERT INTO spatial_planning.application_objection
         (permit_app_id, objector_name, objector_address, grounds, grounds_detail, received_at)
       VALUES ($1,$2,$3,'[]',$4, CURRENT_DATE)
       RETURNING id, permit_app_id, objector_name, grounds_detail, received_at`,
      [request.params.id, name, b.objector_address || null, b.grounds_detail.trim()],
    )
    return reply.code(201).send({ success: true, data: rows[0] })
  })
}

module.exports = { publicObjectionRoutes }
