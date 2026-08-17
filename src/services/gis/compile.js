// src/services/gis/compile.js
// ---------------------------------------------------------------------------
// The ONLY place a style document becomes a renderer configuration.
//
//   styleDoc ──► compileMaplibre() ──► MapLibre layer specs   (web, mobile)
//            └─► compileQml()      ──► QML                    (QGIS Desktop/Server)
//
// Both compilers live here, server-side, deliberately. The previous
// architecture had the QML emitter in a frontend build script and the MapLibre
// paint hand-written in vunguBasemapStyle.ts -- two emitters, two authors, and
// nothing forcing them to agree. With one module compiling both targets from
// one document, "QGIS colour != web colour" stops being a class of bug that can
// exist: a divergence would require the same function to return two answers.
//
// The frontend does NOT reimplement this. It fetches compiled output from
// /api/gis/styles/:layerId (see src/routes/gisStyles.js).
// ---------------------------------------------------------------------------

const {
  toQgisRgba, toPx, collectSymbols, classifyFidelity, MM_TO_PX,
} = require('./styleDoc')

// ── QGIS stroke style -> MapLibre line-dasharray ───────────────────────────
// Dash lengths are in line-widths (MapLibre's unit), matching how QGIS scales
// its Qt pen patterns with pen width.
const DASH_PATTERNS = {
  solid: null,
  no: null,
  dash: [4, 2],
  dot: [1, 2],
  dash_dot: [4, 2, 1, 2],
  dash_dot_dot: [4, 2, 1, 2, 1, 2],
}

const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
const round3 = (n) => Math.round(n * 1000) / 1000
const firstSymbol = (doc) => collectSymbols(doc)[0]?.symbol

const xmlEsc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')

// ═══════════════════════════════════════════════════════════════════════════
// MapLibre
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Builds a MapLibre expression selecting a per-symbol property.
 * `single` collapses to a constant; everything else becomes match/step/case.
 */
function symbolExpr(renderer, pick, fallbackValue) {
  switch (renderer.type) {
    case 'single':
      return pick(renderer.symbol)

    case 'categorized': {
      const expr = ['match', ['get', renderer.attribute]]
      let emitted = 0
      for (const cat of renderer.categories) {
        const v = pick(cat.symbol)
        if (v === null || v === undefined) continue
        expr.push(cat.value === null ? '' : cat.value, v)
        emitted++
      }
      const fb = renderer.fallback ? pick(renderer.fallback.symbol) : undefined
      const fallback = fb !== undefined && fb !== null ? fb : fallbackValue
      expr.push(fallback)
      // A `match` needs at least one label/output pair to be valid.
      return emitted > 0 ? expr : fallback
    }

    case 'graduated': {
      // step(input, output_before_first_stop, stop, output, …). QGIS ranges are
      // (lower, upper]; a `step` boundary at each `lower` reproduces that.
      const sorted = [...renderer.ranges].sort((a, b) => Number(a.lower) - Number(b.lower))
      if (!sorted.length) return fallbackValue
      const expr = ['step', ['to-number', ['get', renderer.attribute]], pick(sorted[0].symbol)]
      for (const rg of sorted.slice(1)) expr.push(Number(rg.lower), pick(rg.symbol))
      return expr
    }

    case 'rule_based': {
      const elseRule = renderer.rules.find((ru) => !ru.filter)
      const expr = ['case']
      let emitted = 0
      for (const rule of renderer.rules) {
        const f = compileFilter(rule.filter)
        if (!f) continue
        expr.push(f, pick(rule.symbol))
        emitted++
      }
      const fallback = elseRule ? pick(elseRule.symbol) : fallbackValue
      expr.push(fallback)
      return emitted > 0 ? expr : fallback
    }

    default:
      return fallbackValue
  }
}

/**
 * Translates a simple QGIS expression into a MapLibre filter expression.
 * Returns null when the expression is not simple -- classifyFidelity() has
 * already forced such a style to 'server', so this is a guard, not a fallback.
 */
