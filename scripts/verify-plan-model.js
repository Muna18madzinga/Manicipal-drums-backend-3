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
const { ZONE_TYPES_SQL, LAND_USES_SQL } = require('../src/utils/zoneUses')

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
                           (SELECT COUNT(*)::int FROM plan_zone_type) zone_types,
                           (SELECT COUNT(*)::int FROM land_use_groups) land_uses`

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
  check(JSON.stringify(profiles.map((p) => `${p.code}:${p.status}:${p.version}`)) === JSON.stringify(['rural:draft:0', 'urban:draft:0']), 'rural and urban profiles are both draft v0')
  const plans = await q('SELECT * FROM plan_instrument_summary ORDER BY is_template DESC, title')
  const template = plans.find((p) => p.is_default_template && p.profile_code === 'rural')
  const urbanStarter = plans.find((p) => p.is_default_template && p.profile_code === 'urban')
  const vplan = plans.find((p) => !p.is_template)
  const ruralStarter = plans.find((p) => p.is_template && !p.is_default_template && p.profile_code === 'rural')
  check(plans.length === 4, "four plan instruments: the rural sample template, the rural and urban starter palettes, and Vungu's local plan")
  check(template && template.authority_id === null && template.profile_code === 'rural', 'the template belongs to no authority and uses the rural profile')
  check(vplan && vplan.authority_code === 'VUNGU' && vplan.profile_code === 'urban' && vplan.status === 'unknown', "Vungu's plan: owned by Vungu, urban profile, status unknown (not yet confirmed)")

  console.log('== urban starter palette and reference classification')
  check(urbanStarter && urbanStarter.authority_id === null && urbanStarter.zone_types >= 10 && urbanStarter.land_uses >= 20,
    `the urban starter palette has zone types and land uses (${urbanStarter && urbanStarter.zone_types} / ${urbanStarter && urbanStarter.land_uses})`)
  check(urbanStarter && urbanStarter.decisions === 0, 'the urban starter palette carries NO decisions (they are law, not a best-practice guess)')
  check((await q("SELECT 1 FROM reference_classification WHERE scheme = 'HILUCS' AND level = 1")).length === 6, 'HILUCS has its six top-level classes')
  check((await q("SELECT 1 FROM plan_zone_type_class WHERE status <> 'proposed'")).length === 0
     && (await q("SELECT 1 FROM land_use_group_class WHERE status <> 'proposed'")).length === 0, 'every shipped crosswalk row is only "proposed" until someone confirms it')
  check((await q(`SELECT 1 FROM land_use_groups g JOIN plan_instrument i ON i.id = g.plan_instrument_id AND i.is_template
                    WHERE NOT EXISTS (SELECT 1 FROM land_use_group_class k WHERE k.land_use_group_id = g.id)`)).length === 0, 'every land use in both templates is mapped to a reference class')

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
    const grp = (await client.query("SELECT id FROM land_use_groups WHERE group_code = 'A' AND plan_instrument_id = $1", [template.id])).rows[0].id
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

    // ---- Phase 2: a plan owns its land uses and decisions ----
    console.log('== plans own their land uses and decisions (Phase 2)')
    const adopter = (await client.query("INSERT INTO local_authorities (authority_name, code, kind, authority_type) VALUES ('Test adopting council', 'TESTADOPT', 'rural', 'Rural District Council') RETURNING id")).rows[0].id
    const adopted = (await client.query("SELECT adopt_plan_template($1, $2, 'Verification adoption', 'district_master') AS id", [template.id, adopter])).rows[0].id
    const sum = (await client.query('SELECT zone_types, land_uses, decisions FROM plan_instrument_summary WHERE id = $1', [adopted])).rows[0]
    // Re-read the template: earlier checks may have added decisions since it was first read.
    const tNow = (await client.query('SELECT zone_types, land_uses, decisions FROM plan_instrument_summary WHERE id = $1', [template.id])).rows[0]
    check(sum.zone_types === tNow.zone_types && sum.land_uses === tNow.land_uses && sum.decisions === tNow.decisions,
      `adopting a template copies everything (${sum.zone_types} zone types, ${sum.land_uses} land uses, ${sum.decisions} decisions)`)
    const derived = (await client.query("SELECT id FROM plan_instrument WHERE id = $1 AND derived_from_id = $2", [adopted, template.id])).rows
    check(derived.length === 1, 'the copy records which template it was adopted from')
    const unprovenanced = (await client.query(`SELECT (SELECT COUNT(*)::int FROM plan_zone_type WHERE plan_instrument_id = $1 AND derived_from_id IS NULL)
                                                   + (SELECT COUNT(*)::int FROM land_use_groups WHERE plan_instrument_id = $1 AND derived_from_id IS NULL)
                                                   + (SELECT COUNT(*)::int FROM zone_land_use_controls WHERE plan_instrument_id = $1 AND derived_from_id IS NULL) AS n`, [adopted])).rows[0].n
    check(unprovenanced === 0, 'every copied zone type, land use and decision records where it came from')
    check((await client.query('SELECT COUNT(*)::int n FROM plan_diff($1)', [adopted])).rows[0].n === 0, 'a fresh copy has no difference from its template')

    // the reference crosswalk travels with the copy
    const crossCount = async (plan) => (await client.query(`SELECT (SELECT COUNT(*)::int FROM plan_zone_type_class k JOIN plan_zone_type t ON t.id = k.plan_zone_type_id WHERE t.plan_instrument_id = $1)
                                                            + (SELECT COUNT(*)::int FROM land_use_group_class k JOIN land_use_groups g ON g.id = k.land_use_group_id WHERE g.plan_instrument_id = $1) AS n`, [plan])).rows[0].n
    const tCross = await crossCount(template.id)
    check(tCross > 0 && (await crossCount(adopted)) === tCross, `adopting copies the HILUCS crosswalk (${tCross} rows)`)

    // the copy is independent of the template
    const cell = (await client.query(`SELECT c.id, c.control_type FROM zone_land_use_controls c
                                         JOIN plan_zone_type t ON t.id = c.plan_zone_type_id
                                         JOIN land_use_groups g ON g.id = c.land_use_group_id
                                        WHERE c.plan_instrument_id = $1 AND t.code = 'Communal Farming Zone' AND g.group_code = 'A'`, [adopted])).rows[0]
    const flipped = cell.control_type === 'prohibited' ? 'permitted' : 'prohibited'
    await client.query('UPDATE zone_land_use_controls SET control_type = $1 WHERE id = $2', [flipped, cell.id])
    const orig = (await client.query(`SELECT c.control_type FROM zone_land_use_controls c
                                         JOIN plan_zone_type t ON t.id = c.plan_zone_type_id
                                         JOIN land_use_groups g ON g.id = c.land_use_group_id
                                        WHERE c.plan_instrument_id = $1 AND t.code = 'Communal Farming Zone' AND g.group_code = 'A'`, [template.id])).rows[0]
    check(orig.control_type === cell.control_type, 'changing the copy does not change the template')
    const diff = (await client.query('SELECT * FROM plan_diff($1)', [adopted])).rows
    check(diff.length === 1 && diff[0].change === 'changed' && diff[0].template_decision === cell.control_type && diff[0].plan_decision === flipped,
      'plan_diff reports exactly the one changed cell')

    // land-use codes are per plan
    check((await client.query("SELECT COUNT(*)::int n FROM land_use_groups WHERE group_code = 'A' AND is_active")).rows[0].n === 2, "two plans can both have a land use 'A'")
    await expectError(client, 'a plan cannot have the same land-use code twice',
      "INSERT INTO land_use_groups (group_code, description, plan_instrument_id) VALUES ('A', 'Duplicate', $1)", [adopted], /duplicate key|unique/)
    await client.query("INSERT INTO land_use_groups (group_code, description, plan_instrument_id, is_active) VALUES ('ZZ', 'Plan-only use', $1, TRUE)", [adopted])
    const lu = async (plan) => (await client.query(LAND_USES_SQL, [plan])).rows.map((r) => r.group_code)
    check((await lu(adopted)).includes('ZZ') && !(await lu(template.id)).includes('ZZ'), "a land use added to one plan does not appear in another")

    // decisions stay inside one plan
    const adoptedType = (await client.query("SELECT id FROM plan_zone_type WHERE plan_instrument_id = $1 AND code = 'Game Corridor Zone'", [adopted])).rows[0].id
    const templateUse = (await client.query("SELECT id FROM land_use_groups WHERE plan_instrument_id = $1 AND group_code = 'U'", [template.id])).rows[0].id
    await expectError(client, "a decision cannot pair one plan's zone type with another plan's land use",
      "INSERT INTO zone_land_use_controls (plan_zone_type_id, land_use_group_id, control_type) VALUES ($1, $2, 'permitted')", [adoptedType, templateUse], /different plan/)

    // two palettes can be compared and combined without guessing
    check(ruralStarter && ruralStarter.decisions === 0 && ruralStarter.zone_types >= 10, 'the rural starter palette exists beside the sample template and carries no decisions')
    const cmp = (await client.query('SELECT class_code, presence FROM plan_compare($1, $2)', [template.id, ruralStarter.id])).rows
    check(cmp.some((r) => r.presence === 'both') && cmp.some((r) => r.presence === 'only_b' && /Mining/.test(r.class_code)),
      'plan_compare shows where the palettes overlap and what the starter adds (mining)')
    const imp = (await client.query("SELECT kind, code, outcome FROM import_plan_items($1, $2, ARRAY['Mining and Quarrying', 'Communal Agriculture', 'Game Park Zone'], ARRAY['M1', 'F1', 'A'])", [adopted, ruralStarter.id])).rows
    const outcome = (k, c) => (imp.find((r) => r.kind === k && r.code === c) || {}).outcome
    check(/^copied/.test(outcome('zone_type', 'Mining and Quarrying')) && /^copied/.test(outcome('land_use', 'M1')), 'import_plan_items copies a chosen zone type and land use')
    check(/not in source/.test(outcome('zone_type', 'Game Park Zone')) && /not in source/.test(outcome('land_use', 'A')), 'import_plan_items reports items the source lacks')
    check(/^copied/.test(outcome('zone_type', 'Communal Agriculture')) && /^copied/.test(outcome('land_use', 'F1')), 'import_plan_items copies other items the target lacks')
    const importedDecisions = (await client.query(`SELECT COUNT(*)::int n FROM zone_land_use_controls c JOIN plan_zone_type t ON t.id = c.plan_zone_type_id
                                                    WHERE t.plan_instrument_id = $1 AND t.code = 'Mining and Quarrying'`, [adopted])).rows[0].n
    check(importedDecisions === 0, 'imported items arrive with NO decisions')
    const again = (await client.query("SELECT outcome FROM import_plan_items($1, $2, ARRAY['Mining and Quarrying'], '{}')", [adopted, ruralStarter.id])).rows[0].outcome
    check(/^skipped/.test(again), 'importing the same item twice skips it instead of overwriting')
    await expectError(client, 'a profile cannot have two default templates',
      "UPDATE plan_instrument SET is_default_template = TRUE WHERE id = $1", [ruralStarter.id], /duplicate key|unique/)
    await expectError(client, 'only a template can be a default template',
      "UPDATE plan_instrument SET is_default_template = TRUE WHERE id = $1", [adopted], /check constraint/)

    // the readers see each plan separately
    const typeTotal = async (plan) => (await client.query(ZONE_TYPES_SQL, [plan])).rows.reduce((n, r) => n + r.permitted + r.special_consent + r.prohibited, 0)
    check((await typeTotal(adopted)) === (await typeTotal(template.id)), "the zone-type reader counts a plan's own decisions (the copy equals the template)")

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
