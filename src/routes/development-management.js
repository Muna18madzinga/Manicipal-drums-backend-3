/**
 * Development Management routes — DM Handbook 2021 v1.2
 *
 * All endpoints mount under /api (registered in server.js).
 * All tables live in the spatial_planning schema (migration 070).
 *
 * Phase 1 — Permit Applications
 *   POST   /permit-applications
 *   GET    /permit-applications
 *   GET    /permit-applications/:id
 *   PATCH  /permit-applications/:id/status
 *   POST   /permit-applications/:id/consultations
 *   GET    /permit-applications/:id/consultations
 *   PATCH  /consultations/:cid/response
 *   POST   /permit-applications/:id/objections
 *   GET    /permit-applications/:id/objections
 *   PATCH  /objections/:oid/consideration
 *
 * Phase 2 — Enforcement
 *   POST   /enforcement-orders
 *   GET    /enforcement-orders
 *   PATCH  /enforcement-orders/:id/status
 *   POST   /enforcement-orders/:id/compliance-checks
 *   POST   /prohibition-orders
 *   GET    /prohibition-orders
 *
 * Phase 3 — Building Plans
 *   POST   /permit-applications/:id/building-plans
 *   GET    /permit-applications/:id/building-plans
 *   PATCH  /building-plans/:bpid/appraisal
 *   POST   /building-plans/:bpid/annotations
 *
 * Phase 4 — Stage Inspections
 *   GET    /inspection-stages                          (owned by routes/inspections.js)
 *   GET    /inspection-checklist/:stageNumber          (public)
 *   POST   /permit-applications/:id/stage-inspections
 *   GET    /permit-applications/:id/stage-inspections
 *   GET    /stage-inspections/:sid
 *   POST   /stage-inspections/:sid/checklist
 *
 * Phase 5 — Certificate of Occupation
 *   POST   /permit-applications/:id/occupation-certificate
 *   GET    /permit-applications/:id/occupation-certificate
 */

const fs = require('fs').promises
const path = require('path')
const crypto = require('crypto')
const { requireAuth, requireRole } = require('../middleware/jwtAuth')
const notifier = require('../services/notifier')

const STAFF_ROLES = [
  'admin', 'planner', 'planning_clerk', 'building_inspector',
  'eo', 'env_officer', 'surveyor', 'gis_officer',
]

// Citizens (public / registered / viewer) can read their own rows and create
// new applications; only staff can change status or add internal records.
const PERMIT_READERS = [...STAFF_ROLES, 'public', 'viewer', 'registered']

// ════════════════════════════════════════════════════════════════════
// Photo storage (DM Handbook Phase 4 — Stage Inspection Photos)
// ════════════════════════════════════════════════════════════════════
const STAGE_PHOTO_ROOT = process.env.STAGE_PHOTO_ROOT
  ? path.resolve(process.env.STAGE_PHOTO_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'stage-photos')

const MAX_STAGE_PHOTO_BYTES = 10 * 1024 * 1024  // 10 MB
const ALLOWED_STAGE_PHOTO_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic',
])
const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/heic': '.heic',
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)
}
function isStr(v, max = 4096) {
  return typeof v === 'string' && v.length > 0 && v.length <= max
}
function isDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

