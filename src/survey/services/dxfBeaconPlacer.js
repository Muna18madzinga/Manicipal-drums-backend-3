/**
 * DXF beacon placer — pure functions for beacon label placement.
 * Matches the PDF generator's renderBeacons logic at pdfkitGeoPDF.js:4564
 * + helpers placeSuffixLabelPOIDirected (:5504), tryTightFullBeaconLabelPosition
 * (:400), and the splay-detection block (:4693-4711).
 *
 * Two DXF adaptations documented in the function headers:
 *   1. charWidthRatio = 0.55 used for label-width estimation (DXF can't query
 *      a rendered font width like the PDF's doc.widthOfString).
 *   2. Returned positions are the DXF baseline-left insertion point — the caller
 *      passes them directly to addText (no PDF-style width/2, height/2 subtraction).
 *
 * No DXF dependencies, no module state, no I/O. Pure math.
 */

import {
  isPointInPolygon,
  rectanglesOverlap,
  rectangleOverlapsPolygon,
  pointToLineDistance,
} from './dxfGeometry.js'

const PT_PER_MM = 1 / 0.352778   // ≈ 2.835

/**
 * PDF tier switch for beacon font size in points.
 * Matches pdfkitGeoPDF.js:4800-4807.
 */
export function pickBeaconFontSize(scaleValue) {
  if (scaleValue <= 500)  return 6
  if (scaleValue <= 1000) return 6.5
  if (scaleValue <= 2000) return 7
  return 7.5
}

/**
 * Beacon open-circle radius as a FIXED legible PAPER size (mm). The circle must
 * read clearly at the print scale regardless of the ground scale — matching the
 * SI 727 General Plan convention (see the ideal plan: ~2 mm radius open circles).
 * The previous 1.8-3.0 pt clamp (~0.63-1.06 mm) rendered the circles too small
 * to read. A slight log growth at coarser scales keeps them visible when the
 * figure is small.
 *
 *   baseRadiusMM × (1 + 0.15·log10(max(500, scaleValue) / 500)), clamped 1.5-2.4 mm
 */
export function computeBeaconRadius(scaleValue) {
  const baseRadiusMM = 1.8
  const scaleFactor  = 1 + 0.15 * Math.log10(Math.max(500, scaleValue) / 500)
  const rMM = baseRadiusMM * scaleFactor
  return Math.max(1.5, Math.min(2.4, rMM))   // paper-mm
}

/**
 * Lightweight bbox collision tracker. No spatial index — linear scan suffices
 * for ~600 typical beacon labels per plan.
 *
 * API:
 *   add(rect)                    — record a placed bbox
 *   hasCollision(rect, padding)  — does any registered rect overlap (with padding gap)?
 *   size                         — getter, current count
 *   all                          — getter, shallow copy of stored rects (for tests)
 */
export function createCollisionRegistry() {
  const rects = []
  return {
    add(rect) { rects.push(rect) },
    hasCollision(rect, padding = 1) {
      for (const r of rects) {
        if (rectanglesOverlap(rect, r, padding)) return true
      }
      return false
    },
    get size() { return rects.length },
    get all() { return rects.slice() },
  }
}

/**
 * Splay-group detection — pure proximity scan.
 * Matches pdfkitGeoPDF.js:4693-4711 with the threshold floor supplied by the
 * caller (so the function is unit-agnostic; the DXF integration layer
 * converts the PDF's 18 pt floor to ground-metres via mm(18 * PT_TO_MM_GEN)).
 *
 * Threshold = max(proximityFloor, beaconRadius × 6).
 *
 * Returns a Map<beaconName, Array<{name, distance, pos}>>. The Map contains
 * an entry ONLY for beacons that have at least one close neighbor. Solo
 * beacons (no close neighbors) are absent from the map.
 *
 * Each entry holds the DIRECT close neighbors of that beacon (per-beacon
 * neighbor view, NOT the full connected component). The integration layer
 * stitches components via BFS over this map.
 */
