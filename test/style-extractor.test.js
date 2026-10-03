/**
 * Style-extraction regression tests.
 *
 * Two regressions motivated these:
 *
 *   1. The extractor only looked in <projectDir>/styles/, while the council's
 *      exported symbology lives in <projectDir>/canonical-qml/. Every layer
 *      that was not loaded into the pilot QGIS project -- districts, wards,
 *      landuse, buildings, stands -- silently rendered with the flat default
 *      symbol, so the portal looked styled while nothing was extracted.
 *   2. Line symbols stacked a casing under a core, and "widest line wins"
 *      picked the casing. Every OSM road class came out the same colour.
 *
 * Run: npx jest test/style-extractor.test.js
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { PerfectQGISStyleExtractor } = require('../src/services/admin/perfectQGISStyleExtractor')

const REPO = path.join(__dirname, '..')
const PROJECT = process.env.QGIS_PROJECT_LOCAL || path.join(REPO, 'qgis-projects', 'vungu-project.qgs')
const CANONICAL_DIR = path.join(REPO, 'qgis-projects', 'canonical-qml')

const extract = (layer, options = {}) =>
  new PerfectQGISStyleExtractor().extractCompleteStyle(layer, PROJECT, options)

describe('style source resolution', () => {
  test('the project and canonical QML corpus are both present', () => {
    expect(fs.existsSync(PROJECT)).toBe(true)
    expect(fs.existsSync(CANONICAL_DIR)).toBe(true)
  })

  test('resolves a project layer from the .qgs itself', async () => {
    const style = await extract('proposed_peri_urban_zones')
    expect(style.metadata.styleSource).toBe('project-file')
    expect(style.metadata.fallback).toBe(false)
  })

  test('resolves a layer that only exists as an exported QML sidecar', async () => {
    // districts is not in the pilot project; it must not fall back to default.
    const style = await extract('districts')
    expect(style.metadata.styleSource).toBe('canonical-qml')
    expect(style.metadata.qmlPath).toContain('districts.qml')
    expect(style.metadata.fallback).toBe(false)
  })

  test('resolves every layer the portal serves', async () => {
    const { LAYERS } = require('../src/config/spatialLayers')
    const extractor = new PerfectQGISStyleExtractor()
    const unresolved = []
    for (const layer of LAYERS) {
      try {
        const style = await extractor.extractCompleteStyle(layer.id, PROJECT, { noCache: true })
        if (style.metadata.fallback) unresolved.push(`${layer.id} (fallback: ${style.metadata.fallbackReason})`)
      } catch (error) {
        unresolved.push(`${layer.id} (${error.message})`)
      }
    }
    expect(unresolved).toEqual([])
  })

  test('reports the substitution when a portal id needs its vungu_ prefix dropped', async () => {
    // The pilot project does not name this layer `vungu_proposed_peri_urban_zones`;
    // the drop-prefix retry finds it (here via the project's own datasource).
    const style = await extract('vungu_proposed_peri_urban_zones')
    expect(style.metadata.aliasOf).toBe('vungu_proposed_peri_urban_zones')
    expect(style.metadata.fallback).toBe(false)
    expect(style.qgisStyle.rendererType).toBe('categorizedSymbol')
  })

  test('an explicit QML path wins over every other source', async () => {
    const style = await extract('districts', { qmlPath: path.join(CANONICAL_DIR, 'wards.qml') })
    expect(style.metadata.styleSource).toBe('qml-explicit')
  })

  test('prefers a styles/ sidecar over the project, matching QGIS Desktop', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vungu-style-'))
    fs.mkdirSync(path.join(tmp, 'styles'))
    fs.copyFileSync(PROJECT, path.join(tmp, 'test.qgs'))
    const wardsQml = fs.readFileSync(path.join(CANONICAL_DIR, 'wards.qml'), 'utf8')
    fs.writeFileSync(path.join(tmp, 'styles', 'proposed_peri_urban_zones.qml'), wardsQml)

    const located = new PerfectQGISStyleExtractor().resolveStyleSource(
      'proposed_peri_urban_zones',
      path.join(tmp, 'test.qgs')
    )
    expect(located.source).toBe('qml-sidecar')
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('a layer with no QGIS artefact fails loudly instead of pretending', async () => {
    await expect(extract('no_such_layer_xyz')).rejects.toThrow(/No QGIS style for layer/)
  })
})

describe('QGIS renderer translation', () => {
  test('categorised renderer becomes a match expression that varies', async () => {
    const style = await extract('proposed_peri_urban_zones')
    expect(style.qgisStyle.rendererType).toBe('categorizedSymbol')
    expect(style.qgisStyle.attributeName).toBe('zone')

    const paint = style.maplibreStyle.paint
    expect(paint['fill-color'][0]).toBe('match')
    expect(paint['fill-color'][1]).toEqual(['get', 'zone'])
    // More than one colour proves the classification survived.
    expect(new Set(paint['fill-color'].filter((_, i) => i % 2 === 0)).size).toBeGreaterThan(1)
  })

  test('line symbols take the topmost layer as the core, not the widest casing', async () => {
    const style = await extract('roads')
    const colours = style.webStyle.symbols.map((s) => s.stroke?.color).filter(Boolean)
    // Before the fix every category resolved to the white casing.
    expect(new Set(colours).size).toBeGreaterThan(1)
    expect(colours).not.toContain('#ffffff')
  })

  test('line symbols with casing emit a casing layer beneath the core', async () => {
    const style = await extract('roads')
    const casing = (style.maplibreStyle.additionalLayers || []).find((l) => l.placement === 'below')
    expect(casing).toBeDefined()
    expect(casing.type).toBe('line')
    // Per-category casing widths, not one flat width.
    expect(casing.paint['line-width'][0]).toBe('match')
  })

  test('an outline-only polygon keeps its multi-line outline stack', async () => {
    const style = await extract('gweru_rural_planning_boundary')
    if (style.webStyle.symbols[0]?.isOutlineOnly) {
      expect(style.maplibreStyle.additionalLayers?.length).toBeGreaterThan(0)
    }
  })

  test('labeling survives extraction', async () => {
    const style = await extract('proposed_peri_urban_zones')
    expect(style.metadata.hasLabels).toBe(true)
  })
})
