/**
 * Stand Number Allocation (H3, migration 105) — end-to-end through the real
 * stands.js handlers against the local DB.
 *
 * Covers: sequential next-number, allocate (register + status flip), the
 * double-allocation guard, revoke (history preserved + stand freed), and the
 * certificate render.
 */
require('dotenv').config()
const { randomUUID } = require('node:crypto')
const Fastify = require('fastify')
const fastifyPostgres = require('@fastify/postgres')
const fastifyCookie = require('@fastify/cookie')
const { standsRoutes } = require('../stands')
const { signAccessToken } = require('../../middleware/jwtAuth')

const TEST_USER_ID = randomUUID()
const TEST_WARD = `jesttest-ward-${TEST_USER_ID.slice(0, 8)}`
let app, auth, standId, allocId

// Small valid polygon (a ~few-hundred-m² box near Gweru).
const poly = {
  type: 'Polygon',
  coordinates: [[[29.80, -19.45], [29.8005, -19.45], [29.8005, -19.4495], [29.80, -19.4495], [29.80, -19.45]]],
}

beforeAll(async () => {
  app = Fastify({ logger: false })
  await app.register(fastifyPostgres, { connectionString: process.env.DATABASE_URL })
  await app.register(fastifyCookie, { secret: process.env.COOKIE_SECRET || process.env.JWT_SECRET })
  await app.register(async (s) => { await standsRoutes(s) }, { prefix: '/api' })
  await app.ready()

  await app.pg.query(
    `INSERT INTO users (id, email, full_name, name, role, active, status, password_hash)
     VALUES ($1,$2,'Jest Allocator','Jest Allocator','planner',true,'active','$2b$10$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, `jesttest-alloc-${TEST_USER_ID}@example.test`],
  )
  auth = { authorization: `Bearer ${signAccessToken({ id: TEST_USER_ID, role: 'planner', email: 'x@example.test' })}` }

  const created = await app.inject({
    method: 'POST', url: '/api/stands', headers: auth,
    payload: { standNumber: 'STD-100', ward: TEST_WARD, geometry: poly },
  })
  expect(created.statusCode).toBe(201)
  standId = created.json().data.id
}, 30000)

afterAll(async () => {
  await app.pg.query(`DELETE FROM stand_allocation WHERE stand_id = $1`, [standId])
  await app.pg.query(`DELETE FROM stands WHERE ward = $1`, [TEST_WARD])
  await app.pg.query(`DELETE FROM users WHERE id = $1`, [TEST_USER_ID])
  await app.close()
}, 30000)

test('next-number returns the next sequential number in the ward', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/stands/next-number?ward=${encodeURIComponent(TEST_WARD)}&prefix=STD-`, headers: auth })
  expect(res.statusCode).toBe(200)
  // STD-100 exists → next is 101.
  expect(res.json().data.next_number).toBe(101)
  expect(res.json().data.suggested_stand_number).toBe('STD-101')
})

test('allocate creates a register entry and flips the stand to allocated', async () => {
  const res = await app.inject({
    method: 'POST', url: `/api/stands/${standId}/allocate`, headers: auth,
    payload: { allotteeName: 'Tendai Moyo', purpose: 'residential', conditions: 'Build within 24 months.' },
  })
  expect(res.statusCode).toBe(201)
  allocId = res.json().data.id
  expect(res.json().data.reference_no).toMatch(/^VRDC-STD-\d{4}-\d{6}$/)

  const stand = await app.pg.query(`SELECT status, allocated_at FROM stands WHERE id = $1`, [standId])
  expect(stand.rows[0].status).toBe('allocated')
  expect(stand.rows[0].allocated_at).not.toBeNull()
})

test('a second allocation of the same stand is rejected', async () => {
  const res = await app.inject({
    method: 'POST', url: `/api/stands/${standId}/allocate`, headers: auth,
    payload: { allotteeName: 'Someone Else' },
  })
  expect(res.statusCode).toBe(409)
})

test('certificate renders HTML with the reference and allottee', async () => {
  const res = await app.inject({ method: 'GET', url: `/api/stand-allocations/${allocId}/certificate`, headers: auth })
  expect(res.statusCode).toBe(200)
  expect(res.headers['content-type']).toMatch(/text\/html/)
  expect(res.body).toContain('CERTIFICATE OF STAND ALLOCATION')
  expect(res.body).toContain('Tendai Moyo')
})

test('revoke frees the stand and preserves history; re-allocation works', async () => {
  const rev = await app.inject({
    method: 'POST', url: `/api/stands/${standId}/revoke-allocation`, headers: auth,
    payload: { reason: 'Allottee withdrew.' },
  })
  expect(rev.statusCode).toBe(200)

  const stand = await app.pg.query(`SELECT status FROM stands WHERE id = $1`, [standId])
  expect(stand.rows[0].status).toBe('available')

  // History keeps the revoked row (soft), and a fresh allocation can proceed.
  const hist = await app.inject({ method: 'GET', url: `/api/stands/${standId}/allocations`, headers: auth })
  expect(hist.json().data.some(a => a.status === 'revoked')).toBe(true)

  const re = await app.inject({
    method: 'POST', url: `/api/stands/${standId}/allocate`, headers: auth,
    payload: { allotteeName: 'New Allottee' },
  })
  expect(re.statusCode).toBe(201)
}, 30000)
