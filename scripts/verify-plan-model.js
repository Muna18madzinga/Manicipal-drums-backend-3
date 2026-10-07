#!/usr/bin/env node
/**
 * Verify the plan-model foundation (migration 139) against a database.
 *
 *   node scripts/verify-plan-model.js
 *
 * Works on any database the migrations have been applied to: a fully loaded one
 * (the dev database) or a fresh one (structure and seeds only). Its checks are
 * relationships and invariants, not fixed row counts. It reads the structure and
 * the migrated data, then exercises the triggers and constraints inside a
 * transaction that is ALWAYS rolled back, creating its own test rows, so nothing
 * is kept. Exit code 0 only if every check passes. Needs DATABASE_URL.
 */
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

let failures = 0
const check = (ok, msg) => {
  console.log(`${ok ? '  ok   ' : '  FAIL '} ${msg}`)
  if (!ok) failures++
}

async function expectError(client, label, sql, params, pattern) {
  await client.query('SAVEPOINT s')
  try {
    await client.query(sql, params)
    check(false, `${label} (was accepted; should be refused)`)
  } catch (err) {
    check(pattern.test(err.message), `${label} -> refused: ${err.message.slice(0, 70)}`)
  }
  await client.query('ROLLBACK TO SAVEPOINT s')
}

