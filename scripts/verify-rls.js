#!/usr/bin/env node
/**
 * Prove row-level security by authority (migration 154). Changes nothing: everything runs in one
 * transaction that is rolled back.
 *
 *   node scripts/verify-rls.js
 *
 * It builds three authorities (A, B, and a combination C of both), plans and permits for each, then
 * looks at the data AS vungu_app with different people's settings, the same way the API does
 * (src/lib/tenancy.js). It checks what each can see, what each can write, that the public sees only
 * published things, that a missing setting fails closed, and that the superuser path used by code that
 * has not opted in is unchanged.
 */
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

let failures = 0
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failures++ }

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const c = await pool.connect()
  const q = async (sql, p) => (await c.query(sql, p)).rows
  const one = async (sql, p) => (await q(sql, p))[0]

  // Act as the API does for a request: step into vungu_app with that person's settings.
  const as = async ({ user = '', authority = '', platform = false } = {}) => {
    await c.query('RESET ROLE')
    await c.query("SELECT set_config('app.user_id', $1, true), set_config('app.authority_id', $2, true), set_config('app.platform', $3, true)",
      [user, String(authority ?? ''), platform ? 'on' : ''])
    await c.query('SET LOCAL ROLE vungu_app')
  }
  const asSuper = async () => { await c.query('RESET ROLE') }
  const expectRefused = async (msg, sql, p) => {
    await c.query('SAVEPOINT s')
    try { await c.query(sql, p); await c.query('ROLLBACK TO SAVEPOINT s'); check(false, `${msg} (it was allowed)`) }
    catch (err) { await c.query('ROLLBACK TO SAVEPOINT s'); check(/row-level security|violates|permission/i.test(err.message), `${msg} -> refused: ${err.message.slice(0, 70)}`) }
  }

  try {
    await c.query('BEGIN')
    check((await one("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'vungu_app'")), 'the vungu_app role exists')
    const role = await one("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'vungu_app'")
    check(role.rolsuper === false && role.rolbypassrls === false, 'vungu_app is neither a superuser nor able to bypass row-level security')

    // ---- fixtures (as the superuser) ----
    const auth = async (code, kind) => (await one("INSERT INTO local_authorities (authority_name, code, kind, authority_type) VALUES ($1, $2, $3, 'test') RETURNING id", [`RLS ${code}`, `RLS${code}`, kind])).id
    const A = await auth('A', 'rural'), B = await auth('B', 'rural'), C = await auth('C', 'combination')
    await c.query('INSERT INTO authority_member (combination_id, member_id) VALUES ($1, $2), ($1, $3)', [C, A, B])
    const profile = (await one("SELECT id FROM plan_profile WHERE code = 'rural'")).id
    const plan = async (authority, title, status = 'draft') => (await one(
      "INSERT INTO plan_instrument (authority_id, profile_id, plan_type, title, status) VALUES ($1, $2, 'local', $3, $4) RETURNING id", [authority, profile, title, status])).id
    const planA = await plan(A, 'RLS plan A'), planB = await plan(B, 'RLS plan B'), planC = await plan(C, 'RLS plan C'), pubB = await plan(B, 'RLS gazetted B', 'gazetted')
    const template = (await one('SELECT id FROM plan_instrument WHERE is_default_template AND profile_id = $1', [profile])).id
    const zt = async (p, code) => (await one("INSERT INTO plan_zone_type (plan_instrument_id, code, name) VALUES ($1, $2, $2) RETURNING id", [p, code])).id
    const ztA = await zt(planA, 'ZA'); const ztB = await zt(planB, 'ZB')
    await c.query("INSERT INTO land_use_groups (group_code, description, plan_instrument_id) VALUES ('RA', 'a use', $1), ('RB', 'a use', $2)", [planA, planB])
    await c.query("INSERT INTO plan_zone_standard (plan_zone_type_id, kind_code, max_value) VALUES ($1, 'max_height', 9), ($2, 'max_height', 12)", [ztA, ztB])
    const cit = (await one("INSERT INTO users (email, password_hash, role, name) VALUES ('rls-citizen@x.test', 'x', 'registered', 'Citizen') RETURNING id")).id
    const cit2 = (await one("INSERT INTO users (email, password_hash, role, name) VALUES ('rls-citizen2@x.test', 'x', 'registered', 'Citizen Two') RETURNING id")).id
    const permit = async (authority, by, stand) => (await one(
      "INSERT INTO spatial_planning.permit_application (applicant_name, development_type, stand_number, authority_id, created_by) VALUES ('RLS applicant', 'new_building', $1, $2, $3) RETURNING id", [stand, authority, by])).id
    const pA = await permit(A, cit, 'RLS-A'), pB = await permit(B, cit2, 'RLS-B')
    await c.query("INSERT INTO spatial_planning.permit_rule_snapshot (permit_id, kind, snapshot) VALUES ($1, 'lodgement', '{}'), ($2, 'lodgement', '{}')", [pA, pB])

    const staff = (await one("INSERT INTO users (email, password_hash, role, name) VALUES ('rls-staff@x.test', 'x', 'planner', 'Staff') RETURNING authority_id")).authority_id
    check(staff !== null, 'a new staff user with no authority is given one (the transitional default)')

    const titles = async () => (await q("SELECT title FROM plan_instrument WHERE title LIKE 'RLS %' ORDER BY title")).map((r) => r.title.replace('RLS ', ''))
    const stands = async () => (await q("SELECT stand_number FROM spatial_planning.permit_application WHERE stand_number LIKE 'RLS-%' ORDER BY 1")).map((r) => r.stand_number)

    // ---- what each person sees ----
    console.log('== plans')
    await as({ authority: A })
    check(JSON.stringify(await titles()) === JSON.stringify(['gazetted B', 'plan A', 'plan C']), "staff of A see their own plan, the combination's, and B's gazetted plan, but not B's draft")
    check((await one('SELECT COUNT(*)::int n FROM plan_instrument WHERE id = $1', [template])).n === 1, 'a template is visible to everyone')
    await as({ authority: B })
    check(JSON.stringify(await titles()) === JSON.stringify(['gazetted B', 'plan B', 'plan C']), "staff of B see theirs, the combination's and their own gazetted plan, not A's draft")
    await as({})
    check(JSON.stringify(await titles()) === JSON.stringify(['gazetted B']), 'the public sees only the gazetted plan')
    check((await one('SELECT COUNT(*)::int n FROM plan_instrument WHERE id = $1', [template])).n === 1, 'the public can read a template')
    await as({ platform: true })
    check((await titles()).length === 4, 'a platform operator sees all four')

    console.log('== what hangs off a plan follows the plan')
    await as({ authority: A })
    check((await one("SELECT COUNT(*)::int n FROM plan_zone_type WHERE code IN ('ZA', 'ZB')")).n === 1, "A sees A's zone type and not B's")
    check((await one("SELECT COUNT(*)::int n FROM land_use_groups WHERE group_code IN ('RA', 'RB')")).n === 1, "A sees A's land use and not B's")
    check((await one('SELECT COUNT(*)::int n FROM plan_zone_standard')).n >= 1 && (await one(`SELECT COUNT(*)::int n FROM plan_zone_standard WHERE plan_zone_type_id = $1`, [ztB])).n === 0, "A cannot see B's standards (reached through the zone type)")
    check((await one("SELECT COUNT(*)::int n FROM plan_instrument_summary WHERE title LIKE 'RLS %'")).n === 3, 'the summary view runs with the caller\'s rights (A sees 3 of 4)')

    console.log('== writing')
    await as({ authority: A })
    await expectRefused("A cannot create a plan for B", "INSERT INTO plan_instrument (authority_id, profile_id, plan_type, title) VALUES ($1, $2, 'local', 'RLS sneaky')", [B, profile])
    check((await one("INSERT INTO plan_instrument (authority_id, profile_id, plan_type, title) VALUES ($1, $2, 'local', 'RLS A second') RETURNING id", [A, profile])).id !== undefined, 'A can create a plan for itself')
    check((await c.query("UPDATE plan_instrument SET notes = 'x' WHERE id = $1", [planB])).rowCount === 0, "A's update of B's plan touches no row")
    check((await c.query('DELETE FROM plan_instrument WHERE id = $1', [planB])).rowCount === 0, "A's delete of B's plan touches no row")
    check((await c.query("UPDATE plan_instrument SET notes = 'x' WHERE id = $1", [planC])).rowCount === 0, "a member can SEE the combination's plan but cannot change it")
    await expectRefused("A cannot add a zone type to B's plan", "INSERT INTO plan_zone_type (plan_instrument_id, code, name) VALUES ($1, 'ZX', 'ZX')", [planB])
    await expectRefused("A cannot add a standard to B's zone type", "INSERT INTO plan_zone_standard (plan_zone_type_id, kind_code, max_value) VALUES ($1, 'max_height', 99)", [ztB])
    await expectRefused("A cannot move its own plan to B", "UPDATE plan_instrument SET authority_id = $2 WHERE id = $1", [planA, B])
    await as({})
    await expectRefused('the public cannot create a plan', "INSERT INTO plan_instrument (authority_id, profile_id, plan_type, title) VALUES ($1, $2, 'local', 'RLS public')", [A, profile])

    console.log('== the functions respect it')
    await as({ authority: A })
    const adopted = (await one("SELECT adopt_plan_template($1, $2, 'RLS adopted by A', 'local') AS id", [template, A])).id
    check((await one('SELECT authority_id FROM plan_instrument WHERE id = $1', [adopted])).authority_id === A, 'A can adopt a template for itself')
    check((await one('SELECT COUNT(*)::int n FROM plan_zone_type WHERE plan_instrument_id = $1', [adopted])).n > 0, "the adopted plan's zone types were copied in")
    await expectRefused('A cannot adopt a template on behalf of B', "SELECT adopt_plan_template($1, $2, 'RLS adopted for B', 'local')", [template, B])

    console.log('== permits')
    await as({ authority: A })
    check(JSON.stringify(await stands()) === JSON.stringify(['RLS-A']), "A's staff see A's permit and not B's")
    check((await one('SELECT COUNT(*)::int n FROM spatial_planning.permit_rule_snapshot WHERE permit_id = $1', [pB])).n === 0, "and not B's permit's rule snapshots")
    await c.query('RESET ROLE')
    const pC = await permit(C, null, 'RLS-C')
    await as({ authority: A })
    check(JSON.stringify(await stands()) === JSON.stringify(['RLS-A', 'RLS-C']), "a member's staff also see a permit of the combination, but not the other member's")
    await as({ authority: B })
    check(JSON.stringify(await stands()) === JSON.stringify(['RLS-B', 'RLS-C']), 'and the other member sees the same combination permit')
    await as({ authority: C })
    check(JSON.stringify(await stands()) === JSON.stringify(['RLS-C']), "the combination's own staff see its permits, not the members'")
    check((await c.query("UPDATE spatial_planning.permit_application SET description = 'x' WHERE id = $1", [pC])).rowCount === 1, 'and can change them')
    await as({ authority: A })
    check((await c.query("UPDATE spatial_planning.permit_application SET description = 'x' WHERE id = $1", [pC])).rowCount === 0, "a member can see the combination's permit but not change it")
    await as({ user: cit })
    check(JSON.stringify(await stands()) === JSON.stringify(['RLS-A']), 'a citizen sees only their own permit')
    await as({})
    check((await stands()).length === 0, 'the public sees no permits')
    await as({ platform: true })
    check((await stands()).length === 3, 'a platform operator sees all')
    await as({ authority: A })
    await expectRefused("A's staff cannot create a permit for B", "INSERT INTO spatial_planning.permit_application (applicant_name, development_type, authority_id) VALUES ('x', 'new_building', $1)", [B])
    check((await c.query("UPDATE spatial_planning.permit_application SET description = 'x' WHERE id = $1", [pB])).rowCount === 0, "A's update of B's permit touches no row")
    await as({ user: cit })
    check((await one("INSERT INTO spatial_planning.permit_application (applicant_name, development_type, authority_id, created_by) VALUES ('mine', 'new_building', $1, $2) RETURNING id", [A, cit])).id !== undefined, 'a citizen can lodge their own permit')
    await expectRefused("a citizen cannot lodge a permit in another person's name", "INSERT INTO spatial_planning.permit_application (applicant_name, development_type, authority_id, created_by) VALUES ('theirs', 'new_building', $1, $2)", [A, cit2])

    console.log('== what hangs off a permit follows the permit (migration 155)')
    await asSuper()
    const child = async (sql, p) => (await one(sql, p)).id
    const consA = await child("INSERT INTO spatial_planning.application_consultation (permit_app_id, body_name) VALUES ($1, 'RLS body') RETURNING id", [pA])
    const objB = await child("INSERT INTO spatial_planning.application_objection (permit_app_id, objector_name) VALUES ($1, 'RLS objector') RETURNING id", [pB])
    const bpA = await child("INSERT INTO spatial_planning.building_plan (permit_app_id, plan_document_url) VALUES ($1, 'x') RETURNING id", [pA])
    const bpB = await child("INSERT INTO spatial_planning.building_plan (permit_app_id, plan_document_url) VALUES ($1, 'x') RETURNING id", [pB])
    await c.query("INSERT INTO spatial_planning.building_plan_annotation (building_plan_id, severity, message) VALUES ($1, 'info', 'RLS note A'), ($2, 'info', 'RLS note B')", [bpA, bpB])
    const siB = await child("INSERT INTO spatial_planning.stage_inspection (permit_app_id, stage_number) VALUES ($1, 1) RETURNING id", [pB])
    const n = async (sql, p) => (await one(sql, p)).n
    await as({ authority: A })
    check(await n('SELECT COUNT(*)::int n FROM spatial_planning.application_consultation WHERE id = $1', [consA]) === 1, "A sees its own permit's consultation")
    check(await n('SELECT COUNT(*)::int n FROM spatial_planning.application_objection WHERE id = $1', [objB]) === 0, "A does not see B's objection")
    check(await n("SELECT COUNT(*)::int n FROM spatial_planning.building_plan WHERE id IN ($1, $2)", [bpA, bpB]) === 1, "A sees A's building plan, not B's")
    check(await n("SELECT COUNT(*)::int n FROM spatial_planning.building_plan_annotation WHERE message LIKE 'RLS note %'") === 1, "an annotation is reached through its building plan: A sees only A's")
    check(await n('SELECT COUNT(*)::int n FROM spatial_planning.stage_inspection WHERE id = $1', [siB]) === 0, "A does not see B's inspection")
    check(await n('SELECT COUNT(*)::int n FROM spatial_planning.permit_event WHERE permit_app_id = $1', [pB]) === 0, "nor B's permit's event trail")
    check((await c.query("UPDATE spatial_planning.application_objection SET grounds_detail = 'x' WHERE id = $1", [objB])).rowCount === 0, "A's update of B's objection touches no row")
    check((await c.query('DELETE FROM spatial_planning.building_plan WHERE id = $1', [bpB])).rowCount === 0, "A's delete of B's building plan touches no row")
    await expectRefused("A cannot file an objection on B's permit", "INSERT INTO spatial_planning.application_objection (permit_app_id, objector_name) VALUES ($1, 'x')", [pB])
    await expectRefused("A cannot annotate B's building plan", "INSERT INTO spatial_planning.building_plan_annotation (building_plan_id, severity, message) VALUES ($1, 'info', 'x')", [bpB])
    check((await one("INSERT INTO spatial_planning.application_objection (permit_app_id, objector_name) VALUES ($1, 'mine') RETURNING id", [pA])).id !== undefined, 'A can file an objection on its own permit')
    await as({ authority: C })
    check(await n('SELECT COUNT(*)::int n FROM spatial_planning.application_consultation') === 0, "the combination's staff do not see its members' consultations")
    await as({ authority: A })
    await c.query('RESET ROLE'); const consC = await child("INSERT INTO spatial_planning.application_consultation (permit_app_id, body_name) VALUES ($1, 'RLS combo') RETURNING id", [pC]); await as({ authority: A })
    check(await n('SELECT COUNT(*)::int n FROM spatial_planning.application_consultation WHERE id = $1', [consC]) === 1, "a member can read a consultation on the combination's permit")
    check((await c.query("UPDATE spatial_planning.application_consultation SET body_name = 'x' WHERE id = $1", [consC])).rowCount === 0, '...but cannot change it')
    await as({ user: cit })
    check(await n('SELECT COUNT(*)::int n FROM spatial_planning.application_consultation WHERE id = $1', [consA]) === 1, 'a citizen sees the consultations on their own permit')
    await as({ user: cit2 })
    check(await n('SELECT COUNT(*)::int n FROM spatial_planning.application_consultation WHERE id = $1', [consA]) === 0, "and another citizen does not")
    await as({})
    check(await n('SELECT COUNT(*)::int n FROM spatial_planning.application_objection') === 0, 'the public sees no objections')
    await as({ platform: true })
    check(await n("SELECT COUNT(*)::int n FROM spatial_planning.building_plan WHERE id IN ($1, $2)", [bpA, bpB]) === 2, 'a platform operator sees both')
    await as({ authority: A })
    check(await n("SELECT COUNT(*)::int n FROM spatial_planning.v_inspector_queue q JOIN spatial_planning.permit_application p ON p.id = q.permit_app_id WHERE p.id = $1", [pB]) === 0, "the inspector queue view runs with the caller's rights")

    console.log('== failing closed, and the path that has not opted in')
    await c.query('RESET ROLE')
    await c.query("SELECT set_config('app.user_id', '', true), set_config('app.authority_id', '', true), set_config('app.platform', '', true)")
    await c.query('SET LOCAL ROLE vungu_app')
    check((await stands()).length === 0 && JSON.stringify(await titles()) === JSON.stringify(['gazetted B']), 'with no settings at all, only public things are visible')
    await asSuper()
    check((await titles()).length >= 5 && (await stands()).length >= 3, 'the superuser path (code that has not opted in) still sees everything: nothing existing breaks')

    console.log('== membership that has ended no longer shows')
    await c.query("UPDATE authority_member SET valid_from = CURRENT_DATE - 10, valid_to = CURRENT_DATE - 1 WHERE combination_id = $1 AND member_id = $2", [C, A])
    await as({ authority: A })
    check(!(await titles()).includes('plan C'), "once A's membership of the combination has ended, A no longer sees its plan")
    await as({ authority: B })
    check((await titles()).includes('plan C'), 'B, still a member, does')
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    c.release()
    await pool.end()
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED (nothing was kept)')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
