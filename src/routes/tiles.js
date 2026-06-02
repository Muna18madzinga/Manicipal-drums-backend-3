// src/routes/tiles.js
// Vector tile service: serves zimbabwe.gpkg PostGIS layers as MVT (PBF).
//
// Expert rationale for format choice (GeoJSON vs TopoJSON vs MVT):
//
//   GeoJSON   — human-readable, large (full coordinate verbosity), no zoom
//               awareness, not suitable for large polygon datasets. Use only
//               for single-feature popups / search results.
//
//   TopoJSON  — topology-aware encoding; shares arc segments between adjacent
//               polygons → 20–80 % smaller than GeoJSON for boundary files.
//               NOT natively supported by MapLibre GL JS; requires client-side
//               conversion, adding CPU overhead on low-end devices. Best for
//               static choropleth / D3 analytics views.
//               This server provides a dedicated /tiles/topo/:layer endpoint.
//
//   MVT/PBF   — Mapbox Vector Tile (Protocol Buffers, binary). PostGIS
//               ST_AsMVT produces them server-side; MapLibre renders them via
//               GPU with no JS parsing. Zoom-aware (minzoom/maxzoom), tile-
//               cached, gzip-compressible. 80–95 % smaller than equivalent
//               GeoJSON; supports 100 000+ features with no client-side
//               performance hit. This is the correct format for all interactive
//               map layers in SpartialIQ.
//
// This file implements:
//   GET /api/tiles/layers           — layer catalog (JSON)
//   GET /api/tiles/:layer/:z/:x/:y.pbf — one MVT tile (binary, gzip)
//   GET /api/tiles/:layer/:id       — single feature GeoJSON popup
//   GET /api/tiles/topo/:layer      — full layer as simplified TopoJSON
//   GET /api/tiles/cache/stats      — cache diagnostics (admin only)
//   DELETE /api/tiles/cache/:layer  — invalidate one layer (admin only)

const zlib = require('zlib')
const { promisify } = require('util')
const gzip = promisify(zlib.gzip)

const { allLayers, getLayer } = require('../config/spatialLayers')
const { isValidTileCoord, buildTileQuery, buildBboxGeoJsonQuery } = require('../lib/tileQuery')
const { TileCache } = require('../lib/tileCache')
const { requireAuth, requireRole } = require('../middleware/jwtAuth')

// 4 000 tiles, 128 MB max, 24 h TTL
const cache = new TileCache(4000, 128 * 1024 * 1024, 24 * 60 * 60 * 1000)

