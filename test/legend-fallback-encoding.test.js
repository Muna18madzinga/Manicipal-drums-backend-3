/**
 * Regression tests for the WMS legend fallback encoding.
 *
 * The portal has two legend sources:
 *   1. QGIS Server `GetLegendGraphic` -> PNG, base64 data URL.
 *   2. The offline placeholder SVG, percent-encoded data URL.
 *
 * `GET /ogc/wms/legend/:layer?raw=true` streams raw bytes to the map legend
 * widget. It used to base64-decode whatever came back, which silently shipped
 * corrupt bytes labelled image/svg+xml whenever the placeholder was served —
 * i.e. exactly when QGIS Server was down and the fallback mattered most.
 */
const fs = require('fs')
const path = require('path')

const BRIDGE = path.join(__dirname, '..', 'src', 'services', 'admin', 'refinedOGCBridge.js')

describe('legend fallback encoding', () => {
  let source

  beforeAll(() => {
    source = fs.readFileSync(BRIDGE, 'utf8')
  })

  test('getLegend states its encoding instead of leaving callers to guess', () => {
    // The QGIS path is a base64 data URL...
    expect(source).toMatch(/encoding:\s*'base64'/)
    // ...and the offline fallback is percent-encoded, and says so.
    expect(source).toMatch(/encoding:\s*'uri'/)
    // Both paths declare a media type for the raw route to echo.
    expect(source).toMatch(/mediaType:\s*params\.FORMAT/)
    expect(source).toMatch(/mediaType:\s*'image\/svg\+xml'/)
  })

  test('the offline placeholder is a percent-encoded data URL', () => {
    const svg = new (require('../src/services/admin/refinedOGCBridge.js').RefinedOGCBridge)()
      .createDefaultLegendSVG('roads')
    expect(svg.startsWith('data:image/svg+xml,')).toBe(true)
    // Decoding it as base64 -- the old bug -- yields garbage, never '<svg'.
    const asBase64 = Buffer.from(svg.slice(svg.indexOf(',') + 1), 'base64').toString('utf8')
    expect(asBase64).not.toContain('<svg')
    // Decoding it correctly yields the real SVG.
    expect(decodeURIComponent(svg.slice(svg.indexOf(',') + 1))).toContain('<svg')
  })

  test('the raw route honours the declared encoding', () => {
    const route = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'routes', 'ogcServices.js'),
      'utf8'
    )
    expect(route).toMatch(/result\.encoding === 'uri'/)
    expect(route).toMatch(/result\.mediaType \|\| result\.contentType/)
    // The unconditional base64 decode is what produced the corrupt output.
    expect(route).not.toMatch(/Buffer\.from\(result\.legend\.split\(','\)\[1\], 'base64'\)/)
  })
})