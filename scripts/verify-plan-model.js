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

  console.log("== Vungu's plan has a land-use vocabulary but no invented decisions")
  const vu = (await one(`SELECT (SELECT COUNT(*)::int FROM land_use_groups g WHERE g.plan_instrument_id = $1 AND g.is_active) AS uses,
                              (SELECT COUNT(*)::int FROM land_use_groups g WHERE g.plan_instrument_id = $1 AND g.derived_from_id IS NULL) AS no_provenance,
                              (SELECT COUNT(*)::int FROM zone_land_use_controls c WHERE c.plan_instrument_id = $1 AND c.deleted_at IS NULL AND c.derived_from_id IS NOT NULL) AS decisions`, [vplan.id]))
  check(vu.uses === template.land_uses, `Vungu's plan has the council use-class vocabulary (${vu.uses} land uses, the same as the sample template)`)
  check(vu.no_provenance === 0, 'every one of Vungu\'s land uses records where it came from')
  check(vu.decisions === 0, "no decision in Vungu's plan was copied from a template: its permitted / special consent / prohibited rules are the council's to state, not inferred")

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
    check((await client.query("SELECT COUNT(DISTINCT plan_instrument_id)::int n FROM land_use_groups WHERE group_code = 'A' AND is_active")).rows[0].n >= 2
       && (await client.query("SELECT 1 FROM land_use_groups WHERE group_code = 'A' AND is_active GROUP BY plan_instrument_id HAVING COUNT(*) > 1")).rows.length === 0,
      "several plans can each have a land use 'A', and no plan has it twice")
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

    // ---- Phase 2, slice 2: pathways, standards, parcel zoning, snapshots ----
    console.log('== pathways, standards, parcel zoning and application snapshots (Phase 2, slice 2)')
    const s263 = (await client.query("SELECT * FROM decision_pathway WHERE code = 's26_3_special_consent'")).rows[0]
    check(s263 && s263.requires_public_notice === true && s263.notice_at_applicant_cost === true && s263.adjacent_owners_notified === true,
      "the s26(3) pathway records the two confirmed facts: public notice at the applicant's expense, adjacent owners notified")
    check(s263 && s263.objection_days === null && s263.decision_body === null && s263.evidence_status === 'secondary_source',
      'the unknown facts (objection period, decision body) are blank, not guessed')
    check((await client.query("SELECT 1 FROM decision_pathway WHERE decision = 'permitted'")).rows.length === 0, 'no pathway is invented for "permitted" uses')
    await expectError(client, 'only one default pathway per decision',
      "INSERT INTO decision_pathway (code, name, decision, is_default_for_decision) VALUES ('dup_default', 'Dup', 'special_consent', TRUE)", [], /duplicate key|unique/)

    check((await client.query('SELECT COUNT(*)::int n FROM standard_kind')).rows[0].n >= 10, 'the standards vocabulary exists')
    check((await client.query('SELECT COUNT(*)::int n FROM plan_zone_standard s JOIN plan_zone_type t ON t.id = s.plan_zone_type_id WHERE t.plan_instrument_id = $1', [template.id])).rows[0].n === 0,
      'the template carries NO standard values (the unverified numbers were not migrated)')
    const communal = (await client.query("SELECT id FROM plan_zone_type WHERE plan_instrument_id = $1 AND code = 'Communal Farming Zone'", [adopted])).rows[0].id
    await expectError(client, 'a standard must have a limit, and min cannot exceed max',
      "INSERT INTO plan_zone_standard (plan_zone_type_id, kind_code, min_value, max_value) VALUES ($1, 'max_height', 10, 5)", [communal], /check constraint/)
    await expectError(client, "a standard cannot name another plan's land use",
      "INSERT INTO plan_zone_standard (plan_zone_type_id, kind_code, land_use_group_id, max_value) VALUES ($1, 'max_height', $2, 9)", [communal, templateUse], /different plan/)
    await client.query("INSERT INTO plan_zone_standard (plan_zone_type_id, kind_code, max_value, source_ref) VALUES ($1, 'max_height', 9, 'verification')", [communal])

    // adopting copies standards
    const tCommunal = (await client.query("SELECT id FROM plan_zone_type WHERE plan_instrument_id = $1 AND code = 'Communal Farming Zone'", [template.id])).rows[0].id
    await client.query("INSERT INTO plan_zone_standard (plan_zone_type_id, kind_code, min_value) VALUES ($1, 'min_stand_area', 12345)", [tCommunal])
    const second = (await client.query("SELECT adopt_plan_template($1, $2, 'Second verification adoption', 'local') AS id", [template.id, adopter])).rows[0].id
    const copiedStd = (await client.query('SELECT s.min_value FROM plan_zone_standard s JOIN plan_zone_type t ON t.id = s.plan_zone_type_id WHERE t.plan_instrument_id = $1', [second])).rows
    check(copiedStd.length === 1 && Number(copiedStd[0].min_value) === 12345, 'adopting copies the standards')

    // a decision that needs special consent, on the adopted plan's Communal Farming zone
    await client.query("UPDATE zone_land_use_controls SET control_type = 'special_consent' WHERE id = $1", [cell.id])

    // parcels: two adjacent zone squares and stands in different places (far from real data)
    const square = (x0, x1) => `ST_Multi(ST_GeomFromText('POLYGON((${x0} 10, ${x1} 10, ${x1} 10.01, ${x0} 10.01, ${x0} 10))', 4326))`
    const mkZone = async (name, typeId, x0, x1) => (await client.query(
      `INSERT INTO proposed_peri_urban_zones (zone, plan_instrument_id, plan_zone_type_id, geom) VALUES ($1, $2, $3, ${square(x0, x1)}) RETURNING id`, [name, adopted, typeId])).rows[0].id
    const zoneA = await mkZone('Verification zone A', communal, 10, 10.01)
    const zoneB = await mkZone('Verification zone B', adoptedType, 10.01, 10.02)
    const mkStand = async (no, x0, x1) => (await client.query(
      `INSERT INTO stands (stand_number, ward, area_sqm, geom) VALUES ($1, 'W0', 500, ST_GeomFromText('POLYGON((${x0} 10.002, ${x1} 10.002, ${x1} 10.004, ${x0} 10.004, ${x0} 10.002))', 4326)) RETURNING id`, [no])).rows[0].id
    const standIn = await mkStand('VERIFY-IN', 10.001, 10.002)
    const standSplit = await mkStand('VERIFY-SPLIT', 10.008, 10.0125)   // about 44% in A, 56% in B
    const standFar = await mkStand('VERIFY-FAR', 20, 20.001)

    const zoning = async (id) => (await client.query('SELECT * FROM compute_parcel_zoning($1, $2)', ['stands', id])).rows
    const zin = await zoning(standIn)
    check(zin.length === 1 && zin[0].zone_id === zoneA && Number(zin[0].share_pct) > 99 && zin[0].is_governing === true, 'a stand inside one zone: 100% in it, and it governs')
    const zsplit = await zoning(standSplit)
    const gov = zsplit.filter((r) => r.is_governing)
    check(zsplit.length === 2 && gov.length === 1 && gov[0].zone_id === zoneB && Math.abs(zsplit.reduce((n, r) => n + Number(r.share_pct), 0) - 100) < 0.1,
      'a stand across two zones: both returned, shares add up to 100%, the larger share governs')
    check((await zoning(standFar)).length === 0, 'a stand inside no zone is unzoned (no rows), not assumed zoned')
    await expectError(client, 'an unknown parcel layer is refused', "SELECT parcel_geometry('bogus', '1')", [], /unknown parcel layer/)

    await client.query("SELECT set_manual_parcel_zoning('stands', $1, $2, 'verification')", [standSplit, zoneA])
    await client.query("SELECT refresh_parcel_zoning('stands', $1)", [standSplit])
    const forSplit = (await client.query("SELECT zone_id, method FROM parcel_zoning_for('stands', $1) WHERE is_governing", [standSplit])).rows
    check(forSplit.length === 1 && forSplit[0].zone_id === zoneA && forSplit[0].method === 'manual', "a person's manual assignment wins over the intersection, and a refresh keeps it")

    // snapshots
    const snap = async (stand, use) => (await client.query("SELECT rule_snapshot('stands', $1, $2) AS j", [stand, use])).rows[0].j
    const sIn = await snap(standIn, 'A')
    const r0 = sIn.results[0]
    check(r0 && r0.plan.id === adopted && r0.decision === 'special_consent' && r0.decision_source === 'zone_type', 'the snapshot finds the plan, the zone type and its decision for the land use')
    check(r0 && r0.pathway && r0.pathway.code === 's26_3_special_consent' && r0.pathway_source === 'default' && r0.pathway.objection_days === null,
      'a special-consent decision gets the s26(3) pathway by default, with the unknown objection period left null')
    check(r0 && r0.standards.length === 1 && r0.standards[0].kind === 'max_height', "the snapshot includes the zone type's standards")
    const sNone = await snap(standIn, 'QQ')
    check(sNone.results[0].decision === null && sNone.results[0].land_use === null, 'a land use the plan does not have is "not decided", never allowed')
    check((await snap(standFar, 'A')).unzoned === true, 'the snapshot of an unzoned stand says so')

    // provisional rules (migration 161): a draft plan and an unreviewed column say so in the snapshot
    check(sIn.provisional === true && r0.plan.provisional === true && r0.zone.review_status === 'unreviewed',
      'a snapshot of a draft plan is marked provisional, with the zone column unreviewed')
    check((await snap(standFar, 'A')).provisional === false, 'a snapshot of an unzoned stand is not provisional (nothing to qualify)')
    const reviewZt = (await client.query('SELECT plan_zone_type_id AS id FROM zone_land_use_controls WHERE id = $1', [cell.id])).rows[0].id
    await expectError(client, 'a review needs the reviewer\'s name', "SELECT set_zone_type_review($1, 'reviewed', '')", [reviewZt], /name of the reviewer/)
    await expectError(client, 'an unknown review status is refused', "SELECT set_zone_type_review($1, 'approved', 'x')", [reviewZt], /review status/)
    await client.query("SELECT set_zone_type_review($1, 'reviewed', 'Verification Planner')", [reviewZt])
    const rv = (await client.query('SELECT review_status, reviewed_by, reviewed_at IS NOT NULL AS dated FROM plan_zone_type WHERE id = $1', [reviewZt])).rows[0]
    check(rv.review_status === 'reviewed' && rv.reviewed_by === 'Verification Planner' && rv.dated, 'a column can be marked reviewed, by whom and when')
    check((await snap(standIn, 'A')).results[0].zone.review_status === 'reviewed' && (await snap(standIn, 'A')).provisional === true,
      'a reviewed column in a plan that is not in force is still provisional')
    check((await client.query("SELECT COUNT(*)::int n FROM plan_event WHERE plan_instrument_id = $1 AND event_type = 'zone_review'", [adopted])).rows[0].n === 1, 'the review is recorded in the plan\'s history')
    await client.query("UPDATE zone_land_use_controls SET conditions = 'edited after review' WHERE id = $1", [cell.id])
    check((await client.query('SELECT review_status FROM plan_zone_type WHERE id = $1', [reviewZt])).rows[0].review_status === 'in_review',
      'editing a decision in a reviewed column puts the column back in review')
    await client.query("UPDATE zone_land_use_controls SET conditions = NULL WHERE id = $1", [cell.id])

    await client.query("INSERT INTO decision_pathway (code, name, decision) VALUES ('verify_own_pathway', 'Own pathway', 'special_consent')")
    await client.query('UPDATE zone_land_use_controls SET pathway_code = $1 WHERE id = $2', ['verify_own_pathway', cell.id])
    const sOwn = (await snap(standIn, 'A')).results[0]
    check(sOwn.pathway.code === 'verify_own_pathway' && sOwn.pathway_source === 'decision', 'a pathway named on the decision overrides the default')

    // permits: the parcel is linked at lodgement, and the rules are an append-only history
    const mkPermit = async (stand, ward, lng, lat) => (await client.query(
      `INSERT INTO spatial_planning.permit_application (applicant_name, development_type, stand_number, suburb_ward, location)
       VALUES ('Verify Applicant', 'new_building', $1, $2, ${lng === undefined ? 'NULL' : 'ST_SetSRID(ST_MakePoint($3, $4), 4326)'}) RETURNING id`,
      lng === undefined ? [stand, ward] : [stand, ward, lng, lat])).rows[0].id
    const lodge = async (id) => (await client.query('SELECT spatial_planning.lodge_permit_zoning($1) AS m', [id])).rows[0].m
    const permitRow = async (id) => (await client.query('SELECT authority_id, parcel_layer, parcel_id, parcel_match, plan_instrument_id FROM spatial_planning.permit_application WHERE id = $1', [id])).rows[0]
    const snaps = async (id) => (await client.query('SELECT kind, land_use_code, snapshot FROM spatial_planning.permit_rule_snapshot WHERE permit_id = $1 ORDER BY taken_at, id', [id])).rows

    const permitIn = await mkPermit('VERIFY-IN', null)
    check((await lodge(permitIn)) === 'matched', 'lodgement matches a stand number to its parcel')
    const pIn = await permitRow(permitIn)
    check(pIn.parcel_layer === 'stands' && pIn.parcel_id === standIn && pIn.plan_instrument_id === adopted && pIn.authority_id !== null,
      'the permit records its parcel, the plan found to govern it, and an authority')
    const sn0 = await snaps(permitIn)
    check(sn0.length === 1 && sn0[0].kind === 'lodgement' && sn0[0].land_use_code === null && sn0[0].snapshot.results[0].decision === null,
      'the lodgement snapshot records the zoning but no decision (the citizen form names no land use)')
    await lodge(permitIn)
    check((await snaps(permitIn)).length === 1, 'lodging twice does not add a second lodgement snapshot')

    const permitNone = await mkPermit('NOPE-999', null)
    check((await lodge(permitNone)) === 'unmatched' && (await permitRow(permitNone)).parcel_layer === null && (await snaps(permitNone)).length === 0,
      'a stand number that matches nothing is recorded as unmatched, not rejected or guessed')

    const dupStand = (await client.query(`INSERT INTO stands (stand_number, ward, area_sqm, geom) VALUES ('VERIFY-IN', 'W1', 500, ST_GeomFromText('POLYGON((10.003 10.002, 10.004 10.002, 10.004 10.004, 10.003 10.004, 10.003 10.002))', 4326)) RETURNING id`)).rows[0].id
    const permitAmb = await mkPermit('VERIFY-IN', null)
    check((await lodge(permitAmb)) === 'ambiguous' && (await permitRow(permitAmb)).parcel_layer === null, 'a stand number matching two stands is ambiguous: none is chosen')
    const permitWard = await mkPermit('VERIFY-IN', 'W1')
    check((await lodge(permitWard)) === 'matched' && (await permitRow(permitWard)).parcel_id === dupStand, 'the ward narrows two candidates to one')

    const permitLoc = await mkPermit(null, null, 20.0005, 10.003)
    check((await lodge(permitLoc)) === 'by_location', 'with no stand number, exactly one stand under the location is found by location')

    // assessment: the planner picks the land use; history is kept, never rewritten
    await expectError(client, 'an assessment needs a parcel first', "SELECT spatial_planning.take_permit_assessment_snapshot($1, 'A', NULL)", [permitNone], /has no parcel/)
    const a1 = await client.query("SELECT spatial_planning.take_permit_assessment_snapshot($1, 'A', NULL) AS s", [permitIn])
    check(a1.rows[0].s.results.length === 1 && a1.rows[0].s.results[0].decision === 'special_consent', 'the assessment snapshot gives the decision under the plan recorded at lodgement')
    await client.query("UPDATE zone_land_use_controls SET control_type = 'prohibited' WHERE id = $1", [cell.id])
    await client.query("SELECT spatial_planning.take_permit_assessment_snapshot($1, 'A', NULL)", [permitIn])
    const hist = (await snaps(permitIn)).filter((r) => r.kind === 'assessment')
    check(hist.length === 2 && hist[0].snapshot.results[0].decision === 'special_consent' && hist[1].snapshot.results[0].decision === 'prohibited',
      'a later change to the plan gives a new snapshot; the earlier one is kept as it was')
    await expectError(client, 'a stored snapshot cannot be rewritten', "UPDATE spatial_planning.permit_rule_snapshot SET snapshot = '{}'::jsonb WHERE permit_id = $1", [permitIn], /append-only/)

    await client.query("SELECT spatial_planning.set_permit_parcel($1, 'stands', $2, NULL)", [permitNone, standIn])
    const fixed = await permitRow(permitNone)
    check(fixed.parcel_match === 'manual' && fixed.parcel_id === standIn && (await snaps(permitNone)).some((r) => r.kind === 'parcel_corrected'),
      'staff can set the parcel on an unmatched permit, recorded as a manual correction')
    await expectError(client, 'staff cannot set a parcel that does not exist', "SELECT spatial_planning.set_permit_parcel($1, 'stands', '00000000-0000-0000-0000-000000000000', NULL)", [permitNone], /no parcel/)

    // two plans cover one parcel: neither is picked
    const copyPlan = (await client.query("SELECT id FROM plan_instrument WHERE id = $1", [second])).rows[0].id
    const copyType = (await client.query("SELECT id FROM plan_zone_type WHERE plan_instrument_id = $1 AND code = 'Communal Farming Zone'", [copyPlan])).rows[0].id
    await client.query(`INSERT INTO proposed_peri_urban_zones (zone, plan_instrument_id, plan_zone_type_id, geom) VALUES ('Verification overlap', $1, $2, ${square(10, 10.01)})`, [copyPlan, copyType])
    const permitTwo = await mkPermit('VERIFY-FAR-IN', null, 10.0015, 10.003)
    await client.query('UPDATE spatial_planning.permit_application SET stand_number = $2 WHERE id = $1', [permitTwo, 'VERIFY-IN'])
    await client.query('DELETE FROM stands WHERE id = $1', [dupStand])
    check((await lodge(permitTwo)) === 'matched' && (await permitRow(permitTwo)).plan_instrument_id === null
      && (await snaps(permitTwo))[0].snapshot.results.filter((r) => r.governing).length === 2,
      'a parcel covered by two plans keeps both in the snapshot and records no single plan')

    // Vungu's own plan: the use exists, the decision does not (and is never invented)
    await client.query(`INSERT INTO proposed_peri_urban_zones (zone, geom) VALUES ('Verification Vungu zone', ${square(30, 30.01)})`)
    await client.query(`INSERT INTO stands (stand_number, ward, area_sqm, geom) VALUES ('VERIFY-VUNGU', 'W0', 500, ST_GeomFromText('POLYGON((30.002 10.002, 30.003 10.002, 30.003 10.004, 30.002 10.004, 30.002 10.002))', 4326))`)
    const vStand = (await client.query("SELECT id FROM stands WHERE stand_number = 'VERIFY-VUNGU'")).rows[0].id
    const vSnap = (await snap(vStand, 'A')).results[0]
    check(vSnap && vSnap.plan.id === vplan.id && vSnap.land_use && vSnap.land_use.code === 'A' && vSnap.decision === null,
      "in Vungu's plan the land use is found and the decision is 'not decided', never invented")

    // renaming a zone polygon (e.g. fixing a typo in QGIS) keeps its zone type in step
    const mkVZone = async (name) => (await client.query(
      `INSERT INTO proposed_peri_urban_zones (zone, geom) VALUES ($1, ${square(40, 40.01)}) RETURNING id, plan_zone_type_id`, [name])).rows[0]
    const rename = async (id, name) => (await client.query('UPDATE proposed_peri_urban_zones SET zone = $2 WHERE id = $1 RETURNING plan_zone_type_id', [id, name])).rows[0].plan_zone_type_id
    const typeCode = async (id) => ((await client.query('SELECT code FROM plan_zone_type WHERE id = $1', [id])).rows[0] || {}).code

    const zr1 = await mkVZone('Typo Zonee')
    const zr1Type = await rename(zr1.id, 'Typo Zone')
    check(zr1Type === zr1.plan_zone_type_id && (await typeCode(zr1Type)) === 'Typo Zone', 'fixing a typo in a zone name renames its zone type in place when nothing else depends on it')

    const zr2 = await mkVZone('Ruled Zonee')
    await client.query("INSERT INTO zone_land_use_controls (plan_zone_type_id, land_use_group_id, control_type) SELECT $1, id, 'permitted' FROM land_use_groups WHERE plan_instrument_id = $2 AND group_code = 'A'", [zr2.plan_zone_type_id, vplan.id])
    const zr2Type = await rename(zr2.id, 'Ruled Zone')
    check(zr2Type !== zr2.plan_zone_type_id && (await typeCode(zr2Type)) === 'Ruled Zone' && (await typeCode(zr2.plan_zone_type_id)) === 'Ruled Zonee',
      'a zone type that already has decisions is not renamed: the polygon gets a new type and the old one keeps its rules for a person to resolve')

    const zr3a = await mkVZone('Shared Zonee')
    const zr3b = await mkVZone('Shared Zonee')
    const zr3Type = await rename(zr3a.id, 'Shared Zone')
    check(zr3Type !== zr3a.plan_zone_type_id && (await typeCode(zr3b.plan_zone_type_id)) === 'Shared Zonee',
      'renaming one of two polygons that share a zone type does not rename the type under the other')

    const zr4 = await mkVZone('Elsewhere')
    check((await rename(zr4.id, 'Typo Zone')) === zr1Type, 'renaming a polygon to an existing zone name moves it to that zone type')

    // ---- Phase 3: the workbench's rules (sign-off, status chain, freeze, versions) ----
    console.log('== workbench: sign-off, status chain, freeze and versions (Phase 3)')
    const status = async (id) => (await client.query('SELECT status FROM plan_instrument WHERE id = $1', [id])).rows[0].status
    const setStatus = (id, to, ref, from) => client.query('SELECT set_plan_status($1, $2, NULL, $3, $4, $5)', [id, to, 'verify', ref || null, from || null])

    await expectError(client, 'a plan cannot skip public notice', "SELECT set_plan_status($1, 'approved', NULL, 'verify')", [adopted], /cannot go from draft to approved/)
    await expectError(client, 'a template has no status to change', "SELECT set_plan_status($1, 'public_notice', NULL, 'verify')", [template.id], /template/)
    await setStatus(adopted, 'public_notice')
    await expectError(client, 'approval needs a sign-off', "SELECT set_plan_status($1, 'approved', NULL, 'verify')", [adopted], /current sign-off/)
    await client.query("SELECT sign_off_plan($1, NULL, 'Verification Planner', 'planner', 'checked')", [adopted])
    check((await client.query('SELECT plan_signoff_is_current($1) AS ok', [adopted])).rows[0].ok === true, 'a sign-off is current while the plan is unchanged')
    await client.query("UPDATE zone_land_use_controls SET control_type = 'permitted' WHERE id = $1", [cell.id])
    check((await client.query('SELECT plan_signoff_is_current($1) AS ok', [adopted])).rows[0].ok === false, 'any edit after sign-off makes the sign-off stale')
    await expectError(client, 'a stale sign-off cannot approve', "SELECT set_plan_status($1, 'approved', NULL, 'verify')", [adopted], /current sign-off/)
    await expectError(client, 'a sign-off needs the signer\'s name', "SELECT sign_off_plan($1, NULL, '', 'planner')", [adopted], /name/)
    await client.query("SELECT sign_off_plan($1, NULL, 'Verification Planner', 'planner', 'rechecked')", [adopted])
    await setStatus(adopted, 'approved')
    check((await status(adopted)) === 'approved', 'with a current sign-off the plan can be approved')

    await expectError(client, 'an approved plan\'s decisions cannot be edited', "UPDATE zone_land_use_controls SET control_type = 'prohibited' WHERE id = $1", [cell.id], /approved and cannot be edited/)
    await expectError(client, 'an approved plan\'s land uses cannot be added to', "INSERT INTO land_use_groups (group_code, description, plan_instrument_id, is_active) VALUES ('ZZ2', 'x', $1, TRUE)", [adopted], /approved and cannot be edited/)
    await expectError(client, 'an approved plan\'s standards cannot be added to', "INSERT INTO plan_zone_standard (plan_zone_type_id, kind_code, max_value) VALUES ($1, 'max_storeys', 2)", [communal], /approved and cannot be edited/)
    await expectError(client, 'gazetting needs a gazette reference', "SELECT set_plan_status($1, 'gazetted', NULL, 'verify')", [adopted], /gazette reference/)
    await expectError(client, 'gazetting needs an effective date', "SELECT set_plan_status($1, 'gazetted', NULL, 'verify', 'SI 1 of 2026', NULL)", [adopted], /effective date/)
    await setStatus(adopted, 'gazetted', 'SI 1 of 2026', '2026-01-01')
    const gz = (await client.query('SELECT status, gazette_ref, effective_from FROM plan_instrument WHERE id = $1', [adopted])).rows[0]
    check(gz.status === 'gazetted' && gz.gazette_ref === 'SI 1 of 2026' && gz.effective_from !== null, 'gazetting records the reference and effective date')

    // a change is a new version
    await client.query("SELECT set_zone_type_review($1, 'reviewed', 'Verification Planner')", [reviewZt])
    const v2 = (await client.query('SELECT new_plan_version($1, NULL, $2) AS id', [adopted, 'verify'])).rows[0].id
    check((await client.query("SELECT COUNT(*)::int n FROM plan_zone_type WHERE plan_instrument_id = $1 AND review_status = 'reviewed' AND reviewed_by = 'Verification Planner'", [v2])).rows[0].n === 1,
      'a new version keeps the review state of a column it copies unchanged')
    const v2row = (await client.query('SELECT version, status, supersedes_id FROM plan_instrument WHERE id = $1', [v2])).rows[0]
    check(v2row.version === 2 && v2row.status === 'draft' && v2row.supersedes_id === adopted, 'a new version is the next draft and supersedes the old one')
    const counts = async (id) => (await client.query('SELECT zone_types, land_uses, decisions FROM plan_instrument_summary WHERE id = $1', [id])).rows[0]
    const c1 = await counts(adopted)
    const c2 = await counts(v2)
    check(c1.decisions === c2.decisions && c1.land_uses === c2.land_uses && c1.zone_types === c2.zone_types, 'the new version is a complete copy')
    await expectError(client, 'only one open newer version at a time', 'SELECT new_plan_version($1, NULL, $2)', [adopted, 'verify'], /newer version of this plan already exists/)
    check((await client.query('SELECT COUNT(*)::int n FROM plan_decision_diff($1, $2)', [adopted, v2])).rows[0].n === 0, 'a fresh version has no difference from the one before')
    await client.query("UPDATE zone_land_use_controls SET control_type = 'prohibited' WHERE plan_instrument_id = $1 AND derived_from_id = $2", [v2, cell.id])
    const vd = (await client.query('SELECT * FROM plan_decision_diff($1, $2)', [adopted, v2])).rows
    check(vd.length === 1 && vd[0].change === 'changed' && vd[0].to_decision === 'prohibited', 'the diff against the previous version shows exactly the change')
    check((await client.query('SELECT COUNT(*)::int n FROM plan_diff($1)', [v2])).rows[0].n >= 0, 'plan_diff (against the template) still works')

    // putting the new version in force moves the zone polygons and supersedes the old one
    const onOld = (await client.query('SELECT COUNT(*)::int n FROM proposed_peri_urban_zones WHERE plan_instrument_id = $1', [adopted])).rows[0].n
    await setStatus(v2, 'public_notice')
    await client.query("SELECT sign_off_plan($1, NULL, 'Verification Planner', 'planner')", [v2])
    await setStatus(v2, 'approved')
    await setStatus(v2, 'gazetted', 'SI 2 of 2026', '2026-06-01')
    const movedTo = (await client.query('SELECT COUNT(*)::int n FROM proposed_peri_urban_zones WHERE plan_instrument_id = $1', [v2])).rows[0].n
    check(onOld > 0 && movedTo > 0 && (await status(adopted)) === 'superseded', 'gazetting the new version supersedes the old and moves its zone polygons to it')
    const sup = (await client.query("SELECT detail FROM plan_event WHERE plan_instrument_id = $1 AND event_type = 'superseded'", [adopted])).rows[0]
    check(sup && sup.detail.polygons_moved === movedTo, 'the move is recorded as an event on the old plan')
    const ends = (await client.query('SELECT effective_to FROM plan_instrument WHERE id = $1', [adopted])).rows[0]
    check(ends.effective_to !== null, 'the superseded plan ends the day before the new one takes effect')

    const ev = (await client.query("SELECT event_type FROM plan_event WHERE plan_instrument_id = $1 ORDER BY at", [adopted])).rows.map((r) => r.event_type)
    check(ev.includes('signed_off') && ev.filter((e) => e === 'status_changed').length >= 3 && ev.includes('new_version_started') && ev.includes('superseded'),
      'every step is in the plan\'s event history')
    await expectError(client, 'events cannot be rewritten', "UPDATE plan_event SET event_type = 'x' WHERE plan_instrument_id = $1", [adopted], /append-only/)
    await expectError(client, 'sign-offs cannot be rewritten', "UPDATE plan_signoff SET comment = 'x' WHERE plan_instrument_id = $1", [adopted], /append-only/)
    console.log('== matrix reference data and audit (migrations 156-160)')
    const act = (await client.query('SELECT code FROM development_activity ORDER BY code')).rows.map((r) => r.code)
    check(['new_building', 'alteration', 'extension', 'change_of_use', 'subdivision', 'consolidation', 'rezoning', 'other'].every((c) => act.includes(c)),
      'the eight kinds of development the permit could always record are all in development_activity')
    await expectError(client, 'a permit cannot be for an unknown kind of development',
      "INSERT INTO spatial_planning.permit_application (applicant_name, development_type) VALUES ('x', 'teleportation')", [], /foreign key|development_type/)
    check((await client.query("SELECT COUNT(*)::int n FROM activity_standard_kind WHERE activity_code = 'subdivision' AND kind_code IN ('min_stand_area', 'min_frontage')")).rows[0].n === 2,
      'a subdivision is tested against minimum stand area and frontage')
    await expectError(client, 'an activity cannot be linked to a standard kind that does not exist',
      "INSERT INTO activity_standard_kind (activity_code, kind_code) VALUES ('subdivision', 'nonsense')", [], /foreign key/)
    const tree = (await client.query("SELECT group_code, parent_group_code, parent_group_id IS NOT NULL AS resolved FROM land_use_group_tree WHERE plan_instrument_id = $1 AND group_code IN ('A', 'A1', 'D1', 'L1')", [vplan.id])).rows
    const t = Object.fromEntries(tree.map((r) => [r.group_code, r]))
    check(t.A && t.A.parent_group_code === null && t.A1.parent_group_code === 'A' && t.A1.resolved && t.D1.parent_group_code === 'D' && t.D1.resolved,
      "A1 is under A and D1 under D in Vungu's plan")
    check(t.L1 && t.L1.parent_group_code === 'L' && !t.L1.resolved, 'L1 names a class (L) that the plan does not have, and shows no parent')
    check((await client.query("SELECT COUNT(*)::int n FROM information_schema.columns WHERE table_schema = 'spatial_planning' AND table_name = 'existing_use' AND column_name = 'land_use_group_code'")).rows[0].n === 1,
      'an existing use can be recorded as a land-use group code')
    check((await client.query('SELECT land_use_group_for($1, $2) AS id', [vplan.id, 'D1'])).rows[0].id !== null && (await client.query("SELECT land_use_group_for($1, 'QQ') AS id", [vplan.id])).rows[0].id === null,
      'land_use_group_for finds a group by code in a plan, and nothing for an unknown code')

    // a scratch plan that does each thing the audit looks for
    const aud = (await client.query("INSERT INTO plan_instrument (authority_id, profile_id, plan_type, title, status) SELECT $1, id, 'local', 'Audit fixture', 'draft' FROM plan_profile WHERE code = 'urban' RETURNING id", [combo])).rows[0].id
    const use = {}
    for (const [code, order] of [['A', 1], ['A1', 2], ['B', 3], ['C', 4], ['D', 5], ['E', 6], ['F', 7], ['G', 8], ['H', 9], ['I', 10], ['J', 11], ['L1', 12]]) {
      use[code] = (await client.query("INSERT INTO land_use_groups (group_code, description, group_category, plan_instrument_id, is_active, display_order) VALUES ($1, $4, 'residential', $2, TRUE, $3) RETURNING id", [code, aud, order, 'use ' + code])).rows[0].id
    }
    await client.query("INSERT INTO land_use_group_class (land_use_group_id, scheme, code, relation, status) VALUES ($1, 'HILUCS', '5_1_ResidentialUse', 'within', 'proposed'), ($2, 'HILUCS', '5_1_ResidentialUse', 'within', 'proposed')", [use.A, use.A1])
    const zone = async (code, category) => (await client.query("INSERT INTO plan_zone_type (plan_instrument_id, code, name, category) VALUES ($1, $2, $4, $3) RETURNING id", [aud, code, category, "zone " + code])).rows[0].id
    const decide = async (zid, fn) => { for (const code of Object.keys(use)) { const v = fn(code); if (v) await client.query('INSERT INTO zone_land_use_controls (plan_zone_type_id, land_use_group_id, control_type) VALUES ($1, $2, $3)', [zid, use[code], v]) } }
    const zRes = await zone('RES-NODWELL', 'residential'); await decide(zRes, (c) => (c === 'A' || c === 'B' ? 'prohibited' : 'special_consent'))
    const zCopy = await zone('RES-COPY', 'residential'); await decide(zCopy, (c) => (c === 'A' || c === 'B' ? 'prohibited' : 'special_consent'))
    const zAll = await zone('EVERYTHING', 'mixed'); await decide(zAll, () => 'permitted')
    const zGap = await zone('GAPPY', 'commercial'); await decide(zGap, (c) => (['A', 'B', 'C'].includes(c) ? null : c === 'D' ? 'permitted' : 'prohibited'))
    const zOk = await zone('CONSIDERED', 'residential'); await decide(zOk, (c) => (c === 'A' ? 'permitted' : c === 'A1' ? 'prohibited' : c === 'D' ? 'special_consent' : c === 'E' ? 'permitted' : c === 'F' ? 'prohibited' : c === 'G' ? 'special_consent' : c === 'H' ? 'prohibited' : c === 'I' ? 'permitted' : c === 'J' ? 'prohibited' : c === 'L1' ? 'permitted' : 'special_consent'))
    const findings = (await client.query('SELECT severity, kind, zone_code, group_code FROM plan_matrix_audit WHERE plan_instrument_id = $1', [aud])).rows
    const has = (kind, zone2) => findings.some((f) => f.kind === kind && (zone2 === undefined || f.zone_code === zone2))
    check(has('residential_zone_without_dwellings', 'RES-NODWELL') && has('residential_zone_without_dwellings', 'RES-COPY'), 'a residential zone that permits no dwelling outright is an error')
    check(!has('residential_zone_without_dwellings', 'CONSIDERED'), 'a residential zone that does permit a dwelling is not')
    check(has('near_identical_columns', 'RES-NODWELL') || has('near_identical_columns', 'RES-COPY'), 'two zones that decide every use the same way are reported')
    check(has('default_fill', 'EVERYTHING') && !has('default_fill', 'CONSIDERED'), 'a zone that permits everything is reported as a default fill; a considered one is not')
    check(has('no_decision', 'GAPPY') && !has('no_decision', 'CONSIDERED'), 'a zone with gaps is reported, listing them')
    check(has('special_consent_without_condition', 'CONSIDERED'), 'special-consent decisions with no condition are reported for review')
    check(findings.some((f) => f.kind === 'sub_class_without_class' && f.group_code === 'L1'), 'L1 without an L class is reported')
    check(findings.every((f) => ['error', 'warning', 'review'].includes(f.severity)), 'every finding has a severity')
    const auditSum = (await client.query('SELECT errors, warnings, reviews FROM plan_matrix_audit_summary WHERE plan_instrument_id = $1', [aud])).rows[0]
    check(Number(auditSum.errors) >= 2 && Number(auditSum.warnings) >= 3 && Number(auditSum.reviews) >= 2, `the summary counts them (${auditSum.errors} errors, ${auditSum.warnings} warnings, ${auditSum.reviews} reviews)`)
    check((await client.query("SELECT COUNT(*)::int n FROM plan_matrix_audit WHERE plan_instrument_id = (SELECT id FROM plan_instrument WHERE is_default_template AND profile_id = (SELECT id FROM plan_profile WHERE code = 'urban'))")).rows[0].n === 0,
      'the audit reports nothing for the urban starter palette (it has no decisions, and does not use the lettered schedule)')

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
