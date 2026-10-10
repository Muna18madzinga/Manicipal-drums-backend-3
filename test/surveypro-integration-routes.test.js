// The integration console's view of the SurveyPro importer (src/routes/gms-integration.js): who may see it, who may run it, and that no connection string
// or secret ever leaves the server. Needs the demo GIS users (scripts/seed-demo-users.js), as the GMS acceptance suite does.

require('dotenv').config()
const Fastify = require('fastify')
const { Pool } = require('pg')
const { authRoutes } = require('../src/routes/auth')
const { gmsIntegrationRoutes } = require('../src/routes/gms-integration')
const { auditLogPlugin } = require('../src/middleware/auditLog')
const { stubAdapter } = require('../src/services/gms/erpAdapter')
const { loginAs } = require('./helpers/auth')

const SECRET_URL = 'postgresql://reader_x:SCHROUTE-secret@127.0.0.1:1/none'

describe('the SurveyPro importer in the integration console', () => {
  let app, pool, startedAt
  const tok = {}
  const as = (t) => ({ authorization: `Bearer ${t}` })
  const saved = {}
  const env = (o) => { for (const k of Object.keys(o)) { if (!(k in saved)) saved[k] = process.env[k]; if (o[k] == null) delete process.env[k]; else process.env[k] = o[k] } }

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(require('@fastify/postgres'), { connectionString: process.env.DATABASE_URL })
    await app.register(require('@fastify/cookie'), { secret: process.env.COOKIE_SECRET || process.env.JWT_SECRET })
    await app.register(auditLogPlugin)
    await app.register(async (s) => { await authRoutes(s) }, { prefix: '/api' })
    await app.register(gmsIntegrationRoutes, { prefix: '/api', erpAdapter: stubAdapter(), worker: false })
    await app.ready()
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
    startedAt = (await pool.query('SELECT now() AS t')).rows[0].t
    for (const r of ['gis', 'viewer']) tok[r] = await loginAs(app, `demo.${r}@vungu.test`, 'demo1234')
  })
  afterEach(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })
  afterAll(async () => {
    await pool.query('DELETE FROM integration.surveypro_import_run WHERE started_at >= $1', [startedAt])
    await pool.end(); await app.close()
  })

  test('a GIS officer may look at it, a viewer may not', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/integration/surveypro', headers: as(tok.gis) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/integration/surveypro', headers: as(tok.viewer) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/integration/surveypro' })).statusCode).toBe(401)
  })

  test('it says whether it is scheduled and which councils, never how to reach them', async () => {
    env({ SURVEYPRO_IMPORT_MINUTES: '15', SURVEYPRO_READERS: JSON.stringify({ VUNGU: SECRET_URL, GWERU: SECRET_URL + '2' }), SURVEYPRO_DATABASE_URL: null })
    const r = await app.inject({ method: 'GET', url: '/api/integration/surveypro', headers: as(tok.gis) })
    const d = r.json().data
    expect(d).toMatchObject({ scheduled: true, interval_minutes: 15, applies: true, councils: ['VUNGU', 'GWERU'], misconfigured: null })
    expect(r.body).not.toContain('SCHROUTE-secret')
    expect(r.body).not.toMatch(/postgres(ql)?:\/\//)
  })

  test('not scheduled is the default, and says so', async () => {
    env({ SURVEYPRO_IMPORT_MINUTES: null, SURVEYPRO_READERS: null, SURVEYPRO_DATABASE_URL: null })
    const d = (await app.inject({ method: 'GET', url: '/api/integration/surveypro', headers: as(tok.gis) })).json().data
    expect(d).toMatchObject({ scheduled: false, interval_minutes: null, councils: [] })
  })

  test('a broken configuration is reported, not thrown', async () => {
    env({ SURVEYPRO_READERS: '{oops', SURVEYPRO_DATABASE_URL: null })
    const r = await app.inject({ method: 'GET', url: '/api/integration/surveypro', headers: as(tok.gis) })
    expect(r.statusCode).toBe(200)
    expect(r.json().data.misconfigured).toMatch(/not valid JSON/)
  })

  test('running it now needs the integration role, a configured council, and is a dry run unless told otherwise', async () => {
    env({ SURVEYPRO_READERS: null, SURVEYPRO_DATABASE_URL: null })
    expect((await app.inject({ method: 'POST', url: '/api/integration/surveypro/run', headers: as(tok.viewer), payload: {} })).statusCode).toBe(403)
    const none = await app.inject({ method: 'POST', url: '/api/integration/surveypro/run', headers: as(tok.gis), payload: {} })
    expect(none.statusCode).toBe(503)
    expect(none.json().error).toBe('not_configured')

    env({ SURVEYPRO_READERS: JSON.stringify({ DOWN: SECRET_URL }) })
    const r = await app.inject({ method: 'POST', url: '/api/integration/surveypro/run', headers: as(tok.gis), payload: {} })
    expect(r.statusCode).toBe(200)
    expect(r.json().data).toMatchObject({ applied: false, status: 'failed' })        // a dry run, and the council could not be read
    expect(r.body).not.toContain('SCHROUTE-secret')
  })

  test('the server runs it on its own timer when scheduled, records it, and stops when the server does', async () => {
    env({ SURVEYPRO_IMPORT_MINUTES: '1', SURVEYPRO_READERS: JSON.stringify({ DOWN: SECRET_URL }), SURVEYPRO_DATABASE_URL: null, GMS_WORKER: null })
    const timed = Fastify({ logger: false })
    await timed.register(require('@fastify/postgres'), { connectionString: process.env.DATABASE_URL })
    await timed.register(gmsIntegrationRoutes, { prefix: '/api', erpAdapter: stubAdapter(), importEveryMs: 300 })
    await timed.ready()
    const since = (await pool.query('SELECT now() AS t')).rows[0].t
    await new Promise((r) => setTimeout(r, 1500))
    await timed.close()
    const ran = (await pool.query("SELECT status, trigger, applied FROM integration.surveypro_import_run WHERE started_at >= $1 AND trigger = 'schedule'", [since])).rows
    expect(ran.length).toBeGreaterThanOrEqual(1)
    expect(ran[0]).toEqual({ status: 'failed', trigger: 'schedule', applied: true })
    await new Promise((r) => setTimeout(r, 800))
    const after = (await pool.query("SELECT count(*)::int AS n FROM integration.surveypro_import_run WHERE started_at >= $1 AND trigger = 'schedule'", [since])).rows[0].n
    await new Promise((r) => setTimeout(r, 800))
    expect((await pool.query("SELECT count(*)::int AS n FROM integration.surveypro_import_run WHERE started_at >= $1 AND trigger = 'schedule'", [since])).rows[0].n).toBe(after)   // closed: no more runs
  })

  test('the run it just made is on the list, with its detail, and still no secret', async () => {
    const list = (await app.inject({ method: 'GET', url: '/api/integration/surveypro', headers: as(tok.gis) })).json().data
    const mine = list.runs.find((x) => x.trigger === 'manual')
    expect(mine).toBeTruthy()
    expect(mine.report).toBeUndefined()                                               // the list is light; the detail has it
    const one = await app.inject({ method: 'GET', url: `/api/integration/surveypro/runs/${mine.id}`, headers: as(tok.gis) })
    expect(one.statusCode).toBe(200)
    expect(one.json().data.report[0]).toMatchObject({ council: 'DOWN' })
    expect(one.body).not.toContain('SCHROUTE-secret')
    expect((await app.inject({ method: 'GET', url: '/api/integration/surveypro/runs/999999999', headers: as(tok.gis) })).statusCode).toBe(404)
  })
})
