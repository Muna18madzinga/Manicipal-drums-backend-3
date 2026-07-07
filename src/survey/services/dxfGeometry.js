/**
 * DXF Geometric Primitives — pure functions used by sub-projects 4b
 * (whitespace scanner), 4c (block placer), 4d (per-feature label
 * placement), and 3-v2 (Schedule of Areas topological placement).
 *
 * Algorithms are byte-for-byte ports from `app-backend/src/services/
 * pdfkitGeoPDF.js` (line numbers cited per function). Interfaces are
 * normalised to a uniform `{x, y}` object shape — the PDF's mixed
 * `[y, x]` tuples / `{x, y}` objects / `{x1, y1, x2, y2}` flat-segment
 * conventions are unpacked at function entry.
 *
 * All inputs are unit-agnostic; caller's responsibility to keep units
 * consistent within one call (don't mix metres and millimetres).
 *
 * No DXF dependencies, no module state, no I/O. Pure math.
 */

/**
 * Euclidean distance between two points.
 * Port of `pdfkitGeoPDF.js:86` `pointDistance`.
 *
 * @param {{x:number,y:number}} p1
 * @param {{x:number,y:number}} p2
 * @returns {number} non-negative distance
 */
export function pointDistance(p1, p2) {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * Perpendicular distance from a point to an infinite line through
 * lineStart/lineEnd. Clamps the projection parameter to [0, 1], so for
 * the line-segment variant this is functionally identical to
 * `distanceToSegment` (the PDF original was inconsistent in naming;
 * the math is the same).
 * Port of `pdfkitGeoPDF.js:95` `pointToLineDistance`.
 *
 * @param {{x:number,y:number}} point
 * @param {{x:number,y:number}} lineStart
 * @param {{x:number,y:number}} lineEnd
 * @returns {number} non-negative distance
 */
export function pointToLineDistance(point, lineStart, lineEnd) {
  const { x: px, y: py } = point
  const { x: x1, y: y1 } = lineStart
  const { x: x2, y: y2 } = lineEnd

  const dx = x2 - x1
  const dy = y2 - y1
  const lineLengthSquared = dx * dx + dy * dy

  if (lineLengthSquared === 0) {
    // Degenerate "line" is a point
    return pointDistance(point, lineStart)
  }

  // Projection parameter t, clamped to [0, 1]
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lineLengthSquared))

  // Closest point on the line at parameter t
  const closestX = x1 + t * dx
  const closestY = y1 + t * dy

  const distX = px - closestX
  const distY = py - closestY
  return Math.sqrt(distX * distX + distY * distY)
}

/**
 * Distance from a point to a finite line segment. Clamps to the nearest
 * endpoint when the perpendicular projection falls outside the segment.
 * Port of `pdfkitGeoPDF.js:167` `distanceToSegment`.
 *
 * @param {{x:number,y:number}} point
 * @param {{x:number,y:number}} segStart
 * @param {{x:number,y:number}} segEnd
 * @returns {number} non-negative distance
 */
export function distanceToSegment(point, segStart, segEnd) {
  const { x: px, y: py } = point
  const { x: sx, y: sy } = segStart
  const { x: ex, y: ey } = segEnd

  const dx = ex - sx
  const dy = ey - sy
  const lengthSquared = dx * dx + dy * dy

  if (lengthSquared === 0) {
    // Segment is a point
    return pointDistance(point, segStart)
  }

  // Clamped projection parameter
  let t = ((px - sx) * dx + (py - sy) * dy) / lengthSquared
  t = Math.max(0, Math.min(1, t))

  // Closest point on segment
  const closestX = sx + t * dx
  const closestY = sy + t * dy

  return pointDistance(point, { x: closestX, y: closestY })
}

/**
 * Ray-casting point-in-polygon test.
 * Port of `pdfkitGeoPDF.js:66` `isPointInPolygon`.
 *
 * The polygon's last vertex does NOT need to equal the first; this
 * function iterates with a wrap-around (i, j) pair so an open polygon
 * array works correctly. Behaviour on the polygon boundary (point on a
 * vertex or exactly on an edge) is algorithm-dependent — ray casting is
 * known to be fragile in this case and callers should not rely on a
 * specific result for boundary points.
 *
 * @param {{x:number,y:number}} point
 * @param {Array<{x:number,y:number}>} polygon
 * @returns {boolean}
 */
export function isPointInPolygon(point, polygon) {
  const { x, y } = point
  let inside = false

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const { x: xi, y: yi } = polygon[i]
    const { x: xj, y: yj } = polygon[j]

    // PDF original formula (`pdfkitGeoPDF.js:75`) verbatim — only the
    // destructuring above changed. The PDF used [y, x] tuples where the
    // ray was cast in the (Cape Lo) y-direction and the straddle test
    // was on the x-direction. With {x, y} object destructuring, the same
    // formula now describes a ray cast in the conventional y-direction
    // (vertical) with x-direction (horizontal) straddling.
    const intersect = ((xi > x) !== (xj > x)) && (y < ((yj - yi) * (x - xi)) / (xj - xi) + yi)
    if (intersect) inside = !inside
  }

  return inside
}

/**
 * True if the point is inside the polygon OR within `bufferDistance` of
 * any edge.
 * Port of `pdfkitGeoPDF.js:129` `isPointNearPolygon`.
 *
 * IMPORTANT: this function iterates `polygon.length - 1` edges (NOT
 * `length` with wrap-around), so it assumes the polygon is presented
 * CLOSED — the last vertex equals the first. Pass an open polygon and
 * the final edge from `polygon[n-1]` back to `polygon[0]` will not be
 * checked.
 *
 * (`isPointInPolygon` above does its own wrap-around so an open polygon
 * is fine there. The two PDF originals are inconsistent; this port
 * preserves both behaviours for fidelity.)
 *
 * @param {{x:number,y:number}} point
 * @param {Array<{x:number,y:number}>} polygon CLOSED — last vertex must equal first
 * @param {number} bufferDistance
 * @returns {boolean}
 */
