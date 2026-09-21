/**
 * seed-eho-office.js
 *
 * The EHO console's field registers (premises, outbreaks, water samples,
 * nuisance complaints) already hold a few real rows. Every office
 * register — abatement notices, burial permits, food-handler certs,
 * licence clearances, field programmes, premises inspections — is empty.
 * This attaches office records to the premises that already exist rather
 * than inventing new ones.
 *
 * "Overdue" on an abatement notice is not a stored status (the CHECK
 * constraint only allows served/extended/complied/non_complied/escalated/
 * withdrawn) — it is served_at + compliance_days having passed while the
 * notice is still 'served'. The seeded overdue notice relies on that, not
 * on a status value.
 *
 * health_premises_inspection has no risk-rating column; verdict
 * (pass/fail/conditional/pending) is what the risk sort actually has to
 * work with, so the four inspections vary verdict rather than a rating
 * that does not exist in the schema.
 *
 * Idempotent via seedkit's `ensure`; a re-run adds nothing.
 *
 *     node scripts/seed-eho-office.js
 *     node scripts/seed-eho-office.js --undo
 */

try { require('dotenv').config({ quiet: true }) } catch (_) { /* optional */ }
const { Pool } = require('pg')
const { forget, ensure } = require('./lib/seedkit')

const DATABASE_URL = process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/Vungu_spatial334'

const TAG = 'VUNGU-EHO-OFFICE'

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString()
const daysFromNow = n => new Date(Date.now() + n * 86400000).toISOString()
const dateAgo = n => daysAgo(n).slice(0, 10)
const dateFromNow = n => daysFromNow(n).slice(0, 10)

async function userId (db, email) {
  const { rows } = await db.query('SELECT id FROM public.users WHERE email = $1', [email])
  if (!rows.length) throw new Error(`No user ${email}. Run: node scripts/seed-demo-users.js`)
  return rows[0].id
}

async function premisesByReference (db, reference) {
  const { rows } = await db.query(
    'SELECT id, name FROM spatial_planning.health_premises WHERE reference = $1', [reference])
  if (!rows.length) throw new Error(`No health_premises with reference ${reference}`)
  return rows[0]
}

