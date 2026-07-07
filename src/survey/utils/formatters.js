/**
 * Formatters & Utilities
 * Provides formatting functions for survey plan data
 */

/**
 * Banker's Rounding (Round Half to Even)
 * IEEE 754 standard rounding method
 * 
 * When the value is exactly halfway between two numbers,
 * round to the nearest even number to minimize bias.
 * 
 * Examples:
 *   bankersRound(2.5, 0) => 2 (even)
 *   bankersRound(3.5, 0) => 4 (even)
 *   bankersRound(2.25, 1) => 2.2 (even)
 *   bankersRound(2.35, 1) => 2.4 (even)
 * 
 * @param {number} value - The number to round
 * @param {number} decimals - Number of decimal places (default: 0)
 * @returns {number} Rounded value
 */
export function bankersRound(value, decimals = 0) {
  if (typeof value !== 'number' || isNaN(value)) {
    throw new Error('Value must be a valid number')
  }
  
  if (typeof decimals !== 'number' || decimals < 0 || !Number.isInteger(decimals)) {
    throw new Error('Decimals must be a non-negative integer')
  }
  
  const multiplier = Math.pow(10, decimals)
  const scaled = value * multiplier
  const floor = Math.floor(scaled)
  const fraction = scaled - floor
  
  // Check if exactly half (within floating point precision)
  const epsilon = 1e-10
  if (Math.abs(fraction - 0.5) < epsilon) {
    // Exactly half - round to nearest even
    const rounded = floor % 2 === 0 ? floor : floor + 1
    return rounded / multiplier
  } else {
    // Not exactly half - use standard rounding
    return Math.round(scaled) / multiplier
  }
}

/**
 * Format area with adaptive units and banker's rounding
 * 
 * Rules:
 * - Area < 10,000 m²: Display in m² (whole number, banker's rounding)
 * - Area ≥ 10,000 m²: Display in ha (4 decimals, banker's rounding)
 * 
 * Examples:
 *   formatArea(566.03) => "566 m²"
 *   formatArea(9999.5) => "10000 m²"
 *   formatArea(10000) => "1.0000 ha"
 *   formatArea(25678.1234) => "2.5678 ha"
 * 
 * @param {number} area_m2 - Area in square meters
 * @returns {string} Formatted area string
 */
export function formatArea(area_m2) {
  if (typeof area_m2 !== 'number' || isNaN(area_m2)) {
    throw new Error('Area must be a valid number')
  }
  
  if (area_m2 < 0) {
    throw new Error('Area cannot be negative')
  }
  
  if (area_m2 < 10000) {
    // Display in m² (whole number with banker's rounding)
    const rounded = bankersRound(area_m2, 0)
    return `${rounded.toLocaleString('en-US')} m²`
  } else {
    // Display in ha (4 decimals with banker's rounding)
    const area_ha = area_m2 / 10000
    const rounded = bankersRound(area_ha, 4)
    return `${rounded.toFixed(4)} ha`
  }
}

/**
 * Format area for CSV export (no units, just numbers)
 * 
 * @param {number} area_m2 - Area in square meters
 * @returns {string} Formatted area value
 */
export function formatAreaValue(area_m2) {
  if (typeof area_m2 !== 'number' || isNaN(area_m2)) {
    throw new Error('Area must be a valid number')
  }
  
  if (area_m2 < 0) {
    throw new Error('Area cannot be negative')
  }
  
  if (area_m2 < 10000) {
    const rounded = bankersRound(area_m2, 0)
    return rounded.toString()
  } else {
    const area_ha = area_m2 / 10000
    const rounded = bankersRound(area_ha, 4)
    return rounded.toFixed(4)
  }
}

/**
 * Get area unit based on magnitude
 * 
 * @param {number} area_m2 - Area in square meters
 * @returns {string} Unit ('m²' or 'ha')
 */
export function getAreaUnit(area_m2) {
  if (typeof area_m2 !== 'number' || isNaN(area_m2)) {
    throw new Error('Area must be a valid number')
  }
  
  return area_m2 < 10000 ? 'm²' : 'ha'
}

/**
 * Format coordinate value with appropriate precision
 * 
 * @param {number} value - Coordinate value
 * @param {number} decimals - Decimal places (default: 3)
 * @returns {string} Formatted coordinate
 */
export function formatCoordinate(value, decimals = 3) {
  if (typeof value !== 'number' || isNaN(value)) {
    throw new Error('Value must be a valid number')
  }
  
  return value.toFixed(decimals)
}

/**
 * Format distance with appropriate unit
 * 
 * @param {number} meters - Distance in meters
 * @returns {string} Formatted distance
 */
export function formatDistance(meters) {
  if (typeof meters !== 'number' || isNaN(meters)) {
    throw new Error('Distance must be a valid number')
  }
  
  if (meters < 0) {
    throw new Error('Distance cannot be negative')
  }
  
  if (meters < 1000) {
    return `${meters.toFixed(2)} m`
  } else {
    const km = meters / 1000
    return `${km.toFixed(3)} km`
  }
}