export function groupSplayBeacons(beaconPositions, beaconRadius, proximityFloor) {
  const threshold = Math.max(proximityFloor, beaconRadius * 6)
  const map = new Map()
  for (const [name1, p1] of beaconPositions) {
    const close = []
    for (const [name2, p2] of beaconPositions) {
      if (name1 === name2) continue
      const dx = p2.x - p1.x
      const dy = p2.y - p1.y
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < threshold) close.push({ name: name2, distance: d, pos: p2 })
    }
    if (close.length > 0) map.set(name1, close)
  }
  return map
}

/**
 * Order a splay group's members clockwise from angle 0 around the group's
 * centroid. Integration uses this to place labels in a deterministic angular
 * sequence so each placer call sees only the already-placed members in the
 * collision registry.
 */
export function orderSplayGroupByAngle(members) {
  if (members.length <= 1) return members.slice()
  const cx = members.reduce((s, m) => s + m.pos.x, 0) / members.length
  const cy = members.reduce((s, m) => s + m.pos.y, 0) / members.length
  const withAngle = members.map(m => ({
    ...m,
    _angle: Math.atan2(m.pos.y - cy, m.pos.x - cx),
  }))
  withAngle.sort((a, b) => a._angle - b._angle)
  return withAngle.map(({ _angle, ...rest }) => rest)
}

/**
 * INTERNAL helper: shoelace centroid (also used by the integration layer's
 * fallback paths). Same algorithm as in 4d's dxfLabelPlacer.
 */
function shoelaceCentroid(polygon) {
  let twiceArea = 0, cx = 0, cy = 0
  for (let i = 0; i < polygon.length; i++) {
    const p0 = polygon[i]
    const p1 = polygon[(i + 1) % polygon.length]
    const cross = p0.x * p1.y - p1.x * p0.y
    twiceArea += cross
    cx += (p0.x + p1.x) * cross
    cy += (p0.y + p1.y) * cross
  }
  const sixArea = 3 * twiceArea
  if (Math.abs(sixArea) < 1e-12) {
    let sx = 0, sy = 0
    for (const p of polygon) { sx += p.x; sy += p.y }
    return { x: sx / polygon.length, y: sy / polygon.length }
  }
  return { x: cx / sixArea, y: cy / sixArea }
}

/**
 * POI-directed inside placement.
 *
 * Port of pdfkitGeoPDF.js:5504-5597 with two DXF adaptations:
 *   1. Uses caller-supplied labelWidth (DXF can't call doc.widthOfString;
 *      the integration layer estimates via `labelText.length * fontHeight *
 *      0.55`, matching the charWidthRatio constant used by 4d).
 *   2. Returns the label's top-left insertion point — caller passes
 *      directly to addText without any subtraction.
 *
 * Algorithm (paraphrased from the PDF):
 *   1. Find the ring vertex closest to beaconPos.
 *   2. Compute the interior bisector at that corner; orient toward centroid.
 *   3. Try increasing offset distances along the bisector with angle
 *      perturbations. Each candidate must (a) have its center inside the
 *      polygon, and (b) not collide with any rect in the registry.
 *   4. Fallback to centroid when all candidates fail.
 */