async function seed (db) {
  const eho = await userId(db, 'demo.envoffice@vungu.test')

  const bakery = await premisesByReference(db, 'PR-2026-0001')     // Kudu Bakery
  const butchery = await premisesByReference(db, 'PR-2026-0002')   // Somabula Butchery
  const tuckshop = await premisesByReference(db, 'PR-2026-0003')   // Far Tuckshop

  // ── Three abatement notices: served, complied, overdue ────────────────
  await ensure(db, TAG, 'spatial_planning.health_abatement_notice', {
    reference: 'AN-2026-0001',
    notice_type: 'abatement',
    premises_id: bakery.id,
    subject_name: bakery.name,
    subject_address: 'Stand 1, Vungu Growth Point',
    nuisance_description: 'Grease trap overflow draining onto the pedestrian walkway.',
    required_action: 'Clear the grease trap and repair the outlet within the notice period.',
    compliance_days: 14,
    served_at: daysAgo(5),
    served_method: 'hand',
    status: 'served',
    issued_by_name: 'Demo Environmental Officer',
    issued_by: eho,
  }, 'reference = $1', ['AN-2026-0001'])

  await ensure(db, TAG, 'spatial_planning.health_abatement_notice', {
    reference: 'AN-2026-0002',
    notice_type: 'abatement',
    premises_id: butchery.id,
    subject_name: butchery.name,
    subject_address: 'Stand 14, Somabula',
    nuisance_description: 'Offal disposed of in an open pit behind the premises.',
    required_action: 'Dispose of offal through the licensed contractor and cover the pit.',
    compliance_days: 10,
    served_at: daysAgo(40),
    served_method: 'registered_post',
    status: 'complied',
    closed_at: daysAgo(28),
    issued_by_name: 'Demo Environmental Officer',
    issued_by: eho,
  }, 'reference = $1', ['AN-2026-0002'])

  // Overdue: served 60 days ago with a 21-day compliance window, still
  // 'served' — the derived overdue state the register has to surface.
  await ensure(db, TAG, 'spatial_planning.health_abatement_notice', {
    reference: 'AN-2026-0003',
    notice_type: 'closure',
    premises_id: tuckshop.id,
    subject_name: tuckshop.name,
    subject_address: 'Stand 30, Far Estate',
    nuisance_description: 'Trading from an unroofed structure with no handwashing facility.',
    required_action: 'Cease trading until the structure is roofed and a handwashing point installed.',
    compliance_days: 21,
    served_at: daysAgo(60),
    served_method: 'affixed',
    status: 'served',
    issued_by_name: 'Demo Environmental Officer',
    issued_by: eho,
  }, 'reference = $1', ['AN-2026-0003'])

  // ── Two burial permits ──────────────────────────────────────────────────
  await ensure(db, TAG, 'spatial_planning.health_burial_permit', {
    reference: 'BP-2026-0001',
    permit_kind: 'burial',
    deceased_name: 'Amai Chenjerai Moyo',
    date_of_death: dateAgo(3),
    cause_of_death: 'Natural causes',
    cemetery: 'Vungu Memorial Cemetery',
    ward: 'Ward 4',
    interment_at: daysFromNow(1),
    applicant_name: 'T. Moyo',
    applicant_relation: 'Son',
    applicant_contact: '+263 77 300 4410',
    issued_by_name: 'Demo Environmental Officer',
    issued_by: eho,
  }, 'reference = $1', ['BP-2026-0001'])

  await ensure(db, TAG, 'spatial_planning.health_burial_permit', {
    reference: 'BP-2026-0002',
    permit_kind: 'exhumation',
    deceased_name: 'Baba Josiah Ncube',
    date_of_death: dateAgo(900),
    cause_of_death: 'Not recorded',
    cemetery: 'Somabula Cemetery',
    ward: 'Ward 9',
    applicant_name: 'R. Ncube',
    applicant_relation: 'Daughter',
    applicant_contact: '+263 71 220 8890',
    issued_by_name: 'Demo Environmental Officer',
    issued_by: eho,
    notes: 'Family relocating remains to Somabula ahead of resettlement.',
  }, 'reference = $1', ['BP-2026-0002'])

  // ── Three food-handler certs, one expiring within 30 days ──────────────
  await ensure(db, TAG, 'spatial_planning.health_food_handler_cert', {
    reference: 'FH-2026-0001',
    premises_id: bakery.id,
    handler_name: 'S. Mahlangu',
    issued_at: daysAgo(340),
    expires_at: dateFromNow(20),
    medical_clearance_source: 'Vungu RDC Clinic',
    issued_by: eho,
  }, 'reference = $1', ['FH-2026-0001'])

  await ensure(db, TAG, 'spatial_planning.health_food_handler_cert', {
    reference: 'FH-2026-0002',
    premises_id: butchery.id,
    handler_name: 'D. Zhou',
    issued_at: daysAgo(60),
    expires_at: dateFromNow(305),
    medical_clearance_source: 'Vungu RDC Clinic',
    issued_by: eho,
  }, 'reference = $1', ['FH-2026-0002'])

  await ensure(db, TAG, 'spatial_planning.health_food_handler_cert', {
    reference: 'FH-2026-0003',
    premises_id: tuckshop.id,
    handler_name: 'N. Chirwa',
    issued_at: daysAgo(200),
    expires_at: dateFromNow(165),
    medical_clearance_source: 'Gweru Provincial Hospital',
    issued_by: eho,
  }, 'reference = $1', ['FH-2026-0003'])

  // ── Two licence clearances ──────────────────────────────────────────────
  await ensure(db, TAG, 'spatial_planning.health_licence_clearance', {
    reference: 'LC-2026-0001',
    licence_type: 'food_outlet',
    applicant_name: 'S. Mahlangu',
    applicant_contact: '+263 77 118 2230',
    trading_name: bakery.name,
    premises_id: bakery.id,
    stand_number: '1',
    suburb_ward: 'Vungu Growth Point',
    received_at: daysAgo(20),
    status: 'cleared',
    decided_at: daysAgo(12),
    decided_by: eho,
    decided_by_name: 'Demo Environmental Officer',
    valid_until: dateFromNow(345),
  }, 'reference = $1', ['LC-2026-0001'])

  await ensure(db, TAG, 'spatial_planning.health_licence_clearance', {
    reference: 'LC-2026-0002',
    licence_type: 'liquor',
    applicant_name: 'Somabula Traders Pvt Ltd',
    applicant_contact: '+263 78 990 1145',
    trading_name: 'Somabula Bottle Store',
    stand_number: '14',
    suburb_ward: 'Somabula',
    received_at: daysAgo(4),
    status: 'pending',
  }, 'reference = $1', ['LC-2026-0002'])

  // ── Two field programmes ────────────────────────────────────────────────
  await ensure(db, TAG, 'spatial_planning.health_field_programme', {
    reference: 'FP-2026-0001',
    programme_type: 'indoor_residual_spray',
    title: 'Ward 4 IRS round',
    ward: 'Ward 4',
    village_or_area: 'Vungu Growth Point',
    scheduled_for: dateFromNow(10),
    status: 'planned',
    target_quantity: 120,
    quantity_unit: 'households',
    team_lead: 'Demo Environmental Officer',
    team_size: 4,
  }, 'reference = $1', ['FP-2026-0001'])

  await ensure(db, TAG, 'spatial_planning.health_field_programme', {
    reference: 'FP-2026-0002',
    programme_type: 'illegal_dump_clearance',
    title: 'Somabula roadside dump clearance',
    ward: 'Ward 9',
    village_or_area: 'Somabula',
    scheduled_for: dateAgo(6),
    executed_at: daysAgo(5),
    status: 'completed',
    target_quantity: 3,
    achieved_quantity: 3,
    quantity_unit: 'truckloads',
    team_lead: 'Demo Environmental Officer',
    team_size: 6,
  }, 'reference = $1', ['FP-2026-0002'])

  // ── Four premises inspections, varying verdict across the premises ─────
  const inspections = [
    ['HI-2026-0001', bakery.id, 'food_hygiene', 'pass', daysAgo(15),
      'Handwashing facilities and food storage in order.', null],
    ['HI-2026-0002', butchery.id, 'sanitation', 'fail', daysAgo(12),
      'Offal pit uncovered; drainage from the slaughter area running onto open ground.',
      'Cover the pit and correct drainage within 10 days. Abatement notice AN-2026-0002 followed.'],
    ['HI-2026-0003', tuckshop.id, 'general', 'conditional', daysAgo(8),
      'No handwashing point; roofing incomplete over the trading area.',
      'Install a handwashing point and complete roofing before re-inspection.'],
    ['HI-2026-0004', bakery.id, 'pest_control', 'pending', daysAgo(2),
      'Rodent bait stations checked; lab result on droppings sample awaited.', null],
  ]
  for (const [reference, premisesId, scope, verdict, inspectedAt, findings, actionRequired] of inspections) {
    await ensure(db, TAG, 'spatial_planning.health_premises_inspection', {
      reference,
      premises_id: premisesId,
      inspected_at: inspectedAt,
      inspector_name: 'Demo Environmental Officer',
      scope,
      verdict,
      findings,
      action_required: actionRequired,
      created_by: eho,
    }, 'reference = $1', [reference])
  }
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
      console.log(`Seeded the EHO office registers (${rows[0].n} rows tracked).`)
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
