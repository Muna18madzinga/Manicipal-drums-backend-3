jest.mock('../src/middleware/jwtAuth', () => ({ requireAuth: () => async () => {}, requireRole: () => async () => {} }))

const { parseParcelRef, parseUseCode, singlePlanId, takeSnapshot } = require('../src/utils/ruleSnapshot')
const { parcelZoningRoutes } = require('../src/routes/parcelZoning')
const { developmentManagementRoutes } = require('../src/routes/development-management')

function makeServer(queryImpl) {
  const routes = {}
  const server = {
    pg: { query: jest.fn(queryImpl) },
    log: { error() {} },
    get: (path, ...rest) => { routes['GET ' + path] = rest[rest.length - 1] },
    post: (path, ...rest) => { routes['POST ' + path] = rest[rest.length - 1] },
    patch: (path, ...rest) => { routes['PATCH ' + path] = rest[rest.length - 1] },
    delete: (path, ...rest) => { routes['DELETE ' + path] = rest[rest.length - 1] },
  }
  const call = async (key, request) => {
    const reply = { statusCode: 200, body: null }
    reply.code = reply.status = (c) => { reply.statusCode = c; return reply }
    reply.send = (b) => { reply.body = b; return reply }
    const out = await routes[key]({ query: {}, params: {}, body: {}, user: { id: 'u1', role: 'citizen' }, log: { error() {} }, ...request }, reply)
    return { out, reply }
  }
  return { server, call }
}

describe('input validation', () => {
  test('parcel references: only known layers and plain identifiers', () => {
    expect(parseParcelRef('stands', 'abc-123')).toEqual({ layer: 'stands', id: 'abc-123' })
    expect(parseParcelRef('vungu_parcels', 42)).toEqual({ layer: 'vungu_parcels', id: '42' })
    expect(parseParcelRef('users', '1')).toBeNull()
    expect(parseParcelRef('stands', "1'; DROP TABLE stands; --")).toBeNull()
    expect(parseParcelRef('stands', { a: 1 })).toBeNull()
  })
  test('land-use codes are short plain codes', () => {
    expect(parseUseCode('A1')).toBe('A1')
    expect(parseUseCode('A 1')).toBeNull()
    expect(parseUseCode("A'; --")).toBeNull()
    expect(parseUseCode(5)).toBeNull()
  })
  test('an application records a plan only when exactly one plan governs', () => {
    const r = (id, governing) => ({ plan: { id }, governing })
    expect(singlePlanId({ results: [r('p1', true), r('p1', false)] })).toBe('p1')
    expect(singlePlanId({ results: [r('p1', true), r('p2', true)] })).toBeNull()
    expect(singlePlanId({ results: [] })).toBeNull()
  })
  test('takeSnapshot passes the parcel and use as parameters', async () => {
    const db = { query: jest.fn(async () => ({ rows: [{ snapshot: { results: [] } }] })) }
    await takeSnapshot(db, { layer: 'stands', id: '1' }, 'A')
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('rule_snapshot($1, $2, $3)'), ['stands', '1', 'A'])
  })
})

describe('GET /parcel-zoning/:layer/:id', () => {
  const setup = async (impl) => { const s = makeServer(impl); await parcelZoningRoutes(s.server); return s }
  const KEY = 'GET /parcel-zoning/:layer/:id'

  test('a bad layer or id is a 400 and never reaches the database', async () => {
    const { call, server } = await setup(async () => ({ rows: [] }))
    expect((await call(KEY, { params: { layer: 'users', id: '1' } })).reply.statusCode).toBe(400)
    expect((await call(KEY, { params: { layer: 'stands', id: '1;--' } })).reply.statusCode).toBe(400)
    expect(server.pg.query).not.toHaveBeenCalled()
  })

  test('a bad use code is a 400', async () => {
    const { call } = await setup(async () => ({ rows: [] }))
    const { reply } = await call(KEY, { params: { layer: 'stands', id: '1' }, query: { use: "A'; --" } })
    expect(reply.statusCode).toBe(400)
  })

  test('an unknown parcel is a 404', async () => {
    const { call } = await setup(async () => ({ rows: [{ found: false }] }))
    const { reply } = await call(KEY, { params: { layer: 'stands', id: '1' } })
    expect(reply.statusCode).toBe(404)
  })

  test('without ?use it lists the zones and flags an unzoned parcel', async () => {
    const { call } = await setup(async (sql) => (/parcel_geometry/.test(sql) ? { rows: [{ found: true }] } : { rows: [] }))
    const { out } = await call(KEY, { params: { layer: 'stands', id: '1' } })
    expect(out.data.unzoned).toBe(true)
    expect(out.data.zones).toEqual([])
  })

  test('with ?use it returns the server-computed snapshot', async () => {
    const snapshot = { unzoned: false, results: [{ decision: 'permitted' }] }
    const { call, server } = await setup(async (sql) => (/parcel_geometry/.test(sql) ? { rows: [{ found: true }] } : { rows: [{ snapshot }] }))
    const { out } = await call(KEY, { params: { layer: 'stands', id: '1' }, query: { use: 'A' } })
    expect(out.data).toEqual(snapshot)
    expect(server.pg.query).toHaveBeenLastCalledWith(expect.stringContaining('rule_snapshot'), ['stands', '1', 'A'])
  })

  test('a database error is a 500 without detail', async () => {
    const { call } = await setup(async () => { throw new Error('host 10.0.0.5 down') })
    const { reply } = await call(KEY, { params: { layer: 'stands', id: '1' } })
    expect(reply.statusCode).toBe(500)
    expect(JSON.stringify(reply.body)).not.toMatch(/10\.0\.0\.5/)
  })
})
