/**
 * A seed or verification script is the system speaking, and tenant data must say whose it is: an insert into a tenant table with no
 * authority is refused (tenancy.make_tenant, migration 167) rather than guessed. This tells every connection a pool opens which
 * authority the script is acting for, so its inserts land in that authority's rows without each statement naming it.
 *
 *   const pool = new Pool({ connectionString })
 *   await seedAuthority(pool)            // the authority named by SEED_AUTHORITY_CODE, default VUNGU
 *   await seedAuthority(pool, 'TESTCO')
 *
 * It works through the connection's startup options, so it covers every client the pool opens afterwards and the lookup itself is
 * made on a throwaway pool (a client opened before the setting would not have it). Returns the authority id.
 */
const { Pool } = require('pg')

async function seedAuthority(pool, code = process.env.SEED_AUTHORITY_CODE || 'VUNGU') {
  const lookup = new Pool({ ...pool.options, max: 1 })
  let id
  try {
    const { rows } = await lookup.query('SELECT id FROM public.local_authorities WHERE code = $1', [code])
    if (!rows[0]) throw new Error(`seedAuthority: ${code} is not an authority in this database`)
    id = rows[0].id
  } finally {
    await lookup.end()
  }
  pool.options.options = `${pool.options.options ? pool.options.options + ' ' : ''}-c app.authority_id=${id}`
  return id
}

module.exports = { seedAuthority }
