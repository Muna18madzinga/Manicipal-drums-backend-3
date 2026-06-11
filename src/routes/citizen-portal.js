// src/routes/citizen-portal.js
// Lightweight read endpoints used by the citizen-portal Map & Discover
// surface. Any signed-in user can call them.

const { requireAuth } = require('../middleware/jwtAuth')

/**
 * Fastify plugin. Register with prefix '/api'; routes live under
 * /api/council and /api/available-stands.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
async function citizenPortalRoutes(fastify) {
  const pg = fastify.pg

  // The "About Vungu RDC" contact card. local_authorities holds two
  // duplicated rows for Vungu Rural District Council with no geometry;
  // DISTINCT + LIMIT 1 gives a single clean row to the panel.
  fastify.get('/council', { preHandler: requireAuth(fastify) }, async () => {
    const { rows } = await pg.query(
      `SELECT DISTINCT authority_name AS name, authority_type AS type,
              address, telephone, email, application_fee
       FROM local_authorities
       WHERE authority_name = 'Vungu Rural District Council'
       LIMIT 1`)
    return { success: true, data: rows[0] || null }
  })

  // Stands the council is offering for allocation. Filters: zone (exact),
  // ward (ILIKE substring). The 'status' filter is not exposed because the
  // citizen surface only renders available stands.
  fastify.get('/available-stands', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    const { zone, ward } = request.query
    try {
      const { rows } = await pg.query(
        `SELECT id, stand_number, suburb_ward, area_sqm, zone, status,
                description, longitude, latitude
         FROM spatial_planning.available_stand
         WHERE status = 'available'
           AND ($1::text IS NULL OR zone = $1)
           AND ($2::text IS NULL OR suburb_ward ILIKE '%' || $2 || '%')
         ORDER BY stand_number`,
        [zone || null, ward || null])
      return { success: true, data: rows }
    } catch (err) {
      request.log.error({ err }, 'list available stands failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

module.exports = { citizenPortalRoutes }
