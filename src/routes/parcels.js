// src/routes/parcels.js
// Parcel/stand spatial lookup for the planner intake map picker.
// Resolves an arbitrary lng/lat into a jurisdiction + stand bundle.

const { requireRole } = require('../middleware/jwtAuth')

const VUNGU_AUTHORITY = 'Vungu Rural District Council'

// Roles allowed to use the site inspector (/parcels/nearby). It returns
// register ownership details (PII), so it mirrors the Property File gate
// in the frontend router.
const STAFF_ROLES = ['planner', 'planning_clerk', 'eo', 'gis_officer',
  'env_officer', 'building_inspector', 'surveyor', 'admin']

// SRIDs as they exist in Vungu_spatial333 (verified 2026-07): the OSM/gpkg
// layers (roads, buildings, pois_points) carry the custom 900914 (≡ CRS84
// degrees), vungu_parcels is 4326. Constants keep ST_DWithin index-friendly;
// if a reimport changes an SRID these queries fail loudly rather than lie.
const OSM_SRID = 900914

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
 * Register ownership for a stand, from the Property File land register
 * (spatial_planning.property / parcel_owner, migration 084). The register is
 * keyed by stand_number text — same identifier parcelResolver emits.
 */
async function ownersForStand(pg, standNumber) {
  const r = await pg.query(
    `SELECT po.name, po.role, po.company, po.phone, po.email
     FROM spatial_planning.property pr
     JOIN spatial_planning.parcel_owner po ON po.property_id = pr.id
     WHERE UPPER(pr.stand_number) = UPPER($1)
     ORDER BY po.role, po.name`,
    [standNumber],
  )
  return r.rows
}

/**
 * Everything within radiusM metres of a point: named roads, POIs, building
 * count, neighbouring parcels and development applications on those parcels.
 * Degree prefilter (uses the 074 GiST indexes) + exact geography distance.
 */
async function nearbyResolver(pg, lng, lat, radiusM) {
  // 1° latitude ≈ 111 km; 1.1 margin covers longitude shrink at Vungu's
  // latitude (~-19.5°, cos ≈ 0.94). Exact metre filter applied after.
  const deg = (radiusM / 111000) * 1.1

  const roadsQ = pg.query(
    `WITH pt AS (SELECT ST_SetSRID(ST_MakePoint($1,$2), ${OSM_SRID}) AS g,
                        ST_SetSRID(ST_MakePoint($1,$2), 4326)::geography AS gg)
     SELECT name, fclass, MIN(d)::int AS dist_m
     FROM (SELECT COALESCE(NULLIF(r.name,''), r.fclass) AS name, r.fclass,
                  ST_Distance(ST_SetSRID(r.geom,4326)::geography, pt.gg) AS d
           FROM roads r, pt
           WHERE ST_DWithin(r.geom, pt.g, $3)) s
     WHERE d <= $4
     GROUP BY name, fclass
     ORDER BY dist_m
     LIMIT 10`,
    [lng, lat, deg, radiusM],
  )

  const poisQ = pg.query(
    `WITH pt AS (SELECT ST_SetSRID(ST_MakePoint($1,$2), ${OSM_SRID}) AS g,
                        ST_SetSRID(ST_MakePoint($1,$2), 4326)::geography AS gg)
     SELECT COALESCE(NULLIF(p.name,''), p.fclass) AS name, p.fclass,
            ST_Distance(ST_SetSRID(p.geom,4326)::geography, pt.gg)::int AS dist_m
     FROM pois_points p, pt
     WHERE ST_DWithin(p.geom, pt.g, $3)
       AND ST_Distance(ST_SetSRID(p.geom,4326)::geography, pt.gg) <= $4
     ORDER BY dist_m
     LIMIT 10`,
    [lng, lat, deg, radiusM],
  )

  // ponytail: count uses the degree prefilter only (±6% at radius edge over
  // 711k rows) — switch to exact geography if the count ever drives decisions.
  const buildingsQ = pg.query(
    `SELECT count(*)::int AS n FROM buildings
     WHERE ST_DWithin(geom, ST_SetSRID(ST_MakePoint($1,$2), ${OSM_SRID}), $3)`,
    [lng, lat, radiusM / 111000],
  )

  const parcelsQ = pg.query(
    `WITH pt AS (SELECT ST_SetSRID(ST_MakePoint($1,$2), 4326) AS g)
     SELECT fid,
            COALESCE(NULLIF(name,''), name_cfu, 'Parcel ' || fid) AS stand_number,
            status, area_ha,
            ST_Distance(geom::geography, pt.g::geography)::int AS dist_m
     FROM vungu_parcels, pt
     WHERE geom IS NOT NULL AND ST_DWithin(geom, pt.g, $3)
     ORDER BY dist_m
     LIMIT 10`,
    [lng, lat, deg],
  )

  // Applications locate through their parcel (boundary_geometry is not yet
  // populated by any intake path — join again when it is).
  const appsQ = pg.query(
    `SELECT da.application_number, da.status, da.application_type,
            da.date_submitted::date AS date_submitted,
            COALESCE(NULLIF(p.name,''), p.name_cfu, 'Parcel ' || p.fid) AS stand_number
     FROM development_applications da
     JOIN vungu_parcels p ON p.fid = da.parcel_id
     WHERE p.geom IS NOT NULL
       AND ST_DWithin(p.geom, ST_SetSRID(ST_MakePoint($1,$2), 4326), $3)
     ORDER BY da.date_submitted DESC NULLS LAST
     LIMIT 10`,
    [lng, lat, deg],
  )

  const [roads, pois, buildings, parcels, apps] =
    await Promise.all([roadsQ, poisQ, buildingsQ, parcelsQ, appsQ])
  return {
    roads: roads.rows,
    pois: pois.rows,
    buildings: buildings.rows[0].n,
    parcels: parcels.rows.map(r => ({
      ...r, area_ha: r.area_ha === null ? null : Number(r.area_ha),
    })),
    applications: apps.rows,
  }
}

