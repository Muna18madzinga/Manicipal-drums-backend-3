// src/routes/parcels.js
// Parcel/stand spatial lookup for the planner intake map picker.
// Resolves an arbitrary lng/lat into a jurisdiction + stand bundle.

const VUNGU_AUTHORITY = 'Vungu Rural District Council'

// SRID-safe point-in-polygon: force the point to the geom's own SRID rather
// than transform (the tables mix 4326 and the custom 900914 ≡ CRS84, both
// lng/lat degrees, and 900914 is not transform-safe).
const CONTAINS = (geomExpr) =>
  `ST_Contains(${geomExpr}, ST_SetSRID(ST_MakePoint($1, $2), ST_SRID(${geomExpr})))`

async function jurisdictionResolver(pg, lng, lat) {
  const inj = await pg.query(
    `SELECT ${CONTAINS('geom')} AS v FROM gweru_rural_planning_boundary LIMIT 1`,
    [lng, lat],
  )
  const dist = await pg.query(
    `SELECT name_en FROM districts
     WHERE level = 2 AND ${CONTAINS('geom')} LIMIT 1`,
    [lng, lat],
  )
  const auth = await pg.query(
    `SELECT DISTINCT authority_name AS name, telephone, email, address
     FROM local_authorities WHERE authority_name = $1 LIMIT 1`,
    [VUNGU_AUTHORITY],
  )
  return {
    in_jurisdiction: Boolean(inj.rows[0] && inj.rows[0].v),
    district: dist.rows[0] ? dist.rows[0].name_en : null,
    authority: auth.rows[0] || null,
  }
}

async function parcelResolver(pg, lng, lat) {
  const r = await pg.query(
    `SELECT fid,
            COALESCE(NULLIF(name, ''), name_cfu, 'Parcel ' || fid) AS stand_number,
            province,
            area_ha,
            ST_X(ST_Centroid(ST_Transform(geom, 4326))) AS lng,
            ST_Y(ST_Centroid(ST_Transform(geom, 4326))) AS lat
     FROM vungu_parcels
     WHERE geom IS NOT NULL AND ${CONTAINS('geom')}
     LIMIT 1`,
    [lng, lat],
  )
  if (!r.rows[0]) return null
  const p = r.rows[0]
  return {
    fid: p.fid,
    stand_number: p.stand_number,
    province: p.province,
    area_ha: p.area_ha === null ? null : Number(p.area_ha),
    centroid: [Number(p.lng), Number(p.lat)],
  }
}

async function wardResolver(pg, lng, lat) {
  const r = await pg.query(
    `SELECT name_en FROM wards
     WHERE level = 3 AND ${CONTAINS('geom')} LIMIT 1`,
    [lng, lat],
  )
  return r.rows[0] ? r.rows[0].name_en : null
}

function buildDescription(stand, district) {
  const area = stand.area_ha != null ? ` — ${stand.area_ha} ha` : ''
  const place = district ? `, ${district}` : ''
  return `Parcel ${stand.stand_number}${place}${area}`
}

/**
 * Compose the intake bundle for a point. Pass anything with a `.query`
 * method (a pg Pool or fastify.pg).
 * @returns {{in_jurisdiction:boolean, district:string|null,
 *   authority:object|null, stand:object|null}}
 */
async function resolveLocation(pg, lng, lat) {
  const j = await jurisdictionResolver(pg, lng, lat)
  let stand = null
  if (j.in_jurisdiction) {
    stand = await parcelResolver(pg, lng, lat)
    if (stand) {
      stand.district = j.district
      stand.ward = await wardResolver(pg, lng, lat)
      stand.description = buildDescription(stand, j.district)
    }
  }
  return { ...j, stand }
}

/**
 * Fastify plugin. Register with prefix '/api'; routes live under /api/parcels.
 * @param {import('fastify').FastifyInstance} fastify
 */
async function parcelsRoutes(fastify) {
  fastify.get('/parcels/locate', async (request, reply) => {
    const lng = Number(request.query?.lng)
    const lat = Number(request.query?.lat)
    if (!Number.isFinite(lng) || !Number.isFinite(lat)
        || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      return reply.code(400).send({
        success: false, error: 'bad_request',
        message: 'lng and lat query params are required and must be valid coordinates',
      })
    }
    try {
      const data = await resolveLocation(fastify.pg, lng, lat)
      return { success: true, data }
    } catch (err) {
      request.log.error({ err }, 'parcel locate failed')
      return reply.code(500).send({
        success: false, error: 'internal', message: 'Failed to locate parcel',
      })
    }
  })
}

module.exports = {
  parcelsRoutes,
  resolveLocation,
  jurisdictionResolver,
  parcelResolver,
  wardResolver,
}
