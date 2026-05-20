// src/routes/tiles.js
// Vector tile service: serves zimbabwe.gpkg PostGIS layers as MVT.
const { allLayers, getLayer } = require('../config/spatialLayers')
const { isValidTileCoord, buildTileQuery } = require('../lib/tileQuery')
const { TileCache } = require('../lib/tileCache')

const cache = new TileCache(2000)

/**
 * Fastify plugin. Register with prefix '/api'; routes live under /api/tiles.
 * @param {import('fastify').FastifyInstance} fastify
 */
async function tilesRoutes(fastify) {
  // Layer catalog — drives frontend layer panels.
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
      const { rows } = await fastify.pg.query(
        `SELECT ${attrs}, ST_AsGeoJSON(geom) AS geometry
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
