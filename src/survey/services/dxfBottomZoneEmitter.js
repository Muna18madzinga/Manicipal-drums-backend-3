/**
 * dxfBottomZoneEmitter — topology placement for the four legacy bottom-zone
 * blocks (Statement, OFD, SG, Beacon Descriptions) plus orchestration with
 * the existing Schedule of Areas emitter. Replaces the fixed-partition
 * bottom-zone layout shipped before sub-project 3-v4.
 *
 * Spec: docs/superpowers/specs/2026-06-05-dxf-bottom-zone-topology-design.md
 *
 * Pure-function module. All DXF emission goes through caller-injected
 * `addText` / `addLine` / `addRect` callbacks. The orchestrator places
 * blocks in PDF order (matching pdfkitGeoPDF.js:calculateBlockPositions
 * at lines 8553-8581): OFD → schedule → beacon → statement → SG.
 */

import { findBlockPosition } from './dxfBlockPlacer.js'
import {
  OUTSIDE_FIGURE_DATA,
  SURVEYOR_GENERAL_BOX,
  edgeDistanceMetres,
  resolveLoSystem,
} from '../../../app-shared/block-definitions.js'

/** PDF point → paper-millimetre conversion. 1 pt = 1/72 inch = 25.4/72 mm. */
const PT_TO_MM_GEN = 25.4 / 72

/**
 * DXF character-width-to-text-height ratio. Matches the STYLE widthFactor
 * settled in sub-project 3-v3 for 1:1 PDF parity at print scale.
 */
const CHAR_WIDTH_RATIO = 0.55

/** Polygon clearance for the placer (paper-mm). Matches dxfScheduleEmitter. */
export const POLYGON_BUFFER_MM = 2.0

/** Block-to-block separation (paper-mm). Matches dxfScheduleEmitter. */
export const BLOCK_SPACING_MM = 3.0

/** Topology + grid step resolution (paper-mm). Matches dxfScheduleEmitter. */
export const SCAN_STEP_MM = 5.0

/**
 * Format a survey date as "Month YYYY" (e.g. "June 2024") for the statement
 * line. Mirrors pdfkitGeoPDF.js:drawSurveyStatement so PDF and DXF render the
 * same string for the same `metadata.date` value. Falls back to the raw input
 * when the date cannot be parsed.
 */
function formatSurveyDate(dateInput) {
  if (!dateInput) return ''
  try {
    const d = new Date(dateInput)
    if (Number.isNaN(d.getTime())) return String(dateInput)
    return `${d.toLocaleString('en-US', { month: 'long' })} ${d.getFullYear()}`
  } catch {
    return String(dateInput)
  }
}

/**
 * Compute size of the Survey Date Statement block.
 *
 * The statement is a stack of up to three lines:
 *   - `Surveyed in <date> by me`               (height: fonts.hBody, gap: rH * 1.5)
 *   - <surveyor name>                          (height: fonts.hSub,  gap: rH)
 *   - `(Land Surveyor, Zim)`                   (height: fonts.hBody, gap: rH * 1.5)
 *
 * Lines emit only when their metadata key is present. The surveyor name
 * and "(Land Surveyor, Zim)" emit together: presence of `metadata.surveyor`
 * implies both rows.
 *
 * Returns {0,0} when no lines would emit → orchestrator skips emission.
 *
 * @param {{date?:string, surveyor?:string}} metadata
 * @param {{hBody:number, hSub:number, rH:number}} fonts — all in ground-metres
 * @returns {{width:number, height:number}}
 */
