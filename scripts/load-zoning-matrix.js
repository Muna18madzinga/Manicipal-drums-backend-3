#!/usr/bin/env node
/**
 * Load the zoning permission matrix (zone_land_use_controls) from a CSV.
 *
 *   node scripts/load-zoning-matrix.js --template zoning-matrix-template.csv
 *       Write a blank CSV: every zone type x every land-use group, decisions empty.
 *
 *   node scripts/load-zoning-matrix.js --file zoning-matrix.csv
 *       Dry run (the default): validate and report what would change. Writes nothing.
 *
 *   node scripts/load-zoning-matrix.js --file zoning-matrix.csv --apply
 *       Do it, in one transaction: all rows are loaded or none are.
 *
 *   node scripts/load-zoning-matrix.js --file zoning-matrix.csv --apply --rollback
 *       Run the whole write, then undo it: proves an import would succeed and
 *       keeps nothing. (--rollback is only meaningful together with --apply.)
 *
 * Rows with a blank control_type are "undecided": reported, never loaded.
 * See src/utils/zoningMatrixImport.js for the CSV format and the checks.
 */
const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')
const { parseCsv, planImport, buildTemplate } = require('../src/utils/zoningMatrixImport')

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? null : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true)
}

const KNOWN_FLAGS = new Set(['--template', '--file', '--apply', '--rollback'])

async function main() {
  // A misspelt flag must never fall through to a real write.
  const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a))
  if (unknown.length) {
    console.error(`Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(' ')}`)
    console.error('Usage: --template <out.csv> | --file <in.csv> [--apply [--rollback]]')
    process.exit(2)
  }
  const template = arg('template')
  const file = arg('file')
  const apply = process.argv.includes('--apply')
  const rollback = process.argv.includes('--rollback')
  if (rollback && !apply) {
    console.error('--rollback only applies together with --apply')
    process.exit(2)
  }
  if (!template && !file) {
    console.error('Usage: --template <out.csv> | --file <in.csv> [--apply [--rollback]]')
    process.exit(2)
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const { rows: zones } = await pool.query('SELECT id, zone FROM proposed_peri_urban_zones ORDER BY id')
    const { rows: groups } = await pool.query('SELECT id, group_code, description, is_active FROM land_use_groups')

    if (template) {
      const out = typeof template === 'string' ? template : 'zoning-matrix-template.csv'
      fs.writeFileSync(out, buildTemplate({ zones, groups }))
      const names = new Set(zones.map((z) => z.zone)).size
      console.log(`Wrote ${out}: ${names} zone types x ${groups.filter((g) => g.is_active).length} groups. Fill in control_type`)
      console.log('(permitted | special_consent | prohibited); leave blank anything not yet decided.')
      return
    }

    const { rows: existing } = await pool.query(
      'SELECT zone_id, land_use_group_id, control_type, conditions, notes, authority, deleted_at FROM zone_land_use_controls')
    const plan = planImport({ rows: parseCsv(fs.readFileSync(file, 'utf8')), zones, groups, existing })
    const s = plan.summary

    console.log(`\nZoning matrix import — ${apply ? (rollback ? 'APPLY then ROLL BACK (test)' : 'APPLY') : 'dry run (nothing is written)'}`)
    console.log(`  CSV rows        ${s.rows}`)
    console.log(`  cells to load   ${s.cells}  (insert ${s.inserts}, update ${s.updates}, unchanged ${s.unchanged})`)
    console.log(`  undecided rows  ${s.undecided}  (blank control_type — skipped)`)
    console.log(`  errors          ${s.errors}`)
    plan.errors.forEach((e) => console.log(`    ✗ ${e}`))

    console.log('\nCoverage (decisions per zone type, of the active groups):')
    for (const c of plan.coverage) {
      console.log(`  ${c.zone.padEnd(38)} ${String(c.decided).padStart(2)}/${c.decided + c.missing.length}  (${c.polygons} polygon${c.polygons === 1 ? '' : 's'})${c.missing.length ? '  no decision: ' + c.missing.join(',') : ''}`)
    }

    if (plan.errors.length) {
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
      for (const c of plan.cells.filter((x) => x.action !== 'unchanged')) {
        await client.query(
          `INSERT INTO zone_land_use_controls (zone_id, land_use_group_id, control_type, authority, conditions, notes)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (zone_id, land_use_group_id) DO UPDATE SET
             control_type = EXCLUDED.control_type, authority = EXCLUDED.authority,
             conditions = EXCLUDED.conditions, notes = EXCLUDED.notes,
             updated_at = NOW(), deleted_at = NULL, deleted_by = NULL`,
          [c.zone_id, c.land_use_group_id, c.control_type, c.authority, c.conditions, c.notes])
      }
      if (rollback) {
        const { rows: [n] } = await client.query('SELECT COUNT(*)::int AS n FROM zone_land_use_controls WHERE deleted_at IS NULL')
        await client.query('ROLLBACK')
        console.log(`\nTest import wrote ${s.inserts + s.updates} cells (the table held ${n.n} rows inside the transaction), then rolled back. Nothing was kept.`)
        return
      }
      await client.query('COMMIT')
      console.log(`\nLoaded ${s.inserts + s.updates} cells (${s.unchanged} already up to date).`)
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
