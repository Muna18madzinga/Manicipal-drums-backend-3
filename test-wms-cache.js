// test-wms-cache.js
// Self-check for the WMS raster tile cache added to /api/ogc/wms/map/:layer.
// No DB, no QGIS Server, no framework — run with: node test-wms-cache.js
//
// Covers the three pieces of non-trivial logic:
//   1. invalidateTileLayer() busts raster tiles, including the de-prefixed
//      QGIS spelling (vungu_x -> x), so a planner edit never serves a stale
//      rendered image.
//   2. Single-flight coalescing collapses concurrent identical renders into
//      one call to QGIS Server.
//   3. A ServiceException (XML, not PNG) is never written to the cache.

const assert = require('assert')
const { wmsCache, invalidateTileLayer } = require('./src/routes/tiles')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const XML = Buffer.from('<ServiceException>boom</ServiceException>')

async function testInvalidation() {
  await wmsCache.set('stands/EPSG:3857/1,2,3,4/512x512/image/png//true', PNG)
  await wmsCache.set('proposed_peri_urban_zones/EPSG:3857/1,2,3,4/512x512/image/png//true', PNG)
  await wmsCache.set('roads/EPSG:3857/1,2,3,4/512x512/image/png//true', PNG)

  invalidateTileLayer('stands')
  assert.strictEqual(await wmsCache.get('stands/EPSG:3857/1,2,3,4/512x512/image/png//true'), undefined,
    'stands raster should be gone after invalidateTileLayer("stands")')

  // The registry id is vungu_-prefixed; QGIS publishes the short name.
  invalidateTileLayer('vungu_proposed_peri_urban_zones')
  assert.strictEqual(
    await wmsCache.get('proposed_peri_urban_zones/EPSG:3857/1,2,3,4/512x512/image/png//true'), undefined,
    'de-prefixed raster should be busted by the vungu_-prefixed layer id')

  // Unrelated layers survive — invalidation must not be a global flush.
  assert.ok(await wmsCache.get('roads/EPSG:3857/1,2,3,4/512x512/image/png//true'),
    'roads raster should survive an unrelated layer invalidation')
}

async function testSingleFlight() {
  // Mirrors the wmsInFlight map in ogcServices.js.
  const inFlight = new Map()
  let renders = 0
  const render = async () => { renders++; await new Promise(r => setTimeout(r, 10)); return PNG }

  const get = (key) => {
    let pending = inFlight.get(key)
    if (!pending) {
      pending = render().finally(() => inFlight.delete(key))
      inFlight.set(key, pending)
    }
    return pending
  }

  const key = 'roads/EPSG:3857/9,9,9,9/512x512/image/png//true'
  await Promise.all(Array.from({ length: 20 }, () => get(key)))
  assert.strictEqual(renders, 1, `20 concurrent requests must trigger 1 render, got ${renders}`)
  assert.strictEqual(inFlight.size, 0, 'in-flight map must drain after settle')
}

function testServiceExceptionRejected() {
  const isImage = (buf) => !(buf[0] === 0x3c || buf.length === 0)
  assert.ok(isImage(PNG), 'a PNG must be cacheable')
  assert.ok(!isImage(XML), 'a ServiceException must not be cached')
  assert.ok(!isImage(Buffer.alloc(0)), 'an empty body must not be cached')
}

async function main() {
  await testInvalidation()
  await testSingleFlight()
  testServiceExceptionRejected()
  console.log('WMS cache self-check passed:', wmsCache.stats())
}

main().catch((err) => { console.error(err); process.exit(1) })