export function sizeStatement(metadata, fonts) {
  const { hBody, hSub, rH } = fonts
  const lines = []
  if (metadata.date) {
    lines.push({
      text:   `Surveyed in ${formatSurveyDate(metadata.date)} by me`,
      height: hBody,
      gap:    rH * 1.5,
    })
  }
  if (metadata.surveyor) {
    lines.push({ text: metadata.surveyor,       height: hSub,  gap: rH })
    lines.push({ text: '(Land Surveyor, Zim)',  height: hBody, gap: rH * 1.5 })
  }
  if (lines.length === 0) return { width: 0, height: 0 }

  // Sum line heights + gaps between lines (no gap after the last line).
  const height = lines.reduce((s, l, i) => s + l.height + (i < lines.length - 1 ? l.gap : 0), 0)
  // Width = longest line by character count × hBody × CHAR_WIDTH_RATIO.
  const maxChars = Math.max(...lines.map(l => l.text.length))
  const width    = maxChars * hBody * CHAR_WIDTH_RATIO
  return { width, height }
}

/**
 * Compute size of the Outside Figure Data table.
 *
 * Width = sum of OUTSIDE_FIGURE_DATA column widths (PDF points) converted
 * to paper-mm via PT_TO_MM_GEN, then passed through the `mm` callback so
 * the returned value is in ground-metres.
 *
 * Height = header box (headerBoxHeight pt: OFD title + CO-ORDINATES section)
 *        + column-header row (headerHeight pt) + N data rows (ofRowH each).
 *
 * Returns {0,0} when there are no edges → orchestrator skips emission.
 *
 * @param {{edges?:Array}|null|undefined} outsideFigureData
 * @param {{ofTitleH:number, ofRowH:number}} fonts — in ground-metres
 * @param {(x:number)=>number} mm — paper-mm → ground-metre converter
 * @returns {{width:number, height:number}}
 */
export function sizeOFDTable(outsideFigureData, fonts, mm) {
  const edgesCount = outsideFigureData?.edges?.length || 0
  if (edgesCount === 0) return { width: 0, height: 0 }

  const widthMM = OUTSIDE_FIGURE_DATA.columns.reduce((s, col) => s + col.width, 0) * PT_TO_MM_GEN
  const width   = mm(widthMM)
  const height  = mm(OUTSIDE_FIGURE_DATA.headerBoxHeight * PT_TO_MM_GEN)  // title + CO-ORDINATES box
                + mm(OUTSIDE_FIGURE_DATA.headerHeight    * PT_TO_MM_GEN)  // column-header row
                + fonts.ofRowH * edgesCount                              // data rows (ofRowH = pt(rowHeight))
  return { width, height }
}

/**
 * Compute size of the Surveyor-General Approval Box.
 *
 * SURVEYOR_GENERAL_BOX is a constant 200 × 80 PDF points. Returns the
 * ground-metre equivalents via the injected `mm` converter.
 *
 * @param {(x:number)=>number} mm
 * @returns {{width:number, height:number}}
 */
export function sizeSGBox(mm) {
  return {
    width:  mm(SURVEYOR_GENERAL_BOX.width  * PT_TO_MM_GEN),
    height: mm(SURVEYOR_GENERAL_BOX.height * PT_TO_MM_GEN),
  }
}

/**
 * Compute size of the Beacon Descriptions block.
 *
 * Height = 1 title row + 1 row per beacon group, each at fonts.rH * 1.2.
 * (Mirrors the row spacing used by the existing `addBeaconDescription`
 * closure in dxfGenerator.js around line 873.)
 *
 * Width is the intrinsic preferred width = 180 mm; the orchestrator may
 * cap this against the contentArea before topology lookup.
 *
 * Returns {0,0} for empty input → orchestrator skips emission.
 *
 * @param {Array<{points:string,description?:string}>|null|undefined} beaconGroups
 * @param {{rH:number}} fonts
 * @param {(x:number)=>number} mm
 * @returns {{width:number, height:number}}
 */
export function sizeBeaconDescriptions(beaconGroups, fonts, mm) {
  if (!beaconGroups || beaconGroups.length === 0) {
    return { width: 0, height: 0 }
  }
  const lineCount = 1 + beaconGroups.length     // 1 title + 1 per group
  const height    = lineCount * fonts.rH * 1.2
  const width     = mm(180)                     // 180 mm preferred width
  return { width, height }
}

