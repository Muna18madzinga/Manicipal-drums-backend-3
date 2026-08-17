// src/services/gis/styleDoc.js
// ---------------------------------------------------------------------------
// The normalised, renderer-neutral GIS style document -- schema
// `vungu.gis.style/1`. This is THE authoritative symbology payload stored in
// gis_style.definition (migration 114). Every renderer config is COMPILED from
// it; nothing is hand-authored per client:
//
//        QGIS (.qgs/.qml) ─┐
//   statutory schedule ────┼──► styleDoc ──┬──► compileMaplibre() ──► Web GIS
//                  SLD ────┘               ├──► compileQml()      ──► QGIS Desktop/Server
//                                          └──► (future) mobile, ArcGIS
//
// Design rules:
//  * Timestamp-free. The document's checksum must be stable across reads, so
//    all temporal metadata lives in gis_style table columns, never in here.
//  * Colours are always lowercase `#rrggbb` plus a separate 0..1 opacity.
//    QGIS's "r,g,b,a" and CSS `rgba()` are both normalised on the way in, so
//    two styles that mean the same colour always checksum the same.
//  * Widths are carried in the unit the author used (`mm` for QGIS/paper,
//    `px` for screen) and converted at compile time -- never pre-flattened,
//    or QGIS Server and MapLibre would disagree at different DPIs.
// ---------------------------------------------------------------------------

const crypto = require('crypto')

const SCHEMA = 'vungu.gis.style/1'

const GEOMETRIES = ['polygon', 'line', 'point', 'raster']
const RENDERERS = ['single', 'categorized', 'graduated', 'rule_based']
const SYMBOL_KINDS = ['fill', 'line', 'marker']
const FILL_STYLES = ['solid', 'none', 'horizontal', 'vertical', 'cross', 'b_diagonal', 'f_diagonal', 'diagonal_x', 'dense']
const STROKE_STYLES = ['solid', 'no', 'dash', 'dot', 'dash_dot', 'dash_dot_dot']
const MARKER_SHAPES = ['circle', 'square', 'triangle', 'diamond', 'star', 'cross', 'svg']
const FIDELITY = ['direct', 'converted', 'server', 'unsupported']

// Hatched/patterned fills need a raster sprite MapLibre does not have; QGIS
// draws them procedurally. Anything in here forces server rendering.
const PATTERN_FILL_STYLES = FILL_STYLES.filter((s) => s !== 'solid' && s !== 'none')

// QGIS renders in millimetres against a paper DPI; MapLibre in screen pixels.
// 1 mm at the QGIS Server default 96 DPI = 96/25.4 px.
const MM_TO_PX = 96 / 25.4

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))
const round3 = (n) => Math.round(n * 1000) / 1000
const rgbToHex = (r, g, b) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

// ── Colour normalisation ───────────────────────────────────────────────────

/**
 * Accepts QGIS `"r,g,b,a"`, `"r,g,b"`, `#rgb`, `#rrggbb`, `#rrggbbaa`,
 * `rgb()/rgba()`. Returns `{ hex: '#rrggbb', opacity: 0..1 }`, or null for
 * unusable input so callers raise a validation error rather than silently
 * inventing a colour.
 */
function parseColor(raw) {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim().toLowerCase()
  if (!s || s === 'none' || s === 'transparent') return { hex: '#000000', opacity: 0 }

  const hexMatch = /^#([0-9a-f]{3,8})$/.exec(s)
  if (hexMatch) {
    const h = hexMatch[1]
    if (h.length === 3) return { hex: `#${h.split('').map((c) => c + c).join('')}`, opacity: 1 }
    if (h.length === 6) return { hex: `#${h}`, opacity: 1 }
    if (h.length === 8) {
      return { hex: `#${h.slice(0, 6)}`, opacity: round3(parseInt(h.slice(6, 8), 16) / 255) }
    }
    return null
  }

  // rgb(…) / rgba(…) / bare "r,g,b[,a]" (the QGIS Option format)
  const nums = s.replace(/^rgba?\(/, '').replace(/\)$/, '').split(',').map((p) => p.trim())
  if (nums.length >= 3 && nums.slice(0, 3).every((n) => n !== '' && !Number.isNaN(Number(n)))) {
    const [r, g, b] = nums.slice(0, 3).map((n) => clamp(Math.round(Number(n)), 0, 255))
    // QGIS writes alpha 0-255; CSS rgba() writes 0-1. A 4th component above 1
    // can only be the 0-255 form.
    let opacity = 1
    if (nums.length >= 4 && nums[3] !== '' && !Number.isNaN(Number(nums[3]))) {
      const a = Number(nums[3])
      opacity = a > 1 ? round3(clamp(a, 0, 255) / 255) : round3(clamp(a, 0, 1))
    }
    return { hex: rgbToHex(r, g, b), opacity }
  }

  return null
}

