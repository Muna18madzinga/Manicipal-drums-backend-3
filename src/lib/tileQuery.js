// src/lib/tileQuery.js
// Pure helpers for building PostGIS vector-tile (MVT) queries.

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

module.exports = { isValidTileCoord }
