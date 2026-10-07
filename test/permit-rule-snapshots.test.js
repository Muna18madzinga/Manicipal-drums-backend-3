jest.mock('../src/middleware/jwtAuth', () => ({ requireAuth: () => async () => {}, requireRole: () => async () => {} }))

const { developmentManagementRoutes } = require('../src/routes/development-management')

const PERMIT = '4c98ad9f-d0bd-4360-864b-af54cef9d08f'
const OWNER = '11111111-1111-1111-1111-111111111111'

function makeServer(queryImpl) {
  const routes = {}
  const reg = (verb) => (path, ...rest) => { routes[`${verb} ${path}`] = rest[rest.length - 1] }
  const server = {
    pg: { query: jest.fn(queryImpl) },
    log: { error() {}, info() {}, warn() {} },
    get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE'),
  }
  const call = async (key, request) => {
    const reply = { statusCode: 200, body: null }
    reply.code = reply.status = (c) => { reply.statusCode = c; return reply }
    reply.send = (b) => { reply.body = b; return reply }
    const out = await routes[key]({
      query: {}, params: {}, body: {}, user: { id: OWNER, role: 'planner' }, log: { error() {} }, ...request,
    }, reply)
    return { out, reply }
  }
  return { server, call }
}

const setup = async (impl) => { const s = makeServer(impl); await developmentManagementRoutes(s.server); return s }

describe('POST /permit-applications links the parcel at lodgement', () => {
  const KEY = 'POST /permit-applications'
  const body = { applicant_name: 'A Citizen', development_type: 'new_building', stand_number: '123', suburb_ward: '1' }

  test('the server resolves the parcel and merges the link into the response', async () => {
    const calls = []
    const { call } = await setup(async (sql, params) => {
      calls.push(sql)
      if (/INSERT INTO spatial_planning.permit_application/.test(sql)) return { rows: [{ id: PERMIT, applicant_name: 'A Citizen' }] }
      if (/lodge_permit_zoning/.test(sql)) return { rows: [{}] }
      if (/SELECT authority_id, parcel_layer/.test(sql)) return { rows: [{ authority_id: 1, parcel_layer: 'stands', parcel_id: 'S1', parcel_match: 'matched', plan_instrument_id: 'plan-1' }] }
      return { rows: [] }
    })
    const { reply } = await call(KEY, { body, user: { id: OWNER, role: 'public' } })
    expect(reply.statusCode).toBe(201)
    expect(reply.body.data).toMatchObject({ parcel_layer: 'stands', parcel_match: 'matched', plan_instrument_id: 'plan-1' })
    expect(calls.some((s) => /lodge_permit_zoning/.test(s))).toBe(true)
  })

  test('a failure while linking the parcel never fails the lodgement', async () => {
    const { call } = await setup(async (sql) => {
      if (/INSERT INTO spatial_planning.permit_application/.test(sql)) return { rows: [{ id: PERMIT, applicant_name: 'A Citizen' }] }
      if (/lodge_permit_zoning/.test(sql)) throw new Error('postgis exploded')
      return { rows: [] }
    })
    const { reply } = await call(KEY, { body, user: { id: OWNER, role: 'public' } })
    expect(reply.statusCode).toBe(201)
    expect(reply.body.data.id).toBe(PERMIT)
  })

  test('the client cannot supply the parcel or plan: the insert never takes them from the body', async () => {
    const { call, server } = await setup(async (sql) => (/INSERT INTO spatial_planning.permit_application/.test(sql)
      ? { rows: [{ id: PERMIT }] } : { rows: [{}] }))
    await call(KEY, { body: { ...body, parcel_layer: 'stands', parcel_id: 'evil', plan_instrument_id: 'evil', rules_snapshot: { decision: 'permitted' } }, user: { id: OWNER, role: 'public' } })
    const insert = server.pg.query.mock.calls.find(([sql]) => /INSERT INTO spatial_planning.permit_application/.test(sql))
    expect(JSON.stringify(insert[1])).not.toMatch(/evil|permitted/)
  })
})