/** styleDoc hex + opacity -> the QGIS `"r,g,b,a"` Option string. */
function toQgisRgba(hex, opacity = 1) {
  const h = (hex || '#000000').replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) || 0
  const g = parseInt(h.slice(2, 4), 16) || 0
  const b = parseInt(h.slice(4, 6), 16) || 0
  return `${r},${g},${b},${Math.round(clamp(Number(opacity), 0, 1) * 255)}`
}

/** Width in a declared unit -> screen pixels. */
function toPx(width, unit) {
  const w = Number(width)
  if (!Number.isFinite(w)) return 0
  return unit === 'mm' ? round3(w * MM_TO_PX) : round3(w)
}

// ── Symbol constructors ────────────────────────────────────────────────────

function fillSymbol(o = {}) {
  const fill = parseColor(o.fill ?? '#cccccc') || { hex: '#cccccc', opacity: 1 }
  const stroke = o.stroke === null ? null : parseColor(o.stroke ?? '#232323')
  return {
    kind: 'fill',
    fill: fill.hex,
    fillOpacity: o.fillOpacity !== undefined ? round3(clamp(Number(o.fillOpacity), 0, 1)) : fill.opacity,
    fillStyle: FILL_STYLES.includes(o.fillStyle) ? o.fillStyle : 'solid',
    stroke: stroke ? stroke.hex : null,
    strokeOpacity: stroke
      ? (o.strokeOpacity !== undefined ? round3(clamp(Number(o.strokeOpacity), 0, 1)) : stroke.opacity)
      : 0,
    strokeWidth: o.strokeWidth !== undefined ? Number(o.strokeWidth) : 0.26,
    strokeUnit: o.strokeUnit === 'px' ? 'px' : 'mm',
    strokeStyle: STROKE_STYLES.includes(o.strokeStyle) ? o.strokeStyle : 'solid',
    ...(o.strokeDashArray ? { strokeDashArray: o.strokeDashArray.map(Number) } : {}),
  }
}

function lineSymbol(o = {}) {
  const stroke = parseColor(o.stroke ?? '#232323') || { hex: '#232323', opacity: 1 }
  return {
    kind: 'line',
    stroke: stroke.hex,
    strokeOpacity: o.strokeOpacity !== undefined ? round3(clamp(Number(o.strokeOpacity), 0, 1)) : stroke.opacity,
    strokeWidth: o.strokeWidth !== undefined ? Number(o.strokeWidth) : 0.26,
    strokeUnit: o.strokeUnit === 'px' ? 'px' : 'mm',
    strokeStyle: STROKE_STYLES.includes(o.strokeStyle) ? o.strokeStyle : 'solid',
    cap: ['butt', 'round', 'square'].includes(o.cap) ? o.cap : 'round',
    join: ['bevel', 'round', 'miter'].includes(o.join) ? o.join : 'round',
    ...(o.strokeDashArray ? { strokeDashArray: o.strokeDashArray.map(Number) } : {}),
    // A statutory road is an inked line over a paper halo -- two MapLibre
    // layers, one symbol. Carried here so the pair can never drift.
    ...(o.casing
      ? {
          casing: {
            stroke: (parseColor(o.casing.stroke) || { hex: '#ffffff' }).hex,
            strokeWidth: Number(o.casing.strokeWidth),
            strokeUnit: o.casing.strokeUnit === 'px' ? 'px' : 'mm',
          },
        }
      : {}),
  }
}

