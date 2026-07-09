require('dotenv').config()
const { Pool } = require('pg')
const { upsertPlan, listPlans, plansForPoint, validatePlanDoc } = require('../statutory-plans')

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
const TEST_PREFIX = 'plan-jesttest-'

afterAll(async () => {
  await pool.query(
    `DELETE FROM spatial_planning.statutory_plan WHERE id LIKE $1`, [`${TEST_PREFIX}%`])
  await pool.end()
})

const doc = (over = {}) => ({
  id: `${TEST_PREFIX}a`, kind: 'local', name: 'Jest Local Plan', status: 'draft',
  authorityId: 'lpa', writtenStatement: { sections: [] }, maps: [], objections: [],
  consultationLog: [], audit: [], measures: [], phasing: [], ...over,
})

describe('validatePlanDoc', () => {
  test('accepts a well-formed doc', () => expect(validatePlanDoc(doc())).toBeNull())
  test('rejects bad kind, status, name, id', () => {
    expect(validatePlanDoc(doc({ kind: 'zonal' }))).toMatch(/kind/)
    expect(validatePlanDoc(doc({ status: 'published' }))).toMatch(/status/)
    expect(validatePlanDoc(doc({ name: '' }))).toMatch(/name/)
    expect(validatePlanDoc(doc({ id: '' }))).toMatch(/id/)
    expect(validatePlanDoc(null)).toMatch(/required/)
  })
})

describe('upsertPlan / listPlans / plansForPoint', () => {
  test('roundtrip: insert, update, list returns the doc verbatim', async () => {
    await upsertPlan(pool, doc(), null)
    await upsertPlan(pool, doc({ name: 'Jest Local Plan v2', status: 'exhibition' }), null)

    const all = await listPlans(pool)
    const mine = all.find(p => p.id === `${TEST_PREFIX}a`)
    expect(mine).toBeDefined()
    expect(mine.name).toBe('Jest Local Plan v2')
    expect(mine.status).toBe('exhibition')
    expect(mine.writtenStatement).toEqual({ sections: [] })
  })

  test('plansForPoint: only operative plans; NULL boundary applies everywhere', async () => {
    await upsertPlan(pool, doc({ id: `${TEST_PREFIX}op`, name: 'Operative wide', status: 'operative' }), null)
    // bounded operative plan around Gweru
    await upsertPlan(pool, doc({
      id: `${TEST_PREFIX}bounded`, name: 'Operative bounded', status: 'operative',
      boundary: { type: 'Polygon', coordinates: [[[29.7, -19.6], [29.9, -19.6], [29.9, -19.4], [29.7, -19.4], [29.7, -19.6]]] },
    }), null)

    const inGweru = await plansForPoint(pool, 29.8, -19.5)
    const ids = inGweru.map(p => p.id)
    expect(ids).toContain(`${TEST_PREFIX}op`)       // authority-wide
    expect(ids).toContain(`${TEST_PREFIX}bounded`)  // point inside boundary
    expect(ids).not.toContain(`${TEST_PREFIX}a`)    // exhibition ≠ operative

    const farAway = await plansForPoint(pool, 31.0, -17.8)
    const farIds = farAway.map(p => p.id)
    expect(farIds).toContain(`${TEST_PREFIX}op`)       // wide still applies
    expect(farIds).not.toContain(`${TEST_PREFIX}bounded`) // outside boundary
  })
})