/**
 * Emit the Survey Date Statement at `position` (top-left of its bbox).
 *
 * No-op when neither metadata.date nor metadata.surveyor is set
 * (matches sizeStatement returning {0,0}).
 *
 * Mirrors dxfGenerator.js lines 1692-1703 exactly, parameterized by
 * `position.x` (was statementL) and `position.y` (was cY).
 *
 * @param {(layer:string,x:number,y:number,text:string,h:number,angle?:number,style?:string)=>void} addText
 * @param {{x:number,y:number}} position - top-left (south-up: high y)
 * @param {{date?:string, surveyor?:string}} metadata
 * @param {{hBody:number, hSub:number, rH:number}} fonts
 * @param {string} layer
 */
export function emitStatement(addText, position, metadata, fonts, layer) {
  const { hBody, hSub, rH } = fonts
  let cY = position.y
  if (metadata.date) {
    addText(layer, position.x, cY, `Surveyed in ${formatSurveyDate(metadata.date)} by me`, hBody, 0, undefined)
    cY -= rH * 1.5
  }
  if (metadata.surveyor) {
    addText(layer, position.x, cY, metadata.surveyor, hSub, 0, 'BOLD')
    cY -= rH
    addText(layer, position.x, cY, '(Land Surveyor, Zim)', hBody, 0, undefined)
    cY -= rH * 1.5
  }
}

/**
 * Emit the Surveyor-General Approval Box at `position` (top-left).
 *
 * Mirrors dxfGenerator.js lines 1779-1801. The box rect spans
 * (position.x, position.y - size.height) to (position.x + size.width,
 * position.y). All vertical offsets come from SURVEYOR_GENERAL_BOX
 * via PT_TO_MM_GEN through the `mm` converter.
 *
 * @param {Function} addText
 * @param {(layer:string,x1:number,y1:number,x2:number,y2:number)=>void} addLine
 * @param {(layer:string,x1:number,y1:number,x2:number,y2:number)=>void} addRect
 * @param {{x:number,y:number}} position - top-left (south-up: high y)
 * @param {{width:number,height:number}} size
 * @param {{sgTitleH:number, sgBodyH:number}} fonts
 * @param {(x:number)=>number} mm
 * @param {string} layer
 */
export function emitSGBox(addText, addLine, addRect, position, size, fonts, mm, layer) {
  const SG = SURVEYOR_GENERAL_BOX
  const sgBoxTopY = position.y
  const sgBoxBotY = position.y - size.height
  const sgBoxL    = position.x
  const sgBoxR    = position.x + size.width
  const aCX       = (sgBoxL + sgBoxR) / 2

  const sgTitleY  = sgBoxTopY - mm(SG.titleYOffset         * PT_TO_MM_GEN)
  const sgSigY    = sgBoxTopY - mm(SG.signatureLineYOffset * PT_TO_MM_GEN)
  const sgForY    = sgBoxTopY - mm(SG.forSGYOffset         * PT_TO_MM_GEN)
  const sgDateY   = sgBoxTopY - mm(SG.dateYOffset          * PT_TO_MM_GEN)
  const sgSigInset = mm(SG.signatureLineInset * PT_TO_MM_GEN)

  addRect(layer, sgBoxL, sgBoxBotY, sgBoxR, sgBoxTopY)
  addText(layer, aCX, sgTitleY, 'Approved', fonts.sgTitleH, 0)
  addLine(layer, sgBoxL + sgSigInset, sgSigY, sgBoxR - sgSigInset, sgSigY)
  addText(layer, aCX, sgForY,  'For Surveyor General', fonts.sgBodyH)
  addText(layer, aCX, sgDateY, SG.dateText,            fonts.sgBodyH)
}

/**
 * Emit the Outside Figure Data table at `position` (top-left).
 *
 * Mirrors dxfGenerator.js lines 1715-1773 exactly, parameterized by
 * `position.x` (was statementL) and `position.y` (was cY). Column anchors
 * are computed inside the function from OUTSIDE_FIGURE_DATA.
 *
 * @param {Function} addText
 * @param {Function} addLine
 * @param {{x:number,y:number}} position
 * @param {{edges?:Array}} outsideFigureData
 * @param {{ofTitleH:number, ofBodyH:number, ofRowH:number}} fonts
 * @param {(x:number)=>number} mm
 * @param {string} layer
 */
