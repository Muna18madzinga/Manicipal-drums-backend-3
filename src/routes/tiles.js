// src/routes/tiles.js
// Vector tile service: serves zimbabwe.gpkg PostGIS layers as MVT.
const { allLayers, getLayer } = require('../config/spatialLayers')
const { isValidTileCoord, buildTileQuery } = require('../lib/tileQuery')
const { TileCache } = require('../lib/tileCache')

const cache = new TileCache(2000)

/** Capitalise the first letter of a string for tidy result subtitles. */
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

/**
 * Fastify plugin. Register with prefix '/api'; routes live under /api/tiles.
 * @param {import('fastify').FastifyInstance} fastify
 */
async function tilesRoutes(fastify) {
  // Layer catalog — drives frontend layer panels.
  // IMPORTANT: this static route MUST be declared before the parametric
  // /tiles/:layer/:id route below; otherwise Fastify would treat the literal
  // segment "layers" as a value for :layer and shadow this handler entirely.
  // A non-numeric :id (e.g. a stray path segment) reaching that route is
  // intentionally rejected with 400 via the Number.isInteger check.
  fastify.get('/tiles/layers', async () => ({
    success: true,
    data: allLayers().map((l) => ({
      id: l.id,
      title: l.title,
      geomType: l.geomType,
      group: l.group,
      minzoom: l.minzoom,
      maxzoom: l.maxzoom,
    })),
  }))

  // Ward list — flat JSON with centroids, used by the planner ward selector
  // and any "fly to ward" affordance. The GeoPackage stored ward labels as
  // bare numbers, so we join districts on the pcode prefix (ZW{PP}{DD}{WW},
  // first 6 chars = district) and compose a human-readable label like
  // "Ward 18 — Beitbridge". Centroid is WGS84 [lon, lat].
  //
  // Scope: defaults to the council's district (Vungu RDC = Gweru Rural,
  // pcode ZW1704). Override via env COUNCIL_DISTRICT_PCODE, or pass
  // ?scope=country to fetch every ward in Zimbabwe (used by admin tools).
  const COUNCIL_DISTRICT_PCODE = process.env.COUNCIL_DISTRICT_PCODE || 'ZW1704'
  fastify.get('/wards', async (request, reply) => {
    try {
      const scope = request.query?.scope === 'country' ? 'country' : 'council'
      const filter = scope === 'council' ? 'AND w.pcode LIKE $1' : ''
      const params = scope === 'council' ? [`${COUNCIL_DISTRICT_PCODE}%`] : []
      const { rows } = await fastify.pg.query(
        `SELECT w.fid,
                w.name_en AS ward_label,
                w.pcode,
                d.name_en AS district_name,
                ST_X(ST_Centroid(ST_SetSRID(w.geom, 4326))) AS lon,
                ST_Y(ST_Centroid(ST_SetSRID(w.geom, 4326))) AS lat
         FROM wards w
         LEFT JOIN districts d ON d.pcode = LEFT(w.pcode, 6)
         WHERE w.geom IS NOT NULL ${filter}
         ORDER BY d.name_en NULLS LAST,
                  -- numeric ward labels sort naturally
                  CASE WHEN w.name_en ~ '^[0-9]+$' THEN LPAD(w.name_en, 4, '0') ELSE w.name_en END,
                  w.fid`,
        params
      )
      reply
        .header('Cache-Control', 'public, max-age=3600')
        .send({
          success: true,
          data: rows.map((r) => {
            const wardLabel = r.ward_label ? `Ward ${r.ward_label}` : `Ward ${r.fid}`
            const name = r.district_name ? `${wardLabel} — ${r.district_name}` : wardLabel
            return {
              fid: r.fid,
              name,
              pcode: r.pcode || null,
              center: [Number(r.lon), Number(r.lat)],
            }
          }),
        })
    } catch (err) {
      fastify.log.error({ err }, 'ward list query failed')
      return reply.code(500).send({ error: 'Ward lookup failed' })
    }
  })

  // Map search — powers the planner search box. Looks across wards (council
  // district), Vungu parcels + farm cadastre (by name), and named places
  // inside the council district. Returns a flat list of {type, label,
  // center:[lon,lat]} so the frontend can fly the map straight to a hit.
  // Each source is capped so one common term can't return thousands of rows.
  // Named /map-search to avoid colliding with public.js's legacy /search
  // (which queries the old flat `places` table).
  fastify.get('/map-search', async (request, reply) => {
    const q = String(request.query?.q || '').trim()
    // Min 1 char so single-digit ward numbers (1-9) are searchable.
    if (q.length < 1) return { success: true, data: [] }
    const like = `%${q}%`
    const councilPcode = process.env.COUNCIL_DISTRICT_PCODE || 'ZW1704'
    try {
      const out = []

      // Wards in the council district. name_en is a bare number, so match
      // both "5" and "Ward 5".
      const wards = await fastify.pg.query(
        `SELECT w.name_en AS ward, d.name_en AS district,
                ST_X(ST_Centroid(ST_SetSRID(w.geom, 4326))) AS lon,
                ST_Y(ST_Centroid(ST_SetSRID(w.geom, 4326))) AS lat
         FROM wards w
         LEFT JOIN districts d ON d.pcode = LEFT(w.pcode, 6)
         WHERE w.pcode LIKE $1
           AND (w.name_en ILIKE $2 OR ('ward ' || w.name_en) ILIKE $2)
         ORDER BY (CASE WHEN w.name_en ~ '^[0-9]+$' THEN LPAD(w.name_en, 4, '0') ELSE w.name_en END)
         LIMIT 8`,
        [`${councilPcode}%`, like]
      )
      for (const r of wards.rows) {
        out.push({
          type: 'ward',
          label: `Ward ${r.ward}`,
          subtitle: r.district ? `${r.district} Rural District` : 'Ward',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      // Vungu parcels by name (stored as real EPSG:4326).
      const parcels = await fastify.pg.query(
        `SELECT COALESCE(NULLIF(name, ''), name_cfu, 'Parcel ' || fid) AS label,
                district,
                ST_X(ST_Centroid(geom)) AS lon, ST_Y(ST_Centroid(geom)) AS lat
         FROM vungu_parcels
         WHERE geom IS NOT NULL AND (name ILIKE $1 OR name_cfu ILIKE $1)
         LIMIT 8`,
        [like]
      )
      for (const r of parcels.rows) {
        out.push({
          type: 'parcel',
          label: r.label,
          subtitle: r.district ? `Parcel · ${r.district}` : 'Parcel',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      // Vungu farm cadastre by name.
      const farms = await fastify.pg.query(
        `SELECT COALESCE(NULLIF(name, ''), name_cfu, 'Farm ' || fid) AS label,
                ST_X(ST_Centroid(geom)) AS lon, ST_Y(ST_Centroid(geom)) AS lat
         FROM vungu_farm_cadastre
         WHERE geom IS NOT NULL AND (name ILIKE $1 OR name_cfu ILIKE $1)
         LIMIT 8`,
        [like]
      )
      for (const r of farms.rows) {
        out.push({ type: 'farm', label: r.label, subtitle: 'Farm cadastre', center: [Number(r.lon), Number(r.lat)] })
      }

      // Named places (towns / villages) inside the council district.
      const places = await fastify.pg.query(
        `SELECT p.name AS label, p.fclass,
                ST_X(ST_Centroid(ST_SetSRID(p.geom, 4326))) AS lon,
                ST_Y(ST_Centroid(ST_SetSRID(p.geom, 4326))) AS lat
         FROM places_points p
         JOIN districts d ON d.pcode = $2
         WHERE p.name ILIKE $1 AND ST_Within(p.geom, d.geom)
         LIMIT 8`,
        [like, councilPcode]
      )
      for (const r of places.rows) {
        out.push({
          type: 'place',
          label: r.label,
          subtitle: r.fclass ? cap(r.fclass.replace(/_/g, ' ')) : 'Place',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      // Points of interest (schools, clinics, business centres, shops, …)
      // inside the council district — searched by name.
      const pois = await fastify.pg.query(
        `SELECT p.name AS label, p.fclass,
                ST_X(ST_Centroid(ST_SetSRID(p.geom, 4326))) AS lon,
                ST_Y(ST_Centroid(ST_SetSRID(p.geom, 4326))) AS lat
         FROM pois_points p
         JOIN districts d ON d.pcode = $2
         WHERE p.name ILIKE $1 AND ST_Within(p.geom, d.geom)
         LIMIT 8`,
        [like, councilPcode]
      )
      for (const r of pois.rows) {
        out.push({
          type: 'poi',
          label: r.label,
          subtitle: r.fclass ? cap(r.fclass.replace(/_/g, ' ')) : 'Facility',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      // Master-plan proposed peri-urban zones by zone name (EPSG:4326).
      const zones = await fastify.pg.query(
        `SELECT zone AS label,
                ST_X(ST_Centroid(geom)) AS lon, ST_Y(ST_Centroid(geom)) AS lat
         FROM vungu_proposed_peri_urban_zones
         WHERE geom IS NOT NULL AND zone ILIKE $1
         LIMIT 8`,
        [like]
      )
      for (const r of zones.rows) {
        out.push({ type: 'zone', label: r.label, subtitle: 'Proposed peri-urban zone', center: [Number(r.lon), Number(r.lat)] })
      }

      // Beyond peri-urban zones by settlement / tenure name (EPSG:4326).
      const beyond = await fastify.pg.query(
        `SELECT COALESCE(settlement, zone_code) AS label,
                ST_X(ST_Centroid(geom)) AS lon, ST_Y(ST_Centroid(geom)) AS lat
         FROM vungu_beyond_peri_urban_zones
         WHERE geom IS NOT NULL AND (settlement ILIKE $1 OR zone_code ILIKE $1 OR adm3_en ILIKE $1)
         LIMIT 8`,
        [like]
      )
      for (const r of beyond.rows) {
        if (!r.label) continue
        out.push({ type: 'zone', label: r.label, subtitle: 'Land tenure zone', center: [Number(r.lon), Number(r.lat)] })
      }

      // Drop rows with missing or null-island (0,0) centroids — those come
      // from broken geometries and would fly the map into the ocean.
      const data = out.filter((r) =>
        r.label &&
        Number.isFinite(r.center[0]) && Number.isFinite(r.center[1]) &&
        !(r.center[0] === 0 && r.center[1] === 0)
      )
      reply.header('Cache-Control', 'public, max-age=120').send({ success: true, data })
    } catch (err) {
      fastify.log.error({ err, q }, 'map search failed')
      return reply.code(500).send({ error: 'Search failed' })
    }
  })

  // One MVT tile.
  fastify.get('/tiles/:layer/:z/:x/:y.pbf', async (request, reply) => {
    const { layer: layerId } = request.params
    const z = Number(request.params.z)
    const x = Number(request.params.x)
    const y = Number(request.params.y)

    const layer = getLayer(layerId)
    if (!layer) {
      return reply.code(404).send({ error: `Unknown layer: ${layerId}` })
    }
    if (!isValidTileCoord(z, x, y)) {
      return reply.code(400).send({ error: 'Invalid tile coordinate' })
    }
    // Outside the layer's zoom range → empty tile, no DB hit.
    if (z < layer.minzoom || z > layer.maxzoom) {
      return reply.code(204).send()
    }

    const key = `${layerId}/${z}/${x}/${y}`
    const cached = cache.get(key)
    if (cached) {
      return reply
        .header('Content-Type', 'application/vnd.mapbox-vector-tile')
        .header('Cache-Control', 'public, max-age=86400')
        .header('X-Tile-Cache', 'hit')
        .send(cached)
    }

    try {
      const { sql, params } = buildTileQuery(layer, z, x, y)
      const { rows } = await fastify.pg.query(sql, params)
      const tile = rows[0] && rows[0].tile
      if (!tile || tile.length === 0) {
        return reply.code(204).send()
      }
      const buf = Buffer.from(tile)
      cache.set(key, buf)
      return reply
        .header('Content-Type', 'application/vnd.mapbox-vector-tile')
        .header('Cache-Control', 'public, max-age=86400')
        .header('X-Tile-Cache', 'miss')
        .send(buf)
    } catch (err) {
      fastify.log.error({ err, layer: layerId, z, x, y }, 'tile query failed')
      return reply.code(500).send({ error: 'Tile generation failed' })
    }
  })

  // Single feature as GeoJSON — for click-to-inspect popups.
  fastify.get('/tiles/:layer/:id', async (request, reply) => {
    const { layer: layerId, id } = request.params
    const layer = getLayer(layerId)
    if (!layer) {
      return reply.code(404).send({ error: `Unknown layer: ${layerId}` })
    }
    const fid = Number(id)
    if (!Number.isInteger(fid)) {
      return reply.code(400).send({ error: 'Invalid feature id' })
    }
    try {
      const attrs = layer.attributes.map((a) => `"${a}"`).join(', ')
      // fid is the GeoPackage primary key on every imported table, so this lookup is index-backed.
      // ST_AsGeoJSON validates the geometry SRID against spatial_ref_sys and
      // refuses non-EPSG entries (the GeoPackage import landed under SRID
      // 900914 = WGS 84 CRS84 with auth_name=NULL). ST_SetSRID just relabels
      // the metadata; the coordinates are already WGS84 lon/lat so no actual
      // reprojection is needed.
      const { rows } = await fastify.pg.query(
        `SELECT ${attrs}, ST_AsGeoJSON(ST_SetSRID(geom, 4326)) AS geometry
         FROM "${layer.table}" WHERE fid = $1`,
        [fid]
      )
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Feature not found' })
      }
      const { geometry, ...properties } = rows[0]
      return {
        type: 'Feature',
        geometry: JSON.parse(geometry),
        properties: { ...properties, layer: layerId },
      }
    } catch (err) {
      fastify.log.error({ err, layer: layerId, id }, 'feature query failed')
      return reply.code(500).send({ error: 'Feature lookup failed' })
    }
  })
}

module.exports = { tilesRoutes }
