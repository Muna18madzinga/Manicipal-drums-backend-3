/**
 * seed-golden-thread.js
 *
 * One development application carried through every stage of the statutory
 * workflow, so a tester can follow a single case across every portal instead
 * of finding unrelated rows in each.
 *
 *   citizen lodges -> clerk acknowledges -> notice and consultation ->
 *   an objection -> committee agenda and attendance -> determination ->
 *   permit -> stage inspections -> occupation certificate
 *
 * Idempotent: every insert is guarded on a natural key, so a re-run adds
 * nothing but still wires up anything that was missing.
 *
 *     node scripts/seed-golden-thread.js
 *     node scripts/seed-golden-thread.js --undo
 *
 * Requires scripts/seed-demo-users.js to have run first — this looks users
 * up by email rather than creating them.
 */

try { require('dotenv').config({ quiet: true }) } catch (_) { /* optional */ }
const { Pool } = require('pg')
const { remember, forget, ensure } = require('./lib/seedkit')

const DATABASE_URL = process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/Vungu_spatial334'

const TAG = 'VUNGU-GOLDEN-THREAD'
const REFERENCE = 'TPD/VUN/2026/0900'

// Vungu RDC, Midlands — the same area the other demo stands sit in, so the
// case lands where the basemap already has data.
const LNG = 29.7894
const LAT = -19.4612

/** Days before now, as an ISO date. */
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
const tsAgo = n => new Date(Date.now() - n * 86400000).toISOString()

async function userId (db, email) {
  const { rows } = await db.query('SELECT id FROM public.users WHERE email = $1', [email])
  if (!rows.length) {
    throw new Error(`No user ${email}. Run: node scripts/seed-demo-users.js`)
  }
  return rows[0].id
}

