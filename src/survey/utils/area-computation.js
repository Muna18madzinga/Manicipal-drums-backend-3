import { shoelaceAreaYX, polygonCentroidYX, bankersRound } from './zim-geo.js'
import { computeEdgesWithResiduals } from './edge-computation.js'

/**
 * Compute complete area/consistency data for a polygon
 * SINGLE SOURCE OF TRUTH: Used by /compute/area and /geopdf/vector
 * 
 * This function computes all area-related metrics including:
 * - Area (m² and ha) with banker's rounding
 * - Centroid coordinates
 * - Edge data (distance, bearing, direction)
 * - Residuals (closure error analysis)
 * - Closure ratio (perimeter / closure error)
 * 
 * @param {Array} points - Array of {y, x} points (Cape Lo coordinates)
 * @param {Object} options - Configuration options
 * @param {number} options.hectaresThreshold - Threshold for displaying in hectares (default: 10000 m²)
 * @param {number} options.roundMetersDecimals - Decimal places for m² (default: 0)
 * @param {number} options.roundHectaresDecimals - Decimal places for ha (default: 4)
 * @param {boolean} options.includeResiduals - Whether to compute residuals (default: true)
 * @returns {Object} Complete area/consistency data
 */
export function computeAreaConsistency(points, options = {}) {
  const {
    hectaresThreshold = 10000,
    roundMetersDecimals = 0,
    roundHectaresDecimals = 4,
    includeResiduals = true
  } = options
  
  if (!Array.isArray(points) || points.length < 3) {
    throw new Error('At least 3 points required for area computation')
  }
  
  // Ensure closed ring for metrics
  const closed = points[0].y === points[points.length - 1].y && 
                 points[0].x === points[points.length - 1].x
    ? points
    : [...points, points[0]]
  
  // Compute area using shoelace formula
  const signedArea = shoelaceAreaYX(points)
  const absArea = Math.abs(signedArea)
  const centroid = polygonCentroidYX(points)
  
  // Round area values
  const useHectares = absArea >= hectaresThreshold
  const areaMetersRounded = bankersRound(absArea, roundMetersDecimals)
  const areaHectaresRounded = bankersRound(absArea / 10000, roundHectaresDecimals)
  
  // Compute edges with residuals
  const edgeResult = computeEdgesWithResiduals(points, { includeResiduals })
  const edges = edgeResult.edges
  
  // Calculate closure metrics
  let closureError = 0
  let perimeter = 0
  let closureRatio = Infinity
  let closureRatioFormatted = '1:∞'
  
  if (includeResiduals && edgeResult.residuals) {
    const residuals = edgeResult.residuals
    closureError = Math.sqrt(residuals.sumDy ** 2 + residuals.sumDx ** 2)
    perimeter = edges.reduce((sum, edge) => sum + edge.distance, 0)
    
    if (closureError > 0) {
      closureRatio = perimeter / closureError
      closureRatioFormatted = `1:${Math.round(closureRatio).toLocaleString()}`
    }
  } else {
    // If residuals not included, still calculate perimeter
    perimeter = edges.reduce((sum, edge) => sum + edge.distance, 0)
  }
  
  return {
    area: {
      signed_m2: signedArea,
      abs_m2: absArea,
      meters_rounded: areaMetersRounded,
      hectares_rounded: areaHectaresRounded,
      display: useHectares 
        ? { hectares: areaHectaresRounded, unit: 'ha' }
        : { square_meters: areaMetersRounded, unit: 'm²' }
    },
    centroid: {
      y: centroid.y,
      x: centroid.x
    },
    edges,
    residuals: includeResiduals && edgeResult.residuals ? {
      sumDy: edgeResult.residuals.sumDy,
      sumDx: edgeResult.residuals.sumDx,
      closureError,
      closureErrorFormatted: `${bankersRound(closureError, 3)}m`
    } : undefined,
    closure: {
      perimeter,
      error: closureError,
      ratio: closureRatio,
      ratioFormatted: closureRatioFormatted
    }
  }
}

export default {
  computeAreaConsistency
}
