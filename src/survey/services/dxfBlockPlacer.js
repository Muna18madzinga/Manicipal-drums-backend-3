/**
 * DXF Generic Block Placer — finds non-overlapping positions for blocks
 * inside a drawing zone, avoiding the outside-figure polygon and any
 * already-placed blocks (including tick-mark obstacles composed by the
 * caller).
 *
 * Used by sub-project 3-v2 (Schedule of Areas topological placement)
 * and potentially by 4d (per-feature label placement). Algorithm ported
 * verbatim from `pdfkitGeoPDF.js:9297-9530` (the schedule-multi-table
 * topology-aware placement logic), with the generator and validator
 * concerns separated for testability — algorithm rules unchanged.
 *
 * No DXF dependencies, no module state, no I/O (apart from an optional
 * caller-injected logger).
 */

import { rectangleOverlapsPolygon, rectanglesOverlap } from './dxfGeometry.js'
import { computeWhitespaceZones } from './dxfTopology.js'

/**
 * Returns the axis-aligned bounding box of a polygon plus the polygon
 * itself wrapped in one object. Consumers (the placer, 3-v2's caller
 * setup) want the bbox + polygon together for collision-detection and
 * candidate-generation pipelines.
 *
 * Deferred from sub-project 4b's spec.
 *
 * @param {Array<{x:number,y:number}>|null|undefined} polygon
 * @returns {{x:number,y:number,width:number,height:number,right:number,bottom:number,polygon:Array<{x:number,y:number}>}|null}
 *   null if polygon is missing or empty
 */
export function computeMapFeatureBounds(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return null

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of polygon) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    right: maxX,
    bottom: maxY,
    polygon,
  }
}

/**
 * Predicate — true if `rect` does NOT overlap any obstacle in
 * `polygon` or `placedBlocks`. Composes the three checks the PDF's
 * `isValidPosition` does (port of `pdfkitGeoPDF.js:9344`):
 *   1. Polygon overlap via 4a's rectangleOverlapsPolygon(rect, polygon, buffer)
 *      — skipped when polygon is null/empty.
 *   2. Block overlap via 4a's rectanglesOverlap(rect, placedBlocks[i], blockSpacing)
 *      — returns false on first overlap.
 *   3. Returns true if all checks pass.
 *
 * True predicate (boolean). No {valid, reason} shape like the PDF
 * original — DXF callers don't currently surface placement-failure
 * reasons.
 *
 * @param {Object} args
 * @param {{x:number,y:number,width:number,height:number}} args.rect - The candidate position+size to validate
 * @param {Array<{x:number,y:number}>|null} args.polygon - Polygon to avoid (skipped if null/empty)
 * @param {Array<{x:number,y:number,width:number,height:number}>} args.placedBlocks - Obstacles
 * @param {number} args.buffer - Polygon-clearance distance
 * @param {number} args.blockSpacing - Minimum separation between rect and any placed block
 * @returns {boolean}
 */
export function isValidPosition({ rect, polygon, placedBlocks, buffer, blockSpacing }) {
  // Polygon overlap check (skipped when polygon is missing/empty)
  if (Array.isArray(polygon) && polygon.length > 0) {
    if (rectangleOverlapsPolygon(rect, polygon, buffer)) return false
  }

  // Block-vs-block overlap check
  for (const placedBlock of placedBlocks) {
    if (rectanglesOverlap(rect, placedBlock, blockSpacing)) return false
  }

  return true
}

/**
 * No-op fake logger used when callers don't provide one. Same shape as
 * fastify.log (info/warn/error methods).
 */