export function emitOFDTable(addText, addLine, position, outsideFigureData, fonts, mm, layer) {
  const edges = outsideFigureData?.edges || []
  if (edges.length === 0) return

  const { ofTitleH, ofBodyH } = fonts
  const OFD = OUTSIDE_FIGURE_DATA
  const ptG = (p) => mm(p * PT_TO_MM_GEN)   // PDF points → ground-metres

  // Column x-boundaries (ground). x[4] = OFD/CO-ORDINATES divider; x[6] = right edge.
  const x = [position.x]
  for (const col of OFD.columns) x.push(x[x.length - 1] + ptG(col.width))

  const headerBoxH = ptG(OFD.headerBoxHeight)  // 40pt — title + CO-ORDINATES box
  const headerRowH = ptG(OFD.headerHeight)     // 15pt — column-header row
  const dataRowH   = ptG(OFD.rowHeight)        // 12pt — each data row

  const yTop     = position.y
  const yHBbot   = yTop - headerBoxH
  const yCHbot   = yHBbot - headerRowH
  const yRowsBot = yCHbot - dataRowH * edges.length

  // ── Grid borders ──
  addLine(layer, x[0], yTop,   x[6], yTop)      // top of header box
  addLine(layer, x[0], yHBbot, x[6], yHBbot)    // header box ↔ column-header row
  addLine(layer, x[0], yCHbot, x[6], yCHbot)    // column-header row ↔ data rows
  for (let k = 1; k <= edges.length; k++) addLine(layer, x[0], yCHbot - dataRowH * k, x[6], yCHbot - dataRowH * k)
  addLine(layer, x[0], yTop, x[0], yRowsBot)    // left edge (full height)
  addLine(layer, x[4], yTop, x[4], yRowsBot)    // OFD/CO-ORDINATES divider (full height)
  addLine(layer, x[6], yTop, x[6], yRowsBot)    // right edge (full height)
  for (const i of [1, 2, 3, 5]) addLine(layer, x[i], yHBbot, x[i], yRowsBot) // column separators (rows only)

  // Centre `text` within column [xL, xR] (DXF can't query rendered width; use the
  // same 0.55 char ratio the rest of the generator assumes).
  const cText = (xL, xR, yy, text, h, style) => {
    const w = String(text).length * h * 0.55
    addText(layer, xL + ((xR - xL) - w) / 2, yy, String(text), h, 0, style)
  }

  // ── Header box ──
  cText(x[0], x[4], yTop - headerBoxH * 0.5 - ofTitleH * 0.4, 'OUTSIDE FIGURE DATA', ofTitleH, 'BOLD')
  cText(x[4], x[6], yTop - ptG(3)  - ofTitleH, 'CO-ORDINATES', ofTitleH, 'BOLD')
  // Single source of truth shared with the PDF — prefer the loSystem carried in
  // the outside-figure constants, else the SI 727 default (Lo 31).
  const loSystem = resolveLoSystem(outsideFigureData)
  cText(x[4], x[6], yTop - ptG(15) - ofBodyH, `System : ${loSystem}°`, ofBodyH)
  const yYMX = yTop - ptG(28) - ofBodyH
  addText(layer, x[4] + ptG(4), yYMX, 'Y', ofBodyH, 0)
  cText(x[4], x[6], yYMX, 'Metres', ofBodyH)
  addText(layer, x[6] - ptG(4) - ofBodyH * 0.55, yYMX, 'X', ofBodyH, 0)

  // ── Column-header row ──
  const yHdr = yHBbot - headerRowH * 0.5 - ofBodyH * 0.4
  const headers = ['SIDES', 'Metres', 'DIRECTION', 'Constants', '+ 0.00', '+ 0.00']
  for (let i = 0; i < 6; i++) cText(x[i], x[i + 1], yHdr, headers[i], ofBodyH, 'BOLD')

  // ── Data rows ──
  let yr = yCHbot
  for (const edge of edges) {
    const yv = yr - dataRowH * 0.5 - ofBodyH * 0.4
    const distM = edgeDistanceMetres(edge)              // accepts `distance` or `metres`
    const dist = distM != null ? distM.toFixed(2) : ''
    const yV   = typeof edge.y === 'number' ? (edge.y >= 0 ? '+' : '') + edge.y.toFixed(2) : ''
    const xV   = typeof edge.x === 'number' ? (edge.x >= 0 ? '+' : '') + edge.x.toFixed(2) : ''
    const vals = [edge.side || '', dist, edge.direction || '', edge.pointId || '', yV, xV]
    for (let i = 0; i < 6; i++) cText(x[i], x[i + 1], yv, vals[i], ofBodyH)
    yr -= dataRowH
  }
}

