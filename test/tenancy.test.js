jest.mock('../src/middleware/jwtAuth', () => ({
  requireAuth: () => async () => {},
  requireRole: () => async () => {},
  optionalAuth: () => async (request) => { if (request.__signedIn) request.user = request.__signedIn },
}))

const { contextOf, acquire, withTenant, tenantPool, APP_ROLE } = require('../src/lib/tenancy')
const { makePg } = require('./helpers/fakePg')
const { developmentManagementRoutes } = require('../src/routes/development-management')

// A pool whose clients record every statement, including the control ones, in order.
function recordingPool({ failOn } = {}) {
  const statements = []
  const released = []
  const client = {
    query: jest.fn(async (sql, params) => {
      statements.push({ sql: String(sql), params })
      if (failOn && failOn.test(String(sql))) throw new Error('boom')
      return { rows: [{ ok: 1 }], rowCount: 1 }
    }),
    release: jest.fn((destroy) => released.push(!!destroy)),
  }
  return { pool: { connect: jest.fn(async () => client) }, statements, released, client }
}

describe('who a request runs as', () => {
  test('a person: their id, authority and platform flag; the public: nothing', () => {
    expect(contextOf({ id: 'u1', authority_id: 7, is_platform: false })).toEqual({ userId: 'u1', authorityId: '7', platform: false })
    expect(contextOf({ id: 'u2', authority_id: null, is_platform: true })).toEqual({ userId: 'u2', authorityId: '', platform: true })
    expect(contextOf(undefined)).toEqual({ userId: '', authorityId: '', platform: false })
    expect(contextOf({ id: 'u3', is_platform: 'on' }).platform).toBe(false)   // only a real boolean true
  })

  test('steps into the restricted role and sets the three settings', async () => {
    const { pool, statements } = recordingPool()
    const c = await acquire(pool, { id: 'u1', authority_id: 7 })
    expect(statements[0].sql).toBe(`SET ROLE ${APP_ROLE}`)
    expect(statements[1].sql).toMatch(/set_config\('app\.user_id'/)
    expect(statements[1].params).toEqual(['u1', '7', ''])
    await c.release()
  })

  test('on release it rolls back, resets role and settings, then returns the connection', async () => {
    const { pool, statements, released } = recordingPool()
    const c = await acquire(pool, { id: 'u1', authority_id: 7 })
    statements.length = 0
    await c.release()
    expect(statements.map((s) => s.sql.split('(')[0].trim())).toEqual(['ROLLBACK', 'RESET ROLE', 'SELECT set_config'])
    expect(released).toEqual([false])
  })

  test('if the connection cannot be reset it is thrown away, never returned carrying someone\'s identity', async () => {
    const { pool, released } = recordingPool({ failOn: /RESET ROLE/ })
    const c = await acquire(pool, { id: 'u1', authority_id: 7 })
    await c.release()
    expect(released).toEqual([true])
  })

  test('FAILS CLOSED: if it cannot step into the role, it throws and discards the connection, never running as the owner', async () => {
    const { pool, released } = recordingPool({ failOn: /^SET ROLE/ })
    await expect(acquire(pool, { id: 'u1', authority_id: 7 })).rejects.toThrow('boom')
    expect(released).toEqual([true])
  })

  test('withTenant releases even when the work throws', async () => {
    const { pool, released } = recordingPool()
    await expect(withTenant(pool, { id: 'u1' }, async () => { throw new Error('work failed') })).rejects.toThrow('work failed')
    expect(released).toEqual([false])
  })

  test('tenantPool.query scopes one statement and connect() hands back a scoped client', async () => {
    const { pool, statements } = recordingPool()
    const db = tenantPool(pool, { id: 'u1', authority_id: 7 })
    const r = await db.query('SELECT 1', [])
    expect(r.rows).toEqual([{ ok: 1 }])
    expect(statements.some((s) => /^SET ROLE/.test(s.sql))).toBe(true)
    const c = await db.connect()
    await c.release()
    expect(pool.connect).toHaveBeenCalledTimes(2)
  })
})

describe('a permit addressed by id is invisible to someone whose authority does not own it', () => {
  const ID = '4c98ad9f-d0bd-4360-864b-af54cef9d08f'
  async function hookFor(rowsFor) {
    let hook
    const { pg } = makePg(async () => ({ rows: rowsFor }))
    const server = { pg, addHook: (_name, fn) => { hook = fn }, get() {}, post() {}, put() {}, patch() {}, delete() {} }
    await developmentManagementRoutes(server)
    return { hook, pg }
  }
  const reply = () => { const r = { statusCode: 200, body: null }; r.code = (c) => { r.statusCode = c; return r }; r.send = (b) => { r.body = b; return r }; return r }

  test('a signed-in person who cannot see the permit gets a 404, as if it did not exist', async () => {
    const { hook } = await hookFor([])
    const rep = reply()
    await hook({ routeOptions: { url: '/permit-applications/:id/rule-snapshot' }, params: { id: ID }, __signedIn: { id: 'u1', authority_id: 2 } }, rep)
    expect(rep.statusCode).toBe(404)
  })

  test('one who can see it passes through', async () => {
    const { hook } = await hookFor([{ '?column?': 1 }])
    const rep = reply()
    await hook({ routeOptions: { url: '/permit-applications/:id' }, params: { id: ID }, __signedIn: { id: 'u1', authority_id: 1 } }, rep)
    expect(rep.statusCode).toBe(200)
  })

  test('anonymous requests, bad ids and other routes are left to the routes themselves', async () => {
    const { hook, pg } = await hookFor([])
    const rep = reply()
    await hook({ routeOptions: { url: '/permit-applications/:id' }, params: { id: ID } }, rep)                       // no user: the route answers 401
    await hook({ routeOptions: { url: '/permit-applications/:id' }, params: { id: 'nope' }, __signedIn: { id: 'u' } }, rep)   // the route validates the id
    await hook({ routeOptions: { url: '/permit-applications' }, params: {}, __signedIn: { id: 'u' } }, rep)            // the list is scoped by the database
    await hook({ routeOptions: { url: '/enforcement-orders/:id' }, params: { id: ID }, __signedIn: { id: 'u' } }, rep) // not a permit route
    expect(rep.statusCode).toBe(200)
    expect(pg.query).not.toHaveBeenCalled()
  })
})
