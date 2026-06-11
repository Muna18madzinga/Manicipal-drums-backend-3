require('dotenv').config()
const { Pool } = require('pg')
const { resolveLocation } = require('../parcels')

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
afterAll(async () => { await pool.end() })

describe('resolveLocation', () => {
  test('A: in-Vungu point on a parcel', async () => {
    const b = await resolveLocation(pool, 29.39004439183376, -19.294730339613977)
    expect(b.in_jurisdiction).toBe(true)
    expect(b.district).toBe('Gweru')
    expect(b.authority).not.toBeNull()
    expect(b.authority.name).toBe('Vungu Rural District Council')
    expect(b.stand).not.toBeNull()
    expect(b.stand.stand_number).toBe('Communal Land')
    expect(b.stand.ward).toBe('6')
    expect(Array.isArray(b.stand.centroid)).toBe(true)
    expect(b.stand.centroid).toHaveLength(2)
    expect(typeof b.stand.description).toBe('string')
  })

  test('C: out-of-Vungu point (Harare) names the district, no stand', async () => {
    const b = await resolveLocation(pool, 31.05, -17.83)
    expect(b.in_jurisdiction).toBe(false)
    expect(b.district).toBe('Harare')
    expect(b.stand).toBeNull()
  })

  test('D: point with no district', async () => {
    const b = await resolveLocation(pool, 0, 0)
    expect(b.in_jurisdiction).toBe(false)
    expect(b.district).toBeNull()
    expect(b.stand).toBeNull()
  })
})
