/**
 * seed-inspector-register.js
 *
 * The building inspector console has thirteen sections and almost nothing
 * behind them. This attaches inspection-register demo data to permit
 * applications that already exist in the database (it creates none), so the
 * queue, the failed-inspection flag workflow, plan appraisal, public
 * complaints, the occupation-certificate path, and the citizen booking
 * route all have something real to render.
 *
 * Distinct from seed-inspector-demo.js (that one creates its own stands and
 * an inspector login) and from seed-golden-thread.js (that one's single
 * case deliberately ends on an outstanding re-inspection — nothing exercises
 * the occupation-certificate path, which is why this script adds a second,
 * separate completed case for it).
 *
 * Idempotent: every insert is guarded on a natural key via seedkit's
 * `ensure`, so a re-run adds nothing but still wires up anything missing.
 *
 *     node scripts/seed-inspector-register.js
 *     node scripts/seed-inspector-register.js --undo
 */

try { require('dotenv').config({ quiet: true }) } catch (_) { /* optional */ }
const { Pool } = require('pg')
const { remember, forget, ensure } = require('./lib/seedkit')

const DATABASE_URL = process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/Vungu_spatial334'

const TAG = 'VUNGU-INSPECTOR-REGISTER'

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString()
const daysFromNow = n => new Date(Date.now() + n * 86400000).toISOString()

async function userId (db, email) {
  const { rows } = await db.query('SELECT id FROM public.users WHERE email = $1', [email])
  if (!rows.length) throw new Error(`No user ${email}. Run: node scripts/seed-demo-users.js`)
  return rows[0].id
}

/** An existing permit_application, looked up by its tpd_reference — never created here. */
async function permitByReference (db, reference) {
  const { rows } = await db.query(
    'SELECT id FROM spatial_planning.permit_application WHERE tpd_reference = $1', [reference])
  if (!rows.length) throw new Error(`No permit_application with tpd_reference ${reference}`)
  return rows[0].id
}