/**
 * Name → parcel lookup for deep links (/gis-map?stand=…) and search.
 * Exact (case-insensitive) matches sort first, then smallest parcels — a
 * subdivided farm beats the giant parent when both contain the query.
 * ponytail: vungu_parcels only — UNION the stands table when it gains rows.
 */
async function findParcels(pg, q) {
  const r = await pg.query(
    `SELECT fid,
            COALESCE(NULLIF(name,''), name_cfu, 'Parcel ' || fid) AS stand_number,
            status, area_ha, district,
            ST_X(ST_Centroid(geom)) AS lng, ST_Y(ST_Centroid(geom)) AS lat,
            ST_XMin(geom) AS minx, ST_YMin(geom) AS miny,
            ST_XMax(geom) AS maxx, ST_YMax(geom) AS maxy
     FROM vungu_parcels
     WHERE geom IS NOT NULL AND (name ILIKE $1 OR name_cfu ILIKE $1)
     ORDER BY (LOWER(name) = LOWER($2) OR LOWER(name_cfu) = LOWER($2)) DESC,
              area_ha ASC NULLS LAST
     LIMIT 5`,
    [`%${q}%`, q],
  )
  return r.rows.map(p => ({
    fid: p.fid,
    stand_number: p.stand_number,
    status: p.status,
    district: p.district,
    area_ha: p.area_ha === null ? null : Number(p.area_ha),
    centroid: [Number(p.lng), Number(p.lat)],
    bbox: [Number(p.minx), Number(p.miny), Number(p.maxx), Number(p.maxy)],
  }))
}

/**
 * Area-weighted land-use distribution across the cadastre, from
 * vungu_parcels.status (the land-use class carried by the GPKG import).
 * Feeds the planner map's View Analytics panel.
 */
