#!/usr/bin/env node
/**
 * Remove a throwaway test authority and everything it owns (its plans, their zone types, land
 * uses, decisions and history).
 *
 *   node scripts/remove-test-authority.js --code TESTCO            show what would go (nothing deleted)
 *   node scripts/remove-test-authority.js --code TESTCO --apply    delete it, in one transaction
 *
 * SAFETY: it refuses any authority whose code does not start with TEST or whose name does not
 * contain "(delete me)", and refuses one that still has permits, zone polygons or plans that
 * other plans were adopted from. A real authority can never be removed with this.
 */
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

const KNOWN = new Set(['--code', '--apply'])
const USAGE = 'Usage: --code <TESTCODE> [--apply]'
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1] }

async function main() {
  const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && !KNOWN.has(a))
  if (unknown.length) { console.error(`Unknown option(s): ${unknown.join(' ')}\n${USAGE}`); process.exit(2) }
  const code = arg('code') && arg('code').toUpperCase()
  if (!code) { console.error(USAGE); process.exit(2) }
  const apply = process.argv.includes('--apply')

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()
  try {
    const { rows: [a] } = await client.query('SELECT id, code, authority_name FROM local_authorities WHERE code = $1', [code])
    if (!a) throw new Error(`No authority with code ${code}.`)
    if (!/^TEST/.test(a.code) || !/\(delete me\)/i.test(a.authority_name)) {
      throw new Error(`Refusing: ${a.code} "${a.authority_name}" is not marked as a test authority (code starting TEST and "(delete me)" in the name).`)
    }
    const { rows: plans } = await client.query('SELECT id, title FROM plan_instrument WHERE authority_id = $1', [a.id])
    const ids = plans.map((p) => p.id)
    const count = async (sql, p = [ids]) => (await client.query(sql, p)).rows[0].n
    const permits = await count('SELECT COUNT(*)::int n FROM spatial_planning.permit_application WHERE authority_id = $1', [a.id])
    const polygons = ids.length ? await count('SELECT COUNT(*)::int n FROM proposed_peri_urban_zones WHERE plan_instrument_id = ANY($1::uuid[])') : 0
    const children = ids.length ? await count('SELECT COUNT(*)::int n FROM plan_instrument WHERE (derived_from_id = ANY($1::uuid[]) OR supersedes_id = ANY($1::uuid[])) AND NOT (id = ANY($1::uuid[]))') : 0
    const members = await count('SELECT COUNT(*)::int n FROM authority_member WHERE combination_id = $1 OR member_id = $1', [a.id])
    if (permits || polygons || children || members) {
      throw new Error(`Refusing: ${a.code} still has ${permits} permits, ${polygons} zone polygons, ${children} plans copied from its plans, ${members} authority memberships.`)
    }

    const decisions = ids.length ? await count('SELECT COUNT(*)::int n FROM zone_land_use_controls WHERE plan_instrument_id = ANY($1::uuid[])') : 0
    console.log(`${a.code} "${a.authority_name}": ${plans.length} plan(s) [${plans.map((p) => p.title).join('; ')}], ${decisions} decisions.`)
    if (!apply) { console.log('Nothing deleted. Add --apply to delete.'); return }

    await client.query('BEGIN')
    if (ids.length) {
      await client.query('DELETE FROM zone_land_use_controls WHERE plan_instrument_id = ANY($1::uuid[])', [ids])
      await client.query('DELETE FROM plan_zone_standard WHERE plan_zone_type_id IN (SELECT id FROM plan_zone_type WHERE plan_instrument_id = ANY($1::uuid[]))', [ids])
      await client.query('DELETE FROM land_use_groups WHERE plan_instrument_id = ANY($1::uuid[])', [ids])
      await client.query('DELETE FROM plan_instrument WHERE id = ANY($1::uuid[])', [ids])
    }
    await client.query('DELETE FROM local_authorities WHERE id = $1', [a.id])
    await client.query('COMMIT')
    console.log(`Deleted ${a.code} and its ${plans.length} plan(s).`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
