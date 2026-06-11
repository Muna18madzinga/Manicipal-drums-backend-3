// src/routes/tiles.js
// Vector tile service: serves PostGIS layers as MVT (PBF).
//
// This file implements:
//   GET /api/tiles/layers           - layer catalog (JSON)
//   GET /api/tiles/:layer/:z/:x/:y.pbf - one MVT tile (binary, gzip)
//   GET /api/tiles/:layer/:id       - single feature GeoJSON popup
//   GET /api/tiles/topo/:layer      - full layer as simplified TopoJSON
//   GET /api/tiles/cache/stats      - cache diagnostics (admin only)
//   DELETE /api/tiles/cache/:layer  - invalidate one layer (admin only)

const zlib = require('zlib')
const { promisify } = require('util')
const gzip = promisify(zlib.gzip)

const { allLayers, getLayer } = require('../config/spatialLayers')
const { isValidTileCoord, buildTileQuery } = require('../lib/tileQuery')
const { TileCache } = require('../lib/tileCache')
const { requireAuth, requireRole } = require('../middleware/jwtAuth')

// 4 000 tiles, 128 MB max, 24 h TTL
const cache = new TileCache(4000, 128 * 1024 * 1024, 24 * 60 * 60 * 1000)

function etagFor(key) {
  const day = new Date().toISOString().slice(0, 10)
  const hash = Buffer.from(`${key}:${day}`).toString('base64').slice(0, 16)
  return `"${hash}"`
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

async function tilesRoutes(fastify) {
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

  fastify.get('/tiles/cache/stats',
    { preHandler: [requireAuth, requireRole(['admin'])] },
    async () => ({ success: true, data: cache.stats() })
  )

  fastify.delete('/tiles/cache/:layer',
    { preHandler: [requireAuth, requireRole(['admin'])] },
    async (req) => {
      const count = cache.invalidateLayer(req.params.layer)
      return { success: true, data: { invalidated: count, layer: req.params.layer } }
    }
  )

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
            const name = r.district_name ? `${wardLabel} - ${r.district_name}` : wardLabel
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

  fastify.get('/map-search', async (request, reply) => {
    const q = String(request.query?.q || '').trim()
    if (q.length < 1) return { success: true, data: [] }
    const like = `%${q}%`
    const councilPcode = process.env.COUNCIL_DISTRICT_PCODE || 'ZW1704'

    try {
      const out = []

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

      const districts = await fastify.pg.query(
        `SELECT name_en AS label,
                ST_X(ST_Centroid(ST_SetSRID(geom, 4326))) AS lon,
                ST_Y(ST_Centroid(ST_SetSRID(geom, 4326))) AS lat
         FROM districts
         WHERE level = 2 AND name_en ILIKE $1
         ORDER BY name_en
         LIMIT 8`,
        [like]
      )
      for (const r of districts.rows) {
        out.push({
          type: 'place',
          label: r.label,
          subtitle: 'District',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

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
          subtitle: r.district ? `Parcel - ${r.district}` : 'Parcel',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      const farms = await fastify.pg.query(
        `SELECT COALESCE(NULLIF(name, ''), name_cfu, 'Farm ' || fid) AS label,
                ST_X(ST_Centroid(geom)) AS lon, ST_Y(ST_Centroid(geom)) AS lat
         FROM vungu_farm_cadastre
         WHERE geom IS NOT NULL AND (name ILIKE $1 OR name_cfu ILIKE $1)
         LIMIT 8`,
        [like]
      )
      for (const r of farms.rows) {
        out.push({
          type: 'farm',
          label: r.label,
          subtitle: 'Farm cadastre',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      const places = await fastify.pg.query(
        `SELECT p.name AS label, p.fclass,
                d.name_en AS district,
                ST_X(ST_Centroid(ST_SetSRID(p.geom, 4326))) AS lon,
                ST_Y(ST_Centroid(ST_SetSRID(p.geom, 4326))) AS lat
         FROM places_points p
         LEFT JOIN districts d
           ON d.level = 2 AND ST_Contains(d.geom, ST_SetSRID(p.geom, ST_SRID(d.geom)))
         WHERE p.name ILIKE $1
         ORDER BY p.name
         LIMIT 8`,
        [like]
      )
      for (const r of places.rows) {
        out.push({
          type: 'place',
          label: r.label,
          subtitle: r.district ? `${r.district} Rural District` : 'Place',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      const pois = await fastify.pg.query(
        `SELECT p.name AS label, p.fclass,
                ST_X(ST_Centroid(ST_SetSRID(p.geom, 4326))) AS lon,
                ST_Y(ST_Centroid(ST_SetSRID(p.geom, 4326))) AS lat
         FROM pois_points p
         WHERE p.name ILIKE $1
         ORDER BY p.name
         LIMIT 8`,
        [like]
      )
      for (const r of pois.rows) {
        out.push({
          type: 'poi',
          label: r.label,
          subtitle: r.fclass ? cap(r.fclass.replace(/_/g, ' ')) : 'Facility',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      const zones = await fastify.pg.query(
        `SELECT zone AS label,
                ST_X(ST_Centroid(geom)) AS lon, ST_Y(ST_Centroid(geom)) AS lat
         FROM vungu_proposed_peri_urban_zones
         WHERE geom IS NOT NULL AND zone ILIKE $1
         LIMIT 8`,
        [like]
      )
      for (const r of zones.rows) {
        out.push({
          type: 'zone',
          label: r.label,
          subtitle: 'Proposed peri-urban zone',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

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
        out.push({
          type: 'zone',
          label: r.label,
          subtitle: 'Land tenure zone',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

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
    if (z < layer.minzoom || z > layer.maxzoom) {
      return reply
        .header('Cache-Control', 'public, max-age=604800')
        .code(204).send()
    }

    const key = `${layerId}/${z}/${x}/${y}`
    const etag = etagFor(key)

    if (request.headers['if-none-match'] === etag) {
      return reply.code(304).send()
    }

    const cached = cache.get(key)
    if (cached) {
      return reply
        .header('Content-Type', 'application/vnd.mapbox-vector-tile')
        .header('Content-Encoding', 'gzip')
        .header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600')
        .header('ETag', etag)
        .header('X-Tile-Cache', 'hit')
        .send(cached)
    }

    try {
      const { sql, params } = buildTileQuery(layer, z, x, y)
      const { rows } = await fastify.pg.query(sql, params)
      const rawTile = rows[0]?.tile

      if (!rawTile || rawTile.length === 0) {
        return reply
          .header('Cache-Control', 'public, max-age=3600')
          .code(204).send()
      }

      const compressed = await gzip(Buffer.from(rawTile), { level: 6 })
      cache.set(key, compressed)

      return reply
        .header('Content-Type', 'application/vnd.mapbox-vector-tile')
        .header('Content-Encoding', 'gzip')
        .header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600')
        .header('ETag', etag)
        .header('X-Tile-Cache', 'miss')
        .send(compressed)
    } catch (err) {
      fastify.log.error({ err, layer: layerId, z, x, y }, 'tile query failed')
      return reply.code(500).send({ error: 'Tile generation failed' })
    }
  })

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
      const { rows } = await fastify.pg.query(
        `SELECT ${attrs}, ST_AsGeoJSON(ST_SetSRID(geom, 4326), 6) AS geometry
         FROM "${layer.table}" WHERE fid = $1`,
        [fid]
      )
      if (!rows.length) {
        return reply.code(404).send({ error: 'Feature not found' })
      }
      const { geometry, ...properties } = rows[0]
      return {
        type: 'Feature',
        geometry: JSON.parse(geometry),
        properties: { ...properties, _layer: layerId },
      }
    } catch (err) {
      fastify.log.error({ err, layer: layerId, id }, 'feature lookup failed')
      return reply.code(500).send({ error: 'Feature lookup failed' })
    }
  })

  fastify.get('/tiles/topo/:layer', async (request, reply) => {
    const layer = getLayer(request.params.layer)
    if (!layer) {
      return reply.code(404).send({ error: `Unknown layer: ${request.params.layer}` })
    }
    if (layer.group !== 'admin') {
      return reply.code(400).send({ error: 'TopoJSON only available for admin boundary layers' })
    }
    try {
      const attrs = layer.attributes.filter((a) => a !== 'fid')
      const attrPairs = attrs.map((a) => `'${a}', "${a}"`).join(', ')
      const simplifyDeg = 0.005
      const { rows } = await fastify.pg.query(
        `SELECT jsonb_agg(
           jsonb_build_object(
             'type', 'Feature',
             'id', fid,
             'geometry', ST_AsGeoJSON(
               ST_SimplifyPreserveTopology(ST_SetSRID(geom,4326), $1),
               5
             )::jsonb,
             'properties', jsonb_build_object(${attrPairs})
           )
         ) AS features
         FROM "${layer.table}"
         WHERE geom IS NOT NULL`,
        [simplifyDeg]
      )
      const features = rows[0]?.features || []
      let topology
      try {
        const { topology: topoFn } = require('topojson-server')
        topology = topoFn({ [layer.id]: { type: 'FeatureCollection', features } })
      } catch {
        topology = { type: 'FeatureCollection', features }
      }
      const json = JSON.stringify(topology)
      const compressed = await gzip(Buffer.from(json))
      return reply
        .header('Content-Type', 'application/geo+json')
        .header('Content-Encoding', 'gzip')
        .header('Cache-Control', 'public, max-age=604800')
        .send(compressed)
    } catch (err) {
      fastify.log.error({ err, layer: request.params.layer }, 'topo query failed')
      return reply.code(500).send({ error: 'TopoJSON generation failed' })
    }
  })
}

module.exports = { tilesRoutes }
