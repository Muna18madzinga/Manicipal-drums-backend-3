#!/usr/bin/env node
/**
 * Make (or remove) the database login an authority's QGIS Desktop or QGIS Server uses (migration 166).
 *
 *   node scripts/create-authority-db-role.js --authority VUNGU                 a read-only login, dry run
 *   node scripts/create-authority-db-role.js --authority VUNGU --apply         create it and print its service entry
 *   node scripts/create-authority-db-role.js --authority VUNGU --author --apply   a login that may also edit the authority's zones
 *   node scripts/create-authority-db-role.js --authority VUNGU --drop --apply  remove it
 *   node scripts/create-authority-db-role.js --list                            the roles that exist
 *   node scripts/create-authority-db-role.js --sync                            make the reader's grants match the approved layers
 *
 * What the login can do is decided by the DATABASE, not by the QGIS project it opens: it sees the published layers whose rows are
 * safe to reach directly (national and reference data, and tenant data row-level security scopes to its authority), nothing
 * else, and cannot say it is another authority (its identity comes from the role). A read-only login also has
 * default_transaction_read_only set. An author login may insert, update and delete zone polygons (and what the zone triggers
 * maintain) of its own authority's plan only.
 *
 * The password is generated here and printed ONCE, in the pg_service entry to paste into the machine that runs QGIS. It is not
 * stored anywhere else, so keep the entry safe; to change it, drop the role and create it again. The QGIS project itself holds only
 * service='<name>' (no password), which is why each authority's project names its own service.
 */
const path = require('node:path')
const crypto = require('node:crypto')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

const KNOWN = new Set(['--authority', '--author', '--apply', '--drop', '--list', '--sync'])
const USAGE = 'Usage: --authority <code> [--author] [--drop] [--apply] | --list | --sync'
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) }

/** The login role for an authority: lower-case, letters, digits and underscores only. */
const roleFor = (code) => `authority_${String(code).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`

async function main() {
  const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && !KNOWN.has(a))
  if (unknown.length) { console.error(`Unknown option(s): ${unknown.join(' ')}\n${USAGE}`); process.exit(2) }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const q = async (s, a) => (await pool.query(s, a)).rows
  try {
    if (!(await q("SELECT to_regclass('tenancy.role_authority') AS t"))[0].t) throw new Error('Run migration 166 first.')
    if (process.argv.includes('--list')) {
      const rows = await q(`SELECT r.role_name, a.code, r.access, (SELECT rolcanlogin FROM pg_roles WHERE rolname = r.role_name) AS login
                              FROM tenancy.role_authority r JOIN local_authorities a ON a.id = r.authority_id ORDER BY 2, 1`)
      console.log(rows.length ? rows.map((r) => `${r.role_name.padEnd(28)} ${r.code.padEnd(10)} ${r.access.padEnd(7)} ${r.login ? '' : '(role missing)'}`).join('\n') : 'No direct-client roles.')
      return
    }
    if (process.argv.includes('--sync')) {
      const rows = await q('SELECT relation, action FROM tenancy.sync_published_grants()')
      console.log(rows.length ? rows.map((r) => `${r.relation}: ${r.action}`).join('\n') : 'The reader\'s grants already match the approved layers.')
      return
    }
    const code = arg('authority')
    if (typeof code !== 'string') { console.error(USAGE); process.exit(2) }
    const auth = (await q('SELECT id, code, kind FROM local_authorities WHERE code = $1', [code.toUpperCase()]))[0]
    if (!auth) throw new Error(`No authority with the code ${code}.`)
    if (auth.kind === 'combination') throw new Error(`${auth.code} is a combination authority: give its members their own logins.`)
    const role = roleFor(auth.code)
    const apply = process.argv.includes('--apply')
    const exists = (await q('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).length > 0

    if (process.argv.includes('--drop')) {
      console.log(exists ? `${role} would be removed.` : `${role} does not exist.`)
      if (apply && exists) {
        await pool.query('DELETE FROM tenancy.role_authority WHERE role_name = $1', [role])
        await pool.query(`DROP ROLE ${role}`)
        console.log('  removed.')
      } else if (exists) console.log('  (dry run: nothing changed; add --apply)')
      return
    }
    const access = process.argv.includes('--author') ? 'author' : 'read'
    if (exists) throw new Error(`${role} already exists. Drop it first to change its access or its password.`)
    console.log(`${role}: a ${access === 'author' ? 'READ AND ZONE-EDIT' : 'read-only'} login for ${auth.code}.`)
    if (!apply) { console.log('  (dry run: nothing created; add --apply)'); return }

    const password = crypto.randomBytes(18).toString('base64url')
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE CONNECTION LIMIT 10 IN ROLE ${access === 'author' ? 'tenancy_author' : 'tenancy_reader'}`)
      if (access === 'read') await c.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`)
      await c.query(`ALTER ROLE ${role} SET statement_timeout = '60s'`)
      await c.query('INSERT INTO tenancy.role_authority (role_name, authority_id, access) VALUES ($1, $2, $3)', [role, auth.id, access])
      await c.query('SELECT count(*) FROM tenancy.sync_published_grants()')
      await c.query('COMMIT')
    } catch (err) { await c.query('ROLLBACK').catch(() => {}); throw err } finally { c.release() }

    const u = new URL(process.env.DATABASE_URL)
    console.log('  created. Paste this into the pg_service.conf of the machine that runs QGIS (shown once):\n')
    console.log(`[${role}]\nhost=${u.hostname}\nport=${u.port || 5432}\ndbname=${u.pathname.replace(/^\//, '')}\nuser=${role}\npassword=${password}\nsslmode=prefer\n`)
    console.log(`  Then point that authority's QGIS project at service='${role}'.`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
