// src/routes/__tests__/gms.acceptance.test.js
// GIS Management System phase 1 acceptance tests (build brief section 12,
// tests 1-6, 11, 12) and business rules 1, 4, 5 and 10, against the live DB.
//
// Needs: migration 132, the demo users (scripts/seed-demo-users.js with the
// GIS roles) and the fictional Tsamba sample (scripts/seed-tsamba.js).
//
// Everything this suite writes lives in a throwaway township and is purged
// in afterAll, except audit rows, which are append-only by design.

require('dotenv').config()
const crypto = require('node:crypto')
const Fastify = require('fastify')
const { Pool } = require('pg')
const { authRoutes } = require('../auth')
const { gmsRoutes } = require('../gms')
const { gmsIntegrationRoutes } = require('../gms-integration')
const { auditLogPlugin } = require('../../middleware/auditLog')
const { stubAdapter } = require('../../services/gms/erpAdapter')
const { enqueue, deliverOne, MAX_ATTEMPTS } = require('../../services/gms/outbox')
const { loginAs } = require('../../../test/helpers/auth')
const { purgeTownship, layoutFeatures, loOrigin, LO29 } = require('../../../scripts/seed-tsamba')

const SECRET = 'test-inbound-secret'
const TOWNSHIP = `TEST-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
const PW = 'demo1234'

describe('GMS phase 1 acceptance', () => {
  let app
  let pool
  let erp
  const tok = {}
  let parcels // stand_no -> parcel_id for the imported test layout
  let origin
  const as = (t) => ({ authorization: `Bearer ${t}` })

  const signed = (event) => {
    const body = JSON.stringify(event)
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex')
    return app.inject({
      method: 'POST', url: '/api/integration/inbound', payload: body,
      headers: { 'content-type': 'application/json', 'x-erp-signature': `sha256=${sig}` },
    })
  }
  const erpEvent = (type, key, payload) => ({
    event_id: crypto.randomUUID(), type, version: 1, occurred_at: new Date().toISOString(),
    source: 'erp-test', idempotency_key: `${TOWNSHIP}:${key}`, payload,
  })

  beforeAll(async () => {
    process.env.ERP_INBOUND_SECRET = SECRET
    erp = stubAdapter()
    app = Fastify({ logger: false })
    await app.register(require('@fastify/postgres'), { connectionString: process.env.DATABASE_URL })
    await app.register(require('@fastify/cookie'), { secret: process.env.COOKIE_SECRET || process.env.JWT_SECRET })
    await app.register(auditLogPlugin)
    await app.register(async (s) => { await authRoutes(s) }, { prefix: '/api' })
    await app.register(gmsRoutes, { prefix: '/api' })
    await app.register(gmsIntegrationRoutes, { prefix: '/api', erpAdapter: erp, worker: false })
    await app.ready()
    pool = new Pool({ connectionString: process.env.DATABASE_URL })

    for (const r of ['gis-head', 'gis-data', 'gis-dev', 'gis-analyst', 'gis-tech', 'dept-editor']) {
      tok[r] = await loginAs(app, `demo.${r}@vungu.test`, PW)
    }
    // West of the Tsamba sample, still in the Lo29 belt.
    origin = await loOrigin(pool, 29.40, -19.70)
  })

  afterAll(async () => {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await purgeTownship(c, TOWNSHIP, null)
      await c.query('COMMIT')
    } finally {
      c.release()
    }
    await pool.end()
    await app.close()
  })

  const importPlan = (token, features, commit, township = TOWNSHIP) => app.inject({
    method: 'POST', url: '/api/gms/imports/general-plan', headers: as(token),
    payload: { sg_ref: `${TOWNSHIP} GP`, township_code: township, source_srid: LO29, features, commit },
  })

  // ── Test 1 ─────────────────────────────────────────────────────────────
  test('1: committing an approved general plan creates 60 class-A parcels and 60 ParcelCreated events', async () => {
    const features = layoutFeatures(origin.y, origin.x)

    const dry = await importPlan(tok['gis-data'], features, false)
    expect(dry.statusCode).toBe(200)
    expect(dry.json().committed).toBe(false)
    expect(dry.json().report).toMatchObject({ source_crs: 'Lo29', feature_count: 60, errors: [] })

    const res = await importPlan(tok['gis-data'], features, true)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.committed).toBe(true)
    expect(body.parcel_ids).toHaveLength(60)

    const { rows } = await pool.query(
      `SELECT parcel_id, stand_no, accuracy_class, source_srid, ST_SRID(geom_source) AS src_srid,
              ST_SRID(geom_wgs84) AS wgs_srid, transform_method, area_m2
         FROM land.parcel WHERE township_code = $1`, [TOWNSHIP])
    expect(rows).toHaveLength(60)
    for (const r of rows) {
      expect(r).toMatchObject({ accuracy_class: 'A', source_srid: LO29, src_srid: LO29, wgs_srid: 4326 })
      expect(r.transform_method).toMatch(/Arc 1950/)
      expect(Number(r.area_m2)).toBeCloseTo(600, 1)
    }
    parcels = new Map(rows.map((r) => [r.stand_no, r.parcel_id]))

    const { rows: [ev] } = await pool.query(
      `SELECT count(*)::int AS n FROM integration.outbox_event
        WHERE type = 'ParcelCreated' AND payload->>'parcel_id' = ANY($1)`, [body.parcel_ids])
    expect(ev.n).toBe(60)
  })

  test('1: only gis_head / gis_data may import survey data', async () => {
    const res = await importPlan(tok['gis-tech'], layoutFeatures(origin.y, origin.x), false)
    expect(res.statusCode).toBe(403)
  })

  // ── Test 2 / rule 1 ────────────────────────────────────────────────────
  test('2: a Planning dept_editor cannot move a parcel boundary and is told why', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/gms/parcels/${parcels.get('101')}`, headers: as(tok['dept-editor']),
      payload: { geometry: { type: 'Polygon', coordinates: [] } },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('boundary_survey_only')
    expect(res.json().message).toMatch(/only through an import of an approved general plan/)

    const attr = await app.inject({
      method: 'PATCH', url: `/api/gms/parcels/${parcels.get('101')}`, headers: as(tok['dept-editor']),
      payload: { sg_ref: 'X' },
    })
    expect(attr.statusCode).toBe(403)
  })

  test('rule 1: the database refuses a boundary change outside a survey import', async () => {
    await expect(pool.query(
      `UPDATE land.parcel SET geom_wgs84 = ST_Multi(ST_Translate(geom_wgs84, 0.001, 0)) WHERE parcel_id = $1`,
      [parcels.get('101')],
    )).rejects.toThrow(/approved Survey Section import/)
  })

  // ── Test 3 ─────────────────────────────────────────────────────────────
  test('3: overlapping parcels in a layout are blocked and the overlap is returned for highlighting', async () => {
    const f = layoutFeatures(origin.y - 5000, origin.x, 901).slice(0, 2)
    // Push stand 902 five metres back over 901.
    f[1].geometry.coordinates[0] = f[1].geometry.coordinates[0].map(([y, x]) => [y + 5, x])
    const res = await importPlan(tok['gis-data'], f, true, `${TOWNSHIP}-OVL`)
    expect(res.statusCode).toBe(422)
    const overlap = res.json().report.errors.find((e) => e.code === 'overlap')
    expect(overlap.stand_nos).toEqual(['901', '902'])
    expect(overlap.overlap_m2).toBeCloseTo(150, 0)
    expect(overlap.geometry.type).toBe('Polygon')
    const { rowCount } = await pool.query('SELECT 1 FROM land.parcel WHERE township_code = $1', [`${TOWNSHIP}-OVL`])
    expect(rowCount).toBe(0)
  })

  // ── Rule 4 ─────────────────────────────────────────────────────────────
  test('rule 4: stand numbers are unique within a township and parcels are never deleted', async () => {
    const res = await importPlan(tok['gis-data'], layoutFeatures(origin.y, origin.x).slice(0, 1), false)
    expect(res.statusCode).toBe(422)
    expect(res.json().report.errors[0]).toMatchObject({ code: 'stand_no_exists', stand_no: '101' })

    await expect(pool.query('DELETE FROM land.parcel WHERE parcel_id = $1', [parcels.get('101')]))
      .rejects.toThrow(/never reused/)
  })

  // ── Test 4 ─────────────────────────────────────────────────────────────
  test('4: AccountLinked for stand 142 delivered twice is stored once and allocates the parcel', async () => {
    const event = erpEvent('AccountLinked', 'AccountLinked:142', {
      parcel_id: parcels.get('142'), erp_account_no: `${TOWNSHIP}-ACC-142`, allocation_date: '2026-09-01',
    })
    const first = await signed(event)
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ duplicate: false, outcome: 'applied' })
    const again = await signed(event)
    expect(again.json()).toMatchObject({ duplicate: true })

    const { rows } = await pool.query('SELECT * FROM revenue_link.account_link WHERE parcel_id = $1', [parcels.get('142')])
    expect(rows).toHaveLength(1)

    const profile = await app.inject({ method: 'GET', url: `/api/parcels/${parcels.get('142')}`, headers: as(tok['gis-analyst']) })
    expect(profile.json().data.allocation_status).toBe('allocated')
  })

  test('inbound: unsigned or wrongly signed events are refused', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/integration/inbound',
      payload: erpEvent('AccountLinked', 'unsigned', {}),
      headers: { 'x-erp-signature': 'sha256=00' },
    })
    expect(res.statusCode).toBe(401)
  })

  // ── Rule 5 ─────────────────────────────────────────────────────────────
  test('rule 5: amounts sent by the ERP are never stored', async () => {
    const account = `${TOWNSHIP}-ACC-142`
    const event = erpEvent('BillingStatusUpdated', 'BillingStatusUpdated:1', {
      erp_account_no: account, status_band: 'in_arrears', as_at: new Date().toISOString(), balance: 1234.5, amount_due: 99,
    })
    expect((await signed(event)).json().outcome).toBe('applied')
    const { rows: [logged] } = await pool.query('SELECT payload FROM integration.inbound_event WHERE event_id = $1', [event.event_id])
    expect(logged.payload).toEqual({ erp_account_no: account, status_band: 'in_arrears', as_at: event.payload.as_at })

    const profile = await app.inject({ method: 'GET', url: `/api/parcels/${parcels.get('142')}`, headers: as(tok['gis-analyst']) })
    expect(profile.json().data.status_band).toBe('in_arrears')
    expect(JSON.stringify(profile.json())).not.toMatch(/1234|balance|amount/)
    await pool.query('DELETE FROM revenue_link.billing_status WHERE erp_account_no = $1', [account])
  })

  // ── Test 5 ─────────────────────────────────────────────────────────────
  test('5: reconciliation on the Tsamba sample finds 8 / 3 / 2', async () => {
    const run = await app.inject({ method: 'POST', url: '/api/integration/reconciliation/run', headers: as(tok['gis-data']) })
    expect(run.statusCode).toBe(200)
    const list = await app.inject({ method: 'GET', url: '/api/integration/reconciliation', headers: as(tok['gis-data']) })
    const tsamba = list.json().data.filter((r) => r.detail.township_code === 'TSAMBA-GP' || String(r.detail.erp_account_no || '').startsWith('TSB-'))
    const count = (k) => tsamba.filter((r) => r.kind === k).length
    expect(count('structure_no_account')).toBe(8)
    expect(count('account_no_parcel')).toBe(3)
    expect(count('duplicate_stand_no')).toBe(2)
  })

  // ── Test 6 ─────────────────────────────────────────────────────────────
  test('6: public identify shows no account, band, owner, phone or balance', async () => {
    const pub = await app.inject({ method: 'GET', url: `/api/gms/public/parcels/${parcels.get('142')}` })
    expect(pub.statusCode).toBe(200)
    const text = JSON.stringify(pub.json())
    expect(text).not.toMatch(/erp_account|status_band|owner|phone|balance|national_id|ACC-142/)
    expect(pub.json().data.stand_no).toBe('142')

    const internal = await app.inject({ method: 'GET', url: `/api/parcels/${parcels.get('142')}` })
    expect(internal.statusCode).toBe(401)
  })

  // ── Test 11 / rule 10 ──────────────────────────────────────────────────
  test('11: a failed event retried by gis_dev after the ERP recovers is acknowledged', async () => {
    const id = await enqueue(pool, 'BuildingCompleted', { parcel_id: parcels.get('150') }, `${TOWNSHIP}:BuildingCompleted:150`)
    await pool.query('UPDATE integration.outbox_event SET attempts = $2 WHERE event_id = $1', [id, MAX_ATTEMPTS - 1])
    erp.down = true
    expect((await deliverOne(pool, erp, id)).status).toBe('failed')

    const analyst = await app.inject({ method: 'POST', url: `/api/integration/events/${id}/retry`, headers: as(tok['gis-analyst']) })
    expect(analyst.statusCode).toBe(403)

    erp.down = false
    const retry = await app.inject({ method: 'POST', url: `/api/integration/events/${id}/retry`, headers: as(tok['gis-dev']) })
    expect(retry.json()).toMatchObject({ data: { status: 'acknowledged' } })
    expect(erp.received.has(`${TOWNSHIP}:BuildingCompleted:150`)).toBe(true)

    const failed = await app.inject({ method: 'GET', url: '/api/integration/events?status=failed', headers: as(tok['gis-analyst']) })
    expect(failed.json().data.map((e) => e.event_id)).not.toContain(id)
  })

  // ── Test 12 ────────────────────────────────────────────────────────────
  test('12: resolving a reconciliation item is audited with who, what and the note', async () => {
    await pool.query(
      `INSERT INTO land.building (parcel_id, source, accuracy_class) VALUES ($1, 'test', 'C')`,
      [parcels.get('155')])
    await app.inject({ method: 'POST', url: '/api/integration/reconciliation/run', headers: as(tok['gis-data']) })
    const { rows: [item] } = await pool.query(
      `SELECT id FROM integration.reconciliation_item
        WHERE kind = 'structure_no_account' AND ref_key = $1 AND status = 'open'`, [parcels.get('155')])

    const noNote = await app.inject({ method: 'POST', url: `/api/integration/reconciliation/${item.id}/resolve`, headers: as(tok['gis-data']), payload: {} })
    expect(noNote.statusCode).toBe(400)
    const res = await app.inject({
      method: 'POST', url: `/api/integration/reconciliation/${item.id}/resolve`, headers: as(tok['gis-data']),
      payload: { note: 'Account opened by Revenue' },
    })
    expect(res.json().data).toMatchObject({ status: 'resolved', resolution_note: 'Account opened by Revenue' })

    // The audit row is written in onResponse, after inject() returns.
    await new Promise((r) => setTimeout(r, 200))
    const { rows: [audit] } = await pool.query(
      `SELECT actor_email, event, status, occurred_at FROM public.admin_audit_event
        WHERE path = $1 ORDER BY id DESC LIMIT 1`,
      [`/api/integration/reconciliation/${item.id}/resolve`])
    expect(audit).toMatchObject({ actor_email: 'demo.gis-data@vungu.test', event: 'INTEGRATION', status: 200 })

    await expect(pool.query(`UPDATE public.admin_audit_event SET status = 0 WHERE path = $1`,
      [`/api/integration/reconciliation/${item.id}/resolve`])).rejects.toThrow(/append-only/)
  })

  test('wards summary and key registry answer for the sample', async () => {
    const w = await app.inject({ method: 'GET', url: '/api/wards/TSB-W02/summary', headers: as(tok['gis-analyst']) })
    expect(w.json().data).toMatchObject({ ward_code: 'TSB-W02', structures_no_account: 8 })
    const k = await app.inject({ method: 'GET', url: '/api/parcels?account=TSB-ACC-0101', headers: as(tok['gis-analyst']) })
    expect(k.json().data).toHaveLength(1)
    expect(k.json().data[0]).toMatchObject({ stand_no: '101', township_code: 'TSAMBA-GP', status_band: 'current' })
  })
})
