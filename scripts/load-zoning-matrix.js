#!/usr/bin/env node
/**
 * Load the zoning permission matrix (zone_land_use_controls) from a CSV.
 *
 *   node scripts/load-zoning-matrix.js --template district-matrix.csv
 *       Write a blank CSV for the DISTRICT matrix: every district zone type
 *       (Communal Farming ... Commercial) x every coded land use (A ... Z),
 *       decisions empty.
 *
 *   node scripts/load-zoning-matrix.js --template local-matrix.csv --local
 *       The same, but for a LOCAL plan: every zone polygon name x every land use.
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
 * A row's `zone` is a zone type (district matrix) or a zone polygon name (local
 * plan). Rows with a blank control_type are "undecided" — like a blank cell in
 * the council's matrix: reported, never loaded.
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

const KNOWN_FLAGS = new Set(['--template', '--file', '--apply', '--rollback', '--local'])
const USAGE = 'Usage: --template <out.csv> [--local] | --file <in.csv> [--apply [--rollback]]'

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
  const apply = process.argv.includes('--apply')
  const rollback = process.argv.includes('--rollback')
  const local = process.argv.includes('--local')
  if (rollback && !apply) {
    console.error('--rollback only applies together with --apply')
    process.exit(2)
  }
  if (local && !template) {
    console.error('--local only applies together with --template')
    process.exit(2)
  }
  if (!template && !file) {
    console.error(USAGE)
    process.exit(2)
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const { rows: zones } = await pool.query('SELECT id, zone FROM proposed_peri_urban_zones ORDER BY id')
    const { rows: zoneTypes } = await pool.query('SELECT code, label, display_order FROM ref_zone_types')
    const { rows: groups } = await pool.query('SELECT id, group_code, description, display_order, is_active FROM land_use_groups')

    if (template) {
      const out = typeof template === 'string' ? template : (local ? 'local-matrix-template.csv' : 'district-matrix-template.csv')
      const level = local ? 'local' : 'district'
      fs.writeFileSync(out, buildTemplate({ zones, zoneTypes, groups, level }))
      const nZones = level === 'district'
        ? zoneTypes.filter((t) => t.display_order != null).length
        : new Set(zones.map((z) => z.zone)).size
      console.log(`Wrote ${out}: ${nZones} ${level === 'district' ? 'district zone types' : 'local zone names'} x ${groups.filter((g) => g.is_active).length} land uses.`)
      console.log('Fill in control_type (permitted | special_consent | prohibited, or P | SC | X);')
      console.log('leave blank anything not yet decided.')
      return
    }

    const { rows: existing } = await pool.query(
      'SELECT zone_id, zone_type, land_use_group_id, control_type, conditions, notes, authority, deleted_at FROM zone_land_use_controls')
    const plan = planImport({ rows: parseCsv(fs.readFileSync(file, 'utf8')), zones, zoneTypes, groups, existing })
    const s = plan.summary

    console.log(`\nZoning matrix import — ${apply ? (rollback ? 'APPLY then ROLL BACK (test)' : 'APPLY') : 'dry run (nothing is written)'}`)
    console.log(`  CSV rows        ${s.rows}`)
    console.log(`  cells to load   ${s.cells}  (insert ${s.inserts}, update ${s.updates}, unchanged ${s.unchanged})`)
    console.log(`  undecided rows  ${s.undecided}  (blank control_type — skipped)`)
    console.log(`  errors          ${s.errors}`)
    plan.errors.forEach((e) => console.log(`    ✗ ${e}`))

    console.log('\nCoverage (decisions per zone named in the CSV, of the active land uses):')
    for (const c of plan.coverage) {
      const where = c.kind === 'zone' ? `  (${c.polygons} polygon${c.polygons === 1 ? '' : 's'})` : ''
      const missing = c.missing.length ? `  no decision: ${c.missing.join(',')}` : ''
      console.log(`  ${c.zone.padEnd(40)} ${String(c.decided).padStart(2)}/${c.decided + c.missing.length}${where}${missing}`)
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
        // A cell targets a zone type or a zone polygon; each has its own unique key.
        const target = c.zone_type
          ? { col: 'zone_type', val: c.zone_type, conflict: '(zone_type, land_use_group_id) WHERE zone_type IS NOT NULL' }
          : { col: 'zone_id', val: c.zone_id, conflict: '(zone_id, land_use_group_id)' }
        await client.query(
          `INSERT INTO zone_land_use_controls (${target.col}, land_use_group_id, control_type, authority, conditions, notes)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT ${target.conflict} DO UPDATE SET
             control_type = EXCLUDED.control_type, authority = EXCLUDED.authority,
             conditions = EXCLUDED.conditions, notes = EXCLUDED.notes,
             updated_at = NOW(), deleted_at = NULL, deleted_by = NULL`,
          [target.val, c.land_use_group_id, c.control_type, c.authority, c.conditions, c.notes])
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