describe('PUT /permit-applications/:id/parcel', () => {
  const KEY = 'PUT /permit-applications/:id/parcel'

  test('a bad permit id or parcel reference is a 400 and never reaches the database', async () => {
    const { call, server } = await setup(async () => ({ rows: [] }))
    expect((await call(KEY, { params: { id: 'nope' }, body: { layer: 'stands', id: '1' } })).reply.statusCode).toBe(400)
    expect((await call(KEY, { params: { id: PERMIT }, body: { layer: 'users', id: '1' } })).reply.statusCode).toBe(400)
    expect((await call(KEY, { params: { id: PERMIT }, body: { layer: 'stands', id: "1'; --" } })).reply.statusCode).toBe(400)
    expect(server.pg.query).not.toHaveBeenCalled()
  })

  test('sets the parcel through the database function, recording who did it', async () => {
    const snapshot = { results: [] }
    const { call, server } = await setup(async () => ({ rows: [{ snapshot }] }))
    const { reply } = await call(KEY, { params: { id: PERMIT }, body: { layer: 'stands', id: 'S1' } })
    expect(reply.statusCode).toBe(200)
    expect(reply.body.data).toEqual(snapshot)
    expect(server.pg.query).toHaveBeenCalledWith(expect.stringContaining('set_permit_parcel'), [PERMIT, 'stands', 'S1', OWNER])
  })

  test('an unknown parcel is a 404', async () => {
    const { call } = await setup(async () => { throw new Error('no parcel S9 in layer stands') })
    const { reply } = await call(KEY, { params: { id: PERMIT }, body: { layer: 'stands', id: 'S9' } })
    expect(reply.statusCode).toBe(404)
  })
})

describe('POST /permit-applications/:id/rule-snapshot', () => {
  const KEY = 'POST /permit-applications/:id/rule-snapshot'

  test('a bad land-use code is a 400 and never reaches the database', async () => {
    const { call, server } = await setup(async () => ({ rows: [] }))
    const { reply } = await call(KEY, { params: { id: PERMIT }, body: { land_use_code: "A'; DROP TABLE x; --" } })
    expect(reply.statusCode).toBe(400)
    expect(server.pg.query).not.toHaveBeenCalled()
  })

  test('the snapshot is computed by the database from the permit, not supplied by the client', async () => {
    const snapshot = { results: [{ decision: 'prohibited' }] }
    const { call, server } = await setup(async () => ({ rows: [{ snapshot }] }))
    const { reply } = await call(KEY, { params: { id: PERMIT }, body: { land_use_code: 'A', snapshot: { results: [{ decision: 'permitted' }] } } })
    expect(reply.statusCode).toBe(201)
    expect(reply.body.data).toEqual(snapshot)
    expect(server.pg.query).toHaveBeenCalledWith(expect.stringContaining('take_permit_assessment_snapshot'), [PERMIT, 'A', OWNER])
  })

  test('a permit with no parcel is a 409: set the parcel first', async () => {
    const { call } = await setup(async () => { throw new Error('permit x has no parcel: set the parcel first') })
    const { reply } = await call(KEY, { params: { id: PERMIT }, body: { land_use_code: 'A' } })
    expect(reply.statusCode).toBe(409)
    expect(reply.body.error).toBe('no_parcel')
  })
})

describe('GET /permit-applications/:id/rule-snapshots', () => {
  const KEY = 'GET /permit-applications/:id/rule-snapshots'
  const permitRow = { id: PERMIT, created_by: OWNER, parcel_layer: 'stands', parcel_id: 'S1', parcel_match: 'matched', plan_instrument_id: 'p' }

  test("someone else's permit is a 404, so its existence is not leaked", async () => {
    const { call } = await setup(async () => ({ rows: [{ ...permitRow, created_by: 'someone-else' }] }))
    const { reply } = await call(KEY, { params: { id: PERMIT }, user: { id: OWNER, role: 'public' } })
    expect(reply.statusCode).toBe(404)
  })

  test('the owner sees the parcel link and the history, without internal ids', async () => {
    const snaps = [{ id: 's1', kind: 'lodgement' }, { id: 's2', kind: 'assessment' }]
    const { call } = await setup(async (sql) => (/permit_rule_snapshot/.test(sql) ? { rows: snaps } : { rows: [permitRow] }))
    const { reply } = await call(KEY, { params: { id: PERMIT }, user: { id: OWNER, role: 'public' } })
    const body = reply.body
    expect(body.data.snapshots).toEqual(snaps)
    expect(body.data.parcel).toEqual({ parcel_layer: 'stands', parcel_id: 'S1', parcel_match: 'matched', plan_instrument_id: 'p' })
  })
})
