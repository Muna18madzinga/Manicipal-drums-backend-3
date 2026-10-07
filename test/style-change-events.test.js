const { tilesRoutes, invalidateTileLayer, emitStyleChange, tileEpoch, wmsCache } = require('../src/routes/tiles')

// Registers the tile routes on a stand-in server and returns the /map/events
// handler plus a connected fake SSE client.
async function connectClient() {
  const routes = {}
  const server = new Proxy({ redis: undefined }, {
    get: (target, key) => {
      if (key in target) return target[key]
      if (key === 'get') return (path, ...rest) => { routes[path] = rest[rest.length - 1] }
      return () => {}
    },
  })
  await tilesRoutes(server)

  const writes = []
  const reply = { raw: { writeHead() {}, write: (chunk) => writes.push(chunk) } }
  const closeHandlers = []
  const request = { raw: { on: (event, fn) => event === 'close' && closeHandlers.push(fn) } }
  routes['/map/events'](request, reply) // never resolves by design
  return { writes, disconnect: () => closeHandlers.forEach((fn) => fn()) }
}

const events = (writes) =>
  writes.filter((w) => w.startsWith('data: ')).map((w) => JSON.parse(w.slice(6)))

describe('style-change notifications', () => {
  test('a symbology change moves every layer on to a new tile edition', () => {
    const before = tileEpoch('gweru_chiefdoms')
    const other = tileEpoch('gweru_rivers')
    emitStyleChange('test')
    expect(tileEpoch('gweru_chiefdoms')).not.toBe(before)
    expect(tileEpoch('gweru_rivers')).not.toBe(other)
  })

  test('a data edit moves only that layer on, including the de-prefixed spelling', () => {
    const chiefdoms = tileEpoch('gweru_chiefdoms')
    const zonesShort = tileEpoch('proposed_peri_urban_zones')
    const zonesLong = tileEpoch('vungu_proposed_peri_urban_zones')
    invalidateTileLayer('vungu_proposed_peri_urban_zones')
    expect(tileEpoch('vungu_proposed_peri_urban_zones')).not.toBe(zonesLong)
    expect(tileEpoch('proposed_peri_urban_zones')).not.toBe(zonesShort)
    expect(tileEpoch('gweru_chiefdoms')).toBe(chiefdoms)
  })

  test('a symbology change drops the rendered WMS tiles', async () => {
    await wmsCache.set('gweru_chiefdoms/EPSG:3857/1,2,3,4/512x512/image/png//true', Buffer.from('png'))
    expect(await wmsCache.get('gweru_chiefdoms/EPSG:3857/1,2,3,4/512x512/image/png//true')).toBeTruthy()
    emitStyleChange('test')
    expect(await wmsCache.get('gweru_chiefdoms/EPSG:3857/1,2,3,4/512x512/image/png//true')).toBeFalsy()
  })

  test('connected maps receive a style event for all layers', async () => {
    const client = await connectClient()
    emitStyleChange('qgis-project')
    const got = events(client.writes)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ type: 'style', layer: '*', reason: 'qgis-project' })
    client.disconnect()
  })
})
