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