function markerSymbol(o = {}) {
  const fill = parseColor(o.fill ?? '#7b6b55') || { hex: '#7b6b55', opacity: 1 }
  const stroke = o.stroke === null ? null : parseColor(o.stroke ?? '#ffffff')
  return {
    kind: 'marker',
    shape: MARKER_SHAPES.includes(o.shape) ? o.shape : 'circle',
    ...(o.svgPath ? { svgPath: String(o.svgPath) } : {}),
    size: o.size !== undefined ? Number(o.size) : 2,
    sizeUnit: o.sizeUnit === 'px' ? 'px' : 'mm',
    fill: fill.hex,
    fillOpacity: o.fillOpacity !== undefined ? round3(clamp(Number(o.fillOpacity), 0, 1)) : fill.opacity,
    stroke: stroke ? stroke.hex : null,
    strokeWidth: o.strokeWidth !== undefined ? Number(o.strokeWidth) : 0,
    strokeUnit: o.strokeUnit === 'px' ? 'px' : 'mm',
  }
}

/** Builds a symbol of the right kind for a geometry. */
function symbolFor(geometry, o = {}) {
  if (o.kind && SYMBOL_KINDS.includes(o.kind)) {
    if (o.kind === 'fill') return fillSymbol(o)
    if (o.kind === 'line') return lineSymbol(o)
    return markerSymbol(o)
  }
  if (geometry === 'polygon') return fillSymbol(o)
  if (geometry === 'line') return lineSymbol(o)
  return markerSymbol(o)
}

/**
 * A zoom-scaling curve for line widths.
 *
 * Cartographic linework must thicken as you zoom in or a road hierarchy becomes
 * illegible at one end of the range. QGIS expresses this with a reference scale
 * (symbol sizes scale relative to `referencescale`); MapLibre with an
 * `interpolate` expression. Both are driven from these numbers, so the two
 * renderers thicken identically instead of each having its own curve.
 *
 * Widths in the symbols are the width AT `refZoom`; every other zoom is
 * `width * base^(zoom - refZoom)`.
 */
function zoomScale(o = {}) {
  return {
    base: o.base !== undefined ? Number(o.base) : 1.4,
    refZoom: o.refZoom !== undefined ? Number(o.refZoom) : 13,
    minZoom: o.minZoom !== undefined ? Number(o.minZoom) : 8,
    maxZoom: o.maxZoom !== undefined ? Number(o.maxZoom) : 19,
  }
}

/**
 * A zoom-varying opacity ramp: [{ zoom, value }, …] in ascending zoom.
 *
 * Real cartography fades layers in and out with scale -- a province colour wash
 * that is useful at country zoom becomes noise at street zoom, and admin
 * boundaries recede as detail arrives. QGIS does this with per-scale symbol
 * levels; MapLibre with an interpolate expression. Both come from these stops.
 */
function opacityCurve(stops) {
  return (stops || [])
    .map((s) => ({ zoom: Number(s.zoom), value: round3(clamp(Number(s.value), 0, 1)) }))
    .filter((s) => Number.isFinite(s.zoom))
    .sort((a, b) => a.zoom - b.zoom)
}

/** Assembles a style document. */
function styleDoc({
  layerId, geometry, renderer, labels = null,
  minZoom = null, maxZoom = null, opacity = 1, notes = null,
}) {
  return {
    schema: SCHEMA,
    layerId,
    geometry,
    renderer,
    labels,
    scale: { minZoom, maxZoom },
    opacity: round3(clamp(Number(opacity), 0, 1)),
    ...(notes ? { notes } : {}),
  }
}

// ── Canonical serialisation + checksum ─────────────────────────────────────

