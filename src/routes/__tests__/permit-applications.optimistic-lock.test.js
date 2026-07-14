const { buildAppForTest } = require('../../../test/helpers/buildApp')
const { loginAs }         = require('../../../test/helpers/auth')

// Regression tests for migration 097: PATCH /permit-applications/:id/case and
// /status must require the caller's expectedRevision to match the row's
// current revision, and bump it on success — concurrent edits get a 409 +
// the server's current copy instead of a silent overwrite.
describe('permit-applications optimistic locking (migration 097)', () => {
  let app, planner

  beforeAll(async () => {
    app = await buildAppForTest()
    planner = await loginAs(app, 'demo.planner@vungu.test', 'demo1234')
  })
  afterAll(async () => { await app.close() })

  async function seedPermit() {
    const client = await app.pg.connect()
    try {
      const r = await client.query(
        `INSERT INTO spatial_planning.permit_application
           (applicant_name, development_type, status, created_by)
         VALUES ('Lock Smoke', 'new_building', 'registered',
                 (SELECT id FROM users WHERE email='demo.planner@vungu.test'))
         RETURNING id, revision`,
      )
      return r.rows[0]
    } finally {
      client.release()
    }
  }

  async function cleanup(id) {
    const client = await app.pg.connect()
    try { await client.query(`DELETE FROM spatial_planning.permit_application WHERE id = $1`, [id]) }
    finally { client.release() }
  }

  it('rejects a save missing expectedRevision', async () => {
    const seed = await seedPermit()
    try {
      const res = await app.inject({
        method: 'PATCH', url: `/api/permit-applications/${seed.id}/case`,
        headers: { authorization: `Bearer ${planner}` },
        payload: { estimated_cost: 1000 },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('expected_revision_required')
    } finally {
      await cleanup(seed.id)
    }
  })

  it('accepts a save with the current revision and bumps it', async () => {
    const seed = await seedPermit()
    try {
      const res = await app.inject({
        method: 'PATCH', url: `/api/permit-applications/${seed.id}/case`,
        headers: { authorization: `Bearer ${planner}` },
        payload: { estimated_cost: 1000, expectedRevision: seed.revision },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json().data
      expect(body.estimated_cost).toBe('1000.00')
      expect(body.revision).toBe(seed.revision + 1)
    } finally {
      await cleanup(seed.id)
    }
  })

  it('409s a save with a stale revision and returns the current row', async () => {
    const seed = await seedPermit()
    try {
      // First officer saves — revision moves from 0 to 1.
      const first = await app.inject({
        method: 'PATCH', url: `/api/permit-applications/${seed.id}/case`,
        headers: { authorization: `Bearer ${planner}` },
        payload: { estimated_cost: 2000, expectedRevision: seed.revision },
      })
      expect(first.statusCode).toBe(200)

      // Second officer, still holding the stale revision=0 they loaded
      // before the first save landed, tries to save.
      const second = await app.inject({
        method: 'PATCH', url: `/api/permit-applications/${seed.id}/case`,
        headers: { authorization: `Bearer ${planner}` },
        payload: { estimated_cost: 3000, expectedRevision: seed.revision },
      })
      expect(second.statusCode).toBe(409)
      const body = second.json()
      expect(body.error).toBe('conflict')
      // The conflict payload carries the CURRENT row, not the stale one, so
      // the frontend can show the officer what actually changed.
      expect(body.data.estimated_cost).toBe('2000.00')
      expect(body.data.revision).toBe(seed.revision + 1)
    } finally {
      await cleanup(seed.id)
    }
  })

  it('409s /status the same way', async () => {
    const seed = await seedPermit()
    try {
      const stale = await app.inject({
        method: 'PATCH', url: `/api/permit-applications/${seed.id}/status`,
        headers: { authorization: `Bearer ${planner}` },
        payload: { status: 'under_review', expectedRevision: seed.revision - 1 },
      })
      // seed.revision is 0 for a freshly-created row, so revision - 1 = -1
      // never matches; this exercises the same 409 path as a real race.
      expect(stale.statusCode).toBe(409)
      expect(stale.json().error).toBe('conflict')
    } finally {
      await cleanup(seed.id)
    }
  })
})
