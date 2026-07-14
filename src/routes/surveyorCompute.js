/**
 * Surveyor COGO compute routes — stateless coordinate geometry calculators.
 *
 * Ported from survey-suite-nov-alpha's app-backend/src/routes/compute.js.
 * Deliberately stateless (no DB writes): this is Phase 0 of the survey-suite
 * integration — the walking skeleton that proves the math ports cleanly
 * before Phase 2+ ties parcels/points to survey_task records.
 *
 *   POST /surveyor/compute/polar                       — P(Y,X)+dist+bearing -> Q(Y,X)
 *   POST /surveyor/compute/intersections/bearing-bearing — two rays -> intersection point
 *   POST /surveyor/compute/area                          — polygon area/closure/edges
 */

const { requireRole } = require('../middleware/jwtAuth')
const { polarForward, intersectBearingBearing } = require('../utils/zim-geo')
const { computeAreaConsistency } = require('../utils/area-computation')

const SURVEYOR = ['surveyor', 'admin']

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

async function surveyorComputeRoutes(fastify) {
  fastify.post('/surveyor/compute/polar', { preHandler: requireRole(fastify, SURVEYOR) }, async (request, reply) => {
    const b = request.body || {}
    if (![b.y, b.x, b.distance, b.bearingDeg].every(isFiniteNum)) {
      return reply.code(400).send({ success: false, error: 'y, x, distance, bearingDeg must all be numbers' })
    }
    const point = polarForward({ y0: b.y, x0: b.x, distance: b.distance, bearingDeg: b.bearingDeg })
    return reply.send({ success: true, data: { point } })
  })

  fastify.post('/surveyor/compute/intersections/bearing-bearing', { preHandler: requireRole(fastify, SURVEYOR) }, async (request, reply) => {
    const b = request.body || {}
    const p1 = b.p1 || {}
    const p2 = b.p2 || {}
    if (![p1.y, p1.x, p1.bearingDeg, p2.y, p2.x, p2.bearingDeg].every(isFiniteNum)) {
      return reply.code(400).send({ success: false, error: 'p1 and p2 each need numeric y, x, bearingDeg' })
    }
    const result = intersectBearingBearing(
      { y1: p1.y, x1: p1.x, bearing1Deg: p1.bearingDeg },
      { y2: p2.y, x2: p2.x, bearing2Deg: p2.bearingDeg },
    )
    if (!result.ok) return reply.code(400).send({ success: false, error: result.reason })
    return reply.send({ success: true, data: { point: result.point } })
  })

  fastify.post('/surveyor/compute/area', { preHandler: requireRole(fastify, SURVEYOR) }, async (request, reply) => {
    const b = request.body || {}
    const points = b.points
    if (!Array.isArray(points) || points.length < 3
        || !points.every((p) => p && isFiniteNum(p.y) && isFiniteNum(p.x))) {
      return reply.code(400).send({ success: false, error: 'points must be an array of at least 3 {y,x} numbers' })
    }
    try {
      const result = computeAreaConsistency(points, {
        hectaresThreshold: isFiniteNum(b.hectaresThreshold) ? b.hectaresThreshold : undefined,
        includeResiduals: b.includeResiduals !== false,
      })
      return reply.send({ success: true, data: result })
    } catch (err) {
      request.log.error({ err }, 'compute area failed')
      return reply.code(400).send({ success: false, error: err.message })
    }
  })
}

module.exports = { surveyorComputeRoutes }
