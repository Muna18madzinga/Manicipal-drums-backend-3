jest.mock('../src/middleware/jwtAuth', () => ({
  requireAuth: () => async () => {},
  requireRole: () => async () => {},
  requireAdmin: () => Object.assign(async () => {}, { admin: true }),
}))
const mockSettings = { 'analytics.enabled': true, 'analytics.retention_days': 395 }
jest.mock('../src/services/adminSettings', () => ({
  getSetting: jest.fn(async (_f, key) => mockSettings[key]),
  invalidate: jest.fn(),
  DEFAULTS: {},
}))

const U = require('../src/services/usageAnalytics')
const { analyticsRoutes } = require('../src/routes/analytics')
const { adminConsoleRoutes } = require('../src/routes/admin-console')

const VISITOR = '4c98ad9f-d0bd-4360-864b-af54cef9d08f'

function makeServer(queryImpl) {
  const routes = {}
  const reg = (verb) => (path, ...rest) => { routes[`${verb} ${path}`] = { handler: rest[rest.length - 1], opts: rest.length > 1 ? rest[0] : {} } }
  const server = {
    pg: { query: jest.fn(queryImpl) },
    log: { error() {}, warn() {}, info() {} },
    get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE'),
  }
  const call = async (key, request) => {
    const reply = { statusCode: 200, body: undefined }
    reply.code = (c) => { reply.statusCode = c; return reply }
    reply.send = (b) => { reply.body = b; return reply }
    await routes[key].handler({ query: {}, params: {}, body: {}, headers: {}, log: { error() {} }, ...request }, reply)
    return { reply }
  }
  return { server, call, routes }
}

describe('what the server will accept', () => {
  const ok = (body) => U.parsePageView(body)

  test('a route pattern, an optional visitor id and an optional bare host', () => {
    expect(ok({ path: '/applications/:id' })).toEqual({ path: '/applications/:id', visitorId: null, referrerHost: null })
    expect(ok({ path: '/admin/plan-workbench', visitorId: VISITOR.toUpperCase(), referrerHost: 'Example.ORG' }))
      .toEqual({ path: '/admin/plan-workbench', visitorId: VISITOR, referrerHost: 'example.org' })
  })

  test('refuses anything that is a concrete URL, not a pattern', () => {
    for (const path of ['/applications?id=7', '/a#frag', '/applications/4c98ad9f-d0bd-4360-864b-af54cef9d08f', '/permits/1234567', 'applications', '/has space', '/ünï', '/' + 'x'.repeat(200), 5, null, undefined, {}]) {
      expect(ok({ path }).error).toBe('bad_path')
    }
  })

  test('refuses a bad visitor id or referrer, rather than storing something else', () => {
    expect(ok({ path: '/x', visitorId: 'not-a-uuid' }).error).toBe('bad_visitor')
    expect(ok({ path: '/x', visitorId: 12 }).error).toBe('bad_visitor')
    for (const referrerHost of ['https://example.org/path', 'example.org:8080', 'a b', '', '-bad.org', 'x'.repeat(260), 5]) {
      expect(ok({ path: '/x', referrerHost }).error).toBe('bad_referrer')
    }
  })

  test('a body that is not an object is refused', () => {
    expect(ok('path=/x').error).toBe('bad_path')
    expect(ok(null).error).toBe('bad_path')
  })

  test('Do Not Track and Global Privacy Control are honoured', () => {
    expect(U.doNotTrack({ dnt: '1' })).toBe(true)
    expect(U.doNotTrack({ 'sec-gpc': '1' })).toBe(true)
    expect(U.doNotTrack({ dnt: '0' })).toBeFalsy()
    expect(U.doNotTrack({})).toBeFalsy()
  })
})

