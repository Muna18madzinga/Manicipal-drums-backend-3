#!/usr/bin/env node
/**
 * Create (or rotate the password of) the NON-superuser login the server runs as, and write its connection string to a file.
 *
 *   node scripts/create-runtime-role.js                 dry run: says what it would do
 *   node scripts/create-runtime-role.js --apply         create the login `vungu_runtime`, write APP_DATABASE_URL to .env.runtime
 *   node scripts/create-runtime-role.js --apply --rotate    give an existing login a new password
 *   node scripts/create-runtime-role.js --check         connect as the runtime login and prove what it can and cannot do
 *
 * Run it with DATABASE_URL set to the OWNER (the account that runs migrations). The password is generated here, written only to
 * .env.runtime (git-ignored, mode 600 where the OS supports it) and never printed. Start the server with those variables
 * (`node --env-file=.env.runtime server.js`, or copy APP_DATABASE_URL into the host's environment): server.js then uses it for every
 * connection and keeps DATABASE_URL (the owner) for migrations and scripts only. See docs/TENANCY.md.
 */
require('dotenv').config({ quiet: true })
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Pool } = require('pg')

const LOGIN = process.env.RUNTIME_ROLE || 'vungu_runtime'
const OUT = path.join(__dirname, '..', '.env.runtime')
const args = new Set(process.argv.slice(2))

const urlFor = (user, password) => { const u = new URL(process.env.DATABASE_URL); u.username = user; u.password = password; return u.toString() }

async function check() {
  if (!fs.existsSync(OUT)) throw new Error('no .env.runtime: run with --apply first')
  const url = /^APP_DATABASE_URL=(.+)$/m.exec(fs.readFileSync(OUT, 'utf8'))[1].trim()
  const pool = new Pool({ connectionString: url })
  let bad = 0
  const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++ }
  const refused = async (label, sql) => { try { await pool.query(sql); ok(false, label + ' (it was allowed)') } catch (e) { ok(/permission denied|must be owner|must be superuser|only superusers/.test(e.message), label + ' -> ' + e.message.slice(0, 70)) } }
  try {
    const me = (await pool.query('select current_user u, r.rolsuper su, r.rolbypassrls bp, r.rolcreaterole cr, r.rolcreatedb cdb from pg_roles r where r.rolname = current_user')).rows[0]
    console.log(`connected as ${me.u}`)
    ok(!me.su, 'it is not a superuser'); ok(!me.cr, 'it cannot create roles')
    ok((await pool.query('select count(*)::int n from public.users')).rows[0].n >= 0, 'the system plane reads the data')
    ok((await pool.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema','pg_toast') and pg_get_userbyid(c.relowner)=current_user")).rows[0].n === 0, 'it owns no table, so it cannot ALTER or DROP any')
    await refused('it cannot change table structure', 'alter table public.users add column zz_probe int')
    await refused('it cannot create a role', 'create role zz_probe_role')
    await refused('it cannot read password hashes of database roles', 'select rolpassword from pg_authid limit 1')
    await refused('it cannot edit the tenancy contract', "update tenancy.relation_class set class = 'tenant' where false and relation = 'x'; delete from tenancy.relation_class where relation = 'zz'")
    const c = await pool.connect()
    try {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE vungu_app')
      const r = (await c.query("select current_user u, (select rolbypassrls from pg_roles where rolname = current_user) bp, app.authority_id() a")).rows[0]
      ok(r.u === 'vungu_app' && r.bp === false, 'it can step down to vungu_app, which cannot bypass row-level security')
      await c.query('ROLLBACK')
    } finally { c.release() }
  } finally { await pool.end() }
  console.log(bad ? `${bad} FAILED` : 'ALL OK'); process.exit(bad ? 1 : 0)
}

async function main() {
  if (args.has('--check')) return check()
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL (the owner) is required')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const owner = (await pool.query('select current_user u, (select rolsuper from pg_roles where rolname = current_user) su')).rows[0]
    const group = (await pool.query("select 1 from pg_roles where rolname = 'vungu_system'")).rowCount
    if (!group) throw new Error('role vungu_system is missing: run the migrations first (168)')
    const exists = (await pool.query('select 1 from pg_roles where rolname = $1', [LOGIN])).rowCount > 0
    console.log(`owner connection: ${owner.u}${owner.su ? ' (superuser)' : ''}; login ${LOGIN} ${exists ? 'exists' : 'does not exist'}`)
    if (!args.has('--apply')) { console.log(`dry run. With --apply this would ${exists ? (args.has('--rotate') ? 'give it a new password' : 'leave it alone (use --rotate for a new password)') : 'create it'} and write ${path.basename(OUT)}.`); return }
    if (exists && !args.has('--rotate')) { console.log('nothing to do (--rotate to change its password)'); return }
    const password = crypto.randomBytes(24).toString('base64url')
    const lit = (s) => "'" + s.replace(/'/g, "''") + "'"
    if (!exists) {
      await pool.query(`CREATE ROLE ${LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS INHERIT PASSWORD ${lit(password)}`)
      await pool.query(`GRANT vungu_system TO ${LOGIN}`)
      await pool.query(`GRANT vungu_app TO ${LOGIN}`)
    } else {
      await pool.query(`ALTER ROLE ${LOGIN} PASSWORD ${lit(password)}`)
    }
    fs.writeFileSync(OUT, `# written by scripts/create-runtime-role.js; secret, never commit\nAPP_DATABASE_URL=${urlFor(LOGIN, password)}\n`, { mode: 0o600 })
    console.log(`${exists ? 'rotated' : 'created'} ${LOGIN}; connection string written to ${path.basename(OUT)} (not printed).`)
    console.log('Next: node scripts/create-runtime-role.js --check')
  } finally { await pool.end() }
}

main().catch((e) => { console.error(e.message); process.exit(1) })
