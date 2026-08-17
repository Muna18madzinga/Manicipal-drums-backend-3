// src/services/gis/qgisImport.js
// ---------------------------------------------------------------------------
// Reads the AUTHORITATIVE QGIS cartography out of a .qgs project or a .qml
// sidecar and normalises it into a `vungu.gis.style/1` document.
//
// This is what makes "QGIS is the source of truth" a mechanism rather than a
// claim: a GIS officer styles a layer in QGIS Desktop, the renderer XML is
// parsed here, and the resulting document is what every client draws from. No
// developer retypes a colour.
//
// It deliberately does NOT resolve conflicts. When a layer has several
// candidate styles (a .qgs renderer AND a QML sidecar AND a generated file),
// every candidate is returned with its provenance so a human chooses and the
// choice lands in the audit log. Silently preferring one is how drift started.
// ---------------------------------------------------------------------------

const fs = require('fs')
const path = require('path')
const { XMLParser } = require('fast-xml-parser')
const {
  styleDoc, fillSymbol, lineSymbol, markerSymbol, parseColor,
  validate, classifyFidelity, checksum,
} = require('./styleDoc')

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  isArray: (name) => ['maplayer', 'category', 'range', 'rule', 'symbol', 'layer', 'Option', 'prop'].includes(name),
  parseAttributeValue: false,
  trimValues: true,
})

const toArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])

// QGIS records a layer's geometry two different ways depending on version:
//   3.2x+ : a `geometry="Polygon|Line|Point"` ATTRIBUTE on <maplayer>
//   older : a <layerGeometryType>0|1|2</layerGeometryType> child element
// The real vungu-project.qgs (QGIS 3.40) uses the attribute form only, and
// reading just the element silently defaulted every layer to polygon -- which
// compiles a road into a fill. Both forms are read, attribute first.
const GEOM_BY_CODE = { 0: 'point', 1: 'line', 2: 'polygon' }
const GEOM_BY_NAME = {
  point: 'point', multipoint: 'point',
  line: 'line', linestring: 'line', multilinestring: 'line',
  polygon: 'polygon', multipolygon: 'polygon',
}

/** Resolves a <maplayer>'s geometry, or null when it cannot be determined. */
function resolveGeometry(maplayer) {
  const attr = maplayer['@geometry']
  if (attr) {
    const g = GEOM_BY_NAME[String(attr).toLowerCase()]
    if (g) return g
  }
  const code = maplayer.layerGeometryType
  if (code !== undefined && code !== '') return GEOM_BY_CODE[String(code)] ?? null
  return null
}

// QGIS gates visibility on a SCALE DENOMINATOR; MapLibre on a zoom level.
// At the equator with 96 DPI, zoom z has denominator 559082264.028 / 2^z.
const SCALE_Z0 = 559082264.028

/** QGIS scale denominator -> nearest web-mercator zoom level. */
function scaleToZoom(denominator) {
  const d = Number(denominator)
  if (!Number.isFinite(d) || d <= 0) return null
  return Math.max(0, Math.min(24, Math.round(Math.log2(SCALE_Z0 / d))))
}

/**
 * Reads a layer's scale-based visibility into a zoom range.
 * QGIS `minScale` is the SMALLEST-scale (most zoomed-out) limit, so it maps to
 * MapLibre's minzoom; `maxScale` maps to maxzoom. Respects the enable flag --
 * QGIS keeps stale scale values around while the flag is off.
 */
function visibilityZoom(maplayer) {
  if (maplayer['@hasScaleBasedVisibilityFlag'] !== '1') return { minZoom: null, maxZoom: null }
  return {
    minZoom: scaleToZoom(maplayer['@minScale']),
    maxZoom: scaleToZoom(maplayer['@maxScale']),
  }
}

/** Renderer type in QGIS XML -> our renderer type. */
const RENDERER_MAP = {
  singleSymbol: 'single',
  categorizedSymbol: 'categorized',
  graduatedSymbol: 'graduated',
  RuleRenderer: 'rule_based',
}

