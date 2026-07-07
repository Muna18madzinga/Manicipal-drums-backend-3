/**
 * DXF Generator for Survey Plans â€” R12 (AC1009) format
 * Mirrors the PDF labeling system: scale-aware text heights, shared-edge
 * topology (distance one side / bearing the other), stand labels rotated to
 * longest edge, BOLD text style for stand numbers.
 *
 * Compatible with AutoCAD R12 through AutoCAD 2026+.
 * All geometry in Cape Lo ground coordinates (real-world metres).
 *
 * Layers:
 *   OUTSIDE_FIGURE   â€“ Outside figure boundary (red)
 *   PARCELS           â€“ Land parcel boundaries (white/black)
 *   BEACONS           â€“ Beacon circles (green)
 *   BEACON_LABELS     â€“ Beacon name text (green)
 *   DISTANCES         â€“ Edge distance annotations (cyan)
 *   DIRECTIONS        â€“ Edge bearing annotations (magenta)
 *   STAND_NUMBERS     â€“ Parcel stand numbers (yellow, BOLD style)
 *   TITLE_BLOCK       â€“ Title and metadata text (white)
 */

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

import {
  TITLE_BLOCK,
  SCHEDULE_OF_AREAS,
  OUTSIDE_FIGURE_DATA,
  SURVEYOR_GENERAL_BOX,
  formatStandRanges,
  computeScheduleColumnWidths,
  edgeDistanceMetres,
  classifyBeaconGroups,
  snapScaleBarSegment,
  resolveLoSystem,
} from '../../../app-shared/block-definitions.js'
import { SHEET_ORDER, MAX_SHEET_UP_ATTEMPTS, nextSheetUp } from '../../../app-shared/sheetEscalation.js';

/** Conversion factor: 1 PDF point = 0.352778 mm. block-definitions values
 *  are in PDF pts (matching the PDF generator's native unit); the DXF
 *  generator works in paper-mm so it converts at the boundary.
 */
const PT_TO_MM_GEN = 25.4 / 72
import { findStandLabelPosition, findEdgeLabelPosition } from './dxfLabelPlacer.js'
import {
  placeSuffixLabelPOIDirected,
  tryTightFullBeaconLabelPosition,
  calculateFullBeaconLabelOutsideOnEdge,
  pickBeaconFontSize,
  computeBeaconRadius,
  groupSplayBeacons,
  orderSplayGroupByAngle,
  createCollisionRegistry,
} from './dxfBeaconPlacer.js'
import {
  extractScheduleRow,
  computeScheduleLayout,
  addScheduleTable,
  nextLargerSheet,
  SCHEDULE_HEADER_HEIGHT_MM,
} from './dxfScheduleHelpers.js'
import { emitScheduleOfAreasTopological } from './dxfScheduleEmitter.js'
import { getOutsideFigureVertices } from './outsideFigureBeacons.js'
import {
  emitOFDTable,
  emitBeaconDescriptions,
  emitStatement,
  emitSGBox,
} from './dxfBottomZoneEmitter.js'
import { planSheetLayout } from './sheetLayoutPlanner.js'
import { buildPolygonForPlanner, buildPlannerObstacles } from './polygonForPlanner.js'
import { buildScheduleMeasurer } from './scheduleMeasurer.js'
import { rectangleOverlapsPolygon } from './dxfGeometry.js'
import { findBlockPosition } from './dxfBlockPlacer.js'
import { selectFigureScale } from '../utils/si727Constants.js'
import { balanceScheduleTables, shouldAdoptResplit } from './scheduleStrategy.js'
import { roundBearingSouth } from '../utils/zim-geo.js'

// Re-export schedule helpers extracted to dxfScheduleHelpers.js during 3-v2.
// External consumers (tests, other modules) keep importing from dxfGenerator.js.
export {
  extractScheduleRow,
  computeScheduleLayout,
  addScheduleTable,
  nextLargerSheet,
} from './dxfScheduleHelpers.js'

/**
 * Word-boundary wrap for single-line DXF TEXT entities.
 * Splits `str` into chunks no longer than `maxChars` characters, never
 * breaking inside a word. Single tokens longer than `maxChars` are emitted
 * as their own line (no truncation, no hyphenation). Returns [] for empty
 * input; never produces empty entries.
 */
export function splitToWidth(str, maxChars) {
  if (!str) return []
  const tokens = String(str).split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []
  const lines = []
  let current = ''
  for (const tok of tokens) {
    if (current === '') {
      current = tok
      continue
    }
    if (current.length + 1 + tok.length <= maxChars) {
      current += ' ' + tok
    } else {
      lines.push(current)
      current = tok
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

/**
 * Returns `["SHEET N"]` when sheetInfo indicates a multi-sheet plan
 * (totalSheets > 1) with a positive integer sheetNumber. Returns [] for
 * any other input shape. No warning on malformed input â€” the absent label
 * is itself visible to the surveyor in CAD.
 */
export function formatSheetLabel(sheetInfo) {
  if (!sheetInfo || typeof sheetInfo !== 'object') return []
  const { sheetNumber, totalSheets } = sheetInfo
  if (typeof totalSheets !== 'number' || totalSheets <= 1) return []
  if (!Number.isInteger(sheetNumber) || sheetNumber <= 0) return []
  return [`SHEET ${sheetNumber}`]
}

/**
 * Returns the SI 727 Seventh Schedule (b) Vide template from
 * `app-shared/block-definitions.js`, wrapped via `splitToWidth` to fit
 * `maxLineChars`. Always returns at least one entry. Throws if the
 * template is missing from the shared module (configuration bug â€”
 * the PDF would fail the same way).
 */
export function formatVideLine(maxLineChars) {
  const template = TITLE_BLOCK?.vide?.template
  if (!template) throw new Error('TITLE_BLOCK.vide.template missing from app-shared/block-definitions.js')
  return splitToWidth(template, maxLineChars)
}

/**
 * Title-case helper: "lot 9 of borrowdale" â†’ "Lot 9 Of Borrowdale".
 * Matches the PDF's `toTitleCase` style for figure-description substitutions.
 */
function titleCase(str) {
  return String(str || '').replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
}

/**
 * Builds the SI 727 Seventh Schedule (b) figure-description sentence
 * from the figureDescription template in `app-shared/block-definitions.js`,
 * wrapped to `maxLineChars`. Returns [] when there is no outside-figure
 * sequence to describe or no surveyed parcels to count.
 *
 * Placeholder substitutions and missing-field fallbacks are documented in
 * the spec (2026-06-01-dxf-title-block-si727-design.md, Components).
 *
 * Note: single-sheet template only. The multi-sheet variant
 * (`figureDescription.multiSheetTemplate`) is owned by sub-project #6
 * (multi-sheet tiling).
 */
export function formatFigureDescription(metadata, outsideFigureData, surveyedParcels, maxLineChars) {
  const template = TITLE_BLOCK?.figureDescription?.template
  if (!template) throw new Error('TITLE_BLOCK.figureDescription.template missing from app-shared/block-definitions.js')

  const edges = outsideFigureData?.edges
  if (!Array.isArray(edges) || edges.length === 0) return []
  if (!Array.isArray(surveyedParcels) || surveyedParcels.length === 0) return []

  // Beacon sequence comes from the SHARED extractor (outsideFigureBeacons.js),
  // the exact same function the PDF uses — so the closed, dot-joined sequence is
  // byte-identical to the PDF's on every project (real or fixture).
  const beaconSequence = getOutsideFigureVertices(outsideFigureData, null).sequence
  if (!beaconSequence) return []

  const township = titleCase(metadata?.township) || 'the township'
  const district = titleCase(metadata?.district) || 'the district'
  const parentProperty = titleCase(metadata?.parentProperty)
  const wholePortion = (metadata?.wholePortion || '').trim() || 'the whole'
  const ofTarget = parentProperty ? `${township} of ${parentProperty}` : township

  const standNames = surveyedParcels.map(sp => String(sp?.stand ?? '')).filter(Boolean)
  if (standNames.length === 0) return []
  const standCount = standNames.length

  const sentence = template
    .replace('{beaconSequence}', beaconSequence)
    .replace('{standCount}',     String(standCount))
    .replace('{wholePortion}',   wholePortion)
    .replace('{ofTarget}',       ofTarget)
    .replace('{district}',       district)

  return splitToWidth(sentence, maxLineChars)
}

/**
 * Build the SI 727 designation headline that sits beneath the "GENERAL PLAN / of"
 * heading — e.g. "Stands 1213, 1686 - 1737 MAGLAS TOWNSHIP".
 *
 * Derived exactly like the PDF title block (drawTitleBlock) so the two stay in
 * lockstep: the stand range comes from the surveyed parcels, and the township
 * description is `surveyOf`/`township` with any leading "Stands X - Y" prefix and
 * any trailing " of <parent property>" suffix stripped. The parent-property suffix
 * deliberately appears only in the figure-description sentence, not this headline.
 * Case is preserved as stored (the PDF doesn't force-case this line). Falls back to
 * `surveyOf`/`designation` (suffix-stripped) when the parts are unavailable, and
 * returns '' when there is nothing to render.
 */
export function formatPlanDesignation(metadata, surveyedParcels) {
  const standNames = Array.isArray(surveyedParcels)
    ? surveyedParcels.map(sp => String(sp?.stand ?? '')).filter(Boolean)
    : []
  const standRange = formatStandRanges(standNames)
  const rawSurveyOf = (metadata?.surveyOf || metadata?.township || '').trim()
  const townshipDesc = rawSurveyOf
    .replace(/^Stands?\s+[\d,\s\-–]+/i, '')
    .replace(/\s+of\s+.+$/i, '')
    .trim()
  if (standRange && townshipDesc) return `Stands ${standRange} ${townshipDesc}`
  const fallback = (metadata?.surveyOf || metadata?.designation || '').trim()
  return fallback.replace(/\s+of\s+.+$/i, '').trim()
}

function normalizeCapeLoYX(y, x) {
  if (!Number.isFinite(y) || !Number.isFinite(x)) return [y, x];
  const ay = Math.abs(y);
  const ax = Math.abs(x);
  if ((ay > 1000000 && ax < 1000000) || ay > ax * 2) return [x, y];
  return [y, x];
}

/**
 * Convert Cape Lo (Y = Westing, X = Southing) to DXF coordinates with
 * **north-up east-right** orientation — matching the PDF view.
 *
 *   DXF.x = -capeY  (negate westing → easting; east increases to the right)
 *   DXF.y = -capeX  (negate southing → northing; north increases upward)
 *
 * Renamed-in-place: the function still ends in "SouthUp" for historical
 * compatibility with imports across tests/fixtures/docs, but the behavior
 * was flipped on 2026-06-05 after the user noticed the DXF and PDF plots
 * had opposite orientations. The negation is a 180° rotation of the
 * previous south-up west-right output. Text-label angles compensate via
 * the existing `if (ang > 90 || ang < -90) ang += 180` normalization
 * downstream, so labels remain right-side-up.
 */
export function capeLoToDxfSouthUp(capeY, capeX) {
  const [y, x] = normalizeCapeLoYX(capeY, capeX);
  return { x: -y, y: -x };
}

/** Shoelace centroid in AutoCAD space from an array of AutoCAD {x,y} points */
function shoelaceCentroid(pts) {
  let twiceArea = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
    const cross = p0.x * p1.y - p1.x * p0.y;
    twiceArea += cross;
    cx += (p0.x + p1.x) * cross;
    cy += (p0.y + p1.y) * cross;
  }
  if (Math.abs(twiceArea) > 1e-6) {
    return { x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) };
  }
  // Fallback: simple average
  let sx = 0, sy = 0;
  pts.forEach((q) => { sx += q.x; sy += q.y; });
  return { x: sx / pts.length, y: sy / pts.length };
}

/**
 * Walk outsideFigureData.edges and return the ordered vertex list around the
 * outside-figure boundary, with a closing duplicate appended so callers can
 * pair vertices[i] with vertices[i+1] for edge geometry without index-modulo
 * wraparound.
 *
 * Each edge in edges[] carries the START vertex of that edge as { pointId, y, x }.
 * Non-finite vertices (NaN / Infinity / |coord| > 1e7 plausibility bound) are
 * filtered out and counted via skippedCount so the caller can bump
 * warnings.summary.outsideFigureVertices.
 *
 * @param {Object|null} outsideFigureData  May be null/undefined; empty .edges OK.
 * @returns {{ vertices: Array<{y:number,x:number,pointId:string}>, skippedCount: number }}
 *   vertices: ordered around the boundary, with closing duplicate.
 *   skippedCount: how many edges had non-finite vertex coords.
 */
export function computeOutsideFigureVertices(outsideFigureData) {
  const edges = outsideFigureData?.edges
  if (!Array.isArray(edges) || edges.length === 0) {
    return { vertices: [], skippedCount: 0 }
  }
  const vertices = []
  let skippedCount = 0
  for (let idx = 0; idx < edges.length; idx++) {
    const e = edges[idx]
    if (!Number.isFinite(e.y) || !Number.isFinite(e.x)
        || Math.abs(e.y) > 1e7 || Math.abs(e.x) > 1e7) {
      skippedCount++
      continue
    }
    // edgeIndex preserves the original position in outsideFigureData.edges so
    // consumers can detect "bridged" polygon edges (i.e. consecutive kept
    // vertices whose original indices aren't adjacent â€” indicating a filtered
    // vertex in between) and fall back to geometry rather than reading stale
    // distance/direction metadata from the wrong original edge.
    vertices.push({ y: e.y, x: e.x, pointId: e.pointId || '', edgeIndex: idx })
  }
  // Append closing duplicate (first valid vertex) so consumers can iterate
  // vertices[i] / vertices[i+1] without wraparound.
  if (vertices.length > 0) {
    vertices.push({ ...vertices[0] })
  }
  return { vertices, skippedCount }
}

/** Polygon area from AutoCAD {x,y} points (shoelace, absolute) */
function polygonAreaGround(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y;
    a -= pts[j].x * pts[i].y;
  }
  return Math.abs(a / 2);
}

function degToDMS(deg) {
  let d = Math.floor(deg);
  const rm = (deg - d) * 60;
  let m = Math.floor(rm);
  let s = Math.round((rm - m) * 60);
  // Carry normalization: Math.round on the seconds (and float error in
  // (deg - d) * 60) can yield 60 — e.g. 161°09'56" rounded to the nearest 10"
  // surfaces as 161°09'60" instead of 161°10'00". Carry seconds → minutes →
  // degrees so the label always reads canonically. Mirrors edge-computation.js.
  if (s >= 60) { s -= 60; m += 1; }
  if (m >= 60) { m -= 60; d += 1; }
  if (d >= 360) { d -= 360; }
  // Use the degree symbol (°) — identical to the PDF's edge-label formatter
  // (pdfkitLabeling.js:441). The literal "d" separator ("179d18'15\"") is not
  // SI 727 compliant. The post-emission pass converts ° → the DXF control code
  // "%%d", which every CAD viewer renders as a true degree symbol.
  return `${d}°${String(m).padStart(2, '0')}'${String(s).padStart(2, '0')}"`;
}

