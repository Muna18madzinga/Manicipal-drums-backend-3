/**
 * DXF Per-Feature Label Placer — finds smart positions for stand
 * numbers and edge labels (distance + direction) inside parcel
 * polygons.
 *
 * Used by `dxfGenerator.js` in the parcel emission block. Algorithms
 * ported verbatim from `pdfkitGeoPDF.js:1136-1225` (stand labels),
 * `:4321-4427` (edge labels), and `:6038-6070` (fit-in-parcel utility),
 * with two DXF adaptations:
 *   1. Rendered string width is estimated via `charWidthRatio = 0.55`
 *      (DXF can't query rendered width like the PDF's doc.widthOfString).
 *   2. Returned `{x, y}` positions are the DXF baseline-left insertion
 *      point — the caller passes them directly to `addText` without
 *      any PDF-style width/2 or height/2 subtraction.
 *
 * No DXF emission inside this module — pure position-computation.
 * No module state, no I/O. Pure math.
 */

import { isPointInPolygon } from './dxfGeometry.js'

/**
 * True if a label's bounding box fits inside the polygon's bounding box
 * minus the given padding on all sides. Cheap bbox check — doesn't do
 * per-corner isPointInPolygon. Useful for fast filtering before more
 * expensive checks.
 *
 * Port of `pdfkitGeoPDF.js:6038-6070` `checkLabelFitsInParcel`.
 *
 * @param {Object} args
 * @param {number} args.centerX - Label center x
 * @param {number} args.centerY - Label center y
 * @param {number} args.labelWidth
 * @param {number} args.labelHeight
 * @param {Array<{x:number,y:number}>} args.polygon
 * @param {number} [args.padding=5] - Padding from polygon bbox edges
 * @returns {boolean}
 */
export function checkLabelFitsInParcel({
  centerX, centerY, labelWidth, labelHeight, polygon, padding = 5,
}) {
  const labelLeft   = centerX - labelWidth  / 2
  const labelRight  = centerX + labelWidth  / 2
  const labelTop    = centerY - labelHeight / 2
  const labelBottom = centerY + labelHeight / 2

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of polygon) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }

  return (
    labelLeft   >= minX + padding &&
    labelRight  <= maxX - padding &&
    labelTop    >= minY + padding &&
    labelBottom <= maxY - padding
  )
}

/**
 * INTERNAL helper — shoelace centroid. Inlined here so dxfLabelPlacer
 * stays self-contained (doesn't depend on dxfGenerator.js's helper).
 *
 * @param {Array<{x:number,y:number}>} polygon
 * @returns {{x:number,y:number}}
 */
function shoelaceCentroid(polygon) {
  let twiceArea = 0, cx = 0, cy = 0
  for (let i = 0; i < polygon.length; i++) {
    const p0 = polygon[i], p1 = polygon[(i + 1) % polygon.length]
    const cross = p0.x * p1.y - p1.x * p0.y
    twiceArea += cross
    cx += (p0.x + p1.x) * cross
    cy += (p0.y + p1.y) * cross
  }
  const sixArea = 3 * twiceArea
  if (Math.abs(sixArea) < 1e-12) {
    // Degenerate polygon; fall back to vertex average.
    let sx = 0, sy = 0
    for (const p of polygon) { sx += p.x; sy += p.y }
    return { x: sx / polygon.length, y: sy / polygon.length }
  }
  return { x: cx / sixArea, y: cy / sixArea }
}

/**
 * Find the stand-label position for a parcel. Returns the DXF addText
 * insertion point (baseline-left convention) plus the possibly-shrunk
 * font height.
 *
 * Port of `pdfkitGeoPDF.js:1136-1225` with two DXF adaptations:
 *   1. Char-width approximation (charWidthRatio default 0.55) replaces
 *      the PDF's doc.widthOfString.
 *   2. Returns the centroid directly as the addText insertion point
 *      (DXF baseline-left). The PDF's width/2, height/2 subtractions
 *      are NOT applied — they belong to the PDF's bottom-left convention.
 *
 * `findLargestInscribedCircle` fallback dropped (the PDF version at
 * line 1247 is a stub returning the centroid; we just use the centroid).
 *
 * @param {Object} args
 * @param {Array<{x:number,y:number}>} args.polygon - 3+ vertices, NOT closed (last vertex doesn't repeat first)
 * @param {string} args.standNumber
 * @param {number} args.fontHeight - Initial font height; may shrink during iteration
 * @param {number} [args.charWidthRatio=0.55] - Character-width-to-height ratio for width estimation
 * @param {number} [args.minFontHeightRatio=0.5] - Floor for the iterative shrink (fraction of input fontHeight)
 * @returns {{x:number, y:number, fontHeight:number, width:number, height:number}|null}
 *   null if polygon has fewer than 3 vertices
 */
