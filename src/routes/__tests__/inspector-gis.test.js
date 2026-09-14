// src/routes/__tests__/inspector-gis.test.js
// Building Inspector GIS: geofence rules, site resolution precedence and the
// route contract. Spatial cases run against the live database inside a
// transaction that is always rolled back.

require('dotenv').config()
const { Pool } = require('pg')
const spatial = require('../../services/inspectorSpatial')
const { _internals: routeInternals } = require('../inspector-gis')
const { buildAppForTest } = require('../../../test/helpers/buildApp')
const { loginAs } = require('../../../test/helpers/auth')

const { geofenceVerdict } = spatial
const { constraintStatus, wardDigits, CONSTRAINTS } = spatial._internals

// Inside the council boundary, on Lower Gweru Communal Land, with mapped buildings.
const VUNGU_X = 29.2250
const VUNGU_Y = -19.2456
// Inside Gweru Urban — outside the council planning boundary.
const OUTSIDE_X = 29.7894
const OUTSIDE_Y = -19.4612

describe('geofenceVerdict', () => {
  test('a fix on the stand is on site', () => {
    expect(geofenceVerdict({ precision: 'boundary', distanceM: 0, accuracyM: 5 })).toBe('on_site')
  })

  test('boundary tolerance is 30 m plus capped accuracy credit', () => {
    expect(geofenceVerdict({ precision: 'boundary', distanceM: 30, accuracyM: null })).toBe('on_site')
    expect(geofenceVerdict({ precision: 'boundary', distanceM: 31, accuracyM: null })).toBe('off_site')
    expect(geofenceVerdict({ precision: 'boundary', distanceM: 70, accuracyM: 40 })).toBe('on_site')
    // credit is capped at 50 m however poor the fix claims to be
    expect(geofenceVerdict({ precision: 'boundary', distanceM: 81, accuracyM: 90 })).toBe('off_site')
  })

  test('a point-only site gets the wider 75 m tolerance', () => {
    expect(geofenceVerdict({ precision: 'point', distanceM: 75, accuracyM: 0 })).toBe('on_site')
    expect(geofenceVerdict({ precision: 'point', distanceM: 76, accuracyM: 0 })).toBe('off_site')
  })

  test('a coarse fix or an unpositioned site proves nothing', () => {
    expect(geofenceVerdict({ precision: 'boundary', distanceM: 0, accuracyM: 250 })).toBe('unverifiable')
    expect(geofenceVerdict({ precision: 'area', distanceM: 0, accuracyM: 5 })).toBe('unverifiable')
    expect(geofenceVerdict({ precision: 'none', distanceM: null, accuracyM: 5 })).toBe('unverifiable')
    expect(geofenceVerdict({ precision: 'boundary', distanceM: null, accuracyM: 5 })).toBe('unverifiable')
  })
})

describe('constraint rules', () => {
  const byKey = Object.fromEntries(CONSTRAINTS.map(c => [c.key, c]))

  test('only the EMA figures and protected areas are statutory', () => {
    const statutory = CONSTRAINTS.filter(c => c.basis === 'statutory').map(c => c.key).sort()
    expect(statutory).toEqual(['protected_area', 'water_body', 'watercourse'])
    expect(byKey.watercourse.thresholdM).toBe(30)
  })

  test('intersecting a no-build feature is a conflict; being near it is a review', () => {
    expect(constraintStatus(byKey.water_body, 0)).toBe('conflict')
    expect(constraintStatus(byKey.water_body, 12)).toBe('review')
    expect(constraintStatus(byKey.water_body, 45)).toBe('clear')
    // a stream crossing the stand is still a review, not a finding
    expect(constraintStatus(byKey.watercourse, 0)).toBe('review')
    expect(constraintStatus(byKey.cemetery, 99)).toBe('review')
    expect(constraintStatus(byKey.cemetery, null)).toBe('clear')
  })

  test('ward numbers compare across the registers\' spellings', () => {
    expect(wardDigits('Ward 04 — Lalapanzi')).toBe('4')
    expect(wardDigits('4')).toBe('4')
    expect(wardDigits('Lalapanzi')).toBeNull()
  })
})

