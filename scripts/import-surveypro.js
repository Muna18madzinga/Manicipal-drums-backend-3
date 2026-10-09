#!/usr/bin/env node
/**
 * Bring the council's survey work in from SurveyPro.
 *
 *   node scripts/import-surveypro.js            dry run: reads SurveyPro and says what would change; changes nothing
 *   node scripts/import-surveypro.js --apply    do it
 *   node scripts/import-surveypro.js --json     the report as JSON (for a scheduler or a person to read later)
 *
 * What it does (src/services/surveyproImport.js has the rules):
 *   - a job's status follows its SurveyPro project: delivered -> submitted; accepted or returned by the council's reviewer -> the same;
 *   - parcels of an ACCEPTED project enter the register (land.parcel) as authority-origin parcels awaiting the Surveyor-General, in the
 *     Cape / Lo system VunGIS's own registry uses, with the transformation method and accuracy recorded;
 *   - nothing already imported is ever changed, and a layout with any problem is refused whole, with the reasons.
 *
 * Configuration (environment):
 *   SURVEYPRO_DATABASE_URL   SurveyPro's database, as THIS council's reader login (SurveyPro: scripts/create-authority-reader.js).
 *                            It can read the council's survey_share views and nothing else.
 *   DATABASE_URL             VunGIS (the system plane: land.parcel is national data, so the application role cannot write it)
 *   SURVEYPRO_SHARE_SCHEMA   the schema holding the views; default survey_share
 *
 * Exit code: 0 when everything went through (conflicts and warnings are listed, not fatal), 1 when something was refused, 2 when a
 * database could not be reached or the options were wrong.
 */
require('dotenv').config({ quiet: true })
const { Pool } = require('pg')
const { runImport } = require('../src/services/surveyproImport')

const args = process.argv.slice(2)
const KNOWN = new Set(['--apply', '--json'])
const bad = args.filter((a) => !KNOWN.has(a))
if (bad.length) { console.error(`Unknown option(s): ${bad.join(' ')}\nUsage: [--apply] [--json]`); process.exit(2) }
const apply = args.includes('--apply'), asJson = args.includes('--json')

function print(report) {
  const t = report.totals
  console.log(`${report.applied ? 'APPLIED' : 'DRY RUN (nothing was changed)'}: read ${report.read.projects} project(s) and ${report.read.parcels} parcel(s) from SurveyPro`)
  for (const r of report.projects) {
    if (r.failed) { console.log(`\n  project ${r.project} "${r.name}": FAILED: ${r.failed}`); continue }
    const p = r.parcels
    const quiet = !r.status?.to && !r.status?.error && !p.imported.length && !p.diverged.length && !p.errors.length && !p.warnings.length
    if (quiet) continue
    console.log(`\n  project ${r.project} "${r.name}" (${r.authority})`)
    if (r.status?.to) console.log(`    job ${r.job}: ${r.status.from} -> ${r.status.to}`)
    if (r.status?.error) console.log(`    job ${r.status.job}: ${r.status.error}`)
    for (const x of p.imported) console.log(`    + stand ${x.stand} -> ${x.parcel_id} (${x.area_m2} m2)`)
    for (const x of p.diverged) console.log(`    ! stand ${x.stand} (${x.parcel_id}): ${x.note}`)
    for (const x of p.errors) console.log(`    x ${x.code}: ${JSON.stringify(x)}`)
    for (const x of p.warnings) console.log(`    ~ ${x.code}: ${JSON.stringify(x)}`)
  }
  console.log(`\n${t.statuses} status change(s), ${t.imported} parcel(s) ${report.applied ? 'imported' : 'to import'}, ${t.unchanged} already in the register, ${t.diverged} diverged, ${t.errors} refused, ${t.warnings} warning(s)`)
}

async function main() {
  if (!process.env.SURVEYPRO_DATABASE_URL) { console.error('SURVEYPRO_DATABASE_URL is not set (the council\'s reader login on SurveyPro)'); process.exit(2) }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(2) }
  const source = new Pool({ connectionString: process.env.SURVEYPRO_DATABASE_URL, max: 1 })
  const pg = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const report = await runImport(pg, source, { apply, schema: process.env.SURVEYPRO_SHARE_SCHEMA || 'survey_share' })
    if (asJson) console.log(JSON.stringify(report, null, 2)); else print(report)
    process.exitCode = report.totals.errors ? 1 : 0
  } catch (err) {
    console.error('could not complete: ' + err.message)
    process.exitCode = 2
  } finally {
    await source.end().catch(() => {}); await pg.end().catch(() => {})
  }
}

main()
