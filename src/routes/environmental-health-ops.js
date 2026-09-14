// src/routes/environmental-health-ops.js
// ─────────────────────────────────────────────────────────────────────────
// The Environmental Health Officer's operational record: the inspections
// carried out, the documents issued, and the field programmes run.
//
//   GET  /eho/notices                POST /eho/notices       PATCH /eho/notices/:id
//   GET  /eho/inspections            POST /eho/inspections
//   PATCH /eho/inspections/:id       (links the notice it grounded)
//   GET  /eho/food-handlers          POST /eho/food-handlers
//   POST /eho/food-handlers/:id/revoke
//   GET  /eho/burial-permits         POST /eho/burial-permits
//   POST /eho/burial-permits/:id/cancel
//   GET  /eho/clearances             POST /eho/clearances    PATCH /eho/clearances/:id
//   GET  /eho/programmes             POST /eho/programmes    PATCH /eho/programmes/:id
//   GET  /eho/summary                every console counter in one round trip
//
// Tables: spatial_planning.health_* (migration 122), alongside the four
// registers of migration 121 served by environmental-health.js. Split into a
// second file because one 1,700-line route module is not reviewable, not
// because the two halves are different subsystems — they share the /eho
// prefix, the role lists and the reference format on purpose.
//
// WHY /eho/summary EXISTS
// The dashboard needs eight counts drawn from seven tables. Fetching seven
// lists and counting them in the browser moves rows across a link that, for
// this council, is a rural Zimbabwean one — and then throws away every row but
// the length. The counts are computed where the rows already are.
//
// WHAT THESE ENDPOINTS REFUSE TO DO
// Nothing here decides anything either. A clearance is recorded, not granted;
// a certificate is registered, not vouched for. The officer decides under the
// Public Health Act and these rows are the council's memory of it.
// ─────────────────────────────────────────────────────────────────────────

const { requireRole } = require('../middleware/jwtAuth')

// Same ownership as the registers: the EHO writes, admin shares every write
// for support, and the other planning roles read what touches their own work.
const WRITE_ROLES = ['env_officer', 'admin']
const READ_ROLES = [
  'admin', 'planner', 'planning_clerk', 'building_inspector',
  'eo', 'env_officer', 'surveyor', 'gis_officer',
]

const INSPECTION_SCOPES = [
  'food_hygiene', 'sanitation', 'water_supply',
  'pest_control', 'staff_hygiene', 'general',
]
const INSPECTION_VERDICTS = ['pass', 'fail', 'conditional', 'pending']
const INSPECTION_POSITION_SOURCES = ['field_gps', 'map_pick', 'premises']

const NOTICE_TYPES = ['abatement', 'closure', 'works_in_default', 'prohibition']
const NOTICE_STATUSES = ['served', 'extended', 'complied', 'non_complied', 'escalated', 'withdrawn']
const NOTICE_ESCALATIONS = ['works_in_default', 'prosecution', 'closure']
const SERVED_METHODS = ['hand', 'registered_post', 'affixed', 'email']
// Outcomes that end a notice. They are dated when reached.
const NOTICE_CLOSING = ['complied', 'escalated', 'withdrawn']

const PERMIT_KINDS = ['burial', 'exhumation', 'reburial']

const LICENCE_TYPES = [
  'shop', 'liquor', 'hawker', 'food_outlet', 'lodging',
  'abattoir', 'creche', 'transport_of_food', 'other',
]
const CLEARANCE_STATUSES = ['pending', 'cleared', 'conditional', 'refused', 'withdrawn']

const PROGRAMME_TYPES = [
  'refuse_collection', 'illegal_dump_clearance', 'disposal_site_check',
  'latrine_construction', 'indoor_residual_spray', 'larviciding',
  'rodent_control', 'health_education', 'water_point_maintenance', 'other',
]
const PROGRAMME_STATUSES = ['planned', 'in_progress', 'completed', 'cancelled']
const PROGRAMME_POSITION_SOURCES = ['field_gps', 'map_pick', 'ward_centroid']

// ── Validation primitives ───────────────────────────────────────────────
// Deliberately the same helpers, with the same names and semantics, as
// environmental-health.js. Two /eho files that validated a coordinate
// differently would be a bug waiting for whichever one is read second.

const isUuid = (v) =>
  typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)

const isStr = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max
const orNull = (v, max) => (isStr(v, max) ? v.trim() : null)

const f = (v) => (v == null ? null : Number(v))

function coord(v, min, max) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined
}

/** { lng, lat } | null (absent) | undefined (invalid or half a pair) */
function readLngLat(lngRaw, latRaw) {
  const lng = coord(lngRaw, -180, 180)
  const lat = coord(latRaw, -90, 90)
  if (lng === undefined || lat === undefined) return undefined
  if (lng === null && lat === null) return null
  if (lng === null || lat === null) return undefined
  if (lng === 0 && lat === 0) return undefined   // a null-island default, never a real fix
  return { lng, lat }
}

/** Whole number in range, or undefined when present-but-invalid. */
function int(v, min, max) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return undefined
  return n
}

function num(v, min, max) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < min || n > max) return undefined
  return n
}

/** An ISO date (YYYY-MM-DD or a full timestamp), or undefined if unparseable. */
function isoDate(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string' || v.length > 40) return undefined
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : v
}

/**
 * A position and its provenance, validated together against the source list
 * this table actually allows — the CHECK constraints differ per table, and a
 * 500 from a constraint violation is a worse answer than a 400 naming the field.
 */
function readPosition(b, allowedSources) {
  const pos = readLngLat(b.lng, b.lat)
  if (pos === undefined) return { error: 'bad_position' }
  const source = orNull(b.location_source, 20)
  if (source && !allowedSources.includes(source)) return { error: 'bad_location_source' }
  const accuracy = num(b.location_accuracy_m, 0, 100000)
  if (accuracy === undefined) return { error: 'bad_accuracy' }
  if (!pos && (source || accuracy != null)) return { error: 'position_required_for_source' }
  return { pos, source, accuracy }
}

