// What VunGIS tells a surveyor about the register around their work (POST /api/context/parcels; src/services/contextParcels.js), against the live
// database. The route is mounted on a minimal app, authenticated by a SurveyPro service token made for this purpose.

require('dotenv').config()
const crypto = require('node:crypto')
const Fastify = require('fastify')
const fastifyPostgres = require('@fastify/postgres')
const { Pool } = require('pg')
const { sign } = require('../src/lib/serviceToken')
const { readArea, qualityOf, MAX_SIDE_M, MAX_RADIUS_M } = require('../src/services/contextParcels')

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const claims = { sub: 'surveyor@vungu.test', authority: 'VUNGU' }
// its own patch of ground, so suites running side by side cannot meet on it
const W0 = -89000, S0 = 2156000
const sq = (w, s, n = 30) => JSON.stringify({ type: 'Polygon', coordinates: [[[w, s], [w + n, s], [w + n, s + n], [w, s + n], [w, s]]] })
const TAG = 'context parcels test'

describe('how far to trust an outline', () => {
  test('approved, council-surveyed and indicative are told apart from what the register knows of how each was made', () => {
    expect(qualityOf({ sg_ref: 'GP 123', accuracy_basis: 'general_plan', origin: 'custodian' })).toBe('approved')
    expect(qualityOf({ sg_ref: null, accuracy_basis: 'general_plan', origin: 'custodian' })).toBe('approved')
    expect(qualityOf({ sg_ref: null, accuracy_basis: 'surveyed', origin: 'authority' })).toBe('council_survey')
    expect(qualityOf({ sg_ref: null, accuracy_basis: 'map_digitised', origin: 'custodian' })).toBe('indicative')
    expect(qualityOf({ sg_ref: null, accuracy_basis: 'unknown', origin: 'custodian' })).toBe('indicative')
    expect(qualityOf({ sg_ref: 'GP 9', accuracy_basis: 'map_digitised', origin: 'authority' })).toBe('approved')   // once approved it is approved, however it began
  })
})

describe('the area that may be asked for', () => {
  test('a box or a circle, in a belt the register has, and never bigger than the cap', () => {
    expect(readArea({ lo_zone: 29, area: { bbox: [0, 0, 1000, 1000] } })).toMatchObject({ kind: 'bbox', bbox: [-250, -250, 1250, 1250] })       // the default buffer is added
    expect(readArea({ lo_zone: 29, buffer_m: 0, area: { bbox: [1000, 1000, 0, 0] } })).toMatchObject({ bbox: [0, 0, 1000, 1000] })           // either way round
    expect(readArea({ lo_zone: 31, area: { center: { lon: 29.8, lat: -19.4 }, radius_m: 500 } })).toMatchObject({ kind: 'circle', radius: 750 })
    for (const bad of [
      { lo_zone: 28, area: { bbox: [0, 0, 1, 1] } },
      { lo_zone: 29, area: {} },
      { lo_zone: 29, area: { bbox: [0, 0, 'x', 1] } },
      { lo_zone: 29, buffer_m: -1, area: { bbox: [0, 0, 1, 1] } },
      { lo_zone: 29, buffer_m: 5000, area: { bbox: [0, 0, 1, 1] } },
      { lo_zone: 29, area: { bbox: [0, 0, MAX_SIDE_M, 10] } },                       // with the buffer, wider than the cap
      { lo_zone: 29, area: { center: { lon: 29.8, lat: -19.4 }, radius_m: MAX_RADIUS_M } },
      { lo_zone: 29, area: { center: { lon: 29.8, lat: -99 }, radius_m: 100 } },
    ]) expect(() => readArea(bad)).toThrow()
  })
})