/**
 * Emit Beacon Descriptions inside the bbox defined by `position` + `size`.
 *
 * Adapter for the existing closure-based `addBeaconDescription` helper
 * defined in dxfGenerator.js (line 860). Converts the topology-returned
 * top-left + size into the four corners that helper expects:
 *   leftX   = position.x
 *   rightX  = position.x + size.width
 *   topY    = position.y                   (high y in south-up DXF)
 *   bottomY = position.y - size.height
 *
 * No-op when beaconGroups is empty.
 *
 * @param {(layer:string,leftX:number,rightX:number,topY:number,bottomY:number,groups:Array)=>void} addBeaconDescription
 * @param {string} layer
 * @param {{x:number,y:number}} position
 * @param {{width:number,height:number}} size
 * @param {Array} beaconGroups
 */
export function emitBeaconDescriptions(addBeaconDescription, layer, position, size, beaconGroups) {
  if (!beaconGroups || beaconGroups.length === 0) return
  addBeaconDescription(
    layer,
    position.x,
    position.x + size.width,
    position.y,
    position.y - size.height,
    beaconGroups,
  )
}

/**
 * Compute the fallback top-left position for `blockName` when topology
 * returns null. Deterministic per block; corners are picked so two
 * failed placements don't stack on top of each other.
 *
 *   ofd       → bottom-left
 *   beacon    → bottom-left stacked above OFD (reads OFD's height from placedBlocks)
 *   statement → top-left at statementFallbackY
 *   sg        → bottom-right
 *
 * Returns top-left {x, y} in south-up DXF coords (y = top of bbox).
 *
 * @param {string} blockName
 * @param {{width:number,height:number}} size
 * @param {{x:number,y:number,width:number,height:number}} contentArea
 * @param {Array<{name:string,x:number,y:number,width:number,height:number}>} placedBlocks
 * @param {number} statementFallbackY
 * @param {(x:number)=>number} mm
 * @returns {{x:number,y:number}}
 */
export function fallbackCorner(blockName, size, contentArea, placedBlocks, statementFallbackY, mm) {
  const cntL = contentArea.x
  const cntR = contentArea.x + contentArea.width
  const cntB = contentArea.y
  const pad  = mm(3)
  const bot  = mm(5)
  switch (blockName) {
    case 'ofd':
      return { x: cntL + pad, y: cntB + bot + size.height }
    case 'beacon': {
      const ofdEntry = placedBlocks.find(b => b.name === 'ofd')
      const ofdH = ofdEntry ? ofdEntry.height : 0
      const gap  = ofdEntry ? mm(3) : 0
      return { x: cntL + pad, y: cntB + bot + ofdH + gap + size.height }
    }
    case 'statement':
      return { x: cntL + pad, y: statementFallbackY }
    case 'sg':
      return { x: cntR - pad - size.width, y: cntB + bot + size.height }
    default:
      throw new Error(`fallbackCorner: unknown blockName "${blockName}"`)
  }
}