async function seed (db) {
  const citizen = await userId(db, 'demo.citizen@vungu.test')
  const clerk = await userId(db, 'demo.clerk@vungu.test')
  const planner = await userId(db, 'demo.planner@vungu.test')
  const inspector = await userId(db, 'demo.inspector@vungu.test')

  // ── 1. The application ────────────────────────────────────────────────
  const appId = await ensure(db, TAG, 'spatial_planning.permit_application', {
    tpd_reference: REFERENCE,
    dev_register_no: 'DR/2026/0900',
    stand_number: '4530',
    suburb_ward: 'Ward 12',
    street_address: '4530 Gweru Road, Vungu',
    stand_area_sqm: 1200,
    applicant_name: 'Demo Citizen',
    applicant_id_number: '63-1234567X63',
    applicant_phone: '+263 77 000 0900',
    applicant_email: 'demo.citizen@vungu.test',
    development_type: 'new_building',
    description: 'Construction of a three-bedroom dwelling with a detached garage.',
    status: 'approved_with_conditions',
    received_at: daysAgo(90),
    acknowledged_at: daysAgo(86),
    decision_at: daysAgo(20),
    decision_conditions: 'Stormwater to discharge to the road reserve. Boundary wall not to exceed 1.8 m.',
    decision_officer: planner,
    created_by: citizen,
    estimated_cost: 48000,
    plinth_area: 180,
    floors: 1,
    parking_bays: 2,
    classification: 'residential',
    recommendation: 'approve_with_conditions',
    statutory_due_date: daysAgo(-10),
    clock_state: 'stopped',
    clock_paused_days: 17,
  }, 'tpd_reference = $1', [REFERENCE])

  await db.query(
    `UPDATE spatial_planning.permit_application
        SET location = ST_SetSRID(ST_MakePoint($1, $2), 4326),
            location_source = 'case_file', location_set_by = $3, location_set_at = NOW()
      WHERE id = $4 AND location IS NULL`,
    [LNG, LAT, clerk, appId])

  // ── 2. The case timeline ──────────────────────────────────────────────
  const events = [
    [90, 'status_changed', citizen, 'registered', { to: 'registered', note: 'Application lodged online.' }],
    [86, 'status_changed', clerk, 'planning_clerk', { to: 'acknowledged', note: 'Acknowledged under section 26.' }],
    [80, 'status_changed', clerk, 'planning_clerk', { to: 'circulation', note: 'Circulated to service authorities.' }],
    [66, 'status_changed', clerk, 'planning_clerk', { to: 'objection_period', note: 'Notice published; 21-day period opened.' }],
    [40, 'status_changed', planner, 'planner', { to: 'under_review', note: 'Objection period closed. One objection received.' }],
    [20, 'status_changed', planner, 'planner', { to: 'approved_with_conditions', note: 'Determined by committee.' }],
  ]
  for (const [d, type, actor, role, detail] of events) {
    const { rows } = await db.query(
      `SELECT id FROM spatial_planning.permit_event
        WHERE permit_app_id = $1 AND event_type = $2 AND detail->>'note' = $3 LIMIT 1`,
      [appId, type, detail.note])
    if (rows.length) continue
    const ins = await db.query(
      `INSERT INTO spatial_planning.permit_event
         (permit_app_id, event_type, actor_id, actor_role, detail, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6) RETURNING id`,
      [appId, type, actor, role, JSON.stringify(detail), tsAgo(d)])
    await remember(db, TAG, 'spatial_planning.permit_event', ins.rows[0].id)
  }

  // ── 3. Public notice and the objection period ─────────────────────────
  await ensure(db, TAG, 'spatial_planning.public_notice', {
    permit_app_id: appId,
    advert_verified: true,
    advert_reference: 'The Chronicle, 12 July 2026, p14',
    advert_verified_at: tsAgo(66),
    advert_verified_by: clerk,
    abutting_owners_verified: true,
    abutting_owners_verified_at: tsAgo(66),
    abutting_owners_verified_by: clerk,
    site_notice_verified: true,
    site_notice_verified_at: tsAgo(65),
    site_notice_verified_by: clerk,
    objection_period_start: daysAgo(66),
    objection_period_end: daysAgo(45),
    objection_period_closed: true,
    objection_period_closed_at: tsAgo(45),
    objection_period_closed_by: clerk,
    notes: 'One objection received within the period.',
  }, 'permit_app_id = $1', [appId])

  // Two consultations: one returned, one still outstanding, so the blocking
  // logic has something real to show rather than a uniformly clean case.
  const consultations = [
    ['Zimbabwe National Water Authority', 'water_authority', 'no_objection', 'responded',
      'No objection. Connection to the existing main is adequate.', daysAgo(62)],
    ['Department of Roads', 'roads_authority', 'pending', 'open', null, null],
  ]
  for (const [name, type, status, task, notes, received] of consultations) {
    await ensure(db, TAG, 'spatial_planning.application_consultation', {
      permit_app_id: appId,
      body_name: name,
      body_type: type,
      circulated_at: daysAgo(80),
      response_due_at: daysAgo(59),
      response_status: status,
      response_received_at: received,
      response_notes: notes,
      task_status: task,
      priority: 'normal',
      created_by: clerk,
    }, 'permit_app_id = $1 AND body_name = $2', [appId, name])
  }

  await ensure(db, TAG, 'spatial_planning.application_objection', {
    permit_app_id: appId,
    objector_name: 'M. Ncube',
    objector_address: '4528 Gweru Road, Vungu',
    grounds: JSON.stringify(['overlooking', 'stormwater']),
    grounds_detail: 'Concerned the garage will discharge stormwater onto the adjoining stand.',
    received_at: daysAgo(52),
    consideration_notes: 'Sustained in part. A stormwater condition was attached to the permit.',
    sustained: true,
    considered_at: daysAgo(21),
    considered_by: planner,
  }, 'permit_app_id = $1 AND objector_name = $2', [appId, 'M. Ncube'])

  // ── 4. Committee ──────────────────────────────────────────────────────
  const members = [
    ['Cllr T. Moyo', 'Chairperson'],
    ['Cllr R. Sibanda', 'Deputy Chairperson'],
    ['Cllr P. Dube', 'Member'],
    ['Cllr L. Chirwa', 'Member'],
    ['Cllr N. Mpofu', 'Member'],
  ]
  const memberIds = []
  for (const [name, title] of members) {
    memberIds.push(await ensure(db, TAG, 'spatial_planning.committee_member', {
      full_name: name, title, active: true, created_by: planner,
    }, 'full_name = $1', [name]))
  }

  const meeting = await db.query(
    `SELECT id, quorum FROM spatial_planning.committee_meeting
      WHERE deleted_at IS NULL ORDER BY meeting_date DESC LIMIT 1`)
  if (meeting.rows.length) {
    const meetingId = meeting.rows[0].id
    await ensure(db, TAG, 'spatial_planning.agenda_item', {
      meeting_id: meetingId,
      permit_app_id: appId,
      item_order: 1,
      purpose: 'determination',
      outcome: 'approved_with_conditions',
      resolution: 'Approved subject to stormwater and boundary-wall conditions.',
      heard_at: tsAgo(20),
      created_by: planner,
    }, 'meeting_id = $1 AND permit_app_id = $2', [meetingId, appId])

    // Four of five present: quorum is met, but the calculation is exercised
    // rather than trivially satisfied.
    for (let i = 0; i < memberIds.length; i++) {
      const status = i === 4 ? 'apology' : 'present'
      await ensure(db, TAG, 'spatial_planning.meeting_attendance', {
        meeting_id: meetingId, member_id: memberIds[i], status, recorded_by: planner,
      }, 'meeting_id = $1 AND member_id = $2', [meetingId, memberIds[i]])
    }
  }

  // ── 5. The statutory clock ────────────────────────────────────────────
  // There is no 'stopped' event type — the clock is started, and paused or
  // resumed while the council waits on someone else. The application's own
  // clock_state records that it has since been determined.
  const clock = [
    ['started', daysAgo(90), null, 'Lodged; the 90-day period begins.'],
    ['paused', daysAgo(62), null, 'Awaiting the Department of Roads response.'],
    ['resumed', daysAgo(45), 17, 'Objection period closed; assessment resumed.'],
  ]
  for (const [type, when, delta, reason] of clock) {
    const { rows } = await db.query(
      `SELECT id FROM spatial_planning.statutory_clock_event
        WHERE permit_app_id = $1 AND event_type = $2 LIMIT 1`, [appId, type])
    if (rows.length) continue
    const ins = await db.query(
      `INSERT INTO spatial_planning.statutory_clock_event
         (permit_app_id, event_type, reason, days_delta, actor_id, effective_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [appId, type, reason, delta, planner, when])
    await remember(db, TAG, 'spatial_planning.statutory_clock_event', ins.rows[0].id)
  }

  // ── 6. Stage inspections ──────────────────────────────────────────────
  // Stages 1 and 2 passed; stage 3 needs re-inspection, so the inspector's
  // queue shows both a clean history and something outstanding.
  const stages = [
    [1, 'pass', 16, 'Pegs and building line verified against the approved plan.'],
    [2, 'pass', 10, 'Trench depth and footing levels correct.'],
    [3, 'reinspection_required', 4, 'DPC not continuous on the north elevation. Re-inspection required.'],
  ]
  const stageIds = []
  for (const [num, result, d, notes] of stages) {
    const id = await ensure(db, TAG, 'spatial_planning.stage_inspection', {
      permit_app_id: appId,
      stage_number: num,
      attempt: 1,
      inspector_id: inspector,
      scheduled_at: tsAgo(d + 1),
      inspected_at: tsAgo(d),
      result,
      result_notes: notes,
      site_ready: true,
      weather_conditions: 'clear',
      stamp_reference: `VUN/INSP/2026/09${num}0`,
    }, 'permit_app_id = $1 AND stage_number = $2 AND attempt = 1', [appId, num])
    stageIds.push([num, id])
  }

  // Checklist marks against the real checklist_item rows for each stage's
  // category, so the console renders actual item text.
  for (const [num, stageId] of stageIds) {
    const items = await db.query(
      'SELECT id FROM spatial_planning.checklist_item WHERE category_id = $1 ORDER BY id LIMIT 4',
      [num])
    for (const [i, item] of items.rows.entries()) {
      const failing = num === 3 && i === 0
      const { rows } = await db.query(
        `SELECT id FROM spatial_planning.inspection_checklist_result
          WHERE stage_inspection_id = $1 AND checklist_item_id = $2 LIMIT 1`,
        [stageId, item.id])
      if (rows.length) continue
      const ins = await db.query(
        `INSERT INTO spatial_planning.inspection_checklist_result
           (stage_inspection_id, checklist_item_id, result, notes, score)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [stageId, item.id, failing ? 'fail' : 'pass',
          failing ? 'DPC not continuous on the north elevation.' : null,
          failing ? 2 : 9])
      await remember(db, TAG, 'spatial_planning.inspection_checklist_result', ins.rows[0].id)
    }
  }

  return { appId, reference: REFERENCE }
}

;(async () => {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  })
  const db = await pool.connect()
  const undoing = process.argv.includes('--undo')
  try {
    await db.query('BEGIN')
    if (undoing) {
      const n = await forget(db, TAG)
      await db.query('COMMIT')
      console.log(`Removed ${n} row(s) created by ${TAG}.`)
    } else {
      const { reference } = await seed(db)
      await db.query('COMMIT')
      const { rows } = await db.query(
        'SELECT count(*)::int n FROM public.seed_demo_ledger WHERE tag = $1', [TAG])
      console.log(`Seeded the golden thread: ${reference} (${rows[0].n} rows tracked).`)
    }
  } catch (e) {
    await db.query('ROLLBACK')
    console.error('FAILED (rolled back):', e.message)
    process.exitCode = 1
  } finally {
    db.release()
    await pool.end()
  }
})()
