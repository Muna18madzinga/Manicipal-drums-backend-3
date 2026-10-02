// src/routes/__tests__/gms.editing.test.js
// GIS Management System phase 2: editing, QA, history, map support.
// Acceptance tests 3 and 13, business rules 2, 3, 6 and 12, against the live DB.
//
// Needs migrations 132 + 133, the GIS demo users and the Tsamba sample
// (its wards make the point-in-ward rule live). Features written here carry
// a TEST-xxxx source and are removed in afterAll.

require('dotenv').config()
const crypto = require('node:crypto')
const Fastify = require('fastify')
const { Pool } = require('pg')
const { authRoutes } = require('../auth')
const { gmsEditingRoutes } = require('../gms-editing')
const { gmsMapRoutes } = require('../gms-map')
const { auditLogPlugin } = require('../../middleware/auditLog')
const { loginAs } = require('../../../test/helpers/auth')

const TAG = `TEST-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
const USERS = ['gis-head', 'gis-data', 'gis-tech', 'gis-analyst', 'dept-editor', 'dept-viewer']

// A quiet corner of Tsamba ward 3, clear of the seeded features.
const LON = 29.64
const LAT = -19.675
const sq = (lon, lat, d = 0.0003) => ({
  type: 'Polygon', coordinates: [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]],
})
const pt = (lon, lat) => ({ type: 'Point', coordinates: [lon, lat] })

describe('GMS phase 2: editing and QA', () => {
  let app
  let pool
  const tok = {}
  const ids = {}
  const as = (t) => ({ authorization: `Bearer ${t}` })
  const call = (user, method, url, payload) => app.inject({ method, url, headers: as(tok[user]), payload })

  /** Open a session, save these edits, submit. Returns [sessionId, submitResponse]. */
  async function submit(user, layer, edits) {
    const open = await call(user, 'POST', '/api/gms/edit-sessions', { layer_id: layer })
    expect(open.statusCode).toBe(200)
    const id = open.json().data.session_id
    expect((await call(user, 'PUT', `/api/gms/edit-sessions/${id}/edits`, { edits })).statusCode).toBe(200)
    return [id, await call(user, 'POST', `/api/gms/edit-sessions/${id}/submit`)]
  }
  const create = (geometry, attrs, extra = {}) => ({ op: 'create', geometry, attrs, accuracy_class: 'B', source: `${TAG} GNSS`, ...extra })

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(require('@fastify/postgres'), { connectionString: process.env.DATABASE_URL })
    await app.register(require('@fastify/cookie'), { secret: process.env.COOKIE_SECRET || process.env.JWT_SECRET })
    await app.register(auditLogPlugin)
    await app.register(async (s) => { await authRoutes(s) }, { prefix: '/api' })
    await app.register(gmsEditingRoutes, { prefix: '/api' })
    await app.register(gmsMapRoutes, { prefix: '/api' })
    await app.ready()
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
    for (const u of USERS) tok[u] = await loginAs(app, `demo.${u}@vungu.test`, 'demo1234')
    const { rows } = await pool.query('SELECT id, email FROM public.users WHERE email = ANY($1)', [USERS.map((u) => `demo.${u}@vungu.test`)])
    for (const r of rows) ids[r.email.slice(5, -10)] = r.id
    // Leftover live sessions from an interrupted run would be resumed.
    await pool.query(
      `UPDATE gis_ops.edit_session SET status = 'abandoned'
        WHERE user_id = ANY($1) AND status IN ('open', 'returned', 'submitted')`, [Object.values(ids)])
  })

  afterAll(async () => {
    const test = `(SELECT feature_id FROM gis_ops.feature WHERE source LIKE '${TAG}%')`
    await pool.query(`DELETE FROM gis_ops.feature_version WHERE feature_id IN ${test}`)
    await pool.query(`DELETE FROM gis_ops.feature WHERE source LIKE '${TAG}%'`)
    await pool.query(`DELETE FROM gis_ops.edit_session WHERE edits::text LIKE '%${TAG}%'`)
    await pool.end()
    await app.close()
  })

  // ── Acceptance test 3 ──────────────────────────────────────────────────
  test('3: overlapping layout stands are blocked with the overlap highlighted; fixed, they pass QA', async () => {
    const a = create(sq(LON, LAT), { stand_no: `${TAG}-1`, proposed_use: 'residential' })
    const b = create(sq(LON + 0.0002, LAT), { stand_no: `${TAG}-2`, proposed_use: 'residential' })
    const [id, blocked] = await submit('gis-tech', 'layout_stands', [a, b])
    expect(blocked.statusCode).toBe(422)
    const overlap = blocked.json().errors.find((e) => e.code === 'overlap')
    expect(overlap).toMatchObject({ index: 0, with_index: 1 })
    expect(overlap.geometry.type).toBe('Polygon')
    expect(overlap.overlap_m2).toBeGreaterThan(100)

    // Rule 3: nothing is visible while it is only a draft.
    const bbox = `${LON - 0.01},${LAT - 0.01},${LON + 0.01},${LAT + 0.01}`
    const before = await call('gis-analyst', 'GET', `/api/gms/layers/layout_stands/features?bbox=${bbox}`)
    expect(before.json().features.filter((f) => String(f.properties.stand_no).startsWith(TAG))).toHaveLength(0)

    // Shift the second stand so it shares an edge instead.
    const fixed = create(sq(LON + 0.0003, LAT), b.attrs)
    await call('gis-tech', 'PUT', `/api/gms/edit-sessions/${id}/edits`, { edits: [a, fixed] })
    expect((await call('gis-tech', 'POST', `/api/gms/edit-sessions/${id}/submit`)).statusCode).toBe(200)

    const queue = await call('gis-data', 'GET', '/api/gms/edit-sessions?scope=queue')
    expect(queue.json().data.map((s) => s.session_id)).toContain(id)
    expect((await call('gis-tech', 'POST', `/api/gms/edit-sessions/${id}/approve`)).statusCode).toBe(403)
    const ok = await call('gis-data', 'POST', `/api/gms/edit-sessions/${id}/approve`)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.created).toHaveLength(2)

    const after = await call('gis-analyst', 'GET', `/api/gms/layers/layout_stands/features?bbox=${bbox}`)
    expect(after.json().features.filter((f) => String(f.properties.stand_no).startsWith(TAG))).toHaveLength(2)
  })

  test('nobody approves their own edit', async () => {
    const [id, res] = await submit('gis-data', 'boreholes', [create(pt(LON, LAT), { name: `${TAG} own`, status: 'functional' })])
    expect(res.statusCode).toBe(200)
    const own = await call('gis-data', 'POST', `/api/gms/edit-sessions/${id}/approve`)
    expect(own.statusCode).toBe(403)
    expect((await call('gis-head', 'POST', `/api/gms/edit-sessions/${id}/reject`, { reason: 'test' })).statusCode).toBe(200)
  })

  test('a departmental focal point edits only their own department\'s layers', async () => {
    const res = await call('dept-editor', 'POST', '/api/gms/edit-sessions', { layer_id: 'boreholes' })
    expect(res.statusCode).toBe(403)
    expect(res.json().message).toMatch(/Engineering/)
    const own = await call('dept-editor', 'POST', '/api/gms/edit-sessions', { layer_id: 'layout_stands' })
    expect(own.statusCode).toBe(200)
    await call('dept-editor', 'DELETE', `/api/gms/edit-sessions/${own.json().data.session_id}`)
  })

  test('rule 2 + domains + wards: attribute and location rules are checked on submit', async () => {
    const [id, res] = await submit('gis-tech', 'boreholes', [
      { op: 'create', geometry: pt(LON, LAT), attrs: { name: `${TAG} a`, status: 'weird' }, accuracy_class: 'B', source: `${TAG}` },
      { op: 'create', geometry: pt(LON, LAT), attrs: { name: `${TAG} b`, status: 'functional' }, source: '' },
      create(pt(31.0, -18.0), { name: `${TAG} c`, status: 'functional' }),
    ])
    expect(res.statusCode).toBe(422)
    const codes = res.json().errors.map((e) => `${e.index}:${e.code}${e.field ? `:${e.field}` : ''}`)
    expect(codes).toEqual(expect.arrayContaining([
      '0:attribute:status', '1:missing_accuracy_class', '1:missing_source', '2:outside_ward',
    ]))
    await call('gis-tech', 'DELETE', `/api/gms/edit-sessions/${id}`)
  })

  test('roads must meet at nodes: an end 50 cm short of another road is refused', async () => {
    const y = LAT + 0.004
    const road = { type: 'LineString', coordinates: [[LON, y], [LON + 0.005, y]] }
    // Ends 0.5 m (~0.0000047 deg) short of the first road.
    const stub = { type: 'LineString', coordinates: [[LON + 0.002, y - 0.003], [LON + 0.002, y - 0.0000047]] }
    const attrs = { surface: 'gravel', road_class: 'access' }
    const [id, res] = await submit('gis-tech', 'council_roads', [create(road, attrs), create(stub, attrs)])
    expect(res.statusCode).toBe(422)
    expect(res.json().errors).toEqual([expect.objectContaining({ index: 1, code: 'not_snapped' })])
    await call('gis-tech', 'DELETE', `/api/gms/edit-sessions/${id}`)
  })

  test('an edit session is resumed after an interruption with its saved edits', async () => {
    const open = await call('gis-tech', 'POST', '/api/gms/edit-sessions', { layer_id: 'schools' })
    const id = open.json().data.session_id
    const edits = [create(pt(LON, LAT), { name: `${TAG} school`, level: 'primary' })]
    await call('gis-tech', 'PUT', `/api/gms/edit-sessions/${id}/edits`, { edits })
    const again = await call('gis-tech', 'POST', '/api/gms/edit-sessions', { layer_id: 'schools' })
    expect(again.json().data.session_id).toBe(id)
    expect(again.json().data.edits).toEqual(edits)
    await call('gis-tech', 'DELETE', `/api/gms/edit-sessions/${id}`)
  })

  test('history, conflicts and restore to an earlier version', async () => {
    const [s1] = await submit('gis-tech', 'boreholes', [create(pt(LON + 0.001, LAT), { name: `${TAG} hist`, status: 'functional' })])
    const fid = (await call('gis-data', 'POST', `/api/gms/edit-sessions/${s1}/approve`)).json().data.created[0]

    // Two editors both start from version 1.
    const [s2] = await submit('gis-tech', 'boreholes', [{ op: 'update', feature_id: fid, base_version: 1, attrs: { status: 'broken' } }])
    const [s3] = await submit('gis-analyst', 'boreholes', [{ op: 'update', feature_id: fid, base_version: 1, attrs: { status: 'needs repair' } }])
    expect((await call('gis-data', 'POST', `/api/gms/edit-sessions/${s2}/approve`)).statusCode).toBe(200)
    const clash = await call('gis-data', 'POST', `/api/gms/edit-sessions/${s3}/approve`)
    expect(clash.statusCode).toBe(409)
    expect((await call('gis-analyst', 'GET', `/api/gms/edit-sessions/${s3}`)).json().data.status).toBe('returned')
    await call('gis-analyst', 'DELETE', `/api/gms/edit-sessions/${s3}`)

    const f = (await call('gis-analyst', 'GET', `/api/gms/features/${fid}`)).json().data
    expect(f.version).toBe(2)
    expect(f.versions.map((v) => [v.version, v.action, v.attrs.status])).toEqual([[2, 'update', 'broken'], [1, 'create', 'functional']])
    expect(f.versions[0].changed_by).toBe('demo.gis-data@vungu.test')

    expect((await call('gis-tech', 'POST', `/api/gms/features/${fid}/restore`, { version: 1, reason: 'x' })).statusCode).toBe(403)
    expect((await call('gis-data', 'POST', `/api/gms/features/${fid}/restore`, { version: 1 })).statusCode).toBe(400)
    expect((await call('gis-data', 'POST', `/api/gms/features/${fid}/restore`, { version: 1, reason: 'Wrongly marked broken' })).statusCode).toBe(200)
    const r = (await call('gis-analyst', 'GET', `/api/gms/features/${fid}`)).json().data
    expect(r).toMatchObject({ version: 3, attrs: { status: 'functional' } })
    expect(r.versions[0]).toMatchObject({ action: 'restore', note: 'Wrongly marked broken' })
  })

  // ── Rules 6 and 12 ─────────────────────────────────────────────────────
  test('6/12: owner names are shown only to roles that may see them, and every view is audited', async () => {
    const bbox = '29.54,-19.63,29.56,-19.61'
    const hidden = await call('gis-tech', 'GET', `/api/gms/layers/business_premises/features?bbox=${bbox}`)
    expect(hidden.statusCode).toBe(404) // restricted layer, no need to know

    const shown = await call('gis-analyst', 'GET', `/api/gms/layers/business_premises/features?bbox=${bbox}`)
    expect(shown.statusCode).toBe(200)
    expect(shown.json().features.length).toBeGreaterThan(0)
    expect(shown.json().features[0].properties.owner_name).toMatch(/fictional/)

    const { rows: [a] } = await pool.query(
      `SELECT actor_email, event, details FROM public.admin_audit_event
        WHERE event = 'PERSONAL_DATA_VIEW' AND actor_email = 'demo.gis-analyst@vungu.test'
        ORDER BY id DESC LIMIT 1`)
    expect(a.details).toMatchObject({ layer: 'business_premises', fields: ['owner_name', 'owner_phone'] })
  })

  // ── Acceptance test 13 ─────────────────────────────────────────────────
  test('13: DXF export offers the survey CRS and writes the Survey Section coordinates', async () => {
    const res = await call('gis-analyst', 'GET', '/api/gms/export/dxf?layer=parcels&township=TSAMBA-GP&srid=922029')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toMatch(/parcels-Lo29\.dxf/)
    expect(res.body).toMatch(/Gauss Conform Lo29/)

    // The first vertex of stand 101, in the CAD convention (-Y, -X).
    const { rows: [p] } = await pool.query(
      `SELECT ST_X(ST_PointN(ST_ExteriorRing(ST_GeometryN(geom_source, 1)), 1)) AS y,
              ST_Y(ST_PointN(ST_ExteriorRing(ST_GeometryN(geom_source, 1)), 1)) AS x
         FROM land.parcel WHERE township_code = 'TSAMBA-GP' AND stand_no = '101' AND status = 'current'`)
    expect(res.body).toContain(`10\n${(-p.y).toFixed(3)}\n20\n${(-p.x).toFixed(3)}`)
    expect(res.body.match(/\nPOLYLINE\n/g)).toHaveLength(60)

    const { rows: [a] } = await pool.query(
      `SELECT details FROM public.admin_audit_event
        WHERE event = 'EXPORT' AND actor_email = 'demo.gis-analyst@vungu.test' ORDER BY id DESC LIMIT 1`)
    expect(a.details).toMatchObject({ format: 'dxf', crs: 'Lo29', features: 60 })

    const crs = (await call('gis-analyst', 'GET', '/api/gms/crs')).json().data.map((c) => c.code)
    expect(crs).toEqual(expect.arrayContaining(['WGS84', 'UTM35S', 'UTM36S', 'Lo29']))
  })

  test('search finds accounts, stands and typed coordinates in any registered CRS', async () => {
    const acc = (await call('gis-analyst', 'GET', '/api/gms/search?q=TSB-ACC-0101')).json().data
    expect(acc[0]).toMatchObject({ kind: 'account', label: 'Account TSB-ACC-0101' })
    const lo = (await call('gis-analyst', 'GET', `/api/gms/search?q=${encodeURIComponent('Lo29 -84021.98 2151376.55')}`)).json().data
    expect(lo[0].kind).toBe('coordinate')
    expect(lo[0].center[0]).toBeCloseTo(29.8, 6)
    expect(lo[0].center[1]).toBeCloseTo(-19.45, 6)
  })

  test('parcel vector tiles are served to staff only', async () => {
    // z16 tile over the Tsamba layout (29.5505, -19.6201).
    const z = 16
    const x = Math.floor(((29.5505 + 180) / 360) * 2 ** z)
    const latR = (-19.6201 * Math.PI) / 180
    const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * 2 ** z)
    const res = await call('dept-viewer', 'GET', `/api/gms/tiles/parcels/${z}/${x}/${y}.pbf`)
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.length).toBeGreaterThan(100)
    expect((await app.inject({ method: 'GET', url: `/api/gms/tiles/parcels/${z}/${x}/${y}.pbf` })).statusCode).toBe(401)
  })
})
