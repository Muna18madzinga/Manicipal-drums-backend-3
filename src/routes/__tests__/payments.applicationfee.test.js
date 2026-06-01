const nock = require('nock')
const crypto = require('crypto')
const { buildAppForTest } = require('../../../test/helpers/buildApp')
const { loginAs }         = require('../../../test/helpers/auth')

describe('application fee payment lifecycle', () => {
  let app, token

  beforeAll(async () => {
    process.env.PAYNOW_INTEGRATION_ID  = '12345'
    process.env.PAYNOW_INTEGRATION_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    process.env.PAYNOW_RESULT_URL      = 'https://example.test/api/payments/webhook/paynow'
    process.env.PAYNOW_RETURN_URL      = 'https://example.test/payment/return'
    process.env.PAYNOW_API_BASE        = 'https://www.paynow.co.zw'
    app = await buildAppForTest()
    token = await loginAs(app, 'demo.viewer@vungu.test', 'demo1234')
  })
  afterAll(async () => { await app.close() })
  afterEach(() => nock.cleanAll())

  async function setupPaidFlow() {
    const client = await app.pg.connect()
    let permitId, paymentId, pollUrl, rawBody
    try {
      const created = await client.query(
        `INSERT INTO spatial_planning.permit_application
           (applicant_name, applicant_email, development_type, status, created_by)
         VALUES ('App Fee Smoke', 'demo.viewer@vungu.test', 'new_building',
                 'pending_payment',
                 (SELECT id FROM users WHERE email = 'demo.viewer@vungu.test'))
         RETURNING id`,
      )
      permitId = created.rows[0].id

      nock('https://www.paynow.co.zw')
        .post('/interface/remotetransaction')
        .reply(200,
          'status=Ok&pollurl=https%3A%2F%2Fwww.paynow.co.zw%2FInterface%2FCheckPayment%2F%3Fguid%3DZZ&hash=AA')

      const initRes = await app.inject({
        method:  'POST', url: '/api/payments',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          purpose:     'application_fee',
          relatedKind: 'permit',
          relatedId:   permitId,
          priceUsd:    25,
          walletCcy:   'USD',
          driver:      'paynow',
          metadata:    { phone: '+263771234567', wallet: 'ecocash' },
        },
      })
      paymentId = initRes.json().data.id
      pollUrl   = initRes.json().data.providerRef

      const fields = {
        reference: paymentId, paynowreference: 'PN1', amount: '25.00',
        additionalinfo: 'fee', status: 'Paid', pollurl: pollUrl,
      }
      const concat = Object.values(fields).join('') + process.env.PAYNOW_INTEGRATION_KEY
      const hash = crypto.createHash('sha512').update(concat, 'utf8').digest('hex').toUpperCase()
      rawBody = new URLSearchParams({ ...fields, hash }).toString()
    } finally { client.release() }
    return { permitId, paymentId, pollUrl, rawBody }
  }

  it('webhook flips permit pending_payment → registered and stamps fee_paid_at', async () => {
    const { permitId, paymentId, rawBody } = await setupPaidFlow()
    const client = await app.pg.connect()
    try {
      const hookRes = await app.inject({
        method:  'POST', url: '/api/payments/webhook/paynow',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: rawBody,
      })
      expect(hookRes.statusCode).toBe(200)

      const after = await client.query(
        `SELECT status, fee_paid_at FROM spatial_planning.permit_application WHERE id = $1`,
        [permitId],
      )
      expect(after.rows[0].status).toBe('registered')
      expect(after.rows[0].fee_paid_at).not.toBeNull()

      const pay = await client.query(`SELECT * FROM payments WHERE id = $1`, [paymentId])
      expect(pay.rows[0].status).toBe('paid')
      expect(pay.rows[0].issued_receipt_no).toMatch(/^VRDC-\d{4}-\d{6}$/)
    } finally {
      await client.query(`DELETE FROM payments WHERE id = $1`, [paymentId])
      await client.query(`DELETE FROM spatial_planning.permit_application WHERE id = $1`, [permitId])
      client.release()
    }
  })

  it('replaying the same webhook does not double-stamp', async () => {
    const { permitId, paymentId, rawBody } = await setupPaidFlow()
    const client = await app.pg.connect()
    try {
      await app.inject({
        method:  'POST', url: '/api/payments/webhook/paynow',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: rawBody,
      })
      const firstReceipt = (await client.query(
        `SELECT issued_receipt_no FROM payments WHERE id = $1`, [paymentId])).rows[0].issued_receipt_no
      expect(firstReceipt).toMatch(/^VRDC-\d{4}-\d{6}$/)

      const replay = await app.inject({
        method:  'POST', url: '/api/payments/webhook/paynow',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: rawBody,
      })
      expect(replay.statusCode).toBe(200)
      const secondReceipt = (await client.query(
        `SELECT issued_receipt_no FROM payments WHERE id = $1`, [paymentId])).rows[0].issued_receipt_no
      expect(secondReceipt).toBe(firstReceipt)
    } finally {
      await client.query(`DELETE FROM payments WHERE id = $1`, [paymentId])
      await client.query(`DELETE FROM spatial_planning.permit_application WHERE id = $1`, [permitId])
      client.release()
    }
  })
})
