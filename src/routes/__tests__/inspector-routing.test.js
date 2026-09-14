// src/routes/__tests__/inspector-routing.test.js
// Road corridor for in-app navigation. The client builds the graph and routes;
// this endpoint only has to return the right segments, bounded, without
// scanning 210,240 rows.

require('dotenv').config()
const { _internals } = require('../inspector-routing')
const { buildAppForTest } = require('../../../test/helpers/buildApp')
const { loginAs } = require('../../../test/helpers/auth')

const { bboxFrom, DRIVABLE_FCLASS, MAX_BBOX_SQ_KM } = _internals

// A populated corridor inside the council area (Lower Gweru).
const BOX = { minLng: 29.20, minLat: -19.28, maxLng: 29.28, maxLat: -19.20 }
const qs = (b) => `minLng=${b.minLng}&minLat=${b.minLat}&maxLng=${b.maxLng}&maxLat=${b.maxLat}`

describe('bboxFrom', () => {
  test('accepts a well-formed box and rejects the malformed ones', () => {
    expect(bboxFrom({ minLng: '29.2', minLat: '-19.3', maxLng: '29.3', maxLat: '-19.2' }))
      .toEqual({ minLng: 29.2, minLat: -19.3, maxLng: 29.3, maxLat: -19.2 })
    expect(bboxFrom({})).toBeNull()
    expect(bboxFrom({ minLng: 'x', minLat: -19.3, maxLng: 29.3, maxLat: -19.2 })).toBeNull()
    // inverted
    expect(bboxFrom({ minLng: 29.3, minLat: -19.3, maxLng: 29.2, maxLat: -19.2 })).toBeNull()
    // degenerate
    expect(bboxFrom({ minLng: 29.2, minLat: -19.2, maxLng: 29.2, maxLat: -19.2 })).toBeNull()
    // out of range
    expect(bboxFrom({ minLng: -200, minLat: -19.3, maxLng: 29.3, maxLat: -19.2 })).toBeNull()
  })
})

describe('drivable classes', () => {
  test('includes tracks and excludes what a vehicle cannot use', () => {
    // 80,626 track segments in this dataset: excluding them would strand every
    // rural site.
    expect(DRIVABLE_FCLASS).toEqual(expect.arrayContaining(['track', 'track_grade3', 'residential', 'trunk']))
    for (const walking of ['footway', 'path', 'steps', 'cycleway', 'bridleway', 'pedestrian']) {
      expect(DRIVABLE_FCLASS).not.toContain(walking)
    }
  })
})

describe('GET /inspector/route-corridor', () => {
  let app, inspector, viewer

  beforeAll(async () => {
    app = await buildAppForTest()
    inspector = await loginAs(app, 'demo.inspector@vungu.test', 'demo1234')
    viewer = await loginAs(app, 'demo.viewer@vungu.test', 'demo1234')
  }, 60000)

  afterAll(async () => { await app.close() }, 30000)

  const as = (t) => ({ authorization: `Bearer ${t}` })

  test('returns drivable segments as GeoJSON with the properties a graph needs', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/inspector/route-corridor?${qs(BOX)}`, headers: as(inspector),
    })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.type).toBe('FeatureCollection')
    expect(d.segmentCount).toBeGreaterThan(0)
    expect(d.classes).toBe('drivable')
    expect(d.truncated).toBe(false)

    const f = d.features[0]
    expect(f.geometry.type).toMatch(/LineString/)
    expect(Array.isArray(f.geometry.coordinates)).toBe(true)
    expect(f.properties).toHaveProperty('fid')
    expect(f.properties).toHaveProperty('fclass')
    // Direction matters for a directed graph; this dataset holds only B and F.
    expect(['B', 'F', 'T']).toContain(f.properties.oneway)
    for (const feature of d.features) {
      expect(DRIVABLE_FCLASS).toContain(feature.properties.fclass)
    }
  }, 60000)

  test('classes=all returns the walking network too', async () => {
    const drivable = await app.inject({
      method: 'GET', url: `/api/inspector/route-corridor?${qs(BOX)}`, headers: as(inspector),
    })
    const all = await app.inject({
      method: 'GET', url: `/api/inspector/route-corridor?${qs(BOX)}&classes=all`, headers: as(inspector),
    })
    expect(all.json().data.classes).toBe('all')
    expect(all.json().data.segmentCount).toBeGreaterThanOrEqual(drivable.json().data.segmentCount)
  }, 60000)

  test('rejects a malformed box, an oversized one, and a citizen', async () => {
    const bad = await app.inject({
      method: 'GET', url: '/api/inspector/route-corridor?minLng=29.2', headers: as(inspector),
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error).toBe('bad_bbox')

    // The whole country: refused with the cap, so the client can subdivide.
    const huge = await app.inject({
      method: 'GET',
      url: '/api/inspector/route-corridor?minLng=25&minLat=-22&maxLng=33&maxLat=-15',
      headers: as(inspector),
    })
    expect(huge.statusCode).toBe(413)
    expect(huge.json().error).toBe('bbox_too_large')
    expect(huge.json().maxAreaSqKm).toBe(MAX_BBOX_SQ_KM)

    const citizen = await app.inject({
      method: 'GET', url: `/api/inspector/route-corridor?${qs(BOX)}`, headers: as(viewer),
    })
    expect(citizen.statusCode).toBe(403)

    const anon = await app.inject({ method: 'GET', url: `/api/inspector/route-corridor?${qs(BOX)}` })
    expect(anon.statusCode).toBe(401)
  }, 60000)

  test('an empty corridor is an empty collection, not an error', async () => {
    // Open ocean: in range, correctly formed, no roads.
    const res = await app.inject({
      method: 'GET',
      url: '/api/inspector/route-corridor?minLng=-30.2&minLat=-40.2&maxLng=-30.1&maxLat=-40.1',
      headers: as(inspector),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.features).toEqual([])
    expect(res.json().data.segmentCount).toBe(0)
  }, 60000)
})
