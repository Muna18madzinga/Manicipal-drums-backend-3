require('dotenv').config()
const { Pool } = require('pg')
const { nearbyResolver, ownersForStand, findParcels, landuseStats } = require('../parcels')

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
afterAll(async () => { await pool.end() })

describe('nearbyResolver', () => {
  test('in-Vungu point returns bounded, sorted, radius-respecting results', async () => {
    const n = await nearbyResolver(pool, 29.39004439183376, -19.294730339613977, 1000)
    for (const key of ['roads', 'pois', 'parcels', 'applications']) {
      expect(Array.isArray(n[key])).toBe(true)
      expect(n[key].length).toBeLessThanOrEqual(10)
    }
    expect(typeof n.buildings).toBe('number')
    // the clicked point sits on a parcel, so the containing parcel is dist 0
    expect(n.parcels.length).toBeGreaterThan(0)
    expect(n.parcels[0].dist_m).toBe(0)
    for (const r of n.roads) expect(r.dist_m).toBeLessThanOrEqual(1000)
    for (const p of n.pois) expect(p.dist_m).toBeLessThanOrEqual(1000)
    const dists = n.roads.map(r => r.dist_m)
    expect([...dists].sort((a, b) => a - b)).toEqual(dists)
  })

  test('remote point (0,0) returns empty results, not an error', async () => {
    const n = await nearbyResolver(pool, 0, 0, 500)
    expect(n.roads).toEqual([])
    expect(n.parcels).toEqual([])
    expect(n.applications).toEqual([])
  })
})

describe('findParcels', () => {
  test('finds Hampton Ranch by name with centroid + bbox', async () => {
    const hits = await findParcels(pool, 'Hampton Ranch')
    expect(hits.length).toBeGreaterThan(0)
    const h = hits[0]
    expect(h.stand_number).toBe('Hampton Ranch')
    expect(h.centroid).toHaveLength(2)
    expect(h.bbox).toHaveLength(4)
    expect(h.bbox[0]).toBeLessThan(h.bbox[2])
    expect(h.bbox[1]).toBeLessThan(h.bbox[3])
    // centroid inside bbox
    expect(h.centroid[0]).toBeGreaterThan(h.bbox[0])
    expect(h.centroid[0]).toBeLessThan(h.bbox[2])
  })

  test('no match returns empty list', async () => {
    expect(await findParcels(pool, 'zz-no-such-parcel-zz')).toEqual([])
  })
})

describe('landuseStats', () => {
  test('area-weighted distribution sums to ~100% and is sorted by area', async () => {
    const rows = await landuseStats(pool)
    expect(rows.length).toBeGreaterThan(0)
    const total = rows.reduce((s, r) => s + r.pct, 0)
    expect(total).toBeGreaterThan(99)
    expect(total).toBeLessThan(101)
    const areas = rows.map(r => r.area_ha)
    expect([...areas].sort((a, b) => b - a)).toEqual(areas)
    for (const r of rows) expect(r.parcels).toBeGreaterThan(0)
  })
})

describe('ownersForStand', () => {
  test('unregistered stand returns empty list', async () => {
    const owners = await ownersForStand(pool, 'no-such-stand-xyz')
    expect(owners).toEqual([])
  })
})
