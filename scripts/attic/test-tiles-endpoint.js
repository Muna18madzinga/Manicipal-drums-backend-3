// test-tiles-endpoint.js
// Manual integration check for the /api/tiles vector-tile service.
// Run against a running backend: `node test-tiles-endpoint.js`.
// Override the base via env: `TILE_BASE=https://staging.example/api/tiles`.
const BASE = process.env.TILE_BASE || 'http://localhost:3000/api/tiles'

async function check(name, fn) {
  try {
    await fn()
    console.log(`PASS  ${name}`)
  } catch (err) {
    console.log(`FAIL  ${name} — ${err.message}`)
    process.exitCode = 1
  }
}

async function main() {
  await check('catalog lists 24 layers', async () => {
    const r = await fetch(`${BASE}/layers`)
    const j = await r.json()
    if (!j.success || j.data.length !== 24) {
      throw new Error(`got success=${j.success} count=${j.data && j.data.length}`)
    }
  })

  // Zimbabwe sits in tile z6/x37/y35 (we confirmed empirically that
  // ST_TileEnvelope(6,37,35) intersects Zimbabwe's bounding box).
  await check('provinces tile z6 returns MVT bytes', async () => {
    const r = await fetch(`${BASE}/provinces/6/37/35.pbf`)
    if (r.status !== 200) throw new Error(`status ${r.status}`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length === 0) throw new Error('empty body')
  })

  await check('roads tile z8 returns MVT bytes', async () => {
    const r = await fetch(`${BASE}/roads/8/149/142.pbf`)
    if (r.status !== 200) throw new Error(`status ${r.status}`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length === 0) throw new Error('empty body')
  })

  await check('unknown layer returns 404', async () => {
    const r = await fetch(`${BASE}/not_a_layer/6/37/35.pbf`)
    if (r.status !== 404) throw new Error(`status ${r.status}`)
  })

  await check('invalid tile coordinate returns 400', async () => {
    const r = await fetch(`${BASE}/provinces/6/9999/9999.pbf`)
    if (r.status !== 400) throw new Error(`status ${r.status}`)
  })

  await check('buildings tile below minzoom returns 204', async () => {
    const r = await fetch(`${BASE}/buildings/6/37/35.pbf`)
    if (r.status !== 204) throw new Error(`status ${r.status}`)
  })

  await check('feature lookup returns GeoJSON', async () => {
    const r = await fetch(`${BASE}/provinces/5`)
    if (r.status !== 200) throw new Error(`status ${r.status}`)
    const f = await r.json()
    if (f.type !== 'Feature') throw new Error(`bad type ${f.type}`)
    if (!f.geometry || !f.geometry.type) throw new Error('missing geometry')
  })

  await check('feature lookup with invalid id returns 400', async () => {
    const r = await fetch(`${BASE}/provinces/notanumber`)
    if (r.status !== 400) throw new Error(`status ${r.status}`)
  })
}

main()