// ── Symbol-layer property access ───────────────────────────────────────────
// QGIS has written symbol-layer properties two ways across versions:
//   modern:  <Option type="Map"><Option type="QString" name="color" value="…"/>
//   legacy:  <prop k="color" v="…"/>
// Both appear in real project files, so both are read.
function symbolLayerProps(symbolLayer) {
  const props = {}

  for (const p of toArray(symbolLayer.prop)) {
    if (p['@k'] !== undefined) props[p['@k']] = p['@v']
  }

  const collectOptions = (node) => {
    if (!node || typeof node !== 'object') return
    for (const opt of toArray(node.Option)) {
      if (opt['@name'] !== undefined && opt['@value'] !== undefined) {
        props[opt['@name']] = opt['@value']
      }
      if (opt.Option) collectOptions(opt) // nested type="Map"
    }
  }
  collectOptions(symbolLayer)

  return props
}

/** Detects the QGIS features MapLibre cannot express, for fidelity scoring. */
function symbolLayerFlags(symbolLayer) {
  const flags = {}
  if (symbolLayer.data_defined_properties) {
    const raw = JSON.stringify(symbolLayer.data_defined_properties)
    // QGIS writes an inert placeholder block even when nothing is overridden;
    // only a live expression or field reference counts.
    if (/"(expression|field)"\s*:/.test(raw) && !/"active"\s*:\s*"?false/.test(raw)) {
      flags.dataDefined = true
    }
  }
  if (symbolLayer['@class'] === 'GeometryGenerator') flags.geometryGenerator = true
  return flags
}

/**
 * Converts one QGIS <symbol> into a styleDoc symbol.
 *
 * A QGIS symbol may stack several symbol layers. For a line, the widest is the
 * casing and the narrowest the ink -- that pairing is preserved rather than
 * flattened, because the statutory road hierarchy depends on it.
 */
function convertSymbol(symbol, geometry) {
  const type = symbol['@type']
    || (geometry === 'polygon' ? 'fill' : geometry === 'line' ? 'line' : 'marker')
  const layers = toArray(symbol.layer)
  const alpha = symbol['@alpha'] !== undefined && symbol['@alpha'] !== ''
    ? Number(symbol['@alpha'])
    : 1
  const flags = {}

  const propSets = layers.map((l) => ({
    props: symbolLayerProps(l),
    flags: symbolLayerFlags(l),
    cls: l['@class'],
  }))
  for (const ps of propSets) Object.assign(flags, ps.flags)
  if (propSets.length > 1) flags.multiLayer = propSets.length

  const primary = propSets[0] || { props: {} }

  if (type === 'fill') {
    const p = primary.props
    const fill = parseColor(p.color ?? p.fill_color ?? '#cccccc') || { hex: '#cccccc', opacity: 1 }
    const outlineRaw = p.outline_style === 'no' ? null : (p.outline_color ?? p.line_color)
    const outline = outlineRaw ? parseColor(outlineRaw) : null
    return {
      symbol: fillSymbol({
        fill: fill.hex,
        fillOpacity: fill.opacity * alpha,
        fillStyle: p.style === 'no' ? 'none' : (p.style || 'solid'),
        stroke: outline ? outline.hex : null,
        strokeOpacity: outline ? outline.opacity : 0,
        strokeWidth: p.outline_width !== undefined ? Number(p.outline_width) : 0.26,
        strokeUnit: /pixel/i.test(p.outline_width_unit || 'MM') ? 'px' : 'mm',
        strokeStyle: p.outline_style || 'solid',
      }),
      flags,
    }
  }

  if (type === 'line') {
    // Widest layer = paper casing, narrowest = ink.
    const lineLayers = propSets
      .map((ps) => ({ ...ps, width: Number(ps.props.line_width ?? ps.props.outline_width ?? 0.26) }))
      .filter((ps) => ps.props.line_color || ps.props.outline_color)
    const ink = lineLayers.length
      ? lineLayers.reduce((a, b) => (b.width < a.width ? b : a))
      : { props: primary.props, width: 0.26 }
    const casing = lineLayers.length > 1
      ? lineLayers.reduce((a, b) => (b.width > a.width ? b : a))
      : null

    const p = ink.props
    const stroke = parseColor(p.line_color ?? p.outline_color ?? '#232323') || { hex: '#232323', opacity: 1 }
    return {
      symbol: lineSymbol({
        stroke: stroke.hex,
        strokeOpacity: stroke.opacity * alpha,
        strokeWidth: ink.width,
        strokeUnit: /pixel/i.test(p.line_width_unit || p.outline_width_unit || 'MM') ? 'px' : 'mm',
        strokeStyle: p.line_style || p.outline_style || 'solid',
        cap: p.capstyle || 'round',
        join: p.joinstyle || 'round',
        ...(casing && casing !== ink
          ? {
              casing: {
                stroke: (parseColor(casing.props.line_color) || { hex: '#ffffff' }).hex,
                strokeWidth: casing.width,
                strokeUnit: /pixel/i.test(casing.props.line_width_unit || 'MM') ? 'px' : 'mm',
              },
            }
          : {}),
      }),
      flags,
    }
  }

  // marker
  const p = primary.props
  const fill = parseColor(p.color ?? '#7b6b55') || { hex: '#7b6b55', opacity: 1 }
  const isSvg = primary.cls === 'SvgMarker' || String(p.name || '').endsWith('.svg')
  const strokeRaw = p.outline_style === 'no' ? null : (p.outline_color ?? null)
  const stroke = strokeRaw ? parseColor(strokeRaw) : null
  return {
    symbol: markerSymbol({
      shape: isSvg ? 'svg' : (p.name || 'circle'),
      ...(isSvg ? { svgPath: p.name } : {}),
      size: p.size !== undefined ? Number(p.size) : 2,
      sizeUnit: /pixel/i.test(p.size_unit || 'MM') ? 'px' : 'mm',
      fill: fill.hex,
      fillOpacity: fill.opacity * alpha,
      stroke: stroke ? stroke.hex : null,
      strokeWidth: p.outline_width !== undefined ? Number(p.outline_width) : 0,
      strokeUnit: /pixel/i.test(p.outline_width_unit || 'MM') ? 'px' : 'mm',
    }),
    flags,
  }
}

