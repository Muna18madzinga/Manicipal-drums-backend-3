#!/usr/bin/env node
/**
 * Does the database keep the tenancy contract (migration 165, docs/TENANCY.md)?
 *
 *   node scripts/verify-tenancy.js          check, and list any departure
 *   node scripts/verify-tenancy.js --debt   also list every authority-owned relation that still has no row-level security
 *
 * Fails (exit 1) if:
 *   - any relation is unclassified (a new table must be classified before it ships: tenancy.classify);
 *   - a tenant relation lacks row-level security or a policy, a tenant view is not security_invoker, a reference or national
 *     relation is writable by the application role, or a sensitive or system relation is accessible to it;
 *   - new objects are granted to the application role automatically (default privileges);
 *   - the application role is a superuser or can bypass row-level security;
 *   - the DEBT (authority-owned relations without row-level security) has GROWN past DEBT_BASELINE. It may only go down. When
 *     it does, lower DEBT_BASELINE in this file in the same change, so it cannot creep back.
 *
 * It also says, as information, whether the application itself connects as a superuser (then row-level security is bypassed
 * everywhere except where a route opts in): that is the last step of the contract and is tracked in docs/TENANCY.md.
 */
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

// The number of authority-owned relations still without row-level security, 9 October 2026, after council_ops (a fresh build has 108; the development database, which is behind the migrations, 94). Lower it as they are protected.
const DEBT_BASELINE = 108

let failures = 0
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failures++ }

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const q = async (s, a) => (await pool.query(s, a)).rows
  try {
    console.log('== the tenancy contract')
    const hasGuard = (await q("SELECT to_regclass('tenancy.violations') AS t"))[0].t
    if (!hasGuard) { check(false, 'tenancy.violations does not exist: run migration 165'); return }

    const v = await q('SELECT relation, class, rule, detail FROM tenancy.violations ORDER BY rule, relation')
    check(v.length === 0, v.length ? `${v.length} departure(s) from the contract` : 'no relation departs from the rules of its class')
    for (const x of v.slice(0, 80)) console.log(`        ${x.rule.padEnd(20)} ${x.relation}  (${x.class}): ${x.detail}`)
    if (v.length > 80) console.log(`        ... and ${v.length - 80} more`)

    const role = (await q("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'vungu_app'"))[0]
    if (role) check(role.rolsuper === false && role.rolbypassrls === false, 'the application role is neither a superuser nor able to bypass row-level security')
    else console.log('  info  no vungu_app role in this database')

    const sys = (await q("SELECT rolname, rolsuper, rolcreaterole FROM pg_roles WHERE rolname IN ('vungu_system','vungu_runtime')"))
    for (const r of sys) check(!r.rolsuper && !r.rolcreaterole, `${r.rolname} is not a superuser and cannot create roles`)
    if (!sys.length) console.log('  info  no runtime role yet (migration 168; scripts/create-runtime-role.js)')

    const debt = await q('SELECT schema, relations, names FROM tenancy.debt ORDER BY schema')
    const total = debt.reduce((n, d) => n + d.relations, 0)
    check(total <= DEBT_BASELINE, `authority-owned relations without row-level security: ${total} (baseline ${DEBT_BASELINE})`)
    if (process.argv.includes('--debt')) for (const d of debt) console.log(`        ${d.schema} (${d.relations}): ${d.names}`)
    else console.log('        ' + debt.map((d) => `${d.schema} ${d.relations}`).join(', ') + '   (--debt lists them)')

    const me = (await q('SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su'))[0]
    console.log(`  info  this connection is ${me.u}${me.su ? ', a SUPERUSER: row-level security is bypassed for any code that does not use the tenant pool' : ''}`)
  } finally {
    await pool.end()
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
