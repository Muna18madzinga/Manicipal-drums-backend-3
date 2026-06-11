const { buildAppForTest } = require('../../../test/helpers/buildApp')
const { loginAs }         = require('../../../test/helpers/auth')

describe('payments routes', () => {
  let app
  beforeAll(async () => { app = await buildAppForTest() })
  afterAll(async () => { await app.close() })

  it('GET /api/payments accepts relatedKind/relatedId filters', async () => {
    const token = await loginAs(app, 'demo.viewer@vungu.test', 'demo1234')
    const res = await app.inject({
      method:  'GET',
      url:     '/api/payments?relatedKind=permit&relatedId=00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.success).toBe(true)
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('POST /api/payments/:id/poll returns 404 for unknown id', async () => {
    const token = await loginAs(app, 'demo.viewer@vungu.test', 'demo1234')
    const res = await app.inject({
      method:  'POST',
      url:     '/api/payments/11111111-1111-1111-1111-111111111111/poll',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.statusCode).toBe(404)
  })
})
