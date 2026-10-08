jest.mock('../src/middleware/jwtAuth', () => ({ requireAuth: () => async () => {}, requireRole: (_f, roles) => Object.assign(async () => {}, { roles }) }))
const { makePg } = require('./helpers/fakePg')
jest.mock('../src/services/planMatrixImport', () => ({ importCsv: jest.fn() }))

const { planWorkbenchRoutes, ruleRefusal } = require('../src/routes/planWorkbench')
const { importCsv } = require('../src/services/planMatrixImport')

const PLAN = '4c98ad9f-d0bd-4360-864b-af54cef9d08f'
const USER = { id: 'u1', role: 'planner', name: 'P. Lanner', email: 'p@x', authority_id: 1 }
const PLATFORM = { ...USER, role: 'admin', is_platform: true }

function makeServer(queryImpl) {
  const routes = {}
  const reg = (verb) => (path, ...rest) => { routes[`${verb} ${path}`] = { handler: rest[rest.length - 1], opts: rest.length > 1 ? rest[0] : {} } }
  const fake = makePg(queryImpl)
  const client = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() }
  // db(request) goes through the tenancy helper (fake.pg.connect); the platform-only add-authority route uses the same pool.
  const server = { pg: fake.pg, log: { error() {} }, get: reg('GET'), post: reg('POST') }
  const call = async (key, request) => {
    const reply = { statusCode: 200, body: null }
    reply.code = (c) => { reply.statusCode = c; return reply }
    reply.send = (b) => { reply.body = b; return reply }
    await routes[key].handler({ query: {}, params: {}, body: {}, user: USER, log: { error() {} }, ...request }, reply)
    return { reply }
  }
  return { server, call, routes, client }
}
const setup = async (impl) => { const s = makeServer(impl); await planWorkbenchRoutes(s.server); return s }
const planExists = (extra) => async (sql, params) => {
  if (/FROM plan_instrument WHERE id = \$1/.test(sql)) return { rows: [{ id: PLAN, is_template: false, status: 'draft' }] }
  return extra ? extra(sql, params) : { rows: [] }
}

describe('who may do what', () => {
  test('writes are for admin and planner; adding an authority is admin only; reads include clerks', async () => {
    const { routes } = await setup(async () => ({ rows: [] }))
    expect(routes['POST /workbench/plans/:id/status'].opts.preHandler.roles).toEqual(['admin', 'planner'])
    expect(routes['POST /workbench/plans/:id/signoff'].opts.preHandler.roles).toEqual(['admin', 'planner'])
    expect(routes['POST /workbench/plans/:id/matrix/import'].opts.preHandler.roles).toEqual(['admin', 'planner'])
    expect(routes['POST /workbench/authorities'].opts.preHandler.roles).toEqual(['admin'])
    expect(routes['GET /workbench/plans'].opts.preHandler.roles).toContain('planning_clerk')
    expect(routes['GET /workbench/plans'].opts.preHandler.roles).not.toContain('public')
  })
})

describe('database rules become readable refusals', () => {
  test('a row-level-security refusal says it belongs to another authority, without the policy text', () => {
    expect(ruleRefusal({ code: '42501', message: 'new row violates row-level security policy for table "plan_instrument"' })).toEqual({ status: 403, message: 'That belongs to another authority.' })
  })
  test('check violations and our own messages are 409 with the message', () => {
    expect(ruleRefusal({ code: '23514', message: 'this plan is approved and cannot be edited' })).toEqual({ status: 409, message: 'this plan is approved and cannot be edited' })
    expect(ruleRefusal({ code: 'P0001', message: 'a template has no status to change' }).status).toBe(409)
    expect(ruleRefusal({ code: '23505', message: 'duplicate key ... detail' }).message).toBe('That already exists.')
  })
  test('anything else is not shown to the client', () => {
    expect(ruleRefusal({ code: '08006', message: 'connection to 10.0.0.5 failed' })).toBeNull()
    expect(ruleRefusal({ code: 'P0001', message: 'division by zero' })).toBeNull()
  })
  test('a rule refusal on a status change is a 409; a fault is a 500 without detail', async () => {
    const refuse = await setup(planExists(async () => { throw Object.assign(new Error('approval needs a current sign-off'), { code: '23514' }) }))
    const r1 = await refuse.call('POST /workbench/plans/:id/status', { params: { id: PLAN }, body: { status: 'approved' } })
    expect(r1.reply.statusCode).toBe(409)
    expect(r1.reply.body.message).toMatch(/current sign-off/)
    const broken = await setup(planExists(async () => { throw new Error('host 10.0.0.5 down') }))
    const r2 = await broken.call('POST /workbench/plans/:id/status', { params: { id: PLAN }, body: { status: 'approved' } })
    expect(r2.reply.statusCode).toBe(500)
    expect(JSON.stringify(r2.reply.body)).not.toMatch(/10\.0\.0\.5/)
  })
})

