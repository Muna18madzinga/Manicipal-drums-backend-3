#!/usr/bin/env node
/**
 * Verify the plan-model foundation (migration 139) against the live database.
 *
 *   node scripts/verify-plan-model.js
 *
 * Reads the structure and the migrated data, then exercises the triggers and
 * constraints inside a transaction that is ALWAYS rolled back, so nothing is kept.
 * Exit code 0 only if every check passes. Needs DATABASE_URL (same as the app).
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

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const q = async (sql, params) => (await pool.query(sql, params)).rows
  const one = async (sql, params) => (await q(sql, params))[0]

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
  check(plans.length === 2, 'two plan instruments: the rural template and Vungu\'s local plan')
  check(template && template.authority_id === null && template.profile_code === 'rural', 'the template belongs to no authority and uses the rural profile')
  check(vplan && vplan.authority_code === 'VUNGU' && vplan.profile_code === 'urban' && vplan.status === 'unknown', 'Vungu\'s plan: owned by Vungu, urban profile, status unknown (not yet confirmed)')

  console.log('== existing data attached')
  check(template && template.zone_types === 11 && template.land_uses === 32 && template.decisions === 337,
    `template: ${template && template.zone_types} zone types, ${template && template.land_uses} land uses, ${template && template.decisions} decisions (expected 11 / 32 / 337)`)
  check(vplan && vplan.zone_types === 11 && vplan.zone_polygons === 36, `Vungu plan: ${vplan && vplan.zone_types} zone types, ${vplan && vplan.zone_polygons} polygons (expected 11 / 36)`)
  check((await q('SELECT 1 FROM proposed_peri_urban_zones WHERE plan_instrument_id IS NULL OR plan_zone_type_id IS NULL')).length === 0, 'every zone polygon has a plan and a zone type')
  check((await q("SELECT 1 FROM zone_land_use_controls WHERE deleted_at IS NULL AND (plan_instrument_id IS NULL OR (zone_type IS NOT NULL AND plan_zone_type_id IS NULL))")).length === 0, 'every decision has its plan references')
  const legacy = await one("SELECT COUNT(*)::int n FROM land_use_groups WHERE NOT is_active AND plan_instrument_id IS NULL")
  check(legacy.n === 10, 'the 10 retired legacy land-use groups are not attached to any plan')
  check((await one('SELECT COUNT(*)::int n FROM zone_effective_controls')).n >= 0, 'zone_effective_controls still reads')

  console.log('== constraints and triggers (inside a rolled-back transaction)')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // combination authorities
    const combo = (await client.query("INSERT INTO local_authorities (authority_name, code, kind, authority_type) VALUES ('Test combination', 'TESTCOMBO', 'combination', 'Combination authority') RETURNING id")).rows[0].id
    const other = (await client.query("INSERT INTO local_authorities (authority_name, code, kind, authority_type) VALUES ('Test urban council', 'TESTURB', 'urban', 'Town Council') RETURNING id")).rows[0].id
    await client.query('INSERT INTO authority_member (combination_id, member_id) VALUES ($1, $2), ($1, $3)', [combo, vungu.id, other])
    check((await client.query('SELECT COUNT(*)::int n FROM authority_member WHERE combination_id = $1', [combo])).rows[0].n === 2, 'a combination authority takes a rural and an urban member')
    await expectError(client, 'a non-combination authority cannot have members', 'INSERT INTO authority_member (combination_id, member_id) VALUES ($1, $2)', [other, vungu.id], /not a combination authority/)
    const combo2 = (await client.query("INSERT INTO local_authorities (authority_name, code, kind, authority_type) VALUES ('Test combination 2', 'TESTCOMBO2', 'combination', 'Combination authority') RETURNING id")).rows[0].id
    await expectError(client, 'a combination cannot be a member of another combination', 'INSERT INTO authority_member (combination_id, member_id) VALUES ($1, $2)', [combo, combo2], /cannot be a member of another/)
    await expectError(client, 'an authority cannot be its own member', 'INSERT INTO authority_member (combination_id, member_id) VALUES ($1, $1)', [combo], /violates check|cannot be a member/)
    await expectError(client, 'an invalid authority kind is refused', "INSERT INTO local_authorities (authority_name, code, kind) VALUES ('Bad', 'BAD', 'suburban')", [], /check constraint/)
    await expectError(client, 'a plan must belong to an authority unless it is a template', "INSERT INTO plan_instrument (authority_id, profile_id, plan_type, title) SELECT NULL, id, 'local', 'Orphan plan' FROM plan_profile WHERE code = 'urban'", [], /check constraint/)

    // a combination can own a plan
    await client.query("INSERT INTO plan_instrument (authority_id, profile_id, plan_type, title, status) SELECT $1, id, 'local', 'Test combination overlap plan', 'draft' FROM plan_profile WHERE code = 'urban'", [combo])
    check((await client.query('SELECT COUNT(*)::int n FROM plan_instrument_summary WHERE authority_id = $1', [combo])).rows[0].n === 1, 'a combination authority can own a plan instrument')

    // older writers still get the new references
    const grp = (await client.query("SELECT id FROM land_use_groups WHERE group_code = 'A'")).rows[0].id
    const typeRow = (await client.query("INSERT INTO zone_land_use_controls (zone_type, land_use_group_id, control_type) VALUES ('Game Park Zone', $1, 'prohibited') ON CONFLICT (zone_type, land_use_group_id) WHERE zone_type IS NOT NULL DO UPDATE SET control_type = 'prohibited' RETURNING plan_instrument_id, plan_zone_type_id", [grp])).rows[0]
    check(typeRow.plan_instrument_id === template.id && typeRow.plan_zone_type_id !== null, 'a zone-type decision written the old way gets the template and zone-type references filled')
    const polyRow = (await client.query("INSERT INTO zone_land_use_controls (zone_id, land_use_group_id, control_type) VALUES (1, $1, 'special_consent') ON CONFLICT (zone_id, land_use_group_id) DO UPDATE SET control_type = 'special_consent' RETURNING plan_instrument_id", [grp])).rows[0]
    check(polyRow.plan_instrument_id === vplan.id, 'a polygon decision written the old way gets Vungu\'s plan filled')

    // a zone drawn in QGIS
    const newZone = (await client.query("INSERT INTO proposed_peri_urban_zones (zone) VALUES ('Verification test zone') RETURNING plan_instrument_id, plan_zone_type_id")).rows[0]
    check(newZone.plan_instrument_id === vplan.id && newZone.plan_zone_type_id !== null, 'a new zone polygon is filed under Vungu\'s plan, with its zone type created')

    // effective controls follow the new zone-type reference
    const tmplType = (await client.query("SELECT id FROM plan_zone_type WHERE plan_instrument_id = $1 AND code = 'Communal Farming Zone'", [template.id])).rows[0].id
    await client.query('UPDATE proposed_peri_urban_zones SET plan_zone_type_id = $1 WHERE id = 1', [tmplType])
    const eff = (await client.query("SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE source = 'zone_type')::int via_type FROM zone_effective_controls WHERE zone_id = 1")).rows[0]
    check(eff.via_type >= 30, `a polygon classified as a template zone type inherits its decisions (${eff.via_type} via the zone type)`)

    await client.query('ROLLBACK')
  } catch (err) {
    await client.query('ROLLBACK')
    console.log('  FAIL  unexpected error:', err.message)
    failures++
  } finally {
    client.release()
  }

  const after = await one('SELECT (SELECT COUNT(*)::int FROM local_authorities) a, (SELECT COUNT(*)::int FROM plan_instrument) p, (SELECT COUNT(*)::int FROM zone_land_use_controls) c, (SELECT COUNT(*)::int FROM proposed_peri_urban_zones) z')
  check(after.a === 1 && after.p === 2 && after.c === 337 && after.z === 36, `nothing was kept (authorities ${after.a}, plans ${after.p}, decisions ${after.c}, polygons ${after.z})`)

  await pool.end()
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
