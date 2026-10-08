#!/usr/bin/env node
/**
 * Give Vungu's plan a PROVISIONAL first-cut development control matrix, so the application can be built and tested
 * against real-looking decisions while the council's review is pending.
 *
 *   node scripts/seed-vungu-draft-matrix.js            dry run: report what would be written
 *   node scripts/seed-vungu-draft-matrix.js --apply    write it (one transaction), and the zone categories
 *   node scripts/seed-vungu-draft-matrix.js --apply --force   also overwrite decisions the council has entered
 *
 * What this is, and is not:
 *   - It is a PROPOSAL by the development team, drawn from the intent of each zone (docs/derived/zones.csv and the
 *     review pack). It is NOT council policy and has not been reviewed by anyone.
 *   - Every column is left 'unreviewed'. The plan stays at its recorded status ("unknown"), so every assessment that
 *     rests on it is marked provisional (migration 161). Nothing here signs the plan off or gazettes it.
 *   - No special consent carries a condition and no standards are entered: those are the council's (decisions D6-D8
 *     in the review pack). The matrix audit reports them.
 *   - Only the 11 urban-profile zones are in Vungu's plan; the rural block waits for decision D2.
 *
 * Safe to re-run: it only changes cells that differ, and refuses to overwrite a decision that someone other than this
 * script entered unless --force is given. The same decisions are written to docs/vungu-draft-v0-matrix.csv so the council
 * can review them as a spreadsheet and return a marked-up copy to the loader (scripts/load-zoning-matrix.js).
 */
const fs = require('node:fs')
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')
const { importCsv } = require('../src/services/planMatrixImport')

const MARK = 'Draft v0 proposal (unreviewed)'
const CSV_OUT = path.join(__dirname, '..', 'docs', 'vungu-draft-v0-matrix.csv')

