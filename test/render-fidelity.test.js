/**
 * The fidelity ladder must route, not approximate.
 *
 * The paper claims symbology too complex for MapLibre is rendered by QGIS
 * Server. That claim lives or dies on one behaviour: a symbol layer MapLibre
 * cannot express must NOT compile to a MapLibre layer. Before SERVER_ONLY_CLASSES
 * existed, a QGIS GradientFill imported as a solid `#cccccc` fill classified
 * `direct` and compiled to a normal vector layer -- the portal showed flat grey
 * where the GIS officer had drawn a ramp, and nothing said so.
 *
 * The controls matter as much as the failures. A change that routed every style
 * to QGIS Server would satisfy "no approximations" while destroying the portal,
 * so these assert the opposite direction too.
 */
const path = require('path')
const fs = require('fs')
const os = require('os')

const { importQml, SERVER_ONLY_CLASSES } = require('../src/services/gis/qgisImport')
const { compileMaplibre } = require('../src/services/gis/compile')

/** Minimal QGIS 3.x .qml with one symbol of `type` and the given layer classes. */
function qml({ symbolType, geometry, layers }) {
  const body = layers
    .map(
      (l, i) => `        <layer class="${l.cls}" pass="${i}" locked="0">
          <Option type="Map">${l.props
            .map(([k, v]) => `<Option type="QString" name="${k}" value="${v}"/>`)
            .join('')}</Option>
        </layer>`
    )
    .join('\n')
  return `<qgis version="3.40.0-Bratislava">
  <renderer-v2 type="singleSymbol" symbollevels="0" forceraster="0" enableorderby="0">
    <symbols>
      <symbol type="${symbolType}" name="0" alpha="1" clip_to_extent="1" force_rhr="0">
${body}
      </symbol>
    </symbols>
  </renderer-v2>
</qgis>`
}

let tmpDir
let seq = 0

