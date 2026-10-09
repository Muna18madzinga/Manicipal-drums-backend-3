#!/usr/bin/env node
/**
 * End-to-end check on a FRESH database: build it from the migrations, then onboard a
 * second authority with the real tools.
 *
 *   node scripts/verify-fresh-database.js              migrations as they are in this working tree
 *   node scripts/verify-fresh-database.js --committed  migrations as committed in HEAD (what a new
 *                                                      deployment would run)
 *
 * What it does, on a throwaway database that it always drops afterwards:
 *   1. creates the database (PostGIS) on the same LOCAL server as DATABASE_URL;
 *   2. runs the migration chain from scratch;
 *   3. runs scripts/verify-plan-model.js (structure, seeds, safeguards);
 *   4. loads the sample matrix with scripts/load-zoning-matrix.js;
 *   5. adds a second authority and has it adopt the template (scripts/add-authority.js,
 *      scripts/adopt-plan-template.js);
 *   6. loads a different matrix into that authority's plan, including a land use that only
 *      its plan has, and checks the template is untouched and plan_diff sees the changes.
 * Exit code 0 only if every step passes. Never touches the database in DATABASE_URL itself.
 */
const path = require('path')
const os = require('os')
const fs = require('fs')
const { spawnSync, execSync } = require('child_process')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

const ROOT = path.join(__dirname, '..')
const SCRATCH = 'vungu_fresh_check'
const base = new URL(process.env.DATABASE_URL || 'postgresql://x@invalid/x')
if (!['localhost', '127.0.0.1'].includes(base.hostname)) {
  console.error(`Refusing: DATABASE_URL is not a local server (${base.hostname}).`)
  process.exit(2)
}
const urlFor = (db) => { const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + db; return u.toString() }
const scratchUrl = urlFor(SCRATCH)

let failures = 0
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failures++ }

function run(script, args, { cwd = ROOT, expectFail = false } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, DATABASE_URL: scratchUrl, NODE_PATH: path.join(ROOT, 'node_modules') },
  })
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }
}