describe('readLngLat', () => {
  const { readLngLat } = routeInternals
  test('accepts a pair, rejects half a pair, null island and out-of-range', () => {
    expect(readLngLat('29.2', '-19.2')).toEqual({ lng: 29.2, lat: -19.2 })
    expect(readLngLat(undefined, undefined)).toBeNull()
    expect(readLngLat(29.2, undefined)).toBeUndefined()
    expect(readLngLat(0, 0)).toBeUndefined()
    expect(readLngLat(200, -19)).toBeUndefined()
    expect(readLngLat('abc', -19)).toBeUndefined()
  })
})

describe('site resolution against the registers', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
  let client
  let permitId

  beforeAll(async () => {
    client = await pool.connect()
    await client.query('BEGIN')
    const p = await client.query(
      `INSERT INTO spatial_planning.permit_application
         (applicant_name, development_type, status, stand_number, suburb_ward)
       VALUES ('GIS resolution test', 'new_building', 'approved', 'ZZ-GIS-1', '6')
       RETURNING id`,
    )
    permitId = p.rows[0].id
    const d = 0.00028
    const e = 0.00038
    const env = (x0) => `ST_SetSRID(ST_MakeEnvelope(${x0}, ${VUNGU_Y - e / 2}, ${x0 + d}, ${VUNGU_Y + e / 2}), 4326)`
    await client.query(
      `INSERT INTO stands (stand_number, ward, area_sqm, geom, status)
       VALUES ('ZZ-GIS-1', 'Ward 6', 1200, ${env(VUNGU_X - d / 2)}, 'allocated'),
              ('ZZ-GIS-2', 'Ward 6', 1200, ${env(VUNGU_X + d / 2)}, 'allocated')`,
    )
  }, 30000)

  afterAll(async () => {
    await client.query('ROLLBACK')
    client.release()
    await pool.end()
  })

  test('a stand number in the Stands Register resolves to its boundary', async () => {
    const site = await spatial.resolvePermitSite(client, permitId)
    expect(site.source).toBe('stands_register')
    expect(site.precision).toBe('boundary')
    expect(site.site_label).toBe('ZZ-GIS-1')
  })

  test('an ambiguous stand number is not guessed', async () => {
    await client.query('SAVEPOINT amb')
    await client.query(
      `INSERT INTO stands (stand_number, ward, area_sqm, geom, status)
       VALUES ('ZZ-GIS-1', 'Ward 9', 1200,
               ST_SetSRID(ST_MakeEnvelope(29.30, -19.30, 29.3003, -19.2996), 4326), 'allocated')`,
    )
    await client.query(`UPDATE spatial_planning.permit_application SET suburb_ward = NULL WHERE id = $1`, [permitId])
    const site = await spatial.resolvePermitSite(client, permitId)
    expect(site.source).not.toBe('stands_register')
    await client.query('ROLLBACK TO SAVEPOINT amb')
  })

  test('the site report runs structures, neighbours and constraints on a boundary', async () => {
    const r = await spatial.getSiteReport(client, permitId)
    expect(r.site.precision).toBe('boundary')
    expect(r.jurisdiction.inJurisdiction).toBe(true)
    expect(r.constraints).toHaveLength(CONSTRAINTS.length)
    for (const c of r.constraints) expect(['conflict', 'review', 'clear', 'no_data']).toContain(c.status)
    expect(r.structures.available).toBe(true)
    expect(r.structures.count).toBeGreaterThan(0)
    expect(r.structures.footprints.features).toHaveLength(r.structures.count)
    expect(r.neighbours.map(n => n.label)).toContain('ZZ-GIS-2')
    const shared = r.neighbours.find(n => n.label === 'ZZ-GIS-2').sharedBoundaryM
    expect(shared).toBeGreaterThan(35)   // the common 42 m edge, within digitising tolerance
    expect(shared).toBeLessThan(60)
  }, 30000)

  test('a point outside any stand-sized parcel reports point precision and skips coverage', async () => {
    await client.query('SAVEPOINT pt')
    await client.query(
      `UPDATE spatial_planning.permit_application
          SET stand_number = 'ZZ-NOWHERE', location = ST_SetSRID(ST_MakePoint(29.24002745, -19.2237914), 4326)
        WHERE id = $1`, [permitId])
    const r = await spatial.getSiteReport(client, permitId)
    expect(r.site.precision).toBe('point')
    expect(r.site.source).toBe('permit_location')
    expect(r.site.coarseArea.label).toBe('Communal Land')
    expect(r.structures).toBeNull()
    expect(r.limitations.join(' ')).toMatch(/Only a position is known/)
    await client.query('ROLLBACK TO SAVEPOINT pt')
  }, 30000)

  test('a permit named after a farm-sized parcel is only an area and runs no checks', async () => {
    await client.query('SAVEPOINT area')
    await client.query(`UPDATE spatial_planning.permit_application SET stand_number = 'Communal Land' WHERE id = $1`, [permitId])
    const r = await spatial.getSiteReport(client, permitId)
    expect(r.site.precision).toBe('area')
    expect(r.constraints).toEqual([])
    expect(r.limitations[0]).toMatch(/Record the site position/)
    await client.query('ROLLBACK TO SAVEPOINT area')
  }, 30000)

  test('identify on the stand links the structure to its permit', async () => {
    const r = await spatial.identifyAt(client, VUNGU_X - 0.00005, VUNGU_Y)
    expect(r.stand.standNumber).toBe('ZZ-GIS-1')
    expect(r.cases.map(c => c.permitId)).toContain(permitId)
    expect(r.assessment).toBe('permitted_case')
  }, 30000)

  test('identify outside the council boundary says so', async () => {
    const r = await spatial.identifyAt(client, OUTSIDE_X, OUTSIDE_Y)
    expect(r.jurisdiction.inJurisdiction).toBe(false)
    expect(r.assessment).toBe('outside_jurisdiction')
  }, 30000)

  test('the sites layer carries the boundary and a positioned point', async () => {
    const r = await spatial.listInspectorSites(client, { scope: 'inspectable' })
    const pt = r.points.features.find(f => f.properties.permitId === permitId)
    expect(pt.geometry.type).toBe('Point')
    expect(pt.properties.precision).toBe('boundary')
    expect(r.boundaries.features.some(f => f.properties.permitId === permitId)).toBe(true)
  }, 30000)
})

