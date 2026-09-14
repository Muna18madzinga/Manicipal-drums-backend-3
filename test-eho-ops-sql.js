// test-eho-ops-sql.js
// Every statement src/routes/environmental-health-ops.js issues, run against
// the real schema inside a transaction that is always rolled back, plus the
// constraints of migration 122 checked for actually biting.
//
//   node test-eho-ops-sql.js      (reads DATABASE_URL from .env)
//
// This is a SQL smoke test, not an HTTP one: it catches the failure mode a
// route module actually has - a column renamed, a cast dropped, a CHECK that
// the API can reach but never explains. Nothing is left behind.

require('dotenv').config()
const { Client } = require('pg')

// Exercises every statement environmental-health-ops.js issues, against the
// real schema, inside a transaction that is always rolled back.
;(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  await c.query('BEGIN')
  let failures = 0
  const ok = (label) => console.log('  ok  ' + label)
  const bad = (label, e) => { failures++; console.log('  FAIL ' + label + ' :: ' + e.message) }

  const XY = (a) => `ST_X(${a}.location) AS lng, ST_Y(${a}.location) AS lat`
  const pointSql = (l, t) => `CASE WHEN ${l}::double precision IS NULL THEN NULL
    ELSE ST_SetSRID(ST_MakePoint(${l}::double precision, ${t}::double precision), 4326) END`

  let premisesId, inspectionId, handlerId, burialId, clearanceId, programmeId

  try {
    const r = await c.query(
      `INSERT INTO spatial_planning.health_premises (reference, name, premises_type)
       VALUES ('PR-SMOKE-0001','Smoke Test Bakery','bakery') RETURNING id`)
    premisesId = r.rows[0].id; ok('seed premises')
  } catch (e) { bad('seed premises', e) }

  try {
    const r = await c.query(
      `INSERT INTO spatial_planning.health_premises_inspection
         (reference, premises_id, inspected_at, inspector_name, scope, verdict,
          findings, action_required, follow_up_date,
          location, location_source, location_accuracy_m, created_by)
       VALUES ($1,$2,COALESCE($3::timestamptz, NOW()),$4,$5,$6,$7,$8,$9::date,
               ${pointSql('$10', '$11')},$12,$13,$14)
       RETURNING *, ${XY('health_premises_inspection')}`,
      ['IN-SMOKE-0001', premisesId, null, 'T Moyo', 'food_hygiene', 'fail',
        'Fly screens torn.', 'Replace screens within 7 days.', '2026-10-01',
        29.8, -19.4, 'field_gps', 5, null])
    inspectionId = r.rows[0].id
    ok('insert inspection (geometry + verdict CHECK)')
  } catch (e) { bad('insert inspection', e) }

  try {
    await c.query(
      `UPDATE spatial_planning.health_premises
          SET last_inspected_at = GREATEST(COALESCE(last_inspected_at, $2), $2), updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL`, [premisesId, new Date().toISOString()])
    ok('premises last_inspected_at rollup')
  } catch (e) { bad('premises rollup', e) }

  try {
    await c.query(
      `SELECT i.*, ${XY('i')}, p.name AS premises_name, u.full_name AS created_by_name
         FROM spatial_planning.health_premises_inspection i
         JOIN spatial_planning.health_premises p ON p.id = i.premises_id
         LEFT JOIN public.users u ON u.id = i.created_by
        WHERE ($1::uuid IS NULL OR i.premises_id = $1)
          AND ($2::text IS NULL OR i.verdict = $2)
          AND ($3::timestamptz IS NULL OR i.inspected_at >= $3)
          AND ($4::timestamptz IS NULL OR i.inspected_at <= $4)
          AND ($5::boolean IS FALSE OR (i.follow_up_date IS NOT NULL AND i.verdict <> 'pass'))
        ORDER BY i.inspected_at DESC LIMIT $6 OFFSET $7`,
      [premisesId, null, null, null, true, 10, 0])
    ok('list inspections (all filters)')
  } catch (e) { bad('list inspections', e) }

  try {
    await c.query(
      `UPDATE spatial_planning.health_premises_inspection
          SET notice_id = $2, updated_at = NOW()
        WHERE id = $1 RETURNING *, ${XY('health_premises_inspection')}`, [inspectionId, null])
    ok('patch inspection')
  } catch (e) { bad('patch inspection', e) }

  let noticeId
  try {
    const r = await c.query(
      `INSERT INTO spatial_planning.health_abatement_notice
         (reference, notice_type, premises_id, complaint_id, stand_number, suburb_ward,
          subject_name, subject_address, subject_contact,
          nuisance_description, required_action, compliance_days,
          served_at, served_method, issued_by_name, issued_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz, NOW()),$14,$15,$16)
       RETURNING id`,
      ['AN-SMOKE-0001', 'abatement', premisesId, null, '4521', 'Ward 3', 'A Dube', 'Stand 4521', null,
        'Blocked soakaway overflowing to the road.', 'Clear and repair the soakaway.', 14,
        null, 'hand', 'T Moyo', null])
    noticeId = r.rows[0].id
    await c.query(`UPDATE spatial_planning.health_premises_inspection SET notice_id = $2 WHERE id = $1`, [inspectionId, noticeId])
    ok('serve notice + link grounding inspection')
  } catch (e) { bad('serve notice', e) }

  try {
    const r = await c.query(
      `SELECT n.*, p.name AS premises_name, c.reference AS complaint_reference,
              COALESCE(n.extended_to, (n.served_at AT TIME ZONE 'Africa/Harare')::date + n.compliance_days) AS compliance_due,
              (SELECT COUNT(*) FROM spatial_planning.health_premises_inspection i WHERE i.notice_id = n.id) AS reinspections,
              (SELECT i.verdict FROM spatial_planning.health_premises_inspection i
                WHERE i.notice_id = n.id ORDER BY i.inspected_at DESC LIMIT 1) AS last_reinspection_verdict
         FROM spatial_planning.health_abatement_notice n
         LEFT JOIN spatial_planning.health_premises p ON p.id = n.premises_id
         LEFT JOIN spatial_planning.health_nuisance_complaint c ON c.id = n.complaint_id
        WHERE n.id = $1`, [noticeId])
    const row = r.rows[0]
    if (Number(row.reinspections) !== 1 || row.last_reinspection_verdict !== 'fail') throw new Error('link not visible: ' + JSON.stringify(row))
    ok('notice read-back (due date, linked inspection counted)')
  } catch (e) { bad('notice read-back', e) }

  try {
    await c.query(
      `UPDATE spatial_planning.health_abatement_notice SET
         status = COALESCE($2, status), extended_to = COALESCE($3::date, extended_to),
         escalation = COALESCE($4, escalation), outcome_notes = COALESCE($5, outcome_notes),
         closed_at = CASE WHEN $6::boolean THEN COALESCE(closed_at, NOW())
                          WHEN $2 IS NOT NULL THEN NULL ELSE closed_at END,
         updated_at = NOW()
       WHERE id = $1 RETURNING id`, [noticeId, 'escalated', null, 'prosecution', 'Not complied at re-inspection.', true])
    ok('escalate notice to prosecution (closed + dated)')
  } catch (e) { bad('escalate notice', e) }

  try {
    const r = await c.query(
      `INSERT INTO spatial_planning.health_food_handler_cert
         (reference, premises_id, handler_name, handler_id_number,
          expires_at, medical_clearance_source, notes, issued_by)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8) RETURNING *`,
      ['FH-SMOKE-0001', premisesId, 'R Ncube', '12-345678-A-12',
        '2027-09-14', 'Gweru District Clinic', null, null])
    handlerId = r.rows[0].id; ok('insert food-handler cert')
  } catch (e) { bad('insert food-handler cert', e) }

  try {
    await c.query(
      `SELECT h.*, p.name AS premises_name, u.full_name AS issued_by_name
         FROM spatial_planning.health_food_handler_cert h
         JOIN spatial_planning.health_premises p ON p.id = h.premises_id
         LEFT JOIN public.users u ON u.id = h.issued_by
        WHERE ($1::uuid IS NULL OR h.premises_id = $1)
          AND ($2::text IS NULL OR (h.handler_name ILIKE '%' || $2 || '%'
            OR h.handler_id_number ILIKE '%' || $2 || '%' OR h.reference ILIKE '%' || $2 || '%'))
          AND ($3::int IS NULL OR h.expires_at <= CURRENT_DATE + ($3 || ' days')::interval)
          AND ($4::boolean IS TRUE OR h.revoked_at IS NULL)
        ORDER BY h.expires_at ASC LIMIT $5`, [premisesId, 'Ncube', 400, false, 10])
    ok('list food-handler certs (expiring filter)')
  } catch (e) { bad('list food-handler certs', e) }

  try {
    await c.query(
      `UPDATE spatial_planning.health_food_handler_cert
          SET revoked_at = NOW(), revoked_by = $2, revoked_reason = $3
        WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
      [handlerId, null, 'Medical clearance withdrawn.'])
    ok('revoke food-handler cert')
  } catch (e) { bad('revoke food-handler cert', e) }

  try {
    const r = await c.query(
      `INSERT INTO spatial_planning.health_burial_permit
         (reference, permit_kind, deceased_name, deceased_id_number, date_of_death,
          cause_of_death, cemetery, ward, interment_at,
          applicant_name, applicant_relation, applicant_contact,
          issued_by_name, issued_by, notes)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9::timestamptz,$10,$11,$12,$13,$14,$15) RETURNING *`,
      ['BP-SMOKE-0001', 'burial', 'J Sibanda', null, '2026-09-10', 'Natural causes',
        'Ward 4 Cemetery', '4', null, 'M Sibanda', 'son', null, 'T Moyo', null, null])
    burialId = r.rows[0].id; ok('insert burial permit')
  } catch (e) { bad('insert burial permit', e) }

  try {
    await c.query(
      `SELECT b.* FROM spatial_planning.health_burial_permit b
        WHERE ($1::text IS NULL OR (b.deceased_name ILIKE '%' || $1 || '%'
          OR b.reference ILIKE '%' || $1 || '%' OR b.cemetery ILIKE '%' || $1 || '%'))
          AND ($2::text IS NULL OR b.permit_kind = $2)
        ORDER BY b.issued_at DESC LIMIT $3 OFFSET $4`, ['Sibanda', 'burial', 10, 0])
    ok('list burial permits')
  } catch (e) { bad('list burial permits', e) }

  try {
    await c.query(
      `UPDATE spatial_planning.health_burial_permit
          SET cancelled_at = NOW(), cancelled_by = $2, cancelled_reason = $3
        WHERE id = $1 AND cancelled_at IS NULL RETURNING *`,
      [burialId, null, 'Duplicate application.'])
    ok('cancel burial permit')
  } catch (e) { bad('cancel burial permit', e) }

  try {
    const r = await c.query(
      `INSERT INTO spatial_planning.health_licence_clearance
         (reference, licence_type, applicant_name, applicant_contact, trading_name,
          premises_id, stand_number, suburb_ward, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      ['LC-SMOKE-0001', 'shop', 'A Dube', null, 'Dube General Dealer',
        premisesId, '4521', 'Ward 3', null, null])
    clearanceId = r.rows[0].id; ok('insert licence clearance')
  } catch (e) { bad('insert licence clearance', e) }

  const SELECT_CLEARANCE = `
    SELECT c.*, p.name AS premises_name,
           i.reference AS inspection_reference, i.verdict AS inspection_verdict
      FROM spatial_planning.health_licence_clearance c
      LEFT JOIN spatial_planning.health_premises p ON p.id = c.premises_id
      LEFT JOIN spatial_planning.health_premises_inspection i ON i.id = c.inspection_id`
  try {
    await c.query(`${SELECT_CLEARANCE}
      WHERE ($1::text IS NULL OR c.status = $1)
        AND ($2::text IS NULL OR c.licence_type = $2)
        AND ($3::text IS NULL OR (c.applicant_name ILIKE '%' || $3 || '%'
          OR c.trading_name ILIKE '%' || $3 || '%' OR c.reference ILIKE '%' || $3 || '%'
          OR c.stand_number ILIKE '%' || $3 || '%'))
        AND ($4::boolean IS FALSE OR c.status = 'pending')
      ORDER BY c.received_at DESC LIMIT $5`, [null, 'shop', 'Dube', true, 10])
    ok('list clearances')
  } catch (e) { bad('list clearances', e) }

  try {
    await c.query(
      `UPDATE spatial_planning.health_licence_clearance SET
         status          = COALESCE($2, status),
         conditions      = COALESCE($3, conditions),
         refusal_reason  = COALESCE($4, refusal_reason),
         valid_until     = COALESCE($5::date, valid_until),
         inspection_id   = COALESCE($6::uuid, inspection_id),
         notes           = COALESCE($7, notes),
         decided_at      = CASE WHEN $8::boolean THEN NOW()
                                WHEN $2 = 'pending' THEN NULL ELSE decided_at END,
         decided_by      = CASE WHEN $8::boolean THEN $9::uuid
                                WHEN $2 = 'pending' THEN NULL ELSE decided_by END,
         decided_by_name = CASE WHEN $8::boolean THEN COALESCE($10, decided_by_name)
                                WHEN $2 = 'pending' THEN NULL ELSE decided_by_name END,
         updated_at      = NOW()
       WHERE id = $1 RETURNING id`,
      [clearanceId, 'conditional', 'Provide a grease trap before trading.', null,
        '2027-01-31', inspectionId, null, true, null, 'T Moyo'])
    ok('patch clearance to conditional (decision dated, CHECK held)')
  } catch (e) { bad('patch clearance', e) }

  try {
    const r = await c.query(
      `INSERT INTO spatial_planning.health_field_programme
         (reference, programme_type, title, ward, village_or_area, scheduled_for,
          target_quantity, quantity_unit, team_lead, team_size, notes,
          location, location_source, location_accuracy_m, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,${pointSql('$12', '$13')},$14,$15,$16)
       RETURNING *, ${XY('health_field_programme')}`,
      ['FP-SMOKE-0001', 'indoor_residual_spray', 'IRS round 1 Ward 7', '7', 'Chizhou',
        '2026-10-05', 420, 'households', 'S Chirwa', 6, null, 29.9, -19.3, 'ward_centroid', null, null])
    programmeId = r.rows[0].id; ok('insert field programme')
  } catch (e) { bad('insert field programme', e) }

  try {
    await c.query(
      `SELECT g.*, ${XY('g')} FROM spatial_planning.health_field_programme g
        WHERE ($1::text IS NULL OR g.programme_type = $1)
          AND ($2::text IS NULL OR g.status = $2)
          AND ($3::text IS NULL OR g.ward = $3)
          AND ($4::date IS NULL OR g.scheduled_for >= $4::date)
          AND ($5::date IS NULL OR g.scheduled_for <= $5::date)
        ORDER BY g.scheduled_for DESC LIMIT $6`,
      ['indoor_residual_spray', null, '7', '2026-01-01', '2026-12-31', 10])
    ok('list programmes')
  } catch (e) { bad('list programmes', e) }

  try {
    await c.query(
      `UPDATE spatial_planning.health_field_programme SET
         status            = COALESCE($2, status),
         achieved_quantity = COALESCE($3, achieved_quantity),
         quantity_unit     = COALESCE($4, quantity_unit),
         team_lead         = COALESCE($5, team_lead),
         notes             = COALESCE($6, notes),
         cancelled_reason  = COALESCE($7, cancelled_reason),
         executed_at       = CASE WHEN $8::boolean THEN COALESCE($9::timestamptz, executed_at, NOW())
                                  ELSE COALESCE($9::timestamptz, executed_at) END,
         updated_at        = NOW()
       WHERE id = $1 RETURNING *, ${XY('health_field_programme')}`,
      [programmeId, 'completed', 397, null, null, null, null, true, null])
    ok('patch programme to completed (executed_at auto-stamped)')
  } catch (e) { bad('patch programme', e) }

  try {
    const r = await c.query(
      `SELECT
         (SELECT COUNT(*) FROM spatial_planning.health_premises WHERE deleted_at IS NULL) AS premises,
         (SELECT COUNT(*) FROM spatial_planning.health_premises
           WHERE deleted_at IS NULL AND (last_inspected_at IS NULL
             OR last_inspected_at < NOW() - ($1 || ' days')::interval)) AS premises_overdue,
         (SELECT COUNT(*) FROM spatial_planning.health_outbreak WHERE status <> 'closed') AS outbreaks_open,
         (SELECT COALESCE(SUM(cases_count), 0) FROM spatial_planning.health_outbreak
           WHERE status <> 'closed') AS outbreak_cases_open,
         (SELECT COUNT(*) FROM spatial_planning.health_water_sample
           WHERE result = 'not_potable' AND sampled_at > NOW() - INTERVAL '90 days') AS water_failing_90d,
         (SELECT COUNT(*) FROM spatial_planning.health_nuisance_complaint
           WHERE status IN ('open','investigating')) AS complaints_open,
         (SELECT COUNT(*) FROM spatial_planning.health_premises_inspection
           WHERE follow_up_date IS NOT NULL AND verdict <> 'pass'
             AND follow_up_date <= CURRENT_DATE) AS followups_due,
         (SELECT COUNT(*) FROM spatial_planning.health_food_handler_cert
           WHERE revoked_at IS NULL
             AND expires_at BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days')
           AS handler_certs_expiring_30d,
         (SELECT COUNT(*) FROM spatial_planning.health_food_handler_cert
           WHERE revoked_at IS NULL AND expires_at < CURRENT_DATE) AS handler_certs_expired,
         (SELECT COUNT(*) FROM spatial_planning.health_licence_clearance
           WHERE status = 'pending') AS clearances_pending,
         (SELECT COUNT(*) FROM spatial_planning.health_field_programme
           WHERE status IN ('planned','in_progress') AND scheduled_for <= CURRENT_DATE) AS programmes_due`,
      [90])
    ok('summary, 11 counters: ' + JSON.stringify(r.rows[0]))
  } catch (e) { bad('summary', e) }

  const mustReject = async (label, sql, params) => {
    await c.query('SAVEPOINT sp')
    try {
      await c.query(sql, params)
      failures++; console.log('  FAIL ' + label + ' :: was ACCEPTED')
    } catch (e) { ok(label + ' rejected (' + (e.constraint || e.code) + ')') }
    await c.query('ROLLBACK TO SAVEPOINT sp')
  }
  await mustReject('fail verdict with no action_required',
    `INSERT INTO spatial_planning.health_premises_inspection
       (reference, premises_id, inspector_name, scope, verdict, findings)
     VALUES ('IN-X-1',$1,'T Moyo','general','fail','Dirty.')`, [premisesId])
  await mustReject('extended notice with no new date',
    `INSERT INTO spatial_planning.health_abatement_notice
       (reference, notice_type, subject_name, nuisance_description, required_action, compliance_days, issued_by_name, status)
     VALUES ('AN-X-1','abatement','A','x','y',7,'T Moyo','extended')`, [])
  await mustReject('withdrawn notice with no reason',
    `INSERT INTO spatial_planning.health_abatement_notice
       (reference, notice_type, subject_name, nuisance_description, required_action, compliance_days, issued_by_name, status, closed_at)
     VALUES ('AN-X-2','abatement','A','x','y',7,'T Moyo','withdrawn', NOW())`, [])
  await mustReject('programme quantity with no unit',
    `INSERT INTO spatial_planning.health_field_programme
       (reference, programme_type, title, ward, scheduled_for, target_quantity)
     VALUES ('FP-X-1','larviciding','X','3','2026-10-01',100)`, [])
  await mustReject('completed programme with no executed_at',
    `INSERT INTO spatial_planning.health_field_programme
       (reference, programme_type, title, ward, scheduled_for, status)
     VALUES ('FP-X-2','larviciding','X','3','2026-10-01','completed')`, [])
  await mustReject('handler cert expiring before it is issued',
    `INSERT INTO spatial_planning.health_food_handler_cert
       (reference, premises_id, handler_name, expires_at, medical_clearance_source)
     VALUES ('FH-X-1',$1,'R Ncube','2020-01-01','Clinic')`, [premisesId])
  await mustReject('clearance refused with no reason',
    `INSERT INTO spatial_planning.health_licence_clearance
       (reference, licence_type, applicant_name, status, decided_at)
     VALUES ('LC-X-1','shop','A Dube','refused', NOW())`, [])
  await mustReject('decided clearance with no decided_at',
    `INSERT INTO spatial_planning.health_licence_clearance
       (reference, licence_type, applicant_name, status)
     VALUES ('LC-X-2','shop','A Dube','cleared')`, [])
  await mustReject('anonymous-style: burial permit dated before the death',
    `INSERT INTO spatial_planning.health_burial_permit
       (reference, deceased_name, date_of_death, cemetery, issued_by_name)
     VALUES ('BP-X-1','J Sibanda','2030-01-01','Ward 4','T Moyo')`, [])

  await c.query('ROLLBACK')
  await c.end()
  console.log(failures
    ? '\n' + failures + ' FAILURE(S)'
    : '\nall statements and constraints verified; transaction rolled back')
  process.exit(failures ? 1 : 0)
})()