/** Compute a simple ETag from layer + z/x/y and today's date for daily invalidation. */
function etagFor(key) {
  const day = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const hash = Buffer.from(`${key}:${day}`).toString('base64').slice(0, 16)
  return `"${hash}"`
}

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
async function tilesRoutes(fastify) {

  // ── Layer catalog ──────────────────────────────────────────────────────────
  fastify.get('/tiles/layers', async () => ({
    success: true,
    data: allLayers().map((l) => ({
      id:       l.id,
      title:    l.title,
      geomType: l.geomType,
      group:    l.group,
      minzoom:  l.minzoom,
      maxzoom:  l.maxzoom,
    })),
  }))

  // ── Cache diagnostics (admin only) ─────────────────────────────────────────
  fastify.get('/tiles/cache/stats',
    { preHandler: [requireAuth, requireRole(['admin'])] },
    async () => ({ success: true, data: cache.stats() })
  )

  // ── Invalidate layer cache (admin only) ────────────────────────────────────
  fastify.delete('/tiles/cache/:layer',
    { preHandler: [requireAuth, requireRole(['admin'])] },
    async (req, reply) => {
      const count = cache.invalidateLayer(req.params.layer)
      return { success: true, data: { invalidated: count, layer: req.params.layer } }
    }
  )

  // ── MVT tile endpoint ──────────────────────────────────────────────────────
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
    // Outside zoom range → empty tile (no DB hit, no bandwidth)
    if (z < layer.minzoom || z > layer.maxzoom) {
      return reply
        .header('Cache-Control', 'public, max-age=604800') // 7 d
        .code(204).send()
    }

    const key = `${layerId}/${z}/${x}/${y}`
    const etag = etagFor(key)

    // ETag conditional request — save bandwidth when tile is unchanged
    if (request.headers['if-none-match'] === etag) {
      return reply.code(304).send()
    }

    const cached = cache.get(key)
    if (cached) {
      return reply
        .header('Content-Type',     'application/vnd.mapbox-vector-tile')
        .header('Content-Encoding', 'gzip')
        .header('Cache-Control',    'public, max-age=86400, stale-while-revalidate=3600')
        .header('ETag',             etag)
        .header('X-Tile-Cache',     'hit')
        .send(cached)
    }

    try {
      const { sql, params } = buildTileQuery(layer, z, x, y)
      const { rows } = await fastify.pg.query(sql, params)
      const rawTile = rows[0]?.tile

      if (!rawTile || rawTile.length === 0) {
        // Empty tile — cache the 204 response to avoid re-querying empty areas
        return reply
          .header('Cache-Control', 'public, max-age=3600')
          .code(204).send()
      }

      // Gzip the tile before caching — MVT tiles are already binary (protobuf)
      // but gzip achieves an additional 60-80 % on typical spatial data.
      const compressed = await gzip(Buffer.from(rawTile), { level: 6 })
      cache.set(key, compressed)

      return reply
        .header('Content-Type',     'application/vnd.mapbox-vector-tile')
        .header('Content-Encoding', 'gzip')
        .header('Cache-Control',    'public, max-age=86400, stale-while-revalidate=3600')
        .header('ETag',             etag)
        .header('X-Tile-Cache',     'miss')
        .send(compressed)

    } catch (err) {
      fastify.log.error({ err, layer: layerId, z, x, y }, 'tile query failed')
      return reply.code(500).send({ error: 'Tile generation failed' })
    }
  })

  // ── Single feature GeoJSON — click-to-inspect popups ──────────────────────
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
      fastify.log.error({ err, layer: layerId, id }, 'feature query failed')
      return reply.code(500).send({ error: 'Feature lookup failed' })
    }
  })

  // ── TopoJSON endpoint for admin boundary analytics ─────────────────────────
  // TopoJSON encodes shared arcs between adjacent polygons once rather than
  // repeating them in every feature. For static admin boundaries (provinces,
  // districts, wards) this reduces payload 40-70 % vs GeoJSON.
  // MapLibre does not consume TopoJSON directly; this endpoint is for:
  //   • D3.js choropleth / thematic maps in the analytics view
  //   • Client-side spatial join queries
  //   • Offline / low-bandwidth export
  //
  // Simplification tolerance: 0.005° (~555 m) — appropriate for
  // province/district overviews at z6–z9.
  fastify.get('/tiles/topo/:layer', async (request, reply) => {
    const layer = getLayer(request.params.layer)
    if (!layer) {
      return reply.code(404).send({ error: `Unknown layer: ${request.params.layer}` })
    }
    // Only serve admin boundaries via this endpoint (large polygon layers)
    if (layer.group !== 'admin') {
      return reply.code(400).send({ error: 'TopoJSON only available for admin boundary layers' })
    }
    try {
      // Fetch simplified GeoJSON from PostGIS
      const attrs = layer.attributes.filter(a => a !== 'fid')
      const simplifyDeg = 0.005 // ~555 m — admin overview level
      const { rows } = await fastify.pg.query(
        `SELECT jsonb_agg(
           jsonb_build_object(
             'type', 'Feature',
             'id', fid,
             'geometry', ST_AsGeoJSON(
               ST_SimplifyPreserveTopology(ST_SetSRID(geom,4326), $1),
               5
             )::jsonb,
             'properties', jsonb_build_object(${
               attrs.map(a => `'${a}', "${a}"`).join(', ')
             })
           )
         ) AS features
         FROM "${layer.table}"
         WHERE geom IS NOT NULL`,
        [simplifyDeg]
      )
      const features = rows[0]?.features || []
      // Convert to actual TopoJSON using topojson-server (installed).
      // topology() shares arc segments between adjacent polygons, reducing
      // province/district boundary payload by 40–70 % vs GeoJSON.
      let topology
      try {
        const { topology: topoFn } = require('topojson-server')
        topology = topoFn({ [layer.id]: { type: 'FeatureCollection', features } })
      } catch {
        // Fallback to plain GeoJSON FC if topojson-server unavailable
        topology = { type: 'FeatureCollection', features }
      }
      const json = JSON.stringify(topology)
      const compressed = await gzip(Buffer.from(json))
      return reply
        .header('Content-Type',     'application/geo+json')
        .header('Content-Encoding', 'gzip')
        .header('Cache-Control',    'public, max-age=604800') // 7 days — static boundaries
        .send(compressed)
    } catch (err) {
      fastify.log.error({ err, layer: request.params.layer }, 'topo query failed')
      return reply.code(500).send({ error: 'TopoJSON generation failed' })
    }
  })
}

module.exports = { tilesRoutes }