export function isPointNearPolygon(point, polygon, bufferDistance) {
  if (isPointInPolygon(point, polygon)) return true

  for (let i = 0; i < polygon.length - 1; i++) {
    const p1 = polygon[i]
    const p2 = polygon[i + 1]
    if (distanceToSegment(point, p1, p2) <= bufferDistance) {
      return true
    }
  }

  return false
}

/**
 * True if two finite line segments cross. Uses the standard
 * cross-product orientation test (`ua` and `ub` in [0, 1]).
 *
 * Port of `pdfkitGeoPDF.js:7317` `lineSegmentsIntersect`. The PDF
 * version takes flat `{x1, y1, x2, y2}` segment objects; this port
 * takes `[{x, y}, {x, y}]` pairs (start, end) for interface uniformity.
 *
 * Parallel and collinear segments return `false` regardless of overlap
 * — the PDF original short-circuits when the denominator is near zero.
 * Callers needing collinear-overlap detection should check separately.
 *
 * @param {[{x:number,y:number},{x:number,y:number}]} seg1
 * @param {[{x:number,y:number},{x:number,y:number}]} seg2
 * @returns {boolean}
 */
export function lineSegmentsIntersect(seg1, seg2) {
  const [{ x: x1, y: y1 }, { x: x2, y: y2 }] = seg1
  const [{ x: x3, y: y3 }, { x: x4, y: y4 }] = seg2

  const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1)

  // Parallel (or collinear) — PDF original returns false here regardless of overlap
  if (Math.abs(denom) < 1e-10) return false

  const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom
  const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom

  return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1
}

/**
 * Axis-aligned rectangle overlap test with optional buffer.
 * Port of `pdfkitGeoPDF.js:7556` `rectanglesOverlap`.
 *
 * Touching edges (zero overlap area) return `false` unless the buffer
 * makes them effectively touch with positive overlap.
 *
 * @param {{x:number,y:number,width:number,height:number}} rect1
 * @param {{x:number,y:number,width:number,height:number}} rect2
 * @param {number} [buffer=0] minimum separation; rect2 is treated as if
 *   expanded by `buffer` on all sides for the overlap test
 * @returns {boolean}
 */
export function rectanglesOverlap(rect1, rect2, buffer = 0) {
  return !(
    rect1.x + rect1.width  < rect2.x - buffer ||
    rect2.x + rect2.width  < rect1.x - buffer ||
    rect1.y + rect1.height < rect2.y - buffer ||
    rect2.y + rect2.height < rect1.y - buffer
  )
}

/**
 * True if a rectangle overlaps a polygon. Three independent checks:
 * (1) any rect corner inside the polygon, (2) any polygon vertex inside
 * the (buffered) rect, (3) any polygon edge crosses any rect edge.
 *
 * Port of `pdfkitGeoPDF.js:7222` `rectangleOverlapsPolygon`. The PDF
 * version did inline tuple↔object conversions inside the function; this
 * port uses the uniform `{x, y}` interface so the conversions disappear.
 *
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {Array<{x:number,y:number}>} polygon
 * @param {number} [buffer=0]
 * @returns {boolean}
 */
export function rectangleOverlapsPolygon(rect, polygon, buffer = 0) {
  // Expand rect by buffer on all sides
  const expandedRect = {
    x: rect.x - buffer,
    y: rect.y - buffer,
    width: rect.width + 2 * buffer,
    height: rect.height + 2 * buffer,
  }

  // Check 1: any rect corner inside polygon
  const corners = [
    { x: expandedRect.x,                       y: expandedRect.y                       },
    { x: expandedRect.x + expandedRect.width,  y: expandedRect.y                       },
    { x: expandedRect.x + expandedRect.width,  y: expandedRect.y + expandedRect.height },
    { x: expandedRect.x,                       y: expandedRect.y + expandedRect.height },
  ]
  for (const corner of corners) {
    if (isPointInPolygon(corner, polygon)) return true
  }

  // Check 2: any polygon vertex inside rect
  for (const vertex of polygon) {
    if (vertex.x >= expandedRect.x && vertex.x <= expandedRect.x + expandedRect.width
        && vertex.y >= expandedRect.y && vertex.y <= expandedRect.y + expandedRect.height) {
      return true
    }
  }

  // Check 3: any polygon edge crosses any rect edge
  const rectEdges = [
    // Top
    [{ x: expandedRect.x,                       y: expandedRect.y                       },
     { x: expandedRect.x + expandedRect.width,  y: expandedRect.y                       }],
    // Right
    [{ x: expandedRect.x + expandedRect.width,  y: expandedRect.y                       },
     { x: expandedRect.x + expandedRect.width,  y: expandedRect.y + expandedRect.height }],
    // Bottom
    [{ x: expandedRect.x + expandedRect.width,  y: expandedRect.y + expandedRect.height },
     { x: expandedRect.x,                       y: expandedRect.y + expandedRect.height }],
    // Left
    [{ x: expandedRect.x,                       y: expandedRect.y + expandedRect.height },
     { x: expandedRect.x,                       y: expandedRect.y                       }],
  ]
  for (let i = 0; i < polygon.length; i++) {
    const polyEdge = [polygon[i], polygon[(i + 1) % polygon.length]]
    for (const rectEdge of rectEdges) {
      if (lineSegmentsIntersect(polyEdge, rectEdge)) return true
    }
  }

  return false
}