describe('input validation (nothing reaches the database when it is wrong)', () => {
  test('a bad plan id is a 400 and an unknown plan a 404', async () => {
    const { call, server } = await setup(async () => ({ rows: [] }))
    expect((await call('POST /workbench/plans/:id/status', { params: { id: 'x' }, body: { status: 'draft' } })).reply.statusCode).toBe(400)
    expect(server.pg.query).not.toHaveBeenCalled()
    expect((await call('POST /workbench/plans/:id/status', { params: { id: PLAN }, body: { status: 'draft' } })).reply.statusCode).toBe(404)
  })
  test('status needs a string; dates and gazette references are checked', async () => {
    const { call } = await setup(planExists())
    expect((await call('POST /workbench/plans/:id/status', { params: { id: PLAN }, body: {} })).reply.statusCode).toBe(400)
    expect((await call('POST /workbench/plans/:id/status', { params: { id: PLAN }, body: { status: 'gazetted', effective_from: '1 June' } })).reply.statusCode).toBe(400)
    expect((await call('POST /workbench/plans/:id/status', { params: { id: PLAN }, body: { status: 'gazetted', gazette_ref: 'x'.repeat(300) } })).reply.statusCode).toBe(400)
  })
  test("adding an authority is for the platform operator, not an authority's own administrator", async () => {
    const { call, server } = await setup(async () => ({ rows: [] }))
    const { reply } = await call('POST /workbench/authorities', { body: { code: 'CHIP', name: 'Chipinge', kind: 'rural' }, user: { ...USER, role: 'admin' } })
    expect(reply.statusCode).toBe(403)
    expect(reply.body.error).toBe('platform_only')
    expect(server.pg.connect).not.toHaveBeenCalled()
  })

  test('adding an authority validates code, name, kind and members', async () => {
    const { call, server } = await setup(async () => ({ rows: [] }))
    const post = (body) => call('POST /workbench/authorities', { body, user: PLATFORM })
    expect((await post({ code: "x'; --", name: 'N', kind: 'rural' })).reply.statusCode).toBe(400)
    expect((await post({ code: 'CHIP', name: '', kind: 'rural' })).reply.statusCode).toBe(400)
    expect((await post({ code: 'CHIP', name: 'Chipinge', kind: 'suburban' })).reply.statusCode).toBe(400)
    expect((await post({ code: 'CMB', name: 'Combo', kind: 'combination', members: ['ONE'] })).reply.statusCode).toBe(400)
    expect((await post({ code: 'CHIP', name: 'Chipinge', kind: 'rural', members: ['ONE'] })).reply.statusCode).toBe(400)
    expect(server.pg.connect).not.toHaveBeenCalled()
  })
  test('adopting needs an integer authority, a title, a known plan type and profile', async () => {
    const { call, server } = await setup(async () => ({ rows: [] }))
    const post = (body) => call('POST /workbench/plans/adopt', { body })
    expect((await post({ authority_id: '1', title: 'T' })).reply.statusCode).toBe(400)
    expect((await post({ authority_id: 1, title: ' ' })).reply.statusCode).toBe(400)
    expect((await post({ authority_id: 1, title: 'T', plan_type: 'bogus' })).reply.statusCode).toBe(400)
    expect((await post({ authority_id: 1, title: 'T', profile: 'suburban' })).reply.statusCode).toBe(400)
    expect((await post({ authority_id: 1, title: 'T', template_id: 'nope' })).reply.statusCode).toBe(400)
    expect(server.pg.query).not.toHaveBeenCalled()
  })
})

describe('matrix import', () => {
  test('is a dry run unless apply is exactly true', async () => {
    importCsv.mockReset()
    importCsv.mockResolvedValue({ applied: false, plan: {}, summary: {}, errors: [], coverage: [] })
    const { call } = await setup(planExists())
    await call('POST /workbench/plans/:id/matrix/import', { params: { id: PLAN }, body: { csv: 'zone,group_code,control_type\n' } })
    expect(importCsv.mock.calls[0][3].apply).toBe(false)
    await call('POST /workbench/plans/:id/matrix/import', { params: { id: PLAN }, body: { csv: 'zone,group_code,control_type\n', apply: true } })
    expect(importCsv.mock.calls[1][3].apply).toBe(true)
    expect(importCsv.mock.calls[1][3].actor).toEqual(USER)
    const bad = await call('POST /workbench/plans/:id/matrix/import', { params: { id: PLAN }, body: { csv: 'x', apply: 'yes' } })
    expect(bad.reply.statusCode).toBe(400)
  })
  test('needs a CSV and refuses an enormous one', async () => {
    const { call } = await setup(planExists())
    expect((await call('POST /workbench/plans/:id/matrix/import', { params: { id: PLAN }, body: {} })).reply.statusCode).toBe(400)
    expect((await call('POST /workbench/plans/:id/matrix/import', { params: { id: PLAN }, body: { csv: 'x'.repeat(1_000_001) } })).reply.statusCode).toBe(413)
  })
  test('a frozen plan is a readable 409', async () => {
    importCsv.mockReset()
    importCsv.mockRejectedValue(Object.assign(new Error('this plan is approved and cannot be edited: create a new version instead'), { code: '23514' }))
    const { call } = await setup(planExists())
    const { reply } = await call('POST /workbench/plans/:id/matrix/import', { params: { id: PLAN }, body: { csv: 'a', apply: true } })
    expect(reply.statusCode).toBe(409)
    expect(reply.body.message).toMatch(/create a new version/)
  })
})

describe('sign-off is attributed to the signed-in user', () => {
  test('uses the user, not anything in the body', async () => {
    const { call, server } = await setup(planExists(async () => ({ rows: [{ id: 'so-1' }] })))
    const { reply } = await call('POST /workbench/plans/:id/signoff', { params: { id: PLAN }, body: { comment: 'ok', signer: 'Someone Else' } })
    expect(reply.statusCode).toBe(201)
    const call2 = server.pg.query.mock.calls.find(([sql]) => /sign_off_plan/.test(sql))
    expect(call2[1]).toEqual([PLAN, 'u1', 'P. Lanner', 'planner', 'ok'])
  })
})
