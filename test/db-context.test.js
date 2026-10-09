const { modeOf, runWithRequest, setUser, inRequest, currentUser, systemOf, install } = require('../src/lib/dbContext')

// A pool that records every statement and who it ran as (the role and settings the tenancy helper sets).
function recordingPg() {
  const log = []
  const makeClient = () => {
    const state = { role: null, user: '', authority: '', platform: '' }
    return {
      query: jest.fn(async (sql, params) => {
        const s = String(sql)
        if (/^SET ROLE/.test(s)) { state.role = s.split(' ')[2]; return { rows: [] } }
        if (/^RESET ROLE/.test(s)) { state.role = null; return { rows: [] } }
        if (/set_config\('app\.user_id', \$1/.test(s)) { [state.user, state.authority, state.platform] = params; return { rows: [] } }
        if (/set_config\('app\.user_id', ''/.test(s)) { state.user = state.authority = state.platform = ''; return { rows: [] } }
        if (/^ROLLBACK|^BEGIN|^COMMIT/.test(s)) return { rows: [] }
        log.push({ sql: s, as: state.role, user: state.user, authority: state.authority })
        return { rows: [{ ok: 1 }] }
      }),
      release: jest.fn(),
    }
  }
  const pg = {
    query: jest.fn(async (sql, params) => { log.push({ sql: String(sql), as: 'OWNER' }); return { rows: [{ ok: 1 }] } }),
    connect: jest.fn(async () => makeClient()),
    transact: undefined, pool: { name: 'the raw pool' }, Client: function Client() {},
  }
  return { pg, log }
}
const fastifyOf = (pg) => ({ pg, log: { warn: jest.fn() }, decorate() {} })

describe('the mode', () => {
  test('is off unless asked, and ignores nonsense', () => {
    expect(modeOf({})).toBe('off')
    expect(modeOf({ TENANCY_MODE: 'STRICT' })).toBe('strict')
    expect(modeOf({ TENANCY_MODE: ' warn ' })).toBe('warn')
    expect(modeOf({ TENANCY_MODE: 'yolo' })).toBe('off')
  })
})

describe('off: nothing changes', () => {
  test('fastify.pg stays the plain pool, and gains a system connection that is the same one', async () => {
    const { pg, log } = recordingPg()
    const original = pg.query
    install(fastifyOf(pg), { mode: 'off' })
    expect(pg.query).toBe(original)
    await runWithRequest(async () => { setUser({ id: 'u1', authority_id: 2 }); await pg.query('SELECT 1') })
    expect(log[0].as).toBe('OWNER')
    expect(systemOf(pg)).toBe(pg.system)
  })
  test('systemOf of a plain pool or a test double is itself', () => {
    const plain = { query() {} }
    expect(systemOf(plain)).toBe(plain)
    expect(systemOf(undefined)).toBeUndefined()
  })
})

describe('warn and strict: inside a request the connection is the person', () => {
  for (const mode of ['warn', 'strict']) {
    test(`${mode}: a query runs as vungu_app with the person's authority`, async () => {
      const { pg, log } = recordingPg()
      install(fastifyOf(pg), { mode })
      await runWithRequest(async () => {
        setUser({ id: 'u1', authority_id: 7 })
        await pg.query('SELECT 1')
      })
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ as: 'vungu_app', user: 'u1', authority: '7' })
    })

    test(`${mode}: before anyone has authenticated the request is the public`, async () => {
      const { pg, log } = recordingPg()
      install(fastifyOf(pg), { mode })
      await runWithRequest(async () => { await pg.query('SELECT 1') })
      expect(log[0]).toMatchObject({ as: 'vungu_app', user: '', authority: '' })
    })

    test(`${mode}: concurrent requests keep their own identity`, async () => {
      const { pg, log } = recordingPg()
      install(fastifyOf(pg), { mode })
      const one = (id, authority, ms) => runWithRequest(async () => {
        setUser({ id, authority_id: authority })
        await new Promise((r) => setTimeout(r, ms))
        await pg.query(`SELECT '${id}'`)
      })
      await Promise.all([one('a', 1, 20), one('b', 2, 5), one('c', 3, 10)])
      const by = Object.fromEntries(log.map((l) => [l.sql.match(/'(\w)'/)[1], l.authority]))
      expect(by).toEqual({ a: '1', b: '2', c: '3' })
    })

    test(`${mode}: the system connection is still unscoped, on purpose`, async () => {
      const { pg, log } = recordingPg()
      install(fastifyOf(pg), { mode })
      await runWithRequest(async () => { setUser({ id: 'u1', authority_id: 7 }); await systemOf(pg).query('SELECT sys') })
      expect(log[0].as).toBe('OWNER')
    })

    test(`${mode}: transact runs every statement as the person, and commits`, async () => {
      const { pg, log } = recordingPg()
      install(fastifyOf(pg), { mode })
      await runWithRequest(async () => {
        setUser({ id: 'u1', authority_id: 4 })
        await pg.transact(async (c) => { await c.query('INSERT 1'); await c.query('INSERT 2') })
      })
      expect(log.map((l) => [l.sql, l.as, l.authority])).toEqual([['INSERT 1', 'vungu_app', '4'], ['INSERT 2', 'vungu_app', '4']])
    })
  }
})

describe('outside a request', () => {
  test('warn: unscoped, and says so once per place', async () => {
    const { pg, log } = recordingPg()
    const f = fastifyOf(pg)
    install(f, { mode: 'warn' })
    await pg.query('SELECT 1'); await pg.query('SELECT 2')
    expect(log.every((l) => l.as === 'OWNER')).toBe(true)
    expect(f.log.warn.mock.calls.length).toBeLessThanOrEqual(2)
    expect(f.log.warn.mock.calls[0][1]).toMatch(/systemOf/)
  })
  test('strict: it throws, naming the way out', () => {
    const { pg } = recordingPg()
    install(fastifyOf(pg), { mode: 'strict' })
    expect(() => pg.query('SELECT 1')).toThrow(/outside a request.*systemOf/)
    expect(() => pg.connect()).toThrow(/outside a request/)
  })
  test('strict: the raw pool refuses, the system pool does not', () => {
    const { pg } = recordingPg()
    install(fastifyOf(pg), { mode: 'strict' })
    expect(() => pg.pool.query('SELECT 1')).toThrow(/unscoped/)
    expect(systemOf(pg).pool).toEqual({ name: 'the raw pool' })
  })
})

describe('the request store', () => {
  test('is closed outside a request and holds the person inside one', async () => {
    expect(inRequest()).toBe(false)
    setUser({ id: 'ignored' })              // no store: nothing happens
    expect(currentUser()).toBeNull()
    await runWithRequest(async () => {
      expect(inRequest()).toBe(true)
      expect(currentUser()).toBeNull()
      setUser({ id: 'u9' })
      await Promise.resolve()
      expect(currentUser().id).toBe('u9')
      setUser(undefined)
      expect(currentUser()).toBeNull()
    })
  })
  test('installing twice does nothing the second time', () => {
    const { pg } = recordingPg()
    install(fastifyOf(pg), { mode: 'warn' })
    const q = pg.query
    expect(install(fastifyOf(pg), { mode: 'strict' }).mode).toBe('warn')
    expect(pg.query).toBe(q)
  })
})