/**
 * Orchestrate topology placement for the four bottom-zone blocks plus
 * the schedule of areas. Places blocks in PDF order to match
 * pdfkitGeoPDF.js:calculateBlockPositions at lines 8553-8581:
 *
 *   1. OFD table
 *   2. Schedule of Areas (delegated to helpers.scheduleEmitter)
 *   3. Beacon Descriptions
 *   4. Survey Date Statement
 *   5. Surveyor-General Approval Box
 *
 * Per block: size → findBlockPosition → fallbackCorner if null → emit
 * → push to placedBlocks. Pre-seeded `obstacles` are honoured by every
 * placement (title zone, north arrow, scale bar).
 *
 * @returns {{
 *   placedBlocks: Array<{name:string,x:number,y:number,width:number,height:number}>,
 *   scheduleResult: object,
 *   southmostY: number,
 * }}
 */
export function placeBottomZoneBlocks({
  contentArea,
  polygon,
  obstacles,
  statementFallbackY,
  surveyedFeatures,
  outsideFigureData,
  beaconGroups,
  metadata,
  sheetSize,
  fonts,
  helpers,
  layer,
  addText, addLine, addRect,
  warn, logger,
}) {
  const { mm, addBeaconDescription, scheduleEmitter } = helpers
  const placedBlocks = [...(obstacles || [])]

  const place = (name, size, emitFn) => {
    if (size.width === 0 || size.height === 0) return null
    const pos = findBlockPosition({
      block:         size,
      mapBounds:     contentArea,
      polygon,
      placedBlocks,
      buffer:        mm(POLYGON_BUFFER_MM),
      blockSpacing:  mm(BLOCK_SPACING_MM),
      scanStep:      mm(SCAN_STEP_MM),
      tableMinWidth: size.width,
      logger,
    })
    let finalPos = pos
    if (finalPos === null) {
      warn(`${name}Overflow`, {
        blockName:   name,
        blockSize:   size,
        contentArea: { width: contentArea.width, height: contentArea.height },
        obstacles:   placedBlocks.length,
        hint:        `${name} block fell back to a deterministic corner; may overlap parcel figure or other blocks.`,
      })
      finalPos = fallbackCorner(name, size, contentArea, placedBlocks, statementFallbackY, mm)
    }
    emitFn(finalPos)
    placedBlocks.push({ name, x: finalPos.x, y: finalPos.y, width: size.width, height: size.height })
    return finalPos
  }

  // 1. OFD
  const ofdSize = sizeOFDTable(outsideFigureData, fonts, mm)
  place('ofd', ofdSize, (pos) =>
    emitOFDTable(addText, addLine, pos, outsideFigureData, fonts, mm, layer))

  // 2. Schedule of Areas — delegate to existing emitter with seedPlacedBlocks.
  const scheduleResult = scheduleEmitter({
    surveyedFeatures,
    drawingZone:      contentArea,
    polygon,
    sheetSize,
    fonts,
    helpers,
    addText, addLine, warn, logger,
    seedPlacedBlocks: placedBlocks,
  })
  for (const t of scheduleResult.placedTables || []) {
    placedBlocks.push({ name: 'schedule', x: t.x, y: t.y, width: t.width, height: t.height })
  }

  // 3. Beacon Descriptions
  const beaconSize = sizeBeaconDescriptions(beaconGroups, fonts, mm)
  place('beacon', beaconSize, (pos) =>
    emitBeaconDescriptions(addBeaconDescription, layer, pos, beaconSize, beaconGroups))

  // 4. Statement
  const statementSize = sizeStatement(metadata, fonts)
  place('statement', statementSize, (pos) =>
    emitStatement(addText, pos, metadata, fonts, layer))

  // 5. SG Box
  const sgSize = sizeSGBox(mm)
  place('sg', sgSize, (pos) =>
    emitSGBox(addText, addLine, addRect, pos, sgSize, fonts, mm, layer))

  return {
    placedBlocks,
    scheduleResult,
    southmostY: scheduleResult.southmostY,
  }
}