async function seed (db) {
  const inspector = await userId(db, 'demo.inspector@vungu.test')
  const admin = await userId(db, 'demo.admin@vungu.test')
  const citizen = await userId(db, 'demo.citizen@vungu.test')

  // Four approved, real permits already in the database. p1/p2 carry the
  // queue variety below; p3 is reserved whole for the occupation-certificate
  // case; p4 only gets a building plan (plans get submitted regardless of
  // how the application is eventually determined).
  const p1 = await permitByReference(db, 'TPD/VUN/2026/0020')
  const p2 = await permitByReference(db, 'TPD/VUN/2026/0005')
  const p3 = await permitByReference(db, 'TPD/VUN/2026/0016')
  const p4 = await permitByReference(db, 'TPD/VUN/2026/0015')

  // ── Six stage_inspection rows, spread across two permits ──────────────
  // p1: pass, a scheduled-but-not-yet-inspected future visit, then a fail.
  // p2: pass, another scheduled-future visit, then a re-inspection that was
  // due and never carried out (overdue).
  const stageRows = [
    [p1, 1, { scheduled_at: daysAgo(31), inspected_at: daysAgo(30), result: 'pass',
      result_notes: 'Pegs and building line verified against the approved plan.' }],
    [p1, 2, { scheduled_at: daysFromNow(5), inspected_at: null, result: null,
      result_notes: null }],
    [p1, 3, { scheduled_at: daysAgo(9), inspected_at: daysAgo(9), result: 'fail',
      result_notes: 'Footing depth short of the approved drawing on the east side. Backfill removed pending correction.' }],
    [p2, 1, { scheduled_at: daysAgo(25), inspected_at: daysAgo(24), result: 'pass',
      result_notes: 'Setting out matches the site plan.' }],
    [p2, 4, { scheduled_at: daysFromNow(3), inspected_at: null, result: null,
      result_notes: null }],
    [p2, 5, { scheduled_at: daysAgo(6), inspected_at: null, result: 'reinspection_required',
      result_notes: 'Re-inspection scheduled after the wall-plate query was raised; visit did not take place.' }],
  ]
  const stageIds = {}
  for (const [permitId, stageNumber, extra] of stageRows) {
    const id = await ensure(db, TAG, 'spatial_planning.stage_inspection', {
      permit_app_id: permitId,
      stage_number: stageNumber,
      attempt: 1,
      inspector_id: inspector,
      site_ready: true,
      weather_conditions: 'clear',
      ...extra,
    }, 'permit_app_id = $1 AND stage_number = $2 AND attempt = 1', [permitId, stageNumber])
    stageIds[`${permitId}:${stageNumber}`] = id
  }
  const failingInspectionId = stageIds[`${p1}:3`]

  // ── Two flags against the failing inspection ──────────────────────────
  const flags = [
    ['work_not_to_standard', 'Footing depth measured 380mm against the drawn 450mm on the east elevation.'],
    ['measurements_incorrect', 'Setting-out offset from the boundary peg does not match the approved site plan.'],
  ]
  for (const [reasonCode, description] of flags) {
    await ensure(db, TAG, 'spatial_planning.stage_inspection_flag', {
      stage_inspection_id: failingInspectionId,
      reason_code: reasonCode,
      description,
      flagged_by: inspector,
      flagged_by_role: 'building_inspector',
      status: 'open',
    }, 'stage_inspection_id = $1 AND reason_code = $2', [failingInspectionId, reasonCode])
  }

  // ── Four building_plan rows, two annotations each ──────────────────────
  const plans = [
    [p1, 'Rev A', 'residential', 1, 180],
    [p2, 'Rev A', 'residential', 1, 210],
    [p3, 'Rev B', 'residential', 1, 195],
    [p4, 'Rev A', 'commercial', 2, 340],
  ]
  for (const [permitId, revisionLabel, buildingUse, storeys, gfa] of plans) {
    const planId = await ensure(db, TAG, 'spatial_planning.building_plan', {
      permit_app_id: permitId,
      revision: 1,
      revision_label: revisionLabel,
      plan_document_url: `/uploads/plans/${permitId}-rev-a.pdf`,
      architect_name: 'M. Chikanza Architects',
      number_of_storeys: storeys,
      gross_floor_area_sqm: gfa,
      building_use: buildingUse,
      status: 'approved',
      appraised_by: inspector,
      created_by: inspector,
    }, 'permit_app_id = $1', [permitId])

    const annotations = [
      ['warn', 'DPC-01', 'Damp-proof course detail not shown on the north elevation.'],
      ['error', 'STR-04', 'Lintel span over the garage opening exceeds the schedule without a supporting beam detail.'],
    ]
    for (const [severity, code, message] of annotations) {
      await ensure(db, TAG, 'spatial_planning.building_plan_annotation', {
        building_plan_id: planId,
        severity,
        code,
        message,
        created_by: inspector,
      }, 'building_plan_id = $1 AND code = $2', [planId, code])
    }
  }

  // ── Three building_complaint rows, one anonymous ────────────────────────
  await ensure(db, TAG, 'spatial_planning.building_complaint', {
    reference: 'BC-2026-0001',
    category: 'building_without_permit',
    severity: 'urgent',
    status: 'received',
    description: 'A two-room extension is being built with no permit board displayed on site.',
    stand_number: '2210',
    suburb_ward: 'Ward 5',
    anonymous: true,
    received_at: daysAgo(3),
  }, 'reference = $1', ['BC-2026-0001'])

  await ensure(db, TAG, 'spatial_planning.building_complaint', {
    reference: 'BC-2026-0002',
    category: 'deviation_from_plan',
    severity: 'routine',
    status: 'inspected',
    description: 'Boundary wall built higher than the 1.8m condition on the approved permit.',
    stand_number: '4530',
    suburb_ward: 'Ward 12',
    reporter_name: 'J. Sithole',
    reporter_phone: '+263 77 220 9931',
    anonymous: false,
    permit_app_id: p1,
    received_at: daysAgo(14),
    received_by: admin,
    assigned_to: inspector,
    inspected_at: daysAgo(10),
    inspected_by: inspector,
  }, 'reference = $1', ['BC-2026-0002'])

  await ensure(db, TAG, 'spatial_planning.building_complaint', {
    reference: 'BC-2026-0003',
    category: 'dangerous_structure',
    severity: 'emergency',
    status: 'closed',
    description: 'Retaining wall along the road reserve has visible cracking and is leaning.',
    stand_number: '990',
    suburb_ward: 'Ward 2',
    reporter_name: 'P. Moyo',
    reporter_phone: '+263 78 440 1120',
    anonymous: false,
    received_at: daysAgo(30),
    received_by: admin,
    assigned_to: inspector,
    inspected_at: daysAgo(28),
    inspected_by: inspector,
    finding: 'Substantiated. Wall footing undermined by uncontrolled stormwater. Notice issued to the owner to rebuild.',
    closed_at: daysAgo(2),
    closed_by: inspector,
  }, 'reference = $1', ['BC-2026-0003'])

  // ── One completed case ending in an occupation certificate ─────────────
  // p3 gets a full, clean pass through every stage — the golden thread's
  // case deliberately stops at an outstanding re-inspection, so nothing else
  // currently exercises this path.
  let lastStageId = null
  for (let stage = 1; stage <= 9; stage++) {
    const daysBack = (10 - stage) * 6
    lastStageId = await ensure(db, TAG, 'spatial_planning.stage_inspection', {
      permit_app_id: p3,
      stage_number: stage,
      attempt: 1,
      inspector_id: inspector,
      scheduled_at: daysAgo(daysBack + 1),
      inspected_at: daysAgo(daysBack),
      result: 'pass',
      result_notes: `Stage ${stage} inspected and passed.`,
      site_ready: true,
      weather_conditions: 'clear',
      stamp_reference: `VUN/INSP/2026/0016-${stage}`,
    }, 'permit_app_id = $1 AND stage_number = $2 AND attempt = 1', [p3, stage])
  }
  await ensure(db, TAG, 'spatial_planning.occupation_certificate', {
    permit_app_id: p3,
    certificate_no: 'OC-2026-0001',
    issued_at: daysAgo(1).slice(0, 10),
    occupant_name: 'Demo Occupant',
    building_use: 'residential',
    gross_floor_area_sqm: 195,
    issued_by: inspector,
    countersigned_by: admin,
    notes: 'All nine stages passed. Final inspection clear.',
  }, 'permit_app_id = $1', [p3])

  // ── Two inspection_bookings rows (public schema, not spatial_planning) ──
  // This table was corrupt until today's rebuild and is now empty; these
  // exercise the citizen booking route it used to error on. application_id
  // has no FK — it is a free-text label — so it carries the human-readable
  // reference; permit_app_id is the real link back to the permit.
  await ensure(db, TAG, 'public.inspection_bookings', {
    application_id: 'TPD/VUN/2026/0020',
    permit_app_id: p1,
    stage_number: 4,
    stage_name: 'Brickwork and window level',
    citizen_id: citizen,
    status: 'pending_payment',
  }, 'application_id = $1 AND stage_number = $2', ['TPD/VUN/2026/0020', 4])

  await ensure(db, TAG, 'public.inspection_bookings', {
    application_id: 'TPD/VUN/2026/0005',
    permit_app_id: p2,
    stage_number: 5,
    stage_name: 'Brickwork to wall plate',
    citizen_id: citizen,
    inspector_id: inspector,
    status: 'scheduled',
    fee_paid_at: daysAgo(4),
    scheduled_for: daysFromNow(2),
  }, 'application_id = $1 AND stage_number = $2', ['TPD/VUN/2026/0005', 5])

  return { p1, p2, p3, p4 }
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
      await seed(db)
      await db.query('COMMIT')
      const { rows } = await db.query(
        'SELECT count(*)::int n FROM public.seed_demo_ledger WHERE tag = $1', [TAG])
      console.log(`Seeded the inspector register (${rows[0].n} rows tracked).`)
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
