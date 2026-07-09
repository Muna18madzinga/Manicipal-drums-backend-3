const { bearingSouthBetween, roundBearingSouth, bankersRound, degToDMS, polarForward } = require('./zim-geo')

/**
 * Compute polygon edges with closure residuals.
 * Distance rounded to 0.01m and bearing rounded to 10" (<6km) / 1" (>=6km),
 * both via banker's rounding — the Zimbabwe cadastral convention.
 *
 * Ported from surveypro-nov-alpha's app-backend/src/utils/edge-computation.js.
 *
 * @param {Array<{y:number,x:number,id?:string,name?:string}>} points
 * @param {{ includeResiduals?: boolean }} options
 */
function computeEdgesWithResiduals(points, options = {}) {
  const { includeResiduals = true } = options

  if (!Array.isArray(points) || points.length < 3) {
    throw new Error('At least 3 points required')
  }

  const N = points.length
  const edges = []
  let residualSumDy = 0
  let residualSumDx = 0

  const obs = []
  for (let i = 0; i < N; i++) {
    const a = points[i]
    const b = points[(i + 1) % N]
    const dy = b.y - a.y
    const dx = b.x - a.x
    const distance = Math.hypot(dy, dx)
    const brg = bearingSouthBetween({ y1: a.y, x1: a.x }, { y2: b.y, x2: b.x })
    const distRounded = bankersRound(distance, 2)
    const secRes = distance < 6000 ? 10 : 1
    const bearingRoundedDeg = roundBearingSouth(brg, secRes)

    const dms = degToDMS(bearingRoundedDeg)
    let D = dms.D
    let M = dms.M
    let S = Math.round(dms.S)
    if (S >= 60) { S -= 60; M += 1 }
    if (M >= 60) { M -= 60; D += 1 }
    const directionDMS = `${D}°${String(M).padStart(2, '0')}'${String(S).padStart(2, '0')}"`

    obs.push({
      index: i + 1,
      from: { y: a.y, x: a.x, id: a.id, name: a.name },
      to: { y: b.y, x: b.x, id: b.id, name: b.name },
      distance,
      distRounded,
      bearingDeg: brg,
      bearingRoundedDeg,
      directionDMS,
      secondsResolution: secRes,
    })
  }

  if (includeResiduals) {
    const traversePts = [{ y: points[0].y, x: points[0].x }]
    for (let i = 0; i < obs.length; i++) {
      const last = traversePts[traversePts.length - 1]
      const step = obs[i]
      traversePts.push(polarForward({
        y0: last.y, x0: last.x, distance: step.distRounded, bearingDeg: step.bearingRoundedDeg,
      }))
    }

    for (let i = 0; i < obs.length; i++) {
      const targetIdx = (i + 1) % points.length
      const entered = points[targetIdx]
      const computed = traversePts[i + 1]
      const dY = computed.y - entered.y
      const dX = computed.x - entered.x
      residualSumDy += dY
      residualSumDx += dX
      const base = obs[i]
      edges.push({
        index: base.index, from: base.from, to: base.to,
        dy: dY, dx: dX,
        distance: base.distance, distanceRounded: base.distRounded,
        bearingDeg: base.bearingDeg, bearingRoundedDeg: base.bearingRoundedDeg,
        directionDMS: base.directionDMS, secondsResolution: base.secondsResolution,
      })
    }
  } else {
    for (let i = 0; i < obs.length; i++) {
      const base = obs[i]
      edges.push({
        index: base.index, from: base.from, to: base.to,
        distance: base.distance, distanceRounded: base.distRounded,
        bearingDeg: base.bearingDeg, bearingRoundedDeg: base.bearingRoundedDeg,
        directionDMS: base.directionDMS, secondsResolution: base.secondsResolution,
      })
    }
  }

  return {
    edges,
    residuals: includeResiduals ? { sumDy: residualSumDy, sumDx: residualSumDx } : undefined,
  }
}

module.exports = { computeEdgesWithResiduals }