export function placeSuffixLabelPOIDirected({
  beaconPos, polygon, labelWidth, labelHeight, beaconRadius, registry,
}) {
  // Deduplicate closing vertex if present
  const n = polygon.length
  const last = polygon[n - 1]
  const first = polygon[0]
  const isClosed = last && first &&
    Math.abs(last.x - first.x) < 0.001 && Math.abs(last.y - first.y) < 0.001
  const ring = isClosed ? polygon.slice(0, -1) : polygon
  const rn = ring.length

  // Centroid fallback for degenerate cases
  if (rn < 3) {
    const c = shoelaceCentroid(ring)
    return { x: c.x - labelWidth / 2, y: c.y - labelHeight / 2 }
  }

  // Find closest ring vertex to beacon
  let beaconIdx = -1
  let minDist = Infinity
  for (let i = 0; i < rn; i++) {
    const dx = ring[i].x - beaconPos.x
    const dy = ring[i].y - beaconPos.y
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d < minDist) { minDist = d; beaconIdx = i }
  }

  // Interior bisector at that corner
  let intX = 0, intY = 1   // fallback direction
  const B = ring[beaconIdx]
  const P = ring[(beaconIdx - 1 + rn) % rn]
  const N = ring[(beaconIdx + 1) % rn]
  const v1x = P.x - B.x, v1y = P.y - B.y
  const v2x = N.x - B.x, v2y = N.y - B.y
  const len1 = Math.sqrt(v1x * v1x + v1y * v1y)
  const len2 = Math.sqrt(v2x * v2x + v2y * v2y)
  if (len1 > 0.001 && len2 > 0.001) {
    const u1x = v1x / len1, u1y = v1y / len1
    const u2x = v2x / len2, u2y = v2y / len2
    let bx = u1x + u2x, by = u1y + u2y
    const bLen = Math.sqrt(bx * bx + by * by)
    if (bLen < 0.001) {
      // 180° straight corner — use perpendicular to one edge
      bx = -u1y
      by =  u1x
    } else {
      bx /= bLen
      by /= bLen
    }
    // Orient toward interior: dot with (centroid - B) should be positive
    const centroid = shoelaceCentroid(ring)
    const dot = bx * (centroid.x - B.x) + by * (centroid.y - B.y)
    intX = dot >= 0 ? bx : -bx
    intY = dot >= 0 ? by : -by
  }

  // Minimum clearance: beacon circle + half label height + 1 unit gap
  const dMin = beaconRadius + labelHeight / 2 + 1

  // Candidate validator
  const polygonPts = ring   // already in {x, y} shape
  const tryPos = (cx, cy) => {
    if (!isPointInPolygon({ x: cx, y: cy }, polygonPts)) return false
    if (registry.hasCollision(
      { x: cx - labelWidth / 2, y: cy - labelHeight / 2, width: labelWidth, height: labelHeight },
      1,
    )) return false
    return true
  }

  const distances    = [dMin, dMin * 1.3, dMin * 1.7, dMin * 2.2, dMin * 3.0, dMin * 4.0]
  const perturbsDeg  = [0, 10, -10, 20, -20, 30, -30, 45, -45]

  for (const dist of distances) {
    for (const pd of perturbsDeg) {
      const rad = pd * Math.PI / 180
      const cosP = Math.cos(rad), sinP = Math.sin(rad)
      const dx = intX * cosP - intY * sinP
      const dy = intX * sinP + intY * cosP
      const cx = beaconPos.x + dx * dist
      const cy = beaconPos.y + dy * dist
      if (tryPos(cx, cy)) {
        return { x: cx - labelWidth / 2, y: cy - labelHeight / 2 }
      }
    }
  }

  // Fallback: centroid (caller's leader-distance check decides whether to draw a leader)
  const centroid = shoelaceCentroid(ring)
  return { x: centroid.x - labelWidth / 2, y: centroid.y - labelHeight / 2 }
}

/**
 * INTERNAL helper: returns true iff the rect lies entirely outside every
 * polygon in the list. Wraps 4a's rectangleOverlapsPolygon (inverted).
 */
function isRectOutsidePolygons(rect, polygons) {
  for (const poly of polygons) {
    if (rectangleOverlapsPolygon(rect, poly, 0)) return false
  }
  return true
}

/**
 * Tight outside placement — two candidates only: right then left.
 *
 * Port of pdfkitGeoPDF.js:400-446. Returns the chosen label's top-left
 * insertion point + which side it was placed on, or null when both sides
 * fail validation.
 *
 * A candidate passes when (a) the bbox lies outside every incidentPolygon
 * (via 4a's rectangleOverlapsPolygon, inverted), and (b) the registry
 * reports no collision.
 */
export function tryTightFullBeaconLabelPosition({
  beaconPos, labelWidth, labelHeight, beaconRadius, padding,
  incidentPolygons, registry,
}) {
  const baseY = beaconPos.y - labelHeight / 2
  const candidates = [
    {
      name: 'right',
      x: beaconPos.x + beaconRadius + padding,
      y: baseY,
    },
    {
      name: 'left',
      x: beaconPos.x - beaconRadius - padding - labelWidth,
      y: baseY,
    },
  ]

  for (const c of candidates) {
    const rect = { x: c.x, y: c.y, width: labelWidth, height: labelHeight }
    if (
      Array.isArray(incidentPolygons) && incidentPolygons.length > 0 &&
      !isRectOutsidePolygons(rect, incidentPolygons)
    ) continue
    if (registry.hasCollision(rect, 1)) continue
    return { x: c.x, y: c.y, position: c.name }
  }

  return null
}

