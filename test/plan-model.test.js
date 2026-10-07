const { planModelRoutes, plansQuery, AUTHORITIES_SQL, PROFILES_SQL } = require('../src/routes/planModel')

// Registers the routes on a stand-in server and returns the handlers.
async function setup(queryImpl) {
  const routes = {}
  const server = {
    pg: { query: jest.fn(queryImpl) },
    get: (path, handler) => { routes[path] = handler },
  }
  await planModelRoutes(server)
  const call = async (path, query = {}) => {
    const reply = { code: 200, body: null, code_(c) { this.code = c; return this }, send(b) { this.body = b; return this } }
    reply.code = function (c) { reply.statusCode = c; return reply }
    const out = await routes[path]({ query, log: { error() {} } }, reply)
    return { out, reply }
  }
  return { server, call }
}

describe('plansQuery (filters are bound parameters, never concatenated)', () => {
  test('no filters: everything, templates first', () => {
    const { sql, params } = plansQuery({})
    expect(params).toEqual([])
    expect(sql).not.toMatch(/WHERE/)
    expect(sql).toMatch(/ORDER BY is_template DESC/)
  })

  test('authority and profile are normalised and bound', () => {
    const { sql, params } = plansQuery({ authority: 'vungu', profile: 'URBAN' })
    expect(params).toEqual(['VUNGU', 'urban'])
    expect(sql).toMatch(/authority_code = \$1 AND profile_code = \$2/)
  })

  test('template accepts only true or false', () => {
    expect(plansQuery({ template: 'true' }).params).toEqual([true])
    expect(plansQuery({ template: 'false' }).params).toEqual([false])
    expect(plansQuery({ template: "x'; DROP TABLE plan_instrument; --" }).params).toEqual([])
  })

  test('a hostile authority value never reaches the SQL text', () => {
    const { sql, params } = plansQuery({ authority: "x'; DROP TABLE local_authorities; --" })
    expect(sql).not.toMatch(/DROP/)
    expect(params[0]).toMatch(/DROP/) // only as a bound value
  })
})

describe('plan model endpoints', () => {
  test('GET /authorities returns rows and a count', async () => {
    const rows = [{ id: 1, code: 'VUNGU', kind: 'rural', members: [] }]
    const { call, server } = await setup(async () => ({ rows }))
    const { out } = await call('/authorities')
    expect(out).toEqual({ success: true, count: 1, data: rows })
    expect(server.pg.query).toHaveBeenCalledWith(AUTHORITIES_SQL)
  })

  test('the authorities query returns no contact details and only active authorities', () => {
    expect(AUTHORITIES_SQL).not.toMatch(/telephone|email|address|application_fee/)
    expect(AUTHORITIES_SQL).toMatch(/WHERE a\.is_active/)
    expect(AUTHORITIES_SQL).toMatch(/valid_to IS NULL OR am\.valid_to >= CURRENT_DATE/) // current members only
  })

  test('GET /plan-profiles uses the profiles query', async () => {
    const { call, server } = await setup(async () => ({ rows: [{ code: 'rural' }, { code: 'urban' }] }))
    const { out } = await call('/plan-profiles')
    expect(out.count).toBe(2)
    expect(server.pg.query).toHaveBeenCalledWith(PROFILES_SQL)
  })

  test('GET /plans passes the filters as parameters', async () => {
    const { call, server } = await setup(async () => ({ rows: [] }))
    await call('/plans', { authority: 'vungu', template: 'false' })
    const [sql, params] = server.pg.query.mock.calls[0]
    expect(params).toEqual(['VUNGU', false])
    expect(sql).toMatch(/authority_code = \$1 AND is_template = \$2/)
  })

  test('a database error is a 500 with a safe message, not a stack trace', async () => {
    const { call } = await setup(async () => { throw new Error('connection to server at "10.0.0.5" failed') })
    const { reply } = await call('/plans')
    expect(reply.statusCode).toBe(500)
    expect(reply.body).toEqual({ success: false, error: 'Failed to list plans' })
    expect(JSON.stringify(reply.body)).not.toMatch(/10\.0\.0\.5/) // the connection detail is not leaked
  })
})