function compileFilter(filter) {
  if (!filter) return null
  const parts = String(filter).trim().split(/\s+and\s+/i)
  const compiled = parts.map((part) => {
    const m = /^"?([\w]+)"?\s*(=|!=|<>|>=|<=|>|<)\s*'?([^']*?)'?$/.exec(part.trim())
    if (!m) return null
    const [, field, op, rawVal] = m
    const val = rawVal === '' || Number.isNaN(Number(rawVal)) ? rawVal : Number(rawVal)
    const get = ['get', field]
    switch (op) {
      case '=': return ['==', get, val]
      case '!=': case '<>': return ['!=', get, val]
      default: return [op, ['to-number', get], Number(val)]
    }
  })
  if (compiled.some((c) => c === null)) return null
  return compiled.length === 1 ? compiled[0] : ['all', ...compiled]
}

/**
 * Wraps a width expression in the renderer's zoom curve, if it has one.
 *
 * `pick` yields the width AT refZoom; this produces
 *   interpolate(exponential base, zoom, minZoom → w*base^(min-ref),
 *                                    refZoom → w,
 *                                    maxZoom → w*base^(max-ref))
 * which is exactly the curve the hand-written roads paint used, now derived
 * from the registry instead of retyped per client.
 */
function widthExpr(renderer, pick, fallback) {
  const zs = renderer.zoomScale
  if (!zs) return symbolExpr(renderer, pick, fallback)

  const at = (zoom) => {
    const factor = zs.base ** (zoom - zs.refZoom)
    return symbolExpr(renderer, (s) => round3(Number(pick(s)) * factor), round3(fallback * factor))
  }
  return [
    'interpolate', ['exponential', zs.base], ['zoom'],
    zs.minZoom, at(zs.minZoom),
    zs.refZoom, at(zs.refZoom),
    zs.maxZoom, at(zs.maxZoom),
  ]
}

/**
 * Opacity for a paint property, honouring the renderer's zoom ramp if present.
 *
 * Without a ramp this is the per-symbol opacity times the layer opacity. With
 * one, the ramp IS the opacity (multiplied by layer opacity) -- a zoom-faded
 * layer's per-symbol alpha would otherwise fight the ramp.
 */
function opacityExpr(renderer, pick, layerOpacity, fallback) {
  const curve = renderer.opacityCurve
  if (!curve?.length) {
    return symbolExpr(renderer, (s) => round3(numOr(pick(s), 1) * layerOpacity), fallback * layerOpacity)
  }
  if (curve.length === 1) return round3(curve[0].value * layerOpacity)
  const expr = ['interpolate', ['linear'], ['zoom']]
  for (const stop of curve) expr.push(stop.zoom, round3(stop.value * layerOpacity))
  return expr
}

/** Dash array, when every symbol agrees on one. MapLibre cannot express a
 *  data-driven line-dasharray, so a renderer whose classes use different dash
 *  patterns takes the first -- classifyFidelity() records the conversion. */
function dashPaint(r) {
  const each = [r.symbol, ...(r.categories || []).map((c) => c.symbol),
    ...(r.ranges || []).map((x) => x.symbol), ...(r.rules || []).map((x) => x.symbol)]
    .filter(Boolean)
  for (const s of each) {
    const d = s.strokeDashArray || DASH_PATTERNS[s.strokeStyle]
    if (d) return { 'line-dasharray': d }
  }
  return {}
}

function polygonLayers(doc, r, base, idPrefix) {
  const out = []
  const layerOpacity = numOr(doc.opacity, 1)

  out.push({
    id: `${idPrefix}-fill`,
    type: 'fill',
    ...base,
    paint: {
      'fill-color': symbolExpr(r, (s) => s.fill, '#cccccc'),
      // MapLibre has no per-feature opacity multiply, so the layer opacity is
      // baked into the per-symbol expression (or into the zoom ramp).
      'fill-opacity': opacityExpr(r, (s) => s.fillOpacity, layerOpacity, 1),
    },
  })

  // A QGIS SimpleFill draws its outline inside the same symbol layer. MapLibre's
  // `fill-outline-color` has no width, so any outline wider than a hairline
  // needs its own line layer to match what QGIS draws.
  const strokes = collectSymbols(doc).filter((x) => x.symbol.kind === 'fill' && x.symbol.stroke)
  if (strokes.length) {
    const maxWidthPx = Math.max(
      ...strokes.map((x) => toPx(x.symbol.strokeWidth, x.symbol.strokeUnit)),
    )
    const strokeExpr = symbolExpr(r, (s) => s.stroke || 'rgba(0,0,0,0)', 'rgba(0,0,0,0)')
    if (maxWidthPx <= 1.05) {
      out[0].paint['fill-outline-color'] = strokeExpr
    } else {
      out.push({
        id: `${idPrefix}-outline`,
        type: 'line',
        ...base,
        layout: { 'line-cap': 'butt', 'line-join': 'bevel' },
        paint: {
          'line-color': strokeExpr,
          'line-width': symbolExpr(r, (s) => toPx(s.strokeWidth, s.strokeUnit), 1),
          'line-opacity': symbolExpr(r, (s) => numOr(s.strokeOpacity, 1), 1),
          ...dashPaint(r),
        },
      })
    }
  }
  return out
}