/**
 * Edge-anchored outside placement (fallback after tryTightFullBeaconLabelPosition).
 *
 * Adapted port — PDF's calculateFullBeaconLabelOutsideOnEdge has additional
 * scale-aware logic; this DXF version finds the nearest polygon edge across all
 * incidentPolygons, computes its outward normal, and places the label bbox so
 * its CENTER sits at `foot + outwardNormal · (beaconRadius + labelHeight/2 + 1)`.
 *
 * If the chosen position fails validation (overlaps an incident polygon or
 * collides with the registry), walk along the edge in both directions in
 * labelWidth/4 steps up to 2·labelWidth, retrying. Returns null when nothing fits.
 *
 * Returns the label's top-left insertion point or null.
 */
export function calculateFullBeaconLabelOutsideOnEdge({
  beaconPos, incidentPolygons, labelWidth, labelHeight, beaconRadius, registry,
}) {
  if (!Array.isArray(incidentPolygons) || incidentPolygons.length === 0) {
    return null
  }

  // 1. Find the nearest polygon edge across all incidentPolygons.
  let nearestEdge = null
  let nearestPoly = null
  let nearestDist = Infinity
  for (const poly of incidentPolygons) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      const d = pointToLineDistance(beaconPos, a, b)
      if (d < nearestDist) {
        nearestDist = d
        nearestEdge = { a, b }
        nearestPoly = poly
      }
    }
  }
  if (!nearestEdge) return null

  const { a, b } = nearestEdge
  // 2. Project beacon onto the edge to get the foot point.
  const dx = b.x - a.x
  const dy = b.y - a.y
  const edgeLen = Math.sqrt(dx * dx + dy * dy)
  if (edgeLen < 1e-6) return null
  const ux = dx / edgeLen
  const uy = dy / edgeLen
  const t = ((beaconPos.x - a.x) * ux + (beaconPos.y - a.y) * uy)
  // Clamp t into the segment [0, edgeLen]
  const tClamped = Math.max(0, Math.min(edgeLen, t))
  const footX = a.x + ux * tClamped
  const footY = a.y + uy * tClamped

  // 3. Outward normal of the edge — pick the direction that lies outside the polygon.
  // Edge tangent (u). Two candidate normals: (-uy, ux) and (uy, -ux).
  let nx = -uy, ny = ux
  // Test midpoint + tiny step in (nx, ny). If inside the polygon, flip.
  const midX = (a.x + b.x) / 2
  const midY = (a.y + b.y) / 2
  const step = Math.max(1e-3, edgeLen * 0.001)
  const probe = { x: midX + nx * step, y: midY + ny * step }
  if (isPointInPolygon(probe, nearestPoly)) {
    nx = -nx; ny = -ny
  }

  // 4. Primary placement: center = foot + outwardNormal × offset
  const offset = beaconRadius + labelHeight / 2 + 1
  const placeAt = (cx, cy) => ({
    x: cx - labelWidth / 2,
    y: cy - labelHeight / 2,
  })
  const validate = (rect) => {
    if (!isRectOutsidePolygons(rect, incidentPolygons)) return false
    if (registry.hasCollision(rect, 1)) return false
    return true
  }

  const tryCenter = (cx, cy) => {
    const tl = placeAt(cx, cy)
    const rect = { x: tl.x, y: tl.y, width: labelWidth, height: labelHeight }
    return validate(rect) ? tl : null
  }

  const primary = tryCenter(footX + nx * offset, footY + ny * offset)
  if (primary) return primary

  // 5. Walk along the edge in both directions; labelWidth/4 step up to 2·labelWidth.
  const walkStep = labelWidth / 4
  const maxWalk = labelWidth * 2
  for (let s = walkStep; s <= maxWalk; s += walkStep) {
    for (const sign of [+1, -1]) {
      const wx = footX + ux * sign * s + nx * offset
      const wy = footY + uy * sign * s + ny * offset
      const tl = tryCenter(wx, wy)
      if (tl) return tl
    }
  }

  return null
}