export function findStandLabelPosition({
  polygon, standNumber, fontHeight, charWidthRatio = 0.55, minFontHeightRatio = 0.5,
}) {
  if (!Array.isArray(polygon) || polygon.length < 3) return null

  const centroid = shoelaceCentroid(polygon)
  // PDF's isPointInPolygon check is informational — the fallback is a stub returning
  // the centroid anyway, so the result is the same. We still call it to match PDF flow.
  // eslint-disable-next-line no-unused-vars
  const centroidInside = isPointInPolygon(centroid, polygon)
  const labelPoint = centroid

  // Polygon bbox
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of polygon) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const parcelWidth  = maxX - minX
  const parcelHeight = maxY - minY

  // PDF's edge-label reserve constant + minimum dimensions
  const edgeLabelReserve = 25
  const maxAllowedWidth  = Math.max(15, parcelWidth  - edgeLabelReserve * 2)
  const maxAllowedHeight = Math.max(10, parcelHeight - edgeLabelReserve * 2)

  // Iterative shrink — match PDF's `while (...) { fontSize -= 1; }` style but
  // step by 10% of input fontHeight so the iteration count stays bounded.
  const minFontHeight = fontHeight * minFontHeightRatio
  const step = fontHeight * 0.1
  let h = fontHeight
  let widthEstimate  = standNumber.length * h * charWidthRatio
  let heightEstimate = h * 1.2
  while (
    (widthEstimate > maxAllowedWidth * 0.5 || heightEstimate > maxAllowedHeight * 0.5) &&
    h > minFontHeight
  ) {
    h -= step
    if (h < minFontHeight) h = minFontHeight
    widthEstimate  = standNumber.length * h * charWidthRatio
    heightEstimate = h * 1.2
  }

  return {
    x: labelPoint.x,
    y: labelPoint.y,
    fontHeight: h,
    width: widthEstimate,
    height: heightEstimate,
  }
}

/**
 * Find the edge-label position for a label on an edge of a parcel.
 * Iterates perpendicular offset from the edge midpoint inward until
 * all 4 rotated corners of the label bbox fit inside the parcel.
 *
 * Port of `pdfkitGeoPDF.js:4321-4427` `calculateSmartLabelPosition`,
 * with the DXF adaptation that the returned `{x, y}` is the DXF addText
 * insertion point (baseline-left). The PDF's `offset = -labelHeight/2`
 * vertical adjustment is NOT applied.
 *
 * @param {Object} args
 * @param {{x:number,y:number}} args.edgeStart
 * @param {{x:number,y:number}} args.edgeEnd
 * @param {Array<{x:number,y:number}>} args.polygon
 * @param {number} args.labelHeight
 * @param {number} args.labelWidth
 * @param {number} args.angle - Rotation in degrees
 * @param {number} [args.maxOffsetMultiplier=1] - Max offset as multiple of labelHeight (matches PDF's labelHeight + 5)
 * @param {number} [args.stepSize] - Iteration step. Default labelHeight * 0.1
 * @returns {{x:number, y:number}|null}
 *   null if polygon is empty or edge is zero-length
 */
export function findEdgeLabelPosition({
  edgeStart, edgeEnd, polygon, labelHeight, labelWidth, angle,
  maxOffsetMultiplier = 1, stepSize,
}) {
  if (!Array.isArray(polygon) || polygon.length < 3) return null

  const midX = (edgeStart.x + edgeEnd.x) / 2
  const midY = (edgeStart.y + edgeEnd.y) / 2
  const edgeDx = edgeEnd.x - edgeStart.x
  const edgeDy = edgeEnd.y - edgeStart.y
  const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy)
  if (edgeLen < 1e-9) return null

  // Perpendicular unit vector (rotated 90° counterclockwise)
  const perpNormX = -edgeDy / edgeLen
  const perpNormY =  edgeDx / edgeLen

  // Test both inward directions at small offset to find which is inside parcel
  const testOffset = 5
  const testX1 = midX + perpNormX * testOffset
  const testY1 = midY + perpNormY * testOffset
  const testX2 = midX - perpNormX * testOffset
  const testY2 = midY - perpNormY * testOffset

  const inside1 = isPointInPolygon({ x: testX1, y: testY1 }, polygon)
  const inside2 = isPointInPolygon({ x: testX2, y: testY2 }, polygon)

  let offsetDir = 1
  if (inside2 && !inside1) offsetDir = -1

  // Iterative offset search
  const maxOffset = labelHeight * maxOffsetMultiplier + 5
  const step = stepSize ?? labelHeight * 0.1
  const angleRad = angle * (Math.PI / 180)
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)

  let labelX, labelY
  let isFullyInside = false

  for (let offset = 2; offset <= maxOffset; offset += step) {
    labelX = midX + perpNormX * offsetDir * offset
    labelY = midY + perpNormY * offsetDir * offset

    // 4 rotated corners of label bbox (centered on labelX, labelY for the corner check)
    const corners = [
      {
        x: labelX - (labelWidth / 2) * cos + (labelHeight / 2) * sin,
        y: labelY - (labelWidth / 2) * sin - (labelHeight / 2) * cos,
      },
      {
        x: labelX + (labelWidth / 2) * cos + (labelHeight / 2) * sin,
        y: labelY + (labelWidth / 2) * sin - (labelHeight / 2) * cos,
      },
      {
        x: labelX + (labelWidth / 2) * cos - (labelHeight / 2) * sin,
        y: labelY + (labelWidth / 2) * sin + (labelHeight / 2) * cos,
      },
      {
        x: labelX - (labelWidth / 2) * cos - (labelHeight / 2) * sin,
        y: labelY - (labelWidth / 2) * sin + (labelHeight / 2) * cos,
      },
    ]

    isFullyInside = corners.every(c => isPointInPolygon(c, polygon))
    if (isFullyInside) break
  }

  // If no valid offset found, use the max-offset position (best-effort, same as PDF)
  if (!isFullyInside) {
    labelX = midX + perpNormX * offsetDir * maxOffset
    labelY = midY + perpNormY * offsetDir * maxOffset
  }

  return { x: labelX, y: labelY }
}