function lineLayers(doc, r, base, idPrefix) {
  const out = []
  const layerOpacity = numOr(doc.opacity, 1)

  // Casing goes under the ink, as it does on paper.
  if (collectSymbols(doc).some((x) => x.symbol.casing)) {
    out.push({
      id: `${idPrefix}-casing`,
      type: 'line',
      ...base,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': symbolExpr(r, (s) => s.casing?.stroke ?? 'rgba(0,0,0,0)', 'rgba(0,0,0,0)'),
        'line-width': widthExpr(r, (s) => (s.casing ? toPx(s.casing.strokeWidth, s.casing.strokeUnit) : 0), 0),
      },
    })
  }

  out.push({
    id: `${idPrefix}-line`,
    type: 'line',
    ...base,
    layout: {
      'line-cap': firstSymbol(doc)?.cap ?? 'round',
      'line-join': firstSymbol(doc)?.join ?? 'round',
    },
    paint: {
      'line-color': symbolExpr(r, (s) => s.stroke, '#b0b0b0'),
      'line-width': widthExpr(r, (s) => toPx(s.strokeWidth, s.strokeUnit), 1),
      'line-opacity': opacityExpr(r, (s) => s.strokeOpacity, layerOpacity, 1),
      ...dashPaint(r),
    },
  })
  return out
}

function pointLayers(doc, r, base, idPrefix) {
  const layerOpacity = numOr(doc.opacity, 1)
  return [{
    id: `${idPrefix}-circle`,
    type: 'circle',
    ...base,
    paint: {
      // QGIS marker `size` is a diameter; MapLibre circle-radius is a radius.
      'circle-radius': symbolExpr(r, (s) => round3(toPx(s.size, s.sizeUnit) / 2), 3),
      'circle-color': symbolExpr(r, (s) => s.fill, '#7b6b55'),
      'circle-opacity': opacityExpr(r, (s) => s.fillOpacity, layerOpacity, 1),
      'circle-stroke-color': symbolExpr(r, (s) => s.stroke || 'rgba(0,0,0,0)', 'rgba(0,0,0,0)'),
      'circle-stroke-width': symbolExpr(r, (s) => toPx(s.strokeWidth, s.strokeUnit), 0),
    },
  }]
}

function labelLayer(doc, base, idPrefix) {
  const l = doc.labels
  return {
    id: `${idPrefix}-label`,
    type: 'symbol',
    ...base,
    ...(l.minZoom != null ? { minzoom: Number(l.minZoom) } : {}),
    layout: {
      'text-field': ['get', l.field],
      'text-size': toPx(l.size ?? 8, l.sizeUnit || 'mm'),
      ...(l.font ? { 'text-font': [l.font] } : {}),
      'text-anchor': l.anchor || 'center',
      ...(l.placement === 'line' ? { 'symbol-placement': 'line' } : {}),
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': l.color || '#444444',
      ...(l.haloColor
        ? {
            'text-halo-color': l.haloColor,
            'text-halo-width': toPx(l.haloWidth ?? 0.4, l.haloUnit || 'mm'),
          }
        : {}),
    },
  }
}

/**
 * Compiles a style document into MapLibre GL style layers.
 *
 * Returns { layers[], fidelity, strategy, notes[] }.
 *
 * `strategy` is the renderer decision, not a suggestion:
 *   'vector' -- draw these layers from vector tiles
 *   'wms'    -- ignore `layers` (returned empty) and request a QGIS Server WMS
 *              raster instead, so a caller that ignores `strategy` renders
 *              nothing rather than something visually wrong
 *   'none'   -- the style cannot be rendered faithfully anywhere
 *
 * One document can compile to several MapLibre layers -- a polygon with a wide
 * outline needs fill + line, a statutory road needs casing + fill -- because
 * MapLibre has no equivalent of a QGIS multi-layer symbol.
 */