// The 32 use groups, in the council schedule's order.
const GROUPS = ['A', 'A1', 'A2', 'A3', 'B', 'B1', 'B2', 'C', 'D', 'D1', 'E', 'E1', 'E2', 'F', 'G', 'H', 'I', 'J', 'J1', 'K', 'L1', 'M',
  'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'X', 'Z', 'UF']

// For each zone: what is permitted outright (P) and what needs special consent (SC). Everything else is prohibited (X).
// Written from the intent of the zone; see the review pack. Each use appears at most once per zone (checked below).
const ZONES = {
  'Low Density Residential': { category: 'residential',
    P: ['A', 'UF'], SC: ['A1', 'A2', 'B', 'B1', 'B2', 'C', 'E2', 'F', 'I', 'J', 'K', 'Z'] },
  'Medium Density Residential': { category: 'residential',
    P: ['A', 'A1', 'A2', 'UF'], SC: ['A3', 'B', 'B1', 'B2', 'C', 'D', 'E', 'E2', 'F', 'I', 'J', 'K', 'U', 'Z'] },
  'High Density Residential': { category: 'residential',
    P: ['A', 'A1', 'A2', 'A3', 'B', 'UF'], SC: ['B1', 'B2', 'C', 'D', 'E', 'E2', 'F', 'I', 'J', 'K', 'U', 'Z'] },
  'Mixed Density Residential': { category: 'residential',
    P: ['A', 'A1', 'A2', 'A3', 'B', 'I', 'UF'], SC: ['B1', 'B2', 'C', 'D', 'E', 'E2', 'F', 'J', 'K', 'R', 'U', 'Z'] },
  'Densification Zone [LDR]': { category: 'residential',
    P: ['A', 'A1', 'A2', 'UF'], SC: ['A3', 'B', 'B1', 'B2', 'C', 'E2', 'F', 'I', 'J', 'K', 'Z'] },
  'Economic Corridor [Mixed Business]': { category: 'mixed',
    P: ['A3', 'B1', 'D', 'E', 'E1', 'E2', 'G', 'H', 'I', 'J', 'R', 'T', 'U', 'UF'], SC: ['A', 'A2', 'B', 'B2', 'C', 'D1', 'F', 'J1', 'K', 'L1', 'S', 'V', 'Z'] },
  'Institutional': { category: 'institutional',
    P: ['B2', 'C', 'E2', 'F', 'I', 'J', 'K', 'UF'], SC: ['B', 'D', 'E', 'J1', 'U', 'V', 'Z'] },
  'Light Industry': { category: 'industrial',
    P: ['G', 'H', 'L1', 'R', 'S', 'U', 'UF'], SC: ['A', 'D', 'E', 'E1', 'I', 'M', 'T', 'Z'] },
  'Railways Common User Facilities': { category: 'infrastructure',
    P: ['G', 'H', 'S', 'UF'], SC: ['I', 'L1', 'R', 'U'] },
  'Cemetery': { category: 'open_space',
    P: ['V', 'UF'], SC: ['I', 'K', 'Z'] },
  'Residential Agricultural Plots': { category: 'agricultural',
    P: ['A', 'D1', 'P', 'Q', 'Z', 'UF'], SC: ['B', 'B1', 'C', 'D', 'E2', 'F', 'H', 'I', 'J', 'K', 'R', 'X'] },
}

function build() {
  const rows = []
  for (const [zone, def] of Object.entries(ZONES)) {
    const seen = new Set()
    for (const code of [...def.P, ...def.SC]) {
      if (!GROUPS.includes(code)) throw new Error(`${zone}: unknown use group ${code}`)
      if (seen.has(code)) throw new Error(`${zone}: ${code} is listed twice`)
      seen.add(code)
    }
    for (const g of GROUPS) {
      rows.push({ zone, group_code: g, control_type: def.P.includes(g) ? 'P' : def.SC.includes(g) ? 'SC' : 'X', conditions: '', notes: '', authority: MARK })
    }
  }
  return rows
}
const toCsv = (rows) => ['zone,group_code,control_type,conditions,notes,authority', ...rows.map((r) =>
  [r.zone, r.group_code, r.control_type, r.conditions, r.notes, r.authority].map((v) => (/[",]/.test(v) ? `"${v}"` : v)).join(','))].join('\n') + '\n'

async function main() {
  const known = new Set(['--apply', '--force'])
  const bad = process.argv.slice(2).filter((a) => !known.has(a))
  if (bad.length) { console.error(`Unknown option(s): ${bad.join(' ')}\nUsage: [--apply [--force]]`); process.exit(2) }
  const apply = process.argv.includes('--apply'), force = process.argv.includes('--force')
  const rows = build()
  const csv = toCsv(rows)
  fs.writeFileSync(CSV_OUT, csv)

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const plans = (await pool.query(
      `SELECT i.id, i.title, i.status FROM plan_instrument i JOIN local_authorities a ON a.id = i.authority_id
        WHERE a.code = 'VUNGU' AND NOT i.is_template AND i.status NOT IN ('superseded') ORDER BY i.created_at`)).rows
    if (plans.length !== 1) throw new Error(`Expected exactly one live plan for Vungu, found ${plans.length}. Name it by hand.`)
    const plan = plans[0]
    if (['approved', 'gazetted'].includes(plan.status)) throw new Error(`Vungu's plan is ${plan.status}: it is frozen. Start a new version instead.`)

    const foreign = (await pool.query(
      `SELECT COUNT(*)::int n FROM zone_land_use_controls WHERE plan_instrument_id = $1 AND deleted_at IS NULL AND COALESCE(authority, '') <> $2`, [plan.id, MARK])).rows[0].n
    if (foreign && !force) throw new Error(`${foreign} decision(s) in this plan were entered by someone else. Re-run with --force to overwrite them.`)

    console.log(`${plan.title} [${plan.status}]: ${rows.length} decisions, ${Object.keys(ZONES).length} zones; written for review to ${path.relative(process.cwd(), CSV_OUT)}`)
    const res = await importCsv(pool, plan.id, csv, { apply, actor: { id: null, role: 'system' } })
    if (res.errors.length) { console.error('The loader refused the sheet:'); res.errors.slice(0, 10).forEach((e) => console.error('  ' + JSON.stringify(e))); process.exit(1) }
    console.log(`  insert ${res.summary.inserts}, update ${res.summary.updates}, unchanged ${res.summary.unchanged}`)

    if (apply) {
      // The zone categories the audit and the explorer rely on were blank in this plan.
      for (const [zone, def] of Object.entries(ZONES)) {
        await pool.query('UPDATE plan_zone_type SET category = $3 WHERE plan_instrument_id = $1 AND code = $2 AND category IS DISTINCT FROM $3', [plan.id, zone, def.category])
      }
      console.log('  applied. Columns are unreviewed and the plan is still', plan.status, '-> every assessment on it is provisional.')
    } else {
      console.log('  (dry run: nothing written; add --apply)')
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
