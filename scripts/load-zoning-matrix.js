#!/usr/bin/env node
/**
 * Load a plan's zoning permission matrix (zone_land_use_controls) from a CSV.
 *
 * Every command works inside ONE plan: its own zone types, its own land uses, its own
 * decisions. Pick it with --plan <id or part of the title>. Without --plan the rural
 * profile template is used (transitional, for the first sample matrix).
 *
 *   node scripts/load-zoning-matrix.js --plan "Chipinge" --template sheet.csv
 *       Write a blank CSV for that plan: every zone type x every land use, decisions empty.
 *
 *   node scripts/load-zoning-matrix.js --plan "Chipinge" --file sheet.csv
 *       Dry run (the default): validate and report what would change. Writes nothing.
 *
 *   node scripts/load-zoning-matrix.js --plan "Chipinge" --file sheet.csv --apply
 *       Do it, in one transaction: all rows are loaded or none are.
 *
 *   node scripts/load-zoning-matrix.js --plan "Chipinge" --file sheet.csv --apply --rollback
 *       Run the whole write, then undo it: proves an import would succeed and
 *       keeps nothing. (--rollback is only meaningful together with --apply.)
 *
 *   node scripts/load-zoning-matrix.js --list
 *       List the plans you can load into.
 *
 * A row's `zone` is one of the plan's zone types, or a zone polygon name in that plan.
 * Rows with a blank control_type are "undecided" (like a blank cell in the council's
 * matrix): reported, never loaded. See src/utils/zoningMatrixImport.js for the format.
 * Use scripts/adopt-plan-template.js to give an authority its own plan first.
 */
const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')
const { parseCsv, buildTemplate } = require('../src/utils/zoningMatrixImport')
const { loadPlanContext, analyse, applyCells } = require('../src/services/planMatrixImport')

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true)
}

const KNOWN_FLAGS = new Set(['--template', '--file', '--apply', '--rollback', '--local', '--plan', '--list'])
const USAGE = 'Usage: --list | [--plan <id|title>] --template <out.csv> [--local] | [--plan <id|title>] --file <in.csv> [--apply [--rollback]]'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The plan to work in: by id, by part of its title, or (no --plan) the rural template. */
async function resolvePlan(pool, value) {
  const base = `SELECT i.id, i.title, i.is_template, a.authority_name
                  FROM plan_instrument i LEFT JOIN local_authorities a ON a.id = i.authority_id`
  let rows
  if (value === null || value === true) {
    rows = (await pool.query(`${base} JOIN plan_profile p ON p.id = i.profile_id
                              WHERE i.is_default_template AND p.code = 'rural' LIMIT 1`)).rows
  } else if (UUID.test(value)) {
    rows = (await pool.query(`${base} WHERE i.id = $1`, [value])).rows
  } else {
    rows = (await pool.query(`${base} WHERE i.title ILIKE $1 OR a.authority_name ILIKE $1 ORDER BY i.title`, [`%${value}%`])).rows
  }
  if (rows.length === 0) throw new Error(`No plan matches "${value}". Run with --list to see the plans.`)
  if (rows.length > 1) {
    throw new Error(`"${value}" matches ${rows.length} plans; be more specific or use an id:\n` +
      rows.map((r) => `  ${r.id}  ${r.title}${r.authority_name ? ` (${r.authority_name})` : ' (template)'}`).join('\n'))
  }
  return rows[0]
}