describe('inspector GIS routes', () => {
  let app, inspector, viewer, planner, permitId, inspectionId, orderId, oddOrderId

  beforeAll(async () => {
    app = await buildAppForTest()
    inspector = await loginAs(app, 'demo.inspector@vungu.test', 'demo1234')
    viewer = await loginAs(app, 'demo.viewer@vungu.test', 'demo1234')
    planner = await loginAs(app, 'demo.planner@vungu.test', 'demo1234')
    const p = await app.pg.query(
      `INSERT INTO spatial_planning.permit_application
         (applicant_name, development_type, status, stand_number, location)
       VALUES ('GIS route test', 'new_building', 'approved', 'ZZ-ROUTE-1',
               ST_SetSRID(ST_MakePoint(29.24002745, -19.2237914), 4326))
       RETURNING id`,
    )
    permitId = p.rows[0].id
    const si = await app.pg.query(
      `INSERT INTO spatial_planning.stage_inspection (permit_app_id, stage_number, attempt)
       VALUES ($1, 1, 1) RETURNING id`, [permitId])
    inspectionId = si.rows[0].id
  }, 60000)

  afterAll(async () => {
    for (const id of [orderId, oddOrderId].filter(Boolean)) {
      await app.pg.query('DELETE FROM spatial_planning.enforcement_order WHERE id = $1', [id])
    }
    await app.pg.query('DELETE FROM spatial_planning.permit_event WHERE permit_app_id = $1', [permitId])
    await app.pg.query('DELETE FROM spatial_planning.permit_application WHERE id = $1', [permitId])
    // uploaded test files live outside the DB
    await require('node:fs/promises')
      .rm(require('node:path').resolve(process.cwd(), 'uploads', 'permit-documents', permitId), { recursive: true, force: true })
      .catch(() => {})
    await app.close()
  }, 30000)

  const as = (token) => ({ authorization: `Bearer ${token}` })

  test('unauthenticated and citizen-role requests are refused', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/inspector/sites' })
    expect(anon.statusCode).toBe(401)
    const citizen = await app.inject({ method: 'GET', url: '/api/inspector/sites', headers: as(viewer) })
    expect(citizen.statusCode).toBe(403)
  })

  test('GET /inspector/sites returns the three layers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/inspector/sites', headers: as(inspector) })
    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.points.type).toBe('FeatureCollection')
    expect(data.boundaries.type).toBe('FeatureCollection')
    expect(data.enforcement.type).toBe('FeatureCollection')
    const mine = data.points.features.find(f => f.properties.permitId === permitId)
    expect(mine.properties.precision).toBe('point')
  })

  test('site report validates the id and 404s an unknown permit', async () => {
    const bad = await app.inject({ method: 'GET', url: '/api/inspector/permits/nope/site-report', headers: as(inspector) })
    expect(bad.statusCode).toBe(400)
    const missing = await app.inject({
      method: 'GET', url: '/api/inspector/permits/00000000-0000-0000-0000-000000000000/site-report', headers: as(inspector),
    })
    expect(missing.statusCode).toBe(404)
    const ok = await app.inject({ method: 'GET', url: `/api/inspector/permits/${permitId}/site-report`, headers: as(inspector) })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().data.site.precision).toBe('point')
  }, 30000)

  test('identify rejects missing coordinates', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/inspector/identify?lng=29.2', headers: as(inspector) })
    expect(res.statusCode).toBe(400)
  })

  test('field events: validation, server-side geofence, listing', async () => {
    const url = `/api/stage-inspections/${inspectionId}/field-events`
    const half = await app.inject({ method: 'POST', url, headers: as(inspector), payload: { event_type: 'arrived', observed_lat: -19.22 } })
    expect(half.statusCode).toBe(400)
    const badType = await app.inject({ method: 'POST', url, headers: as(inspector), payload: { event_type: 'teleported' } })
    expect(badType.statusCode).toBe(400)
    const byPlanner = await app.inject({ method: 'POST', url, headers: as(planner), payload: { event_type: 'travelling' } })
    expect(byPlanner.statusCode).toBe(403)

    const onSite = await app.inject({
      method: 'POST', url, headers: as(inspector),
      payload: { event_type: 'arrived', observed_lat: -19.2238, observed_lng: 29.24003, accuracy_m: 6,
        // a client-supplied verdict must be ignored
        geofence_result: 'off_site', site_distance_m: 9999 },
    })
    expect(onSite.statusCode).toBe(201)
    expect(onSite.json().data.geofence_result).toBe('on_site')
    expect(onSite.json().data.site_distance_m).toBeLessThan(75)

    const far = await app.inject({
      method: 'POST', url, headers: as(inspector),
      payload: { event_type: 'arrived', observed_lat: -19.2300, observed_lng: 29.2400, accuracy_m: 5 },
    })
    expect(far.json().data.geofence_result).toBe('off_site')

    const list = await app.inject({ method: 'GET', url, headers: as(inspector) })
    expect(list.statusCode).toBe(200)
    expect(list.json().data).toHaveLength(2)

    const geo = await app.inject({
      method: 'GET', url: `/api/stage-inspections/${inspectionId}/geo-verification`, headers: as(inspector),
    })
    expect(geo.statusCode).toBe(200)
    expect(geo.json().data.summary.verdict).toBe('discrepancy')
  }, 30000)

  test('an inspector cannot log attendance on another inspector\'s assignment', async () => {
    const other = await app.pg.query(`SELECT id FROM users WHERE email = 'demo.admin@vungu.test'`)
    await app.pg.query('UPDATE spatial_planning.stage_inspection SET inspector_id = $1 WHERE id = $2', [other.rows[0].id, inspectionId])
    const res = await app.inject({
      method: 'POST', url: `/api/stage-inspections/${inspectionId}/field-events`,
      headers: as(inspector), payload: { event_type: 'travelling' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('not_assigned')
    await app.pg.query('UPDATE spatial_planning.stage_inspection SET inspector_id = NULL WHERE id = $1', [inspectionId])
  })

  // The inspector's case file asks for the orders on one stand. Before this the
  // param was ignored and every order came back, so the client filtered by hand.
  test('GET /enforcement-orders filters by stand_number, trimmed and case-insensitively', async () => {
    const made = await app.inject({
      method: 'POST', url: '/api/enforcement-orders', headers: as(planner),
      payload: {
        order_type: 'stop_notice', subject_name: 'GIS filter test', subject_address: 'Somewhere',
        breach_description: 'Test order', required_action: 'Stop work',
        stand_number: 'ZZ-ENF-1', permit_app_id: permitId,
      },
    })
    expect(made.statusCode).toBe(201)
    orderId = made.json().data.id

    const hit = await app.inject({ method: 'GET', url: '/api/enforcement-orders?stand_number=%20zz-enf-1%20', headers: as(inspector) })
    expect(hit.statusCode).toBe(200)
    expect(hit.json().data.map(o => o.id)).toContain(orderId)

    const miss = await app.inject({ method: 'GET', url: '/api/enforcement-orders?stand_number=ZZ-NO-SUCH-STAND', headers: as(inspector) })
    expect(miss.json().data).toEqual([])

    const unfiltered = await app.inject({ method: 'GET', url: '/api/enforcement-orders', headers: as(inspector) })
    expect(unfiltered.json().data.length).toBeGreaterThanOrEqual(1)
  }, 30000)

  // The case a stand-only query misses: same property, different stand string.
  test('stand_number and permit_app_id OR together, and status still narrows', async () => {
    const odd = await app.inject({
      method: 'POST', url: '/api/enforcement-orders', headers: as(planner),
      payload: {
        order_type: 'enforcement_notice', subject_name: 'Odd stand string', subject_address: 'Somewhere',
        breach_description: 'Captured with a different stand string', required_action: 'Stop work',
        stand_number: 'zz enf 1 (portion)', permit_app_id: permitId,
      },
    })
    expect(odd.statusCode).toBe(201)
    oddOrderId = odd.json().data.id

    const byStandOnly = await app.inject({ method: 'GET', url: '/api/enforcement-orders?stand_number=ZZ-ENF-1', headers: as(inspector) })
    expect(byStandOnly.json().data.map(o => o.id)).not.toContain(oddOrderId)

    const byBoth = await app.inject({
      method: 'GET', url: `/api/enforcement-orders?stand_number=ZZ-ENF-1&permit_app_id=${permitId}`, headers: as(inspector),
    })
    const ids = byBoth.json().data.map(o => o.id)
    expect(ids).toEqual(expect.arrayContaining([orderId, oddOrderId]))

    // status is ANDed against whichever identity matched
    const wrongStatus = await app.inject({
      method: 'GET', url: `/api/enforcement-orders?permit_app_id=${permitId}&status=complied`, headers: as(inspector),
    })
    expect(wrongStatus.json().data).toEqual([])

    const badUuid = await app.inject({ method: 'GET', url: '/api/enforcement-orders?permit_app_id=not-a-uuid', headers: as(inspector) })
    expect(badUuid.statusCode).toBe(200)
  }, 30000)

  // "Not issued yet" is the normal state of an unfinished building, so it is not
  // an error; a 404 is reserved for a permit that does not exist or is not yours.
  test('occupation certificate: 200 + null when unissued, 404 when the permit is unknown or not yours', async () => {
    const unissued = await app.inject({
      method: 'GET', url: `/api/permit-applications/${permitId}/occupation-certificate`, headers: as(inspector),
    })
    expect(unissued.statusCode).toBe(200)
    expect(unissued.json()).toEqual({ success: true, data: null })

    const unknown = await app.inject({
      method: 'GET', url: '/api/permit-applications/00000000-0000-0000-0000-000000000000/occupation-certificate',
      headers: as(inspector),
    })
    expect(unknown.statusCode).toBe(404)

    // A citizen who does not own the case gets 404, not the occupant's details.
    const notMine = await app.inject({
      method: 'GET', url: `/api/permit-applications/${permitId}/occupation-certificate`, headers: as(viewer),
    })
    expect(notMine.statusCode).toBe(404)

    const badId = await app.inject({
      method: 'GET', url: '/api/permit-applications/nope/occupation-certificate', headers: as(inspector),
    })
    expect(badId.statusCode).toBe(400)
  }, 30000)

  // These routes did not exist, so every upload path in the app failed —
  // including the citizen's supporting documents, which always reported
  // upload_failed.
  describe('permit documents', () => {
    const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('site plan bytes'), Buffer.from('\n%%EOF')])

    const upload = (token, { body = PDF, docType = 'site_plan', mime = 'application/pdf', filename = 'site-plan.pdf', id = permitId } = {}) => {
      const boundary = '----vungutest' + Math.random().toString(16).slice(2)
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="doc_type"\r\n\r\n${docType}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
        body,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ])
      return app.inject({
        method: 'POST', url: `/api/permit-applications/${id}/documents`,
        headers: { ...as(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      })
    }

    test('uploads a document, lists it, and is idempotent for the same file', async () => {
      const res = await upload(inspector)
      expect(res.statusCode).toBe(201)
      const doc = res.json().data
      expect(doc).toMatchObject({ doc_type: 'site_plan', mime_type: 'application/pdf', source: 'external' })
      expect(doc.file_name).toBe('site-plan.pdf')
      expect(doc.bytes).toBe(PDF.length)
      expect(doc.storage_url).toMatch(new RegExp(`^/uploads/permit-documents/${permitId}/`))

      const list = await app.inject({
        method: 'GET', url: `/api/permit-applications/${permitId}/documents`, headers: as(inspector),
      })
      expect(list.statusCode).toBe(200)
      expect(list.json().data.map(d => d.id)).toContain(doc.id)

      // Same bytes again: still one row in the register, not two.
      const again = await upload(inspector, { docType: 'building_plan' })
      expect(again.statusCode).toBe(201)
      expect(again.json().data.id).toBe(doc.id)
      const after = await app.inject({
        method: 'GET', url: `/api/permit-applications/${permitId}/documents`, headers: as(inspector),
      })
      expect(after.json().data.filter(d => d.id === doc.id)).toHaveLength(1)
    }, 30000)

    test('rejects a disguised file, a bad doc_type and a missing file', async () => {
      // An executable renamed .pdf: the declared mime passes, magic bytes do not.
      const disguised = await upload(inspector, { body: Buffer.from('MZ\x90\x00executable') })
      expect(disguised.statusCode).toBe(415)
      expect(disguised.json().error).toBe('bad_file_signature')

      const badType = await upload(inspector, { docType: '<script>' })
      expect(badType.statusCode).toBe(400)
      expect(badType.json().error).toBe('bad_doc_type')

      const noMultipart = await app.inject({
        method: 'POST', url: `/api/permit-applications/${permitId}/documents`,
        headers: as(inspector), payload: { doc_type: 'site_plan' },
      })
      expect(noMultipart.statusCode).toBe(415)
    }, 30000)

    test('a citizen who does not own the case can neither list nor upload', async () => {
      const list = await app.inject({
        method: 'GET', url: `/api/permit-applications/${permitId}/documents`, headers: as(viewer),
      })
      expect(list.statusCode).toBe(404)
      const post = await upload(viewer)
      expect(post.statusCode).toBe(404)
    }, 30000)

    test('an unknown permit is 404 and a malformed id is 400', async () => {
      const unknown = await app.inject({
        method: 'GET', url: '/api/permit-applications/00000000-0000-0000-0000-000000000000/documents',
        headers: as(inspector),
      })
      expect(unknown.statusCode).toBe(404)
      const bad = await app.inject({
        method: 'GET', url: '/api/permit-applications/nope/documents', headers: as(inspector),
      })
      expect(bad.statusCode).toBe(400)
    }, 30000)
  })

  test('site location: reason, accuracy and jurisdiction are enforced, then audited', async () => {
    const url = `/api/permit-applications/${permitId}/site-location`
    const noReason = await app.inject({
      method: 'PUT', url, headers: as(inspector),
      payload: { lng: VUNGU_X, lat: VUNGU_Y, source: 'map_pick', reason: 'short' },
    })
    expect(noReason.statusCode).toBe(400)
    const coarse = await app.inject({
      method: 'PUT', url, headers: as(inspector),
      payload: { lng: VUNGU_X, lat: VUNGU_Y, source: 'field_gps', accuracy_m: 40, reason: 'Fix taken at the corner pegs' },
    })
    expect(coarse.statusCode).toBe(422)
    expect(coarse.json().error).toBe('accuracy_insufficient')
    const outside = await app.inject({
      method: 'PUT', url, headers: as(inspector),
      payload: { lng: OUTSIDE_X, lat: OUTSIDE_Y, source: 'map_pick', reason: 'Picked from the Stands Register map' },
    })
    expect(outside.statusCode).toBe(422)
    expect(outside.json().error).toBe('outside_jurisdiction')

    const ok = await app.inject({
      method: 'PUT', url, headers: as(inspector),
      payload: { lng: VUNGU_X, lat: VUNGU_Y, source: 'field_gps', accuracy_m: 4.5, reason: 'Fix taken at the corner pegs during setting out' },
    })
    expect(ok.statusCode).toBe(200)
    const body = ok.json().data
    expect(body.site.position.source).toBe('field_gps')
    expect(body.movedM).toBeGreaterThan(2000)
    const ev = await app.pg.query(
      `SELECT detail FROM spatial_planning.permit_event WHERE permit_app_id = $1 AND event_type = 'site_location_set'`,
      [permitId],
    )
    expect(ev.rows).toHaveLength(1)
    expect(ev.rows[0].detail.previous).toMatchObject({ lng: 29.24002745 })
    expect(ev.rows[0].detail.reason).toMatch(/corner pegs/)
  }, 30000)
})
