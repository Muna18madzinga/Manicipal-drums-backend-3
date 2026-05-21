// src/lib/tileQuery.js
// Pure helpers for building PostGIS vector-tile (MVT) queries.
const { GEOM_COLUMN, GEOM_SRID } = require('../config/spatialLayers')

/**
 * Validates a slippy-map tile coordinate.
 * @param {number} z @param {number} x @param {number} y
 * @returns {boolean}
 */
function isValidTileCoord(z, x, y) {
  if (![z, x, y].every((n) => Number.isInteger(n))) return false
  if (z < 0 || z > 22) return false
  const max = 2 ** z
  return x >= 0 && x < max && y >= 0 && y < max
}

/**
 * Builds the parameterized SQL that returns one MVT tile for a layer.
 * The table, geometry column and attribute names come from the registry
 * (an allowlist), so they are safe to interpolate. z/x/y and the MVT
 * layer name are passed as bound parameters.
 *
 * @param {import('../config/spatialLayers').SpatialLayer} layer
 * @param {number} z @param {number} x @param {number} y
 * @returns {{ sql: string, params: any[] }}
 */
function buildTileQuery(layer, z, x, y) {
  const attrs = layer.attributes.map((a) => `"${a}"`).join(', ')
  let filter = ''
  if (layer.lowZoomFilter && z < layer.lowZoomFilter.maxZoom) {
    filter = ` AND (${layer.lowZoomFilter.where})`
  }
  const sql = `
    SELECT ST_AsMVT(t, $4) AS tile FROM (
      SELECT
        ST_AsMVTGeom(
          ST_Transform("${GEOM_COLUMN}", 3857),
          ST_TileEnvelope($1, $2, $3),
          4096, 64, true
        ) AS geom,
        ${attrs}
      FROM "${layer.table}"
      WHERE "${GEOM_COLUMN}" && ST_Transform(ST_TileEnvelope($1, $2, $3), ${GEOM_SRID})${filter}
    ) AS t
    WHERE t.geom IS NOT NULL
  `
  return { sql, params: [z, x, y, layer.id] }
}

module.exports = { isValidTileCoord, buildTileQuery }
