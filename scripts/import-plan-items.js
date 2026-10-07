#!/usr/bin/env node
/**
 * Bring chosen zone types and land uses from one plan into another.
 *
 *   node scripts/import-plan-items.js --target "Chipinge" --source "Rural profile v0: best-practice" \
 *        --zones "Mining and Quarrying,Wetland and Water Resource Protection" --uses "M1,N3"
 *
 * Copies the named items with their reference-class crosswalk and provenance. A code the
 * target already has is skipped, never overwritten. Decisions are NEVER copied: imported
 * items arrive "not decided", because what is permitted in them is for the target plan's own
 * instrument to say. To see what a palette would add, compare first:
 *   GET /api/plans/<a>/compare/<b>
 *
 *   --target / --source   plan id, or part of a plan or authority title (must match exactly one)
 *   --zones / --uses      comma-separated codes (at least one of the two)
 *   --rollback            run it and undo it, to check what would happen
 */
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

const KNOWN = new Set(['--target', '--source', '--zones', '--uses', '--rollback'])
const USAGE = 'Usage: --target <plan> --source <plan> [--zones "A,B"] [--uses "X,Y"] [--rollback]'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1] }
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])

async function resolve(client, value, label) {
  const { rows } = UUID.test(value)
    ? await client.query('SELECT id, title FROM plan_instrument WHERE id = $1', [value])
    : await client.query(
      `SELECT i.id, i.title FROM plan_instrument i LEFT JOIN local_authorities a ON a.id = i.authority_id
        WHERE i.title ILIKE $1 OR a.authority_name ILIKE $1 ORDER BY i.title`, [`%${value}%`])
  if (rows.length !== 1) throw new Error(rows.length ? `--${label} "${value}" matches ${rows.length} plans; use an id (node scripts/load-zoning-matrix.js --list)` : `No plan matches --${label} "${value}"`)
  return rows[0]
}

async function main() {
  const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && !KNOWN.has(a))
  if (unknown.length) { console.error(`Unknown option(s): ${unknown.join(' ')}\n${USAGE}`); process.exit(2) }
  const zones = list(arg('zones'))
  const uses = list(arg('uses'))
  if (!arg('target') || !arg('source') || (!zones.length && !uses.length)) { console.error(USAGE); process.exit(2) }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()
  try {
    const target = await resolve(client, arg('target'), 'target')
    const source = await resolve(client, arg('source'), 'source')
    await client.query('BEGIN')
    const { rows } = await client.query('SELECT * FROM import_plan_items($1, $2, $3::text[], $4::text[])', [target.id, source.id, zones, uses])
    console.log(`From "${source.title}" into "${target.title}":`)
    rows.forEach((r) => console.log(`  ${r.kind.padEnd(10)} ${r.code.padEnd(42)} ${r.outcome}`))
    if (process.argv.includes('--rollback')) {
      await client.query('ROLLBACK')
      console.log('Rolled back; nothing was kept.')
      return
    }
    await client.query('COMMIT')
    console.log(`${rows.filter((r) => r.outcome.startsWith('copied')).length} item(s) copied, without decisions.`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
