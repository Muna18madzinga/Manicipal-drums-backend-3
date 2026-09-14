// src/routes/__tests__/environmental-health.test.js
// Environmental Health registers (migration 121): position validation, the
// anonymity and closing rules, access control, and the two spatial queries an
// EHO actually relies on — nearby and outbreak catchment.
//
// Runs against the live database. Every row a test creates is tracked and
// removed in afterAll, so the registers are left as they were found.

require('dotenv').config()
const { Pool } = require('pg')
const { _internals } = require('../environmental-health')
const { buildAppForTest } = require('../../../test/helpers/buildApp')
const { loginAs } = require('../../../test/helpers/auth')

const { readLngLat, readPosition } = _internals

// A quiet corner of the district, well away from any demo data, so distance
// assertions are about the rows this suite writes and nothing else.
const X = 29.3001
const Y = -19.3001
/** A point `m` metres due east of (X, Y). Good to well under a metre here. */
const east = (m) => X + m / (111320 * Math.cos((Y * Math.PI) / 180))

describe('readLngLat', () => {
  test('a complete pair is a position', () => {
    expect(readLngLat(29.8, -19.4)).toEqual({ lng: 29.8, lat: -19.4 })
    expect(readLngLat('29.8', '-19.4')).toEqual({ lng: 29.8, lat: -19.4 })
  })
  test('nothing at all is no position, not an error', () => {
    expect(readLngLat(undefined, undefined)).toBeNull()
    expect(readLngLat('', '')).toBeNull()
  })
  test('half a pair, out of range, or null island is invalid', () => {
    expect(readLngLat(29.8, undefined)).toBeUndefined()
    expect(readLngLat(200, -19.4)).toBeUndefined()
    expect(readLngLat(0, 0)).toBeUndefined()
  })
})

describe('readPosition', () => {
  test('a GPS fix carries its source and accuracy', () => {
    expect(readPosition({ lng: X, lat: Y, location_source: 'field_gps', location_accuracy_m: 4 }))
      .toEqual({ pos: { lng: X, lat: Y }, source: 'field_gps', accuracy: 4 })
  })
  test('a record taken by telephone has no position and that is fine', () => {
    expect(readPosition({})).toEqual({ pos: null, source: null, accuracy: null })
  })
  test('provenance without a coordinate is refused — it would be a claim about nothing', () => {
    expect(readPosition({ location_source: 'field_gps' }).error).toBe('position_required_for_source')
    expect(readPosition({ location_accuracy_m: 5 }).error).toBe('position_required_for_source')
  })
  test('an unknown source or a negative accuracy is refused', () => {
    expect(readPosition({ lng: X, lat: Y, location_source: 'guess' }).error).toBe('bad_location_source')
    expect(readPosition({ lng: X, lat: Y, location_accuracy_m: -1 }).error).toBe('bad_accuracy')
  })
})