// ── DTOs ────────────────────────────────────────────────────────────────
function inspectionDto(r) {
  return {
    id: r.id,
    reference: r.reference,
    premises_id: r.premises_id,
    premises_name: r.premises_name ?? null,
    inspected_at: r.inspected_at,
    inspector_name: r.inspector_name,
    scope: r.scope,
    verdict: r.verdict,
    findings: r.findings,
    action_required: r.action_required,
    follow_up_date: r.follow_up_date,
    notice_id: r.notice_id,
    lng: f(r.lng),
    lat: f(r.lat),
    location_source: r.location_source,
    location_accuracy_m: f(r.location_accuracy_m),
    created_at: r.created_at,
    created_by_name: r.created_by_name ?? null,
  }
}

function noticeDto(r) {
  return {
    id: r.id,
    reference: r.reference,
    notice_type: r.notice_type,
    premises_id: r.premises_id,
    premises_name: r.premises_name ?? null,
    complaint_id: r.complaint_id,
    complaint_reference: r.complaint_reference ?? null,
    stand_number: r.stand_number,
    suburb_ward: r.suburb_ward,
    subject_name: r.subject_name,
    subject_address: r.subject_address,
    subject_contact: r.subject_contact,
    nuisance_description: r.nuisance_description,
    required_action: r.required_action,
    compliance_days: r.compliance_days,
    served_at: r.served_at,
    served_method: r.served_method,
    // The date the notice falls due: the extension if one was granted,
    // otherwise service plus the compliance period. Computed in SQL so every
    // reader agrees on one calendar.
    compliance_due: r.compliance_due,
    status: r.status,
    extended_to: r.extended_to,
    escalation: r.escalation,
    outcome_notes: r.outcome_notes,
    closed_at: r.closed_at,
    issued_by_name: r.issued_by_name,
    reinspections: r.reinspections == null ? 0 : Number(r.reinspections),
    last_reinspection_verdict: r.last_reinspection_verdict ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

function handlerDto(r) {
  return {
    id: r.id,
    reference: r.reference,
    premises_id: r.premises_id,
    premises_name: r.premises_name ?? null,
    handler_name: r.handler_name,
    handler_id_number: r.handler_id_number,
    issued_at: r.issued_at,
    expires_at: r.expires_at,
    medical_clearance_source: r.medical_clearance_source,
    notes: r.notes,
    revoked_at: r.revoked_at,
    revoked_reason: r.revoked_reason,
    issued_by_name: r.issued_by_name ?? null,
  }
}

function burialDto(r) {
  return {
    id: r.id,
    reference: r.reference,
    permit_kind: r.permit_kind,
    deceased_name: r.deceased_name,
    deceased_id_number: r.deceased_id_number,
    date_of_death: r.date_of_death,
    cause_of_death: r.cause_of_death,
    cemetery: r.cemetery,
    ward: r.ward,
    interment_at: r.interment_at,
    applicant_name: r.applicant_name,
    applicant_relation: r.applicant_relation,
    applicant_contact: r.applicant_contact,
    issued_by_name: r.issued_by_name,
    issued_at: r.issued_at,
    notes: r.notes,
    cancelled_at: r.cancelled_at,
    cancelled_reason: r.cancelled_reason,
  }
}

function clearanceDto(r) {
  return {
    id: r.id,
    reference: r.reference,
    licence_type: r.licence_type,
    applicant_name: r.applicant_name,
    applicant_contact: r.applicant_contact,
    trading_name: r.trading_name,
    premises_id: r.premises_id,
    premises_name: r.premises_name ?? null,
    stand_number: r.stand_number,
    suburb_ward: r.suburb_ward,
    received_at: r.received_at,
    inspection_id: r.inspection_id,
    inspection_reference: r.inspection_reference ?? null,
    inspection_verdict: r.inspection_verdict ?? null,
    status: r.status,
    conditions: r.conditions,
    refusal_reason: r.refusal_reason,
    decided_at: r.decided_at,
    decided_by_name: r.decided_by_name,
    valid_until: r.valid_until,
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

function programmeDto(r) {
  return {
    id: r.id,
    reference: r.reference,
    programme_type: r.programme_type,
    title: r.title,
    ward: r.ward,
    village_or_area: r.village_or_area,
    scheduled_for: r.scheduled_for,
    executed_at: r.executed_at,
    status: r.status,
    target_quantity: r.target_quantity,
    achieved_quantity: r.achieved_quantity,
    quantity_unit: r.quantity_unit,
    team_lead: r.team_lead,
    team_size: r.team_size,
    notes: r.notes,
    cancelled_reason: r.cancelled_reason,
    lng: f(r.lng),
    lat: f(r.lat),
    location_source: r.location_source,
    location_accuracy_m: f(r.location_accuracy_m),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

// Geometry never leaves as WKB — same rule as the registers file.
const XY = (alias) => `ST_X(${alias}.location) AS lng, ST_Y(${alias}.location) AS lat`

function pointSql(lngParam, latParam) {
  return `CASE WHEN ${lngParam}::double precision IS NULL THEN NULL
               ELSE ST_SetSRID(ST_MakePoint(${lngParam}::double precision, ${latParam}::double precision), 4326) END`
}

async function environmentalHealthOpsRoutes(fastify) {
  const pg = fastify.pg

  /** IN-2026-0007. The year is the year of creation; the counter never resets. */
  async function nextReference(client, seq, prefix) {
    const { rows } = await client.query(`SELECT nextval('spatial_planning.${seq}') AS n`)
    return `${prefix}-${new Date().getFullYear()}-${String(rows[0].n).padStart(4, '0')}`
  }

  const fail = (request, reply, err, what) => {
    request.log.error({ err }, `[eho-ops] ${what} failed`)
    return reply.code(500).send({ success: false, error: 'internal' })
  }

  // ══ PUBLIC HEALTH ACT NOTICES ═════════════════════════════════════════
  const SELECT_NOTICE = `
    SELECT n.*,
           p.name AS premises_name,
           c.reference AS complaint_reference,
           COALESCE(n.extended_to, (n.served_at AT TIME ZONE 'Africa/Harare')::date + n.compliance_days)
             AS compliance_due,
           (SELECT COUNT(*) FROM spatial_planning.health_premises_inspection i
             WHERE i.notice_id = n.id) AS reinspections,
           (SELECT i.verdict FROM spatial_planning.health_premises_inspection i
             WHERE i.notice_id = n.id ORDER BY i.inspected_at DESC LIMIT 1) AS last_reinspection_verdict
      FROM spatial_planning.health_abatement_notice n
      LEFT JOIN spatial_planning.health_premises p ON p.id = n.premises_id
      LEFT JOIN spatial_planning.health_nuisance_complaint c ON c.id = n.complaint_id`

  fastify.get('/eho/notices', { preHandler: requireRole(fastify, READ_ROLES) }, async (request, reply) => {
    const q = request.query || {}
    const status = NOTICE_STATUSES.includes(q.status) ? q.status : null
    const type = NOTICE_TYPES.includes(q.notice_type) ? q.notice_type : null
    const premisesId = isUuid(q.premises_id) ? q.premises_id : null
    const search = isStr(q.search, 120) ? q.search.trim() : null
    const openOnly = q.open === 'true' || q.open === true
    const limit = Math.min(Number(q.limit) || 200, 500)
    try {
      const { rows } = await pg.query(
        `SELECT * FROM (${SELECT_NOTICE}) x
          WHERE ($1::text IS NULL OR x.status = $1)
            AND ($2::text IS NULL OR x.notice_type = $2)
            AND ($3::uuid IS NULL OR x.premises_id = $3)
            AND ($4::text IS NULL OR (
                  x.reference ILIKE '%' || $4 || '%'
               OR x.subject_name ILIKE '%' || $4 || '%'
               OR x.stand_number ILIKE '%' || $4 || '%'
               OR x.premises_name ILIKE '%' || $4 || '%'))
            AND ($5::boolean IS FALSE OR x.status IN ('served', 'extended', 'non_complied'))
          ORDER BY (x.status IN ('served', 'extended', 'non_complied')) DESC, x.compliance_due ASC
          LIMIT $6`,
        [status, type, premisesId, search, openOnly, limit],
      )
      return reply.send({ success: true, data: rows.map(noticeDto) })
    } catch (err) { return fail(request, reply, err, 'list notices') }
  })

  fastify.post('/eho/notices', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const b = request.body || {}
    if (!NOTICE_TYPES.includes(b.notice_type)) return reply.code(400).send({ success: false, error: 'bad_notice_type' })
    for (const [field, max] of [['subject_name', 160], ['nuisance_description', 8000], ['required_action', 8000], ['issued_by_name', 160]]) {
      if (!isStr(b[field], max)) return reply.code(400).send({ success: false, error: 'missing_field', field })
    }
    const days = int(b.compliance_days, 1, 180)
    if (days === undefined || days === null) return reply.code(400).send({ success: false, error: 'bad_compliance_days' })
    const method = b.served_method === undefined ? 'hand' : b.served_method
    if (!SERVED_METHODS.includes(method)) return reply.code(400).send({ success: false, error: 'bad_served_method' })
    const servedAt = isoDate(b.served_at)
    if (servedAt === undefined) return reply.code(400).send({ success: false, error: 'bad_served_at' })
    // A notice dated in the future has not been served, and its compliance
    // clock would start on a day that has not happened.
    if (servedAt && Date.parse(servedAt) > Date.now() + 5 * 60000) {
      return reply.code(400).send({ success: false, error: 'served_in_future' })
    }

    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const reference = await nextReference(client, 'health_abatement_notice_seq', 'AN')
      const { rows } = await client.query(
        `INSERT INTO spatial_planning.health_abatement_notice
           (reference, notice_type, premises_id, complaint_id, stand_number, suburb_ward,
            subject_name, subject_address, subject_contact,
            nuisance_description, required_action, compliance_days,
            served_at, served_method, issued_by_name, issued_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz, NOW()),$14,$15,$16)
         RETURNING id`,
        [
          reference, b.notice_type,
          isUuid(b.premises_id) ? b.premises_id : null,
          isUuid(b.complaint_id) ? b.complaint_id : null,
          orNull(b.stand_number, 40), orNull(b.suburb_ward, 120),
          b.subject_name.trim(), orNull(b.subject_address, 300), orNull(b.subject_contact, 40),
          b.nuisance_description.trim(), b.required_action.trim(), days,
          servedAt, method, b.issued_by_name.trim(), request.user.id,
        ],
      )
      const id = rows[0].id
      // The inspection that grounded the notice, when the officer names one.
      if (isUuid(b.inspection_id)) {
        await client.query(
          `UPDATE spatial_planning.health_premises_inspection SET notice_id = $2, updated_at = NOW()
            WHERE id = $1 AND notice_id IS NULL`, [b.inspection_id, id])
      }
      // The complaint the notice answers now carries its reference, so the
      // complaint book shows which notice abates it.
      if (isUuid(b.complaint_id)) {
        await client.query(
          `UPDATE spatial_planning.health_nuisance_complaint
              SET abatement_notice_ref = $2, updated_at = NOW()
            WHERE id = $1`, [b.complaint_id, reference])
      }
      await client.query('COMMIT')
      const { rows: full } = await pg.query(`${SELECT_NOTICE} WHERE n.id = $1`, [id])
      return reply.code(201).send({ success: true, data: noticeDto(full[0]) })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      if (err && err.code === '23503') return reply.code(404).send({ success: false, error: 'linked_record_not_found' })
      return fail(request, reply, err, 'serve notice')
    } finally { client.release() }
  })

  fastify.patch('/eho/notices/:id', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    const status = b.status === undefined ? null : b.status
    if (status !== null && !NOTICE_STATUSES.includes(status)) {
      return reply.code(400).send({ success: false, error: 'bad_status' })
    }
    const extendedTo = isoDate(b.extended_to)
    if (extendedTo === undefined) return reply.code(400).send({ success: false, error: 'bad_extended_to' })
    const escalation = b.escalation === undefined || b.escalation === null ? null : b.escalation
    if (escalation !== null && !NOTICE_ESCALATIONS.includes(escalation)) {
      return reply.code(400).send({ success: false, error: 'bad_escalation' })
    }
    const notes = orNull(b.outcome_notes, 8000)
    // The CHECK constraints, restated so the officer is told which field.
    if (status === 'extended' && !extendedTo) return reply.code(400).send({ success: false, error: 'extended_to_required' })
    if (status === 'escalated' && !escalation) return reply.code(400).send({ success: false, error: 'escalation_required' })
    if (status === 'withdrawn' && !notes) return reply.code(400).send({ success: false, error: 'outcome_notes_required' })

    const closing = status !== null && NOTICE_CLOSING.includes(status)
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.health_abatement_notice SET
           status        = COALESCE($2, status),
           extended_to   = COALESCE($3::date, extended_to),
           escalation    = COALESCE($4, escalation),
           outcome_notes = COALESCE($5, outcome_notes),
           closed_at     = CASE WHEN $6::boolean THEN COALESCE(closed_at, NOW())
                                WHEN $2 IS NOT NULL THEN NULL
                                ELSE closed_at END,
           updated_at    = NOW()
         WHERE id = $1
         RETURNING id`,
        [id, status, extendedTo, escalation, notes, closing],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      const { rows: full } = await pg.query(`${SELECT_NOTICE} WHERE n.id = $1`, [id])
      return reply.send({ success: true, data: noticeDto(full[0]) })
    } catch (err) { return fail(request, reply, err, 'update notice') }
  })

  // ══ PREMISES INSPECTIONS ══════════════════════════════════════════════
  const SELECT_INSPECTION = `
    SELECT i.*, ${XY('i')}, p.name AS premises_name, u.full_name AS created_by_name
      FROM spatial_planning.health_premises_inspection i
      JOIN spatial_planning.health_premises p ON p.id = i.premises_id
      LEFT JOIN public.users u ON u.id = i.created_by`

  fastify.get('/eho/inspections', { preHandler: requireRole(fastify, READ_ROLES) }, async (request, reply) => {
    const q = request.query || {}
    const premisesId = isUuid(q.premises_id) ? q.premises_id : null
    const verdict = INSPECTION_VERDICTS.includes(q.verdict) ? q.verdict : null
    const from = isoDate(q.from)
    const to = isoDate(q.to)
    if (from === undefined || to === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_date_range' })
    }
    // The follow-up queue: what an officer owes a return visit on.
    const dueOnly = q.due === 'true' || q.due === true
    const limit = Math.min(Number(q.limit) || 200, 500)
    const offset = Math.max(Number(q.offset) || 0, 0)

    try {
      const { rows } = await pg.query(
        `${SELECT_INSPECTION}
          WHERE ($1::uuid IS NULL OR i.premises_id = $1)
            AND ($2::text IS NULL OR i.verdict = $2)
            AND ($3::timestamptz IS NULL OR i.inspected_at >= $3)
            AND ($4::timestamptz IS NULL OR i.inspected_at <= $4)
            AND ($5::boolean IS FALSE
                 OR (i.follow_up_date IS NOT NULL AND i.verdict <> 'pass'))
          ORDER BY i.inspected_at DESC
          LIMIT $6 OFFSET $7`,
        [premisesId, verdict, from, to, dueOnly, limit, offset],
      )
      return reply.send({ success: true, data: rows.map(inspectionDto) })
    } catch (err) { return fail(request, reply, err, 'list inspections') }
  })

  fastify.post('/eho/inspections', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const b = request.body || {}
    if (!isUuid(b.premises_id)) return reply.code(400).send({ success: false, error: 'bad_premises_id' })
    if (!isStr(b.inspector_name, 160)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'inspector_name' })
    }
    if (!INSPECTION_SCOPES.includes(b.scope)) return reply.code(400).send({ success: false, error: 'bad_scope' })
    if (!INSPECTION_VERDICTS.includes(b.verdict)) return reply.code(400).send({ success: false, error: 'bad_verdict' })
    if (!isStr(b.findings, 8000)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'findings' })
    }
    const action = orNull(b.action_required, 8000)
    // The DB enforces this too. Checking here turns a constraint violation
    // into a message that names the field the officer left empty.
    if ((b.verdict === 'fail' || b.verdict === 'conditional') && !action) {
      return reply.code(400).send({ success: false, error: 'action_required_for_verdict' })
    }
    const followUp = isoDate(b.follow_up_date)
    if (followUp === undefined) return reply.code(400).send({ success: false, error: 'bad_follow_up_date' })
    const inspectedAt = isoDate(b.inspected_at)
    if (inspectedAt === undefined) return reply.code(400).send({ success: false, error: 'bad_inspected_at' })

    const p = readPosition(b, INSPECTION_POSITION_SOURCES)
    if (p.error) return reply.code(400).send({ success: false, error: p.error })

    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const reference = await nextReference(client, 'health_premises_inspection_seq', 'IN')
      const { rows } = await client.query(
        `INSERT INTO spatial_planning.health_premises_inspection
           (reference, premises_id, inspected_at, inspector_name, scope, verdict,
            findings, action_required, follow_up_date,
            location, location_source, location_accuracy_m, created_by, notice_id)
         VALUES ($1,$2,COALESCE($3::timestamptz, NOW()),$4,$5,$6,$7,$8,$9::date,
                 ${pointSql('$10', '$11')},$12,$13,$14,$15)
         RETURNING *, ${XY('health_premises_inspection')}`,
        [
          reference, b.premises_id, inspectedAt, b.inspector_name.trim(),
          b.scope, b.verdict, b.findings.trim(), action, followUp,
          p.pos ? p.pos.lng : null, p.pos ? p.pos.lat : null,
          p.source, p.accuracy, request.user.id,
          isUuid(b.notice_id) ? b.notice_id : null,
        ],
      )
      // The premises register's "last inspected" is derived from the visits,
      // never typed separately — two places to record one fact is two places
      // to disagree about it. Only ever moves forward, so an inspection keyed
      // in late cannot rewind a premises that has been seen since.
      await client.query(
        `UPDATE spatial_planning.health_premises
            SET last_inspected_at = GREATEST(COALESCE(last_inspected_at, $2), $2),
                updated_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL`,
        [b.premises_id, rows[0].inspected_at],
      )
      await client.query('COMMIT')
      return reply.code(201).send({ success: true, data: inspectionDto(rows[0]) })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      if (err && err.code === '23503') {
        return reply.code(404).send({ success: false, error: 'premises_or_notice_not_found' })
      }
      return fail(request, reply, err, 'create inspection')
    } finally { client.release() }
  })

  // The only thing an inspection accepts after the fact: the notice it
  // grounded. The findings themselves are what the officer saw on the day and
  // are not editable — a correction is another visit.
  fastify.patch('/eho/inspections/:id', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (b.notice_id !== undefined && b.notice_id !== null && !isUuid(b.notice_id)) {
      return reply.code(400).send({ success: false, error: 'bad_notice_id' })
    }
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.health_premises_inspection
            SET notice_id = $2, updated_at = NOW()
          WHERE id = $1
          RETURNING *, ${XY('health_premises_inspection')}`,
        [id, b.notice_id ?? null],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: inspectionDto(rows[0]) })
    } catch (err) {
      if (err && err.code === '23503') return reply.code(404).send({ success: false, error: 'notice_not_found' })
      return fail(request, reply, err, 'update inspection')
    }
  })

  // ══ FOOD-HANDLER CERTIFICATES ═════════════════════════════════════════
  const SELECT_HANDLER = `
    SELECT h.*, p.name AS premises_name, u.full_name AS issued_by_name
      FROM spatial_planning.health_food_handler_cert h
      JOIN spatial_planning.health_premises p ON p.id = h.premises_id
      LEFT JOIN public.users u ON u.id = h.issued_by`

  fastify.get('/eho/food-handlers', { preHandler: requireRole(fastify, READ_ROLES) }, async (request, reply) => {
    const q = request.query || {}
    const premisesId = isUuid(q.premises_id) ? q.premises_id : null
    const search = isStr(q.search, 120) ? q.search.trim() : null
    // Certificates expiring inside N days — the renewal list an EHO works from.
    const expiringDays = int(q.expiring_days, 0, 3650)
    if (expiringDays === undefined) return reply.code(400).send({ success: false, error: 'bad_expiring_days' })
    const includeRevoked = q.include_revoked === 'true' || q.include_revoked === true
    const limit = Math.min(Number(q.limit) || 200, 500)

    try {
      const { rows } = await pg.query(
        `${SELECT_HANDLER}
          WHERE ($1::uuid IS NULL OR h.premises_id = $1)
            AND ($2::text IS NULL OR (
                  h.handler_name ILIKE '%' || $2 || '%'
               OR h.handler_id_number ILIKE '%' || $2 || '%'
               OR h.reference ILIKE '%' || $2 || '%'))
            AND ($3::int IS NULL OR h.expires_at <= CURRENT_DATE + ($3 || ' days')::interval)
            AND ($4::boolean IS TRUE OR h.revoked_at IS NULL)
          ORDER BY h.expires_at ASC
          LIMIT $5`,
        [premisesId, search, expiringDays, includeRevoked, limit],
      )
      return reply.send({ success: true, data: rows.map(handlerDto) })
    } catch (err) { return fail(request, reply, err, 'list food handlers') }
  })

  fastify.post('/eho/food-handlers', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const b = request.body || {}
    if (!isUuid(b.premises_id)) return reply.code(400).send({ success: false, error: 'bad_premises_id' })
    if (!isStr(b.handler_name, 160)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'handler_name' })
    }
    // A certificate with no clearance behind it is the forgery this register
    // exists to prevent, so the source of the clearance is mandatory.
    if (!isStr(b.medical_clearance_source, 200)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'medical_clearance_source' })
    }
    const expires = isoDate(b.expires_at)
    if (expires === undefined || expires === null) {
      return reply.code(400).send({ success: false, error: 'bad_expires_at' })
    }
    if (Date.parse(expires) <= Date.now()) {
      return reply.code(400).send({ success: false, error: 'expiry_in_past' })
    }

    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const reference = await nextReference(client, 'health_food_handler_seq', 'FH')
      const { rows } = await client.query(
        `INSERT INTO spatial_planning.health_food_handler_cert
           (reference, premises_id, handler_name, handler_id_number,
            expires_at, medical_clearance_source, notes, issued_by)
         VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8)
         RETURNING *`,
        [
          reference, b.premises_id, b.handler_name.trim(), orNull(b.handler_id_number, 40),
          expires, b.medical_clearance_source.trim(), orNull(b.notes, 4000), request.user.id,
        ],
      )
      await client.query('COMMIT')
      // The list endpoint joins the premises name; a fresh insert has not.
      // Re-reading through the same SELECT keeps one shape for one record.
      const { rows: full } = await pg.query(`${SELECT_HANDLER} WHERE h.id = $1`, [rows[0].id])
      return reply.code(201).send({ success: true, data: handlerDto(full[0] || rows[0]) })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      if (err && err.code === '23503') {
        return reply.code(404).send({ success: false, error: 'premises_not_found' })
      }
      return fail(request, reply, err, 'issue food handler cert')
    } finally { client.release() }
  })

  fastify.post('/eho/food-handlers/:id/revoke', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const reason = orNull((request.body || {}).reason, 2000)
    if (!reason) return reply.code(400).send({ success: false, error: 'reason_required' })
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.health_food_handler_cert
            SET revoked_at = NOW(), revoked_by = $2, revoked_reason = $3
          WHERE id = $1 AND revoked_at IS NULL
          RETURNING id`,
        [id, request.user.id, reason],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found_or_already_revoked' })
      const { rows: full } = await pg.query(`${SELECT_HANDLER} WHERE h.id = $1`, [id])
      return reply.send({ success: true, data: handlerDto(full[0]) })
    } catch (err) { return fail(request, reply, err, 'revoke food handler cert') }
  })

  // ══ BURIAL PERMITS ════════════════════════════════════════════════════
  const SELECT_BURIAL = `SELECT b.* FROM spatial_planning.health_burial_permit b`

  fastify.get('/eho/burial-permits', { preHandler: requireRole(fastify, READ_ROLES) }, async (request, reply) => {
    const q = request.query || {}
    const search = isStr(q.search, 120) ? q.search.trim() : null
    const kind = PERMIT_KINDS.includes(q.kind) ? q.kind : null
    const limit = Math.min(Number(q.limit) || 100, 500)
    const offset = Math.max(Number(q.offset) || 0, 0)
    try {
      const { rows } = await pg.query(
        `${SELECT_BURIAL}
          WHERE ($1::text IS NULL OR (
                  b.deceased_name ILIKE '%' || $1 || '%'
               OR b.reference ILIKE '%' || $1 || '%'
               OR b.cemetery ILIKE '%' || $1 || '%'))
            AND ($2::text IS NULL OR b.permit_kind = $2)
          ORDER BY b.issued_at DESC
          LIMIT $3 OFFSET $4`,
        [search, kind, limit, offset],
      )
      return reply.send({ success: true, data: rows.map(burialDto) })
    } catch (err) { return fail(request, reply, err, 'list burial permits') }
  })

  fastify.post('/eho/burial-permits', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.deceased_name, 160)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'deceased_name' })
    }
    if (!isStr(b.cemetery, 160)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'cemetery' })
    }
    if (!isStr(b.issued_by_name, 160)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'issued_by_name' })
    }
    const kind = PERMIT_KINDS.includes(b.permit_kind) ? b.permit_kind : 'burial'
    const death = isoDate(b.date_of_death)
    if (death === undefined || death === null) {
      return reply.code(400).send({ success: false, error: 'bad_date_of_death' })
    }
    // A future death is a typo, and a permit issued against one would carry
    // that typo to a cemetery. Caught here rather than by the CHECK so the
    // officer is told which date is wrong.
    if (Date.parse(death) > Date.now() + 86400000) {
      return reply.code(400).send({ success: false, error: 'death_in_future' })
    }
    const interment = isoDate(b.interment_at)
    if (interment === undefined) return reply.code(400).send({ success: false, error: 'bad_interment_at' })

    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const reference = await nextReference(client, 'health_burial_permit_seq', 'BP')
      const { rows } = await client.query(
        `INSERT INTO spatial_planning.health_burial_permit
           (reference, permit_kind, deceased_name, deceased_id_number, date_of_death,
            cause_of_death, cemetery, ward, interment_at,
            applicant_name, applicant_relation, applicant_contact,
            issued_by_name, issued_by, notes)
         VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9::timestamptz,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [
          reference, kind, b.deceased_name.trim(), orNull(b.deceased_id_number, 40), death,
          orNull(b.cause_of_death, 200), b.cemetery.trim(), orNull(b.ward, 120), interment,
          orNull(b.applicant_name, 160), orNull(b.applicant_relation, 60),
          orNull(b.applicant_contact, 40),
          b.issued_by_name.trim(), request.user.id, orNull(b.notes, 4000),
        ],
      )
      await client.query('COMMIT')
      return reply.code(201).send({ success: true, data: burialDto(rows[0]) })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      return fail(request, reply, err, 'issue burial permit')
    } finally { client.release() }
  })

  fastify.post('/eho/burial-permits/:id/cancel', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const reason = orNull((request.body || {}).reason, 2000)
    if (!reason) return reply.code(400).send({ success: false, error: 'reason_required' })
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.health_burial_permit
            SET cancelled_at = NOW(), cancelled_by = $2, cancelled_reason = $3
          WHERE id = $1 AND cancelled_at IS NULL
          RETURNING *`,
        [id, request.user.id, reason],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found_or_already_cancelled' })
      return reply.send({ success: true, data: burialDto(rows[0]) })
    } catch (err) { return fail(request, reply, err, 'cancel burial permit') }
  })

  // ══ LICENCE HEALTH CLEARANCE ══════════════════════════════════════════
  const SELECT_CLEARANCE = `
    SELECT c.*, p.name AS premises_name,
           i.reference AS inspection_reference, i.verdict AS inspection_verdict
      FROM spatial_planning.health_licence_clearance c
      LEFT JOIN spatial_planning.health_premises p ON p.id = c.premises_id
      LEFT JOIN spatial_planning.health_premises_inspection i ON i.id = c.inspection_id`

  fastify.get('/eho/clearances', { preHandler: requireRole(fastify, READ_ROLES) }, async (request, reply) => {
    const q = request.query || {}
    const status = CLEARANCE_STATUSES.includes(q.status) ? q.status : null
    const type = LICENCE_TYPES.includes(q.licence_type) ? q.licence_type : null
    const search = isStr(q.search, 120) ? q.search.trim() : null
    const openOnly = q.open === 'true' || q.open === true
    const limit = Math.min(Number(q.limit) || 200, 500)
    try {
      const { rows } = await pg.query(
        `${SELECT_CLEARANCE}
          WHERE ($1::text IS NULL OR c.status = $1)
            AND ($2::text IS NULL OR c.licence_type = $2)
            AND ($3::text IS NULL OR (
                  c.applicant_name ILIKE '%' || $3 || '%'
               OR c.trading_name ILIKE '%' || $3 || '%'
               OR c.reference ILIKE '%' || $3 || '%'
               OR c.stand_number ILIKE '%' || $3 || '%'))
            AND ($4::boolean IS FALSE OR c.status = 'pending')
          ORDER BY c.received_at DESC
          LIMIT $5`,
        [status, type, search, openOnly, limit],
      )
      return reply.send({ success: true, data: rows.map(clearanceDto) })
    } catch (err) { return fail(request, reply, err, 'list clearances') }
  })

  fastify.post('/eho/clearances', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const b = request.body || {}
    if (!LICENCE_TYPES.includes(b.licence_type)) {
      return reply.code(400).send({ success: false, error: 'bad_licence_type' })
    }
    if (!isStr(b.applicant_name, 160)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'applicant_name' })
    }
    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const reference = await nextReference(client, 'health_licence_clearance_seq', 'LC')
      const { rows } = await client.query(
        `INSERT INTO spatial_planning.health_licence_clearance
           (reference, licence_type, applicant_name, applicant_contact, trading_name,
            premises_id, stand_number, suburb_ward, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          reference, b.licence_type, b.applicant_name.trim(), orNull(b.applicant_contact, 40),
          orNull(b.trading_name, 200), isUuid(b.premises_id) ? b.premises_id : null,
          orNull(b.stand_number, 40), orNull(b.suburb_ward, 120),
          orNull(b.notes, 4000), request.user.id,
        ],
      )
      await client.query('COMMIT')
      const { rows: full } = await pg.query(`${SELECT_CLEARANCE} WHERE c.id = $1`, [rows[0].id])
      return reply.code(201).send({ success: true, data: clearanceDto(full[0]) })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      return fail(request, reply, err, 'create clearance')
    } finally { client.release() }
  })

  fastify.patch('/eho/clearances/:id', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    const status = b.status === undefined ? null : b.status
    if (status !== null && !CLEARANCE_STATUSES.includes(status)) {
      return reply.code(400).send({ success: false, error: 'bad_status' })
    }
    const conditions = orNull(b.conditions, 8000)
    const refusal = orNull(b.refusal_reason, 8000)
    // The three rules the CHECK constraints hold, restated where the officer
    // can be told which field is missing rather than shown a 500.
    if (status === 'refused' && !refusal) {
      return reply.code(400).send({ success: false, error: 'refusal_reason_required' })
    }
    if (status === 'conditional' && !conditions) {
      return reply.code(400).send({ success: false, error: 'conditions_required' })
    }
    const validUntil = isoDate(b.valid_until)
    if (validUntil === undefined) return reply.code(400).send({ success: false, error: 'bad_valid_until' })
    if (b.inspection_id !== undefined && b.inspection_id !== null && !isUuid(b.inspection_id)) {
      return reply.code(400).send({ success: false, error: 'bad_inspection_id' })
    }
    // A decision is dated and attributed at the moment it is taken; moving
    // back to pending clears both, so the row never claims a decision it no
    // longer holds.
    const decides = status !== null && status !== 'pending'

    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.health_licence_clearance SET
           status          = COALESCE($2, status),
           conditions      = COALESCE($3, conditions),
           refusal_reason  = COALESCE($4, refusal_reason),
           valid_until     = COALESCE($5::date, valid_until),
           inspection_id   = COALESCE($6::uuid, inspection_id),
           notes           = COALESCE($7, notes),
           decided_at      = CASE WHEN $8::boolean THEN NOW()
                                  WHEN $2 = 'pending' THEN NULL
                                  ELSE decided_at END,
           decided_by      = CASE WHEN $8::boolean THEN $9::uuid
                                  WHEN $2 = 'pending' THEN NULL
                                  ELSE decided_by END,
           decided_by_name = CASE WHEN $8::boolean THEN COALESCE($10, decided_by_name)
                                  WHEN $2 = 'pending' THEN NULL
                                  ELSE decided_by_name END,
           updated_at      = NOW()
         WHERE id = $1
         RETURNING id`,
        [
          id, status, conditions, refusal, validUntil,
          b.inspection_id ?? null, orNull(b.notes, 4000),
          decides, request.user.id, orNull(b.decided_by_name, 160),
        ],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      const { rows: full } = await pg.query(`${SELECT_CLEARANCE} WHERE c.id = $1`, [id])
      return reply.send({ success: true, data: clearanceDto(full[0]) })
    } catch (err) { return fail(request, reply, err, 'update clearance') }
  })

  // ══ FIELD PROGRAMMES ══════════════════════════════════════════════════
  const SELECT_PROGRAMME = `
    SELECT g.*, ${XY('g')} FROM spatial_planning.health_field_programme g`

  fastify.get('/eho/programmes', { preHandler: requireRole(fastify, READ_ROLES) }, async (request, reply) => {
    const q = request.query || {}
    const type = PROGRAMME_TYPES.includes(q.programme_type) ? q.programme_type : null
    const status = PROGRAMME_STATUSES.includes(q.status) ? q.status : null
    const ward = isStr(q.ward, 120) ? q.ward.trim() : null
    const from = isoDate(q.from)
    const to = isoDate(q.to)
    if (from === undefined || to === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_date_range' })
    }
    const limit = Math.min(Number(q.limit) || 200, 500)
    try {
      const { rows } = await pg.query(
        `${SELECT_PROGRAMME}
          WHERE ($1::text IS NULL OR g.programme_type = $1)
            AND ($2::text IS NULL OR g.status = $2)
            AND ($3::text IS NULL OR g.ward = $3)
            AND ($4::date IS NULL OR g.scheduled_for >= $4::date)
            AND ($5::date IS NULL OR g.scheduled_for <= $5::date)
          ORDER BY g.scheduled_for DESC
          LIMIT $6`,
        [type, status, ward, from, to, limit],
      )
      return reply.send({ success: true, data: rows.map(programmeDto) })
    } catch (err) { return fail(request, reply, err, 'list programmes') }
  })

  fastify.post('/eho/programmes', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const b = request.body || {}
    if (!PROGRAMME_TYPES.includes(b.programme_type)) {
      return reply.code(400).send({ success: false, error: 'bad_programme_type' })
    }
    if (!isStr(b.title, 200)) return reply.code(400).send({ success: false, error: 'missing_field', field: 'title' })
    if (!isStr(b.ward, 120)) return reply.code(400).send({ success: false, error: 'missing_field', field: 'ward' })
    const scheduled = isoDate(b.scheduled_for)
    if (scheduled === undefined || scheduled === null) {
      return reply.code(400).send({ success: false, error: 'bad_scheduled_for' })
    }
    const target = int(b.target_quantity, 0, 10000000)
    if (target === undefined) return reply.code(400).send({ success: false, error: 'bad_target_quantity' })
    const teamSize = int(b.team_size, 0, 500)
    if (teamSize === undefined) return reply.code(400).send({ success: false, error: 'bad_team_size' })
    const unit = orNull(b.quantity_unit, 40)
    if (target != null && !unit) {
      return reply.code(400).send({ success: false, error: 'quantity_unit_required' })
    }
    const p = readPosition(b, PROGRAMME_POSITION_SOURCES)
    if (p.error) return reply.code(400).send({ success: false, error: p.error })

    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const reference = await nextReference(client, 'health_field_programme_seq', 'FP')
      const { rows } = await client.query(
        `INSERT INTO spatial_planning.health_field_programme
           (reference, programme_type, title, ward, village_or_area, scheduled_for,
            target_quantity, quantity_unit, team_lead, team_size, notes,
            location, location_source, location_accuracy_m, created_by)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,
                 ${pointSql('$12', '$13')},$14,$15,$16)
         RETURNING *, ${XY('health_field_programme')}`,
        [
          reference, b.programme_type, b.title.trim(), b.ward.trim(),
          orNull(b.village_or_area, 200), scheduled,
          target, unit, orNull(b.team_lead, 160), teamSize, orNull(b.notes, 4000),
          p.pos ? p.pos.lng : null, p.pos ? p.pos.lat : null,
          p.source, p.accuracy, request.user.id,
        ],
      )
      await client.query('COMMIT')
      return reply.code(201).send({ success: true, data: programmeDto(rows[0]) })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      return fail(request, reply, err, 'create programme')
    } finally { client.release() }
  })

  fastify.patch('/eho/programmes/:id', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    const status = b.status === undefined ? null : b.status
    if (status !== null && !PROGRAMME_STATUSES.includes(status)) {
      return reply.code(400).send({ success: false, error: 'bad_status' })
    }
    const cancelled = orNull(b.cancelled_reason, 2000)
    if (status === 'cancelled' && !cancelled) {
      return reply.code(400).send({ success: false, error: 'cancelled_reason_required' })
    }
    const achieved = int(b.achieved_quantity, 0, 10000000)
    if (achieved === undefined) return reply.code(400).send({ success: false, error: 'bad_achieved_quantity' })
    const unit = orNull(b.quantity_unit, 40)
    const executed = isoDate(b.executed_at)
    if (executed === undefined) return reply.code(400).send({ success: false, error: 'bad_executed_at' })
    // Completing a round is what stamps it done. Requiring the caller to send
    // executed_at alongside status='completed' would make the CHECK reachable
    // from the UI, so the server supplies it.
    const completing = status === 'completed'

    try {
      const { rows } = await pg.query(
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
         WHERE id = $1
         RETURNING *, ${XY('health_field_programme')}`,
        [
          id, status, achieved, unit, orNull(b.team_lead, 160),
          orNull(b.notes, 4000), cancelled, completing, executed,
        ],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: programmeDto(rows[0]) })
    } catch (err) { return fail(request, reply, err, 'update programme') }
  })

  // ══ CONSOLE SUMMARY ═══════════════════════════════════════════════════
  /**
   * Every counter the dashboard shows, in one query.
   *
   * `overdue_days` is the inspection interval the council works to. The Public
   * Health Act sets no single figure, so the caller states one and the server
   * does not invent a standard.
   */
  fastify.get('/eho/summary', { preHandler: requireRole(fastify, READ_ROLES) }, async (request, reply) => {
    const overdueDays = int((request.query || {}).overdue_days, 1, 3650) ?? 90
    try {
      const { rows } = await pg.query(
        `SELECT
           (SELECT COUNT(*) FROM spatial_planning.health_premises
             WHERE deleted_at IS NULL) AS premises,
           (SELECT COUNT(*) FROM spatial_planning.health_premises
             WHERE deleted_at IS NULL
               AND (last_inspected_at IS NULL
                    OR last_inspected_at < NOW() - ($1 || ' days')::interval)) AS premises_overdue,
           (SELECT COUNT(*) FROM spatial_planning.health_outbreak
             WHERE status <> 'closed') AS outbreaks_open,
           (SELECT COALESCE(SUM(cases_count), 0) FROM spatial_planning.health_outbreak
             WHERE status <> 'closed') AS outbreak_cases_open,
           (SELECT COUNT(*) FROM spatial_planning.health_water_sample
             WHERE result = 'not_potable'
               AND sampled_at > NOW() - INTERVAL '90 days') AS water_failing_90d,
           (SELECT COUNT(*) FROM spatial_planning.health_nuisance_complaint
             WHERE status IN ('open', 'investigating')) AS complaints_open,
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
             WHERE status IN ('planned', 'in_progress')
               AND scheduled_for <= CURRENT_DATE) AS programmes_due,
           (SELECT COUNT(*) FROM spatial_planning.health_abatement_notice
             WHERE status IN ('served', 'extended', 'non_complied')) AS notices_open,
           (SELECT COUNT(*) FROM spatial_planning.health_abatement_notice
             WHERE status IN ('served', 'extended')
               AND COALESCE(extended_to, (served_at AT TIME ZONE 'Africa/Harare')::date + compliance_days)
                   < CURRENT_DATE) AS notices_overdue`,
        [overdueDays],
      )
      const r = rows[0] || {}
      const n = (v) => Number(v ?? 0)
      return reply.send({
        success: true,
        data: {
          overdueDays,
          premises: n(r.premises),
          premisesOverdue: n(r.premises_overdue),
          outbreaksOpen: n(r.outbreaks_open),
          outbreakCasesOpen: n(r.outbreak_cases_open),
          waterFailing90d: n(r.water_failing_90d),
          complaintsOpen: n(r.complaints_open),
          followUpsDue: n(r.followups_due),
          handlerCertsExpiring30d: n(r.handler_certs_expiring_30d),
          handlerCertsExpired: n(r.handler_certs_expired),
          clearancesPending: n(r.clearances_pending),
          programmesDue: n(r.programmes_due),
          noticesOpen: n(r.notices_open),
          noticesOverdue: n(r.notices_overdue),
        },
      })
    } catch (err) { return fail(request, reply, err, 'summary') }
  })
}

module.exports = { environmentalHealthOpsRoutes }