async function main() {
  const useCommitted = process.argv.includes('--committed')
  const admin = new Pool({ connectionString: urlFor('postgres') })
  let tmp = null
  try {
    console.log(`== create a fresh database (${SCRATCH})`)
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${SCRATCH}`)
    const db0 = new Pool({ connectionString: scratchUrl })
    await db0.query('CREATE EXTENSION IF NOT EXISTS postgis')
    await db0.end()
    check(true, 'created with PostGIS')

    console.log(`== run the migrations from scratch (${useCommitted ? 'as committed in HEAD' : 'as in this working tree'})`)
    let migrateDir = ROOT
    if (useCommitted) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-migrations-'))
      // forward slashes: Windows tar mis-reads backslashes when run through a shell
      execSync('git archive HEAD migrations scripts/migrate.js | tar -x -C "' + tmp.split('\\').join('/') + '"', { cwd: ROOT, shell: true })
      migrateDir = tmp
    }
    const mig = run(path.join(migrateDir, 'scripts', 'migrate.js'), [], { cwd: migrateDir })
    const applied = (mig.out.match(/applying/g) || []).length
    check(mig.code === 0 && /complete/.test(mig.out), `the whole chain applied (${applied} migrations)`)
    if (mig.code !== 0) { console.log(mig.out.split('\n').slice(-8).join('\n')); throw new Error('migrations failed') }

    console.log('== structure, seeds and safeguards (verify-plan-model.js)')
    const ver = run(path.join(__dirname, 'verify-plan-model.js'), [])
    check(ver.code === 0 && /ALL CHECKS PASSED/.test(ver.out), 'all checks passed on the empty database')
    if (ver.code !== 0) console.log(ver.out.split('\n').filter((l) => /FAIL/.test(l)).join('\n'))

    console.log('== row-level security by authority (verify-rls.js)')
    const rls = run(path.join(__dirname, 'verify-rls.js'), [])
    check(rls.code === 0 && /ALL CHECKS PASSED/.test(rls.out), 'authorities cannot see or change one another\'s permits and plans')
    if (rls.code !== 0) console.log(rls.out.split('\n').filter((l) => /FAIL/.test(l)).join('\n'))

    console.log('== the tenancy contract (verify-tenancy.js): every relation classified, default deny, secrets closed')
    const ten = run(path.join(__dirname, 'verify-tenancy.js'), [])
    check(ten.code === 0 && /ALL CHECKS PASSED/.test(ten.out), 'every relation is classified and none departs from its class')
    if (ten.code !== 0) console.log(ten.out.split('\n').filter((l) => /FAIL|^\s{8}\S/.test(l)).slice(0, 80).join('\n'))

    console.log('== the statutory clocks follow the Act (verify-statutory-clock.js)')
    const clock = run(path.join(__dirname, 'verify-statutory-clock.js'), [])
    check(clock.code === 0 && /ALL CHECKS PASSED/.test(clock.out), 'three months from acknowledgement, four for a subdivision, set by the database')
    if (clock.code !== 0) console.log(clock.out.split('\n').filter((l) => /FAIL/.test(l)).join('\n'))

    console.log('== load the sample matrix with the real loader')
    const csv = path.join(ROOT, 'docs', 'district-development-control-matrix.csv')
    const load = run(path.join(__dirname, 'load-zoning-matrix.js'), ['--file', csv, '--apply'])
    check(load.code === 0 && /Loaded 337 cells/.test(load.out), '337 decisions loaded into the rural template')

    console.log('== onboard a second authority')
    const add = run(path.join(__dirname, 'add-authority.js'), ['--code', 'TESTRURAL', '--name', 'Test Rural District Council', '--kind', 'rural', '--type', 'Rural District Council'])
    check(add.code === 0 && /Added rural authority TESTRURAL/.test(add.out), 'authority added')
    const adopt = run(path.join(__dirname, 'adopt-plan-template.js'), ['--authority', 'TESTRURAL', '--title', 'Test RDC district plan', '--plan-type', 'district_master'])
    const planId = (adopt.out.match(/\(plan ([0-9a-f-]{36})\)/) || [])[1]
    check(adopt.code === 0 && /11 zone types, 32 land uses, 337 decisions copied/.test(adopt.out) && !!planId, 'it adopted the template: 11 zone types, 32 land uses, 337 decisions')

    console.log("== load a different matrix into that authority's plan only")
    const db = new Pool({ connectionString: scratchUrl })
    try {
      await db.query("INSERT INTO land_use_groups (group_code, description, plan_instrument_id, is_active, display_order) VALUES ('ZZ', 'A use only this plan has', $1, TRUE, 99)", [planId])
      const sheet = path.join(os.tmpdir(), 'fresh-check-sheet.csv')
      fs.writeFileSync(sheet, 'zone,group_code,control_type,conditions,notes,authority\n' +
        'Communal Farming Zone,A,X,,,Test RDC\n' +       // changes a copied cell
        'Communal Farming Zone,ZZ,P,,,Test RDC\n')       // a land use only this plan has

      const dry = run(path.join(__dirname, 'load-zoning-matrix.js'), ['--plan', planId, '--file', sheet])
      check(dry.code === 0 && /insert 1, update 1, unchanged 0/.test(dry.out), "dry run into the new plan: 1 changed cell, 1 new cell")
      const apply = run(path.join(__dirname, 'load-zoning-matrix.js'), ['--plan', planId, '--file', sheet, '--apply'])
      check(apply.code === 0 && /Loaded 2 cells/.test(apply.out), 'loaded into the new plan')

      const toTemplate = run(path.join(__dirname, 'load-zoning-matrix.js'), ['--file', sheet])
      check(toTemplate.code === 1 && /unknown or inactive land-use group "ZZ"/.test(toTemplate.out), "the same sheet is refused by the template: 'ZZ' belongs only to the other plan")

      const tmplA = (await db.query(`SELECT c.control_type FROM zone_land_use_controls c
                                       JOIN plan_instrument i ON i.id = c.plan_instrument_id AND i.is_template
                                       JOIN plan_zone_type t ON t.id = c.plan_zone_type_id
                                       JOIN land_use_groups g ON g.id = c.land_use_group_id
                                      WHERE t.code = 'Communal Farming Zone' AND g.group_code = 'A'`)).rows[0]
      check(tmplA && tmplA.control_type === 'permitted', "the template's decision for A in Communal Farming is unchanged (permitted)")

      const diff = (await db.query('SELECT land_use_code, change FROM plan_diff($1) ORDER BY land_use_code', [planId])).rows
      check(JSON.stringify(diff) === JSON.stringify([{ land_use_code: 'A', change: 'changed' }, { land_use_code: 'ZZ', change: 'added' }]),
        `plan_diff sees exactly the two edits (${diff.map((d) => d.land_use_code + ':' + d.change).join(', ')})`)

      const counts = (await db.query(`SELECT i.is_template, i.zone_types, i.land_uses, i.decisions FROM plan_instrument_summary i WHERE (i.is_default_template AND i.profile_code = 'rural') OR i.id = $1 ORDER BY i.is_template DESC`, [planId])).rows
      check(counts[0].decisions === 337 && counts[1].decisions === 338 && counts[1].land_uses === 33,
        `template unchanged (337 decisions); the new plan has its own (${counts[1].decisions} decisions, ${counts[1].land_uses} land uses)`)
    } finally {
      await db.end()
    }
  } catch (err) {
    console.log('  FAIL  ' + err.message)
    failures++
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`).catch(() => {})
    await admin.end()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    console.log(`\n(scratch database ${SCRATCH} dropped)`)
  }
  console.log(failures ? `${failures} check(s) FAILED` : 'ALL CHECKS PASSED')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