/** Deterministic JSON: object keys sorted recursively, arrays left in order. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
}

/** sha256 over the canonical form. Two equivalent styles hash identically. */
function checksum(doc) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(doc)).digest('hex')}`
}

// ── Validation ─────────────────────────────────────────────────────────────

/**
 * Structural validation. Returns { valid, errors[], warnings[] }.
 * A style that fails here must never be published -- the API and the seed
 * script both gate on it.
 */
function validate(doc) {
  const errors = []
  const warnings = []
  const err = (m) => errors.push(m)

  if (!doc || typeof doc !== 'object') {
    return { valid: false, errors: ['style document is not an object'], warnings }
  }
  if (doc.schema !== SCHEMA) err(`schema must be "${SCHEMA}" (got ${JSON.stringify(doc.schema)})`)
  if (!doc.layerId) err('layerId is required')
  if (!GEOMETRIES.includes(doc.geometry)) err(`geometry must be one of ${GEOMETRIES.join('|')}`)
  if (typeof doc.opacity !== 'number' || doc.opacity < 0 || doc.opacity > 1) {
    err('opacity must be a number in 0..1')
  }

  const r = doc.renderer
  if (!r || typeof r !== 'object') {
    err('renderer is required')
    return { valid: false, errors, warnings }
  }
  if (!RENDERERS.includes(r.type)) err(`renderer.type must be one of ${RENDERERS.join('|')}`)

  const isHex = (v) => /^#[0-9a-f]{6}$/.test(String(v))
  const checkSymbol = (sym, where) => {
    if (!sym || typeof sym !== 'object') { err(`${where}: symbol is required`); return }
    if (!SYMBOL_KINDS.includes(sym.kind)) {
      err(`${where}: symbol.kind must be one of ${SYMBOL_KINDS.join('|')}`)
      return
    }
    if (sym.kind === 'fill' || sym.kind === 'marker') {
      if (!isHex(sym.fill)) err(`${where}: fill must be #rrggbb (got ${JSON.stringify(sym.fill)})`)
      if (sym.stroke !== null && !isHex(sym.stroke)) err(`${where}: stroke must be #rrggbb or null`)
    }
    if (sym.kind === 'line') {
      if (!isHex(sym.stroke)) err(`${where}: stroke must be #rrggbb (got ${JSON.stringify(sym.stroke)})`)
      if (!(Number(sym.strokeWidth) >= 0)) err(`${where}: strokeWidth must be >= 0`)
      if (sym.casing && !isHex(sym.casing.stroke)) err(`${where}: casing.stroke must be #rrggbb`)
    }
    if (sym.kind === 'marker') {
      if (!(Number(sym.size) > 0)) err(`${where}: marker size must be > 0`)
      if (sym.shape === 'svg' && !sym.svgPath) {
        err(`${where}: marker shape is "svg" but svgPath is missing -- the referenced symbol cannot be resolved`)
      }
    }
  }

  switch (r.type) {
    case 'single':
      checkSymbol(r.symbol, 'renderer.symbol')
      break

    case 'categorized': {
      if (!r.attribute) err('categorized renderer requires renderer.attribute')
      if (!Array.isArray(r.categories) || r.categories.length === 0) {
        err('categorized renderer requires a non-empty renderer.categories')
        break
      }
      const seen = new Map()
      r.categories.forEach((cat, i) => {
        if (cat.value === undefined) err(`renderer.categories[${i}]: value is required`)
        checkSymbol(cat.symbol, `renderer.categories[${i}]`)
        const key = String(cat.value)
        if (seen.has(key)) {
          err(`renderer.categories: duplicate value ${JSON.stringify(key)} at indices ${seen.get(key)} and ${i} -- classification is ambiguous`)
        } else seen.set(key, i)
      })
      // "One symbol = one thing": two classes sharing a colour is the exact
      // defect that disqualified the hand-authored QGIS project as authority
      // (High Density Residential and Economic Corridor were both #ffff00).
      // A warning, not an error -- some schedules legitimately share a colour
      // and distinguish by hatch.
      const byColour = new Map()
      r.categories.forEach((cat) => {
        const sig = `${cat.symbol?.fill || cat.symbol?.stroke}|${cat.symbol?.fillStyle || ''}`
        if (!byColour.has(sig)) byColour.set(sig, [])
        byColour.get(sig).push(String(cat.label ?? cat.value))
      })
      for (const [sig, labels] of byColour) {
        if (labels.length > 1) {
          warnings.push(`colour ${sig.split('|')[0]} is shared by ${labels.length} classes (${labels.join(', ')}) -- "one symbol = one thing" is not satisfied unless they differ by hatch`)
        }
      }
      if (!r.fallback) warnings.push('categorized renderer has no fallback -- unclassified features will not draw')
      else checkSymbol(r.fallback.symbol, 'renderer.fallback')
      break
    }

    case 'graduated': {
      if (!r.attribute) err('graduated renderer requires renderer.attribute')
      if (!Array.isArray(r.ranges) || r.ranges.length === 0) {
        err('graduated renderer requires a non-empty renderer.ranges')
        break
      }
      let prevUpper = null
      r.ranges.forEach((rg, i) => {
        const lo = Number(rg.lower)
        const hi = Number(rg.upper)
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
          err(`renderer.ranges[${i}]: lower/upper must be finite numbers`)
        } else if (hi < lo) {
          err(`renderer.ranges[${i}]: upper (${hi}) is below lower (${lo})`)
        }
        if (prevUpper !== null && Number.isFinite(lo) && lo < prevUpper) {
          err(`renderer.ranges[${i}]: overlaps the previous range (lower ${lo} < previous upper ${prevUpper}) -- classification is ambiguous`)
        }
        if (Number.isFinite(hi)) prevUpper = hi
        checkSymbol(rg.symbol, `renderer.ranges[${i}]`)
      })
      break
    }

    case 'rule_based': {
      if (!Array.isArray(r.rules) || r.rules.length === 0) {
        err('rule_based renderer requires a non-empty renderer.rules')
        break
      }
      r.rules.forEach((rule, i) => {
        checkSymbol(rule.symbol, `renderer.rules[${i}]`)
        if (rule.filter !== null && rule.filter !== undefined && typeof rule.filter !== 'string') {
          err(`renderer.rules[${i}]: filter must be a QGIS expression string or null`)
        }
      })
      break
    }
    default:
      break
  }

  const { minZoom, maxZoom } = doc.scale || {}
  if (minZoom != null && maxZoom != null && Number(minZoom) > Number(maxZoom)) {
    err(`scale.minZoom (${minZoom}) is above scale.maxZoom (${maxZoom})`)
  }

  if (doc.labels) {
    if (!doc.labels.field && !doc.labels.expression) {
      err('labels: either field or expression is required')
    }
    if (doc.labels.expression && !doc.labels.field) {
      warnings.push('labels use a QGIS expression -- MapLibre can only reference a field, so labels must be rendered server-side')
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

// ── Fidelity classification ────────────────────────────────────────────────

/** Walks every symbol in a document with a human-readable path. */
function collectSymbols(doc) {
  const out = []
  const r = doc?.renderer
  if (!r) return out
  if (r.symbol) out.push({ symbol: r.symbol, where: 'renderer.symbol' })
  for (const c of r.categories || []) {
    if (c.symbol) out.push({ symbol: c.symbol, where: `category "${c.label ?? c.value}"` })
  }
  if (r.fallback?.symbol) out.push({ symbol: r.fallback.symbol, where: 'renderer.fallback' })
  ;(r.ranges || []).forEach((rg, i) => {
    if (rg.symbol) out.push({ symbol: rg.symbol, where: `range[${i}] ${rg.lower}-${rg.upper}` })
  })
  ;(r.rules || []).forEach((rule, i) => {
    if (rule.symbol) out.push({ symbol: rule.symbol, where: `rule[${i}] ${rule.label || rule.filter || ''}` })
  })
  return out
}

/** True for filters MapLibre can express: field op literal, joined by and/or. */
function isSimpleFilter(filter) {
  const f = String(filter).trim()
  if (!f) return true
  if (/[a-z_]+\s*\(/i.test(f)) return false                      // function call
  if (/@|\$|\bintersects\b|\bwithin\b|\bbuffer\b/i.test(f)) return false // variable / geometry op
  return /^[\w"' .,<>=!*%-]+(\s+(and|or)\s+[\w"' .,<>=!*%-]+)*$/i.test(f)
}

/**
 * Decides how faithfully MapLibre can draw this document, and why. This is the
 * mechanism that stops the system inventing a visually different approximation
 * for QGIS symbology MapLibre cannot express: anything above `converted` is
 * routed to QGIS Server WMS instead of vector tiles.
 *
 *   direct      -- MapLibre paint properties express it exactly
 *   converted   -- expressible after a documented transformation
 *                  (graduated -> step expression, mm -> px, dash patterns)
 *   server      -- must be rasterised by QGIS Server to look right
 *   unsupported -- cannot be rendered faithfully anywhere; blocked from publish
 */
function classifyFidelity(doc) {
  const notes = []
  let level = 'direct'
  const raise = (to, note) => {
    notes.push({ level: to, note })
    if (FIDELITY.indexOf(to) > FIDELITY.indexOf(level)) level = to
  }

  for (const { symbol: s, where } of collectSymbols(doc)) {
    if (s.kind === 'fill' && PATTERN_FILL_STYLES.includes(s.fillStyle)) {
      raise('server', `${where}: fill style "${s.fillStyle}" is a procedural hatch; MapLibre needs a raster fill-pattern sprite, so this layer renders via QGIS Server WMS`)
    }
    if (s.kind === 'marker' && s.shape === 'svg') {
      raise('server', `${where}: SVG marker "${s.svgPath}" has no MapLibre equivalent without a generated sprite sheet`)
    }
    if (s.kind === 'marker' && !['circle', 'svg'].includes(s.shape)) {
      raise('converted', `${where}: marker shape "${s.shape}" is drawn as a MapLibre circle unless a sprite is generated`)
    }
    if (s.strokeUnit === 'mm' || s.sizeUnit === 'mm') {
      raise('converted', `${where}: millimetre widths converted to pixels at ${round3(MM_TO_PX)} px/mm (96 DPI)`)
    }
    if (s.strokeStyle && !['solid', 'no'].includes(s.strokeStyle) && !s.strokeDashArray) {
      raise('converted', `${where}: QGIS stroke style "${s.strokeStyle}" mapped to a MapLibre line-dasharray`)
    }
  }

  const r = doc.renderer || {}
  if (r.type === 'graduated') {
    raise('converted', 'graduated renderer compiled to a MapLibre `step` expression over the classification attribute')
  }
  if (r.zoomScale) {
    raise('converted', `line widths scale with zoom (base ${r.zoomScale.base} about z${r.zoomScale.refZoom}); MapLibre uses an interpolate expression, QGIS a reference scale of 1:${Math.round(559082264.028 / 2 ** r.zoomScale.refZoom)}`)
  }
  if (r.opacityCurve?.length) {
    raise('converted', `opacity varies with zoom across ${r.opacityCurve.length} stops (z${r.opacityCurve[0].zoom}–z${r.opacityCurve[r.opacityCurve.length - 1].zoom}); MapLibre interpolates, QGIS needs per-scale symbol levels`)
  }
  if (r.type === 'rule_based') {
    const complex = (r.rules || []).some((rule) => rule.filter && !isSimpleFilter(rule.filter))
    raise(complex ? 'server' : 'converted',
      complex
        ? 'rule-based renderer uses QGIS expressions beyond simple attribute comparisons; rendered by QGIS Server so the rules evaluate identically'
        : 'rule-based renderer compiled to MapLibre filter expressions')
  }
  if (r.blendMode && r.blendMode !== 'normal') {
    raise('server', `layer blend mode "${r.blendMode}" is not available in MapLibre`)
  }
  if (r.dataDefined && Object.keys(r.dataDefined).length) {
    raise('server', `data-defined overrides (${Object.keys(r.dataDefined).join(', ')}) are evaluated by the QGIS expression engine`)
  }
  if (r.geometryGenerator) {
    raise('unsupported', 'geometry-generator symbology derives new geometry at draw time; neither vector tiles nor a WMS of the source layer reproduces it -- the generated geometry must be materialised as its own PostGIS layer')
  }
  if (doc.labels?.expression && !doc.labels?.field) {
    raise('server', 'label text comes from a QGIS expression rather than a plain field')
  }

  return { level, notes }
}

module.exports = {
  SCHEMA,
  GEOMETRIES,
  RENDERERS,
  SYMBOL_KINDS,
  FILL_STYLES,
  STROKE_STYLES,
  MARKER_SHAPES,
  FIDELITY,
  PATTERN_FILL_STYLES,
  MM_TO_PX,
  parseColor,
  toQgisRgba,
  toPx,
  fillSymbol,
  lineSymbol,
  markerSymbol,
  symbolFor,
  zoomScale,
  opacityCurve,
  styleDoc,
  canonicalJson,
  checksum,
  validate,
  classifyFidelity,
  collectSymbols,
  isSimpleFilter,
}