const COUNTS_SQL = `SELECT (SELECT COUNT(*)::int FROM local_authorities) authorities,
                           (SELECT COUNT(*)::int FROM plan_instrument) plans,
                           (SELECT COUNT(*)::int FROM zone_land_use_controls) decisions,
                           (SELECT COUNT(*)::int FROM proposed_peri_urban_zones) polygons,
                           (SELECT COUNT(*)::int FROM plan_zone_type) zone_types`

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const q = async (sql, params) => (await pool.query(sql, params)).rows
  const one = async (sql, params) => (await q(sql, params))[0]
  const before = await one(COUNTS_SQL)

  console.log('== authorities')
  const vungu = await one("SELECT * FROM local_authorities WHERE code = 'VUNGU'")
  check(vungu && vungu.kind === 'rural' && vungu.province === 'Midlands', 'Vungu RDC is a rural authority in Midlands')
  check(vungu && vungu.authority_id === vungu.id, 'authority_id is an alias of id (the older routes use it)')
  check((await q('SELECT 1 FROM local_authorities WHERE kind IS NULL')).length === 0, 'every authority has a kind')

  console.log('== profiles and plan instruments')
  const profiles = await q('SELECT code, status, version FROM plan_profile ORDER BY code')
  check(JSON.stringify(profiles.map((p) => `${p.code}:${p.status}:${p.version}`)) === JSON.stringify(['rural:draft:0', 'urban:skeleton:0']), 'rural (draft v0) and urban (skeleton) profiles')
  const plans = await q('SELECT * FROM plan_instrument_summary ORDER BY is_template DESC, title')
  const template = plans.find((p) => p.is_template)
  const vplan = plans.find((p) => !p.is_template)
  check(plans.length === 2, "two plan instruments: the rural template and Vungu's local plan")
  check(template && template.authority_id === null && template.profile_code === 'rural', 'the template belongs to no authority and uses the rural profile')
  check(vplan && vplan.authority_code === 'VUNGU' && vplan.profile_code === 'urban' && vplan.status === 'unknown', "Vungu's plan: owned by Vungu, urban profile, status unknown (not yet confirmed)")

  console.log('== seeds and attachment (relationships, not fixed counts)')
  check(template && template.zone_types === 11, `the rural template has the 11 district zone types (${template && template.zone_types})`)
  check(template && template.land_uses === 32, `the rural template has the 32 coded land uses (${template && template.land_uses})`)
  const typeDecisions = (await one("SELECT COUNT(*)::int n FROM zone_land_use_controls WHERE zone_type IS NOT NULL AND deleted_at IS NULL")).n
  check(template && template.decisions === typeDecisions, `every live zone-type decision belongs to the template (${typeDecisions})`)
  const names = (await one('SELECT COUNT(DISTINCT zone)::int n FROM proposed_peri_urban_zones')).n
  const polys = (await one('SELECT COUNT(*)::int n FROM proposed_peri_urban_zones')).n
  check(vplan && vplan.zone_types === names, `Vungu's plan has one zone type per distinct polygon name (${names})`)
  check(vplan && vplan.zone_polygons === polys, `every zone polygon belongs to Vungu's plan (${polys})`)
  check((await q('SELECT 1 FROM proposed_peri_urban_zones WHERE plan_instrument_id IS NULL OR plan_zone_type_id IS NULL')).length === 0, 'no polygon is missing its plan or zone type')
  check((await q('SELECT 1 FROM zone_land_use_controls WHERE deleted_at IS NULL AND (plan_instrument_id IS NULL OR (zone_type IS NOT NULL AND plan_zone_type_id IS NULL))')).length === 0, 'no decision is missing its plan references')
  check((await one('SELECT COUNT(*)::int n FROM land_use_groups WHERE is_active AND plan_instrument_id IS NULL')).n === 0, 'every active land use belongs to a plan')
  check((await one('SELECT COUNT(*)::int n FROM land_use_groups WHERE NOT is_active AND plan_instrument_id IS NOT NULL')).n === 0, 'no retired land use is attached to a plan')
  check((await one('SELECT COUNT(*)::int n FROM zone_effective_controls')).n >= 0, 'zone_effective_controls reads')

  console.log('== constraints and triggers (inside a rolled-back transaction)')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // combination authorities
    const combo = (await client.query("INSERT INTO local_authorities (authority_name, code, kind, authority_type) VALUES ('Test combination', 'TESTCOMBO', 'combination', 'Combination authority') RETURNING id")).rows[0].id
    const combo2 = (await client.query("INSERT INTO local_authorities (authority_name, code, kind, authority_type) VALUES ('Test combination 2', 'TESTCOMBO2', 'combination', 'Combination authority') RETURNING id")).rows[0].id
    const other = (await client.query("INSERT INTO local_authorities (authority_name, code, kind, authority_type) VALUES ('Test urban council', 'TESTURB', 'urban', 'Town Council') RETURNING id")).rows[0].id
    await client.query('INSERT INTO authority_member (combination_id, member_id) VALUES ($1, $2), ($1, $3)', [combo, vungu.id, other])
    check((await client.query('SELECT COUNT(*)::int n FROM authority_member WHERE combination_id = $1', [combo])).rows[0].n === 2, 'a combination authority takes a rural and an urban member')
    await expectError(client, 'a non-combination authority cannot have members', 'INSERT INTO authority_member (combination_id, member_id) VALUES ($1, $2)', [other, vungu.id], /not a combination authority/)
    await expectError(client, 'a combination cannot be a member of another combination', 'INSERT INTO authority_member (combination_id, member_id) VALUES ($1, $2)', [combo, combo2], /cannot be a member of another/)
    await expectError(client, 'an authority cannot be its own member', 'INSERT INTO authority_member (combination_id, member_id) VALUES ($1, $1)', [combo], /violates check|cannot be a member/)
    await expectError(client, 'an invalid authority kind is refused', "INSERT INTO local_authorities (authority_name, code, kind) VALUES ('Bad', 'BAD', 'suburban')", [], /check constraint/)
    await expectError(client, 'a plan must belong to an authority unless it is a template', "INSERT INTO plan_instrument (authority_id, profile_id, plan_type, title) SELECT NULL, id, 'local', 'Orphan plan' FROM plan_profile WHERE code = 'urban'", [], /check constraint/)

    // a combination can own a plan
    await client.query("INSERT INTO plan_instrument (authority_id, profile_id, plan_type, title, status) SELECT $1, id, 'local', 'Test combination overlap plan', 'draft' FROM plan_profile WHERE code = 'urban'", [combo])
    check((await client.query('SELECT COUNT(*)::int n FROM plan_instrument_summary WHERE authority_id = $1', [combo])).rows[0].n === 1, 'a combination authority can own a plan instrument')

    // a zone drawn in QGIS gets filed under Vungu's plan, its zone type created
    const poly = (await client.query("INSERT INTO proposed_peri_urban_zones (zone) VALUES ('Verification test zone') RETURNING id, plan_instrument_id, plan_zone_type_id")).rows[0]
    check(poly.plan_instrument_id === vplan.id && poly.plan_zone_type_id !== null, "a new zone polygon is filed under Vungu's plan, with its zone type created")

    // older writers still get the new references
    const grp = (await client.query("SELECT id FROM land_use_groups WHERE group_code = 'A'")).rows[0].id
    const typeRow = (await client.query("INSERT INTO zone_land_use_controls (zone_type, land_use_group_id, control_type) VALUES ('Communal Farming Zone', $1, 'permitted') ON CONFLICT (zone_type, land_use_group_id) WHERE zone_type IS NOT NULL DO UPDATE SET control_type = 'permitted' RETURNING plan_instrument_id, plan_zone_type_id", [grp])).rows[0]
    check(typeRow.plan_instrument_id === template.id && typeRow.plan_zone_type_id !== null, 'a zone-type decision written the old way gets the template and zone-type references filled')
    const polyRow = (await client.query("INSERT INTO zone_land_use_controls (zone_id, land_use_group_id, control_type) VALUES ($1, $2, 'special_consent') RETURNING plan_instrument_id", [poly.id, grp])).rows[0]
    check(polyRow.plan_instrument_id === vplan.id, "a polygon decision written the old way gets Vungu's plan filled")

    // effective controls: a polygon inherits its zone type's decision, and its own rule wins
    const tmplType = (await client.query("SELECT id FROM plan_zone_type WHERE plan_instrument_id = $1 AND code = 'Communal Farming Zone'", [template.id])).rows[0].id
    await client.query('UPDATE proposed_peri_urban_zones SET plan_zone_type_id = $1 WHERE id = $2', [tmplType, poly.id])
    await client.query('DELETE FROM zone_land_use_controls WHERE zone_id = $1 AND land_use_group_id = $2', [poly.id, grp])
    const inherited = (await client.query("SELECT control_type, source FROM zone_effective_controls WHERE zone_id = $1 AND land_use_group_id = $2", [poly.id, grp])).rows[0]
    check(inherited && inherited.control_type === 'permitted' && inherited.source === 'zone_type', 'a polygon classified as a template zone type inherits that type\'s decision')
    await client.query("INSERT INTO zone_land_use_controls (zone_id, land_use_group_id, control_type) VALUES ($1, $2, 'prohibited')", [poly.id, grp])
    const overridden = (await client.query("SELECT control_type, source FROM zone_effective_controls WHERE zone_id = $1 AND land_use_group_id = $2", [poly.id, grp])).rows[0]
    check(overridden && overridden.control_type === 'prohibited' && overridden.source === 'zone', "the polygon's own rule wins over its zone type's")

    await client.query('ROLLBACK')
  } catch (err) {
    await client.query('ROLLBACK')
    console.log('  FAIL  unexpected error:', err.message)
    failures++
  } finally {
    client.release()
  }

  const after = await one(COUNTS_SQL)
  check(JSON.stringify(after) === JSON.stringify(before), `nothing was kept (${JSON.stringify(after)})`)

  await pool.end()
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
