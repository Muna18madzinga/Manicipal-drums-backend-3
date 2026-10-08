/**
 * A stand-in for the pg pool that also answers the tenancy helper (src/lib/tenancy.js).
 *
 * Route tests assert on the SQL their route sends (`pg.query` calls). The tenancy helper wraps every
 * request in connection set-up (SET ROLE, set_config, ROLLBACK, RESET ROLE); those control statements
 * are answered here and NOT recorded, so a test still sees exactly the route's own statements, and
 * `scopedAs` records who each statement ran as.
 */
function isControl(sql) {
  return typeof sql === 'string' && /^\s*(SET ROLE|RESET ROLE|ROLLBACK|SELECT set_config\('app\.user_id')/i.test(sql)
}

function makePg(queryImpl) {
  const calls = []   // { sql, params }
  const query = jest.fn(async (sql, params) => queryImpl(sql, params))
  const log = []      // control statements, for tests of the helper itself
  const makeClient = () => ({
    query: async (sql, params) => {
      if (isControl(sql)) { log.push({ sql, params }); return { rows: [], rowCount: 0 } }
      calls.push({ sql, params })
      return params === undefined ? query(sql) : query(sql, params)
    },
    release: jest.fn(),
  })
  const pg = {
    query,
    connect: jest.fn(async () => makeClient()),
  }
  return { pg, calls, log }
}

module.exports = { makePg, isControl }