/** Indexes the renderer's <symbol name="N"> children for `symbol="N"` refs. */
function symbolIndex(rendererNode) {
  const byName = new Map()
  const container = rendererNode.symbols || rendererNode
  for (const sym of toArray(container.symbol)) {
    if (sym['@name'] !== undefined) byName.set(String(sym['@name']), sym)
  }
  return byName
}

/** QGIS <labeling> -> styleDoc labels, or null. */
function convertLabels(maplayer) {
  if (maplayer['@labelsEnabled'] === '0') return null
  const settings = maplayer.labeling?.settings
  const ts = settings?.['text-style']
  if (!ts) return null

  const field = ts['@fieldName']
  if (!field) return null

  const isExpression = ts['@isExpression'] === '1'
  const buffer = ts['text-buffer']
  const colour = parseColor(ts['@textColor']) || { hex: '#444444' }
  const placement = settings.placement?.['@placement']

  return {
    ...(isExpression ? { expression: field } : { field }),
    size: ts['@fontSize'] !== undefined ? Number(ts['@fontSize']) : 8,
    sizeUnit: /pixel/i.test(ts['@fontSizeUnit'] || 'Point') ? 'px' : 'mm',
    font: ts['@fontFamily'] || null,
    color: colour.hex,
    ...(buffer?.['@bufferDraw'] === '1'
      ? {
          haloColor: (parseColor(buffer['@bufferColor']) || { hex: '#ffffff' }).hex,
          haloWidth: buffer['@bufferSize'] !== undefined ? Number(buffer['@bufferSize']) : 0.4,
        }
      : {}),
    ...(placement === '2' ? { placement: 'line' } : {}),
  }
}

/**
 * Converts a parsed <renderer-v2> node into a styleDoc renderer.
 * Returns { renderer, flags } where flags feed fidelity classification.
 */
