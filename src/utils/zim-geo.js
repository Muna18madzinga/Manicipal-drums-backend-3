/**
 * Zimbabwe cadastral coordinate geometry (COGO) helpers.
 *
 * Convention: P(Y, X) where Y increases westwards (westing), X increases
 * southwards (southing). Bearings are south-oriented: 0° = South, increasing
 * clockwise (S -> W -> N -> E).
 *
 * Ported from survey-suite-nov-alpha's app-backend/src/utils/zim-geo.js.
 */

const DEG = Math.PI / 180
const RAD = 180 / Math.PI

function bearingSouthDegToUnitYX(bearingDeg) {
  const b = (bearingDeg % 360 + 360) % 360
  const rad = b * DEG
  const xComp = Math.cos(rad) // along south
  const yComp = Math.sin(rad) // along west
  return { y: yComp, x: xComp }
}

function normalizeBearingSouth(bearingDeg) {
  return (bearingDeg % 360 + 360) % 360
}

// Polar: from P(Y,X) + distance & bearing (south-oriented) -> Q(Y,X)
function polarForward({ y0, x0, distance, bearingDeg }) {
  const { y: uy, x: ux } = bearingSouthDegToUnitYX(bearingDeg)
  return { y: y0 + uy * distance, x: x0 + ux * distance }
}

// Bearing from P(Y,X) to Q(Y,X), in south-oriented degrees [0,360)
function bearingSouthBetween({ y1, x1 }, { y2, x2 }) {
  const dy = y2 - y1 // westing delta
  const dx = x2 - x1 // southing delta
  const ang = Math.atan2(dy, dx) * RAD
  return normalizeBearingSouth(ang)
}

function distanceYX({ y1, x1 }, { y2, x2 }) {
  return Math.hypot(y2 - y1, x2 - x1)
}

// Intersection of two bearing lines (bearing-bearing), south-oriented angles
function intersectBearingBearing({ y1, x1, bearing1Deg }, { y2, x2, bearing2Deg }) {
  const u1 = bearingSouthDegToUnitYX(bearing1Deg)
  const u2 = bearingSouthDegToUnitYX(bearing2Deg)
  const a11 = u1.y, a12 = -u2.y
  const a21 = u1.x, a22 = -u2.x
  const by = y2 - y1
  const bx = x2 - x1
  const det = a11 * a22 - a12 * a21
  if (Math.abs(det) < 1e-12) {
    return { ok: false, reason: 'Lines nearly parallel', point: null }
  }
  const t = (by * a22 - a12 * bx) / det
  return { ok: true, point: { y: y1 + t * u1.y, x: x1 + t * u1.x }, t }
}

// Banker's rounding (round half to even) to given decimals
function bankersRound(value, decimals = 0) {
  const factor = Math.pow(10, decimals)
  const n = value * factor
  const f = Math.floor(n)
  const r = n - f
  if (Math.abs(r - 0.5) < 1e-12) {
    return (f % 2 === 0 ? f : f + 1) / factor
  }
  return Math.round(n) / factor
}

function degToDMS(deg) {
  const d = ((deg % 360) + 360) % 360
  const D = Math.floor(d)
  const mFloat = (d - D) * 60
  const M = Math.floor(mFloat)
  const S = (mFloat - M) * 60
  return { D, M, S }
}

function dmsToDeg({ D, M, S }) {
  const sign = D < 0 ? -1 : 1
  const absD = Math.abs(D)
  return sign * (absD + (M || 0) / 60 + (S || 0) / 3600)
}

// Round a south-oriented bearing to the nearest resolution seconds (1" or 10")
function roundBearingSouth(bearingDeg, resolutionSeconds = 1) {
  const dms = degToDMS(normalizeBearingSouth(bearingDeg))
  const totalSec = dms.D * 3600 + dms.M * 60 + dms.S
  const roundedSec = bankersRound(totalSec / resolutionSeconds, 0) * resolutionSeconds
  const D = Math.floor(roundedSec / 3600)
  const M = Math.floor((roundedSec - D * 3600) / 60)
  const S = roundedSec - D * 3600 - M * 60
  return normalizeBearingSouth(dmsToDeg({ D, M, S }))
}

// Shoelace area (signed) for polygon in P(Y,X). Points may be open or closed ring.
function shoelaceAreaYX(points) {
  if (!Array.isArray(points) || points.length < 3) return 0
  const pts = points[0].y === points[points.length - 1].y && points[0].x === points[points.length - 1].x
    ? points
    : [...points, points[0]]
  let sum = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    sum += (a.y * b.x - b.y * a.x)
  }
  return 0.5 * sum // signed
}

// Polygon centroid for non-self-intersecting polygon in P(Y,X)
function polygonCentroidYX(points) {
  const pts = points[0].y === points[points.length - 1].y && points[0].x === points[points.length - 1].x
    ? points
    : [...points, points[0]]
  let A2 = 0
  let Cy = 0, Cx = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    const cross = (a.y * b.x - b.y * a.x)
    A2 += cross
    Cy += (a.y + b.y) * cross
    Cx += (a.x + b.x) * cross
  }
  if (Math.abs(A2) < 1e-12) return { y: pts[0].y, x: pts[0].x }
  return { y: Cy / (3 * A2), x: Cx / (3 * A2) }
}

module.exports = {
  bearingSouthDegToUnitYX,
  normalizeBearingSouth,
  polarForward,
  bearingSouthBetween,
  distanceYX,
  intersectBearingBearing,
  bankersRound,
  degToDMS,
  dmsToDeg,
  roundBearingSouth,
  shoelaceAreaYX,
  polygonCentroidYX,
}
