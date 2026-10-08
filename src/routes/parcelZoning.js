/**
 * Parcel zoning — read-only.
 *
 *   GET /api/parcel-zoning/:layer/:id               the zone(s) a parcel falls in, per plan
 *   GET /api/parcel-zoning/:layer/:id?use=<code>    the same, plus what each plan decides for that
 *                                                   land use (the rule snapshot an application stores)
 *
 * :layer is stands | vungu_parcels | land.parcel. Public, like the zone and matrix endpoints.
 * A parcel in no zone polygon is "unzoned"; a null decision is "not decided", never "allowed".
 * Where two plans cover a parcel both are returned; which one governs is not decided here.
 */
const { parseParcelRef, parseUseCode, takeSnapshot, PARCEL_LAYERS } = require('../utils/ruleSnapshot')
const { optionalAuth } = require('../middleware/jwtAuth')
const { tenantPool } = require('../lib/tenancy')

async function parcelZoningRoutes(fastify) {
  // Public, but the zones a person's database view shows follow their authority (migration 154): the public
  // sees gazetted plans only; staff also see their own authority's.
  fastify.get('/parcel-zoning/:layer/:id', { preHandler: optionalAuth(fastify) }, async (request, reply) => {
    const db = tenantPool(fastify.pg, request.user)
    const ref = parseParcelRef(request.params.layer, request.params.id)
    if (!ref) {
      return reply.code(400).send({ success: false, error: `layer must be one of ${PARCEL_LAYERS.join(', ')} and id a short plain identifier` })
    }
    const rawUse = (request.query || {}).use
    const use = rawUse === undefined ? null : parseUseCode(rawUse)
    if (rawUse !== undefined && !use) return reply.code(400).send({ success: false, error: 'use must be a short land-use code' })
    try {
      const { rows: parcel } = await db.query('SELECT parcel_geometry($1, $2) IS NOT NULL AS found', [ref.layer, ref.id])
      if (!parcel[0].found) return reply.code(404).send({ success: false, error: 'Unknown parcel' })
      if (use) {
        const { snapshot } = await takeSnapshot(db, ref, use)
        return { success: true, data: snapshot }
      }
      const { rows } = await db.query(
        `SELECT pz.zone_id, pz.zone_name, pz.share_pct, pz.is_governing AS governing, pz.method,
                i.id AS plan_id, i.title AS plan_title, i.status AS plan_status
           FROM parcel_zoning_for($1, $2) pz JOIN plan_instrument i ON i.id = pz.plan_instrument_id
          ORDER BY pz.is_governing DESC, pz.share_pct DESC NULLS LAST, pz.zone_id`, [ref.layer, ref.id])
      return { success: true, data: { parcel: ref, unzoned: rows.length === 0, zones: rows } }
    } catch (err) {
      request.log.error({ err }, 'parcel zoning failed')
      return reply.code(500).send({ success: false, error: 'Failed to read parcel zoning' })
    }
  })
}

module.exports = { parcelZoningRoutes }
