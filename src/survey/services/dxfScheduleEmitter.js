/**
 * Schedule of Areas Topological Emitter — places schedule sub-tables
 * inside the drawing zone via 4c's `findBlockPosition`. Replaces the
 * fixed bottom-left col1 strip emission shipped in sub-project 3.
 *
 * Imports `findBlockPosition` from `./dxfBlockPlacer.js`. Receives the
 * four #3 helpers + `mm` via an injected `helpers` parameter bag to
 * avoid a cycle with `dxfGenerator.js`. DXF emission goes through
 * caller-injected `addText` / `addLine` callbacks.
 *
 * Algorithm in `docs/superpowers/specs/2026-06-04-dxf-schedule-of-areas-3v2-design.md`.
 *
 * Consolidation pass added in Task 3. Overflow + edge case handling in Task 4.
 */

import { findBlockPosition, GRID_EDGE_MARGIN, isValidPosition } from './dxfBlockPlacer.js'
import { computeWhitespaceZones } from './dxfTopology.js'
import { rectanglesOverlap, rectangleOverlapsPolygon } from './dxfGeometry.js'
import { planScheduleSplit, SCHEDULE_OF_AREAS } from '../../../app-shared/block-definitions.js'

/** PDF point → paper-millimetre conversion. 1 pt = 1/72 inch = 25.4/72 mm. */
const PT_TO_MM = 25.4 / 72

/** Clearance (paper-mm) from polygon edges for the placer's buffer parameter. */
export const POLYGON_BUFFER_MM = 2.0

/** Minimum separation (paper-mm) between placed sub-tables and other blocks. */
export const BLOCK_SPACING_MM = 3.0

/**
 * Topology + grid step resolution (paper-mm). Higher = fewer candidate
 * positions for the placer to validate = faster placement at the cost of
 * potentially missing tight slots.
 *
 * Bumped from 2 mm to 5 mm on 2026-06-05 after the table-sizing fix
 * (f48ecc8) cut sub-tables ~3.4× narrower. With the previous step the
 * placer generated 50k+ candidates per table on dense Maglas-density
 * plans, taking 40+ seconds and tripping the frontend timeout. At 5 mm
 * the candidate count drops ~6× while the visual placement is unchanged
 * — schedule cells are 35-60 pt wide (12-21 mm), so a 5 mm step still
 * resolves every reasonable placement opportunity.
 */
export const SCAN_STEP_MM = 5.0

// Spec amendment: TITLE_SPACING_MM dropped. SCHEDULE_HEADER_HEIGHT_MM already
// covers the title-to-header gap inside the schedule. Adding TITLE_SPACING
// as a separate reserve on top would make subTableHeight > zoneHeight and
// Pass 1 would always fail (`mm(headerHeight + rowsPerTable*rowHeight + TITLE_SPACING)`
// exceeds the budget that `computeScheduleLayout` allotted for the same rows).

/**
 * Emit Schedule of Areas sub-tables at topology-derived positions inside
 * `drawingZone`. See spec for the full algorithm.
 *
 * @returns {{
 *   placedTables: Array<{x:number,y:number,width:number,height:number,rowCount:number,isContinuation:boolean}>,
 *   placedStandCount: number,
 *   missingStandCount: number,
 *   southmostY: number
 * }}
 */