/**
 * Formats a south-oriented bearing as DMS, applying the SI 727 seconds
 * resolution rule (matches edge-computation.js / the PDF): edges shorter than
 * 6000 m are given to the nearest 10", longer edges to the nearest second.
 * Used only on the fallback path; a pre-computed edge.directionDMS already
 * carries this rounding.
 */
export function degToDMSForDistance(bearDeg, distance) {
  const secRes = (Number.isFinite(distance) && distance < 6000) ? 10 : 1;
  return degToDMS(roundBearingSouth(bearDeg, secRes));
}

/** Shared-edge key: sorted, rounded to 10mm â€” matches PDF's createEdgeKey */
function createEdgeKey(c1, c2) {
  const y1 = Math.round(c1[0] * 100) / 100;
  const x1 = Math.round(c1[1] * 100) / 100;
  const y2 = Math.round(c2[0] * 100) / 100;
  const x2 = Math.round(c2[1] * 100) / 100;
  const pts = [[y1, x1], [y2, x2]].sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);
  return `${pts[0][0]},${pts[0][1]}_${pts[1][0]},${pts[1][1]}`;
}

/** Point-in-polygon test (ray casting) for AutoCAD {x,y} points */
function isPointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Minimum distance from point (px,py) to any edge of polygon [{x,y}...] */
function minDistToPolygon(px, py, polygon) {
  let minD = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    const ax = polygon[i].x, ay = polygon[i].y;
    const bx = polygon[j].x, by = polygon[j].y;
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-12) { // degenerate edge
      const d = Math.sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay));
      if (d < minD) minD = d;
      continue;
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    const d = Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
    if (d < minD) minD = d;
  }
  return minD;
}

/** Check if point is inside polygon OR within buffer distance of its boundary */
function isWithinPolygonBuffer(px, py, polygon, buffer) {
  if (isPointInPolygon(px, py, polygon)) return true;
  return minDistToPolygon(px, py, polygon) <= buffer;
}

/**
 * Parse a scale denominator from any of the shapes the caller may pass:
 *   - object  { value: 500, label: '1:500' }   (what the PDF route/front-end sends)
 *   - string  '1:500' or '500'
 *   - number  500
 * Returns null when nothing usable is present, so the caller can auto-fit.
 *
 * NOTE: the previous implementation did `String(scaleStr)` on the object and
 * matched "[object Object]" → no match → silently defaulted to 1:2500, which
 * hard-wired every DXF to 1:2500 regardless of the chosen scale.
 */
function parseScaleDenom(scale) {
  if (scale == null) return null;
  if (typeof scale === 'number') return Number.isFinite(scale) ? scale : null;
  if (typeof scale === 'object') {
    if (Number.isFinite(scale.value)) return Number(scale.value);
    scale = scale.label;
  }
  const m = String(scale).match(/1\s*:\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  const n = parseInt(String(scale), 10);
  return Number.isFinite(n) ? n : null;
}

/** ISO paper sizes in mm (landscape orientation: width > height) */
const PAPER_SIZES = {
  'ISO_A4': { w: 297, h: 210 },
  'ISO_A3': { w: 420, h: 297 },
  'ISO_A2': { w: 594, h: 420 },
  'ISO_A1': { w: 841, h: 594 },
  'ISO_A0': { w: 1189, h: 841 },
};

// SHEET_LADDER, SCHEDULE_HEADER_HEIGHT_MM, nextLargerSheet, extractScheduleRow,
// computeScheduleLayout, addScheduleTable: extracted to dxfScheduleHelpers.js
// during sub-project 3-v2. Re-exported above so external consumers still work.


/** Convert PDF point size to ground metres at given scale */
function ptToGround(pt, S) { return pt * S * 0.000352778; }

/** Convert paper mm to ground metres at given scale */
function mmToGround(mm, S) { return mm * S / 1000; }

// â”€â”€ DXF R12 primitives â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function p(code, value) {
  return String(code).padStart(3) + '\n' + value + '\n';
}