// Render the EO determination as a council letter (HTML). The body is stored in
// generated_document.content and served via GET /generated-documents/:id —
// the council's authoritative copy of the decision communicated to the citizen.
// decision ∈ approve | approve_with_conditions | refuse.
function renderDecisionLetter({ decision, permit, conditions, notes, officerName }) {
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  const ref = permit.dev_register_no || permit.tpd_reference || String(permit.id).slice(0, 8).toUpperCase()
  const title = {
    approve: 'Development Permit — Approval',
    approve_with_conditions: 'Development Permit — Conditional Approval',
    refuse: 'Development Permit — Refusal',
  }[decision] || 'Development Permit — Decision'
  const verb = {
    approve: 'is hereby <strong>APPROVED</strong>',
    approve_with_conditions: 'is hereby <strong>APPROVED SUBJECT TO THE CONDITIONS</strong> set out below',
    refuse: 'is hereby <strong>REFUSED</strong>',
  }[decision] || 'has been determined'
  const condList = (Array.isArray(conditions) ? conditions : [])
    .map(c => (typeof c === 'string' ? c : (c && c.text) || ''))
    .filter(Boolean)
  const condHtml = (decision === 'approve_with_conditions' && condList.length)
    ? `<h3>Conditions of approval</h3><ol>${condList.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ol>`
    : ''
  const reasonsHtml = notes
    ? `<h3>${decision === 'refuse' ? 'Reasons for refusal' : 'Notes'}</h3><p>${escapeHtml(notes).replace(/\n/g, '<br>')}</p>`
    : ''
  const body = `
    <p>Dear ${escapeHtml(permit.applicant_name || 'Applicant')},</p>
    <p>RE: ${escapeHtml(permit.description || permit.development_type || 'Development application')}
       — Stand ${escapeHtml(permit.stand_number || '—')}${permit.suburb_ward ? ', ' + escapeHtml(permit.suburb_ward) : ''}</p>
    <p>In terms of section 26 of the Regional, Town and Country Planning Act
       [Chapter 29:12], I write to inform you that the above development application
       ${verb}.</p>
    ${condHtml}
    ${reasonsHtml}
    <p>Should you be aggrieved by this decision, you may appeal to the Administrative
       Court within the period prescribed by the Act.</p>
    <p>Yours faithfully,</p>
    <p><strong>${escapeHtml(officerName || 'Executive Officer (Planning)')}</strong><br>
       Executive Officer — Planning<br>Vungu Rural District Council</p>`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>body{font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;max-width:720px;margin:2rem auto;padding:0 1.5rem;line-height:1.6}
.lh{text-align:center;border-bottom:2px solid #1a1a1a;padding-bottom:0.5rem;margin-bottom:1.5rem}
.lh h1{font-size:1.1rem;margin:0;letter-spacing:0.05em}.lh p{margin:0.2rem 0;font-size:0.8rem}
.meta{display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:1.5rem}
h2{font-size:1rem;text-align:center;text-transform:uppercase;letter-spacing:0.05em}
h3{font-size:0.9rem;margin-top:1.3rem}ol{padding-left:1.4rem}@media print{body{margin:0}}</style></head>
<body><div class="lh"><h1>VUNGU RURAL DISTRICT COUNCIL</h1>
<p>Department of Physical Planning &amp; Development Control</p></div>
<div class="meta"><span>Ref: ${escapeHtml(ref)}</span><span>${escapeHtml(today)}</span></div>
<h2>${escapeHtml(title)}</h2>${body}</body></html>`
  return { title, html }
}

async function developmentManagementRoutes(fastify) {
  const pg = fastify.pg

  // Append-only audit log helper (migration 082). Best-effort: a failed
  // audit insert must never break the primary action, but it is logged.
  async function logEvent(permitId, eventType, request, detail = {}) {
    try {
      await pg.query(
        `INSERT INTO spatial_planning.permit_event
           (permit_app_id, event_type, actor_id, actor_role, detail)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [permitId, eventType, request.user?.id || null,
         request.user?.role || null, JSON.stringify(detail || {})],
      )
    } catch (err) {
      request.log.error({ err }, 'permit_event insert failed')
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 1 — PERMIT APPLICATIONS
  // ══════════════════════════════════════════════════════════════════

  fastify.post('/permit-applications', {
    preHandler: requireRole(fastify, ['planning_clerk', 'planner', 'admin', 'public', 'viewer', 'registered']),
  }, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.applicant_name, 255)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'applicant_name' })
    }
    const VALID_TYPES = ['new_building','alteration','extension','change_of_use',
                         'subdivision','consolidation','rezoning','other']
    if (!VALID_TYPES.includes(b.development_type)) {
      return reply.code(400).send({ success: false, error: 'bad_development_type' })
    }
    const initialStatus = (b.pay_intent && typeof b.pay_intent === 'object')
      ? 'pending_payment'
      : 'registered'
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.permit_application
           (dev_app_id, tpd_reference, dev_register_no, stand_number, suburb_ward,
            street_address, stand_area_sqm, applicant_name, applicant_id_number,
            applicant_phone, applicant_email, development_type, description,
            site_plan_url, received_at, created_by, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING *`,
        [
          b.dev_app_id || null,
          b.tpd_reference || null,
          b.dev_register_no || null,
          b.stand_number || null,
          b.suburb_ward || null,
          b.street_address || null,
          b.stand_area_sqm || null,
          b.applicant_name,
          b.applicant_id_number || null,
          b.applicant_phone || null,
          b.applicant_email || null,
          b.development_type,
          b.description || null,
          b.site_plan_url || null,
          isDate(b.received_at) ? b.received_at : new Date().toISOString().slice(0, 10),
          request.user.id,
          initialStatus,
        ],
      )
      let row = rows[0]
      // GIS integration: persist the application's map location (centroid)
      // when supplied, so every role's map can pin it. Stored as 4326 point.
      const lat = Number(b.latitude ?? b.lat)
      const lng = Number(b.longitude ?? b.lng)
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const upd = await pg.query(
          `UPDATE spatial_planning.permit_application
              SET location = ST_SetSRID(ST_MakePoint($2,$3),4326), updated_at = NOW()
            WHERE id = $1
            RETURNING *, ST_X(location) AS lng, ST_Y(location) AS lat`,
          [row.id, lng, lat])
        row = upd.rows[0] || row
      }

      // Acknowledge receipt by email. Fire-and-forget: composing the
      // (optionally AI-fine-tuned) message must never delay or fail the
      // submission response. The email worker picks the row up from the
      // outbox and delivers it.
      const recipientEmail = row.applicant_email || request.user.email || null
      if (recipientEmail) {
        notifier.enqueueApplicationReceived(pg, {
          userId:        request.user.id,
          email:         recipientEmail,
          name:          row.applicant_name || null,
          applicationId: row.id,
          reference:     row.dev_register_no || row.tpd_reference || null,
          devType:       row.development_type || null,
          standNumber:   row.stand_number || null,
          suburbWard:    row.suburb_ward || null,
        }).catch(err => request.log.error({ err }, 'application_received email enqueue failed'))
      }

      return reply.code(201).send({ success: true, data: row })
    } catch (err) {
      request.log.error({ err }, 'permit-application create failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/permit-applications', {
    preHandler: requireRole(fastify, PERMIT_READERS),
  }, async (request, reply) => {
    const { status, development_type, search, limit = 50, offset = 0 } = request.query
    const isStaff = STAFF_ROLES.includes(request.user.role)
    const ownerFilter = isStaff ? null : request.user.id
    const includePending = isStaff && request.query.includePendingPayment === 'true'
    try {
      const { rows } = await pg.query(
        `SELECT * FROM spatial_planning.v_application_summary
         WHERE ($1::text IS NULL OR status = $1)
           AND ($2::text IS NULL OR development_type = $2)
           AND ($3::text IS NULL OR (
                 applicant_name ILIKE '%' || $3 || '%'
                 OR tpd_reference ILIKE '%' || $3 || '%'
                 OR stand_number  ILIKE '%' || $3 || '%'
               ))
           AND ($6::uuid IS NULL OR created_by = $6)
           AND ($7::boolean = true
                OR created_by = COALESCE($6, '00000000-0000-0000-0000-000000000000'::uuid)
                OR status <> 'pending_payment')
         ORDER BY received_at DESC
         LIMIT $4 OFFSET $5`,
        [status || null, development_type || null, search || null,
         Math.min(Number(limit) || 50, 200), Number(offset) || 0,
         ownerFilter, includePending],
      )
      return reply.send({ success: true, data: rows })
    } catch (err) {
      request.log.error({ err }, 'list permit-applications failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/permit-applications/:id', {
    preHandler: requireRole(fastify, PERMIT_READERS),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) {
      return reply.code(400).send({ success: false, error: 'bad_id' })
    }
    try {
      const { rows } = await pg.query(
        `SELECT *, ST_X(location) AS lng, ST_Y(location) AS lat
           FROM spatial_planning.permit_application WHERE id = $1`,
        [request.params.id],
      )
      if (!rows[0]) {
        return reply.code(404).send({ success: false, error: 'not_found' })
      }
      const isStaff = STAFF_ROLES.includes(request.user.role)
      if (!isStaff && rows[0].created_by !== request.user.id) {
        // 404 not 403 so we don't leak the existence of someone else's row.
        return reply.code(404).send({ success: false, error: 'not_found' })
      }
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'get permit-application failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Planner case file (migration 082) ────────────────────────────
  // Persist the planner's working record ON the permit so it is the shared
  // system-of-record, not browser localStorage: proposal detail, due-diligence
  // results, zoning snapshot, committee report, recommendation, structured
  // conditions, statutory due date and the assigned planner.
  fastify.patch('/permit-applications/:id/case', {
    preHandler: requireRole(fastify, ['planner', 'planning_clerk', 'eo', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}

    // Scalar columns (allow-listed).
    const scalar = {
      estimated_cost:         typeof b.estimated_cost === 'number' ? b.estimated_cost : undefined,
      plinth_area:            typeof b.plinth_area === 'number' ? b.plinth_area : undefined,
      floors:                 Number.isInteger(b.floors) ? b.floors : undefined,
      parking_bays:           Number.isInteger(b.parking_bays) ? b.parking_bays : undefined,
      title_deed_no:          isStr(b.title_deed_no, 60) ? b.title_deed_no : undefined,
      classification:         isStr(b.classification, 40) ? b.classification : undefined,
      recommendation:         isStr(b.recommendation, 40) ? b.recommendation : undefined,
      recommendation_reasons: typeof b.recommendation_reasons === 'string' ? b.recommendation_reasons : undefined,
      statutory_due_date:     isDate(b.statutory_due_date) ? b.statutory_due_date : undefined,
      assigned_to:            isUuid(b.assigned_to) ? b.assigned_to : undefined,
    }
    // JSONB columns.
    const json = {
      due_diligence:     b.due_diligence,
      committee_report:  b.committee_report,
      zoning_assessment: b.zoning_assessment,
      permit_conditions: b.permit_conditions,
    }

    const sets = []
    const vals = [request.params.id]
    for (const [k, v] of Object.entries(scalar)) {
      if (v !== undefined) { vals.push(v); sets.push(`${k} = $${vals.length}`) }
    }
    for (const [k, v] of Object.entries(json)) {
      if (v !== undefined) { vals.push(JSON.stringify(v)); sets.push(`${k} = $${vals.length}::jsonb`) }
    }
    // GIS integration: map location (centroid) as a 4326 point.
    const lat = Number(b.lat ?? b.latitude)
    const lng = Number(b.lng ?? b.longitude)
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      vals.push(lng); const lngIdx = vals.length
      vals.push(lat); const latIdx = vals.length
      sets.push(`location = ST_SetSRID(ST_MakePoint($${lngIdx},$${latIdx}),4326)`)
    }
    if (!sets.length) return reply.code(400).send({ success: false, error: 'no_fields' })

    // Optimistic lock: caller must state the revision it last read. A missing
    // or mismatched expectedRevision means someone else saved in between —
    // reject with 409 + the current row rather than silently overwriting.
    const expectedRevision = Number(b.expectedRevision)
    if (!Number.isInteger(expectedRevision)) {
      return reply.code(400).send({ success: false, error: 'expected_revision_required' })
    }

    try {
      const before = await pg.query(
        'SELECT assigned_to, revision FROM spatial_planning.permit_application WHERE id = $1',
        [request.params.id],
      )
      if (!before.rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      if (before.rows[0].revision !== expectedRevision) {
        const current = await pg.query(
          'SELECT *, ST_X(location) AS lng, ST_Y(location) AS lat FROM spatial_planning.permit_application WHERE id = $1',
          [request.params.id],
        )
        return reply.code(409).send({
          success: false, error: 'conflict',
          message: 'This case was changed by another officer since you loaded it.',
          data: current.rows[0],
        })
      }

      const revisionIdx = vals.length + 1
      vals.push(expectedRevision)
      const { rows } = await pg.query(
        `UPDATE spatial_planning.permit_application
            SET ${sets.join(', ')}, revision = revision + 1, updated_at = NOW()
          WHERE id = $1 AND revision = $${revisionIdx}
          RETURNING *, ST_X(location) AS lng, ST_Y(location) AS lat`,
        vals,
      )
      if (!rows[0]) {
        // Lost the race between the check above and this write.
        const current = await pg.query(
          'SELECT *, ST_X(location) AS lng, ST_Y(location) AS lat FROM spatial_planning.permit_application WHERE id = $1',
          [request.params.id],
        )
        return reply.code(409).send({
          success: false, error: 'conflict',
          message: 'This case was changed by another officer since you loaded it.',
          data: current.rows[0],
        })
      }

      await logEvent(request.params.id, 'case_updated', request, {
        fields: sets.map(s => s.split(' ')[0]),
      })
      if (scalar.assigned_to !== undefined && scalar.assigned_to !== before.rows[0].assigned_to) {
        await logEvent(request.params.id, 'reassigned', request, {
          from: before.rows[0].assigned_to, to: scalar.assigned_to,
        })
      }
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'patch permit case failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Audit log (migration 082) ────────────────────────────────────
  // Who did what, when, why. Owner-scoped exactly like the permit reads.
  fastify.get('/permit-applications/:id/events', {
    preHandler: requireRole(fastify, PERMIT_READERS),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const ownRow = await pg.query(
      'SELECT created_by FROM spatial_planning.permit_application WHERE id = $1',
      [request.params.id])
    if (!ownRow.rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    const isStaff = STAFF_ROLES.includes(request.user.role)
    if (!isStaff && ownRow.rows[0].created_by !== request.user.id) {
      return reply.code(404).send({ success: false, error: 'not_found' })
    }
    const { rows } = await pg.query(
      `SELECT e.id, e.event_type, e.actor_id, e.actor_role, e.detail, e.created_at,
              COALESCE(u.full_name, u.name) AS actor_name
         FROM spatial_planning.permit_event e
         LEFT JOIN public.users u ON u.id = e.actor_id
        WHERE e.permit_app_id = $1
        ORDER BY e.created_at DESC`,
      [request.params.id],
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.patch('/permit-applications/:id/status', {
    // EO Planner determines applications (approve / refuse / defer) per RTCP Act s.26,
    // so 'eo' joins the planning officers allowed to transition status.
    preHandler: requireRole(fastify, ['eo', 'planner', 'planning_clerk', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) {
      return reply.code(400).send({ success: false, error: 'bad_id' })
    }
    const { status, decision_conditions, decision_at, permit_conditions } = request.body || {}
    const VALID_STATUSES = ['registered','acknowledged','circulation','objection_period',
      'under_review','awaiting_eo_decision','deferred','approved','approved_with_conditions',
      'refused','withdrawn','appealed']
    if (!VALID_STATUSES.includes(status)) {
      return reply.code(400).send({ success: false, error: 'bad_status' })
    }
    const expectedRevision = Number(request.body?.expectedRevision)
    if (!Number.isInteger(expectedRevision)) {
      return reply.code(400).send({ success: false, error: 'expected_revision_required' })
    }
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.permit_application
            SET status              = $2,
                decision_conditions = COALESCE($3, decision_conditions),
                decision_at         = COALESCE($4::date, decision_at),
                decision_officer    = CASE WHEN $2::varchar IN ('approved','approved_with_conditions','refused')
                                          THEN $5 ELSE decision_officer END,
                permit_conditions   = COALESCE($6::jsonb, permit_conditions),
                revision            = revision + 1,
                updated_at          = NOW()
          WHERE id = $1 AND revision = $7
          RETURNING *`,
        [request.params.id, status, decision_conditions || null,
         isDate(decision_at) ? decision_at : null, request.user.id,
         permit_conditions !== undefined && permit_conditions !== null
           ? JSON.stringify(permit_conditions) : null,
         expectedRevision],
      )
      if (!rows[0]) {
        const current = await pg.query(
          'SELECT * FROM spatial_planning.permit_application WHERE id = $1', [request.params.id])
        if (!current.rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
        return reply.code(409).send({
          success: false, error: 'conflict',
          message: 'This case was changed by another officer since you loaded it.',
          data: current.rows[0],
        })
      }
      await logEvent(request.params.id, 'status_changed', request, {
        status,
        has_conditions: !!permit_conditions,
        decision_conditions: decision_conditions || null,
      })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'patch permit status failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Consultations ────────────────────────────────────────────────

  fastify.post('/permit-applications/:id/consultations', {
    // EO Planner circulates applications to technical departments, so 'eo' may
    // create consultations alongside the planning officers.
    preHandler: requireRole(fastify, ['eo', 'planner', 'planning_clerk', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    // Accept `department` as an alias for `body_name`: the planner UI sends
    // `department`, the statutory column is `body_name`. (Fixes a 400 that
    // previously broke referral creation from the planner console.)
    const bodyName = isStr(b.body_name, 120) ? b.body_name
                   : (isStr(b.department, 120) ? b.department : null)
    if (!bodyName) {
      return reply.code(400).send({ success: false, error: 'body_name required' })
    }
    try {
      const PRI = ['low', 'normal', 'high', 'urgent']
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.application_consultation
           (permit_app_id, body_name, body_type, contact_name, contact_email,
            circulated_at, response_due_at, assigned_to, response_notes,
            priority, task_type, blocking, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [request.params.id, bodyName, b.body_type || null,
         b.contact_name || null, b.contact_email || null,
         isDate(b.circulated_at) ? b.circulated_at : new Date().toISOString().slice(0, 10),
         isDate(b.response_due_at) ? b.response_due_at : null,
         isUuid(b.assigned_to) ? b.assigned_to : null,
         isStr(b.response_notes, 4096) ? b.response_notes : null,
         PRI.includes(b.priority) ? b.priority : 'normal',
         isStr(b.task_type, 40) ? b.task_type : null,
         b.blocking === true,
         request.user.id],
      )
      await logEvent(request.params.id, 'referral_created', request, {
        body_name: bodyName,
        assigned_to: isUuid(b.assigned_to) ? b.assigned_to : null,
      })
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      if (err.code === '23503') return reply.code(404).send({ success: false, error: 'application_not_found' })
      request.log.error({ err }, 'create consultation failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/permit-applications/:id/consultations', {
    preHandler: requireRole(fastify, PERMIT_READERS),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const ownRow = await pg.query(
      'SELECT created_by FROM spatial_planning.permit_application WHERE id = $1',
      [request.params.id])
    if (!ownRow.rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    const isStaff = STAFF_ROLES.includes(request.user.role)
    if (!isStaff && ownRow.rows[0].created_by !== request.user.id) {
      return reply.code(404).send({ success: false, error: 'not_found' })
    }
    const { rows } = await pg.query(
      `SELECT * FROM spatial_planning.application_consultation
       WHERE permit_app_id = $1 ORDER BY created_at ASC`,
      [request.params.id],
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.patch('/consultations/:cid/response', {
    // The tasked specialist records their finding here so it returns to the
    // planner console (closing the referral loop). All technical reviewers may
    // respond — not just the planner — otherwise the loop can never close.
    preHandler: requireRole(fastify, ['planner', 'admin', 'eo', 'planning_clerk',
      'gis_officer', 'surveyor', 'env_officer', 'building_inspector']),
  }, async (request, reply) => {
    if (!isUuid(request.params.cid)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    const VALID = ['pending','no_objection','objection','conditional_approval','no_response']
    if (!VALID.includes(b.response_status)) {
      return reply.code(400).send({ success: false, error: 'bad_response_status' })
    }
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.application_consultation
            SET response_status       = $2,
                response_received_at  = COALESCE($3::date, response_received_at),
                response_notes        = COALESCE($4, response_notes),
                response_document_url = COALESCE($5, response_document_url),
                task_status           = CASE WHEN $2::varchar IN ('no_objection','objection','conditional_approval')
                                             THEN 'responded' ELSE task_status END,
                updated_at            = NOW()
          WHERE id = $1
          RETURNING *`,
        [request.params.cid, b.response_status,
         isDate(b.response_received_at) ? b.response_received_at : null,
         b.response_notes || null, b.response_document_url || null],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      await logEvent(rows[0].permit_app_id, 'referral_response', request, {
        consultation_id: rows[0].id,
        body_name: rows[0].body_name,
        response_status: b.response_status,
      })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'patch consultation response failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // Update a referral's task fields: priority, task_status, due date, blocking,
  // assignment, or escalate it (reminder/chase). The EO Planner manages these
  // from the Technical Circulation screen.
  fastify.patch('/consultations/:cid/task', {
    preHandler: requireRole(fastify, ['eo', 'planner', 'planning_clerk', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.cid)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    const PRI = ['low', 'normal', 'high', 'urgent']
    const TS = ['open', 'in_progress', 'responded', 'accepted', 'returned', 'cancelled']
    const sets = []
    const vals = [request.params.cid]
    if (PRI.includes(b.priority)) { vals.push(b.priority); sets.push(`priority = $${vals.length}`) }
    if (TS.includes(b.task_status)) { vals.push(b.task_status); sets.push(`task_status = $${vals.length}`) }
    if (typeof b.blocking === 'boolean') { vals.push(b.blocking); sets.push(`blocking = $${vals.length}`) }
    if (isDate(b.response_due_at)) { vals.push(b.response_due_at); sets.push(`response_due_at = $${vals.length}::date`) }
    if (isUuid(b.assigned_to)) { vals.push(b.assigned_to); sets.push(`assigned_to = $${vals.length}`) }
    if (b.escalate === true) { sets.push('escalated_at = NOW()') }
    if (!sets.length) return reply.code(400).send({ success: false, error: 'no_fields' })
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.application_consultation
            SET ${sets.join(', ')}, updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        vals,
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      await logEvent(rows[0].permit_app_id, 'referral_task_updated', request, {
        consultation_id: rows[0].id,
        escalated: b.escalate === true,
      })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'patch consultation task failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Objections ───────────────────────────────────────────────────

  fastify.post('/permit-applications/:id/objections', {
    preHandler: requireRole(fastify, ['planning_clerk', 'planner', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (!isStr(b.objector_name, 255)) {
      return reply.code(400).send({ success: false, error: 'objector_name required' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.application_objection
           (permit_app_id, objector_name, objector_address, objector_id_number,
            grounds, grounds_detail, received_at, document_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [request.params.id, b.objector_name, b.objector_address || null,
         b.objector_id_number || null,
         Array.isArray(b.grounds) ? JSON.stringify(b.grounds) : '[]',
         b.grounds_detail || null,
         isDate(b.received_at) ? b.received_at : new Date().toISOString().slice(0, 10),
         b.document_url || null],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      if (err.code === '23503') return reply.code(404).send({ success: false, error: 'application_not_found' })
      request.log.error({ err }, 'create objection failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/permit-applications/:id/objections', {
    preHandler: requireRole(fastify, PERMIT_READERS),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const ownRow = await pg.query(
      'SELECT created_by FROM spatial_planning.permit_application WHERE id = $1',
      [request.params.id])
    if (!ownRow.rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    const isStaff = STAFF_ROLES.includes(request.user.role)
    if (!isStaff && ownRow.rows[0].created_by !== request.user.id) {
      return reply.code(404).send({ success: false, error: 'not_found' })
    }
    const { rows } = await pg.query(
      `SELECT * FROM spatial_planning.application_objection
       WHERE permit_app_id = $1 ORDER BY received_at ASC`,
      [request.params.id],
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.patch('/objections/:oid/consideration', {
    // The EO Planner determines objections on the public-notification screen, so
    // 'eo' (and the clerk) join the planner here. Accepts response evidence.
    preHandler: requireRole(fastify, ['planner', 'admin', 'eo', 'planning_clerk']),
  }, async (request, reply) => {
    if (!isUuid(request.params.oid)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (typeof b.sustained !== 'boolean') {
      return reply.code(400).send({ success: false, error: 'sustained (boolean) required' })
    }
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.application_objection
            SET sustained               = $2,
                consideration_notes     = COALESCE($3, consideration_notes),
                resolution_document_url = COALESCE($4, resolution_document_url),
                considered_at           = CURRENT_DATE,
                considered_by           = $5
          WHERE id = $1
          RETURNING *`,
        [request.params.oid, b.sustained, b.consideration_notes || null,
         isStr(b.resolution_document_url, 1000) ? b.resolution_document_url : null,
         request.user.id],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      await logEvent(rows[0].permit_app_id, 'objection_considered', request, {
        objection_id: rows[0].id, sustained: b.sustained,
      })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'patch objection consideration failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ══════════════════════════════════════════════════════════════════
  // PUBLIC NOTIFICATION (RTCP Act s.26(3) — advert, abutting owners, notice)
  // ══════════════════════════════════════════════════════════════════
  fastify.get('/permit-applications/:id/public-notice', {
    preHandler: requireRole(fastify, PERMIT_READERS),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const ownRow = await pg.query(
      'SELECT created_by FROM spatial_planning.permit_application WHERE id = $1', [request.params.id])
    if (!ownRow.rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    const isStaff = STAFF_ROLES.includes(request.user.role)
    if (!isStaff && ownRow.rows[0].created_by !== request.user.id) {
      return reply.code(404).send({ success: false, error: 'not_found' })
    }
    const { rows } = await pg.query(
      'SELECT * FROM spatial_planning.public_notice WHERE permit_app_id = $1', [request.params.id])
    return reply.send({ success: true, data: rows[0] || null })
  })

  // Record / clear a notification verification step, or set the objection-period
  // window. One row per permit (upserted). step selects which field is written.
  fastify.post('/permit-applications/:id/public-notice/verify', {
    preHandler: requireRole(fastify, ['eo', 'planner', 'planning_clerk', 'admin']),
  }, async (request, reply) => {
    const id = request.params.id
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    const STEP = b.step
    const VALID_STEPS = ['advert', 'abutting_owners', 'site_notice',
      'objection_period_closed', 'set_period', 'notes']
    if (!VALID_STEPS.includes(STEP)) return reply.code(400).send({ success: false, error: 'bad_step' })
    const verified = b.verified !== false   // default true
    const uid = request.user.id
    try {
      const own = await pg.query('SELECT id FROM spatial_planning.permit_application WHERE id=$1', [id])
      if (!own.rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      await pg.query(
        `INSERT INTO spatial_planning.public_notice (permit_app_id)
         VALUES ($1) ON CONFLICT (permit_app_id) DO NOTHING`, [id])

      let sql, params
      switch (STEP) {
        case 'advert':
          sql = `UPDATE spatial_planning.public_notice
                    SET advert_verified=$2, advert_reference=COALESCE($3, advert_reference),
                        advert_verified_at=CASE WHEN $2 THEN NOW() ELSE NULL END,
                        advert_verified_by=CASE WHEN $2 THEN $4::uuid ELSE NULL END
                  WHERE permit_app_id=$1 RETURNING *`
          params = [id, verified, isStr(b.reference, 200) ? b.reference : null, uid]
          break
        case 'abutting_owners':
          sql = `UPDATE spatial_planning.public_notice
                    SET abutting_owners_verified=$2,
                        abutting_owners_verified_at=CASE WHEN $2 THEN NOW() ELSE NULL END,
                        abutting_owners_verified_by=CASE WHEN $2 THEN $3::uuid ELSE NULL END
                  WHERE permit_app_id=$1 RETURNING *`
          params = [id, verified, uid]
          break
        case 'site_notice':
          sql = `UPDATE spatial_planning.public_notice
                    SET site_notice_verified=$2,
                        site_notice_verified_at=CASE WHEN $2 THEN NOW() ELSE NULL END,
                        site_notice_verified_by=CASE WHEN $2 THEN $3::uuid ELSE NULL END
                  WHERE permit_app_id=$1 RETURNING *`
          params = [id, verified, uid]
          break
        case 'objection_period_closed':
          sql = `UPDATE spatial_planning.public_notice
                    SET objection_period_closed=$2,
                        objection_period_closed_at=CASE WHEN $2 THEN NOW() ELSE NULL END,
                        objection_period_closed_by=CASE WHEN $2 THEN $3::uuid ELSE NULL END
                  WHERE permit_app_id=$1 RETURNING *`
          params = [id, verified, uid]
          break
        case 'set_period':
          sql = `UPDATE spatial_planning.public_notice
                    SET objection_period_start=$2::date, objection_period_end=$3::date
                  WHERE permit_app_id=$1 RETURNING *`
          params = [id, isDate(b.objection_period_start) ? b.objection_period_start : null,
            isDate(b.objection_period_end) ? b.objection_period_end : null]
          break
        case 'notes':
          sql = `UPDATE spatial_planning.public_notice SET notes=$2 WHERE permit_app_id=$1 RETURNING *`
          params = [id, isStr(b.notes, 4096) ? b.notes : null]
          break
      }
      const { rows } = await pg.query(sql, params)
      await logEvent(id, 'public_notice_verified', request, { step: STEP, verified })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'public-notice verify failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ══════════════════════════════════════════════════════════════════
  // EO PLANNER — DECISION WORKSPACE (RTCP Act s.26 determination)
  // ══════════════════════════════════════════════════════════════════
  // The authoritative EO decision layer over the data model from migration 085
  // (eo_handoff_package, case_message, v_specialist_findings, generated_document)
  // and 086 (return fields, v_eo_decision_queue). The EO Planner sees one
  // assembled decision package, then Approves / Approves-with-conditions /
  // Refuses, OR returns the case to a role, OR requests citizen information.
  const EO_DECIDERS = ['eo', 'admin']

  // ── EO inbox: every permit awaiting a determination ──────────────
  fastify.get('/eo-planner/cases', {
    preHandler: requireRole(fastify, ['eo', 'planner', 'planning_clerk', 'admin']),
  }, async (request, reply) => {
    try {
      const { rows } = await pg.query(
        `SELECT * FROM spatial_planning.v_eo_decision_queue
          ORDER BY days_to_deemed ASC NULLS LAST, received_at ASC
          LIMIT 200`,
      )
      return reply.send({ success: true, data: rows })
    } catch (err) {
      request.log.error({ err }, 'eo-planner cases failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Federated specialist findings for one permit ─────────────────
  fastify.get('/permit-applications/:id/specialist-findings', {
    preHandler: requireRole(fastify, STAFF_ROLES),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    try {
      const { rows } = await pg.query(
        `SELECT vf.*, COALESCE(u.full_name, u.name) AS specialist_name
           FROM spatial_planning.v_specialist_findings vf
           LEFT JOIN public.users u ON u.id = vf.specialist_id
          WHERE vf.permit_app_id = $1
          ORDER BY vf.received_at DESC NULLS LAST, vf.created_at DESC`,
        [request.params.id],
      )
      return reply.send({ success: true, data: rows })
    } catch (err) {
      request.log.error({ err }, 'specialist-findings query failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Assembled decision package (the EO's single review screen) ────
  fastify.get('/permit-applications/:id/decision-package', {
    preHandler: requireRole(fastify, STAFF_ROLES),
  }, async (request, reply) => {
    const id = request.params.id
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    try {
      const permitRes = await pg.query(
        `SELECT *, ST_X(location) AS lng, ST_Y(location) AS lat
           FROM spatial_planning.permit_application WHERE id = $1`,
        [id],
      )
      if (!permitRes.rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      const permit = permitRes.rows[0]

      // A failed sub-query (e.g. a view not yet migrated) must degrade to [] —
      // the decision package should still render with whatever is available.
      const safe = async (q, params) => {
        try { return (await pg.query(q, params)).rows }
        catch (err) { request.log.error({ err }, 'decision-package sub-query failed'); return [] }
      }

      const [findings, objections, consultations, buildingPlans, documents, handoffRows, eventsRecent] =
        await Promise.all([
          safe(`SELECT vf.*, COALESCE(u.full_name, u.name) AS specialist_name
                  FROM spatial_planning.v_specialist_findings vf
                  LEFT JOIN public.users u ON u.id = vf.specialist_id
                 WHERE vf.permit_app_id = $1
                 ORDER BY vf.received_at DESC NULLS LAST, vf.created_at DESC`, [id]),
          safe(`SELECT * FROM spatial_planning.application_objection
                 WHERE permit_app_id = $1 ORDER BY received_at ASC`, [id]),
          safe(`SELECT * FROM spatial_planning.application_consultation
                 WHERE permit_app_id = $1 ORDER BY created_at ASC`, [id]),
          safe(`SELECT * FROM spatial_planning.building_plan
                 WHERE permit_app_id = $1 ORDER BY revision ASC`, [id]),
          safe(`SELECT id, doc_type, title, storage_url, mime_type, version, created_at
                  FROM spatial_planning.generated_document
                 WHERE permit_app_id = $1 ORDER BY created_at DESC`, [id]),
          safe(`SELECT * FROM spatial_planning.eo_handoff_package
                 WHERE permit_app_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]),
          safe(`SELECT e.event_type, e.actor_role, e.detail, e.created_at,
                       COALESCE(u.full_name, u.name) AS actor_name
                  FROM spatial_planning.permit_event e
                  LEFT JOIN public.users u ON u.id = e.actor_id
                 WHERE e.permit_app_id = $1 ORDER BY e.created_at DESC LIMIT 12`, [id]),
        ])

      const objectionSummary = {
        total: objections.length,
        sustained: objections.filter(o => o.sustained === true).length,
        pending: objections.filter(o => o.sustained === null || o.sustained === undefined).length,
      }

      return reply.send({
        success: true,
        data: {
          permit,
          recommendation: {
            value: permit.recommendation || null,
            reasons: permit.recommendation_reasons || null,
          },
          due_diligence: permit.due_diligence || null,
          committee_report: permit.committee_report || null,
          zoning_assessment: permit.zoning_assessment || null,
          proposed_conditions: permit.permit_conditions || [],
          findings,
          objections,
          objection_summary: objectionSummary,
          consultations,
          building_plans: buildingPlans,
          documents,
          handoff: handoffRows[0] || null,
          events_recent: eventsRecent,
        },
      })
    } catch (err) {
      request.log.error({ err }, 'decision-package failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Case conversation thread ─────────────────────────────────────
  fastify.get('/permit-applications/:id/messages', {
    preHandler: requireRole(fastify, PERMIT_READERS),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const ownRow = await pg.query(
      'SELECT created_by FROM spatial_planning.permit_application WHERE id = $1',
      [request.params.id])
    if (!ownRow.rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    const isStaff = STAFF_ROLES.includes(request.user.role)
    if (!isStaff && ownRow.rows[0].created_by !== request.user.id) {
      return reply.code(404).send({ success: false, error: 'not_found' })
    }
    // Citizens (non-staff) only see messages addressed to them or made public.
    const visClause = isStaff ? '' : "AND m.visibility IN ('citizen','public')"
    const { rows } = await pg.query(
      `SELECT m.*, COALESCE(u.full_name, u.name) AS author_name
         FROM spatial_planning.case_message m
         LEFT JOIN public.users u ON u.id = m.author_id
        WHERE m.permit_app_id = $1 ${visClause}
        ORDER BY m.created_at ASC`,
      [request.params.id],
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.post('/permit-applications/:id/messages', {
    preHandler: requireRole(fastify, STAFF_ROLES),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (!isStr(b.body, 8000)) return reply.code(400).send({ success: false, error: 'body required' })
    const MSG_TYPES = ['internal_note', 'citizen_message', 'specialist_comment', 'decision_comment', 'document_request']
    const VIS = ['internal', 'specialist', 'citizen', 'public']
    const messageType = MSG_TYPES.includes(b.message_type) ? b.message_type : 'internal_note'
    const visibility = VIS.includes(b.visibility) ? b.visibility : 'internal'
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.case_message
           (permit_app_id, author_id, author_role, message_type, visibility, body)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [request.params.id, request.user.id, request.user.role, messageType, visibility, b.body],
      )
      await logEvent(request.params.id, 'message_posted', request, { message_type: messageType, visibility })
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      if (err.code === '23503') return reply.code(404).send({ success: false, error: 'application_not_found' })
      request.log.error({ err }, 'post case message failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Final EO determination (approve / conditions / refuse) ───────
  fastify.post('/permit-applications/:id/eo-decision', {
    preHandler: requireRole(fastify, EO_DECIDERS),
  }, async (request, reply) => {
    const id = request.params.id
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    const DECISION_STATUS = {
      approve: 'approved',
      approve_with_conditions: 'approved_with_conditions',
      refuse: 'refused',
    }
    const status = DECISION_STATUS[b.decision]
    if (!status) return reply.code(400).send({ success: false, error: 'bad_decision' })
    const notes = isStr(b.notes, 8000) ? b.notes : null
    const conditions = (b.conditions !== undefined && b.conditions !== null)
      ? JSON.stringify(b.conditions) : null
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.permit_application
            SET status              = $2,
                decision_conditions = COALESCE($3, decision_conditions),
                decision_at         = CURRENT_DATE,
                decision_officer    = $4,
                permit_conditions   = COALESCE($5::jsonb, permit_conditions),
                updated_at          = NOW()
          WHERE id = $1
          RETURNING *`,
        [id, status, notes, request.user.id, conditions],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      // Close the latest open handoff package as decided (best-effort).
      try {
        await pg.query(
          `UPDATE spatial_planning.eo_handoff_package
              SET status='decided', eo_decision=$2, eo_notes=COALESCE($3, eo_notes),
                  decided_by=$4, decided_at=NOW(), updated_at=NOW()
            WHERE id = (SELECT id FROM spatial_planning.eo_handoff_package
                         WHERE permit_app_id=$1 AND status <> 'decided'
                         ORDER BY created_at DESC LIMIT 1)`,
          [id, status, notes, request.user.id],
        )
      } catch (err) { request.log.error({ err }, 'eo handoff decided update failed') }
      // Generate + persist the council decision letter (best-effort: a failure
      // here must not undo the determination, which is already committed).
      let generatedDoc = null
      try {
        const offRow = await pg.query(
          'SELECT COALESCE(full_name, name) AS n FROM public.users WHERE id=$1', [request.user.id])
        const { title, html } = renderDecisionLetter({
          decision: b.decision, permit: rows[0],
          conditions: b.conditions, notes, officerName: offRow.rows[0]?.n || null,
        })
        const docType = b.decision === 'refuse' ? 'refusal_letter' : 'outcome_letter'
        const bytes = Buffer.byteLength(html, 'utf8')
        const sha = crypto.createHash('sha256').update(html).digest('hex')
        const verRow = await pg.query(
          `SELECT COALESCE(MAX(version),0)+1 AS v FROM spatial_planning.generated_document
            WHERE permit_app_id=$1 AND doc_type=$2`, [id, docType])
        const ins = await pg.query(
          `INSERT INTO spatial_planning.generated_document
             (permit_app_id, doc_type, title, content, mime_type, bytes, sha256_hex, version, payload, generated_by)
           VALUES ($1,$2,$3,$4,'text/html',$5,$6,$7,$8::jsonb,$9)
           RETURNING id, doc_type, title, mime_type, version, created_at`,
          [id, docType, title, html, bytes, sha, verRow.rows[0].v,
           JSON.stringify({ decision: b.decision, status }), request.user.id])
        generatedDoc = ins.rows[0]
      } catch (err) { request.log.error({ err }, 'decision letter generation failed') }
      await logEvent(id, 'eo_decision', request, {
        decision: b.decision, status, has_conditions: !!conditions,
        document_id: generatedDoc ? generatedDoc.id : null,
      })
      return reply.send({ success: true, data: { permit: rows[0], document: generatedDoc } })
    } catch (err) {
      request.log.error({ err }, 'eo-decision failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Return the case to a specific role for more work ─────────────
  fastify.post('/permit-applications/:id/return-to-role', {
    preHandler: requireRole(fastify, EO_DECIDERS),
  }, async (request, reply) => {
    const id = request.params.id
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    const RETURN_ROLES = ['planner', 'gis_officer', 'surveyor', 'env_officer', 'building_inspector']
    if (!RETURN_ROLES.includes(b.role)) return reply.code(400).send({ success: false, error: 'bad_role' })
    const reason = isStr(b.reason, 8000) ? b.reason : null
    // The working status the case returns to (caller may override).
    const ROLE_STATUS = {
      planner: 'under_review', gis_officer: 'circulation', surveyor: 'circulation',
      env_officer: 'circulation', building_inspector: 'circulation',
    }
    const VALID_STATUSES = ['registered', 'acknowledged', 'circulation', 'objection_period',
      'under_review', 'awaiting_eo_decision', 'deferred', 'approved', 'approved_with_conditions',
      'refused', 'withdrawn', 'appealed']
    const status = VALID_STATUSES.includes(b.status) ? b.status : (ROLE_STATUS[b.role] || 'under_review')
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.permit_application
            SET status=$2, updated_at=NOW() WHERE id=$1 RETURNING *`,
        [id, status],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      // Mark the latest open handoff returned (best-effort).
      try {
        await pg.query(
          `UPDATE spatial_planning.eo_handoff_package
              SET status='returned', returned_to_role=$2,
                  return_reason=COALESCE($3, return_reason), updated_at=NOW()
            WHERE id = (SELECT id FROM spatial_planning.eo_handoff_package
                         WHERE permit_app_id=$1 AND status <> 'decided'
                         ORDER BY created_at DESC LIMIT 1)`,
          [id, b.role, reason],
        )
      } catch (err) { request.log.error({ err }, 'eo handoff return update failed') }
      // Record the return as a decision comment in the thread (best-effort).
      if (reason) {
        try {
          await pg.query(
            `INSERT INTO spatial_planning.case_message
               (permit_app_id, author_id, author_role, message_type, visibility, body)
             VALUES ($1,$2,$3,'decision_comment','specialist',$4)`,
            [id, request.user.id, request.user.role, `Returned to ${b.role}: ${reason}`],
          )
        } catch (err) { request.log.error({ err }, 'return case_message insert failed') }
      }
      await logEvent(id, 'returned_to_role', request, { role: b.role, reason, status })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'return-to-role failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Request information from the citizen / applicant ─────────────
  fastify.post('/permit-applications/:id/request-info', {
    preHandler: requireRole(fastify, ['eo', 'planner', 'planning_clerk', 'admin']),
  }, async (request, reply) => {
    const id = request.params.id
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (!isStr(b.message, 8000)) return reply.code(400).send({ success: false, error: 'message required' })
    try {
      const own = await pg.query('SELECT id FROM spatial_planning.permit_application WHERE id=$1', [id])
      if (!own.rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.case_message
           (permit_app_id, author_id, author_role, message_type, visibility, body)
         VALUES ($1,$2,$3,'citizen_message','citizen',$4)
         RETURNING *`,
        [id, request.user.id, request.user.role, b.message],
      )
      // Optionally open a formal document_request when a doc_kind is named.
      let docRequest = null
      if (isStr(b.doc_kind, 40)) {
        try {
          const dr = await pg.query(
            `INSERT INTO spatial_planning.document_request
               (permit_app_id, requested_by, doc_kind, reason, due_at)
             VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [id, request.user.id, b.doc_kind, b.message, isDate(b.due_at) ? b.due_at : null],
          )
          docRequest = dr.rows[0]
        } catch (err) { request.log.error({ err }, 'document_request insert failed') }
      }
      await logEvent(id, 'citizen_info_requested', request, { doc_kind: b.doc_kind || null })
      return reply.code(201).send({ success: true, data: { message: rows[0], document_request: docRequest } })
    } catch (err) {
      request.log.error({ err }, 'request-info failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Generated decision documents (council's authoritative copies) ─
  fastify.get('/permit-applications/:id/generated-documents', {
    preHandler: requireRole(fastify, PERMIT_READERS),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const ownRow = await pg.query(
      'SELECT created_by FROM spatial_planning.permit_application WHERE id = $1',
      [request.params.id])
    if (!ownRow.rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    const isStaff = STAFF_ROLES.includes(request.user.role)
    if (!isStaff && ownRow.rows[0].created_by !== request.user.id) {
      return reply.code(404).send({ success: false, error: 'not_found' })
    }
    const { rows } = await pg.query(
      `SELECT d.id, d.doc_type, d.title, d.mime_type, d.version, d.storage_url, d.created_at,
              COALESCE(u.full_name, u.name) AS generated_by_name
         FROM spatial_planning.generated_document d
         LEFT JOIN public.users u ON u.id = d.generated_by
        WHERE d.permit_app_id = $1
        ORDER BY d.created_at DESC`,
      [request.params.id],
    )
    return reply.send({ success: true, data: rows })
  })

  // Fetch one generated document including its rendered content (for viewing
  // / printing). Owner-scoped exactly like the permit reads.
  fastify.get('/generated-documents/:id', {
    preHandler: requireRole(fastify, PERMIT_READERS),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const { rows } = await pg.query(
      `SELECT d.*, pa.created_by AS permit_created_by
         FROM spatial_planning.generated_document d
         JOIN spatial_planning.permit_application pa ON pa.id = d.permit_app_id
        WHERE d.id = $1`,
      [request.params.id],
    )
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    const isStaff = STAFF_ROLES.includes(request.user.role)
    if (!isStaff && rows[0].permit_created_by !== request.user.id) {
      return reply.code(404).send({ success: false, error: 'not_found' })
    }
    const doc = rows[0]
    delete doc.permit_created_by
    return reply.send({ success: true, data: doc })
  })

  // Save a GIS map snapshot (the application on the basemap with the chosen
  // evidence layers) to the decision record as a generated_document. The PNG
  // is stored as a data URL in content (image storage_url, migration 087/088).
  fastify.post('/permit-applications/:id/map-evidence', {
    preHandler: requireRole(fastify, ['eo', 'planner', 'planning_clerk', 'admin']),
    bodyLimit: 8 * 1024 * 1024,   // a PNG data URL exceeds the 1 MB default
  }, async (request, reply) => {
    const id = request.params.id
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    const image = typeof b.image === 'string' ? b.image : null
    if (!image || !/^data:image\/png;base64,/.test(image)) {
      return reply.code(400).send({ success: false, error: 'image (png data URL) required' })
    }
    if (image.length > 8_000_000) return reply.code(413).send({ success: false, error: 'image too large' })
    try {
      const own = await pg.query('SELECT id FROM spatial_planning.permit_application WHERE id=$1', [id])
      if (!own.rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      const base64 = image.split(',')[1] || ''
      const bytes = Buffer.byteLength(base64, 'base64')
      const sha = crypto.createHash('sha256').update(image).digest('hex')
      const verRow = await pg.query(
        `SELECT COALESCE(MAX(version),0)+1 AS v FROM spatial_planning.generated_document
          WHERE permit_app_id=$1 AND doc_type='map_evidence'`, [id])
      const ins = await pg.query(
        `INSERT INTO spatial_planning.generated_document
           (permit_app_id, doc_type, title, content, mime_type, bytes, sha256_hex, version, payload, generated_by)
         VALUES ($1,'map_evidence',$2,$3,'image/png',$4,$5,$6,$7::jsonb,$8)
         RETURNING id, doc_type, title, mime_type, version, created_at`,
        [id, isStr(b.title, 200) ? b.title : 'Map evidence', image, bytes, sha,
         verRow.rows[0].v, JSON.stringify(b.payload ?? {}), request.user.id])
      await logEvent(id, 'map_evidence_saved', request, { document_id: ins.rows[0].id })
      return reply.code(201).send({ success: true, data: ins.rows[0] })
    } catch (err) {
      request.log.error({ err }, 'map-evidence failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ══════════════════════════════════════════════════════════════════
  // PHASE 2 — ENFORCEMENT
  // ══════════════════════════════════════════════════════════════════

  fastify.post('/enforcement-orders', {
    preHandler: requireRole(fastify, ['eo', 'planner', 'admin']),
  }, async (request, reply) => {
    const b = request.body || {}
    const required = ['order_type', 'subject_name', 'subject_address',
                      'breach_description', 'required_action']
    for (const f of required) {
      if (!isStr(b[f], 2000)) {
        return reply.code(400).send({ success: false, error: 'missing_field', field: f })
      }
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.enforcement_order
           (permit_app_id, order_reference, order_type, subject_name, subject_address,
            stand_number, breach_description, required_action, compliance_period,
            issued_at, issued_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          isUuid(b.permit_app_id) ? b.permit_app_id : null,
          b.order_reference || null,
          b.order_type, b.subject_name, b.subject_address,
          b.stand_number || null,
          b.breach_description, b.required_action,
          Number(b.compliance_period) || 30,
          isDate(b.issued_at) ? b.issued_at : new Date().toISOString().slice(0, 10),
          request.user.id,
        ],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ success: false, error: 'duplicate_reference' })
      request.log.error({ err }, 'create enforcement order failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/enforcement-orders', {
    preHandler: requireRole(fastify, ['eo', 'planner', 'admin', 'building_inspector', 'gis_officer', 'env_officer']),
  }, async (request, reply) => {
    const { status, limit = 50, offset = 0 } = request.query
    try {
      const { rows } = await pg.query(
        `SELECT * FROM spatial_planning.enforcement_order
         WHERE ($1::text IS NULL OR status = $1)
         ORDER BY issued_at DESC LIMIT $2 OFFSET $3`,
        [status || null, Math.min(Number(limit) || 50, 200), Number(offset) || 0],
      )
      return reply.send({ success: true, data: rows })
    } catch (err) {
      request.log.error({ err }, 'list enforcement orders failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.patch('/enforcement-orders/:id/status', {
    preHandler: requireRole(fastify, ['eo', 'planner', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    const VALID = ['draft','issued','served','complied','non_complied','withdrawn','appealed']
    if (!VALID.includes(b.status)) {
      return reply.code(400).send({ success: false, error: 'bad_status' })
    }
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.enforcement_order
            SET status            = $2,
                served_at         = CASE WHEN $2 = 'served' THEN CURRENT_DATE ELSE served_at END,
                compliance_due_at = COALESCE($3::date, compliance_due_at),
                notes             = COALESCE($4, notes)
          WHERE id = $1
          RETURNING *`,
        [request.params.id, b.status,
         isDate(b.compliance_due_at) ? b.compliance_due_at : null,
         b.notes || null],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'patch enforcement status failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/enforcement-orders/:id/compliance-checks', {
    preHandler: requireRole(fastify, ['eo', 'building_inspector', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (!isDate(b.visited_at)) {
      return reply.code(400).send({ success: false, error: 'visited_at (YYYY-MM-DD) required' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.enforcement_compliance_check
           (enforcement_order_id, visited_at, complied, notes, photo_urls, inspector_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [request.params.id, b.visited_at,
         typeof b.complied === 'boolean' ? b.complied : null,
         b.notes || null,
         Array.isArray(b.photo_urls) ? JSON.stringify(b.photo_urls) : '[]',
         request.user.id],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      if (err.code === '23503') return reply.code(404).send({ success: false, error: 'order_not_found' })
      request.log.error({ err }, 'compliance check create failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/prohibition-orders', {
    preHandler: requireRole(fastify, ['eo', 'planner', 'admin']),
  }, async (request, reply) => {
    const b = request.body || {}
    const required = ['subject_name', 'subject_address', 'prohibited_activity', 'reason']
    for (const f of required) {
      if (!isStr(b[f], 2000)) {
        return reply.code(400).send({ success: false, error: 'missing_field', field: f })
      }
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.prohibition_order
           (enforcement_order_id, order_reference, subject_name, subject_address,
            stand_number, prohibited_activity, reason, issued_at, issued_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          isUuid(b.enforcement_order_id) ? b.enforcement_order_id : null,
          b.order_reference || null,
          b.subject_name, b.subject_address, b.stand_number || null,
          b.prohibited_activity, b.reason,
          isDate(b.issued_at) ? b.issued_at : new Date().toISOString().slice(0, 10),
          request.user.id,
        ],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ success: false, error: 'duplicate_reference' })
      request.log.error({ err }, 'create prohibition order failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/prohibition-orders', {
    preHandler: requireRole(fastify, ['eo', 'planner', 'admin', 'building_inspector', 'gis_officer', 'env_officer']),
  }, async (request, reply) => {
    const { status, limit = 50, offset = 0 } = request.query
    const { rows } = await pg.query(
      `SELECT * FROM spatial_planning.prohibition_order
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY issued_at DESC LIMIT $2 OFFSET $3`,
      [status || null, Math.min(Number(limit) || 50, 200), Number(offset) || 0],
    )
    return reply.send({ success: true, data: rows })
  })

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 — BUILDING PLANS
  // ══════════════════════════════════════════════════════════════════

  fastify.post('/permit-applications/:id/building-plans', {
    preHandler: requireRole(fastify, ['building_inspector', 'planning_clerk', 'planner', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (!isStr(b.plan_document_url, 1000)) {
      return reply.code(400).send({ success: false, error: 'plan_document_url required' })
    }
    try {
      const { rows: revRows } = await pg.query(
        `SELECT COALESCE(MAX(revision), 0) + 1 AS next_rev
         FROM spatial_planning.building_plan WHERE permit_app_id = $1`,
        [request.params.id],
      )
      const revision = revRows[0].next_rev
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.building_plan
           (permit_app_id, revision, revision_label, plan_document_url, site_plan_url,
            structural_drawings_url, services_drawings_url, architect_name, architect_reg_no,
            engineer_name, engineer_reg_no, gross_floor_area_sqm, number_of_storeys,
            building_use, submitted_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [
          request.params.id, revision,
          b.revision_label || `Rev ${String.fromCharCode(64 + revision)}`,
          b.plan_document_url, b.site_plan_url || null,
          b.structural_drawings_url || null, b.services_drawings_url || null,
          b.architect_name || null, b.architect_reg_no || null,
          b.engineer_name || null, b.engineer_reg_no || null,
          b.gross_floor_area_sqm || null, b.number_of_storeys || null,
          b.building_use || null,
          isDate(b.submitted_at) ? b.submitted_at : new Date().toISOString().slice(0, 10),
          request.user.id,
        ],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      if (err.code === '23503') return reply.code(404).send({ success: false, error: 'application_not_found' })
      request.log.error({ err }, 'create building plan failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/permit-applications/:id/building-plans', {
    preHandler: requireRole(fastify, PERMIT_READERS),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const ownRow = await pg.query(
      'SELECT created_by FROM spatial_planning.permit_application WHERE id = $1',
      [request.params.id])
    if (!ownRow.rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    const isStaff = STAFF_ROLES.includes(request.user.role)
    if (!isStaff && ownRow.rows[0].created_by !== request.user.id) {
      return reply.code(404).send({ success: false, error: 'not_found' })
    }
    const { rows } = await pg.query(
      `SELECT * FROM spatial_planning.building_plan WHERE permit_app_id = $1 ORDER BY revision ASC`,
      [request.params.id],
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.patch('/building-plans/:bpid/appraisal', {
    preHandler: requireRole(fastify, ['building_inspector', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.bpid)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    const VALID = ['submitted','under_appraisal','approved','approved_with_amendments','rejected','resubmitted']
    if (!VALID.includes(b.status)) {
      return reply.code(400).send({ success: false, error: 'bad_status' })
    }
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.building_plan
            SET status          = $2,
                appraised_by    = $3,
                appraised_at    = CASE WHEN $2::varchar IN ('approved','approved_with_amendments','rejected')
                                       THEN CURRENT_DATE ELSE appraised_at END,
                appraisal_notes = COALESCE($4, appraisal_notes)
          WHERE id = $1
          RETURNING *`,
        [request.params.bpid, b.status, request.user.id, b.appraisal_notes || null],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'building plan appraisal patch failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/building-plans/:bpid/annotations', {
    preHandler: requireRole(fastify, ['building_inspector', 'planner', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.bpid)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (!['info','warn','error'].includes(b.severity) || !isStr(b.message, 2000)) {
      return reply.code(400).send({ success: false, error: 'severity and message required' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.building_plan_annotation
           (building_plan_id, page_number, severity, code, message, bbox, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [request.params.bpid, b.page_number || null, b.severity,
         b.code || null, b.message,
         b.bbox ? JSON.stringify(b.bbox) : null, request.user.id],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      if (err.code === '23503') return reply.code(404).send({ success: false, error: 'plan_not_found' })
      request.log.error({ err }, 'create annotation failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ══════════════════════════════════════════════════════════════════
  // PHASE 4 — STAGE INSPECTIONS
  // ══════════════════════════════════════════════════════════════════
  //
  // GET /inspection-stages is owned by routes/inspections.js (the public
  // catalogue handler). Registering it here as well used to crash startup
  // with FST_ERR_DUPLICATED_ROUTE. Removed to keep one source of truth.

  fastify.get('/inspection-checklist/:stageNumber', async (request, reply) => {
    const stageNumber = Number(request.params.stageNumber)
    if (!Number.isInteger(stageNumber) || stageNumber < 1 || stageNumber > 9) {
      return reply.code(400).send({ success: false, error: 'bad_stage_number' })
    }
    const { rows } = await pg.query(
      `SELECT ci.id, ci.code, ci.description, ci.is_mandatory, ci.applicable_stages,
              cc.code AS category_code, cc.label AS category_label
       FROM spatial_planning.checklist_item ci
       JOIN spatial_planning.checklist_category cc ON cc.id = ci.category_id
       WHERE $1 = ANY(ci.applicable_stages)
       ORDER BY cc.sort_order, ci.sort_order`,
      [stageNumber],
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.post('/permit-applications/:id/stage-inspections', {
    preHandler: requireRole(fastify, ['building_inspector', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    const stageNumber = Number(b.stage_number)
    if (!Number.isInteger(stageNumber) || stageNumber < 1 || stageNumber > 9) {
      return reply.code(400).send({ success: false, error: 'bad_stage_number' })
    }
    try {
      const { rows: attemptRows } = await pg.query(
        `SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt
         FROM spatial_planning.stage_inspection
         WHERE permit_app_id = $1 AND stage_number = $2`,
        [request.params.id, stageNumber],
      )
      const attempt = attemptRows[0].next_attempt
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.stage_inspection
           (permit_app_id, building_plan_id, stage_number, attempt, inspector_id,
            scheduled_at, stamp_reference, weather_conditions, site_ready)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          request.params.id,
          isUuid(b.building_plan_id) ? b.building_plan_id : null,
          stageNumber, attempt, request.user.id,
          b.scheduled_at ? new Date(b.scheduled_at).toISOString() : null,
          b.stamp_reference || null,
          b.weather_conditions || null,
          typeof b.site_ready === 'boolean' ? b.site_ready : null,
        ],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      if (err.code === '23503') return reply.code(404).send({ success: false, error: 'application_not_found' })
      request.log.error({ err }, 'create stage inspection failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/permit-applications/:id/stage-inspections', {
    preHandler: requireRole(fastify, PERMIT_READERS),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const ownRow = await pg.query(
      'SELECT created_by FROM spatial_planning.permit_application WHERE id = $1',
      [request.params.id])
    if (!ownRow.rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    const isStaff = STAFF_ROLES.includes(request.user.role)
    if (!isStaff && ownRow.rows[0].created_by !== request.user.id) {
      return reply.code(404).send({ success: false, error: 'not_found' })
    }
    const { rows } = await pg.query(
      `SELECT * FROM spatial_planning.v_inspection_progress
       WHERE permit_app_id = $1 ORDER BY stage_number, attempt`,
      [request.params.id],
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.get('/stage-inspections/:sid', {
    preHandler: requireAuth(fastify),
  }, async (request, reply) => {
    if (!isUuid(request.params.sid)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const { rows } = await pg.query(
      `SELECT si.*, ist.stage_name, ist.prerequisites
       FROM spatial_planning.stage_inspection si
       JOIN spatial_planning.inspection_stage ist ON ist.stage_number = si.stage_number
       WHERE si.id = $1`,
      [request.params.sid],
    )
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    const { rows: checklistRows } = await pg.query(
      `SELECT icr.*, ci.code, ci.description, ci.is_mandatory,
              cc.code AS category_code, cc.label AS category_label
       FROM spatial_planning.inspection_checklist_result icr
       JOIN spatial_planning.checklist_item ci ON ci.id = icr.checklist_item_id
       JOIN spatial_planning.checklist_category cc ON cc.id = ci.category_id
       WHERE icr.stage_inspection_id = $1
       ORDER BY cc.sort_order, ci.sort_order`,
      [request.params.sid],
    )
    return reply.send({ success: true, data: { ...rows[0], checklist: checklistRows } })
  })

  fastify.post('/stage-inspections/:sid/checklist', {
    preHandler: requireRole(fastify, ['building_inspector', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.sid)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (!Array.isArray(b.results) || b.results.length === 0) {
      return reply.code(400).send({ success: false, error: 'results array required' })
    }
    const VALID_RESULTS = ['pass', 'fail', 'na']
    for (const r of b.results) {
      if (!Number.isInteger(r.checklist_item_id) || !VALID_RESULTS.includes(r.result)) {
        return reply.code(400).send({ success: false, error: 'bad_result_entry' })
      }
      // Score is required for any item not marked 'na'. The *system* —
      // not the inspector — decides pass/fail from these scores.
      if (r.result !== 'na') {
        const score = Number(r.score)
        if (!Number.isFinite(score) || score < 0 || score > 10) {
          return reply.code(400).send({
            success: false, error: 'score_required',
            message: `Item ${r.checklist_item_id} needs a score between 0 and 10`,
          })
        }
      }
      if (r.photo_id != null && !isUuid(r.photo_id)) {
        return reply.code(400).send({ success: false, error: 'bad_photo_id' })
      }
    }
    try {
      for (const r of b.results) {
        await pg.query(
          `INSERT INTO spatial_planning.inspection_checklist_result
             (stage_inspection_id, checklist_item_id, result, notes, score, photo_id)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (stage_inspection_id, checklist_item_id) DO UPDATE
             SET result   = EXCLUDED.result,
                 notes    = COALESCE(EXCLUDED.notes, inspection_checklist_result.notes),
                 score    = EXCLUDED.score,
                 photo_id = COALESCE(EXCLUDED.photo_id, inspection_checklist_result.photo_id)`,
          [
            request.params.sid, r.checklist_item_id, r.result,
            r.notes || null,
            r.result === 'na' ? null : Number(r.score),
            r.photo_id || null,
          ],
        )
      }

      // Ask the database to compute the overall result from the per-item
      // scores. The inspector cannot override this — anti-corruption.
      const { rows: scoreRows } = await pg.query(
        `SELECT item_count, scored_count, photo_count,
                avg_score, min_score, max_score, computed_result
         FROM spatial_planning.stage_inspection_scoring
         WHERE stage_inspection_id = $1`,
        [request.params.sid],
      )
      const summary = scoreRows[0] || {
        item_count: 0, scored_count: 0, photo_count: 0,
        avg_score: null, min_score: null, max_score: null, computed_result: null,
      }

      if (summary.computed_result) {
        await pg.query(
          `UPDATE spatial_planning.stage_inspection
              SET result        = $2,
                  inspected_at  = NOW(),
                  result_notes  = COALESCE($3, result_notes)
            WHERE id = $1`,
          [request.params.sid, summary.computed_result, b.result_notes || null],
        )
      }
      return reply.send({
        success: true,
        data: { ...summary, stage_inspection_id: request.params.sid },
      })
    } catch (err) {
      if (err.code === '23503') {
        return reply.code(404).send({ success: false, error: 'inspection_or_item_not_found' })
      }
      request.log.error({ err }, 'save checklist results failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // GET system-computed score summary for a stage inspection.
  fastify.get('/stage-inspections/:sid/scoring', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    if (!isUuid(request.params.sid)) {
      return reply.code(400).send({ success: false, error: 'bad_id' })
    }
    const { rows } = await pg.query(
      `SELECT * FROM spatial_planning.stage_inspection_scoring WHERE stage_inspection_id = $1`,
      [request.params.sid],
    )
    return reply.send({ success: true, data: rows[0] || null })
  })

  // ══════════════════════════════════════════════════════════════════
  // PHASE 5 — CERTIFICATE OF OCCUPATION
  // ══════════════════════════════════════════════════════════════════

  fastify.post('/permit-applications/:id/occupation-certificate', {
    preHandler: requireRole(fastify, ['building_inspector', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (!isStr(b.certificate_no, 40)) {
      return reply.code(400).send({ success: false, error: 'certificate_no required' })
    }
    // Guard: all 8 construction stages must have passed.
    const { rows: stageRows } = await pg.query(
      `SELECT stage_number, result FROM spatial_planning.stage_inspection
       WHERE permit_app_id = $1 AND stage_number < 9
       ORDER BY stage_number, attempt DESC`,
      [request.params.id],
    )
    const latestByStage = new Map()
    for (const r of stageRows) {
      if (!latestByStage.has(r.stage_number)) latestByStage.set(r.stage_number, r)
    }
    const failed = []
    for (let s = 1; s <= 8; s++) {
      const row = latestByStage.get(s)
      if (!row || !['pass', 'conditional_pass'].includes(row.result)) failed.push(s)
    }
    if (failed.length > 0) {
      return reply.code(409).send({
        success: false,
        error: 'stages_not_passed',
        message: `Stages ${failed.join(', ')} have not passed.`,
      })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.occupation_certificate
           (permit_app_id, certificate_no, issued_at, occupant_name, building_use,
            gross_floor_area_sqm, issued_by, countersigned_by, certificate_pdf_url, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          request.params.id, b.certificate_no,
          isDate(b.issued_at) ? b.issued_at : new Date().toISOString().slice(0, 10),
          b.occupant_name || null, b.building_use || null,
          b.gross_floor_area_sqm || null,
          request.user.id,
          isUuid(b.countersigned_by) ? b.countersigned_by : null,
          b.certificate_pdf_url || null, b.notes || null,
        ],
      )
      // Mark the application as approved.
      await pg.query(
        `UPDATE spatial_planning.permit_application
            SET status = 'approved', decision_at = CURRENT_DATE, decision_officer = $2
          WHERE id = $1 AND status NOT IN ('approved','approved_with_conditions')`,
        [request.params.id, request.user.id],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      if (err.code === '23505') {
        return reply.code(409).send({ success: false, error: 'certificate_already_issued' })
      }
      if (err.code === '23503') {
        return reply.code(404).send({ success: false, error: 'application_not_found' })
      }
      request.log.error({ err }, 'issue occupation certificate failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/permit-applications/:id/occupation-certificate', {
    preHandler: requireAuth(fastify),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const { rows } = await pg.query(
      `SELECT * FROM spatial_planning.occupation_certificate WHERE permit_app_id = $1`,
      [request.params.id],
    )
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    return reply.send({ success: true, data: rows[0] })
  })

  // ══════════════════════════════════════════════════════════════════
  // PHASE 4b — STAGE INSPECTION PHOTO EVIDENCE
  // ══════════════════════════════════════════════════════════════════

  // Boot-time best-effort: make sure the upload root exists.
  try { await ensureDir(STAGE_PHOTO_ROOT) } catch { /* surfaced at upload time */ }

  // POST /stage-inspections/:sid/photos
  // Multipart upload. Field name: 'photo'. Optional fields: caption, takenAt, lng, lat.
  fastify.post('/stage-inspections/:sid/photos', {
    preHandler: requireRole(fastify, ['building_inspector', 'planner', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.sid)) {
      return reply.code(400).send({ success: false, error: 'bad_id' })
    }
    if (!request.isMultipart || !request.isMultipart()) {
      return reply.code(415).send({ success: false, error: 'expected_multipart' })
    }

    // Confirm the parent inspection exists (FK errors would otherwise be opaque).
    const { rows: inspRows } = await pg.query(
      `SELECT id FROM spatial_planning.stage_inspection WHERE id = $1`,
      [request.params.sid],
    )
    if (!inspRows[0]) {
      return reply.code(404).send({ success: false, error: 'inspection_not_found' })
    }

    let file = null, caption = null, takenAt = null, lng = null, lat = null
    try {
      const parts = request.parts({ limits: { fileSize: MAX_STAGE_PHOTO_BYTES, files: 1 } })
      for await (const part of parts) {
        if (part.type === 'file') {
          if (file) { await part.toBuffer().catch(() => null); continue }
          if (!ALLOWED_STAGE_PHOTO_MIME.has(part.mimetype)) {
            return reply.code(415).send({
              success: false, error: 'bad_mime',
              message: `Allowed: ${[...ALLOWED_STAGE_PHOTO_MIME].join(', ')}`,
            })
          }
          const buf = await part.toBuffer()
          if (!buf || buf.length === 0) {
            return reply.code(400).send({ success: false, error: 'empty_file' })
          }
          file = { mimetype: part.mimetype, filename: part.filename, buffer: buf }
        } else if (part.type === 'field') {
          if (part.fieldname === 'caption' && isStr(part.value, 255)) caption = part.value
          if (part.fieldname === 'takenAt' && isStr(part.value, 64))  takenAt = part.value
          if (part.fieldname === 'lng' && isStr(part.value, 32))      lng = Number(part.value)
          if (part.fieldname === 'lat' && isStr(part.value, 32))      lat = Number(part.value)
        }
      }
    } catch (err) {
      if (err && err.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ success: false, error: 'too_large', message: 'Photo exceeds 10 MB.' })
      }
      request.log.error({ err }, 'stage photo parse failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
    if (!file) return reply.code(400).send({ success: false, error: 'no_file' })

    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex')
    const id = crypto.randomUUID()
    const ext = MIME_EXT[file.mimetype] || ''
    const dir = path.join(STAGE_PHOTO_ROOT, request.params.sid)
    const diskPath = path.join(dir, `${id}${ext}`)
    const storageUrl = `/uploads/stage-photos/${request.params.sid}/${id}${ext}`

    try {
      await ensureDir(dir)
      await fs.writeFile(diskPath, file.buffer)
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.stage_inspection_photo
           (id, stage_inspection_id, storage_url, mime_type, bytes, sha256_hex,
            caption, taken_at, taken_lng, taken_lat, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (stage_inspection_id, sha256_hex) DO UPDATE
           SET caption = COALESCE(EXCLUDED.caption, stage_inspection_photo.caption)
         RETURNING *`,
        [
          id, request.params.sid, storageUrl, file.mimetype,
          file.buffer.length, sha256, caption,
          takenAt && !Number.isNaN(Date.parse(takenAt)) ? new Date(takenAt).toISOString() : null,
          Number.isFinite(lng) ? lng : null,
          Number.isFinite(lat) ? lat : null,
          request.user.id,
        ],
      )
      // Mirror into the legacy JSONB array on stage_inspection so existing
      // callers that read photo_urls keep working.
      await pg.query(
        `UPDATE spatial_planning.stage_inspection
            SET photo_urls = photo_urls || to_jsonb($2::text)
          WHERE id = $1 AND NOT (photo_urls ? $2)`,
        [request.params.sid, storageUrl],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'stage photo upload failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // GET /stage-inspections/:sid/photos
  fastify.get('/stage-inspections/:sid/photos', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    if (!isUuid(request.params.sid)) {
      return reply.code(400).send({ success: false, error: 'bad_id' })
    }
    const { rows } = await pg.query(
      `SELECT id, stage_inspection_id, storage_url, mime_type, bytes, sha256_hex,
              caption, taken_at, taken_lng, taken_lat, uploaded_by, created_at
       FROM spatial_planning.stage_inspection_photo
       WHERE stage_inspection_id = $1
       ORDER BY created_at DESC`,
      [request.params.sid],
    )
    return reply.send({ success: true, data: rows })
  })

  // ══════════════════════════════════════════════════════════════════
  // PHASE 4c — ANTI-CORRUPTION FLAGS
  // ══════════════════════════════════════════════════════════════════

  const FLAG_REASONS = new Set([
    'work_not_done', 'work_not_to_standard', 'photos_dont_match_site',
    'safety_issue_missed', 'measurements_incorrect', 'fraudulent_pass',
    'absent_during_inspection', 'other',
  ])

  // POST /stage-inspections/:sid/flag — file an anti-corruption flag.
  fastify.post('/stage-inspections/:sid/flag', {
    preHandler: requireRole(fastify, ['building_inspector', 'planner', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.sid)) {
      return reply.code(400).send({ success: false, error: 'bad_id' })
    }
    const b = request.body || {}
    if (!FLAG_REASONS.has(b.reason_code)) {
      return reply.code(400).send({ success: false, error: 'bad_reason_code' })
    }
    if (!isStr(b.description, 4096)) {
      return reply.code(400).send({ success: false, error: 'description_required' })
    }
    const evidenceIds = Array.isArray(b.evidence_photo_ids)
      ? b.evidence_photo_ids.filter(isUuid)
      : []

    try {
      // Forbid flagging your own inspection — prevents weaponising the flag system.
      const { rows: ownRows } = await pg.query(
        `SELECT inspector_id FROM spatial_planning.stage_inspection WHERE id = $1`,
        [request.params.sid],
      )
      if (!ownRows[0]) {
        return reply.code(404).send({ success: false, error: 'inspection_not_found' })
      }
      if (ownRows[0].inspector_id && ownRows[0].inspector_id === request.user.id) {
        return reply.code(409).send({ success: false, error: 'cannot_flag_own_inspection' })
      }

      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.stage_inspection_flag
           (stage_inspection_id, reason_code, description, evidence_photo_ids,
            flagged_by, flagged_by_role)
         VALUES ($1,$2,$3,$4::UUID[],$5,$6)
         RETURNING *`,
        [
          request.params.sid, b.reason_code, b.description, evidenceIds,
          request.user.id, request.user.role,
        ],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      if (err.code === '23503') {
        return reply.code(404).send({ success: false, error: 'inspection_not_found' })
      }
      request.log.error({ err }, 'stage flag failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // GET /stage-inspections/:sid/flags
  fastify.get('/stage-inspections/:sid/flags', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    if (!isUuid(request.params.sid)) {
      return reply.code(400).send({ success: false, error: 'bad_id' })
    }
    const { rows } = await pg.query(
      `SELECT f.*, u.name AS flagged_by_name
       FROM spatial_planning.stage_inspection_flag f
       LEFT JOIN public.users u ON u.id = f.flagged_by
       WHERE f.stage_inspection_id = $1
       ORDER BY f.created_at DESC`,
      [request.params.sid],
    )
    return reply.send({ success: true, data: rows })
  })

  // GET /permit-applications/:id/stage-inspection-flags — all flags for a permit.
  fastify.get('/permit-applications/:id/stage-inspection-flags', {
    preHandler: requireAuth(fastify),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) {
      return reply.code(400).send({ success: false, error: 'bad_id' })
    }
    const { rows } = await pg.query(
      `SELECT f.*, si.stage_number, u.name AS flagged_by_name
       FROM spatial_planning.stage_inspection_flag f
       JOIN spatial_planning.stage_inspection si ON si.id = f.stage_inspection_id
       LEFT JOIN public.users u ON u.id = f.flagged_by
       WHERE si.permit_app_id = $1
       ORDER BY f.created_at DESC`,
      [request.params.id],
    )
    return reply.send({ success: true, data: rows })
  })

  // ══════════════════════════════════════════════════════════════════
  // COMMITTEE MEETINGS & AGENDA (migration 083)
  // Table applications onto a committee meeting and record the hearing.
  // ══════════════════════════════════════════════════════════════════
  const SCHEDULERS = ['planner', 'planning_clerk', 'eo', 'admin']

  fastify.post('/committee-meetings', { preHandler: requireRole(fastify, SCHEDULERS) }, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.title, 160) || !isDate(b.meeting_date)) {
      return reply.code(400).send({ success: false, error: 'title and meeting_date (YYYY-MM-DD) required' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.committee_meeting (title, meeting_date, location, notes, created_by)
         VALUES ($1, $2::date, $3, $4, $5) RETURNING *`,
        [b.title, b.meeting_date, isStr(b.location, 160) ? b.location : null,
         isStr(b.notes, 4096) ? b.notes : null, request.user.id],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'create committee meeting failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/committee-meetings', { preHandler: requireRole(fastify, STAFF_ROLES) }, async (request, reply) => {
    const status = request.query?.status
    const { rows } = await pg.query(
      `SELECT m.*,
              (SELECT COUNT(*) FROM spatial_planning.agenda_item a WHERE a.meeting_id = m.id) AS item_count
         FROM spatial_planning.committee_meeting m
        WHERE ($1::text IS NULL OR m.status = $1)
        ORDER BY m.meeting_date DESC
        LIMIT 100`,
      [typeof status === 'string' ? status : null],
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.post('/committee-meetings/:id/agenda', { preHandler: requireRole(fastify, SCHEDULERS) }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (!isUuid(b.permit_app_id)) return reply.code(400).send({ success: false, error: 'permit_app_id required' })
    const purpose = ['determination', 'consideration', 'deputation', 'noting'].includes(b.purpose) ? b.purpose : 'determination'
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.agenda_item (meeting_id, permit_app_id, purpose, item_order, created_by)
         VALUES ($1, $2, $3,
           (SELECT COALESCE(MAX(item_order), 0) + 1 FROM spatial_planning.agenda_item WHERE meeting_id = $1),
           $4)
         RETURNING *`,
        [request.params.id, b.permit_app_id, purpose, request.user.id],
      )
      await logEvent(b.permit_app_id, 'hearing_scheduled', request, { meeting_id: request.params.id, purpose })
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ success: false, error: 'already_scheduled' })
      if (err.code === '23503') return reply.code(404).send({ success: false, error: 'meeting_or_permit_not_found' })
      request.log.error({ err }, 'schedule agenda item failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/committee-meetings/:id/agenda', { preHandler: requireRole(fastify, STAFF_ROLES) }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const { rows } = await pg.query(
      `SELECT a.*, p.dev_register_no, p.stand_number, p.suburb_ward,
              p.applicant_name, p.development_type, p.status AS permit_status
         FROM spatial_planning.agenda_item a
         JOIN spatial_planning.permit_application p ON p.id = a.permit_app_id
        WHERE a.meeting_id = $1
        ORDER BY a.item_order ASC`,
      [request.params.id],
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.patch('/agenda-items/:aid', { preHandler: requireRole(fastify, ['eo', 'planner', 'admin']) }, async (request, reply) => {
    if (!isUuid(request.params.aid)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    const VALID = ['pending', 'approved', 'approved_with_conditions', 'refused', 'deferred', 'noted']
    if (b.outcome !== undefined && !VALID.includes(b.outcome)) {
      return reply.code(400).send({ success: false, error: 'bad_outcome' })
    }
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.agenda_item
            SET outcome    = COALESCE($2, outcome),
                resolution = COALESCE($3, resolution),
                heard_at   = CASE WHEN $2 IS NOT NULL AND $2 <> 'pending' THEN NOW() ELSE heard_at END
          WHERE id = $1
          RETURNING *`,
        [request.params.aid, b.outcome ?? null, isStr(b.resolution, 4096) ? b.resolution : null],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      await logEvent(rows[0].permit_app_id, 'hearing_recorded', request, {
        agenda_item_id: rows[0].id, outcome: rows[0].outcome,
      })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'record agenda outcome failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/permit-applications/:id/meetings', { preHandler: requireRole(fastify, PERMIT_READERS) }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const ownRow = await pg.query(
      'SELECT created_by FROM spatial_planning.permit_application WHERE id = $1', [request.params.id])
    if (!ownRow.rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    const isStaff = STAFF_ROLES.includes(request.user.role)
    if (!isStaff && ownRow.rows[0].created_by !== request.user.id) {
      return reply.code(404).send({ success: false, error: 'not_found' })
    }
    const { rows } = await pg.query(
      `SELECT a.id AS agenda_item_id, a.purpose, a.outcome, a.resolution, a.heard_at,
              m.id AS meeting_id, m.title, m.meeting_date, m.location, m.status AS meeting_status
         FROM spatial_planning.agenda_item a
         JOIN spatial_planning.committee_meeting m ON m.id = a.meeting_id
        WHERE a.permit_app_id = $1
        ORDER BY m.meeting_date DESC`,
      [request.params.id],
    )
    return reply.send({ success: true, data: rows })
  })
}

module.exports = { developmentManagementRoutes }