async function landuseStats(pg) {
  const r = await pg.query(
    `SELECT COALESCE(NULLIF(status, ''), 'Unclassified') AS land_use,
            COUNT(*)::int AS parcels,
            ROUND(SUM(area_ha)::numeric, 1) AS area_ha,
            ROUND((100 * SUM(area_ha) / NULLIF(SUM(SUM(area_ha)) OVER (), 0))::numeric, 1) AS pct
     FROM vungu_parcels
     WHERE area_ha IS NOT NULL
     GROUP BY 1
     ORDER BY SUM(area_ha) DESC`)
  return r.rows.map(x => ({
    land_use: x.land_use,
    parcels: x.parcels,
    area_ha: Number(x.area_ha),
    pct: Number(x.pct),
  }))
}

function parseLngLat(query) {
  const lng = Number(query?.lng)
  const lat = Number(query?.lat)
  if (!Number.isFinite(lng) || !Number.isFinite(lat)
      || lng < -180 || lng > 180 || lat < -90 || lat > 90) return null
  return { lng, lat }
}

/**
 * Fastify plugin. Register with prefix '/api'; routes live under /api/parcels.
 * @param {import('fastify').FastifyInstance} fastify
 */
async function parcelsRoutes(fastify) {
  fastify.get('/parcels/locate', async (request, reply) => {
    const pt = parseLngLat(request.query)
    if (!pt) {
      return reply.code(400).send({
        success: false, error: 'bad_request',
        message: 'lng and lat query params are required and must be valid coordinates',
      })
    }
    try {
      const data = await resolveLocation(fastify.pg, pt.lng, pt.lat)
      return { success: true, data }
    } catch (err) {
      request.log.error({ err }, 'parcel locate failed')
      return reply.code(500).send({
        success: false, error: 'internal', message: 'Failed to locate parcel',
      })
    }
  })

  // Name → parcel lookup (public: same attributes the public tiles expose).
  fastify.get('/parcels/find', async (request, reply) => {
    const q = String(request.query?.q || '').trim()
    if (!q) {
      return reply.code(400).send({
        success: false, error: 'bad_request', message: 'q query param is required',
      })
    }
    try {
      return { success: true, data: await findParcels(fastify.pg, q) }
    } catch (err) {
      request.log.error({ err }, 'parcel find failed')
      return reply.code(500).send({
        success: false, error: 'internal', message: 'Failed to search parcels',
      })
    }
  })

  // Land-use distribution (public: aggregate of what the public tiles show).
  fastify.get('/parcels/landuse-stats', async (request, reply) => {
    try {
      return { success: true, data: await landuseStats(fastify.pg) }
    } catch (err) {
      request.log.error({ err }, 'landuse stats failed')
      return reply.code(500).send({
        success: false, error: 'internal', message: 'Failed to compute land-use stats',
      })
    }
  })

  // Site inspector: identify + buffer in one call. Staff-only — the response
  // includes land-register ownership, which citizens must not see.
  fastify.get('/parcels/nearby',
    { preHandler: requireRole(fastify, STAFF_ROLES) },
    async (request, reply) => {
      const pt = parseLngLat(request.query)
      if (!pt) {
        return reply.code(400).send({
          success: false, error: 'bad_request',
          message: 'lng and lat query params are required and must be valid coordinates',
        })
      }
      const radius = Math.min(2000, Math.max(50, Number(request.query?.radius) || 500))
      try {
        const [site, nearby] = await Promise.all([
          resolveLocation(fastify.pg, pt.lng, pt.lat),
          nearbyResolver(fastify.pg, pt.lng, pt.lat, radius),
        ])
        if (site.stand) {
          site.stand.owners = await ownersForStand(fastify.pg, site.stand.stand_number)
        }
        return { success: true, data: { site, radius_m: radius, ...nearby } }
      } catch (err) {
        request.log.error({ err }, 'parcel nearby failed')
        return reply.code(500).send({
          success: false, error: 'internal', message: 'Failed to query surroundings',
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
  nearbyResolver,
  ownersForStand,
  findParcels,
  landuseStats,
}