// â”€â”€ Main generator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function generateDXF(options, logger) {
  // Warnings accumulator. Mutated by guards inside the emitters; returned
  // alongside the Buffer so the route can surface counts to the surveyor.
  const warnings = {
    count: 0,
    summary: {
      beacons: 0,
      parcels: 0,
      outsideFigureVertices: 0,
      scaleFallback: false,
      beaconDescTruncated: 0,
      priorDiagramsTruncated: 0,
      nonAscii: false,
      scheduleOverflow: null,
    },
  }
  /**
   * Records a warning of a given category. Three category families exist:
   *   booleans   â€” 'scaleFallback', 'nonAscii' (sets summary[category] to true)
   *   structured â€” any category ending in 'Overflow' (stores `value` as
   *                the payload object). Pre-3-v4 only 'scheduleOverflow'
   *                was structured; 3-v4 added ofd/beacon/statement/sg.
   *   counters   â€” everything else (adds `value` to summary[category])
   * `warnings.count` increments by 1 for booleans + structured, by `value`
   * for counters.
   */
  function warn(category, value = 1) {
    if (category === 'scaleFallback' || category === 'nonAscii') {
      warnings.summary[category] = true
      warnings.count += 1
      return
    }
    if (typeof category === 'string' &&
        (category.endsWith('Overflow') ||
         category === 'scheduleEscalationExhausted' ||
         category.endsWith('OverlapsPolygon') ||
         category.endsWith('OverlapsSchedule'))) {
      warnings.summary[category] = value
      warnings.count += 1
      return
    }
    warnings.summary[category] = (warnings.summary[category] || 0) + value
    warnings.count += value
  }

  const {
    parcels,
    beacons,
    outsideFigureData,
    metadata = {},
    projection = 'Cape Lo',
    scale,
    sheetSize = 'ISO_A2',
    // Page orientation. Shared from the PDF (PDF↔DXF parity): the PDF decides
    // scale + sheet size + orientation and the DXF consumes them verbatim.
    // 'landscape' (default) = width > height; 'portrait' swaps the paper dims.
    orientation = 'landscape',
    sheetInfo = null,
    // SI 727 plan type. 'general-developed' suppresses parcel-edge distance +
    // direction labels (matches pdfkitLabeling.js:386,456 — developed township
    // general plans omit internal stand edge labels; per-stand survey diagrams
    // carry that detail instead). Outside-figure edge labels are unaffected.
    planType = null,
    // UI-supplied beacon label decisions. Same shape as PDF's `beaconLabels`:
    // [{ beaconName, text, isInsideParcel, displayInParcel, labelType }].
    // labelType 'suffix' / 'full' / 'suppressed'. When present, drives display
    // text + inside/outside placement (matches pdfkitGeoPDF.js:4654-4733). When
    // absent, falls back to pattern matching: `^(\d+)([A-Z]+)$` → prefix=stand,
    // suffix=letter; if a parcel has matching stand, show suffix inside, else
    // show full name outside.
    beaconLabels = null,
  } = options;
  const isDevelopedPlan = planType === 'general-developed';

  const declaredS = parseScaleDenom(scale);
  // Normalize sheetSize input: accept both 'ISO_A0' (underscore, canonical) and
  // 'ISO A0' (space, used in some legacy logs/headers from si727Constants.code).
  // Without this, an 'ISO A0' input misses PAPER_SIZES and falls back to A2.
  const normalizedSheetSize = typeof sheetSize === 'string'
    ? sheetSize.replace(/\s+/g, '_')
    : sheetSize;
  const _basePaper = PAPER_SIZES[normalizedSheetSize] || PAPER_SIZES['ISO_A2'];
  // Honor the shared orientation (from the PDF). PAPER_SIZES are stored
  // landscape (w > h); a 'portrait' request swaps the dimensions.
  const paper = orientation === 'portrait'
    ? { w: _basePaper.h, h: _basePaper.w }
    : _basePaper;

  // â”€â”€ Pre-scan drawing extent (outside figure + parcels ONLY, not unfiltered beacons) â”€â”€
  // Beacons are excluded because pre-filtering they span a huge area (e.g. 268 beacons).
  // Filtered beacons (within OF + 5m buffer) will all be inside the outside figure extent.
  let extMinX = Infinity, extMinY = Infinity, extMaxX = -Infinity, extMaxY = -Infinity;
  function trackExt(pt) {
    if (pt.x < extMinX) extMinX = pt.x;
    if (pt.y < extMinY) extMinY = pt.y;
    if (pt.x > extMaxX) extMaxX = pt.x;
    if (pt.y > extMaxY) extMaxY = pt.y;
  }
  // Outside figure edges define the primary extent
  if (outsideFigureData?.edges) {
    for (const e of outsideFigureData.edges) { trackExt(capeLoToDxfSouthUp(e.y, e.x)); }
  }
  // Also include non-outside-figure parcels (they should be inside OF, but just in case)
  if (parcels?.features) {
    for (const f of parcels.features) {
      const st = f.properties?.stand || '';
      if (f.properties?.isOutsideFigure || st.toLowerCase().includes('outside figure')) continue;
      const coords = f.geometry?.coordinates?.[0];
      if (!coords) continue;
      for (const c of coords) { trackExt(capeLoToDxfSouthUp(c[0], c[1])); }
    }
  }
  // Add 5m buffer for beacons that sit just outside the figure
  const extBuffer = 10; // metres
  extMinX -= extBuffer; extMinY -= extBuffer;
  extMaxX += extBuffer; extMaxY += extBuffer;
  const drawW = (extMaxX - extMinX) || 100;
  const drawH = (extMaxY - extMinY) || 100;

  // â”€â”€ SI 727 scale selection: ENLARGE the figure to the largest prescribed
  //    scale (smallest denominator) whose drawing still fits the sheet's
  //    drawing area, so the figure dominates the plan like a real General Plan.
  //    A declared scale is honoured only when it also fits; otherwise we enlarge
  //    (declared too small) or shrink (declared overflows) to the best fit.
  //
  //    Available drawing area (paper-mm): content area (SI 727 margins: 50 left,
  //    150 right for SG endorsements, 50 top/bottom) minus a reserve for the
  //    schedule/co-ordinate column (right) and the title strip (top).
  // Scale selection. PARITY: when a scale is supplied (the PDF shares its chosen
  // scale with the DXF), honor it VERBATIM so the two render in lockstep. Only
  // when NO scale is supplied do we auto-maximize the figure to the largest SI
  // 727 prescribed scale that fits the sheet (uses the same shared helper the
  // PDF uses for its own selection).
  const _figFit = selectFigureScale({
    drawWidthM: drawW,
    drawHeightM: drawH,
    paperWmm: paper.w,
    paperHmm: paper.h,
  });
  // SI 727 Reg 32(3) scale precedence (fallback when no PDF scale is handed off):
  //   1. declaredS — a supplied scale (PDF handoff) honored verbatim → parity.
  //   2. DEVELOPED township GP — mandated at EXACTLY 1:500 (no edge labels;
  //      tiles if the figure is too big to fit at 1:500).
  //   3. Everything else (UNDEVELOPED township GP + unconstrained) — auto-
  //      maximize to the largest SI 727 scale that fits. Undeveloped has no
  //      fixed scale; the largest fitting figure gives the most room for stand
  //      numbers, beacon labels and edge distances/directions to stay legible.
  let S;
  if (declaredS) {
    S = declaredS;
  } else if (planType === 'general-developed') {
    S = 500;
  } else {
    S = _figFit.S;
  }
  const { minScaleToFit, fitScale } = _figFit;

  logger.info(`[DXF] Drawing extent: ${drawW.toFixed(1)}m x ${drawH.toFixed(1)}m`);
  logger.info(`[DXF] SI 727 scale: 1:${S} (declared: ${declaredS ? '1:' + declaredS : 'none'}, minToFit: 1:${Math.ceil(minScaleToFit)}, fit: 1:${fitScale}, sheet ${normalizedSheetSize} ${paper.w}x${paper.h}mm)`);

  // â”€â”€ Scale-aware sizes (matching pdfkitLabeling.js) â”€â”€
  let distPt, bearPt;
  if (S <= 500)       { distPt = 7; bearPt = 7; }
  else if (S <= 1000) { distPt = 7; bearPt = 7; }
  else if (S <= 2000) { distPt = 8; bearPt = 7; }
  else                { distPt = 9; bearPt = 8; }

  const distHeight = ptToGround(distPt, S);
  const bearHeight = ptToGround(bearPt, S);
  const edgeOffset = mmToGround(3, S);
  const pairGap = ptToGround(0.6, S);
  // PDF-parity sizing (#6 Task 6.2). Replaces fixed pt(1.5)/pt(6)/pt(1)+radius
  // with scale-aware values matching pdfkitGeoPDF.js:renderBeacons:4629-4636
  // (logarithmic radius, 1.8-3.0 pt clamp) and :4800-4807 (font tier switch).
  const beaconFontSizePt  = pickBeaconFontSize(S);
  const beaconLabelHeight = ptToGround(beaconFontSizePt, S);     // ground-metres
  const beaconRadiusMM    = computeBeaconRadius(S);              // paper-mm
  const beaconRadius      = mmToGround(beaconRadiusMM, S);       // ground-metres
  const beaconLabelOffset = beaconRadius + mmToGround(1, S);     // legacy fallback offset (used when all placers fail)

  logger.info(`[DXF] Sizes at 1:${S}: dist=${distHeight.toFixed(3)}m, bear=${bearHeight.toFixed(3)}m, offset=${edgeOffset.toFixed(3)}m, beaconR=${beaconRadius.toFixed(3)}m`);

  // ACI colors: 1=red, 2=yellow, 3=green, 4=cyan, 5=blue, 6=magenta, 7=white
  const layers = [
    { name: 'OUTSIDE_FIGURE',  color: 1 },
    { name: 'PARCELS',         color: 7 },
    { name: 'BEACONS',         color: 3 },
    { name: 'BEACON_LABELS',   color: 3 },
    { name: 'DISTANCES',       color: 4 },
    { name: 'DIRECTIONS',      color: 6 },
    { name: 'STAND_NUMBERS',   color: 2 },
    { name: 'TITLE_BLOCK',     color: 7 },
    { name: 'NORTH_ARROW',     color: 7 },
    { name: 'SCALE_BAR',       color: 7 },
    { name: 'GRID',            color: 8 },
    { name: 'MARGIN_GUIDES',   color: 8 },
    { name: 'OUTSIDE_FIGURE_LABELS', color: 8 },
  ];

  // Track extents
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function trackPt(pt) {
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
    minX = Math.min(minX, pt.x); minY = Math.min(minY, pt.y);
    maxX = Math.max(maxX, pt.x); maxY = Math.max(maxY, pt.y);
  }

  // â”€â”€ Build entities â”€â”€
  let ent = '';

  function addPolyline(layer, points) {
    ent += p(0, 'POLYLINE');
    ent += p(8, layer);
    ent += p(66, '1');
    ent += p(70, '1');
    for (const pt of points) {
      ent += p(0, 'VERTEX');
      ent += p(8, layer);
      ent += p(10, pt.x.toFixed(4));
      ent += p(20, pt.y.toFixed(4));
    }
    ent += p(0, 'SEQEND');
    ent += p(8, layer);
  }

  /**
   * Draw a CLOSED polygon boundary as individual LINE edges, each TRIMMED by
   * `trimR` (ground-metres) at BOTH endpoints. Cadastral polygon corners are
   * beacons, so the trim leaves a clean gap around each beacon's open circle
   * (the SI 727 convention) instead of running the boundary through the symbol.
   * Edges shorter than 2·trimR are skipped (corner-to-corner spacing too tight).
   */
  function addTrimmedPolygon(layer, points, trimR) {
    if (!Array.isArray(points) || points.length < 2) return;
    const a0 = points[0], aN = points[points.length - 1];
    const isClosed = Math.abs(a0.x - aN.x) < 1e-6 && Math.abs(a0.y - aN.y) < 1e-6;
    const verts = isClosed ? points.slice(0, -1) : points;
    const m = verts.length;
    for (let i = 0; i < m; i++) {
      const a = verts[i];
      const b = verts[(i + 1) % m]; // wrap closes the ring
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (!(len > 2 * trimR)) continue;
      const ux = dx / len, uy = dy / len;
      addLine(layer, a.x + ux * trimR, a.y + uy * trimR, b.x - ux * trimR, b.y - uy * trimR);
    }
  }

  function addCircle(layer, cx, cy, r) {
    ent += p(0, 'CIRCLE');
    ent += p(8, layer);
    ent += p(10, cx.toFixed(4));
    ent += p(20, cy.toFixed(4));
    ent += p(40, r.toFixed(4));
  }

  function addText(layer, x, y, text, height, rotation, style) {
    ent += p(0, 'TEXT');
    ent += p(8, layer);
    ent += p(10, x.toFixed(4));
    ent += p(20, y.toFixed(4));
    ent += p(40, height.toFixed(4));
    ent += p(1, text);
    if (rotation && rotation !== 0) {
      ent += p(50, rotation.toFixed(4));
    }
    // Per-entity width factor (matches STYLE_WIDTH_FACTOR). The STYLE table also
    // declares it, but many viewers honour only the entity's own 41 (default 1.0)
    // — without this, text renders ~1.8× too wide and overruns its layout slot.
    ent += p(41, '0.55');
    if (style) {
      ent += p(7, style);
    }
  }

  // Horizontally-centred TEXT: centres on `xc` via DXF justification code 72 = 1
  // (Center). When 72 ≠ 0 the alignment point is read from codes 11/21, so we set
  // both 10/20 and 11/21 to (xc, y) for reader compatibility. Used by the title
  // heading block so it reads as a centred column, matching the PDF.
  function addTextC(layer, xc, y, text, height, style) {
    ent += p(0, 'TEXT');
    ent += p(8, layer);
    ent += p(10, xc.toFixed(4));
    ent += p(20, y.toFixed(4));
    ent += p(40, height.toFixed(4));
    ent += p(1, text);
    ent += p(41, '0.55');   // per-entity width factor (matches STYLE_WIDTH_FACTOR)
    ent += p(72, 1);
    ent += p(11, xc.toFixed(4));
    ent += p(21, y.toFixed(4));
    if (style) {
      ent += p(7, style);
    }
  }

  function addLine(layer, x1, y1, x2, y2) {
    ent += p(0, 'LINE');
    ent += p(8, layer);
    ent += p(10, x1.toFixed(4));
    ent += p(20, y1.toFixed(4));
    ent += p(11, x2.toFixed(4));
    ent += p(21, y2.toFixed(4));
  }

  /**
   * Draw a beacon symbol: a PLAIN OPEN CIRCLE for every beacon, matching the
   * SI 727 General Plan convention (stand-corner beacons shown as clean open
   * circles). The `type` argument is retained for call-site compatibility but no
   * longer changes the symbol — the previous placed/found differentiation
   * (8 radial "fill" lines / a crossing `+`) cluttered the plan with asterisk-
   * like marks. If a placed/found distinction is needed it should be carried via
   * layer or colour, not by busying up the symbol.
   */
  function addBeaconSymbol(layer, cx, cy, type, sizeM) {
    const r = sizeM / 2
    addCircle(layer, cx, cy, r)
  }

  /**
   * Draw a north-pointing arrow. After the 2026-06-05 orientation flip,
   * +DXF-Y is north (we negate Cape Lo X / southing), so the apex at +Y
   * correctly points up = north.
   * Three LINEs form the arrowhead triangle; one TEXT entity reads "S" above the apex.
   * sizeM is the arrowhead height in ground metres at the chosen scale.
   */
  // Filled triangle (DXF SOLID). SOLID fills its quad in 1-2-4-3 order, so a
  // triangle (apex, baseL, baseR) is passed with the 4th vertex equal to the 3rd.
  function addSolidTri(layer, ax, ay, bx, by, cx2, cy2) {
    ent += p(0, 'SOLID')
    ent += p(8, layer)
    ent += p(10, ax.toFixed(4)); ent += p(20, ay.toFixed(4))
    ent += p(11, bx.toFixed(4)); ent += p(21, by.toFixed(4))
    ent += p(12, cx2.toFixed(4)); ent += p(22, cy2.toFixed(4))
    ent += p(13, cx2.toFixed(4)); ent += p(23, cy2.toFixed(4))
  }

  /**
   * Compass-rose North arrow matching the PDF (drawNorthArrow): eight triangular
   * points (N & S filled main points, E/W + diagonals open), a white centre
   * circle, double N–S axis lines, and a "TN" (true north) label below the south
   * tip. Sized in paper-mm so it is scale-independent; `cx, cy` is the rose centre
   * (DXF y-up, so North points +y). The `sizeM` argument is retained for call-site
   * compatibility but no longer drives the (now fixed paper-mm) geometry.
   */
  function addNorthArrow(layer, cx, cy, _sizeM) {
    const mainLen = mm(12.5)  // PDF mainLength 35pt
    const sideLen = mm(8.8)   // PDF sideLength 25pt
    const innerR  = mm(2.8)   // PDF innerRadius 8pt
    const lineOff = mm(0.55)  // PDF lineOffset 1.5pt
    const points = [
      { a: 0,   len: mainLen, fill: true,  bw: mm(1.1) }, // N
      { a: 45,  len: sideLen, fill: false, bw: mm(0.9) }, // NE
      { a: 90,  len: sideLen, fill: false, bw: mm(0.9) }, // E
      { a: 135, len: sideLen, fill: false, bw: mm(0.9) }, // SE
      { a: 180, len: mainLen, fill: true,  bw: mm(1.1) }, // S
      { a: 225, len: sideLen, fill: false, bw: mm(0.9) }, // SW
      { a: 270, len: sideLen, fill: false, bw: mm(0.9) }, // W
      { a: 315, len: sideLen, fill: false, bw: mm(0.9) }, // NW
    ]
    for (const pt of points) {
      const t = (pt.a * Math.PI) / 180
      const s = Math.sin(t), c = Math.cos(t)        // dir = (s, c): a=0 → North (+y)
      const ox = cx + s * pt.len, oy = cy + c * pt.len  // outer tip
      const lx = cx + c * pt.bw,  ly = cy - s * pt.bw   // base, perpendicular +
      const rx = cx - c * pt.bw,  ry = cy + s * pt.bw   // base, perpendicular −
      addLine(layer, ox, oy, lx, ly)
      addLine(layer, lx, ly, rx, ry)
      addLine(layer, rx, ry, ox, oy)
      if (pt.fill) addSolidTri(layer, ox, oy, lx, ly, rx, ry)
    }
    // White centre hub
    addCircle(layer, cx, cy, innerR)
    // Double lines along the N–S axis (hub edge → main tip)
    addLine(layer, cx - lineOff, cy + innerR, cx - lineOff, cy + mainLen)
    addLine(layer, cx + lineOff, cy + innerR, cx + lineOff, cy + mainLen)
    addLine(layer, cx - lineOff, cy - innerR, cx - lineOff, cy - mainLen)
    addLine(layer, cx + lineOff, cy - innerR, cx + lineOff, cy - mainLen)
    // "TN" (true north) label below the south tip
    addTextC(layer, cx, cy - mainLen - mm(6), 'TN', mm(3.5), 'BOLD')
  }

  /**
   * Graduated horizontal scale bar — equal round-number segments graduated
   * 0, L, 2L, 3L (e.g. "0  5  10  15  METRES"), ported from the PDF's drawScaleBar
   * so the two formats read identically. The segment length is ~40 mm of paper at
   * the plan scale, snapped to a nice cartographic number via the shared
   * snapScaleBarSegment(). The bar is reduced segment-by-segment if it would spill
   * past its planner slot (maxWidthGround), so it never overruns the schedule.
   */
  function addScaleBar(layer, cx, cy, scaleDenom, maxWidthGround) {
    const rawSegmentMeters = 0.04 * scaleDenom   // 40 mm of paper at 1:scaleDenom
    const segmentLength = snapScaleBarSegment(rawSegmentMeters)
    let numSegments = 3
    // Reserve room for the " METRES" label on the right. The bar is centred in
    // the slot, so reserve it on both sides to keep label + bar inside the slot.
    const metresReserve = mm(8)
    if (maxWidthGround && maxWidthGround > 0) {
      while (numSegments > 1 && segmentLength * numSegments + 2 * metresReserve > maxWidthGround) numSegments--
    }
    const barWidthGround = segmentLength * numSegments
    const halfW = barWidthGround / 2
    const halfH = mm(2)
    const left = cx - halfW
    // Outer rectangle (2 horizontal LINEs) + centreline
    addLine(layer, left, cy + halfH, left + barWidthGround, cy + halfH)
    addLine(layer, left, cy - halfH, left + barWidthGround, cy - halfH)
    addLine(layer, left, cy, left + barWidthGround, cy)
    // Vertical graduation ticks at 0, L, 2L … with round-number labels below.
    for (let i = 0; i <= numSegments; i++) {
      const x = left + i * segmentLength
      addLine(layer, x, cy - halfH, x, cy + halfH)
      addText(layer, x, cy - halfH - mm(3), String(i * segmentLength), mm(2), 0)
    }
    // "METRES" unit label beside the right end of the bar.
    addText(layer, left + barWidthGround + mm(3), cy - halfH - mm(3), 'METRES', mm(2), 0)
    // "SCALE 1:<denom>" footer, centred under the bar.
    addText(layer, cx, cy - halfH - mm(8), `SCALE 1:${scaleDenom}`, mm(2.5), 0)
  }

  /**
   * Geodetic corner reference crosses — ports the PDF's
   * renderOutsideFigureTickMarks. Instead of scattering short single ticks along
   * the axis-aligned bounding box (which float in the margins when the figure is
   * plotted diagonally to the Cape Lo grid), draw a clean "+" at each of the
   * figure's four coordinate corners (NW/NE/SW/SE) with its Cape Lo Y (westing)
   * and X (southing) labelled — the SI 727 coordinate-frame convention.
   *
   * Coordinate mapping is DXF (x, y) = (−capeY, −capeX) (capeLoToDxfSouthUp), so
   * westing = −x and southing = −y. Returns the crosses' reserved bounds
   * (min-corner ground rects) so the block-placement pass keeps clear of them.
   *
   * (areaL, areaR, areaB, areaT) are the drawing-area (content rectangle) bounds
   * in DXF ground coords. When supplied, each corner that would snap OUTWARD past
   * the drawing area — pushing the cross + its label into the margin — is stepped
   * INWARD by one grid interval until its footprint fits, porting the PDF's
   * renderOutsideFigureTickMarks map-edge clamp (pdfkitGeoPDF.js:1903-1982).
   * Stepping by the grid interval keeps every label a clean round coordinate.
   */
  function addCornerCrosses(layer, drawL, drawR, drawT, drawB, areaL, areaR, areaB, areaT) {
    const arm  = mm(4);     // cross-arm half length
    const lblH = mm(2.5);   // label text height
    const off  = mm(1.5);   // label gap from the arm tip
    // Snap the four corners OUTWARD to a round coordinate grid so every cross
    // label is a clean multiple of 50 m (or 100 m for large figures) — the SI 727
    // coordinate convention. drawL/B are the min corners (floor/out), drawR/T the
    // max corners (ceil/out); labels = −coord, so they stay multiples too.
    const G = Math.max(drawR - drawL, drawT - drawB) > 1000 ? 100 : 50;
    let xL = Math.floor(drawL / G) * G, xR = Math.ceil(drawR / G) * G;
    let yB = Math.floor(drawB / G) * G, yT = Math.ceil(drawT / G) * G;
    // Inward clamp (PDF parity). Footprint extents of a cross centred at (cx, cy):
    //   left  = cx − arm − mm(2)            right = cx + arm + off + mm(24)  (X= label)
    //   bottom = cy − arm − mm(2)            top  = cy + arm + off + lblH + mm(2)  (Y= label)
    // Step each shared grid line inward by G until that footprint sits inside the
    // drawing area. Guarded so a too-small area can't loop forever or cross over.
    if ([areaL, areaR, areaB, areaT].every(Number.isFinite)) {
      const padR = arm + off + mm(24);          // X= label runs right
      const padTop = arm + off + lblH + mm(2);  // Y= label runs up
      const padMin = arm + mm(2);               // bare arm on the other two sides
      let g;
      for (g = 0; yT + padTop > areaT && yT - G > areaB && g < 1000; g++) yT -= G;
      for (g = 0; yB - padMin < areaB && yB + G < areaT && g < 1000; g++) yB += G;
      for (g = 0; xL - padMin < areaL && xL + G < areaR && g < 1000; g++) xL += G;
      for (g = 0; xR + padR > areaR && xR - G > areaL && g < 1000; g++) xR -= G;
    }
    const corners = [
      { x: xL, y: yT }, { x: xR, y: yT },
      { x: xL, y: yB }, { x: xR, y: yB },
    ];
    const bounds = [];
    for (const c of corners) {
      addLine(layer, c.x - arm, c.y, c.x + arm, c.y);   // horizontal arm
      addLine(layer, c.x, c.y - arm, c.x, c.y + arm);   // vertical arm
      // Westing (Y) above the vertical arm; Southing (X) right of the horizontal arm.
      addText(layer, c.x - arm, c.y + arm + off, `Y=${Math.round(-c.x)}`, lblH, 0);
      addText(layer, c.x + arm + off, c.y - lblH / 2, `X=${Math.round(-c.y)}`, lblH, 0);
      // Reserve a band covering the cross + both labels (X= runs right; Y= runs up).
      bounds.push({
        x:      c.x - arm - mm(2),
        y:      c.y - arm - mm(2),
        width:  2 * arm + off + mm(26),          // room for the X= southing string
        height: 2 * arm + off + lblH + mm(2),    // room for the Y= westing string
      });
    }
    return bounds;
  }

  /**
   * Drafting-table convention: short tick marks at each content-area corner +
   * tiny crop-mark crosses at each page corner.
   */
  function addMarginGuides(layer, pageL, pageR, pageT, pageB, cntL, cntR, cntT, cntB) {
    const tick = mm(5)
    const crop = mm(3)
    // Content-area corner ticks (2 LINEs per corner, one X-axis one Y-axis)
    const corners = [
      { x: cntL, y: cntT, dx: tick, dy: -tick },   // top-left
      { x: cntR, y: cntT, dx: -tick, dy: -tick },  // top-right
      { x: cntL, y: cntB, dx: tick, dy: tick },    // bottom-left
      { x: cntR, y: cntB, dx: -tick, dy: tick },   // bottom-right
    ]
    for (const c of corners) {
      addLine(layer, c.x, c.y, c.x + c.dx, c.y)
      addLine(layer, c.x, c.y, c.x, c.y + c.dy)
    }
    // Page-corner crop-mark crosses (2 LINEs per corner)
    const pageCorners = [
      { x: pageL, y: pageT }, { x: pageR, y: pageT },
      { x: pageL, y: pageB }, { x: pageR, y: pageB },
    ]
    for (const c of pageCorners) {
      addLine(layer, c.x - crop, c.y, c.x + crop, c.y)
      addLine(layer, c.x, c.y - crop, c.x, c.y + crop)
    }
  }

  function addRect(layer, x1, y1, x2, y2) {
    addLine(layer, x1, y1, x2, y1); // bottom
    addLine(layer, x2, y1, x2, y2); // right
    addLine(layer, x2, y2, x1, y2); // top
    addLine(layer, x1, y2, x1, y1); // left
  }

  /**
   * Beacon descriptions table â€” one row per beaconGroups[] entry.
   * Truncates with "+ N more â€” see PDF" if rows would overflow zoneBottom.
   */
  function addBeaconDescription(layer, zoneL, zoneR, zoneTop, zoneBottom, beaconGroups) {
    if (!Array.isArray(beaconGroups) || beaconGroups.length === 0) return
    const headerH = mm(4)
    const rowH = mm(3.5)
    let y = zoneTop
    addText(layer, zoneL, y, 'BEACON DESCRIPTION', headerH, 0, 'BOLD')   // singular — matches PDF
    // Separator LINE — sits just below the header text (DXF text grows UP from the
    // baseline). It must clear the first row below it: the previous mm(1) gap put
    // the line inside the first row's mm(2.4)-tall text, cutting across it. Hug the
    // header instead and keep the first row where it was (total height unchanged).
    y -= mm(2)
    addLine(layer, zoneL, y, zoneR, y)
    y -= headerH * 1.4 - mm(1)
    let printed = 0
    for (const g of beaconGroups) {
      if (y - rowH < zoneBottom) break
      const text = `${g.points} : ${g.description || ''}`
      addText(layer, zoneL, y, text, mm(2.4), 0)
      y -= rowH
      printed++
    }
    const remaining = beaconGroups.length - printed
    if (remaining > 0) {
      if (y - rowH < zoneBottom) y = zoneBottom + rowH    // squeeze in the footer
      addText(layer, zoneL, y, `+ ${remaining} more â€” see PDF for full list`, mm(2.2), 0)
      warn('beaconDescTruncated', remaining)
    }
  }

  /**
   * Full endorsement zone in the right-margin column. Five sub-blocks,
   * top to bottom:
   *   1. APPROVED FOR LODGEMENT header + Date / Surveyor-General / Reference lines
   *   2. Dispensation Certificate slot
   *   3. Plan number stamp box (RECT 30 Ã— 15 mm)
   *   4. Prior diagram references (list or "None")
   *   5. Surveyor certification footer
   */
  function drawEndorsementZone(tableL, tableR, tableTop, tableBottom) {
    // NOTE: mm() and pt() are not yet defined at helper-definition time; they
    // are only called at call-time (after S is set), so this is safe.
    //
    // Mirrors the PDF drawEndorsementBlock. The table fills the right-margin
    // strip: horizontally from the drawing-area right margin (tableL) out to the
    // paper edge (tableR), and vertically from the top margin (tableTop) to the
    // bottom margin (tableBottom). Layout top→bottom:
    //   ── line ──  ENDORSEMENTS (centred)  ── line ──
    //   No. | STATEMENT | Date | Surveyor-General      ── line ──
    //   1.  | Dispensation … relates to this General Plan | … | …   (tall entry)
    //   ── line ── (bottom margin)
    // (The "Approved / For Surveyor General" signature box is a separate block.)
    const tableW  = tableR - tableL
    const titleH  = mm(8)
    const headerH = mm(7)

    const yTitleTop = tableTop                 // top margin
    const yTitleBot = tableTop - titleH        // line below the ENDORSEMENTS title
    const yHdrBot   = yTitleBot - headerH       // line below the column headers
    const yBottom   = tableBottom              // bottom margin

    // Columns (PDF proportions): No. fixed, STATEMENT 50%, Date 20%, SG the rest.
    const colNo   = mm(9)
    const colStmt = tableW * 0.5
    const colDate = tableW * 0.2
    const xNoR    = tableL + colNo
    const xStmtR  = xNoR + colStmt
    const xDateR  = xStmtR + colDate

    // Horizontal rules — flush with the drawing-area right margin, out to the
    // media edge. Top/bottom rules sit on the top/bottom margins.
    addLine(TB, tableL, yTitleTop, tableR, yTitleTop)
    addLine(TB, tableL, yTitleBot, tableR, yTitleBot)
    addLine(TB, tableL, yHdrBot,   tableR, yHdrBot)
    addLine(TB, tableL, yBottom,   tableR, yBottom)

    // ENDORSEMENTS — centred across the table, between the top two rules
    addTextC(TB, (tableL + tableR) / 2, yTitleBot + (titleH - mm(3.2)) / 2, 'ENDORSEMENTS', mm(3.2), 'BOLD')

    // Column headers — vertically centred in the header band
    const yHdr = yHdrBot + (headerH - mm(2.4)) / 2
    addTextC(TB, (tableL + xNoR) / 2,   yHdr, 'No.', mm(2.4))
    addText (TB, xNoR + mm(2),          yHdr, 'STATEMENT', mm(2.4), 0)
    addTextC(TB, (xStmtR + xDateR) / 2, yHdr, 'Date', mm(2.4))
    addTextC(TB, (xDateR + tableR) / 2, yHdr, 'Surveyor-General', mm(2.2))

    // Internal column separators — header band + entry row only (not the title band)
    for (const x of [xNoR, xStmtR, xDateR]) addLine(TB, x, yTitleBot, x, yBottom)

    // Entry row 1: "1." + Dispensation Certificate statement, top-aligned
    let yE = yHdrBot - mm(5)
    addTextC(TB, (tableL + xNoR) / 2, yE, '1.', mm(2.4))
    // Wrap to the STATEMENT column INTERIOR: subtract the mm(2) left + mm(2) right
    // text padding, and use a conservative char ratio so no line overruns into the
    // Date column.
    const stmtChars = Math.max(8, Math.floor((colStmt - mm(4)) / (mm(2.4) * 0.6)))
    for (const line of splitToWidth('Dispensation Certificate No. .................. relates to this General Plan', stmtChars)) {
      addText(TB, xNoR + mm(2), yE, line, mm(2.4), 0)
      yE -= mm(4)
    }
  }

  // â”€â”€ 1. Outside Figure boundary â”€â”€
  let ofPolygon = null; // AutoCAD coords for beacon filtering
  let ofResult = null; // Will store vertex data for annotation (computed below)
  if (outsideFigureData?.edges?.length > 0) {
    const ofPts = outsideFigureData.edges.map((e) => {
      const pt = capeLoToDxfSouthUp(e.y, e.x); trackPt(pt); return pt;
    });
    addTrimmedPolygon('OUTSIDE_FIGURE', ofPts, beaconRadius);
    ofPolygon = ofPts; // save for beacon filtering
    logger.info(`[DXF] Outside Figure: ${ofPts.length} vertices`);

    // Compute vertex data for later annotation (after mm is defined)
    ofResult = computeOutsideFigureVertices(outsideFigureData);
    if (ofResult.skippedCount > 0) {
      warn('outsideFigureVertices', ofResult.skippedCount);
    }
  }

  // â”€â”€ 2. Identify shared edges (topology â€” same as PDF) â”€â”€
  const edgeOccurrences = new Map();
  if (parcels?.features) {
    for (const feature of parcels.features) {
      const coords = feature.geometry?.coordinates?.[0];
      if (!coords) continue;
      for (let i = 0; i < coords.length - 1; i++) {
        const key = createEdgeKey(coords[i], coords[i + 1]);
        edgeOccurrences.set(key, (edgeOccurrences.get(key) || 0) + 1);
      }
    }
  }
  const sharedEdges = new Set();
  edgeOccurrences.forEach((count, key) => { if (count > 1) sharedEdges.add(key); });
  const labeledEdges = new Map(); // edgeKey â†’ { distance: bool, bearing: bool }
  logger.info(`[DXF] Shared edges detected: ${sharedEdges.size}`);

  // â”€â”€ 3. Parcels + stand numbers + edge labels â”€â”€
  let parcelCount = 0, edgeLabelCount = 0;
  if (parcels?.features) {
    for (const feature of parcels.features) {
      const props = feature.properties || {};
      const stand = props.stand || '';
      if (props.isOutsideFigure || stand.toLowerCase().includes('outside figure')) continue;
      const coords = feature.geometry?.coordinates?.[0];
      if (!coords) continue;

      // Guard: skip parcel with fewer than 3 finite vertices
      const rawVerts = coords;
      const finiteVerts = rawVerts.filter(([yy, xx]) =>
        Number.isFinite(yy) && Number.isFinite(xx));
      if (finiteVerts.length !== rawVerts.length || finiteVerts.length < 3) {
        logger.warn(`[DXF] dropped parcel ${stand || '<unnamed>'}: missing or non-finite vertices (${finiteVerts.length}/${rawVerts.length} finite)`)
        warn('parcels')
        continue
      }

      // Build AutoCAD polygon (unique vertices, no closing duplicate)
      const polyPts = coords.slice(0, -1).map((c) => {
        const pt = capeLoToDxfSouthUp(c[0], c[1]); trackPt(pt); return pt;
      });
      addTrimmedPolygon('PARCELS', polyPts, beaconRadius);
      parcelCount++;

      // â”€â”€ Stand label: shoelace centroid + 4d's iterative font-shrink â”€â”€
      const centroid = shoelaceCentroid(polyPts);
      const area = polygonAreaGround(polyPts);

      // Adaptive stand font size â€” area-bucketed initial value (matches existing behavior).
      // 4d's findStandLabelPosition may shrink this further if the rendered string
      // doesn't fit the parcel's allowable bounds.
      let standPt;
      if (area > 10000) standPt = 16;
      else if (area > 2000) standPt = 14;
      else if (area > 500) standPt = 12;
      else if (area > 100) standPt = 10;
      else standPt = 8;
      // Cartographic hierarchy: a stand number is a feature label and must not
      // out-rank the 5 mm designation title. Cap at 10 pt (~3.5 mm); the parcel
      // fitter (findStandLabelPosition) may shrink it further to fit.
      standPt = Math.min(standPt, 10);
      const standHeight = ptToGround(standPt, S);

      // Find longest edge angle (matches PDF's renderDeferredStandLabels)
      let longestLen = 0, longestAngle = 0;
      for (let i = 0; i < polyPts.length; i++) {
        const j = (i + 1) % polyPts.length;
        const dx = polyPts[j].x - polyPts[i].x;
        const dy = polyPts[j].y - polyPts[i].y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > longestLen) {
          longestLen = len;
          longestAngle = Math.atan2(dy, dx) * (180 / Math.PI);
        }
      }
      if (longestAngle > 90) longestAngle -= 180;
      if (longestAngle < -90) longestAngle += 180;

      // 4d: smart stand-label position. Falls back to centroid if placer returns null
      // (degenerate polygon â€” same as the existing Number.isFinite guard below).
      const standPos = findStandLabelPosition({
        polygon: polyPts, standNumber: String(stand), fontHeight: standHeight,
      });
      if (standPos && Number.isFinite(standPos.x) && Number.isFinite(standPos.y)) {
        addText('STAND_NUMBERS', standPos.x, standPos.y, String(stand), standPos.fontHeight, longestAngle, 'BOLD');
      } else if (Number.isFinite(centroid.x) && Number.isFinite(centroid.y)) {
        // Fallback: existing inline behavior. Matches pre-4d output for degenerate polygons.
        addText('STAND_NUMBERS', centroid.x, centroid.y, String(stand), standHeight, longestAngle, 'BOLD');
      }

      // â”€â”€ Edge labels with shared-edge topology â”€â”€
      // Most callers don't pre-compute props.edges; derive distance + South-
      // oriented bearing from successive vertex pairs as a fallback so the
      // DISTANCES / DIRECTIONS layers populate even when the GeoJSON omits
      // edges. South-oriented whole-circle bearing convention: 0Â° = +Southing
      // (south), 90Â° = +Westing (west), normalised to [0, 360).
      let edges = props.edges || [];
      if (edges.length === 0 && coords.length > 1) {
        edges = [];
        for (let i = 0; i < coords.length - 1; i++) {
          const a = coords[i], b = coords[i + 1];
          const dY = b[0] - a[0];   // Westing delta
          const dX = b[1] - a[1];   // Southing delta
          const distance = Math.sqrt(dY * dY + dX * dX);
          let bearing = Math.atan2(dY, dX) * (180 / Math.PI);
          bearing = ((bearing % 360) + 360) % 360;
          edges.push({ distance, bearing });
        }
      }
      for (let i = 0; i < edges.length && i < coords.length - 1; i++) {
        const edge = edges[i];
        if (!edge) continue;

        const edgeKey = createEdgeKey(coords[i], coords[i + 1]);
        const isShared = sharedEdges.has(edgeKey);
        const edgeInfo = labeledEdges.get(edgeKey);

        // Determine label mode (matches PDF's renderEdgeLabels logic)
        let labelMode = 'both';
        if (edgeInfo) {
          if (edgeInfo.distance && edgeInfo.bearing) continue; // fully labeled
          else if (edgeInfo.distance && !edgeInfo.bearing) labelMode = 'bearing-only';
          else if (!edgeInfo.distance && edgeInfo.bearing) labelMode = 'distance-only';
        } else if (isShared) {
          labelMode = 'distance-only'; // first parcel gets distance, second gets bearing
        }

        const a = capeLoToDxfSouthUp(coords[i][0], coords[i][1]);
        const b = capeLoToDxfSouthUp(coords[i + 1][0], coords[i + 1][1]);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.01) continue;

        // Edge angle (keep text readable)
        let ang = Math.atan2(dy, dx) * (180 / Math.PI);
        if (ang > 90 || ang < -90) ang += 180;

        // Perpendicular toward centroid (existing â€” kept as fallback when placer returns null)
        let nx = -dy / len, ny = dx / len;
        if (nx * (centroid.x - mx) + ny * (centroid.y - my) < 0) { nx = -nx; ny = -ny; }

        // Distance text
        const distVal = edge.distanceRounded ?? edge.distance;
        const distNum = typeof distVal === 'number' ? distVal : parseFloat(distVal);
        const distText = Number.isFinite(distNum) ? distNum.toFixed(2) : null;

        // Direction text
        const bearDeg = typeof edge.bearing === 'number' ? edge.bearing
          : typeof edge.bearingDeg === 'number' ? edge.bearingDeg
          : parseFloat(edge.bearing);
        const dirText = Number.isFinite(bearDeg) ? (edge.directionDMS || degToDMSForDistance(bearDeg, distNum)) : null;

        // 4d: smart edge-label position for the distance label (the bearing label,
        // if any, is positioned at a further offset along the same perpendicular
        // direction). Char-width approximation for label-width estimate matches
        // sub-project #2's splitToWidth convention.
        const distLabelWidth = distText ? distText.length * distHeight * 0.55 : distHeight * 4;
        const smartPos = findEdgeLabelPosition({
          edgeStart: a, edgeEnd: b, polygon: polyPts,
          labelHeight: distHeight, labelWidth: distLabelWidth, angle: ang,
        });

        // Derive distance-label position + implied offset for stacking the bearing
        const distX = smartPos?.x ?? (mx + nx * edgeOffset);
        const distY = smartPos?.y ?? (my + ny * edgeOffset);
        // Implied offset = distance from edge midpoint to chosen position.
        // Falls back to the existing fixed edgeOffset when the placer returned null.
        const impliedOffset = smartPos
          ? Math.sqrt((distX - mx) * (distX - mx) + (distY - my) * (distY - my))
          : edgeOffset;

        // Developed Township General Plan: suppress parcel-edge distance + direction
        // labels (per-stand survey diagrams carry that detail). Still record the edge
        // in labeledEdges so shared-edge topology decisions for any non-developed edges
        // remain consistent. Outside-figure edge labels are emitted on a separate path
        // (addOutsideFigureEdgeLabels at the figure-emission site) and are NOT affected.
        if (isDevelopedPlan) {
          if (!edgeInfo) {
            labeledEdges.set(edgeKey, { distance: false, bearing: false });
          }
          continue;
        }

        if (labelMode === 'both' || labelMode === 'distance-only') {
          if (distText) {
            addText('DISTANCES', distX, distY, distText, distHeight, ang);
            edgeLabelCount++;
          }
          // Register this edge
          if (!edgeInfo) {
            labeledEdges.set(edgeKey, { distance: true, bearing: false });
          } else {
            edgeInfo.distance = true;
          }
          // For non-shared 'both': place bearing stacked further out along the same perpendicular
          if (labelMode === 'both' && dirText) {
            const bearOff = impliedOffset + distHeight / 2 + pairGap + bearHeight / 2;
            addText('DIRECTIONS', mx + nx * bearOff, my + ny * bearOff, dirText, bearHeight, ang);
            edgeLabelCount++;
            const stored = labeledEdges.get(edgeKey);
            if (stored) stored.bearing = true;
          }
        }

        if (labelMode === 'bearing-only' && dirText) {
          // Shared edge: bearing uses the smart position too (single label, not stacked)
          addText('DIRECTIONS', distX, distY, dirText, bearHeight, ang);
          edgeLabelCount++;
          if (edgeInfo) edgeInfo.bearing = true;
        }
      }
    }
  }
  logger.info(`[DXF] Parcels: ${parcelCount}, Edge labels: ${edgeLabelCount}`);

  // ── 4. Beacons (filtered to outside figure + 2m buffer) ──
  const BEACON_BUFFER = 2; // metres
  let beaconCount = 0, beaconsSkipped = 0;

  // Pre-compute parcel lookup maps for beacon-label placement (matches PDF's
  // beaconLabelMap + parcel lookup at pdfkitGeoPDF.js:4779-4783, 4881-4884).
  // parcelByStand: stand-string → polygon in DXF coords. Used to find the parcel
  //   whose stand matches a beacon name's numeric prefix (e.g. "2475A" → "2475").
  // parcelById: numeric id → polygon in DXF coords. Used when the UI supplies an
  //   explicit `displayInParcel` parcel id.
  const parcelByStand = new Map();
  const parcelById = new Map();
  if (parcels?.features) {
    for (const feature of parcels.features) {
      const props = feature.properties || {};
      if (props.isOutsideFigure) continue;
      const coords = feature.geometry?.coordinates?.[0];
      if (!Array.isArray(coords) || coords.length < 4) continue;
      const poly = coords.slice(0, -1)
        .map(c => capeLoToDxfSouthUp(c[0], c[1]))
        .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (poly.length < 3) continue;
      const standKey = String(props.stand ?? '');
      if (standKey) parcelByStand.set(standKey, poly);
      const idKey = props.id ?? feature.id;
      if (idKey != null) parcelById.set(String(idKey), poly);
    }
  }

  // UI-supplied label map (when provided). One entry per beacon name.
  const beaconLabelMap = new Map();
  if (Array.isArray(beaconLabels)) {
    for (const lbl of beaconLabels) {
      if (lbl && lbl.beaconName) beaconLabelMap.set(lbl.beaconName, lbl);
    }
  }

  // Helper: decide displayLabel + which parcel polygon to use for inside
  // placement. Returns null when the label should be suppressed.
  // Position computation is the placer's job — done downstream in the beacon
  // emission loop using the dxfBeaconPlacer module (#6 Task 6.3).
  const labelDecision = (beaconName) => {
    if (!beaconName) return null;

    // PRIORITY 1: UI-supplied label.
    const uiLabel = beaconLabelMap.get(beaconName);
    if (uiLabel) {
      if (uiLabel.labelType === 'suppressed') return null;
      const text = String(uiLabel.text || '');
      if (!text) return null;
      if (uiLabel.isInsideParcel && uiLabel.displayInParcel != null) {
        const polygon = parcelById.get(String(uiLabel.displayInParcel));
        if (polygon) return { text, isInsideParcel: true, polygon };
      }
      return { text, isInsideParcel: false, polygon: null };
    }

    // PRIORITY 2: pattern-matched fallback (matches PDF:4855-4951).
    const m = beaconName.match(/^(\d+)([A-Za-z]+)$/);
    if (m) {
      const polygon = parcelByStand.get(m[1]);
      if (polygon) return { text: m[2].toUpperCase(), isInsideParcel: true, polygon };
    }
    return { text: beaconName, isInsideParcel: false, polygon: null };
  };

  /**
   * Walk splay components via BFS, order each by angle, return a flat list
   * of beacon features in emission order. Solo beacons (not in any splay
   * group) appear in their original input order. (#6 Task 6.5)
   */
  function computeBeaconIterationOrder(features, beaconPositions, splayMap) {
    const beaconsByName = new Map(features.map(f => {
      const n = f.properties?.pointId || f.properties?.name || f.properties?.beacon_name;
      return [n, f];
    }));
    const emitted = new Set();
    const order = [];
    for (const f of features) {
      const name = f.properties?.pointId || f.properties?.name || f.properties?.beacon_name;
      if (!name || emitted.has(name)) continue;
      const neighbors = splayMap.get(name);
      if (!neighbors || neighbors.length === 0) {
        order.push(f);
        emitted.add(name);
        continue;
      }
      const component = new Set([name]);
      const queue = [name];
      while (queue.length) {
        const cur = queue.shift();
        for (const n of (splayMap.get(cur) || [])) {
          if (!component.has(n.name)) { component.add(n.name); queue.push(n.name); }
        }
      }
      const members = [...component].map(n => ({ name: n, pos: beaconPositions.get(n) }));
      for (const m of orderSplayGroupByAngle(members)) {
        const feat = beaconsByName.get(m.name);
        if (feat) order.push(feat);
        emitted.add(m.name);
      }
    }
    return order;
  }

  // ── Pre-loop setup (#6 Task 6.4) ───────────────────────────────────────────
  const beaconPositions = new Map();
  if (beacons?.features) {
    for (const f of beacons.features) {
      const rc = f.geometry?.coordinates;
      if (!Array.isArray(rc) || rc.length < 2) continue;
      const [byRaw, bxRaw] = rc;
      if (!Number.isFinite(byRaw) || !Number.isFinite(bxRaw)
          || Math.abs(byRaw) > 1e7 || Math.abs(bxRaw) > 1e7) continue;
      const pt = capeLoToDxfSouthUp(rc[0], rc[1]);
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
      const name = f.properties?.pointId || f.properties?.name || f.properties?.beacon_name;
      if (name) beaconPositions.set(name, pt);
    }
  }

  // For each beacon, find the parcel polygons whose vertex matches the beacon.
  const incidentParcelsByBeacon = new Map();
  for (const [name, pt] of beaconPositions) {
    const inc = [];
    if (parcels?.features) {
      for (const f of parcels.features) {
        if (f.properties?.isOutsideFigure) continue;
        const coords = f.geometry?.coordinates?.[0];
        if (!Array.isArray(coords) || coords.length < 4) continue;
        const poly = coords.slice(0, -1).map(c => capeLoToDxfSouthUp(c[0], c[1]));
        if (poly.some(p => Math.abs(p.x - pt.x) < 0.01 && Math.abs(p.y - pt.y) < 0.01)) {
          inc.push(poly);
        }
      }
    }
    if (inc.length > 0) incidentParcelsByBeacon.set(name, inc);
  }

  const PT_TO_MM_GEN = 25.4 / 72;
  const proximityFloorG = mmToGround(18 * PT_TO_MM_GEN, S);
  const splayMap = groupSplayBeacons(beaconPositions, beaconRadius, proximityFloorG);
  const iterationOrder = computeBeaconIterationOrder(beacons?.features || [], beaconPositions, splayMap);

  const registry = createCollisionRegistry();
  const deferredCircles = [];
  // 2026-06-06: leader-line emission suppressed by user request. Beacon
  // labels keep their leader-aware placements (POI, tight-outside,
  // edge-anchored) — the placer's geometry isn't affected — but no LINE
  // entities are emitted on the BEACON_LABELS layer. The visual result:
  // labels sit near their beacons (proximity carries the association)
  // without any connecting strokes. See the (commented-out) leader
  // emission block further down for the prior trigger logic.

  // ── Beacon emission loop (#6 Task 6.4) ─────────────────────────────────────
  for (const feature of iterationOrder) {
    const rc = feature.geometry?.coordinates;
    if (!Array.isArray(rc) || rc.length < 2) continue;

    const [byRaw, bxRaw] = rc;
    if (!Number.isFinite(byRaw) || !Number.isFinite(bxRaw)
        || Math.abs(byRaw) > 1e7 || Math.abs(bxRaw) > 1e7) {
      logger.warn(`[DXF] dropped beacon ${feature.properties?.pointId || '<unnamed>'}: bad coords`);
      warn('beacons');
      continue;
    }
    const pt = capeLoToDxfSouthUp(rc[0], rc[1]);
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;

    if (ofPolygon && !isWithinPolygonBuffer(pt.x, pt.y, ofPolygon, BEACON_BUFFER)) {
      beaconsSkipped++;
      continue;
    }

    trackPt(pt);
    const beaconType = feature.properties?.type || 'placed';
    const beaconDiameter = beaconRadius * 2;

    // Defer the beacon symbol — emitted after all labels so circles sit on top.
    deferredCircles.push({ x: pt.x, y: pt.y, type: beaconType, diameter: beaconDiameter });
    beaconCount++;

    const name = feature.properties?.pointId
              || feature.properties?.name
              || feature.properties?.beacon_name
              || '';
    if (!name) continue;
    const decision = labelDecision(name);
    if (!decision) continue;

    const labelText    = decision.text;
    const labelWidth   = labelText.length * beaconLabelHeight * 0.55;
    const labelHeightG = beaconLabelHeight * 1.2;

    let labelPos;
    if (decision.isInsideParcel && decision.polygon) {
      labelPos = placeSuffixLabelPOIDirected({
        beaconPos: pt, polygon: decision.polygon,
        labelWidth, labelHeight: labelHeightG,
        beaconRadius, registry,
      });
    } else {
      const incident = incidentParcelsByBeacon.get(name) || [];
      const padding  = mmToGround(0.8, S);
      labelPos =
        tryTightFullBeaconLabelPosition({
          beaconPos: pt, labelWidth, labelHeight: labelHeightG,
          beaconRadius, padding, incidentPolygons: incident, registry,
        })
        || calculateFullBeaconLabelOutsideOnEdge({
          beaconPos: pt, incidentPolygons: incident,
          labelWidth, labelHeight: labelHeightG,
          beaconRadius, registry,
        })
        || {
          x: pt.x + beaconLabelOffset,
          y: pt.y + beaconLabelOffset,
        };
    }

    registry.add({ x: labelPos.x, y: labelPos.y, width: labelWidth, height: labelHeightG });
    addText('BEACON_LABELS', labelPos.x, labelPos.y, labelText, beaconLabelHeight);

    // 2026-06-06: leader-line emission removed by user request. The placer
    // still uses leader-aware geometry to position labels (POI-directed,
    // tight-outside, edge-anchored); we just don't draw the connecting line.
    // Original emission (preserved here as a comment for future restoration):
    //
    //   const lcx = labelPos.x + labelWidth / 2;
    //   const lcy = labelPos.y + labelHeightG / 2;
    //   if (Math.hypot(lcx - pt.x, lcy - pt.y) > LEADER_THRESHOLD) {
    //     const angle       = Math.atan2(pt.y - lcy, pt.x - lcx);
    //     const beaconEdgeX = pt.x - Math.cos(angle) * beaconRadius;
    //     const beaconEdgeY = pt.y - Math.sin(angle) * beaconRadius;
    //     const closestX    = Math.max(labelPos.x, Math.min(pt.x, labelPos.x + labelWidth));
    //     const closestY    = Math.max(labelPos.y, Math.min(pt.y, labelPos.y + labelHeightG));
    //     addLine('BEACON_LABELS', beaconEdgeX, beaconEdgeY, closestX, closestY);
    //   }
  }

  // ── Deferred-circle z-order: emit beacon symbols AFTER all labels ──────────
  for (const c of deferredCircles) {
    addBeaconSymbol('BEACONS', c.x, c.y, c.type, c.diameter);
  }
  logger.info(`[DXF] Beacons: ${beaconCount} included, ${beaconsSkipped} filtered out (outside figure + ${BEACON_BUFFER}m buffer)`);

  // â”€â”€ 5. Page layout (matching PDF structure) â”€â”€
  const mm = (v) => mmToGround(v, S); // shorthand
  const pt = (v) => ptToGround(v, S);

  // ── Outside-figure vertex markers ──
  // Nothing is emitted at the outside-figure vertices any more. Per-vertex
  // coordinate value labels (Y=<westing> X=<southing>) were removed earlier —
  // the four corner reference crosses carry the coordinate frame — and the
  // short outward leader ticks that used to point at those labels are now
  // removed too (they pointed at nothing). The outside figure carries only its
  // vertex beacon names. Its edge distances/directions live in the OUTSIDE
  // FIGURE DATA table (no on-figure edge labels — matches the PDF). Parcel-edge
  // labels are unaffected and emitted below.

  // Resolve the OUTSIDE FIGURE DATA "System : Lo NN°" label once, from the
  // project's central meridian (metadata.centralMeridian) / projection, and
  // stash it on outsideFigureData.constants.loSystem so emitOFDTable reads the
  // same value the PDF does. Shared resolveLoSystem() is the single source of
  // truth — a Lo 29 project must read Lo 29, not the bare default.
  if (outsideFigureData && !outsideFigureData.constants?.loSystem) {
    outsideFigureData.constants = {
      ...(outsideFigureData.constants || {}),
      loSystem: resolveLoSystem(outsideFigureData, metadata, projection),
    };
  }

  // Text sizes. Cartographic hierarchy (ISO 3098 nominal heights): the title
  // must dominate every feature label. GENERAL PLAN (7 mm) > designation (5 mm)
  // > section headers/stand numbers (≤3.5 mm) > table body (~2.5 mm). hBody/hHead
  // stay pt-based (≈2.5/2.8 mm) so the schedule row geometry is unchanged.
  const hTitle = mm(7);      // GENERAL PLAN — dominant heading
  const hDesig = mm(5);      // designation headline — the identifying title
  const hSub = pt(10);       // 'of' connector + SHEET label (~3.5 mm)
  const hBody = pt(7);       // table body (~2.5 mm)
  const hHead = pt(8);       // table headers
  const rH = hBody * 1.6;    // row height

  // Drawing bounds. When no features were tracked (empty parcels + empty
  // beacons + no outside figure data), minX/maxX stay at ±Infinity from
  // their initial values. Guard against that so cntL/cntR/cntT/cntB stay
  // finite — otherwise the bottom-zone topology emitter receives a NaN
  // contentArea and fires spurious overflow warns. Default fallback span:
  // 100m around origin (matches drawW/drawH fallback at line 467).
  const dL = Number.isFinite(minX) ? minX : 0;
  const dR = Number.isFinite(maxX) ? maxX : 100;
  const dT = Number.isFinite(maxY) ? maxY : 100;
  const dB = Number.isFinite(minY) ? minY : 0;
  const dW = dR - dL, dH = dT - dB;
  const dCX = (dL + dR) / 2;

  // â”€â”€ Page frame from actual paper size with exact margins â”€â”€
  // Margins: L=50mm, T=50mm, B=50mm, R=150mm (endorsements in right margin)
  const mL = mm(50), mT = mm(50), mB = mm(50), mR = mm(150);
  const pageW = mm(paper.w);   // full paper width in ground
  const pageH = mm(paper.h);   // full paper height in ground

  // Content area dimensions (inside margins, excluding endorsements)
  const contentW = pageW - mL - mR;   // 594 - 50 - 150 = 394mm
  const contentH = pageH - mT - mB;   // 420 - 50 - 50 = 320mm

  // Surveyed parcels (hoisted: needed both to measure the title band below and,
  // later, for the figure-description text + Schedule of Areas). Sharing the one
  // source prevents silent drift between consumers.
  const surveyedFeatures = (parcels?.features || [])
    .filter(f => {
      const st = (f.properties?.stand || '').toLowerCase();
      return !f.properties?.isOutsideFigure && !st.includes('outside figure');
    })
    .sort((a, b) => {
      const na = parseInt(a.properties?.stand) || 0;
      const nb = parseInt(b.properties?.stand) || 0;
      return na - nb || String(a.properties?.stand || '').localeCompare(String(b.properties?.stand || ''));
    });
  const surveyedParcels = surveyedFeatures.map(f => ({
    stand: f.properties?.stand || '',
    area_m2: f.properties?.area_m2 || 0,
  }));

  // ── Measure the title block as ONE cohesive band ──
  // Sum the exact vertical advances the title drawer uses (GENERAL PLAN → of →
  // designation → SHEET → figure description → Vide), so the outside figure can
  // be fitted strictly below it. Mirrors the char-wrap budgets in the drawer.
  const _desigMaxChars = Math.max(1, Math.floor(contentW / (hDesig * 0.6)));
  const _titleMaxChars = Math.max(1, Math.floor(contentW / (hBody * 0.55)));
  const _desigLines = formatPlanDesignation(metadata, surveyedParcels)
    ? splitToWidth(formatPlanDesignation(metadata, surveyedParcels), _desigMaxChars).length : 0;
  const _sheetLines = formatSheetLabel(sheetInfo).length;
  const _figLines   = formatFigureDescription(metadata, outsideFigureData, surveyedParcels, _titleMaxChars).length;
  const _videLines  = formatVideLine(_titleMaxChars).length;
  const titleBandH =
      mm(8)                                   // top inset to first baseline
    + hTitle * 1.6                            // GENERAL PLAN
    + hSub * 1.6                              // of
    + _desigLines * hDesig * 1.6             // designation line(s)
    + mm(3)                                   // gap before SI 727 lines
    + _sheetLines * hSub * 1.6               // SHEET N (multi-sheet only)
    + _figLines * hBody * 1.6                // figure description
    + _videLines * hBody * 1.6               // Vide line
    + hBody;                                  // clearance gap below the last line

  // Page positioned so the drawing is centred horizontally, and vertically so a
  // top band is reserved for the title block with the figure fitted strictly
  // below it (matches the PDF's reserve-band-fit-figure-below strategy). The
  // figure is only shifted DOWN when its natural top margin is smaller than the
  // band, and never so far that it overruns the content bottom.
  const contentCX = dCX;                              // drawing centered horizontally
  const _naturalCY = (dT + dB) / 2;                   // figure centred in content
  const _desiredCY = dT - contentH / 2 + titleBandH;  // figure top at cntT − band
  const _maxCY     = dB + contentH / 2;               // figure bottom at cntB (don't overrun)
  const contentCY  = Math.min(_maxCY, Math.max(_naturalCY, _desiredCY));

  // Page edges (outer border)
  const pageL = contentCX - contentW / 2 - mL;       // left edge of paper
  const pageR = pageL + pageW;                        // right edge of paper
  const pageB = contentCY - contentH / 2 - mB;       // bottom edge of paper
  const pageT = pageB + pageH;                        // top edge of paper

  // Content area edges (inside margins)
  const cntL = pageL + mL;                            // content left  (50mm from left)
  const cntR = pageR - mR;                            // content right (150mm from right)
  const cntT = pageT - mT;                            // content top   (50mm from top)
  const cntB = pageB + mB;                            // content bottom(50mm from bottom)

  // Endorsements column (in the right margin area)
  const endDivX = cntR;                               // vertical divider at content right

  // Layout zones within content area. Title zone now uses the MEASURED title band
  // (so the reserved obstacle matches what is actually drawn and the figure,
  // fitted below it, never overlaps). Tables zone: bottom 40% of content.
  const titleZoneH = titleBandH;
  const tableZoneH = contentH * 0.40;
  const drawDivY = cntB + tableZoneH;                // horizontal divider above tables
  const titleDivY = cntT - titleZoneH;               // not drawn but used for reference

  logger.info(`[DXF] Margins: L=${50}mm T=${50}mm B=${50}mm R=${150}mm, Content: ${(contentW / mm(1)).toFixed(0)}x${(contentH / mm(1)).toFixed(0)}mm`);

  // (surveyedFeatures / surveyedParcels are hoisted above — needed to measure
  // the title band before the page frame is positioned.)

  // â”€â”€ PAGE FRAME + DIVIDERS â”€â”€
  const TB = 'TITLE_BLOCK';
  addRect(TB, pageL, pageB, pageR, pageT);           // outer paper border
  // Content area border (margin lines)
  addRect(TB, cntL, cntB, cntR, cntT);               // content border (also draws the
                                                     // endorsements divider edge at cntR=endDivX,
                                                     // bounded to cntB..cntT — no margin overrun)
  // The drawing-zone / bottom-zone separator at drawDivY was previously drawn
  // as a full-width horizontal line. The PDF doesn't emit any equivalent
  // (it relies on block placement + per-block borders), so the line is
  // omitted here for 1:1 PDF parity. `drawDivY` is still used as a y-coord
  // boundary by the schedule placer and the bottom-zone layout below.
  addMarginGuides('MARGIN_GUIDES', pageL, pageR, pageT, pageB, cntL, cntR, cntT, cntB)

  // â”€â”€ A) TITLE ZONE (within top margin area, centered in content) â”€â”€
  const txC = (cntL + cntR) / 2; // center of content area
  let ty = cntT - mm(8);
  // Title heading mirrors the PDF title block exactly: "GENERAL PLAN" → "of" →
  // designation headline → (SHEET N) → figure description → Vide. The PDF carries
  // no SCALE / firm / licence / "Survey covers" lines here, so neither do we.
  addTextC(TB, txC, ty, 'GENERAL PLAN', hTitle, 'BOLD');
  ty -= hTitle * 1.6;
  addTextC(TB, txC, ty, 'of', hSub);
  ty -= hSub * 1.6;
  // Designation headline: "Stands <range> <township>" (parent-property suffix
  // stripped — it appears only in the figure-description sentence below).
  const planDesignation = formatPlanDesignation(metadata, surveyedParcels)
  if (planDesignation) {
    const desigMaxChars = Math.floor((cntR - cntL) / (hDesig * 0.6))
    for (const line of splitToWidth(planDesignation, desigMaxChars)) {
      addTextC(TB, txC, ty, line, hDesig, 'BOLD');
      ty -= hDesig * 1.6;
    }
  }
  ty -= mm(3);

  // â”€â”€ SI 727 Seventh Schedule (b) lines â”€â”€
  // Character budget for wrapping: content area width divided by an average
  // character-to-text-height ratio of 0.55 (see spec). This is the one knob
  // to tune if manual CAD verification shows lines too short or too long.
  const titleMaxLineChars = Math.floor((cntR - cntL) / (hBody * 0.55))

  // (b.i) Conditional SHEET N label â€” only emits for multi-sheet plans.
  for (const line of formatSheetLabel(sheetInfo)) {
    ty -= hSub * 1.6
    addTextC(TB, txC, ty, line, hSub, 'BOLD')
  }

  // (b.ii) Figure description sentence (replaces the old ad-hoc line).
  for (const line of formatFigureDescription(metadata, outsideFigureData, surveyedParcels, titleMaxLineChars)) {
    ty -= hBody * 1.6
    addTextC(TB, txC, ty, line, hBody)
  }

  // (b.iii) Vide diagram line â€” always emitted.
  for (const line of formatVideLine(titleMaxLineChars)) {
    ty -= hBody * 1.6
    addTextC(TB, txC, ty, line, hBody)
  }

  // Scale bar + North arrow are emitted AFTER the planner runs (see below), at
  // the planner's reserved `scaleBar` / `northArrow` slots — the same slots the
  // schedule is placed to avoid. Rendering them anywhere else (e.g. a hard-coded
  // bottom-right corner) makes the schedule collide with them, because the
  // schedule dutifully dodges the planner's slots, not the renderer's position.

  // Coordinate reference crosses at the figure's four corners (SI 727 frame).
  // _crossBounds is reserved as an obstacle in the collision-avoidance pass so no
  // block covers a cross or its coordinate label.
  const _crossBounds = addCornerCrosses('GRID', dL, dR, dT, dB, cntL, cntR, cntB, cntT)

  // â”€â”€ B) ENDORSEMENTS (right-margin table) â”€â”€
  // Fills the right-margin strip from the drawing-area right margin (endDivX)
  // out to the paper edge (pageR), and from the top margin (cntT) to the bottom
  // margin (cntB). Title + all rules are drawn inside drawEndorsementZone.
  drawEndorsementZone(endDivX, pageR, cntT, cntB);

  // ── C) BOTTOM ZONE — topological emission (3-v4) ──
  // Replaces the pre-3-v4 fixed bottom-zone partition. All five blocks
  // (OFD table, schedule of areas, beacon descriptions, survey date
  // statement, SG approval box) now flow through placeBottomZoneBlocks
  // which mirrors pdfkitGeoPDF.js:calculateBlockPositions ordering and
  // calls findBlockPosition for each block. Pre-seeded obstacles below
  // (title zone, north arrow, scale bar) keep the topology scan away
  // from the already-emitted fixed elements.
  //
  // The figurePolygon construction below mirrors the pre-3-v4 logic:
  // ofResult.vertices carry Cape Lo {y, x} coords; the placer expects
  // DXF ground-metre {x, y}. Convert via capeLoToDxfSouthUp and drop
  // the trailing closing duplicate so polygon edges aren't double-
  // counted by the topology scanner.
  const figurePolygon = (ofResult && Array.isArray(ofResult.vertices) && ofResult.vertices.length >= 4)
    ? ofResult.vertices.slice(0, -1).map(v => capeLoToDxfSouthUp(v.y, v.x))
    : null;

  const contentArea = {
    x:      cntL,
    y:      cntB,
    width:  cntR - cntL,
    height: cntT - cntB,
  };

  // Pre-seeded obstacles — fixed-position elements already emitted above.
  // The scale bar + North arrow are NOT seeded here: the planner reserves them
  // internally (calculateBlockPositions' prePlaced path) and we render them at
  // those reserved slots, so the schedule already avoids them.
  const bottomZoneObstacles = [
    // Title zone covers the top ~20% of the content area.
    { name: 'titleZone',  x: cntL,           y: titleDivY,         width: cntR - cntL, height: cntT - titleDivY },
  ];

  // Schedule-specific fonts matching the PDF generator (9 pt title,
  // 7 pt body/headers, 15 pt row height per drawScheduleOfAreasSingleColumn).
  // OFD + SG sizes pulled from block-definitions.js (single source of truth
  // shared with pdfkitGeoPDF.js).
  const bottomZoneFonts = {
    hHead:    pt(9),
    hBody:    pt(7),
    hSub,
    rH:       pt(15),
    ofTitleH: pt(OUTSIDE_FIGURE_DATA.titleFontSize),
    ofBodyH:  pt(OUTSIDE_FIGURE_DATA.fontSize),
    ofRowH:   pt(OUTSIDE_FIGURE_DATA.rowHeight),
    sgTitleH: pt(SURVEYOR_GENERAL_BOX.titleFontSize),
    sgBodyH:  pt(SURVEYOR_GENERAL_BOX.bodyFontSize),
  };

  // 3-v8 follow-up: use the shared Helvetica-AFM measurer and PDF's
  // (headerFontSize=6, bodyFontSize=7) so DXF and PDF feed the planner
  // bit-identical scheduleColumnWidthsPt. Previously DXF used 1.0 char
  // width × 7pt for both header and body — that gave wider columns than
  // PDF, the planner saw different schedule dimensions, and chose
  // different anchor sides. See scheduleMeasurer.js for the documented
  // trade-off around CAD-viewer width-factor compliance.
  const dxfScheduleMeasure = buildScheduleMeasurer(6, 7);
  const scheduleColumnWidthsPt = computeScheduleColumnWidths({
    dataRows:       surveyedFeatures.map(extractScheduleRow),
    headerFontSize: 6,
    bodyFontSize:   7,
    measureText:    dxfScheduleMeasure,
  });
  const scheduleColumnWidthsG = scheduleColumnWidthsPt.map(w => mm(w * PT_TO_MM_GEN));

  // ── 3-v5: Bottom-zone positions come from the shared sheet-layout planner ──
  // The planner expects PDF-point coordinates with y-down origin. DXF works
  // in ground metres with south-up y. Convert at both boundaries.
  //
  //   1 PDF pt = (25.4/72) mm paper = (25.4/72) * (S/1000) ground metres
  //   So: groundMetres → PDF pt = groundMetres * 1000 / S / (25.4/72)
  const M_TO_PT = 1000 / S / (25.4 / 72);
  const PT_TO_M = 1 / M_TO_PT;
  const contentWidthPt  = (cntR - cntL) * M_TO_PT;
  const contentHeightPt = (cntT - cntB) * M_TO_PT;

  // 3-v8: polygon-for-planner comes from the shared helper so PDF and DXF feed
  // an identical polygon into planSheetLayout. Previously DXF used a y-flipped
  // capeLoToDxfSouthUp transform while PDF used transformCoords (fit-to-extent),
  // and the two polygons differed in size by ~5% AND in vertex ordering —
  // making the planner place blocks on opposite sides of the figure.
  // 3-v8 follow-up: build polygon AND parcel segments via the same shared helper
  // the PDF side now uses, so the placement engine sees identical obstacle sets
  // on both formats (modulo the per-format mapBounds origin).
  const { polyPts: polyPtsForPlanner, parcelSegments: parcelSegmentsForPlanner } = buildPlannerObstacles({
    outsideFigure: (ofResult && ofResult.vertices.length >= 4)
      ? { geometry: { type: 'Polygon', coordinates: [ofResult.vertices.slice(0, -1)] } }
      : null,
    parcels:    { type: 'FeatureCollection', features: surveyedFeatures },
    scaleDenom: S,
    mapBounds:  { x: 0, y: 0, width: contentWidthPt, height: contentHeightPt },
    closeRing:  false,
  });

  // Pre-seeded obstacles: same shift/flip.
  const tickMarkBoundsForPlanner = bottomZoneObstacles.map(o => ({
    name: o.name,
    x: (o.x - cntL) * M_TO_PT,
    y: (cntT - (o.y + o.height)) * M_TO_PT,  // top edge in y-down
    width:  o.width  * M_TO_PT,
    height: o.height * M_TO_PT,
  }));

  const plannerMeasure = (str, { size }) => String(str).length * size * 0.55;

  // ── 3-v7 diagnostic: log the planner inputs so PDF↔DXF discrepancies can be
  // traced from the same request.  Remove once polygon-handoff is verified.
  const _diagPolyBbox = (polyPtsForPlanner && polyPtsForPlanner.length)
    ? {
        minX: Math.min(...polyPtsForPlanner.map(p => p.x)),
        maxX: Math.max(...polyPtsForPlanner.map(p => p.x)),
        minY: Math.min(...polyPtsForPlanner.map(p => p.y)),
        maxY: Math.max(...polyPtsForPlanner.map(p => p.y)),
      }
    : null;
  logger.info({
    msg: '[PLANNER-INPUT] DXF → planSheetLayout',
    mapBounds: { x: 0, y: 0, width: +contentWidthPt.toFixed(1), height: +contentHeightPt.toFixed(1) },
    polyVerts: polyPtsForPlanner?.length ?? 0,
    polyBbox: _diagPolyBbox,
    polyFirst3: polyPtsForPlanner?.slice(0, 3).map(p => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1) })),
    scheduleColumnWidthsPt,
  });

  const blockPositions = planSheetLayout({
    metadata,
    parcels:           { type: 'FeatureCollection', features: surveyedFeatures },
    outsideFigureData,
    beacons:           beacons || { type: 'FeatureCollection', features: [] },
    mapBounds:         { x: 0, y: 0, width: contentWidthPt, height: contentHeightPt },
    mapFeatureBounds:  { x: 0, y: 0, width: contentWidthPt, height: contentHeightPt, pdfPoints: polyPtsForPlanner, parcelSegments: parcelSegmentsForPlanner },
    scale:             { value: S, label: `1:${S}` },
    extent:            { minX: pageL, maxX: pageR, minY: pageB, maxY: pageT },
    // 3-v8 follow-up: match PDF (which now also passes []) so the planner
    // sees identical obstacle sets and makes identical placement decisions.
    // The titleZone/northArrow/scaleBar items previously injected here are
    // already represented by calculateBlockPositions' internal prePlaced
    // path, so removing them here doesn't lose collision coverage.
    tickMarkBounds:    [],
    polyPts:           polyPtsForPlanner,
    measureText:       plannerMeasure,
    logger,
    scheduleColumnWidthsPt,
  });

  // 3-v7 diagnostic: log returned block positions so the PDF↔DXF placement
  // divergence can be diagnosed from a single request.
  logger.info({
    msg: '[PLANNER-OUTPUT] DXF received block positions',
    titleBlock:        blockPositions.titleBlock        ? { x: +blockPositions.titleBlock.x.toFixed(1),        y: +blockPositions.titleBlock.y.toFixed(1) }        : null,
    scheduleOfAreas:   blockPositions.scheduleOfAreas   ? { x: +blockPositions.scheduleOfAreas.x.toFixed(1),   y: +blockPositions.scheduleOfAreas.y.toFixed(1) }   : null,
    outsideFigureData: blockPositions.outsideFigureData ? { x: +blockPositions.outsideFigureData.x.toFixed(1), y: +blockPositions.outsideFigureData.y.toFixed(1) } : null,
    surveyStatement:   blockPositions.surveyStatement   ? { x: +blockPositions.surveyStatement.x.toFixed(1),   y: +blockPositions.surveyStatement.y.toFixed(1) }   : null,
    sgSignature:       blockPositions.sgSignature       ? { x: +blockPositions.sgSignature.x.toFixed(1),       y: +blockPositions.sgSignature.y.toFixed(1) }       : null,
  });

  // 3-v7: paper-size escalation. Mirrors pdfkitGeoPDF.js:13497-13559.
  // Uses normalizedSheetSize so the ladder lookup matches even when callers
  // sent the space form (e.g. 'ISO A0' from si727Constants.code).
  const _sheetSizeUpAttempt = options._sheetSizeUpAttempt ?? 0;
  if (blockPositions.needsScaleUp && _sheetSizeUpAttempt < MAX_SHEET_UP_ATTEMPTS) {
    const nextSheet = nextSheetUp(normalizedSheetSize);
    if (nextSheet) {
      logger.warn(
        `[DXF] Blocks unplaceable on ${normalizedSheetSize} — ` +
        `escalating to ${nextSheet} (attempt ${_sheetSizeUpAttempt + 1}/${MAX_SHEET_UP_ATTEMPTS})`
      );
      return generateDXF({
        ...options,
        sheetSize: nextSheet,
        _sheetSizeUpAttempt: _sheetSizeUpAttempt + 1,
      }, logger);
    }
  }
  if (blockPositions.needsScaleUp) {
    warn('scheduleEscalationExhausted', {
      atSheetSize: sheetSize,
      attempts: _sheetSizeUpAttempt,
      hint: 'Plan too dense for largest available paper size; some blocks may overlap the figure.',
    });
  }

  // Convert planner positions (y-down PDF pt, relative to content area top-left)
  // → DXF ground metres (south-up). Emit position.y = TOP of block in south-up.
  const toDxf = (p) => ({
    x:      cntL + p.x * PT_TO_M,
    y:      cntT - p.y * PT_TO_M,
    width:  p.width  * PT_TO_M,
    height: p.height * PT_TO_M,
  });
  const ofdPos       = toDxf(blockPositions.outsideFigureData);
  const schedPos     = toDxf(blockPositions.scheduleOfAreas);
  const beaconPos    = toDxf(blockPositions.beaconDescription);
  const statementPos = toDxf(blockPositions.surveyStatement);
  const sgPos        = toDxf(blockPositions.sgSignature);

  // Beacon Description groups: honour caller-supplied beaconGroups, else derive
  // from the beacons via the shared classifier — the same grouping the PDF
  // renders — so the DXF emits the SI 727 Beacon Description block (it used to
  // be silently dropped whenever no pre-grouped beaconGroups were passed).
  const beaconGroups = (options.beaconGroups && options.beaconGroups.length)
    ? options.beaconGroups
    : classifyBeaconGroups(beacons);

  // Scale bar + North arrow at the planner's reserved slots (the schedule is
  // placed to avoid these, so rendering them here — rather than at a hard-coded
  // corner — guarantees no collision). The bar is fitted to its slot width so it
  // can't overflow into a neighbouring schedule table.
  const scaleBarPos   = blockPositions.scaleBar   ? toDxf(blockPositions.scaleBar)   : null;
  const northArrowPos = blockPositions.northArrow ? toDxf(blockPositions.northArrow) : null;
  // NOTE: the scale bar + North arrow are emitted AFTER the schedule now (in the
  // collision-avoidance pass below), so they relocate out of the figure when the
  // planner's reserved slot falls on an irregular/large figure.

  // NOTE: the Outside Figure Data table is emitted AFTER the schedule now (in the
  // collision-avoidance pass below), so it can be placed clear of the schedule's
  // actual footprint rather than at a fixed planner slot the schedule may cover.

  // Schedule emitter operates with its own internal sizing (DXF-specific font
  // metrics differ slightly from PDF), so give it the full content area as
  // the drawing zone and let it find space using Pass 1/2/3. Other emitted
  // blocks (OFD, SG, statement, beacon-desc) are passed as seed obstacles so
  // the schedule respects their planner-assigned positions.
  // 3-v6: Pass the planner's exact schedule top-left as fixedPosition. The
  // emitter skips Pass 1/2/3 search and emits side-by-side sub-tables at the
  // planner's position — guarantees PDF↔DXF schedule-position parity.
  // 3-v8 follow-up: when the planner ran the shared schedule search and stored
  // placedTables on the schedule block, convert each sub-table's planner-pt
  // (x, y, w, h) into DXF ground metres and pass through. The emitter renders
  // each sub-table at its own coordinates — matching PDF exactly.
  const _plannerPlacedSched = blockPositions.scheduleOfAreas?.placedTables;
  const _placedTablesGround = (Array.isArray(_plannerPlacedSched) && _plannerPlacedSched.length > 0)
    ? _plannerPlacedSched.map(t => ({
        x:      cntL + t.x * PT_TO_M,
        y:      cntT - t.y * PT_TO_M,            // south-up: TOP of table
        width:  t.width  * PT_TO_M,
        height: t.height * PT_TO_M,
        rowCount:          t.rowCount,
        parcelsStartIndex: t.parcelsStartIndex,
        isContinuation:    !!t.isContinuation,
      }))
    : null;

  // ① Balance the schedule across BOTH side strips at draw time (the ideal
  // General Plan look). Mirror the pooled sub-tables across the figure centre
  // (dCX) into the opposite strip when they still fit the content area
  // [cntL, cntR] — all in DXF ground-metres. Done here (not in the planner)
  // because the planner can't reach the figure polygon on the PDF side; each
  // generator balances in its own frame via the same shared helper.
  // Other bottom-zone blocks the schedule must not overlap (OFD, SG approval box,
  // survey statement, beacon descriptions). Inflate slightly so a visible gap is
  // kept. A sub-table that can't mirror into the opposite strip without hitting
  // one of these stays at its planner (pooled) position — no overlap.
  const _pad = mm(2);
  const _inflate = (b) => ({ x: b.x - _pad, y: b.y + _pad, width: b.width + 2 * _pad, height: b.height + 2 * _pad });
  const _scheduleObstacles = [
    outsideFigureData?.edges?.length ? ofdPos : null,
    sgPos,
    statementPos,
    beaconGroups.length ? beaconPos : null,
    scaleBarPos,
    northArrowPos,
  ].filter(Boolean).map(_inflate);
  const _placedTablesBalanced = _placedTablesGround
    ? balanceScheduleTables(_placedTablesGround, dCX, cntL, cntR, _scheduleObstacles)
    : null;

  // Sibling bottom-zone blocks the re-split search must NOT land on (the planner
  // placed these around the schedule; our own search must avoid them too, or it
  // figure-dodges straight onto e.g. the Surveyor-General box). The emitter's
  // search frame is the content area with y = bottom (min corner), so convert
  // each toDxf position (y = TOP) to its min corner: y_bottom = y - height.
  const _toSeed = (p) => (p ? { x: p.x, y: p.y - p.height, width: p.width, height: p.height } : null);
  const _titleBlockPos = blockPositions.titleBlock ? toDxf(blockPositions.titleBlock) : null;
  const _endorsementPos = blockPositions.endorsement ? toDxf(blockPositions.endorsement) : null;
  const _resplitSeeds = [
    outsideFigureData?.edges?.length ? ofdPos : null,
    sgPos, statementPos,
    beaconGroups.length ? beaconPos : null,
    scaleBarPos, northArrowPos, _titleBlockPos, _endorsementPos,
  ].filter(Boolean).map(_toSeed);

  // Arguments shared by the dry-run (search) and the real emit. fixedPosition /
  // placedTablesGround / seedPlacedBlocks / draw callbacks are supplied per-call.
  const _commonEmitArgs = {
    surveyedFeatures,
    drawingZone: contentArea,    // the search path's zone; ignored when placement is supplied
    polygon: figurePolygon,
    sheetSize,
    fonts: bottomZoneFonts,
    helpers: {
      mm, extractScheduleRow, computeScheduleLayout, addScheduleTable,
      nextLargerSheet, SCHEDULE_HEADER_HEIGHT_MM, columnWidthsG: scheduleColumnWidthsG,
    },
  };

  // Guarded re-split. The planner sizes the schedule against ~full content
  // height, so on dense plans it pools a few very TALL tables down one side.
  // When the figure is irregular and its edge juts into that side strip (the
  // real Maglas overlap: the figure's top-right block reaches into the right
  // strip), those tall tables clip the figure. The emitter's own Pass 1/2/3
  // search is polygon-aware and splits into more, SHORTER tables that dodge the
  // figure. So when the planner's tables overlap the figure, dry-run that search
  // (no-op draw callbacks → deterministic, no side effects) and adopt it ONLY if
  // it seats every stand AND overlaps nothing (shouldAdoptResplit) — never
  // trading a complete schedule for a lossy or still-overlapping one. Tables are
  // south-up (y = TOP); the min-corner rect is { y: t.y - t.height }.
  const _plannerTablesOverlapFigure = _placedTablesBalanced && figurePolygon && figurePolygon.length >= 3 &&
    _placedTablesBalanced.some(t => rectangleOverlapsPolygon(
      { x: t.x, y: t.y - t.height, width: t.width, height: t.height }, figurePolygon, 0));

  // Monotonic placement choice (never worse than today):
  //   C 'resplit-seeded'   — re-split avoiding BOTH the figure and the sibling
  //                          bottom-zone blocks. Clears every overlap. Best.
  //   B 'resplit'          — re-split avoiding only the figure (may touch a
  //                          sibling). This is the prior shipped behaviour; used
  //                          when C can't seat every stand (genuine capacity).
  //   A 'planner'          — the planner's complete tables (overlap the figure).
  // We prefer C, then B, then A — so adding the sibling-avoidance can only ever
  // improve a plan, never reintroduce the figure overlap it already fixed.
  let _emitMode = 'planner';
  if (_plannerTablesOverlapFigure) {
    const _noop = () => {};
    const _silent = { info: () => {}, warn: () => {}, error: () => {} };
    const _drySearch = (seeds) => emitScheduleOfAreasTopological({
      ..._commonEmitArgs,
      fixedPosition: null,
      placedTablesGround: null,        // force the polygon-aware Pass 1/2/3 search
      seedPlacedBlocks: seeds,
      addText: _noop, addLine: _noop, warn: _noop, logger: _silent,
    });
    const _seeded = _drySearch(_resplitSeeds);
    if (shouldAdoptResplit({ resplitTables: _seeded.placedTables, missingStandCount: _seeded.missingStandCount, figurePolygon, obstacles: _resplitSeeds })) {
      _emitMode = 'resplit-seeded';
    } else {
      const _plain = _drySearch([]);
      if (shouldAdoptResplit({ resplitTables: _plain.placedTables, missingStandCount: _plain.missingStandCount, figurePolygon })) {
        _emitMode = 'resplit';
      }
    }
    logger.info(`[DXF] planner schedule tables overlap figure — placement: ${_emitMode}`);
  }

  const _resplit = _emitMode !== 'planner';
  const _schedEmit = emitScheduleOfAreasTopological({
    ..._commonEmitArgs,
    fixedPosition: _resplit ? null : { x: schedPos.x, y: schedPos.y },
    placedTablesGround: _resplit ? null : _placedTablesBalanced,
    seedPlacedBlocks: _emitMode === 'resplit-seeded' ? _resplitSeeds : [],
    addText, addLine, warn, logger,
  });
  // Actual schedule sub-table footprints (min-corner ground rects, y = bottom)
  // — the dominant obstacle the small bottom-zone blocks are placed around below.
  const _schedRects = (_schedEmit?.placedTables || []).map(t => ({
    x: t.x, y: t.y, width: t.width, height: t.height,
  }));

  // Post-emission escalation. Mirrors the PDF's _polyCollisionOnMandatory →
  // needsScaleUp promotion (pdfkitGeoPDF.js:7020). The shared planner runs a
  // coarser placement search than the schedule emitter's actual sub-table
  // footprints, so it can mark the schedule placeable (needsScaleUp=false) on a
  // sheet where the EMITTED tables still overlap the figure. The pre-emission
  // gate above only sees the planner's needsScaleUp and misses this. So if the
  // emitted schedule actually overlaps the figure and the sheet can still grow,
  // escalate rather than render the overlap. When the largest sheet is exhausted
  // there is no nextSheet, so we fall through and keep the existing
  // scheduleOfAreasOverlapsPolygon warning as the graceful residual signal.
  if (warnings.summary.scheduleOfAreasOverlapsPolygon
      && _sheetSizeUpAttempt < MAX_SHEET_UP_ATTEMPTS) {
    const nextSheet = nextSheetUp(normalizedSheetSize);
    if (nextSheet) {
      logger.warn(
        `[DXF] Emitted schedule overlaps the figure on ${normalizedSheetSize} — ` +
        `escalating to ${nextSheet} (attempt ${_sheetSizeUpAttempt + 1}/${MAX_SHEET_UP_ATTEMPTS})`
      );
      return generateDXF({
        ...options,
        sheetSize: nextSheet,
        _sheetSizeUpAttempt: _sheetSizeUpAttempt + 1,
      }, logger);
    }
  }

  // ── Collision-avoidance pass for the small bottom-zone blocks ──
  // The schedule (the dominant block) is already placed; now position Outside
  // Figure Data, beacon descriptions, survey statement and the SG box into the
  // LEFTOVER whitespace so they never cover the schedule, the figure, or each
  // other. Placement order is schedule-first → these blocks second (per design):
  // each keeps its planner slot when that is already clear, otherwise it relocates
  // via findBlockPosition (the same placer the schedule uses). Frame: ground,
  // y-up, min-corner. The fixed-slot blocks (scale bar, North arrow, title block,
  // endorsements) are seeded as obstacles so nothing lands on them either.
  const _rectsOverlap = (a, b) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const _minRect = (pos, size) => ({ x: pos.x, y: pos.y - size.height, width: size.width, height: size.height });
  // Fixed-slot blocks that do NOT relocate (title block, endorsements) seed the
  // obstacle set. The scale bar + North arrow are relocatable tasks below, so
  // they are NOT seeded here (that would make them collide with their own slot).
  const _occupied = [..._schedRects, ..._crossBounds];
  for (const p of [_titleBlockPos, _endorsementPos]) {
    if (p) _occupied.push({ x: p.x, y: p.y - p.height, width: p.width, height: p.height });
  }
  // Returns the emission position (y = TOP) for a block, relocating it out of the
  // schedule / figure / already-placed footprints when its planner slot collides.
  const _placeClear = (pos, size, label) => {
    const here = _minRect(pos, size);
    const onFigure = figurePolygon && figurePolygon.length >= 3 && rectangleOverlapsPolygon(here, figurePolygon, 0);
    const onBlock = _occupied.some((o) => _rectsOverlap(here, o));
    if (!onFigure && !onBlock) { _occupied.push(here); return { x: pos.x, y: pos.y }; }
    const found = findBlockPosition({
      block: { width: size.width, height: size.height },
      mapBounds: contentArea, polygon: figurePolygon, placedBlocks: _occupied,
      buffer: mm(2), blockSpacing: mm(3), scanStep: mm(5), tableMinWidth: size.width, logger,
    });
    if (found) {
      _occupied.push({ x: found.x, y: found.y, width: size.width, height: size.height });
      logger.info(`[DXF] relocated ${label} clear of the schedule/figure → (${found.x.toFixed(1)}, ${found.y.toFixed(1)})`);
      return { x: found.x, y: found.y + size.height };   // findBlockPosition gives bottom-y; emit wants TOP
    }
    _occupied.push(here);   // no clear spot found — keep planner slot (emitted; flagged below)
    logger.warn(`[DXF] ${label} could not be relocated clear of the schedule/figure — kept at planner slot`);
    return { x: pos.x, y: pos.y };
  };

  // Build placement tasks, then place WIDEST-first so the hardest-to-fit blocks
  // claim whitespace before the smaller ones. Each task carries its emit closure
  // so placement and emission are decoupled from ordering.
  const _tasks = [];
  if (outsideFigureData?.edges?.length) {
    const size = { width: ofdPos.width, height: ofdPos.height };
    _tasks.push({ label: 'outsideFigureData', pos: { x: ofdPos.x, y: ofdPos.y }, size,
      emit: (p) => emitOFDTable(addText, addLine, { x: p.x, y: p.y }, outsideFigureData, bottomZoneFonts, mm, TB) });
  }
  if (beaconGroups.length) {
    // Planner sizes beacons from the polygon-feature collection; DXF emits from
    // the resolved beaconGroups whose count may differ. Size for the actual groups
    // (header + separator + 1 row per group) so the emitter doesn't truncate.
    const beaconGroupCount = beaconGroups.length;
    const beaconActualHeight = mm(4 * 1.4 + 1 + beaconGroupCount * 3.5 + 2);
    const size = { width: beaconPos.width, height: Math.max(beaconPos.height, beaconActualHeight) };
    _tasks.push({ label: 'beaconDescription', pos: { x: beaconPos.x, y: beaconPos.y }, size,
      emit: (p) => emitBeaconDescriptions(addBeaconDescription, TB, { x: p.x, y: p.y }, size, beaconGroups) });
  }
  {
    const size = { width: statementPos.width, height: statementPos.height };
    _tasks.push({ label: 'surveyStatement', pos: { x: statementPos.x, y: statementPos.y }, size,
      emit: (p) => emitStatement(addText, { x: p.x, y: p.y }, metadata, bottomZoneFonts, TB) });
  }
  {
    const size = { width: sgPos.width, height: sgPos.height };
    _tasks.push({ label: 'sgSignature', pos: { x: sgPos.x, y: sgPos.y }, size,
      emit: (p) => emitSGBox(addText, addLine, addRect, { x: p.x, y: p.y }, size, bottomZoneFonts, mm, TB) });
  }
  if (scaleBarPos) {
    const size = { width: scaleBarPos.width, height: scaleBarPos.height };
    _tasks.push({ label: 'scaleBar', pos: { x: scaleBarPos.x, y: scaleBarPos.y }, size,
      // bar line near slot top (− mm(4)); labels/footer fall below, within the slot height.
      emit: (p) => addScaleBar('SCALE_BAR', p.x + size.width / 2, p.y - mm(4), S, size.width) });
  }
  if (northArrowPos) {
    const size = { width: northArrowPos.width, height: northArrowPos.height };
    _tasks.push({ label: 'northArrow', pos: { x: northArrowPos.x, y: northArrowPos.y }, size,
      emit: (p) => addNorthArrow('NORTH_ARROW', p.x + size.width / 2, p.y - size.height / 2, mm(25)) });
  }
  _tasks.sort((a, b) => b.size.width - a.size.width);

  const _finalPos = {};
  for (const t of _tasks) {
    const p = _placeClear(t.pos, t.size, t.label);
    t.emit(p);
    _finalPos[t.label] = { x: p.x, y: p.y, width: t.size.width, height: t.size.height };
  }

  // 3-v7: structured warnings for each surrounding block that overlaps the polygon
  // (checked at the FINAL emitted position) + a signal if a block could not be
  // kept clear of the schedule after the collision-avoidance pass above.
  function _warnIfOverlap(name) {
    const pos = _finalPos[name];
    if (!pos) return;
    const rect = { x: pos.x, y: pos.y - pos.height, width: pos.width, height: pos.height };
    if (figurePolygon && figurePolygon.length >= 3 && rectangleOverlapsPolygon(rect, figurePolygon, 0)) {
      warn(`${name}OverlapsPolygon`, {
        position: { x: pos.x, y: pos.y, width: pos.width, height: pos.height },
        hint: `${name} block rendered over the parcel figure.`,
      });
    }
    if (_schedRects.some((s) => _rectsOverlap(rect, s))) {
      warn(`${name}OverlapsSchedule`, {
        position: { x: pos.x, y: pos.y, width: pos.width, height: pos.height },
        hint: `${name} block could not be placed clear of the Schedule of Areas.`,
      });
    }
  }

  _warnIfOverlap('outsideFigureData');
  _warnIfOverlap('beaconDescription');
  _warnIfOverlap('surveyStatement');
  _warnIfOverlap('sgSignature');
  _warnIfOverlap('scaleBar');
  _warnIfOverlap('northArrow');

  logger.info(`[DXF] Shared planner placement complete: 5 surrounding blocks emitted`);

  logger.info(`[DXF] Page frame: ${(pageR - pageL).toFixed(0)}m x ${(pageT - pageB).toFixed(0)}m ground`);

  // â”€â”€ Assemble DXF â”€â”€
  const pad = mm(2);
  const eMin = { x: pageL - pad, y: pageB - pad };
  const eMax = { x: pageR + pad, y: pageT + pad };

  let dxf = '';

  // HEADER
  dxf += p(0, 'SECTION');
  dxf += p(2, 'HEADER');
  dxf += p(9, '$ACADVER');
  dxf += p(1, 'AC1009');
  dxf += p(9, '$EXTMIN');
  dxf += p(10, eMin.x.toFixed(4));
  dxf += p(20, eMin.y.toFixed(4));
  dxf += p(9, '$EXTMAX');
  dxf += p(10, eMax.x.toFixed(4));
  dxf += p(20, eMax.y.toFixed(4));
  dxf += p(0, 'ENDSEC');

  // TABLES
  dxf += p(0, 'SECTION');
  dxf += p(2, 'TABLES');

  // LTYPE table
  dxf += p(0, 'TABLE');
  dxf += p(2, 'LTYPE');
  dxf += p(70, '1');
  dxf += p(0, 'LTYPE');
  dxf += p(2, 'CONTINUOUS');
  dxf += p(70, '0');
  dxf += p(3, 'Solid line');
  dxf += p(72, '65');
  dxf += p(73, '0');
  dxf += p(40, '0.0');
  dxf += p(0, 'ENDTAB');

  // LAYER table
  dxf += p(0, 'TABLE');
  dxf += p(2, 'LAYER');
  dxf += p(70, String(layers.length));
  for (const layer of layers) {
    dxf += p(0, 'LAYER');
    dxf += p(2, layer.name);
    dxf += p(70, '0');
    dxf += p(62, String(layer.color));
    dxf += p(6, 'CONTINUOUS');
  }
  dxf += p(0, 'ENDTAB');

  // UCS table — entry retained as an IDENTITY UCS for backward compatibility.
  // The geometry is already plotted north-up east-right in WCS (see
  // capeLoToDxfSouthUp), so CAD_NORTH_UP no longer needs a rotation. Anyone
  // toggling to this UCS gets the same view as the WCS default.
  dxf += p(0, 'TABLE');
  dxf += p(2, 'UCS');
  dxf += p(70, '1');
  dxf += p(0, 'UCS');
  dxf += p(2, 'CAD_NORTH_UP');
  dxf += p(70, '0');
  dxf += p(10, '0.0'); dxf += p(20, '0.0'); dxf += p(30, '0.0');   // origin
  dxf += p(11, '1.0'); dxf += p(21, '0.0'); dxf += p(31, '0.0');   // X axis (identity)
  dxf += p(12, '0.0'); dxf += p(22, '1.0'); dxf += p(32, '0.0');   // Y axis (identity)
  dxf += p(0, 'ENDTAB');

  // STYLE table — STANDARD + BOLD.
  //
  // Group code 41 is the text WIDTH FACTOR — character horizontal scale
  // relative to height. CAD viewers default the STANDARD font (txt.shx)
  // to a 1.0 (square) ratio, which renders characters ~1.8× wider than
  // the Helvetica-style proportions the PDF uses. Visible effect: column
  // contents overflow their layout slots and the schedule / OFD tables
  // appear "wide" even though their geometry matches the PDF exactly.
  //
  // Setting 41 = 0.55 here makes every TEXT entity emit at Helvetica-like
  // proportions. The 0.55 ratio also matches the assumption baked into
  // the DXF placer (dxfLabelPlacer.js `charWidthRatio = 0.55`) and the
  // existing schedule emitter constants — so label-position math now
  // agrees with the actual rendered width.
  const STYLE_WIDTH_FACTOR = '0.55'
  dxf += p(0, 'TABLE');
  dxf += p(2, 'STYLE');
  dxf += p(70, '2');
  // STANDARD style
  dxf += p(0, 'STYLE');
  dxf += p(2, 'STANDARD');
  dxf += p(70, '0');
  dxf += p(40, '0.0');
  dxf += p(41, STYLE_WIDTH_FACTOR);
  dxf += p(50, '0.0');
  dxf += p(71, '0');
  dxf += p(42, '0.0');
  dxf += p(3, 'txt');
  dxf += p(4, '');
  // BOLD style
  dxf += p(0, 'STYLE');
  dxf += p(2, 'BOLD');
  dxf += p(70, '0');
  dxf += p(40, '0.0');
  dxf += p(41, STYLE_WIDTH_FACTOR);
  dxf += p(50, '0.0');
  dxf += p(71, '0');
  dxf += p(42, '0.0');
  dxf += p(3, 'txt');
  dxf += p(4, '');
  dxf += p(0, 'ENDTAB');

  dxf += p(0, 'ENDSEC');

  // ENTITIES
  dxf += p(0, 'SECTION');
  dxf += p(2, 'ENTITIES');
  dxf += ent;
  dxf += p(0, 'ENDSEC');

  // EOF
  dxf += p(0, 'EOF');

  // Degree symbol → DXF control code "%%d". Writing the literal ° (U+00B0) as
  // UTF-8 yields bytes C2 B0, which ANSI/latin1 CAD viewers render as "Â°".
  // "%%d" is pure-ASCII and rendered as ° by every CAD viewer.
  dxf = dxf.replace(/°/g, '%%d');

  const sizeKB = (Buffer.byteLength(dxf, 'utf8') / 1024).toFixed(1);
  logger.info(`[DXF] Generation complete: ${sizeKB} KB, ${parcelCount} parcels, ${beaconCount} beacons, ${edgeLabelCount} edge labels, ${sharedEdges.size} shared edges`);

  return { buffer: Buffer.from(dxf, 'utf8'), warnings };
}
