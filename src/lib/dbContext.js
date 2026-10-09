/**
 * The application's own database connection, made to follow the person asking (the last step of the tenancy contract,
 * docs/TENANCY.md).
 *
 * Until now a route had to REMEMBER to scope its queries (src/lib/tenancy.js tenantPool); one that forgot ran as the database
 * owner and saw every authority's rows. This module reverses the default. Once installed in a mode other than 'off':
 *
 *   fastify.pg.query / .connect / .transact   run AS THE PERSON making the current request (or as the public if there is none),
 *                                             through the same vungu_app role and settings tenantPool uses;
 *   systemOf(fastify.pg)                      is the unscoped connection, for work that is genuinely the system's: signing
 *                                             someone in, the audit log, notifications, background jobs. It is explicit, greppable
 *                                             and the short list reviewed by hand (scripts/tenancy-route-audit.js).
 *
 * MODES (TENANCY_MODE)
 *   off     (default) nothing changes: fastify.pg is the plain pool. Safe to ship.
 *   warn    inside a request fastify.pg is scoped; outside one (a job, startup) it is unscoped and says so in the log, so the
 *           places that need systemOf can be found without breaking anything.
 *   strict  as warn, but database access outside a request through fastify.pg throws: the system must say so.
 *
 * WHO IS ASKING. An AsyncLocalStorage store is opened for every request (the onRequest hook) and the authentication step puts the
 * person in it (setUser). Until authentication has run, or on a route that does not authenticate, the person is the public.
 * Code that runs outside any request has no store.
 *
 * Services that are system actions by nature (notifications, the audit log, login security) take whatever pool they are handed and
 * elevate with systemOf themselves, so a tenant route that calls them does not change.
 */
const { AsyncLocalStorage } = require('node:async_hooks')
const { tenantPool } = require('./tenancy')

const als = new AsyncLocalStorage()
const MODES = ['off', 'warn', 'strict']

const modeOf = (env = process.env) => {
  const m = String(env.TENANCY_MODE || 'off').trim().toLowerCase()
  return MODES.includes(m) ? m : 'off'
}

/** Open the store for one request. Use as the body of an onRequest hook: runWithRequest(done). */
function runWithRequest(fn) { return als.run({ user: undefined }, fn) }

/** The authentication step says who the request is from. null is the public. */
function setUser(user) { const s = als.getStore(); if (s) s.user = user || null }

const inRequest = () => !!als.getStore()
const currentUser = () => { const s = als.getStore(); return s ? (s.user || null) : null }

/** The unscoped connection behind a (possibly scoped) pg decoration. A plain pool, or a test double, is its own system connection. */
const systemOf = (pg) => (pg && pg.system ? pg.system : pg)

/**
 * Make fastify.pg follow the person asking, according to the mode. Call once, after @fastify/postgres is registered and before any
 * route is. Returns { mode }. In 'off' it only adds pg.system (the same plain connection) so systemOf works everywhere.
 */
function install(fastify, { mode = modeOf(), log = fastify.log } = {}) {
  const pg = fastify.pg
  if (!pg) throw new Error('install the contextual pool after @fastify/postgres')
  if (pg.system) return { mode: pg.tenancyMode }
  const system = {
    query: pg.query.bind(pg),
    connect: pg.connect.bind(pg),
    transact: typeof pg.transact === 'function' ? pg.transact.bind(pg) : undefined,
    pool: pg.pool,
    Client: pg.Client,
  }
  pg.system = system
  pg.tenancyMode = mode
  if (mode === 'off') return { mode }

  const seen = new Set()
  const scoped = (what) => {
    const store = als.getStore()
    if (!store) {
      if (mode === 'strict') throw new Error(`database access outside a request (${what}): use systemOf(fastify.pg) for system work`)
      const where = (new Error().stack || '').split('\n').find((l) => l.includes('/src/') && !l.includes('dbContext')) || 'unknown'
      if (!seen.has(where)) { seen.add(where); log.warn({ where: where.trim() }, 'tenancy: database access outside a request is unscoped; use systemOf(fastify.pg) if that is intended') }
      return null
    }
    return tenantPool(system, store.user || null)
  }

  pg.query = (sql, params) => { const t = scoped('query'); return t ? t.query(sql, params) : system.query(sql, params) }
  pg.connect = (...args) => { const t = scoped('connect'); return t ? t.connect() : system.connect(...args) }
  pg.transact = async (fn) => {
    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      await client.release()
    }
  }
  // the raw pool would bypass the context: in strict mode it refuses
  if (mode === 'strict') {
    const refuse = () => { throw new Error('fastify.pg.pool is unscoped: use fastify.pg.query, or systemOf(fastify.pg).pool for system work') }
    pg.pool = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : refuse()) })
  }
  return { mode }
}

module.exports = { modeOf, runWithRequest, setUser, inRequest, currentUser, systemOf, install, MODES }
