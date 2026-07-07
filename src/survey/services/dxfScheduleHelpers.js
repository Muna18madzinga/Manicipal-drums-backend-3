/**
 * Schedule of Areas helpers — extracted from dxfGenerator.js during
 * sub-project 3-v2 to break an import cycle: dxfScheduleEmitter.js
 * needs these helpers AND is called from dxfGenerator.js.
 *
 * Pure functions, no DXF emission. The two functions that emit
 * (`addScheduleTable`) take addText/addLine as injected callbacks.
 *
 * Algorithms unchanged from the #3 ship at d1f6fcd.
 */

import { SCHEDULE_OF_AREAS, formatAreaValue } from '../../../app-shared/block-definitions.js'

/**
 * Sheet ladder ordered smallest → largest. Index in this array maps to
 * valid Schedule of Areas starting sizes.
 */
const SHEET_LADDER = ['ISO_A2', 'ISO_A1', 'ISO_A0']

/**
 * Conversion factor: 1 PDF point = 0.352778 mm (1/72 inch × 25.4 mm/inch).
 * block-definitions.js dimensions are in PDF points (matching the PDF
 * generator's native unit). The DXF generator works in paper-mm, so this
 * helper converts when reading from the shared definitions.
 */
const PT_TO_MM = 25.4 / 72

/**
 * Total paper-millimetres reserved for the Schedule of Areas header
 * (title + spacing + column headers + DEED parent + underline). Shared
 * by computeScheduleLayout's row-budget math AND addScheduleTable's
 * actual header emission. Drift between the two would silently break
 * the layout.
 *
 * Matches the PDF's _SCHED_TITLE + _SCHED_SPACING + _SCHED_HEADER =
 * 15 + 15 + 25 = 55 pt → 19.4 mm (pdfkitGeoPDF.js:7907-7912).
 */
export const SCHEDULE_HEADER_HEIGHT_MM = 19

/**
 * Returns the next-larger sheet size in SHEET_LADDER, or
 * 'multi-sheet-required' when already at the top (or for an unknown
 * starting size — defensive fallback so sub-project #5 always sees a
 * clear signal).
 */
export function nextLargerSheet(currentSheetSize) {
  const idx = SHEET_LADDER.indexOf(currentSheetSize)
  if (idx < 0 || idx === SHEET_LADDER.length - 1) return 'multi-sheet-required'
  return SHEET_LADDER[idx + 1]
}

/**
 * Extracts the six SI 727 Schedule-of-Areas column values from a parcel
 * GeoJSON feature's `properties`. Returns an object whose values are all
 * strings ('' for absent optional fields).
 *
 * Area follows the SI 727 rule via the shared formatAreaValue (same logic the
 * PDF schedule uses): areas < 10 000 m² are given to the nearest square metre,
 * larger areas in hectares to four decimal places ("…Ha") — both with banker's
 * (round-half-to-even) rounding.
 */
export function extractScheduleRow(parcelFeature) {
  const props = parcelFeature?.properties || {}
  return {
    stand:      String(props.stand ?? ''),
    area:       formatAreaValue(props.area_m2 ?? 0),
    diagram:    String(props.diagram ?? ''),
    deedNumber: String(props.deedNumber ?? ''),
    deedDate:   String(props.deedDate ?? ''),
    surveyor:   String(props.surveyor ?? ''),
  }
}

/**
 * Computes the Schedule-of-Areas layout for a given row count and zone
 * size (in paper-millimetres). See dxfGenerator.js commit d1f6fcd for
 * the full design notes.
 */
