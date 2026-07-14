const { shoelaceAreaYX, polygonCentroidYX, bankersRound } = require('./zim-geo')
const { computeEdgesWithResiduals } = require('./edge-computation')

/**
 * Compute area, centroid, edges, and closure-error metrics for a cadastral
 * polygon given as an ordered array of P(Y,X) points.
 *
 * Ported from survey-suite-nov-alpha's app-backend/src/utils/area-computation.js.
 *
 * @param {Array<{y:number,x:number}>} points
 * @param {{ hectaresThreshold?: number, roundMetersDecimals?: number, roundHectaresDecimals?: number, includeResiduals?: boolean }} options
 */
function computeAreaConsistency(points, options = {}) {
  const {
    hectaresThreshold = 10000,
    roundMetersDecimals = 0,
    roundHectaresDecimals = 4,
    includeResiduals = true,
  } = options

  if (!Array.isArray(points) || points.length < 3) {
    throw new Error('At least 3 points required for area computation')
  }

  const signedArea = shoelaceAreaYX(points)
  const absArea = Math.abs(signedArea)
  const centroid = polygonCentroidYX(points)

  const useHectares = absArea >= hectaresThreshold
  const areaMetersRounded = bankersRound(absArea, roundMetersDecimals)
  const areaHectaresRounded = bankersRound(absArea / 10000, roundHectaresDecimals)

  const edgeResult = computeEdgesWithResiduals(points, { includeResiduals })
  const edges = edgeResult.edges

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
        : { square_meters: areaMetersRounded, unit: 'm²' },
    },
    centroid: { y: centroid.y, x: centroid.x },
    edges,
    residuals: includeResiduals && edgeResult.residuals ? {
      sumDy: edgeResult.residuals.sumDy,
      sumDx: edgeResult.residuals.sumDx,
      closureError,
      closureErrorFormatted: `${bankersRound(closureError, 3)}m`,
    } : undefined,
    closure: {
      perimeter,
      error: closureError,
      ratio: closureRatio,
      ratioFormatted: closureRatioFormatted,
    },
  }
}

module.exports = { computeAreaConsistency }
