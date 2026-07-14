/**
 * Control point routes — national survey monument registry (migration 098).
 *
 *   GET  /surveyor/control-points          (reader)   — search by number/name
 *   POST /surveyor/control-points          (surveyor) — add a monument
 *
 * ponytail: no PUT/DELETE, no bbox search. Add when a real editing or
 * map-plotting need shows up — see migration 098's header for why geom
 * isn't here yet.
 */

const { requireRole } = require('../middleware/jwtAuth')

const SURVEYOR = ['surveyor', 'admin']
const READERS = ['surveyor', 'admin', 'planner', 'eo', 'planning_clerk']
const TYPES = ['PRIM', 'SEC', 'TERT', 'QUART']
const ZONES = [25, 27, 29, 31, 33]

function num(v) {
  return v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null)
}

async function controlPointRoutes(fastify) {
  const pg = fastify.pg

  fastify.get('/surveyor/control-points', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    const { q } = request.query
    try {
      const { rows } = await pg.query(
        `SELECT * FROM spatial_planning.control_point
          WHERE ($1::text IS NULL OR monu_num ILIKE '%'||$1||'%' OR monu_name ILIKE '%'||$1||'%')
          ORDER BY monu_num LIMIT 200`,
        [q || null],
      )
      return reply.send({ success: true, data: rows })
    } catch (err) {
      request.log.error({ err }, 'list control points failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/surveyor/control-points', { preHandler: requireRole(fastify, SURVEYOR) }, async (request, reply) => {
    const b = request.body || {}
    if (typeof b.monu_num !== 'string' || !b.monu_num.trim()) {
      return reply.code(400).send({ success: false, error: 'monu_num required' })
    }
    if (typeof b.monu_name !== 'string' || !b.monu_name.trim()) {
      return reply.code(400).send({ success: false, error: 'monu_name required' })
    }
    if (b.type && !TYPES.includes(b.type)) {
      return reply.code(400).send({ success: false, error: 'bad_type' })
    }
    if (b.gauss_lo && !ZONES.includes(Number(b.gauss_lo))) {
      return reply.code(400).send({ success: false, error: 'bad_gauss_lo' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.control_point
           (monu_num, monu_name, type, gauss_lo, y_gauss, x_gauss, msl_hgt, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [b.monu_num.trim(), b.monu_name.trim(), b.type || 'SEC', num(b.gauss_lo),
         num(b.y_gauss), num(b.x_gauss), num(b.msl_hgt), request.user.id],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      if (err.code === '23505') { // unique_violation on monu_num
        return reply.code(409).send({ success: false, error: 'duplicate_monu_num' })
      }
      request.log.error({ err }, 'create control point failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

module.exports = { controlPointRoutes }