export function computeScheduleLayout({
  rowCount,
  zoneWidth,
  zoneHeight,
  rowHeight,
  headerHeight,
  currentSheetSize,
}) {
  const singleCols = SCHEDULE_OF_AREAS?.singleColumn?.columns
  const multiCols  = SCHEDULE_OF_AREAS?.multiColumn?.columns
  const spacing    = SCHEDULE_OF_AREAS?.multiColumn?.columnSpacing
  if (!Array.isArray(singleCols) || !Array.isArray(multiCols) || typeof spacing !== 'number') {
    throw new Error('SCHEDULE_OF_AREAS missing from app-shared/block-definitions.js')
  }

  // Convert column widths and inter-table spacing from PDF pts to paper-mm.
  // block-definitions.js values are in PDF points (matching the PDF generator's
  // native unit); the DXF layout computes in paper-mm.
  const singleTableWidth = singleCols.reduce((s, c) => s + c.width, 0) * PT_TO_MM
  const subTableWidth    = multiCols.reduce((s, c) => s + c.width, 0) * PT_TO_MM
  const spacingMM        = spacing * PT_TO_MM

  const rowsPerColumn = Math.max(0, Math.floor((zoneHeight - headerHeight) / rowHeight))

  const singleScale = Math.min(1, zoneWidth / singleTableWidth)
  const singleColumnWidths = singleCols.map(c => c.width * PT_TO_MM * singleScale)

  if (rowCount === 0) {
    return { fits: true, numTables: 1, rowsPerTable: 0, columnWidths: singleColumnWidths }
  }

  if (rowsPerColumn === 0) {
    return { fits: false, recommendedSheetSize: nextLargerSheet(currentSheetSize) }
  }

  if (rowCount <= rowsPerColumn) {
    return { fits: true, numTables: 1, rowsPerTable: rowCount, columnWidths: singleColumnWidths }
  }

  const numTablesNeeded  = Math.ceil(rowCount / rowsPerColumn)
  if (zoneWidth < subTableWidth) {
    return { fits: false, recommendedSheetSize: nextLargerSheet(currentSheetSize) }
  }
  const maxTablesByWidth = Math.floor((zoneWidth + spacingMM) / (subTableWidth + spacingMM))

  if (numTablesNeeded > maxTablesByWidth) {
    return { fits: false, recommendedSheetSize: nextLargerSheet(currentSheetSize) }
  }

  const perTableBudget = (zoneWidth - (numTablesNeeded - 1) * spacingMM) / numTablesNeeded
  const subTableWidthOut = Math.min(perTableBudget, subTableWidth)
  const multiScale = subTableWidthOut / subTableWidth
  const multiColumnWidths = multiCols.map(c => c.width * PT_TO_MM * multiScale)

  return {
    fits: true,
    numTables: numTablesNeeded,
    rowsPerTable: rowsPerColumn,
    columnWidths: multiColumnWidths,
  }
}

/**
 * Emits one Schedule-of-Areas sub-table block (title + column headers +
 * DEED parent header + underline + data rows). Returns the y coordinate
 * after the last row.
 *
 * `addText` and `addLine` are injected so the helper stays unit-testable.
 */