function convertRenderer(node, geometry) {
  const qgisType = node['@type']
  const type = RENDERER_MAP[qgisType]
  if (!type) {
    throw new Error(`unsupported QGIS renderer type "${qgisType}" -- add a mapping in RENDERER_MAP before importing this layer`)
  }

  const symbols = symbolIndex(node)
  const flags = {}
  const take = (name) => {
    const sym = symbols.get(String(name))
    if (!sym) return null
    const { symbol, flags: f } = convertSymbol(sym, geometry)
    Object.assign(flags, f)
    return symbol
  }

  if (node['@blendMode'] && node['@blendMode'] !== '0') flags.blendMode = node['@blendMode']

  if (type === 'single') {
    const first = [...symbols.values()][0]
    if (!first) throw new Error('singleSymbol renderer has no <symbol>')
    const { symbol, flags: f } = convertSymbol(first, geometry)
    Object.assign(flags, f)
    return { renderer: { type: 'single', symbol }, flags }
  }

  if (type === 'categorized') {
    const categories = []
    let fallback = null
    for (const c of toArray(node.categories?.category)) {
      const symbol = take(c['@symbol'])
      if (!symbol) continue
      const value = c['@value']
      // QGIS uses an empty value for "all other values".
      if (value === '' || value === undefined) {
        fallback = { label: c['@label'] || 'Other', symbol }
      } else {
        categories.push({ value, label: c['@label'] ?? value, symbol })
      }
    }
    return {
      renderer: {
        type: 'categorized',
        attribute: node['@attr'],
        method: 'unique_values',
        categories,
        ...(fallback ? { fallback } : {}),
      },
      flags,
    }
  }

  if (type === 'graduated') {
    const ranges = toArray(node.ranges?.range).map((r) => {
      const symbol = take(r['@symbol'])
      return symbol
        ? { lower: Number(r['@lower']), upper: Number(r['@upper']), label: r['@label'], symbol }
        : null
    }).filter(Boolean)
    return {
      renderer: {
        type: 'graduated',
        attribute: node['@attr'],
        method: node['@graduatedMethod'] === 'GraduatedSize' ? 'graduated_size' : 'graduated_color',
        ranges,
      },
      flags,
    }
  }

  // rule_based -- QGIS nests <rule> elements. A nested tree is flagged so
  // fidelity forces server rendering rather than a flattened approximation.
  const flatten = (rulesNode) => {
    const out = []
    for (const r of toArray(rulesNode?.rule)) {
      if (r.rule) {
        flags.nestedRules = true
        out.push(...flatten(r))
      }
      const symbol = r['@symbol'] !== undefined ? take(r['@symbol']) : null
      if (!symbol) continue
      out.push({
        filter: r['@else'] === '1' ? null : (r['@filter'] ?? null),
        label: r['@label'] ?? null,
        symbol,
        ...(r['@scalemindenom'] ? { scaleMin: Number(r['@scalemindenom']) } : {}),
      })
    }
    return out
  }
  return { renderer: { type: 'rule_based', rules: flatten(node.rules) }, flags }
}

/** Builds the final document + validation + fidelity for one layer. */
function buildDoc({ layerId, geometry, rendererNode, maplayer, sourcePath, minZoom, maxZoom }) {
  const { renderer, flags } = convertRenderer(rendererNode, geometry)
  const labels = maplayer ? convertLabels(maplayer) : null

  const rawOpacity = maplayer?.layerOpacity
  const opacity = rawOpacity !== undefined && rawOpacity !== '' ? Number(rawOpacity) : 1

  const doc = styleDoc({
    layerId,
    geometry,
    renderer: {
      ...renderer,
      ...(flags.blendMode ? { blendMode: flags.blendMode } : {}),
      ...(flags.dataDefined ? { dataDefined: { symbol: true } } : {}),
      ...(flags.geometryGenerator ? { geometryGenerator: true } : {}),
    },
    labels,
    minZoom: minZoom ?? null,
    maxZoom: maxZoom ?? null,
    opacity: Number.isFinite(opacity) ? opacity : 1,
  })

  return {
    doc,
    validation: validate(doc),
    fidelity: classifyFidelity(doc),
    checksum: checksum(doc),
    sourcePath,
    flags,
  }
}

// ── Public entry points ────────────────────────────────────────────────────

/**
 * Extracts every styled layer from a QGIS project file.
 *
 * Returns [{ layerId, qgisLayerName, geometry, dataSource, table, doc,
 *            validation, fidelity, checksum, sourcePath, error? }].
 * A layer that cannot be converted is returned WITH its error rather than
 * skipped, so an import never quietly loses a layer.
 */