describe('environmental health routes', () => {
  let app
  let eho
  let planner
  let viewer
  let pool
  const created = { premises: [], outbreaks: [], samples: [], complaints: [] }
  const as = (tok) => ({ authorization: `Bearer ${tok}` })

  beforeAll(async () => {
    app = await buildAppForTest()
    eho = await loginAs(app, 'demo.envoffice@vungu.test', 'demo1234')
    planner = await loginAs(app, 'demo.planner@vungu.test', 'demo1234')
    viewer = await loginAs(app, 'demo.viewer@vungu.test', 'demo1234')
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
  })

  afterAll(async () => {
    // Complaints reference premises, so they go first.
    const del = (table, ids) => ids.length
      && pool.query(`DELETE FROM spatial_planning.${table} WHERE id = ANY($1::uuid[])`, [ids])
    await del('health_nuisance_complaint', created.complaints)
    await del('health_water_sample', created.samples)
    await del('health_outbreak', created.outbreaks)
    await del('health_premises', created.premises)
    await pool.end()
    await app.close()
  })

  const post = (url, payload, tok = eho) =>
    app.inject({ method: 'POST', url: `/api/eho/${url}`, headers: as(tok), payload })

  async function premises(name, metresEast, extra = {}) {
    const res = await post('premises', {
      name, premises_type: 'bakery', lng: east(metresEast), lat: Y, location_source: 'field_gps', ...extra,
    })
    expect(res.statusCode).toBe(201)
    created.premises.push(res.json().data.id)
    return res.json().data
  }

  test('only staff read the registers and only the EHO writes them', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/eho/premises' })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/eho/premises', headers: as(viewer) })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/api/eho/outbreaks', headers: as(planner) })).statusCode).toBe(200)
    // A planner can see a cholera cluster beside their permit, but not log one.
    const plannerWrite = await post('outbreaks', { disease: 'cholera', suspected_source: 'x', ward: '1' }, planner)
    expect(plannerWrite.statusCode).toBe(403)
    expect((await post('premises', { name: 'x', premises_type: 'other' }, viewer)).statusCode).toBe(403)
  })

  test('a premises gets a register reference and keeps its position provenance', async () => {
    const p = await premises('Suite Bakery', 0, { location_accuracy_m: 4.5 })
    expect(p.reference).toMatch(/^PR-\d{4}-\d{4}$/)
    expect(p.lng).toBeCloseTo(X, 5)
    expect(p.location_source).toBe('field_gps')
    expect(p.location_accuracy_m).toBe(4.5)
  })

  test('invalid input is refused at the door with the field that was wrong', async () => {
    expect((await post('premises', { name: 'x', premises_type: 'casino' })).json().error).toBe('bad_premises_type')
    expect((await post('premises', { name: 'x', premises_type: 'other', lng: 29.8 })).json().error).toBe('bad_position')
    expect((await post('water-samples', { source_label: 'x', ph: 19 })).json().error).toBe('bad_measurement')
    const nowhere = await post('complaints', { category: 'noise', description: 'loud music' })
    expect(nowhere.statusCode).toBe(400)
    expect(nowhere.json().field).toBe('location')
  })

  test('an anonymous complaint never stores or returns contact details, whatever the form sent', async () => {
    const res = await post('complaints', {
      category: 'vermin', description: 'rats in the refuse area', suburb_ward: 'Ward 1',
      anonymous: true, complainant_name: 'Mrs Moyo', complainant_contact: '0771234567',
    })
    expect(res.statusCode).toBe(201)
    const c = res.json().data
    created.complaints.push(c.id)
    expect(c.anonymous).toBe(true)
    expect(c.complainant_name).toBeNull()
    expect(c.complainant_contact).toBeNull()
    // And not merely hidden in the response — never written.
    const { rows } = await pool.query(
      'SELECT complainant_name, complainant_contact FROM spatial_planning.health_nuisance_complaint WHERE id = $1', [c.id])
    expect(rows[0]).toEqual({ complainant_name: null, complainant_contact: null })
  })

  test('closing an outbreak dates it; reopening clears the date', async () => {
    const res = await post('outbreaks', { disease: 'typhoid', suspected_source: 'vendor stall', ward: 'Ward 2' })
    const ob = res.json().data
    created.outbreaks.push(ob.id)
    expect(ob.closed_at).toBeNull()

    const patch = (payload) => app.inject({
      method: 'PATCH', url: `/api/eho/outbreaks/${ob.id}`, headers: as(eho), payload,
    })
    const closed = (await patch({ status: 'closed' })).json().data
    expect(closed.status).toBe('closed')
    expect(closed.closed_at).not.toBeNull()

    const reopened = (await patch({ status: 'investigating' })).json().data
    expect(reopened.closed_at).toBeNull()
  })

  test('nearby returns what is inside the radius, nearest first, and nothing beyond it', async () => {
    await premises('Nearby A', 40)
    await premises('Nearby B', 120)
    await premises('Beyond', 900)

    const res = await app.inject({
      method: 'GET', url: `/api/eho/nearby?lng=${X}&lat=${Y}&radius_m=300`, headers: as(eho),
    })
    expect(res.statusCode).toBe(200)
    const names = res.json().data.premises.map((p) => p.name)
    expect(names).toContain('Nearby A')
    expect(names).toContain('Nearby B')
    expect(names).not.toContain('Beyond')
    expect(names.indexOf('Nearby A')).toBeLessThan(names.indexOf('Nearby B'))
    const a = res.json().data.premises.find((p) => p.name === 'Nearby A')
    expect(a.distanceM).toBeGreaterThanOrEqual(38)
    expect(a.distanceM).toBeLessThanOrEqual(42)
  })

  test('a nearby query needs a whole coordinate', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/eho/nearby?lng=${X}`, headers: as(eho) })
    expect(res.statusCode).toBe(400)
  })

  test('a catchment lists premises inside the recorded radius and failed water first', async () => {
    const ob = (await post('outbreaks', {
      disease: 'cholera', suspected_source: 'communal borehole', ward: 'Ward 1',
      catchment_m: 250, lng: X, lat: Y, location_source: 'field_gps',
    })).json().data
    created.outbreaks.push(ob.id)

    await premises('Catchment Butchery', 180, { premises_type: 'butchery' })
    const potable = (await post('water-samples', {
      source_label: 'clean tap', result: 'potable', lng: east(20), lat: Y, location_source: 'field_gps',
    })).json().data
    const failed = (await post('water-samples', {
      source_label: 'bad borehole', result: 'not_potable', ecoli_count: 180, lng: east(100), lat: Y,
      location_source: 'field_gps',
    })).json().data
    created.samples.push(potable.id, failed.id)

    const res = await app.inject({ method: 'GET', url: `/api/eho/outbreaks/${ob.id}/catchment`, headers: as(eho) })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.positioned).toBe(true)
    expect(d.radiusM).toBe(250)
    expect(d.usedRecordedCatchment).toBe(true)
    expect(d.premises.map((p) => p.name)).toContain('Catchment Butchery')
    // The failed source leads even though the clean one is nearer: it is the
    // one that explains a water-borne cluster.
    expect(d.waterSamples[0].source_label).toBe('bad borehole')

    // A what-if radius overrides the record without editing it.
    const narrow = (await app.inject({
      method: 'GET', url: `/api/eho/outbreaks/${ob.id}/catchment?radius_m=50`, headers: as(eho),
    })).json().data
    expect(narrow.radiusM).toBe(50)
    expect(narrow.usedRecordedCatchment).toBe(false)
    expect(narrow.premises.map((p) => p.name)).not.toContain('Catchment Butchery')
  })

  test('an outbreak with no position refuses to draw a catchment and says why', async () => {
    const ob = (await post('outbreaks', { disease: 'measles', suspected_source: 'phoned in', ward: 'Ward 7' })).json().data
    created.outbreaks.push(ob.id)
    const d = (await app.inject({ method: 'GET', url: `/api/eho/outbreaks/${ob.id}/catchment`, headers: as(eho) })).json().data
    expect(d.positioned).toBe(false)
    expect(d.radiusM).toBeNull()
    expect(d.premises).toEqual([])
    // An empty list alone would read as "nothing at risk". It must say why.
    expect(d.limitations.join(' ')).toMatch(/no recorded position/i)
  })

  test('the map layers are GeoJSON and count what has no position', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/eho/map', headers: as(eho) })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    for (const k of ['premises', 'outbreaks', 'waterSamples', 'complaints']) {
      expect(d[k].type).toBe('FeatureCollection')
    }
    const pt = d.premises.features.find((f) => f.properties.name === 'Nearby A')
    expect(pt.geometry.type).toBe('Point')
    expect(pt.geometry.coordinates[0]).toBeCloseTo(east(40), 5)
    expect(typeof d.unpositioned.outbreaks).toBe('number')
    expect(d.unpositioned.outbreaks).toBeGreaterThanOrEqual(1)   // the measles outbreak above
  })

  test('deleting a premises is soft: it leaves the register but keeps its row', async () => {
    const p = await premises('Duplicate Entry', 2000)
    const res = await app.inject({ method: 'DELETE', url: `/api/eho/premises/${p.id}`, headers: as(eho) })
    expect(res.statusCode).toBe(200)
    const list = (await app.inject({
      method: 'GET', url: '/api/eho/premises?search=Duplicate%20Entry', headers: as(eho),
    })).json().data
    expect(list.find((x) => x.id === p.id)).toBeUndefined()
    const { rows } = await pool.query('SELECT deleted_at FROM spatial_planning.health_premises WHERE id = $1', [p.id])
    expect(rows[0].deleted_at).not.toBeNull()
  })
})
