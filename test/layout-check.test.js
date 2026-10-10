// The layout check (POST /api/context/check-layout, src/routes/context.js; the rules in src/services/layoutCheck.js) and the service token that
// authenticates SurveyPro's server to it (src/lib/serviceToken.js). Against the live database; the route is mounted on a minimal app.

require('dotenv').config()
const crypto = require('node:crypto')
const Fastify = require('fastify')
const fastifyPostgres = require('@fastify/postgres')
const { Pool } = require('pg')
const { sign, verify, loadPublicKey, MAX_LIFETIME_SECONDS } = require('../src/lib/serviceToken')

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const other = crypto.generateKeyPairSync('ed25519')
const NOW = 1_800_000_000
const claims = { sub: 'surveyor@vungu.test', authority: 'VUNGU', scp: 'check-layout' }

describe('service tokens', () => {
  const good = () => sign(claims, { privateKey, now: NOW }).token
  test('a good token verifies and says who, for which council, for what', () => {
    const c = verify(good(), { publicKey, scope: 'check-layout', now: NOW + 10 })
    expect(c).toMatchObject({ iss: 'surveypro', aud: 'vungis', sub: 'surveyor@vungu.test', authority: 'VUNGU', scp: 'check-layout' })
    expect(c.exp - c.iat).toBe(300)
  })
  test('a token signed by anyone else is refused', () => {
    expect(() => verify(sign(claims, { privateKey: other.privateKey, now: NOW }).token, { publicKey, now: NOW })).toThrow('bad signature')
  })
  test('a token for another purpose is refused', () => {
    expect(() => verify(sign({ ...claims, scp: 'something-else' }, { privateKey, now: NOW }).token, { publicKey, scope: 'check-layout', now: NOW })).toThrow('wrong purpose')
  })
  test('an expired token is refused, a future one too', () => {
    expect(() => verify(good(), { publicKey, now: NOW + 3600 })).toThrow('expired')
    expect(() => verify(good(), { publicKey, now: NOW - 3600 })).toThrow('not yet valid')
  })
  test('a token that claims a long life is refused whatever its signature', () => {
    expect(() => verify(sign(claims, { privateKey, now: NOW, ttl: MAX_LIFETIME_SECONDS + 1 }).token, { publicKey, now: NOW })).toThrow('lifetime too long')
  })
  test('the launch token (VunGIS to SurveyPro) cannot be used the other way', () => {
    const { sign: signLaunch } = require('../src/lib/launchToken')
    const t = signLaunch({ sub: 'surveyor@vungu.test', authority: 'VUNGU', scp: 'check-layout' }, { privateKey, now: NOW }).token
    expect(() => verify(t, { publicKey, scope: 'check-layout', now: NOW })).toThrow('wrong issuer')
  })
  test('"none" and symmetric algorithms are refused', () => {
    const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const t = `${b({ alg: 'none' })}.${b({ iss: 'surveypro', aud: 'vungis', iat: NOW, exp: NOW + 60, jti: 'x', sub: 'a', authority: 'b' })}.`
    expect(() => verify(t, { publicKey, now: NOW })).toThrow('wrong algorithm')
  })
  test('the public key is read from the environment, newlines as \\n', () => {
    const pem = publicKey.export({ type: 'spki', format: 'pem' })
    expect(loadPublicKey({ SURVEYPRO_SERVICE_PUBLIC_KEY: pem.replace(/\n/g, '\\n') })).toBeTruthy()
    expect(loadPublicKey({})).toBeNull()
  })
})

// ── the route and the rules ─────────────────────────────────────────────────────────────────────────────────────────────────────
// its own patch of ground, so suites running side by side cannot meet on it
const W0 = -86500, S0 = 2153500
const poly = (w, s, size = 30) => JSON.stringify({ type: 'Polygon', coordinates: [[[w, s], [w + size, s], [w + size, s + size], [w, s + size], [w, s]]] })
const TOWN = 'CHK-TEST-TOWN'
const PROJECT = 998001

