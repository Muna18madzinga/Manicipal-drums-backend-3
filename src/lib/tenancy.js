/**
 * Running a request's database work as the person making it, so the database (not the route)
 * decides which authority's rows they may see and write. See migration 154 and docs/TENANCY.md.
 *
 *   const db = tenantPool(fastify.pg, request.user)       // a drop-in for the pool, for this person
 *   const { rows } = await db.query('SELECT ...', [...])  // one statement, enforced
 *   const client = await db.connect()                     // a client for a multi-statement unit; db.connect
 *   ...                                                   //   hands back the client already scoped
 *   client.release()
 *
 * HOW. The connection steps into the vungu_app role (which cannot bypass row-level security) and
 * carries three settings the policies read: app.user_id, app.authority_id and app.platform. They are
 * set for the session and ALWAYS reset on release; if resetting fails the connection is destroyed
 * rather than returned to the pool carrying someone's identity.
 *
 * FAIL CLOSED. A person with no authority, no platform flag and no user (the public) gets settings
 * that show only what is public. If the vungu_app role does not exist the call throws: it never falls
 * back to the unrestricted connection.
 *
 * Only code that uses this is enforced. Code that still uses the plain pool connects as the owner and
 * bypasses row-level security, so converting a route is what protects it.
 */

const APP_ROLE = 'vungu_app'

/** The three settings for a person. A missing user is the public. */
function contextOf(user) {
  return {
    userId: user && user.id ? String(user.id) : '',
    authorityId: user && user.authority_id != null ? String(user.authority_id) : '',
    platform: !!(user && user.is_platform === true),
  }
}

async function apply(client, ctx) {
  await client.query(`SET ROLE ${APP_ROLE}`)
  await client.query(
    "SELECT set_config('app.user_id', $1, false), set_config('app.authority_id', $2, false), set_config('app.platform', $3, false)",
    [ctx.userId, ctx.authorityId, ctx.platform ? 'on' : ''])
}

async function clear(client) {
  await client.query('RESET ROLE')
  await client.query("SELECT set_config('app.user_id', '', false), set_config('app.authority_id', '', false), set_config('app.platform', '', false)")
}

/** A client from the pool, scoped to the person. Release it with release(); never keep it. */
async function acquire(pool, user) {
  const client = await pool.connect()
  try {
    await apply(client, contextOf(user))
  } catch (err) {
    client.release(true) // do not return a half-scoped connection to the pool
    throw err
  }
  const release = client.release.bind(client)
  client.release = async (destroy) => {
    if (destroy) return release(true)
    try {
      await client.query('ROLLBACK').catch(() => {})
      await clear(client)
      release()
    } catch (err) {
      release(true) // could not reset: throw the connection away
    }
  }
  return client
}

/** Run fn(client) as the person, then release. */
async function withTenant(pool, user, fn) {
  const client = await acquire(pool, user)
  try { return await fn(client) } finally { await client.release() }
}

/** A pool-shaped object for one person: query() for single statements, connect() for units of work. */
function tenantPool(pool, user) {
  return {
    query: (sql, params) => withTenant(pool, user, (c) => c.query(sql, params)),
    connect: () => acquire(pool, user),
  }
}

module.exports = { APP_ROLE, contextOf, acquire, withTenant, tenantPool }
