const nock = require('nock')
const { getDriver } = require('../paymentDriver')

beforeAll(() => {
  process.env.PAYNOW_INTEGRATION_ID  = '12345'
  process.env.PAYNOW_INTEGRATION_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  process.env.PAYNOW_RESULT_URL      = 'https://example.test/api/payments/webhook/paynow'
  process.env.PAYNOW_RETURN_URL      = 'https://example.test/payment/return'
  process.env.PAYNOW_API_BASE        = 'https://www.paynow.co.zw'
})
afterEach(() => nock.cleanAll())

describe('paynowDriver.pollPayment', () => {
  it('maps Paid → { paid:true }', async () => {
    nock('https://www.paynow.co.zw')
      .get('/Interface/CheckPayment/').query(true)
      .reply(200,
        'reference=ref&paynowreference=PN1&amount=25.00&status=Paid&pollurl=https%3A%2F%2Fwww.paynow.co.zw%2FInterface%2FCheckPayment%2F%3Fguid%3DAAA&hash=ZZ')
    const driver = getDriver('paynow')
    const r = await driver.pollPayment({
      payment: { provider_ref: 'https://www.paynow.co.zw/Interface/CheckPayment/?guid=AAA' },
    })
    expect(r.paid).toBe(true)
    expect(r.providerStatus).toBe('Paid')
  })

  it('maps Sent → { paid:false }', async () => {
    nock('https://www.paynow.co.zw')
      .get('/Interface/CheckPayment/').query(true)
      .reply(200, 'reference=ref&status=Sent&hash=ZZ')
    const driver = getDriver('paynow')
    const r = await driver.pollPayment({
      payment: { provider_ref: 'https://www.paynow.co.zw/Interface/CheckPayment/?guid=AAA' },
    })
    expect(r.paid).toBe(false)
    expect(r.providerStatus).toBe('Sent')
  })

  it('maps Cancelled → { paid:false }', async () => {
    nock('https://www.paynow.co.zw')
      .get('/Interface/CheckPayment/').query(true)
      .reply(200, 'reference=ref&status=Cancelled&hash=ZZ')
    const driver = getDriver('paynow')
    const r = await driver.pollPayment({
      payment: { provider_ref: 'https://www.paynow.co.zw/Interface/CheckPayment/?guid=AAA' },
    })
    expect(r.paid).toBe(false)
    expect(r.providerStatus).toBe('Cancelled')
  })
})

describe('paynowDriver.initPayment', () => {
  it('POSTs Express Checkout with the wallet method and parses the poll URL', async () => {
    nock('https://www.paynow.co.zw')
      .post('/interface/remotetransaction', body => {
        // nock parses application/x-www-form-urlencoded into a plain object
        return /^ecocash$/i.test(body.method)
          && body.phone === '263771234567'
          && body.amount === '25.00'
          && /^[A-F0-9]{128}$/.test(body.hash)
      })
      .reply(200,
        'status=Ok&pollurl=https%3A%2F%2Fwww.paynow.co.zw%2FInterface%2FCheckPayment%2F%3Fguid%3DAAA&hash=DEADBEEF')

    const driver = getDriver('paynow')
    const result = await driver.initPayment({
      payment: {
        id:           'b8b3a9e0-1111-2222-3333-444444444444',
        amount_usd:   '25.00',
        wallet_ccy:   'USD',
        payer_email:  'demo.viewer@vungu.test',
        metadata:     { phone: '+263771234567', wallet: 'ecocash' },
      },
    })

    expect(result.providerRef).toBe('https://www.paynow.co.zw/Interface/CheckPayment/?guid=AAA')
    expect(result.providerStatus).toBe('sent')
    expect(result.redirectUrl).toBeNull()
  })
})

describe('paynowDriver.verifyWebhook', () => {
  function signedBody(fields) {
    const concat = Object.values(fields).join('')
      + process.env.PAYNOW_INTEGRATION_KEY
    const hash = require('crypto').createHash('sha512')
      .update(concat, 'utf8').digest('hex').toUpperCase()
    return new URLSearchParams({ ...fields, hash }).toString()
  }

  it('accepts a correctly-hashed Paid callback', async () => {
    const fields = {
      reference:       'ref',
      paynowreference: 'PN1',
      amount:          '25.00',
      additionalinfo:  'fee',
      status:          'Paid',
      pollurl:         'https://www.paynow.co.zw/Interface/CheckPayment/?guid=AAA',
    }
    const raw = signedBody(fields)
    const driver = getDriver('paynow')
    const v = await driver.verifyWebhook({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body:    Object.fromEntries(new URLSearchParams(raw)),
      rawBody: raw,
    })
    expect(v.ok).toBe(true)
    expect(v.paid).toBe(true)
    expect(v.providerRef).toBe(fields.pollurl)
    expect(v.providerStatus).toBe('Paid')
  })

  it('rejects a tampered Paid callback', async () => {
    const fields = {
      reference: 'ref', paynowreference: 'PN1', amount: '25.00',
      additionalinfo: 'fee', status: 'Paid',
      pollurl: 'https://www.paynow.co.zw/Interface/CheckPayment/?guid=AAA',
    }
    const raw = signedBody(fields)
    const tampered = raw.replace('amount=25.00', 'amount=0.01')
    const driver = getDriver('paynow')
    const v = await driver.verifyWebhook({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body:    Object.fromEntries(new URLSearchParams(tampered)),
      rawBody: tampered,
    })
    expect(v.ok).toBe(false)
  })
})