describe('POST /analytics/pageview', () => {
  const KEY = 'POST /analytics/pageview'
  const setup = async (impl = async () => ({ rows: [], rowCount: 0 })) => { const s = makeServer(impl); await analyticsRoutes(s.server); return s }
  beforeEach(() => { mockSettings['analytics.enabled'] = true })

  test('is public but capped: a small body and its own rate limit well under the global one', async () => {
    const { routes } = await setup()
    expect(routes[KEY].opts.bodyLimit).toBeLessThanOrEqual(4096)
    expect(routes[KEY].opts.config.rateLimit.max).toBeLessThanOrEqual(120)
    expect(routes[KEY].opts.preHandler).toBeUndefined()
  })

  test('stores exactly the three cleaned fields and answers 204', async () => {
    const { call, server } = await setup()
    const { reply } = await call(KEY, { body: { path: '/citizen', visitorId: VISITOR, referrerHost: 'example.org', userId: 'u1', email: 'a@b.c', ip: '1.2.3.4', query: '?x=1' } })
    expect(reply.statusCode).toBe(204)
    const insert = server.pg.query.mock.calls.find(([sql]) => /INSERT INTO public.page_view/.test(sql))
    expect(insert[1]).toEqual(['/citizen', VISITOR, 'example.org'])   // nothing else can reach the table
  })

  test('a malformed request is a 400 and stores nothing', async () => {
    const { call, server } = await setup()
    const { reply } = await call(KEY, { body: { path: '/permits/1234567' } })
    expect(reply.statusCode).toBe(400)
    expect(reply.body.error).toBe('bad_path')
    expect(server.pg.query).not.toHaveBeenCalled()
  })

  test('with analytics switched off it accepts and discards: 204, nothing stored', async () => {
    mockSettings['analytics.enabled'] = false
    const { call, server } = await setup()
    const { reply } = await call(KEY, { body: { path: '/citizen' } })
    expect(reply.statusCode).toBe(204)
    expect(server.pg.query).not.toHaveBeenCalled()
  })

  test('a browser that says Do Not Track is never stored, whatever the client sent', async () => {
    const { call, server } = await setup()
    const { reply } = await call(KEY, { body: { path: '/citizen' }, headers: { dnt: '1' } })
    expect(reply.statusCode).toBe(204)
    expect(server.pg.query).not.toHaveBeenCalled()
  })

  test('a database fault is a 500 with no detail', async () => {
    const { call } = await setup(async () => { throw new Error('connection to 10.0.0.5 refused') })
    const { reply } = await call(KEY, { body: { path: '/citizen' } })
    expect(reply.statusCode).toBe(500)
    expect(JSON.stringify(reply.body)).not.toMatch(/10\.0\.0\.5/)
  })
})

describe('retention', () => {
  test('deletes what is older than the council\'s period, at most once a day', async () => {
    const pg = { query: jest.fn(async () => ({ rowCount: 3 })) }
    const prune = U.makePruner(pg, async () => 395, { info() {} })
    const t0 = 1_800_000_000_000
    expect(await prune(t0)).toBe(3)
    expect(pg.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM public.page_view'), ['395'])
    expect(await prune(t0 + 3_600_000)).toBe(0)       // the same day: nothing runs
    expect(pg.query).toHaveBeenCalledTimes(1)
    await prune(t0 + 86_400_001)                       // the next day: runs again
    expect(pg.query).toHaveBeenCalledTimes(2)
  })

  test('ignores a nonsense period instead of deleting everything', async () => {
    for (const bad of [0, 5, 29, NaN, undefined, 'x']) {
      const pg = { query: jest.fn(async () => ({ rowCount: 99 })) }
      await U.makePruner(pg, async () => bad)(1_800_000_000_000)
      expect(pg.query).not.toHaveBeenCalled()
    }
  })

  test('a failure while pruning never escapes', async () => {
    const pg = { query: jest.fn(async () => { throw new Error('boom') }) }
    await expect(U.makePruner(pg, async () => 395, { warn() {} })(1_800_000_000_000)).resolves.toBe(0)
  })
})

describe('GET /admin/usage', () => {
  const KEY = 'GET /admin/usage'
  const setup = async (impl) => { const s = makeServer(impl); await adminConsoleRoutes(s.server); return s }
  const impl = async (sql) => {
    if (/^\s*SELECT COUNT\(\*\)::int AS views/.test(sql)) return { rows: [{ views: 12, visitors: 4 }] }
    if (/generate_series/.test(sql)) return { rows: [{ day: '2026-10-06', views: 5, visitors: 2 }, { day: '2026-10-07', views: 7, visitors: 3 }] }
    return { rows: [{ path: '/citizen', views: 9, visitors: 3 }] }
  }

  test('is admin only', async () => {
    const { routes } = await setup(impl)
    expect(routes[KEY].opts.preHandler.admin).toBe(true)
  })

  test('returns the shape the console screen reads, for the window asked', async () => {
    const { call, server } = await setup(impl)
    const { reply } = await call(KEY, { query: { days: '30' } })
    expect(reply.body.data).toEqual({
      days: 30, totalViews: 12, distinctVisitors: 4,
      daily: [{ day: '2026-10-06', views: 5, visitors: 2 }, { day: '2026-10-07', views: 7, visitors: 3 }],
      topPaths: [{ path: '/citizen', views: 9, visitors: 3 }],
    })
    expect(server.pg.query.mock.calls[0][1]).toEqual([30, 'Africa/Harare'])   // bound parameters, council's local days
  })

  test('only the offered windows are honoured; anything else is a week', async () => {
    expect(U.parseWindow('30')).toBe(30)
    expect(U.parseWindow('90')).toBe(90)
    for (const v of ['1', '365', '7; DROP TABLE page_view', undefined, 'x']) expect(U.parseWindow(v)).toBe(7)
  })

  test('a fault is a 500 with no detail', async () => {
    const { call } = await setup(async () => { throw new Error('host 10.0.0.5 down') })
    const { reply } = await call(KEY, { query: {} })
    expect(reply.statusCode).toBe(500)
    expect(JSON.stringify(reply.body)).not.toMatch(/10\.0\.0\.5/)
  })
})
