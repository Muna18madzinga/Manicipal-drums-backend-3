const { buildAppForTest } = require('../../../test/helpers/buildApp')
const { loginAs }         = require('../../../test/helpers/auth')

describe('permit-applications pending_payment gating', () => {
  let app, citizen, planner

  beforeAll(async () => {
    app = await buildAppForTest()
    citizen = await loginAs(app, 'demo.viewer@vungu.test', 'demo1234')
    planner = await loginAs(app, 'demo.planner@vungu.test', 'demo1234')
  })
  afterAll(async () => { await app.close() })

  it('creating with pay_intent yields status=pending_payment', async () => {
    const res = await app.inject({
      method:  'POST', url: '/api/permit-applications',
      headers: { authorization: `Bearer ${citizen}` },
      payload: {
        applicant_name:   'Pending Smoke',
        development_type: 'new_building',
        pay_intent:       { phone: '+263771234567', walletCcy: 'USD' },
      },
    })
    expect(res.statusCode).toBe(201)
    const row = res.json().data
    expect(row.status).toBe('pending_payment')

    const client = await app.pg.connect()
    try { await client.query(`DELETE FROM spatial_planning.permit_application WHERE id = $1`, [row.id]) }
    finally { client.release() }
  })

  it('planner GET excludes pending_payment by default and opt-in surfaces it', async () => {
    const client = await app.pg.connect()
    let id
    try {
      const r = await client.query(
        `INSERT INTO spatial_planning.permit_application
           (applicant_name, development_type, status, created_by)
         VALUES ('Hidden Smoke', 'new_building', 'pending_payment',
                 (SELECT id FROM users WHERE email='demo.viewer@vungu.test'))
         RETURNING id`,
      )
      id = r.rows[0].id

      const plannerView = await app.inject({
        method: 'GET', url: '/api/permit-applications',
        headers: { authorization: `Bearer ${planner}` },
      })
      expect(plannerView.json().data.map(d => d.id)).not.toContain(id)

      const citizenView = await app.inject({
        method: 'GET', url: '/api/permit-applications',
        headers: { authorization: `Bearer ${citizen}` },
      })
      expect(citizenView.json().data.map(d => d.id)).toContain(id)

      const optIn = await app.inject({
        method: 'GET', url: '/api/permit-applications?includePendingPayment=true',
        headers: { authorization: `Bearer ${planner}` },
      })
      expect(optIn.json().data.map(d => d.id)).toContain(id)
    } finally {
      if (id) await client.query(`DELETE FROM spatial_planning.permit_application WHERE id = $1`, [id])
      client.release()
    }
  })
})