function importProject(qgsPath, { layerIdFor = (name) => name } = {}) {
  const xml = fs.readFileSync(qgsPath, 'utf-8')
  const tree = parser.parse(xml)
  const project = tree.qgis || tree
  const maplayers = toArray(project.projectlayers?.maplayer)

  return maplayers.map((ml) => {
    const qgisLayerName = ml.layername
    const layerId = layerIdFor(qgisLayerName)
    const geometry = resolveGeometry(ml)
    const dataSource = ml.datasource
    const table = /table="?([^". ]+)"?\."?([^". ]+)"?/.exec(String(dataSource || ''))
    const { minZoom, maxZoom } = visibilityZoom(ml)

    const out = {
      layerId,
      qgisLayerName,
      geometry,
      dataSource,
      table: table ? table[2] : null,
      sourcePath: qgsPath,
    }

    // Guessing a geometry would compile a road into a polygon fill. Refuse.
    if (!geometry) {
      return { ...out, error: `cannot determine geometry (no geometry attribute, no <layerGeometryType>); refusing to guess` }
    }

    const rendererNode = ml['renderer-v2']
    if (!rendererNode) {
      return { ...out, error: 'layer has no <renderer-v2> (unstyled, or a raster/plugin layer)' }
    }

    try {
      return {
        ...out,
        ...buildDoc({ layerId, geometry, rendererNode, maplayer: ml, sourcePath: qgsPath, minZoom, maxZoom }),
      }
    } catch (e) {
      return { ...out, error: e.message }
    }
  })
}

/**
 * Reads a standalone .qml sidecar. `layerId` and `geometry` must be supplied --
 * a QML carries symbology only, never which layer it belongs to.
 */
function importQml(qmlPath, { layerId, geometry, minZoom = null, maxZoom = null }) {
  const xml = fs.readFileSync(qmlPath, 'utf-8')
  const tree = parser.parse(xml)
  const root = tree.qgis || tree.qml || tree
  const rendererNode = root['renderer-v2']
  if (!rendererNode) throw new Error(`${qmlPath}: no <renderer-v2> element`)

  return buildDoc({ layerId, geometry, rendererNode, maplayer: root, sourcePath: qmlPath, minZoom, maxZoom })
}

/**
 * Finds every candidate QGIS style for a layer and returns them ALL, ranked by
 * convention but never silently reduced to one.
 *
 * Ranking reflects how QGIS itself resolves styles:
 *   1. styles/<layer>.qml   -- a sidecar QGIS Desktop loads OVER the project
 *                              renderer, so it wins in Desktop
 *   2. the .qgs renderer    -- what QGIS Server actually serves
 *   3. canonical-qml/<layer>.qml -- generated output, NOT an authoring source;
 *                              listed so a stale generated file stays visible
 *
 * The caller must pick one and record the choice; `recommended` is advice only.
 */
function findCandidates(layerId, { projectPath, geometry, stylesDir, canonicalDir }) {
  const candidates = []
  const projectDir = path.dirname(projectPath)
  const sidecarDir = stylesDir || path.join(projectDir, 'styles')
  const genDir = canonicalDir || path.join(projectDir, 'canonical-qml')

  const tryQml = (file, role, precedence) => {
    if (!fs.existsSync(file)) return
    try {
      candidates.push({ role, precedence, sourcePath: file, ...importQml(file, { layerId, geometry }) })
    } catch (e) {
      candidates.push({ role, precedence, sourcePath: file, error: e.message })
    }
  }

  tryQml(path.join(sidecarDir, `${layerId}.qml`), 'qml_sidecar', 1)

  if (fs.existsSync(projectPath)) {
    const fromProject = importProject(projectPath).find((l) => l.layerId === layerId)
    if (fromProject) candidates.push({ role: 'qgs_project', precedence: 2, ...fromProject })
  }

  tryQml(path.join(genDir, `${layerId}.qml`), 'generated', 3)

  const authoring = candidates.filter((c) => !c.error && c.role !== 'generated')
  return {
    layerId,
    candidates: candidates.sort((a, b) => a.precedence - b.precedence),
    recommended: authoring.length ? authoring[0] : null,
    conflict: authoring.length > 1
      ? `${authoring.length} authoring sources present (${authoring.map((c) => c.role).join(' vs ')}); a GIS officer must choose, and the choice is recorded in the audit log`
      : null,
  }
}

module.exports = {
  importProject,
  importQml,
  findCandidates,
  convertRenderer,
  convertSymbol,
  convertLabels,
  symbolLayerProps,
  resolveGeometry,
  scaleToZoom,
  visibilityZoom,
  RENDERER_MAP,
  GEOM_BY_CODE,
  GEOM_BY_NAME,
}
