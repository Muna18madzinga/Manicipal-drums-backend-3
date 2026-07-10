/**
 * Soft delete (migration 103) — end-to-end through the real route handlers.
 *
 * Covers the two most involved conversions:
 *   - gis.js:      DELETE /api/gis/features/:id keeps the row (deleted_at set),
 *                  list + PUT stop seeing it.
 *   - planning.js: DELETE /api/planning/projects/:id keeps the snapshot, list/get
 *                  stop seeing it, and re-saving the same id resurrects it.
 *
 * The other converted tables (users, citizen_documents, inspection_photos,
 * zone_land_use_controls) use the identical UPDATE + filter pattern.
 */
require('dotenv').config()
const { randomUUID } = require('node:crypto')
const Fastify = require('fastify')
const fastifyPostgres = require('@fastify/postgres')
const fastifyCookie = require('@fastify/cookie')
const { gisRoutes } = require('../gis')
const { planningRoutes } = require('../planning')
const { signAccessToken } = require('../../middleware/jwtAuth')

const TEST_USER_ID = randomUUID()
const TEST_LAYER = 'jesttest-soft'
const TEST_PROJECT_ID = 'jesttest-soft-proj'

let app
let auth

beforeAll(async () => {
  // Minimal app, same pattern as test/helpers/buildApp.js — server.js itself
  // can't load under jest (chokidar v5 is ESM-only via ogcServices).
  app = Fastify({ logger: false })
  await app.register(fastifyPostgres, { connectionString: process.env.DATABASE_URL })
  await app.register(fastifyCookie, { secret: process.env.COOKIE_SECRET || process.env.JWT_SECRET })
  await app.register(async (scope) => {
    await gisRoutes(scope)
    await planningRoutes(scope)
  }, { prefix: '/api' })
  await app.ready()
  await app.pg.query(
    `INSERT INTO users (id, email, full_name, name, role, active, status, password_hash)
     VALUES ($1, $2, 'Jest Soft Delete', 'Jest Soft Delete', 'planner', true, 'active',
             '$2b$10$jesttestjesttestjesttestjesttestjesttestjesttestjestte')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_USER_ID, `jesttest-soft-${TEST_USER_ID}@example.test`],
  )
  auth = { authorization: `Bearer ${signAccessToken({ id: TEST_USER_ID, role: 'planner', email: 'jesttest@example.test' })}` }
}, 30000)

afterAll(async () => {
  // Test-data cleanup is legitimately a hard delete.
  await app.pg.query(`DELETE FROM spatial_planning.gis_feature WHERE layer = $1`, [TEST_LAYER])
  await app.pg.query(`DELETE FROM spatial_planning.gis_feature_history WHERE layer = $1`, [TEST_LAYER])
  await app.pg.query(`DELETE FROM spatial_planning.planning_revision WHERE project_id = $1`, [TEST_PROJECT_ID])
  await app.pg.query(`DELETE FROM spatial_planning.planning_project WHERE id = $1`, [TEST_PROJECT_ID])
  await app.pg.query(`DELETE FROM users WHERE id = $1`, [TEST_USER_ID])
  await app.close()
}, 30000)

const point = { type: 'Point', coordinates: [29.8, -19.45] }

test('gis feature: delete hides it from reads but keeps the row', async () => {
  const created = await app.inject({
    method: 'POST', url: '/api/gis/features', headers: auth,
    payload: { geometry: point, layer: TEST_LAYER, properties: { n: 1 } },
  })
  expect(created.statusCode).toBe(201)
  const id = created.json().id

  const del = await app.inject({ method: 'DELETE', url: `/api/gis/features/${id}`, headers: auth })
  expect(del.statusCode).toBe(200)

  // Hidden from the list…
  const list = await app.inject({ method: 'GET', url: `/api/gis/features?layer=${TEST_LAYER}`, headers: auth })
  expect(list.json().features.map(f => f.id)).not.toContain(id)

  // …not editable…
  const put = await app.inject({
    method: 'PUT', url: `/api/gis/features/${id}`, headers: auth,
    payload: { properties: { n: 2 } },
  })
  expect(put.statusCode).toBe(404)

  // …but the row still exists, flagged.
  const { rows } = await app.pg.query(
    `SELECT deleted_at, deleted_by FROM spatial_planning.gis_feature WHERE id = $1`, [id])
  expect(rows).toHaveLength(1)
  expect(rows[0].deleted_at).not.toBeNull()
  expect(rows[0].deleted_by).toBe(TEST_USER_ID)

  // Double delete → 404, row untouched.
  const del2 = await app.inject({ method: 'DELETE', url: `/api/gis/features/${id}`, headers: auth })
  expect(del2.statusCode).toBe(404)
})

test('planning project: delete hides it; re-saving the same id resurrects it', async () => {
  const doc = { id: TEST_PROJECT_ID, name: 'Jest soft delete', lots: [] }
  const save = await app.inject({ method: 'POST', url: '/api/planning/projects', headers: auth, payload: doc })
  expect(save.statusCode).toBe(200)

  const del = await app.inject({ method: 'DELETE', url: `/api/planning/projects/${TEST_PROJECT_ID}`, headers: auth })
  expect(del.statusCode).toBe(200)

  const listAfter = await app.inject({ method: 'GET', url: '/api/planning/projects', headers: auth })
  expect(listAfter.json().data.map(p => p.id)).not.toContain(TEST_PROJECT_ID)
  const getAfter = await app.inject({ method: 'GET', url: `/api/planning/projects/${TEST_PROJECT_ID}`, headers: auth })
  expect(getAfter.statusCode).toBe(404)

  // Row survived the delete.
  const { rows } = await app.pg.query(
    `SELECT deleted_at FROM spatial_planning.planning_project WHERE id = $1`, [TEST_PROJECT_ID])
  expect(rows).toHaveLength(1)
  expect(rows[0].deleted_at).not.toBeNull()

  // Saving the same id again resurrects it (upsert clears deleted_at).
  const resave = await app.inject({ method: 'POST', url: '/api/planning/projects', headers: auth, payload: doc })
  expect(resave.statusCode).toBe(200)
  const getBack = await app.inject({ method: 'GET', url: `/api/planning/projects/${TEST_PROJECT_ID}`, headers: auth })
  expect(getBack.statusCode).toBe(200)
}, 30000)