/** Writes a QML to disk and imports it the way the registry does. */
function importFixture(spec) {
  const file = path.join(tmpDir, `fixture-${seq++}.qml`)
  fs.writeFileSync(file, qml(spec), 'utf8')
  return importQml(file, { layerId: 'fixture', geometry: spec.geometry })
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vungu-fidelity-'))
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** A representative property set per untranslatable class, as QGIS writes them. */
const PROPS_FOR = {
  GradientFill: [['color1', '255,235,130,255'], ['color2', '200,90,60,255'], ['gradient_type', 'radial']],
  ShapeburstFill: [['color1', '250,240,200,255'], ['color2', '190,120,40,255']],
  LinePatternFill: [['distance', '2'], ['line_width', '0.5'], ['angle', '45'], ['color', '90,90,90,255']],
  PointPatternFill: [['distance_x', '4'], ['distance_y', '4'], ['color', '120,120,120,255']],
  SVGFill: [['path', '/usr/share/qgis/svg/patterns/zebra.svg'], ['size', '4']],
  MarkerLine: [['interval', '2'], ['placement', '0']],
  FontMarker: [['name', 'Arial'], ['size', '8']],
  LineBurial: [['interval', '5'], ['offset', '2']],
  Fence: [['interval', '2']],
  Arrow: [['interval', '4']],
  Raster: [['path', '/data/photo.png'], ['opacity', '1']],
  VectorField: [['length', '20']],
  AnimatedMarker: [['frame_rate', '5']],
  RandomMarkerFill: [['density', '2']],
}

const GEOMETRY_FOR = {
  MarkerLine: 'line',
  LineBurial: 'line',
  Fence: 'line',
  Arrow: 'line',
  FontMarker: 'point',
  Raster: 'polygon',
  VectorField: 'point',
  AnimatedMarker: 'point',
  RandomMarkerFill: 'polygon',
}

const SYMBOL_TYPE_FOR = {
  MarkerLine: 'line',
  LineBurial: 'line',
  Fence: 'line',
  Arrow: 'line',
  FontMarker: 'marker',
  Raster: 'fill',
  VectorField: 'marker',
  AnimatedMarker: 'marker',
  RandomMarkerFill: 'fill',
}

describe('symbology MapLibre cannot express is delegated to QGIS Server', () => {
  test.each(Object.keys(SERVER_ONLY_CLASSES))('%s is classified server, not approximated', (cls) => {
    const geometry = GEOMETRY_FOR[cls] || 'polygon'
    const entry = importFixture({
      symbolType: SYMBOL_TYPE_FOR[cls] || 'fill',
      geometry,
      layers: [{ cls, props: PROPS_FOR[cls] || [['color', '10,20,30,255']] }],
    })

    expect(entry.fidelity.level).toBe('server')

    const compiled = compileMaplibre(entry.doc, { fidelity: entry.fidelity })
    expect(compiled.strategy).toBe('wms')
    // The invariant that matters: nothing reaches the client to be drawn wrongly.
    expect(compiled.layers).toHaveLength(0)

    // And the note must name the class, so a planner can see WHY it delegated.
    const notes = entry.fidelity.notes.map((n) => n.note).join(' | ')
    expect(notes).toContain(cls)
    expect(notes).toContain('QGIS Server')
  })

  test('every class in the table has a reason and a test fixture', () => {
    for (const [cls, why] of Object.entries(SERVER_ONLY_CLASSES)) {
      expect(typeof why).toBe('string')
      expect(why.length).toBeGreaterThan(20)
      // A class with no representative props would silently go untested above.
      expect(PROPS_FOR[cls]).toBeDefined()
    }
  })

  test('one untranslatable layer taints a whole stacked symbol', () => {
    // The gradient is what the viewer sees on top, so the solid fill beneath it
    // being translatable does not make the symbol translatable.
    const entry = importFixture({
      symbolType: 'fill',
      geometry: 'polygon',
      layers: [
        { cls: 'SimpleFill', props: [['color', '245,245,240,255'], ['style', 'solid']] },
        { cls: 'GradientFill', props: PROPS_FOR.GradientFill },
      ],
    })
    expect(entry.fidelity.level).toBe('server')
    expect(compileMaplibre(entry.doc, { fidelity: entry.fidelity }).layers).toHaveLength(0)
  })
})

describe('symbology MapLibre CAN express still goes to the client', () => {
  const control = (spec) => {
    const entry = importFixture(spec)
    return { entry, compiled: compileMaplibre(entry.doc, { fidelity: entry.fidelity }) }
  }

  test('a solid fill is direct and compiles to a real vector layer', () => {
    const { entry, compiled } = control({
      symbolType: 'fill',
      geometry: 'polygon',
      layers: [{
        cls: 'SimpleFill',
        props: [['color', '230,240,255,255'], ['style', 'solid'], ['outline_color', '35,35,35,255'],
          ['outline_width', '0.26'], ['outline_width_unit', 'Pixel']],
      }],
    })
    expect(entry.fidelity.level).toBe('direct')
    expect(compiled.strategy).toBe('vector')
    expect(compiled.layers.length).toBeGreaterThan(0)
  })

  test('a plain line is direct', () => {
    const { entry, compiled } = control({
      symbolType: 'line',
      geometry: 'line',
      layers: [{
        cls: 'SimpleLine',
        props: [['line_color', '35,35,35,255'], ['line_width', '0.5'], ['line_width_unit', 'Pixel']],
      }],
    })
    expect(entry.fidelity.level).toBe('direct')
    expect(compiled.layers.length).toBeGreaterThan(0)
  })

  test('a circle marker is translated, not delegated', () => {
    const { entry, compiled } = control({
      symbolType: 'marker',
      geometry: 'point',
      layers: [{
        cls: 'SimpleMarker',
        props: [['name', 'circle'], ['color', '180,60,60,255'], ['size', '3'], ['size_unit', 'Pixel']],
      }],
    })
    expect(['direct', 'converted']).toContain(entry.fidelity.level)
    expect(compiled.strategy).toBe('vector')
    expect(compiled.layers.length).toBeGreaterThan(0)
  })

  test('the pre-existing brush-hatch rule still fires', () => {
    // Guards against the new table displacing the rule that predates it.
    const { entry, compiled } = control({
      symbolType: 'fill',
      geometry: 'polygon',
      layers: [{ cls: 'SimpleFill', props: [['color', '200,180,140,255'], ['style', 'cross']] }],
    })
    expect(entry.fidelity.level).toBe('server')
    expect(compiled.strategy).toBe('wms')
  })
})