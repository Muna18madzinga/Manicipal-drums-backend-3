/**
 * The server runs as a NON-superuser login (migration 168, scripts/create-runtime-role.js); the owner's connection string is for
 * migrations and scripts only.
 *
 *   APP_DATABASE_URL     the runtime login. When set, this process uses it for EVERY connection it makes (the main pool, the
 *                        survey pool, the LISTEN connection, the email worker) by taking over DATABASE_URL; the owner's value is
 *                        kept in OWNER_DATABASE_URL. Scripts do not load it, so they keep the owner.
 *   assertRuntimeRole    after connecting: a superuser (or a role that can create roles) is a warning, and in production a refusal,
 *                        unless ALLOW_SUPERUSER_DB=1 says it is intended.
 */
function adoptRuntimeUrl(env = process.env) {
  if (!env.APP_DATABASE_URL) return false
  if (env.DATABASE_URL && !env.OWNER_DATABASE_URL) env.OWNER_DATABASE_URL = env.DATABASE_URL
  env.DATABASE_URL = env.APP_DATABASE_URL
  return true
}

async function assertRuntimeRole(pool, { env = process.env, log = console } = {}) {
  const { rows } = await pool.query('SELECT current_user AS name, r.rolsuper, r.rolcreaterole FROM pg_roles r WHERE r.rolname = current_user')
  const me = rows[0]
  const risky = me && (me.rolsuper || me.rolcreaterole)
  if (!risky) { log.info({ role: me && me.name }, 'database role: not a superuser'); return { ok: true, role: me && me.name } }
  const message = `the application connects to the database as ${me.name}, ${me.rolsuper ? 'a superuser' : 'a role that can create roles'}: row-level security is bypassed for any code that does not use the tenant connection. Run scripts/create-runtime-role.js and set APP_DATABASE_URL.`
  if (env.NODE_ENV === 'production' && env.ALLOW_SUPERUSER_DB !== '1') throw new Error('[db] ' + message)
  log.warn({ role: me.name }, message)
  return { ok: false, role: me.name }
}

module.exports = { adoptRuntimeUrl, assertRuntimeRole }
