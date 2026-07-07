// Zimbabwe Cadastral Coordinate helpers
// Convention: P(Y, X) where Y increases westwards (westing), X increases southwards (southing)
// Bearings are south-oriented: 0° = South, increasing clockwise (S->W->N->E)

const DEG = Math.PI / 180
const RAD = 180 / Math.PI

// Convert south-oriented bearing (degrees) to azimuth (radians) measured from East CCW or from North CW?
// We'll compute unit direction in (Y westing, X southing) grid directly.
// South-oriented 0° means positive X direction (increasing south). 90° means positive Y (increasing west).
export function bearingSouthDegToUnitYX(bearingDeg) {
  const b = (bearingDeg % 360 + 360) % 360
  const rad = b * DEG
  // In P(Y,X): x_out increases south, y_out increases west
  const xComp = Math.cos(rad) // along south
  const yComp = Math.sin(rad) // along west
  return { y: yComp, x: xComp }
}

export function normalizeBearingSouth(bearingDeg) {
  const b = (bearingDeg % 360 + 360) % 360
  return b
}

// Polar: from P(Y,X) + distance & bearing (south-oriented) -> Q(Y,X)
export function polarForward({ y0, x0, distance, bearingDeg }) {
  const { y: uy, x: ux } = bearingSouthDegToUnitYX(bearingDeg)
  const dy = uy * distance
  const dx = ux * distance
  return { y: y0 + dy, x: x0 + dx }
}

// Bearing from P(Y,X) to Q(Y,X), in south-oriented degrees [0,360)
export function bearingSouthBetween({ y1, x1 }, { y2, x2 }) {
  const dy = y2 - y1 // westing delta
  const dx = x2 - x1 // southing delta
  // south-oriented: 0=S (positive x), 90=W (positive y)
  const ang = Math.atan2(dy, dx) * RAD
  return normalizeBearingSouth(ang)
}

export function distanceYX({ y1, x1 }, { y2, x2 }) {
  const dy = y2 - y1
  const dx = x2 - x1
  return Math.hypot(dy, dx)
}

// Intersection of two bearing lines (bearing-bearing), south-oriented angles
// Line A: P1 + t * u1, u1 from bearing1; Line B: P2 + s * u2, u2 from bearing2
export function intersectBearingBearing({ y1, x1, bearing1Deg }, { y2, x2, bearing2Deg }) {
  const u1 = bearingSouthDegToUnitYX(bearing1Deg)
  const u2 = bearingSouthDegToUnitYX(bearing2Deg)
  // Solve P1 + t u1 = P2 + s u2 -> two equations in y,x
  // [u1.y, -u2.y][t s]^T = [y2 - y1]
  // [u1.x, -u2.x][t s]^T = [x2 - x1]
  const a11 = u1.y, a12 = -u2.y
  const a21 = u1.x, a22 = -u2.x
  const by = y2 - y1
  const bx = x2 - x1
  const det = a11 * a22 - a12 * a21
  if (Math.abs(det) < 1e-12) {
    return { ok: false, reason: 'Lines nearly parallel', point: null }
  }
  const t = (by * a22 - a12 * bx) / det
  const y = y1 + t * u1.y
  const x = x1 + t * u1.x
  return { ok: true, point: { y, x }, t }
}

// Helpers to convert between conventional EN (east,north) and ZIM YX (west,south)
export function enToZimYX({ e, n }) {
  // Easting increases east; Westing increases west. Set y = -e.
  // Northing increases north; Southing increases south. Set x = -n.
  return { y: -e, x: -n }
}

export function zimYXToEN({ y, x }) {
  return { e: -y, n: -x }
}

// Convert azimuth from North clockwise (0°=N) to south-oriented bearing (0°=S, CW)
export function azimuthNToBearingS(azDeg) {
  // 0N -> 180S; add 180 then normalize
  return normalizeBearingSouth(azDeg + 180)
}

export function bearingSToAzimuthN(bearingDeg) {
  // Inverse: subtract 180
  let az = (bearingDeg - 180) % 360
  if (az < 0) az += 360
  return az
}

// Banker's rounding (round half to even) to given decimals
export function bankersRound(value, decimals = 0) {
  const factor = Math.pow(10, decimals)
  const n = value * factor
  const f = Math.floor(n)
  const r = n - f
  if (Math.abs(r - 0.5) < 1e-12) {
    // exactly half: round to even
    return (f % 2 === 0 ? f : f + 1) / factor
  }
  return Math.round(n) / factor
}