describe('the layout check', () => {
  let app, pool
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows
  const token = (over = {}, o = {}) => sign({ ...claims, ...over }, { privateKey, ...o }).token
  const post = (body, tok = token()) => app.inject({ method: 'POST', url: '/api/context/check-layout', headers: tok ? { authorization: `Bearer ${tok}` } : {}, payload: body })
  const parcel = (id, stand, geojson, over = {}) => ({ id, stand, designation: stand, area_m2: 900, lo_zone: 29, srid: 22289, geojson, ...over })
  const layout = (parcels, over = {}) => ({ authority_code: 'VUNGU', project_id: PROJECT, township: TOWN, survey_class: 'B', parcels, ...over })
  const count = async () => (await q('SELECT count(*)::int AS n FROM land.parcel WHERE township_code = $1 OR source_key LIKE $2', [TOWN, `%:${PROJECT}:%`]))[0].n

  async function seed({ stand, geojson, kind = 'stand', townshipCode = TOWN, source = null }) {
    return (await q(
      `WITH x AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 922029) AS g)
       INSERT INTO land.parcel (stand_no, township_code, geom_source, source_srid, geom_wgs84, transform_method, transform_accuracy_m, area_m2, accuracy_basis, source, parcel_kind, origin, source_relation, source_key)
       SELECT $2, $3, x.g, 922029, ST_Multi(ST_Transform(x.g, 4326)), 'test', 20, round(ST_Area(x.g)::numeric, 2), 'general_plan', 'layout check test', $4, 'custodian', $5, $6 FROM x RETURNING parcel_id`,
      [geojson, stand, kind === 'stand' ? townshipCode : null, kind, source ? 'surveypro' : null, source]))[0].parcel_id
  }
  async function wipe() {
    const c = await pool.connect()
    try {
      await c.query('BEGIN'); await c.query("SET LOCAL gms.purge = 'on'")
      await c.query(`DELETE FROM land.parcel WHERE source = 'layout check test'`)
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
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

  test('a clean layout passes, and the check writes nothing', async () => {
    const before = await count()
    const r = await post(layout([parcel(1, '1', poly(W0, S0)), parcel(2, '2', poly(W0 + 30, S0))]))
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ success: true, ok: true, errors: [], checked: 2, authority: 'VUNGU' })
    expect(await count()).toBe(before)
  })

  test('a stand number already taken in the township is reported, as the importer would refuse it', async () => {
    const held = await seed({ stand: '1', geojson: poly(W0 + 500, S0) })
    const r = (await post(layout([parcel(1, '1', poly(W0, S0))]))).json()
    expect(r.ok).toBe(false)
    expect(r.errors).toEqual([expect.objectContaining({ code: 'stand_no_exists', stand: '1', parcel_id: held })])
  })

  test('an overlap with an existing stand is reported with the size of the overlap', async () => {
    const held = await seed({ stand: '9', geojson: poly(W0 + 600, S0) })
    const r = (await post(layout([parcel(1, '1', poly(W0 + 610, S0))]))).json()
    expect(r.errors).toEqual([expect.objectContaining({ code: 'overlaps_existing', parcel_id: held, stand_no: '9' })])
    expect(r.errors[0].overlap_m2).toBeGreaterThan(100)
  })

  test('a farm does not count: a township is carved out of one', async () => {
    await seed({ stand: 'F1', geojson: poly(W0 + 700 - 100, S0 - 100, 400), kind: 'farm' })
    expect((await post(layout([parcel(1, '1', poly(W0 + 700, S0))]))).json().ok).toBe(true)
  })

  test('what this very project put in the register earlier is not its own obstacle', async () => {
    await seed({ stand: '1', geojson: poly(W0 + 800, S0), source: `VUNGU:${PROJECT}:1` })
    expect((await post(layout([parcel(1, '1', poly(W0 + 800, S0))]))).json().ok).toBe(true)
  })

  test('problems with the layout itself: repeated or missing numbers, overlapping parcels, a bad or unsupported system', async () => {
    const bow = JSON.stringify({ type: 'Polygon', coordinates: [[[W0, S0 + 900], [W0 + 30, S0 + 930], [W0 + 30, S0 + 900], [W0, S0 + 930], [W0, S0 + 900]]] })
    const r = (await post(layout([
      parcel(1, '1', poly(W0, S0 + 900)), parcel(2, '1', poly(W0 + 100, S0 + 900)),        // repeated number
      parcel(3, '', poly(W0 + 200, S0 + 900), { designation: '' }),                        // no number
      parcel(4, '4', bow),                                                                 // bow-tie
      parcel(5, '5', poly(W0 + 300, S0 + 900), { lo_zone: 25 }),                           // Lo25 is not in the registry
      parcel(6, '6', poly(W0 + 400, S0 + 900)), parcel(7, '7', poly(W0 + 410, S0 + 900)), // overlap
    ]))).json()
    const codes = r.errors.map((e) => e.code).sort()
    expect(codes).toEqual(['duplicate_stand_no_in_project', 'invalid_geometry', 'missing_stand_no', 'overlap_within_project', 'unsupported_crs'])
  })

  test('an area that disagrees with the geometry, and a class that does not fit the township, are warnings, not errors', async () => {
    const r = (await post(layout([parcel(1, '1', poly(W0 + 1000, S0), { area_m2: 1500 })], { survey_class: 'C' }))).json()
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code).sort()).toEqual(['area_disagrees', 'class_vs_township'])
  })

  test('no token, a bad token, a token for another purpose, another council: refused', async () => {
    expect((await post(layout([]), null)).statusCode).toBe(401)
    expect((await post(layout([]), 'nonsense')).statusCode).toBe(401)
    expect((await post(layout([]), token({ scp: 'other' }))).statusCode).toBe(401)
    expect((await post(layout([]), token({}, { privateKey: other.privateKey }))).statusCode).toBe(401)
    const wrong = await post(layout([]), token({ authority: 'GWERU' }))
    expect(wrong.statusCode).toBe(403)
    expect(wrong.json().error).toBe('wrong_authority')
  })

  test('a council VunGIS does not know is not found', async () => {
    const r = await post(layout([], { authority_code: 'NOWHERE9' }), token({ authority: 'NOWHERE9' }))
    expect(r.statusCode).toBe(404)
    expect(r.json().error).toBe('unknown_authority')
  })

  test('without a configured key the endpoint says it is not connected, and checks nothing', async () => {
    const saved = process.env.SURVEYPRO_SERVICE_PUBLIC_KEY
    delete process.env.SURVEYPRO_SERVICE_PUBLIC_KEY
    try {
      const r = await post(layout([]))
      expect(r.statusCode).toBe(503)
      expect(r.json().error).toBe('not_configured')
    } finally { process.env.SURVEYPRO_SERVICE_PUBLIC_KEY = saved }
  })
})
