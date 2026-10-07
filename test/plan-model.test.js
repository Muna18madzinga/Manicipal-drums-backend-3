const { planModelRoutes, plansQuery, AUTHORITIES_SQL, PROFILES_SQL } = require('../src/routes/planModel')

// Registers the routes on a stand-in server and returns the handlers.
async function setup(queryImpl) {
  const routes = {}
  const server = {
    pg: { query: jest.fn(queryImpl) },
    get: (path, handler) => { routes[path] = handler },
  }
  await planModelRoutes(server)
  const call = async (path, query = {}, params = {}) => {
    const reply = { code: 200, body: null, code_(c) { this.code = c; return this }, send(b) { this.body = b; return this } }
    reply.code = function (c) { reply.statusCode = c; return reply }
    const out = await routes[path]({ query, params, log: { error() {} } }, reply)
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

  describe('GET /plans/:id/crosswalk', () => {
    const ID = '4c98ad9f-d0bd-4360-864b-af54cef9d08f'

    test('a malformed id is a 400 and never reaches the database', async () => {
      const { call, server } = await setup(async () => ({ rows: [] }))
      const { reply } = await call('/plans/:id/crosswalk', {}, { id: "1; DROP TABLE plan_instrument" })
      expect(reply.statusCode).toBe(400)
      expect(server.pg.query).not.toHaveBeenCalled()
    })

    test('an unknown plan is a 404', async () => {
      const { call } = await setup(async () => ({ rows: [] }))
      const { reply } = await call('/plans/:id/crosswalk', {}, { id: ID })
      expect(reply.statusCode).toBe(404)
    })

    test('returns the rows with the plan id bound as a parameter', async () => {
      const rows = [{ kind: 'zone_type', code: 'Game Park Zone', class_code: '6_1_AgriculturalNatureManagementAreas', relation: 'within', status: 'proposed' }]
      const { call, server } = await setup(async (sql) => (/reference_classification/.test(sql) ? { rows } : { rows: [{ id: ID, title: 'Plan' }] }))
      const { out } = await call('/plans/:id/crosswalk', {}, { id: ID })
      expect(out.count).toBe(1)
      expect(out.data.rows).toEqual(rows)
      expect(server.pg.query).toHaveBeenLastCalledWith(expect.stringContaining('plan_zone_type_class'), [ID])
    })
  })

  describe('GET /plans/:a/compare/:b', () => {
    const A = '4c98ad9f-d0bd-4360-864b-af54cef9d08f'
    const B = 'eed92770-213c-4542-b006-b954521e16d7'

    test('a malformed id is a 400 and never reaches the database', async () => {
      const { call, server } = await setup(async () => ({ rows: [] }))
      const { reply } = await call('/plans/:a/compare/:b', {}, { a: A, b: "x'; --" })
      expect(reply.statusCode).toBe(400)
      expect(server.pg.query).not.toHaveBeenCalled()
    })

    test('an unknown plan is a 404', async () => {
      const { call } = await setup(async () => ({ rows: [{ id: A, title: 'Only one' }] }))
      const { reply } = await call('/plans/:a/compare/:b', {}, { a: A, b: B })
      expect(reply.statusCode).toBe(404)
    })

    test('returns both titles and the class rows, ids bound as parameters', async () => {
      const classes = [{ class_code: '1_3_MiningAndQuarrying', presence: 'only_b' }]
      const { call, server } = await setup(async (sql) => (/plan_compare/.test(sql)
        ? { rows: classes }
        : { rows: [{ id: A, title: 'Sample' }, { id: B, title: 'Starter' }] }))
      const { out } = await call('/plans/:a/compare/:b', {}, { a: A, b: B })
      expect(out.data.a.title).toBe('Sample')
      expect(out.data.b.title).toBe('Starter')
      expect(out.data.classes).toEqual(classes)
      expect(server.pg.query).toHaveBeenLastCalledWith('SELECT * FROM plan_compare($1, $2)', [A, B])
    })
  })

  describe('GET /plans/:id/diff', () => {
    const ID = '4c98ad9f-d0bd-4360-864b-af54cef9d08f'

    test('a malformed id is a 400 and never reaches the database', async () => {
      const { call, server } = await setup(async () => ({ rows: [] }))
      const { reply } = await call('/plans/:id/diff', {}, { id: "x'; DROP TABLE plan_instrument; --" })
      expect(reply.statusCode).toBe(400)
      expect(server.pg.query).not.toHaveBeenCalled()
    })

    test('an unknown plan is a 404', async () => {
      const { call } = await setup(async () => ({ rows: [] }))
      const { reply } = await call('/plans/:id/diff', {}, { id: ID })
      expect(reply.statusCode).toBe(404)
    })

    test('a plan that was not adopted from a template has no diff, and says so', async () => {
      const { call, server } = await setup(async () => ({ rows: [{ id: ID, title: 'Own plan', derived_from_id: null }] }))
      const { out } = await call('/plans/:id/diff', {}, { id: ID })
      expect(out.count).toBe(0)
      expect(out.data.note).toMatch(/not adopted from a template/)
      expect(server.pg.query).toHaveBeenCalledTimes(1) // plan_diff() is not run
    })

    test('an adopted plan returns its changed cells', async () => {
      const changes = [{ zone_type_code: 'Game Park Zone', land_use_code: 'D', template_decision: 'prohibited', plan_decision: 'permitted', change: 'changed' }]
      const { call, server } = await setup(async (sql) => (/plan_diff/.test(sql)
        ? { rows: changes }
        : { rows: [{ id: ID, title: 'Adopted', derived_from_id: 'eed92770-213c-4542-b006-b954521e16d7' }] }))
      const { out } = await call('/plans/:id/diff', {}, { id: ID })
      expect(out.count).toBe(1)
      expect(out.data.changes).toEqual(changes)
      expect(server.pg.query).toHaveBeenLastCalledWith('SELECT * FROM plan_diff($1)', [ID])
    })
  })
})