// DMS helpers (degrees with minutes and seconds; use semicolons if desired by caller when formatting strings)
export function degToDMS(deg) {
  const d = ((deg % 360) + 360) % 360
  const D = Math.floor(d)
  const mFloat = (d - D) * 60
  const M = Math.floor(mFloat)
  const S = (mFloat - M) * 60
  return { D, M, S }
}

export function dmsToDeg({ D, M, S }) {
  const sign = D < 0 ? -1 : 1
  const absD = Math.abs(D)
  return sign * (absD + (M || 0) / 60 + (S || 0) / 3600)
}

export function formatDMS({ D, M, S }, opts = { sep: ':', secondsDecimals: 0 }) {
  const sDec = opts.secondsDecimals ?? 0
  const Srounded = bankersRound(S, sDec)
  // carry if 60.0 due to rounding
  let DD = D, MM = M, SS = Srounded
  if (SS >= 60) { SS -= 60; MM += 1 }
  if (MM >= 60) { MM -= 60; DD += 1 }
  const pad2 = (n) => String(n).padStart(2, '0')
  const secFmt = sDec > 0 ? SS.toFixed(sDec).padStart(2 + (sDec ? (sDec + 1) : 0), '0') : pad2(Math.round(SS))
  return `${DD}${opts.sep}${pad2(MM)}${opts.sep}${secFmt}`
}

// Round a south-oriented bearing to the nearest resolution seconds (1" or 10")
export function roundBearingSouth(bearingDeg, resolutionSeconds = 1) {
  const dms = degToDMS(normalizeBearingSouth(bearingDeg))
  const totalSec = dms.D * 3600 + dms.M * 60 + dms.S
  const roundedSec = bankersRound(totalSec / resolutionSeconds, 0) * resolutionSeconds
  const D = Math.floor(roundedSec / 3600)
  const M = Math.floor((roundedSec - D * 3600) / 60)
  const S = roundedSec - D * 3600 - M * 60
  return normalizeBearingSouth(dmsToDeg({ D, M, S }))
}

// Shoelace area (signed) for polygon in P(Y,X). Points may be open or closed ring.
export function shoelaceAreaYX(points) {
  if (!Array.isArray(points) || points.length < 3) return 0
  // ensure closed
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
export function polygonCentroidYX(points) {
  const pts = points[0].y === points[points.length - 1].y && points[0].x === points[points.length - 1].x
    ? points
    : [...points, points[0]]
  let A2 = 0 // 2 * area signed
  let Cy = 0, Cx = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1]
    const cross = (a.y * b.x - b.y * a.x)
    A2 += cross
    Cy += (a.y + b.y) * cross
    Cx += (a.x + b.x) * cross
  }
  const A = A2 / 2
  if (Math.abs(A) < 1e-12) return { y: pts[0].y, x: pts[0].x }
  return { y: Cy / (3 * A2), x: Cx / (3 * A2) }
}

// Edge metrics + ZIM rounding helpers
export function edgeMetricsYX(a, b) {
  const dy = b.y - a.y
  const dx = b.x - a.x
  const distance = Math.hypot(dy, dx)
  const bearingDeg = bearingSouthBetween(a, b)
  // Rounding rules: distance 0.01 m; bearing seconds: <6000 m -> 10", else 1"
  const distRounded = bankersRound(distance, 2)
  const secRes = distance < 6000 ? 10 : 1
  const bearingRoundedDeg = roundBearingSouth(bearingDeg, secRes)
  return { dy, dx, distance, bearingDeg, distRounded, bearingRoundedDeg, secondsResolution: secRes }
}

export default {
  bearingSouthDegToUnitYX,
  normalizeBearingSouth,
  polarForward,
  bearingSouthBetween,
  distanceYX,
  intersectBearingBearing,
  enToZimYX,
  zimYXToEN,
  azimuthNToBearingS,
  bearingSToAzimuthN,
  bankersRound,
  degToDMS,
  dmsToDeg,
  formatDMS,
  roundBearingSouth,
  shoelaceAreaYX,
  polygonCentroidYX,
  edgeMetricsYX
}