const NO_OP_LOGGER = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * INTERNAL helper. Generates candidate positions inside the whitespace
 * zones returned by 4b's computeWhitespaceZones. For each zone, decimates
 * the zone into a grid of (x, y) positions at `scanStep` resolution.
 *
 * Per-zone iteration follows the PDF original at
 * `pdfkitGeoPDF.js:9402-9423`:
 *   - x iterates from zone.x to zone.x + zone.width - blockWidth
 *   - y iterates from zone.y to min(zone.y + zone.height, mapBottom - blockHeight)
 *     (the y cap is critical — band height can be smaller than blockHeight
 *     but the block's bottom may extend below the band's y range if the
 *     polygon doesn't intrude there; isValidPosition filters those cases).
 *
 * Deduplicates positions within `scanStep` epsilon (PDF dedup at line
 * 9417-9420).
 *
 * @returns {Array<{x:number,y:number}>}
 */
function generateTopologyCandidates({
  polygon, mapBounds, buffer, tableMinWidth, scanStep, blockWidth, blockHeight,
}) {
  const candidates = []
  const mapBottom = mapBounds.y + mapBounds.height
  const zones = computeWhitespaceZones({
    polygon, mapBounds, buffer, tableMinWidth, scanStep,
  })
  // The 'full' zone (returned when polygon < 3 vertices) is handled the same way.
  for (const zone of zones) {
    const yEnd = Math.min(zone.y + zone.height, mapBottom - blockHeight)
    for (let x = zone.x; x <= zone.x + zone.width - blockWidth; x += scanStep) {
      for (let y = zone.y; y <= yEnd; y += scanStep) {
        const dup = candidates.some(
          c => Math.abs(c.x - x) < scanStep && Math.abs(c.y - y) < scanStep
        )
        if (!dup) candidates.push({ x, y })
      }
    }
  }
  return candidates
}

/**
 * Grid-fallback edge margin (in mapBounds units). Positions within this
 * distance of any mapBounds edge are skipped to avoid crowding the
 * boundary. Exported so emitter callers can match the placer's effective
 * scan range when computing their block sizes.
 *
 * Source: PDF placer at `pdfkitGeoPDF.js:9431-9434` uses 14 pt.
 */
export const GRID_EDGE_MARGIN = 14

/**
 * INTERNAL helper. Full-grid fallback. Scans right-to-left first
 * (matches PDF priority at `pdfkitGeoPDF.js:9431-9450`), then
 * left-to-right (line 9452-9472). Skips positions within `scanStep`
 * epsilon of any in `existingCandidates`.
 *
 * Uses `GRID_EDGE_MARGIN` (14) as the edge reserve — see the exported
 * constant for the rationale.
 *
 * @returns {Array<{x:number,y:number}>}
 */
function generateGridCandidates({
  mapBounds, scanStep, blockWidth, blockHeight, existingCandidates,
}) {
  const EDGE_MARGIN = GRID_EDGE_MARGIN
  const candidates = []
  const left   = mapBounds.x + EDGE_MARGIN
  const right  = mapBounds.x + mapBounds.width - EDGE_MARGIN
  const top    = mapBounds.y + EDGE_MARGIN
  const bottom = mapBounds.y + mapBounds.height - EDGE_MARGIN

  const isDup = (x, y) => {
    const inExisting = existingCandidates.some(
      c => Math.abs(c.x - x) < scanStep && Math.abs(c.y - y) < scanStep
    )
    const inSelf = candidates.some(
      c => Math.abs(c.x - x) < scanStep && Math.abs(c.y - y) < scanStep
    )
    return inExisting || inSelf
  }

  // Right-to-left scan (PDF priority — right-side placement preferred)
  for (let x = right - blockWidth; x >= left; x -= scanStep) {
    for (let y = top; y + blockHeight <= bottom; y += scanStep) {
      if (!isDup(x, y)) candidates.push({ x, y })
    }
  }

  // Left-to-right scan (catches positions the right-to-left grid stride missed)
  for (let x = left; x + blockWidth <= right; x += scanStep) {
    for (let y = top; y + blockHeight <= bottom; y += scanStep) {
      if (!isDup(x, y)) candidates.push({ x, y })
    }
  }

  return candidates
}

/**
 * Find a valid position for a block. Returns the top-left {x, y} of a
 * position that fits inside `mapBounds`, doesn't overlap `polygon`
 * (with `buffer` clearance), and doesn't overlap any `placedBlocks`
 * (with `blockSpacing` separation). Returns null if no valid position
 * found.
 *
 * Two-layered candidate strategy:
 *   1. TOPOLOGY (preferred): candidates derived from 4b's whitespace
 *      zones via generateTopologyCandidates.
 *   2. GRID FALLBACK: full-grid scan if topology yielded nothing OR
 *      all topology candidates failed validation.
 *
 * Algorithm restructured from `pdfkitGeoPDF.js:9297-9530` — the PDF
 * interleaves generation and validation; this port separates them for
 * testability. Algorithm rules unchanged.
 *
 * @param {Object} args
 * @param {{width:number,height:number}} args.block
 * @param {{x:number,y:number,width:number,height:number}} args.mapBounds
 * @param {Array<{x:number,y:number}>|null} args.polygon
 * @param {Array<{x:number,y:number,width:number,height:number}>} args.placedBlocks
 * @param {number} args.buffer
 * @param {number} args.blockSpacing
 * @param {number} args.scanStep
 * @param {number} args.tableMinWidth
 * @param {{info:Function,warn:Function,error:Function}} [args.logger=NO_OP_LOGGER]
 * @returns {{x:number,y:number}|null}
 */
export function findBlockPosition({
  block, mapBounds, polygon, placedBlocks, buffer, blockSpacing, scanStep, tableMinWidth,
  logger = NO_OP_LOGGER,
}) {
  // LAYER 1: topology-aware candidates
  const topologyCandidates = generateTopologyCandidates({
    polygon, mapBounds, buffer, tableMinWidth, scanStep,
    blockWidth: block.width, blockHeight: block.height,
  })
  logger.info(`[dxfBlockPlacer] Layer 1 (topology): ${topologyCandidates.length} candidates`)

  for (const c of topologyCandidates) {
    const rect = { x: c.x, y: c.y, width: block.width, height: block.height }
    if (isValidPosition({ rect, polygon, placedBlocks, buffer, blockSpacing })) {
      return { x: c.x, y: c.y }
    }
  }

  // LAYER 2: grid fallback
  const gridCandidates = generateGridCandidates({
    mapBounds, scanStep, blockWidth: block.width, blockHeight: block.height,
    existingCandidates: topologyCandidates,
  })
  logger.info(`[dxfBlockPlacer] Layer 2 (grid fallback): ${gridCandidates.length} candidates`)

  for (const c of gridCandidates) {
    const rect = { x: c.x, y: c.y, width: block.width, height: block.height }
    if (isValidPosition({ rect, polygon, placedBlocks, buffer, blockSpacing })) {
      return { x: c.x, y: c.y }
    }
  }

  logger.warn(`[dxfBlockPlacer] No valid position found for block ${block.width}×${block.height}`)
  return null
}