async function main() {
  // A misspelt flag must never fall through to a real write.
  const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a))
  if (unknown.length) {
    console.error(`Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(' ')}`)
    console.error(USAGE)
    process.exit(2)
  }
  const template = arg('template')
  const file = arg('file')
  const planArg = arg('plan')
  const apply = process.argv.includes('--apply')
  const rollback = process.argv.includes('--rollback')
  const local = process.argv.includes('--local')
  if (rollback && !apply) { console.error('--rollback only applies together with --apply'); process.exit(2) }
  if (local && !template) { console.error('--local only applies together with --template'); process.exit(2) }
  if (!process.argv.includes('--list') && !template && !file) { console.error(USAGE); process.exit(2) }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    if (process.argv.includes('--list')) {
      const { rows } = await pool.query('SELECT * FROM plan_instrument_summary ORDER BY is_template DESC, title')
      for (const r of rows) {
        console.log(`${r.id}  ${r.is_template ? '[template]' : '[' + (r.authority_name || '-') + ']'}  ${r.title}  (${r.zone_types} zone types, ${r.land_uses} land uses, ${r.decisions} decisions)`)
      }
      return
    }

    const plan = await resolvePlan(pool, planArg)
    const ctx = await loadPlanContext(pool, plan.id)
    const { zoneTypes, groups, zones } = ctx

    console.log(`Plan: ${plan.title} ${plan.is_template ? '(template)' : `(${plan.authority_name})`}`)
    if (planArg === null) console.log('  (no --plan given: using the rural profile template)')

    if (template) {
      const out = typeof template === 'string' ? template : 'zoning-matrix-template.csv'
      const level = local ? 'local' : 'plan'
      fs.writeFileSync(out, buildTemplate({ zones, zoneTypes, groups, level }))
      const nZones = level === 'plan' ? zoneTypes.length : new Set(zones.map((z) => z.zone)).size
      console.log(`Wrote ${out}: ${nZones} ${level === 'plan' ? 'zone types' : 'local zone names'} x ${groups.filter((g) => g.is_active).length} land uses.`)
      console.log('Fill in control_type (permitted | special_consent | prohibited, or P | SC | X);')
      console.log('leave blank anything not yet decided.')
      return
    }

    const plan_ = analyse(ctx, fs.readFileSync(file, 'utf8'))
    const s = plan_.summary

    console.log(`\nZoning matrix import — ${apply ? (rollback ? 'APPLY then ROLL BACK (test)' : 'APPLY') : 'dry run (nothing is written)'}`)
    console.log(`  CSV rows        ${s.rows}`)
    console.log(`  cells to load   ${s.cells}  (insert ${s.inserts}, update ${s.updates}, unchanged ${s.unchanged})`)
    console.log(`  undecided rows  ${s.undecided}  (blank control_type — skipped)`)
    console.log(`  errors          ${s.errors}`)
    plan_.errors.forEach((e) => console.log(`    ✗ ${e}`))

    console.log('\nCoverage (decisions per zone named in the CSV, of the plan\'s active land uses):')
    for (const c of plan_.coverage) {
      const where = c.kind === 'zone' ? `  (${c.polygons} polygon${c.polygons === 1 ? '' : 's'})` : ''
      const missing = c.missing.length ? `  no decision: ${c.missing.join(',')}` : ''
      console.log(`  ${c.zone.padEnd(40)} ${String(c.decided).padStart(2)}/${c.decided + c.missing.length}${where}${missing}`)
    }

    if (plan_.errors.length) {
      console.log('\nNot loading: fix the errors above first.')
      process.exit(1)
    }
    if (!apply) {
      console.log('\nDry run only. Re-run with --apply to write these changes.')
      return
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await applyCells(client, plan_.cells)
      if (rollback) {
        const { rows: [n] } = await client.query('SELECT COUNT(*)::int AS n FROM zone_land_use_controls WHERE plan_instrument_id = $1 AND deleted_at IS NULL', [plan.id])
        await client.query('ROLLBACK')
        console.log(`\nTest import wrote ${s.inserts + s.updates} cells (the plan held ${n.n} decisions inside the transaction), then rolled back. Nothing was kept.`)
        return
      }
      await client.query('COMMIT')
      console.log(`\nLoaded ${s.inserts + s.updates} cells into "${plan.title}" (${s.unchanged} already up to date).`)
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