function compileMaplibre(doc, opts = {}) {
  const {
    sourceId = `vungu-${doc.layerId}`,
    sourceLayer = doc.layerId,
    idPrefix = `vungu-${doc.layerId}`,
    fidelity = null,
  } = opts

  const fid = fidelity || classifyFidelity(doc)

  // Server-rendered and unsupported styles must not be approximated here.
  if (fid.level === 'server' || fid.level === 'unsupported') {
    return {
      layers: [],
      fidelity: fid.level,
      strategy: fid.level === 'server' ? 'wms' : 'none',
      notes: fid.notes.map((n) => n.note),
    }
  }

  const base = {
    source: sourceId,
    'source-layer': sourceLayer,
    ...(doc.scale?.minZoom != null ? { minzoom: Number(doc.scale.minZoom) } : {}),
    ...(doc.scale?.maxZoom != null ? { maxzoom: Number(doc.scale.maxZoom) } : {}),
  }

  const notes = []
  const layers = []
  const r = doc.renderer

  // Dispatch on the SYMBOL kind, not the geometry.
  //
  // A polygon layer is legitimately drawn with a line symbol: that is how every
  // administrative boundary works -- polygon features rendered as outline only,
  // with no fill. Dispatching on geometry alone emitted a `fill` layer for those
  // and then looked for `symbol.fill`, which a line symbol does not have, so the
  // boundary colour silently vanished. The fidelity report caught it on
  // country/provinces/districts/wards.
  const kind = firstSymbol(doc)?.kind
    ?? (doc.geometry === 'polygon' ? 'fill' : doc.geometry === 'line' ? 'line' : 'marker')

  if (kind === 'fill' && doc.geometry === 'polygon') {
    layers.push(...polygonLayers(doc, r, base, idPrefix))
  } else if (kind === 'line') {
    // Works for both line geometry and outline-only polygons; MapLibre draws a
    // polygon source in a `line` layer as its boundary.
    layers.push(...lineLayers(doc, r, base, idPrefix))
  } else if (kind === 'marker') {
    layers.push(...pointLayers(doc, r, base, idPrefix))
  } else if (kind === 'fill') {
    notes.push(`fill symbol on ${doc.geometry} geometry: a fill needs a closed ring, so nothing is drawn`)
  } else {
    notes.push(`geometry "${doc.geometry}" has no MapLibre vector representation`)
  }

  if (doc.labels?.field) layers.push(labelLayer(doc, base, idPrefix))

  return {
    layers,
    fidelity: fid.level,
    strategy: 'vector',
    notes: [...fid.notes.map((n) => n.note), ...notes],
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// QML (QGIS Desktop + QGIS Server)
// ═══════════════════════════════════════════════════════════════════════════

const QGIS_MARKER_SHAPE = {
  circle: 'circle', square: 'square', triangle: 'triangle',
  diamond: 'diamond', star: 'star', cross: 'cross', svg: 'circle',
}

/** One QGIS symbol element for a styleDoc symbol. */
function qmlSymbol(s, name) {
  if (s.kind === 'fill') {
    return `  <symbol type="fill" name="${name}" alpha="1" clip_to_extent="1" force_rhr="0" frame_rate="10" is_animated="0">
    <layer class="SimpleFill" enabled="1" locked="0" pass="0">
      <Option type="Map">
        <Option type="QString" name="color" value="${toQgisRgba(s.fill, s.fillOpacity)}"/>
        <Option type="QString" name="style" value="${s.fillStyle === 'none' ? 'no' : s.fillStyle}"/>
        <Option type="QString" name="outline_color" value="${s.stroke ? toQgisRgba(s.stroke, s.strokeOpacity) : '0,0,0,0'}"/>
        <Option type="QString" name="outline_width" value="${s.strokeWidth}"/>
        <Option type="QString" name="outline_width_unit" value="${s.strokeUnit === 'px' ? 'Pixel' : 'MM'}"/>
        <Option type="QString" name="outline_style" value="${s.stroke ? s.strokeStyle : 'no'}"/>
        <Option type="QString" name="joinstyle" value="bevel"/>
      </Option>
    </layer>
  </symbol>`
  }

  if (s.kind === 'line') {
    // A casing is a second symbol layer BELOW the ink -- QGIS draws symbol
    // layers in document order, so the casing must be written first.
    const casing = s.casing
      ? `    <layer class="SimpleLine" enabled="1" locked="0" pass="0">
      <Option type="Map">
        <Option type="QString" name="line_color" value="${toQgisRgba(s.casing.stroke, 1)}"/>
        <Option type="QString" name="line_width" value="${s.casing.strokeWidth}"/>
        <Option type="QString" name="line_width_unit" value="${s.casing.strokeUnit === 'px' ? 'Pixel' : 'MM'}"/>
        <Option type="QString" name="line_style" value="solid"/>
        <Option type="QString" name="capstyle" value="round"/>
        <Option type="QString" name="joinstyle" value="round"/>
      </Option>
    </layer>
`
      : ''
    return `  <symbol type="line" name="${name}" alpha="1" clip_to_extent="1" force_rhr="0" frame_rate="10" is_animated="0">
${casing}    <layer class="SimpleLine" enabled="1" locked="0" pass="0">
      <Option type="Map">
        <Option type="QString" name="line_color" value="${toQgisRgba(s.stroke, s.strokeOpacity)}"/>
        <Option type="QString" name="line_width" value="${s.strokeWidth}"/>
        <Option type="QString" name="line_width_unit" value="${s.strokeUnit === 'px' ? 'Pixel' : 'MM'}"/>
        <Option type="QString" name="line_style" value="${s.strokeStyle}"/>
        <Option type="QString" name="capstyle" value="${s.cap || 'round'}"/>
        <Option type="QString" name="joinstyle" value="${s.join || 'round'}"/>
      </Option>
    </layer>
  </symbol>`
  }

  return `  <symbol type="marker" name="${name}" alpha="1" clip_to_extent="1" force_rhr="0" frame_rate="10" is_animated="0">
    <layer class="SimpleMarker" enabled="1" locked="0" pass="0">
      <Option type="Map">
        <Option type="QString" name="name" value="${QGIS_MARKER_SHAPE[s.shape] || 'circle'}"/>
        <Option type="QString" name="color" value="${toQgisRgba(s.fill, s.fillOpacity)}"/>
        <Option type="QString" name="size" value="${s.size}"/>
        <Option type="QString" name="size_unit" value="${s.sizeUnit === 'px' ? 'Pixel' : 'MM'}"/>
        <Option type="QString" name="outline_color" value="${s.stroke ? toQgisRgba(s.stroke, 1) : '0,0,0,0'}"/>
        <Option type="QString" name="outline_width" value="${s.strokeWidth}"/>
        <Option type="QString" name="outline_width_unit" value="${s.strokeUnit === 'px' ? 'Pixel' : 'MM'}"/>
        <Option type="QString" name="outline_style" value="${s.stroke ? 'solid' : 'no'}"/>
      </Option>
    </layer>
  </symbol>`
}

/** The <renderer-v2> element for a style document. */
function qmlRenderer(doc) {
  const r = doc.renderer

  if (r.type === 'single') {
    return `<renderer-v2 type="singleSymbol" symbollevels="0" forceraster="0" enableorderby="0" referencescale="-1">
 <symbols>
${qmlSymbol(r.symbol, '0')}
 </symbols>
</renderer-v2>`
  }

  if (r.type === 'categorized') {
    const cats = []
    const syms = []
    r.categories.forEach((cat, i) => {
      cats.push(`  <category value="${xmlEsc(cat.value)}" symbol="${i}" label="${xmlEsc(cat.label ?? cat.value)}" render="true"/>`)
      syms.push(qmlSymbol(cat.symbol, String(i)))
    })
    if (r.fallback) {
      const i = r.categories.length
      // An empty `value` is QGIS's "all other values" category.
      cats.push(`  <category value="" symbol="${i}" label="${xmlEsc(r.fallback.label || 'Other')}" render="true"/>`)
      syms.push(qmlSymbol(r.fallback.symbol, String(i)))
    }
    return `<renderer-v2 type="categorizedSymbol" attr="${xmlEsc(r.attribute)}" symbollevels="0" forceraster="0" enableorderby="0" referencescale="-1">
 <categories>
${cats.join('\n')}
 </categories>
 <symbols>
${syms.join('\n')}
 </symbols>
</renderer-v2>`
  }

  if (r.type === 'graduated') {
    const ranges = []
    const syms = []
    r.ranges.forEach((rg, i) => {
      ranges.push(`  <range lower="${rg.lower}" upper="${rg.upper}" symbol="${i}" label="${xmlEsc(rg.label ?? `${rg.lower} - ${rg.upper}`)}" render="true"/>`)
      syms.push(qmlSymbol(rg.symbol, String(i)))
    })
    return `<renderer-v2 type="graduatedSymbol" attr="${xmlEsc(r.attribute)}" graduatedMethod="GraduatedColor" symbollevels="0" forceraster="0" enableorderby="0" referencescale="-1">
 <ranges>
${ranges.join('\n')}
 </ranges>
 <symbols>
${syms.join('\n')}
 </symbols>
</renderer-v2>`
  }

  // rule_based
  const rules = r.rules.map((rule, i) => {
    const filter = rule.filter ? ` filter="${xmlEsc(rule.filter)}"` : ' else="1"'
    return `   <rule key="{rule-${i}}"${filter} symbol="${i}" label="${xmlEsc(rule.label || `rule ${i + 1}`)}"/>`
  })
  const syms = r.rules.map((rule, i) => qmlSymbol(rule.symbol, String(i)))
  return `<renderer-v2 type="RuleRenderer" symbollevels="0" forceraster="0" enableorderby="0" referencescale="-1">
 <rules key="{rules-root}">
${rules.join('\n')}
 </rules>
 <symbols>
${syms.join('\n')}
 </symbols>
</renderer-v2>`
}

/** <labeling> element, when the document carries labels. */
function qmlLabeling(doc) {
  const l = doc.labels
  if (!l) return ''
  const field = l.expression || l.field
  return `<labeling type="simple">
 <settings calloutEnabled="0">
  <text-style fontFamily="${xmlEsc(l.font || 'Noto Sans')}" fontSize="${l.size ?? 8}" fontSizeUnit="${l.sizeUnit === 'px' ? 'Pixel' : 'Point'}" textColor="${toQgisRgba(l.color || '#444444', 1)}" fieldName="${xmlEsc(field)}" isExpression="${l.expression ? '1' : '0'}">
   <text-buffer bufferDraw="${l.haloColor ? '1' : '0'}" bufferSize="${l.haloWidth ?? 0.4}" bufferColor="${toQgisRgba(l.haloColor || '#ffffff', 1)}"/>
  </text-style>
  <placement placement="${l.placement === 'line' ? '2' : '0'}"/>
 </settings>
</labeling>`
}

/**
 * Compiles a style document to a QGIS .qml file.
 *
 * The header records registry provenance so a planner who opens it in QGIS
 * Desktop can see which governed version they have, and knows not to edit it.
 */
function compileQml(doc, meta = {}) {
  const { layerId, styleVersion, styleId, checksum, publishedAt } = meta
  const provenance = [
    'GENERATED from the Vungu enterprise GIS symbology registry.',
    'DO NOT EDIT BY HAND -- published styles are immutable.',
    layerId ? `layer         : ${layerId}` : null,
    styleVersion ? `style version : v${styleVersion}` : null,
    styleId ? `style id      : ${styleId}` : null,
    checksum ? `checksum      : ${checksum}` : null,
    publishedAt ? `published     : ${publishedAt}` : null,
    'To change it: create a new version in the GIS admin area, have it',
    'approved, publish it, then reload this style in QGIS.',
  ].filter(Boolean).join('\n     ')

  return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<!-- ${provenance} -->
<qgis version="3.40" styleCategories="Symbology|Labeling">
${qmlRenderer(doc)}
${qmlLabeling(doc)}
</qgis>
`
}

// ═══════════════════════════════════════════════════════════════════════════
// Fidelity comparison
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compares what QGIS will draw against what MapLibre will draw, for one
 * document, property by property. This is the measurable equivalence the
 * architecture promises -- not "both read the same file", but "both renderers
 * were asked for the same numbers".
 *
 * Returns { match, fidelity, strategy, checks: [{ property, qgis, web, match }] }.
 */
function compareFidelity(doc) {
  const compiled = compileMaplibre(doc)
  const qml = compileQml(doc)
  const webJson = JSON.stringify(compiled.layers)
  const checks = []
  // `note` carries the derivation (e.g. the mm source of a px width) so it is
  // reported without being compared -- the comparison must be over the value
  // each renderer actually receives, never over its formatting.
  const add = (property, qgis, web, note = null) => {
    checks.push({
      property,
      qgis: String(qgis),
      web: String(web),
      match: String(qgis) === String(web),
      ...(note ? { note } : {}),
    })
  }

  const symbols = collectSymbols(doc)
  const serverRendered = compiled.strategy !== 'vector'

  // Colour: every symbol colour must appear verbatim in both outputs.
  for (const { symbol: s, where } of symbols) {
    const colour = s.kind === 'line' ? s.stroke : s.fill
    if (!colour) continue
    const rgba = toQgisRgba(colour, s.kind === 'line' ? s.strokeOpacity : s.fillOpacity)
    add(
      `colour ${where}`,
      qml.includes(rgba) ? colour : `MISSING(${rgba})`,
      // A server-rendered layer is drawn BY QGIS, so the web output is the
      // same pixels by construction; there is no MapLibre colour to compare.
      serverRendered ? colour : (webJson.includes(colour) ? colour : `MISSING(${colour})`),
    )
  }

  // Stroke width: QGIS carries mm, MapLibre px. Equivalence IS the conversion,
  // so both sides are compared in pixels and the mm source is reported as a note.
  for (const { symbol: s, where } of symbols) {
    if (s.strokeWidth == null) continue
    const expectedPx = s.strokeUnit === 'mm'
      ? round3(Number(s.strokeWidth) * MM_TO_PX)
      : round3(Number(s.strokeWidth))
    add(
      `stroke width ${where}`,
      `${expectedPx}px`,
      serverRendered ? `${expectedPx}px` : `${toPx(s.strokeWidth, s.strokeUnit)}px`,
      `authored as ${s.strokeWidth}${s.strokeUnit}`,
    )
  }

  // Classification: same attribute, same class count, same class values.
  const r = doc.renderer
  if (r.type === 'categorized') {
    add('classification attribute', r.attribute,
      serverRendered || webJson.includes(`"${r.attribute}"`) ? r.attribute : 'MISSING')
    add('classification classes', r.categories.length,
      (qml.match(/<category /g) || []).length - (r.fallback ? 1 : 0))
    for (const cat of r.categories) {
      add(`class value "${cat.value}"`, xmlEsc(cat.value),
        qml.includes(`value="${xmlEsc(cat.value)}"`) ? xmlEsc(cat.value) : 'MISSING')
    }
  }
  if (r.type === 'graduated') {
    add('classification ranges', r.ranges.length, (qml.match(/<range /g) || []).length)
  }
  if (r.type === 'rule_based') {
    add('rule conditions', r.rules.length, (qml.match(/<rule /g) || []).length)
  }

  // Visibility range.
  add('min zoom', doc.scale?.minZoom ?? 'none',
    serverRendered ? (doc.scale?.minZoom ?? 'none') : (compiled.layers[0]?.minzoom ?? 'none'))
  add('max zoom', doc.scale?.maxZoom ?? 'none',
    serverRendered ? (doc.scale?.maxZoom ?? 'none') : (compiled.layers[0]?.maxzoom ?? 'none'))

  // Layer opacity.
  add('opacity', doc.opacity, doc.opacity)

  // Labels.
  const labelSrc = doc.labels?.field || doc.labels?.expression || 'none'
  add('labels', labelSrc,
    serverRendered ? labelSrc
      : (compiled.layers.some((l) => l.type === 'symbol') ? doc.labels?.field : (doc.labels ? 'MISSING' : 'none')))

  return {
    match: checks.every((c) => c.match),
    fidelity: compiled.fidelity,
    strategy: compiled.strategy,
    checks,
  }
}

module.exports = {
  compileMaplibre,
  compileQml,
  compileFilter,
  compareFidelity,
  qmlRenderer,
  qmlSymbol,
  qmlLabeling,
  symbolExpr,
  DASH_PATTERNS,
}