export function addScheduleTable({
  layer, x, y,
  dataRows, columnWidths,
  titleText, hHead, hBody, rH,
  addText, addLine,
}) {
  const singleCols = SCHEDULE_OF_AREAS?.singleColumn?.columns
  if (!Array.isArray(singleCols)) {
    throw new Error('SCHEDULE_OF_AREAS missing from app-shared/block-definitions.js')
  }

  // ── Column anchor x-coords (left edge of each column from x). ──
  const colX = []
  let cx = 0
  for (const w of columnWidths) {
    colX.push(x + cx)
    cx += w
  }
  const rightEdge = x + cx

  // Character width used for centring text horizontally inside columns.
  // Matches the 0.6 ratio used by the DEED-anchor formula in the pre-2026-06-06
  // version of this function (and exercised by the dxfScheduleHelpers test
  // "emits the DEED parent header centered above NUMBER + DATE").
  const DXF_CHAR_WIDTH_RATIO = 0.6
  // Internal cell padding (horizontal text inset from the column edge so
  // contents don't touch the vertical grid lines). Matches the PDF's 2-pt
  // padding when scaled by the body font size.
  const H_PAD = hBody * 0.3

  // ── Title (above the bordered table, at the caller-supplied (x, y)). ──
  addText(layer, x, y, titleText, hHead, 0, 'BOLD')

  // ── Bordered table layout ──
  // Top of the bordered area sits one title-row-height below the title.
  const tableTopY = y - hHead * 1.6

  // DEED merged-header row (spans NUMBER + DATE columns). Height matches
  // the single-line sub-header step so the merged header is the same height
  // as one sub-header line.
  const deedRowH = hBody * 1.2
  const deedRowBotY = tableTopY - deedRowH

  // Sub-header rows: enough lines for the longest multi-line header label.
  let maxHeaderLines = 1
  for (let i = 0; i < singleCols.length; i++) {
    const tokens = String(singleCols[i].label).split('\n')
    if (tokens.length > maxHeaderLines) maxHeaderLines = tokens.length
  }
  const subHeaderRowH = maxHeaderLines * hBody * 1.2
  const subHeaderBotY = deedRowBotY - subHeaderRowH

  // Data rows fill below the headers; each row is rH tall.
  const dataTopY = subHeaderBotY
  const dataBotY = dataTopY - dataRows.length * rH

  // ── DEED merged header text ──
  const deedStartX = colX[3]
  const deedEndX   = colX[4] + columnWidths[4]
  const deedCenter = (deedStartX + deedEndX) / 2
  const deedTextWidth = 'DEED'.length * hBody * DXF_CHAR_WIDTH_RATIO
  // y stays at the legacy position (tableTopY) so the existing test for
  // DEED anchor x continues to pass. The text occupies the top of the row.
  addText(layer, deedCenter - deedTextWidth / 2, tableTopY, 'DEED', hBody, 0, 'BOLD')

  // ── Sub-header tokens (per column, centred horizontally) ──
  for (let i = 0; i < singleCols.length; i++) {
    const tokens = String(singleCols[i].label).split('\n')
    let lineY = deedRowBotY
    for (const tok of tokens) {
      // Horizontally centre each token within its column.
      const tokenW = tok.length * hBody * DXF_CHAR_WIDTH_RATIO
      const tokenAnchor = colX[i] + (columnWidths[i] - tokenW) / 2
      addText(layer, tokenAnchor, lineY, tok, hBody, 0, 'BOLD')
      lineY -= hBody * 1.2
    }
  }

  // ── Data rows: centred text, vertically centred in each row ──
  const cellKeys = singleCols.map(c => c.key)
  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r]
    const rowTopY = dataTopY - r * rH
    // Text baseline vertically centred inside [rowBot, rowTop].
    const baseY = rowTopY - (rH - hBody) / 2 - hBody
    for (let i = 0; i < cellKeys.length; i++) {
      const val = row[cellKeys[i]]
      if (val) {
        const valW = String(val).length * hBody * DXF_CHAR_WIDTH_RATIO
        const valAnchor = colX[i] + Math.max(H_PAD, (columnWidths[i] - valW) / 2)
        addText(layer, valAnchor, baseY, val, hBody)
      }
    }
  }

  // ── Grid lines ──
  // Outer border (top, bottom, left, right).
  addLine(layer, x,         tableTopY, rightEdge, tableTopY)
  addLine(layer, x,         dataBotY,  rightEdge, dataBotY)
  addLine(layer, x,         dataBotY,  x,         tableTopY)
  addLine(layer, rightEdge, dataBotY,  rightEdge, tableTopY)

  // DEED row ↔ sub-header row divider (only across DEED columns,
  // matches PDF drawScheduleOfAreasSingleColumn:10301-10304).
  addLine(layer, deedStartX, deedRowBotY, deedEndX, deedRowBotY)

  // Sub-header row ↔ data divider (full width).
  addLine(layer, x, subHeaderBotY, rightEdge, subHeaderBotY)

  // Between every two adjacent data rows.
  for (let r = 1; r < dataRows.length; r++) {
    const dividerY = dataTopY - r * rH
    addLine(layer, x, dividerY, rightEdge, dividerY)
  }

  // Vertical column dividers between the 6 columns.
  // The DEED|DATE divider (between col 3 and col 4) only starts at the
  // sub-header row, so the merged DEED header spans both sub-columns
  // without a line cutting through it (matches PDF :10287-10292).
  for (let i = 1; i < columnWidths.length; i++) {
    const divX = colX[i]
    if (divX > deedStartX && divX < deedEndX) {
      // Internal divider of the DEED merged header — start at sub-header top.
      addLine(layer, divX, dataBotY, divX, deedRowBotY)
    } else {
      // Regular column divider — full height.
      addLine(layer, divX, dataBotY, divX, tableTopY)
    }
  }

  return dataBotY
}