describe('around a place', () => {
  let app, pool
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows
  const token = (over = {}, scope = 'context-parcels', o = {}) => sign({ ...claims, scp: scope, ...over }, { privateKey, ...o }).token
  const post = (body, tok = token()) => app.inject({ method: 'POST', url: '/api/context/parcels', headers: tok ? { authorization: `Bearer ${tok}` } : {}, payload: body })
  // the ground also holds the register's real farms: look only at what this test put there
  const seeded = async (features) => { const ids = new Set((await q('SELECT parcel_id FROM land.parcel WHERE source = $1', [TAG])).map((r) => r.parcel_id)); return features.filter((f) => ids.has(f.properties.parcel_id)) }
  const ask = (w, s, over = {}) => ({ authority_code: 'VUNGU', lo_zone: 29, buffer_m: 0, area: { bbox: [w, s, w + 200, s + 200] }, ...over })

  async function seed({ stand, geojson, srid = 922029, kind = 'stand', origin = 'custodian', sg_ref = null, basis = 'general_plan', status = 'current', est = null, township = 'CTX-TEST-TOWN', survey_class = null, ref = null, owner = null }) {
    return (await q(
      `WITH x AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 922029) AS g0), y AS (SELECT CASE WHEN $2::int = 922029 THEN g0 ELSE ST_Transform(g0, $2::int) END AS g FROM x)
       INSERT INTO land.parcel (stand_no, township_code, geom_source, source_srid, geom_wgs84, transform_method, transform_accuracy_m, area_m2, accuracy_basis, source, parcel_kind, origin, sg_ref, status, estimated_accuracy_m, survey_class, cadastre_ref, custodian_dept)
       SELECT $3, $4, y.g, $2::int, ST_Multi(ST_Transform(y.g, 4326)), 'test', 20, 900, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14 FROM y RETURNING parcel_id`,
      [geojson, srid, stand, kind === 'farm' ? null : township, basis, TAG, kind, origin, sg_ref, status, est, survey_class, ref, owner ? `owner: ${owner}` : 'Survey Section']))[0].parcel_id
  }
  async function wipe() {
    const c = await pool.connect()
    try { await c.query('BEGIN'); await c.query("SET LOCAL gms.purge = 'on'"); await c.query('DELETE FROM land.parcel WHERE source = $1', [TAG]); await c.query('COMMIT') }
    catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  beforeAll(async () => {
    process.env.SURVEYPRO_SERVICE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' })
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
    app = Fastify({ logger: false })
    await app.register(fastifyPostgres, { connectionString: process.env.DATABASE_URL })
    const dbContext = require('../src/lib/dbContext')
    dbContext.install(app)
    app.addHook('onRequest', (_req, _reply, done) => dbContext.runWithRequest(done))
    await app.register(require('../src/routes/context').contextRoutes, { prefix: '/api' })
    await app.ready()
    await wipe()
  })
  afterEach(wipe)
  afterAll(async () => { await wipe(); await app.close(); await pool.end() })

  test('what is there comes back with its kind and how far to trust it, and what is not there does not', async () => {
    await seed({ stand: '1', geojson: sq(W0 + 10, S0 + 10), sg_ref: 'GP 123' })                                                    // approved
    await seed({ stand: '2', geojson: sq(W0 + 50, S0 + 10), origin: 'authority', basis: 'surveyed', survey_class: 'B' })            // the council's, awaiting approval
    await seed({ stand: 'F1', geojson: sq(W0 + 90, S0 + 10, 60), kind: 'farm', origin: 'custodian', basis: 'map_digitised', est: 25, ref: 'Farm 7' })   // indicative
    await seed({ stand: '9', geojson: sq(W0 + 10, S0 + 10), status: 'retired' })                                                   // superseded: not shown
    await seed({ stand: '10', geojson: sq(W0 + 5000, S0 + 5000) })                                                                 // far away
    const r = await post(ask(W0, S0))
    expect(r.statusCode).toBe(200)
    const d = r.json()
    expect(d).toMatchObject({ success: true, authority: 'VUNGU', lo_zone: 29, srid: 922029, truncated: false })
    const by = Object.fromEntries((await seeded(d.features)).map((f) => [f.properties.stand_no, f.properties]))
    expect(Object.keys(by).sort()).toEqual(['1', '2', 'F1'])
    expect(by['1']).toMatchObject({ quality: 'approved', sg_ref: 'GP 123', indicative_m: null })
    expect(by['2']).toMatchObject({ quality: 'council_survey', survey_class: 'B', origin: 'authority', indicative_m: null })
    expect(by['F1']).toMatchObject({ quality: 'indicative', kind: 'farm', farm_ref: 'Farm 7', indicative_m: 25 })
  })

  test('the outline is in the survey system the surveyor works in: westing as X, southing as Y', async () => {
    await seed({ stand: '1', geojson: sq(W0 + 10, S0 + 10), sg_ref: 'GP 1' })
    const f = (await seeded((await post(ask(W0, S0))).json().features))[0]
    expect(f.geometry.type).toBe('Polygon')
    expect(f.geometry.coordinates[0][0]).toEqual([W0 + 10, S0 + 10])
    expect(f.geometry.coordinates[0][2]).toEqual([W0 + 40, S0 + 40])
  })

  test('a parcel kept in another belt is put into the one asked for', async () => {
    await seed({ stand: '1', geojson: sq(W0 + 10, S0 + 10), srid: 922031, sg_ref: 'GP 2' })
    const f = (await seeded((await post(ask(W0, S0))).json().features))[0]
    const [w, s] = f.geometry.coordinates[0][0]
    expect(Math.abs(w - (W0 + 10))).toBeLessThan(0.05)
    expect(Math.abs(s - (S0 + 10))).toBeLessThan(0.05)
  })

  test('only public facts leave: no owner, account, band or custodian', async () => {
    await seed({ stand: '1', geojson: sq(W0 + 10, S0 + 10), sg_ref: 'GP 3', owner: 'A. Citizen' })
    const body = (await post(ask(W0, S0))).body
    expect(Object.keys((await seeded(JSON.parse(body).features))[0].properties).sort()).toEqual(
      ['area_m2', 'basis', 'council', 'farm_ref', 'indicative_m', 'kind', 'origin', 'parcel_id', 'quality', 'sg_ref', 'stand_no', 'status', 'survey_class', 'township_code'])
    expect(body).not.toMatch(/Citizen|"owner"|account|"band"/i)
  })

  test('the buffer brings in what is just outside the box, and a circle by longitude and latitude finds what is inside it', async () => {
    await seed({ stand: '1', geojson: sq(W0 + 230, S0 + 10), sg_ref: 'GP 4' })                       // 30 m east of the box
    expect(await seeded((await post(ask(W0, S0))).json().features)).toHaveLength(0)
    expect(await seeded((await post(ask(W0, S0, { buffer_m: 100 }))).json().features)).toHaveLength(1)
    const c = (await q(`SELECT ST_X(ST_Transform(ST_Centroid(geom_wgs84), 4326)) AS lon, ST_Y(ST_Centroid(geom_wgs84)) AS lat FROM land.parcel WHERE source = $1`, [TAG]))[0]
    const r = await post({ authority_code: 'VUNGU', lo_zone: 29, area: { center: { lon: c.lon, lat: c.lat }, radius_m: 100 } })
    expect(await seeded(r.json().features)).toHaveLength(1)
  })

  test('a question that is too big, or makes no sense, is refused in words, not answered', async () => {
    const big = await post(ask(W0, S0, { area: { bbox: [W0, S0, W0 + MAX_SIDE_M + 1, S0 + 10] } }))
    expect(big.statusCode).toBe(422)
    expect(big.json().error).toBe('area_too_large')
    expect((await post(ask(W0, S0, { lo_zone: 28 }))).json().error).toBe('bad_zone')
    expect((await post(ask(W0, S0, { area: {} }))).json().error).toBe('bad_area')
    const missing = await post(ask(W0, S0, { lo_zone: 25 }))
    expect(missing.statusCode).toBe(409)
    expect(missing.json().error).toBe('zone_unknown')
  })

  test('the token must be for this purpose, this council and a council VunGIS knows', async () => {
    expect((await post(ask(W0, S0), null)).statusCode).toBe(401)
    expect((await post(ask(W0, S0), 'nonsense')).statusCode).toBe(401)
    expect((await post(ask(W0, S0), token({}, 'check-layout'))).statusCode).toBe(401)                  // a token for the layout check does not open this
    expect((await post(ask(W0, S0), token({}, 'context-parcels', { privateKey: crypto.generateKeyPairSync('ed25519').privateKey }))).statusCode).toBe(401)
    const other = await post(ask(W0, S0), token({ authority: 'GWERU' }))
    expect([other.statusCode, other.json().error]).toEqual([403, 'wrong_authority'])
    const unknown = await post(ask(W0, S0, { authority_code: 'NOWHERE9' }), token({ authority: 'NOWHERE9' }))
    expect([unknown.statusCode, unknown.json().error]).toEqual([404, 'unknown_authority'])
  })

  test('the layout check\'s token is not good here, and this one is not good there', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/context/check-layout', headers: { authorization: `Bearer ${token({}, 'context-parcels')}` }, payload: { authority_code: 'VUNGU', project_id: 1, parcels: [] } })
    expect(r.statusCode).toBe(401)
  })

  test('without a configured key it says it is not connected', async () => {
    const saved = process.env.SURVEYPRO_SERVICE_PUBLIC_KEY
    delete process.env.SURVEYPRO_SERVICE_PUBLIC_KEY
    try { expect((await post(ask(W0, S0))).statusCode).toBe(503) } finally { process.env.SURVEYPRO_SERVICE_PUBLIC_KEY = saved }
  })

  test('it only reads', async () => {
    await seed({ stand: '1', geojson: sq(W0 + 10, S0 + 10), sg_ref: 'GP 5' })
    const before = (await q('SELECT count(*)::int AS n, max(updated_at) AS u FROM land.parcel WHERE source = $1', [TAG]))[0]
    await post(ask(W0, S0))
    expect((await q('SELECT count(*)::int AS n, max(updated_at) AS u FROM land.parcel WHERE source = $1', [TAG]))[0]).toEqual(before)
  })
})