export function emitScheduleOfAreasTopological({
  surveyedFeatures,
  drawingZone,
  polygon,
  sheetSize,
  fonts,
  helpers,
  addText,
  addLine,
  warn,
  logger,
  seedPlacedBlocks = [],   // 3-v4: external obstacles to honour in addition to placedPositions
  fixedPosition,           // 3-v6: { x, y } TOP-LEFT (south-up: high y); when set, skip Pass 1/2/3 search and emit at this position
  // 3-v8 follow-up: when the shared planner ran PDF's smart layout search and
  // produced per-sub-table positions, the DXF generator converts each to ground
  // metres and passes them here. Highest precedence — overrides fixedPosition.
  placedTablesGround = null,
}) {
  const { hHead, hBody, rH } = fonts
  const {
    extractScheduleRow, computeScheduleLayout, addScheduleTable,
    nextLargerSheet, SCHEDULE_HEADER_HEIGHT_MM, mm,
  } = helpers

  // 1. Extract data rows. Zero-stand shortcut.
  const dataRows = surveyedFeatures.map(extractScheduleRow)
  if (dataRows.length === 0) {
    return {
      placedTables: [], placedStandCount: 0, missingStandCount: 0,
      southmostY: drawingZone.y,
    }
  }

  // 2. Compute layout using the drawing-zone dimensions, MINUS the placer's
  //    grid-fallback edge margin reserved on top/bottom/left/right. Without
  //    this subtraction the layout sizes sub-tables to exactly fill the zone,
  //    but the placer's grid scan can only generate candidates inside the
  //    margin-shrunk window — the sub-table is then taller than any candidate
  //    slot and `generateGridCandidates` returns zero positions.
  //    The margin is in mapBounds units (ground-metres for our case); the
  //    layout helper works in paper-mm, so we divide by mm(1) consistently.
  const effectiveZoneWidth  = (drawingZone.width  - 2 * GRID_EDGE_MARGIN) / mm(1)
  const effectiveZoneHeight = (drawingZone.height - 2 * GRID_EDGE_MARGIN) / mm(1)
  const layout = computeScheduleLayout({
    rowCount:         dataRows.length,
    zoneWidth:        effectiveZoneWidth,
    zoneHeight:       effectiveZoneHeight,
    rowHeight:        rH / mm(1),
    headerHeight:     SCHEDULE_HEADER_HEIGHT_MM,
    currentSheetSize: sheetSize,
  })

  // Helper: emit the "SCHEDULE OF AREAS" title placeholder near the top-left
  // of the drawing zone. Used by every path that fails to place any sub-table,
  // so the user always sees there's a schedule that couldn't fit (the
  // structured `scheduleOverflow` warn alone isn't visible in the DXF).
  const emitTitlePlaceholder = () => {
    addText(
      'TITLE_BLOCK',
      drawingZone.x + mm(3),
      drawingZone.y + drawingZone.height - mm(5),
      'SCHEDULE OF AREAS', hHead, 0, 'BOLD',
    )
  }

  // 3. Initial-budget overflow.
  if (!layout.fits) {
    emitTitlePlaceholder()
    warn('scheduleOverflow', {
      atSheetSize:       sheetSize,
      requiredSheetSize: layout.recommendedSheetSize,
      standCount:        dataRows.length,
      phase:             'initial-budget',
    })
    return {
      placedTables: [], placedStandCount: 0, missingStandCount: dataRows.length,
      southmostY: drawingZone.y,
    }
  }

  // 4. Sub-table dimensions in ground-metres. Height = headerHeight + rowsPerTable
  //    * rowHeight, matching computeScheduleLayout's budget exactly so Pass 1
  //    candidate positions are not pre-emptively rejected by the placer.
  // 2026-06-06: prefer dynamic widths from helpers when caller provides them.
  // Falls back to layout.columnWidths (the pre-2026-06-06 fixed widths) when
  // helpers.columnWidthsG is absent so existing test fixtures still work.
  const columnWidthsG_local = helpers.columnWidthsG || layout.columnWidths.map(mm)
  const subTableWidthG = columnWidthsG_local.reduce((s, w) => s + w, 0)
  const subTableHeightG = mm(
    SCHEDULE_HEADER_HEIGHT_MM + layout.rowsPerTable * (rH / mm(1)),
  )

  // 3-v8 follow-up: placedTablesGround early exit. When the planner ran the
  // shared schedule-layout search and produced per-sub-table positions, render
  // each at its own (x, y). This gives DXF the SAME placement PDF uses.
  if (Array.isArray(placedTablesGround) && placedTablesGround.length > 0) {
    const placedTables = []
    let placedStandCount = 0
    let southmostY = placedTablesGround[0].y
    for (const t of placedTablesGround) {
      const startRow = Number.isFinite(t.parcelsStartIndex)
        ? t.parcelsStartIndex
        : placedStandCount
      const rowsBudget = Number.isFinite(t.rowCount) ? t.rowCount : layout.rowsPerTable
      const rows = dataRows.slice(startRow, startRow + rowsBudget)
      if (rows.length === 0) break
      const titleText = t.isContinuation ? "SCHEDULE OF AREAS (cont'd)" : 'SCHEDULE OF AREAS'
      addScheduleTable({
        layer: 'TITLE_BLOCK',
        x: t.x, y: t.y,
        dataRows: rows,
        columnWidths: columnWidthsG_local,
        titleText,
        hHead, hBody, rH,
        addText, addLine,
      })
      const yBottom = t.y - t.height
      placedTables.push({
        x: t.x, y: yBottom, width: t.width, height: t.height,
        rowCount: rows.length, isContinuation: !!t.isContinuation,
      })
      placedStandCount += rows.length
      if (yBottom < southmostY) southmostY = yBottom
    }
    logger.info(`[dxfScheduleEmitter] placedTablesGround mode: emitted ${placedTables.length}/${placedTablesGround.length} sub-tables (${placedStandCount}/${dataRows.length} stands)`)
    if (polygon && polygon.length >= 3) {
      for (const t of placedTables) {
        const rect = { x: t.x, y: t.y, width: t.width, height: t.height }
        if (rectangleOverlapsPolygon(rect, polygon, 0)) {
          warn('scheduleOfAreasOverlapsPolygon', {
            position: rect,
            isContinuation: t.isContinuation,
            hint: 'Schedule sub-table rendered over the parcel figure.',
          })
        }
      }
    }
    return {
      placedTables,
      placedStandCount,
      missingStandCount: dataRows.length - placedStandCount,
      southmostY,
    }
  }

  // 3-v6: fixedPosition early exit. When the caller (DXF generator) supplies
  // an exact placement from the shared planner, skip Pass 1/2/3 polygon-aware
  // search and emit sub-tables side-by-side at that position. Achieves PDF↔DXF
  // schedule-position parity at the cost of accepting overlap if the caller's
  // position conflicts with the polygon — the caller is responsible for picking
  // a sensible spot (which the shared planner already does for the PDF).
  if (fixedPosition) {
    const spacingG = mm(SCHEDULE_OF_AREAS.multiColumn.columnSpacing * PT_TO_MM)
    const placedTables = []
    let placedStandCount = 0
    let southmostY = fixedPosition.y
    for (let i = 0; i < layout.numTables; i++) {
      const startRow = i * layout.rowsPerTable
      const rows = dataRows.slice(startRow, startRow + layout.rowsPerTable)
      if (rows.length === 0) break
      const x = fixedPosition.x + i * (subTableWidthG + spacingG)
      const titleText = i === 0 ? 'SCHEDULE OF AREAS' : "SCHEDULE OF AREAS (cont'd)"
      addScheduleTable({
        layer: 'TITLE_BLOCK',
        x, y: fixedPosition.y,
        dataRows: rows,
        columnWidths: columnWidthsG_local,
        titleText,
        hHead, hBody, rH,
        addText, addLine,
      })
      const yBottom = fixedPosition.y - subTableHeightG
      placedTables.push({
        x, y: yBottom, width: subTableWidthG, height: subTableHeightG,
        rowCount: rows.length,
        isContinuation: i > 0,
      })
      placedStandCount += rows.length
      if (yBottom < southmostY) southmostY = yBottom
    }
    logger.info(`[dxfScheduleEmitter] fixedPosition mode: emitted ${placedTables.length}/${layout.numTables} sub-tables at (${fixedPosition.x.toFixed(2)}, ${fixedPosition.y.toFixed(2)})`)
    // 3-v7: warn if any placed sub-table overlaps the polygon. The emit still
    // happens (single source of truth: the planner placed the schedule here);
    // the warn gives the frontend a machine-readable signal.
    if (polygon && polygon.length >= 3) {
      for (const t of placedTables) {
        const rect = { x: t.x, y: t.y, width: t.width, height: t.height }
        if (rectangleOverlapsPolygon(rect, polygon, 0)) {
          warn('scheduleOfAreasOverlapsPolygon', {
            position: rect,
            isContinuation: t.isContinuation,
            hint: 'Schedule sub-table rendered over the parcel figure.',
          })
        }
      }
    }
    return {
      placedTables,
      placedStandCount,
      missingStandCount: dataRows.length - placedStandCount,
      southmostY,
    }
  }

  // Closed-polygon copy + whitespace-zone enumeration + right-edge sort are
  // shared between Pass 1 (new right-anchor preference) and Pass 2 (existing
  // split + shrink-to-fit). Hoisting them out of Pass 2 lets Pass 1 use the
  // same gap topology without re-walking it.
  //
  // computeWhitespaceZones walks polygon edges via polygon[i] → polygon[i+1]
  // for i < polygon.length - 1, missing the closing edge when the polygon
  // isn't explicitly closed. The orchestrator's figurePolygon construction
  // (dxfGenerator.js: ofResult.vertices.slice(0, -1)) strips the closing
  // vertex, and unit-test polygons typically follow the same convention.
  // Without an explicit closing edge, the strip-scanner reports spurious
  // zones (e.g. a polygon fully covering the zone yields a "left strip"
  // zone of the full width). Append a closing duplicate before passing in.
  const closedPolygon = (polygon && polygon.length >= 3 &&
    (polygon[0].x !== polygon[polygon.length - 1].x ||
     polygon[0].y !== polygon[polygon.length - 1].y))
    ? [...polygon, polygon[0]]
    : polygon

  const allZones = computeWhitespaceZones({
    polygon:       closedPolygon,
    mapBounds:     drawingZone,
    buffer:        mm(POLYGON_BUFFER_MM),
    tableMinWidth: subTableWidthG,
    scanStep:      mm(SCAN_STEP_MM),
  })
  const seedFiltered = allZones.filter(g =>
    !seedPlacedBlocks.some(b =>
      rectanglesOverlap(g, b, mm(BLOCK_SPACING_MM))))

  // Right-anchor preference: surveyors expect the Schedule of Areas on the
  // RIGHT side of the page (next to endorsements). Sort gaps by right-edge x
  // descending so both passes try the rightmost-fitting gap first.
  const availableGaps = seedFiltered.slice().sort((a, b) => {
    const aRight = a.x + a.width
    const bRight = b.x + b.width
    if (aRight !== bRight) return bRight - aRight   // right-edge x desc
    return (b.width * b.height) - (a.width * a.height)   // area desc tiebreaker
  })

  logger.info(`[dxfScheduleEmitter] Pass 1 right-anchor: ${availableGaps.length} candidate gaps (sorted by right-edge x desc)`)

  // 5. PASS 1 — right-preferred topology placement at original size.
  //
  // For each sub-table we walk `availableGaps` (right-edge sorted) and try to
  // right-anchor at the gap's right edge. If that position is invalid (polygon
  // overlap on the right side or seed block in the way) we fall back to the
  // generic findBlockPosition for that single table — preserving the prior
  // Pass 1 success rate on asymmetric polygons where the rightmost slot is
  // blocked but a middle/left slot is free.
  //
  // Right-anchor commit d2b67b4 originally scoped this to Pass 2 only, but on
  // plans where Pass 1 succeeds at original size (the common case) the
  // schedule still landed on the left. Extending the right-pref to Pass 1
  // makes "schedule on the right" hold across all placement paths.
  let placedPositions = []
  for (let i = 0; i < layout.numTables; i++) {
    let placed = false
    for (const g of availableGaps) {
      if (g.width < subTableWidthG || g.height < subTableHeightG) continue
      const rect = {
        x:      g.x + g.width - subTableWidthG,
        y:      g.y + g.height - subTableHeightG,
        width:  subTableWidthG,
        height: subTableHeightG,
      }
      const valid = isValidPosition({
        rect,
        polygon:      closedPolygon,
        placedBlocks: [...seedPlacedBlocks, ...placedPositions],
        buffer:       mm(POLYGON_BUFFER_MM),
        blockSpacing: mm(BLOCK_SPACING_MM),
      })
      if (valid) {
        placedPositions.push({ ...rect, rowCount: layout.rowsPerTable })
        placed = true
        break
      }
    }
    if (placed) continue
    // Fall back to the generic placer (preserves pre-fix Pass 1 success on
    // asymmetric polygons where the rightmost slot is blocked).
    const position = findBlockPosition({
      block:         { width: subTableWidthG, height: subTableHeightG },
      mapBounds:     drawingZone,
      polygon,
      placedBlocks:  [...seedPlacedBlocks, ...placedPositions],
      buffer:        mm(POLYGON_BUFFER_MM),
      blockSpacing:  mm(BLOCK_SPACING_MM),
      scanStep:      mm(SCAN_STEP_MM),
      tableMinWidth: subTableWidthG,
      logger,
    })
    if (position === null) break
    placedPositions.push({
      x: position.x, y: position.y,
      width: subTableWidthG, height: subTableHeightG,
      rowCount: layout.rowsPerTable,
    })
  }

  // 6. PASS 2 — split-into-smaller (only if PASS 1 didn't seat all tables).
  if (placedPositions.length < layout.numTables) {
    // 2026-06-06: split-into-smaller replaces pre-2026-06-06 consolidation
    // (fewer-but-taller tables, which rarely succeeded because consolidated
    // taller tables exceeded the zone height). Spec:
    //   docs/superpowers/specs/2026-06-06-schedule-split-and-dynamic-columns-design.md
    placedPositions = []   // discard pass-1 positions; replay from scratch
    const headerHeightG = mm(SCHEDULE_HEADER_HEIGHT_MM)

    const { plan, residualRows } = planScheduleSplit({
      totalRows:    dataRows.length,
      availableGaps,
      tableWidth:   subTableWidthG,
      headerHeight: headerHeightG,
      rowHeight:    rH,
      minRowsPerTable: 3,
    })

    // 2026-06-06 polygon-overlap fix + shrink-to-fit:
    //   1. Validate every proposed placement against polygon + seed obstacles.
    //   2. If invalid, halve the sub-table's rowCount and retry until it
    //      either fits or drops below minRowsPerTable. This handles the
    //      band-flush quirk (computeWhitespaceZones can over-report zone
    //      width on non-convex polygons) AND adapts to sub-tables that fit
    //      at smaller sizes but not at the originally-planned size.
    //   3. Anchor the sub-table at the gap's RIGHT edge (not left) so the
    //      sub-table sits closest to the content-area right side. Combined
    //      with the right-edge gap sort above, this gives "schedule on the
    //      right" by construction.
    //   4. Rows shrunk from a successfully placed sub-table become residual
    //      (counted toward missingStandCount).
    const MIN_ROWS_PER_TABLE = 3
    let residualFromInvalidPlacement = 0
    let residualFromShrink = 0
    for (const entry of plan) {
      const g = availableGaps[entry.gapIndex]
      let rows = entry.rowCount
      let placed = false
      while (rows >= MIN_ROWS_PER_TABLE) {
        const subTableHeightG = headerHeightG + rows * rH
        // Right-anchor placement: x = gap right edge - tableWidth.
        const rect = {
          x:      g.x + g.width - subTableWidthG,
          y:      g.y + g.height - subTableHeightG,
          width:  subTableWidthG,
          height: subTableHeightG,
        }
        const valid = isValidPosition({
          rect,
          polygon:      closedPolygon,
          placedBlocks: [...seedPlacedBlocks, ...placedPositions],
          buffer:       mm(POLYGON_BUFFER_MM),
          blockSpacing: mm(BLOCK_SPACING_MM),
        })
        if (valid) {
          placedPositions.push({ ...rect, rowCount: rows })
          if (rows < entry.rowCount) {
            residualFromShrink += entry.rowCount - rows
            logger.info(`[dxfScheduleEmitter] Pass 2 split: shrunk gap[${entry.gapIndex}] sub-table from ${entry.rowCount} → ${rows} rows to fit; ${entry.rowCount - rows} rows become residual`)
          }
          placed = true
          break
        }
        // Halve rows and retry. Math.floor ensures monotone decrease.
        rows = Math.floor(rows / 2)
      }
      if (!placed) {
        residualFromInvalidPlacement += entry.rowCount
        logger.info(`[dxfScheduleEmitter] Pass 2 split: rejected gap[${entry.gapIndex}] (no rowCount fits — polygon or seed overlap); ${entry.rowCount} rows become residual`)
      }
    }
    const passTwoResidualTotal = residualFromInvalidPlacement + residualFromShrink

    const totalResidual = residualRows + passTwoResidualTotal
    if (placedPositions.length > 0 && totalResidual > 0) {
      warn('scheduleOverflow', {
        atSheetSize:          sheetSize,
        recommendedSheetSize: nextLargerSheet(sheetSize),
        placedStandCount:     dataRows.length - totalResidual,
        missingStandCount:    totalResidual,
        placedTables:         placedPositions.length,
        phase:                'split-residual',
      })
    }

    if (placedPositions.length > 0) {
      logger.info(`[dxfScheduleEmitter] Pass 2 split placed ${placedPositions.length} sub-tables (planResidual=${residualRows}, shrunk=${residualFromShrink}, invalid=${residualFromInvalidPlacement})`)
    }

    // PASS 3 — skip-polygon + skip-seed fallback. When Pass 1 + Pass 2 both
    // produced zero placements (either feasible=0 entering consolidation, or
    // consolidation's taller-height retry also failed), try one more time at
    // the ORIGINAL sub-table size with polygon=null AND ignoring the
    // orchestrator-supplied seedPlacedBlocks. Accepts overlap with both the
    // figure polygon and the other bottom-zone blocks — the schedule is a
    // mandatory SI 727 element so overlapping a parcel boundary or the OFD
    // table is the documented trade-off (matches
    // `pdfkitGeoPDF.js:_findFreshSkipPolygon`).
    //
    // 3-v4 regression fix (2026-06-06): pre-3-v4 Pass 3 already ignored the
    // polygon. When Task 4 added seedPlacedBlocks to Pass 1/2/3 uniformly,
    // Pass 3 lost its ability to rescue dense plans where the orchestrator
    // had placed OFD in the central whitespace before the schedule's turn.
    // On the user's Maglas-density plan the schedule fell back to title
    // placeholder only. Pass 3 now ignores the seed too — Pass 1 and Pass 2
    // continue to honor it.
    if (placedPositions.length === 0) {
      logger.info('[dxfScheduleEmitter] Pass 1 + Pass 2 both placed 0 — trying Pass 3 skip-polygon fallback')
      for (let i = 0; i < layout.numTables; i++) {
        const position = findBlockPosition({
          block:         { width: subTableWidthG, height: subTableHeightG },
          mapBounds:     drawingZone,
          polygon:       null,       // skip polygon avoidance; accept overlap
          placedBlocks:  placedPositions,    // skip seed avoidance; only honor own sub-tables
          buffer:        mm(POLYGON_BUFFER_MM),
          blockSpacing:  mm(BLOCK_SPACING_MM),
          scanStep:      mm(SCAN_STEP_MM),
          tableMinWidth: subTableWidthG,
          logger,
        })
        if (position === null) break
        placedPositions.push({
          x: position.x, y: position.y,
          width: subTableWidthG, height: subTableHeightG,
          rowCount: layout.rowsPerTable,
        })
      }
      if (placedPositions.length > 0) {
        logger.info(`[dxfScheduleEmitter] Pass 3 placed ${placedPositions.length} tables (overlapping figure polygon)`)
      }
    }

    // All three passes failed — emit title placeholder + warn and return.
    if (placedPositions.length === 0) {
      emitTitlePlaceholder()
      warn('scheduleOverflow', {
        atSheetSize:          sheetSize,
        recommendedSheetSize: nextLargerSheet(sheetSize),
        placedStandCount:     0,
        missingStandCount:    dataRows.length,
        placedTables:         0,
        phase:                'consolidation-zero-fit',
      })
      return {
        placedTables: [], placedStandCount: 0, missingStandCount: dataRows.length,
        southmostY: drawingZone.y,
      }
    }
  }

  // 7. FINAL emission loop.
  const placedTables = []
  let placedStandCount = 0
  let southmostY = Infinity

  for (let i = 0; i < placedPositions.length; i++) {
    const p = placedPositions[i]
    const rows = dataRows.slice(placedStandCount, placedStandCount + p.rowCount)
    if (rows.length === 0) break
    const titleText = i === 0 ? 'SCHEDULE OF AREAS' : "SCHEDULE OF AREAS (cont'd)"
    addScheduleTable({
      layer: 'TITLE_BLOCK',
      // findBlockPosition returns block bottom-y (LOW y); addScheduleTable's
      // `y` is the title-row TOP (HIGH y). Block occupies [p.y, p.y + p.height].
      x: p.x, y: p.y + p.height,
      dataRows: rows,
      columnWidths: columnWidthsG_local,
      titleText,
      hHead, hBody, rH,
      addText, addLine,
    })
    placedTables.push({
      x: p.x, y: p.y, width: p.width, height: p.height,
      rowCount: rows.length,
      isContinuation: i > 0,
    })
    placedStandCount += rows.length
    if (p.y < southmostY) southmostY = p.y
  }

  // 8. Residual-overflow warn.
  const missingStandCount = dataRows.length - placedStandCount
  if (missingStandCount > 0 && placedTables.length > 0) {
    warn('scheduleOverflow', {
      atSheetSize:          sheetSize,
      recommendedSheetSize: nextLargerSheet(sheetSize),
      placedStandCount,
      missingStandCount,
      placedTables:         placedTables.length,
      phase:                'consolidation-residual',
    })
  }

  if (placedTables.length === 0) southmostY = drawingZone.y

  return {
    placedTables,
    placedStandCount,
    missingStandCount,
    southmostY,
  }
}
