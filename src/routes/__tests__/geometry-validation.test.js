/**
 * Geometry validation gate (H1, migration 106) — through the real gis + stands
 * handlers against the local DB.
 *
 * A valid polygon is accepted; a self-intersecting "bowtie" is rejected 422
 * with the invalid-geometry reason, never stored.
 */
require('dotenv').config()
const { randomUUID } = require('node:crypto')
const Fastify = require('fastify')
const fastifyPostgres = require('@fastify/postgres')
const fastifyCookie = require('@fastify/cookie')
const { gisRoutes } = require('../gis')
const { standsRoutes } = require('../stands')
const { signAccessToken } = require('../../middleware/jwtAuth')

const TEST_USER_ID = randomUUID()
const TEST_WARD = `jesttest-geom-${TEST_USER_ID.slice(0, 8)}`
const TEST_LAYER = 'jesttest-geom'
let app, auth

const validPoly  = { type: 'Polygon', coordinates: [[[29.80, -19.45], [29.801, -19.45], [29.801, -19.449], [29.80, -19.449], [29.80, -19.45]]] }
const bowtiePoly = { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] }

beforeAll(async () => {
  app = Fastify({ logger: false })
  await app.register(fastifyPostgres, { connectionString: process.env.DATABASE_URL })
  await app.register(fastifyCookie, { secret: process.env.COOKIE_SECRET || process.env.JWT_SECRET })
  await app.register(async (s) => {
    await gisRoutes(s)
    await standsRoutes(s)
  }, { prefix: '/api' })
  await app.ready()
  await app.pg.query(
    `INSERT INTO users (id, email, full_name, name, role, active, status, password_hash)
     VALUES ($1,$2,'Jest Geom','Jest Geom','planner',true,'active','$2b$10$xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, `jesttest-geom-${TEST_USER_ID}@example.test`],
  )
  auth = { authorization: `Bearer ${signAccessToken({ id: TEST_USER_ID, role: 'planner', email: 'x@example.test' })}` }
}, 30000)

afterAll(async () => {
  await app.pg.query(`DELETE FROM spatial_planning.gis_feature WHERE layer = $1`, [TEST_LAYER])
  await app.pg.query(`DELETE FROM spatial_planning.gis_feature_history WHERE layer = $1`, [TEST_LAYER])
  await app.pg.query(`DELETE FROM stands WHERE ward = $1`, [TEST_WARD])
  await app.pg.query(`DELETE FROM users WHERE id = $1`, [TEST_USER_ID])
  await app.close()
}, 30000)

test('gis digitize: valid polygon accepted, bowtie rejected 422', async () => {
  const ok = await app.inject({ method: 'POST', url: '/api/gis/features', headers: auth, payload: { geometry: validPoly, layer: TEST_LAYER } })
  expect(ok.statusCode).toBe(201)

  const bad = await app.inject({ method: 'POST', url: '/api/gis/features', headers: auth, payload: { geometry: bowtiePoly, layer: TEST_LAYER } })
  expect(bad.statusCode).toBe(422)
  expect(bad.json().error).toBe('invalid_geometry')
  expect(bad.json().message).toMatch(/self-intersection/i)

  // The bad geometry was never stored.
  const cnt = await app.pg.query(`SELECT COUNT(*)::int n FROM spatial_planning.gis_feature WHERE layer = $1`, [TEST_LAYER])
  expect(cnt.rows[0].n).toBe(1)
})

test('stand create: bowtie rejected 422', async () => {
  const bad = await app.inject({
    method: 'POST', url: '/api/stands', headers: auth,
    payload: { standNumber: 'GEOM-1', ward: TEST_WARD, geometry: bowtiePoly },
  })
  expect(bad.statusCode).toBe(422)
  expect(bad.json().error).toBe('invalid_geometry')

  const ok = await app.inject({
    method: 'POST', url: '/api/stands', headers: auth,
    payload: { standNumber: 'GEOM-2', ward: TEST_WARD, geometry: validPoly },
  })
  expect(ok.statusCode).toBe(201)
})
