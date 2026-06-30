// src/lib/tileQuery.js
// Pure helpers for building PostGIS vector-tile (MVT) queries.
// Enhanced: zoom-aware geometry simplification using ST_SimplifyPreserveTopology
// so low-zoom tiles are lightweight (admin boundaries ~10 KB/tile) and
// high-zoom tiles carry full-precision geometry.
const { GEOM_COLUMN, GEOM_SRID } = require('../config/spatialLayers')

/**
 * Validates a slippy-map tile coordinate.
 */
function isValidTileCoord(z, x, y) {
  if (![z, x, y].every((n) => Number.isInteger(n))) return false
  if (z < 0 || z > 22) return false
  const max = 2 ** z
  return x >= 0 && x < max && y >= 0 && y < max
}

/**
 * Returns the ST_SimplifyPreserveTopology tolerance for a given zoom level
 * in the layer's native SRID (degrees for WGS84/900914).
 * At z=0 the world is ~360°; each zoom halves it.
 * We use 1/512th of the tile width as the snap tolerance so that
 * sub-pixel detail is stripped before MVT encoding.
 *
 * Results are in degrees (SRID 900914 / 4326 units):
 *   z=4  → 0.0439°  (~4.9 km at equator)  — just country outlines
 *   z=8  → 0.00274° (~304 m)              — province/district outlines
 *   z=12 → 0.000171°(~19 m)               — ward boundaries
 *   z=15 → 0.0000214°(~2.4 m)             — parcel / building detail
 *   z>=16 → 0 (no simplification)
 */
function snapTolerance(z) {
  if (z >= 16) return 0
  // tile width in degrees / MVT extent (4096 px) / 2 = half-pixel snap
  const tileWidthDeg = 360 / Math.pow(2, z)
  return (tileWidthDeg / 4096) * 0.5
}

/**
 * Builds the parameterized SQL that returns one MVT tile for a layer.
 * The table, geometry column and attribute names come from the registry
 * (an allowlist), so they are safe to interpolate. z/x/y and the MVT
 * layer name are passed as bound parameters.
 *
 * Optimization layers:
 *  1. Bounding-box pre-filter using GiST index on geom (&&)
 *  2. Zoom-aware ST_SimplifyPreserveTopology reduces vertex count by 60-95%
 *     at low zoom levels without distorting topology
 *  3. ST_AsMVTGeom clips to tile envelope + 64-px buffer
 *  4. NULL geom rows filtered before MVT aggregation
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

  const tol = snapTolerance(z)
  // For points simplification has no meaning; apply only to polygon/line.
  const geomExpr = (tol > 0 && layer.geomType !== 'point')
    ? `ST_SimplifyPreserveTopology("${GEOM_COLUMN}", ${tol})`
    : `"${GEOM_COLUMN}"`

  // Storage SRID is per-layer. OSM-derived tables share GEOM_SRID (900914,
  // legacy CRS84 import); Vungu master-plan tables are stored as real
  // EPSG:4326. The && operator requires matching SRIDs on both sides, so
  // we transform the tile envelope into the layer's own SRID.
  const layerSrid = layer.srid || GEOM_SRID
  const sql = `
    SELECT ST_AsMVT(t, $4, 4096, 'geom') AS tile FROM (
      SELECT
        ST_AsMVTGeom(
          ST_Transform(${geomExpr}, 3857),
          ST_TileEnvelope($1, $2, $3),
          4096, 64, true
        ) AS geom,
        ${attrs}
      FROM "${layer.table}"
      WHERE "${GEOM_COLUMN}" && ST_Transform(ST_TileEnvelope($1, $2, $3), ${layerSrid})${filter}
    ) AS t
    WHERE t.geom IS NOT NULL
  `
  return { sql, params: [z, x, y, layer.id] }
}

/**
 * Builds a GeoJSON FeatureCollection query for a layer within a bounding box.
 * Used by the TopoJSON and analytics endpoints; returns simplified geometry
 * at an appropriate level for choropleth/analysis rendering.
 *
 * @param {string} table
 * @param {string[]} attributes
 * @param {number} simplifyDeg  tolerance in degrees (0 = full precision)
 * @returns {{ sql: string, params: any[] }}
 */
function buildBboxGeoJsonQuery(table, attributes, simplifyDeg = 0.001) {
  const attrs = attributes.map((a) => `"${a}"`).join(', ')
  const geomExpr = simplifyDeg > 0
    ? `ST_SimplifyPreserveTopology(geom, ${simplifyDeg})`
    : 'geom'
  const sql = `
    SELECT jsonb_build_object(
      'type', 'FeatureCollection',
      'features', jsonb_agg(
        jsonb_build_object(
          'type', 'Feature',
          'id', fid,
          'geometry', ST_AsGeoJSON(ST_SetSRID(${geomExpr}, 4326))::jsonb,
          'properties', jsonb_build_object(${
            attributes.map(a => `'${a}', "${a}"`).join(', ')
          })
        )
      )
    ) AS fc
    FROM "${table}"
    WHERE geom IS NOT NULL
  `
  return { sql, params: [] }
}

module.exports = { isValidTileCoord, buildTileQuery, buildBboxGeoJsonQuery, snapTolerance }
