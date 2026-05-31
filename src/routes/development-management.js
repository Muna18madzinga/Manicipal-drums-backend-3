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

const STAFF_ROLES = ['admin', 'planner', 'planning_clerk', 'building_inspector', 'eo']

// Citizens (user / viewer / registered) can read their own rows and create
// new applications; only staff can change status or add internal records.
const PERMIT_READERS = [...STAFF_ROLES, 'user', 'viewer', 'registered']

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

async function developmentManagementRoutes(fastify) {
  const pg = fastify.pg

  // ══════════════════════════════════════════════════════════════════
  // PHASE 1 — PERMIT APPLICATIONS
  // ══════════════════════════════════════════════════════════════════

  fastify.post('/permit-applications', {
    preHandler: requireRole(fastify, ['planning_clerk', 'planner', 'admin', 'user', 'viewer', 'registered']),
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
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.permit_application
           (dev_app_id, tpd_reference, dev_register_no, stand_number, suburb_ward,
            street_address, stand_area_sqm, applicant_name, applicant_id_number,
            applicant_phone, applicant_email, development_type, description,
            site_plan_url, received_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
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
        ],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
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
         ORDER BY received_at DESC
         LIMIT $4 OFFSET $5`,
        [status || null, development_type || null, search || null,
         Math.min(Number(limit) || 50, 200), Number(offset) || 0,
         ownerFilter],
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
        'SELECT * FROM spatial_planning.permit_application WHERE id = $1',
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

  fastify.patch('/permit-applications/:id/status', {
    preHandler: requireRole(fastify, ['planner', 'planning_clerk', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) {
      return reply.code(400).send({ success: false, error: 'bad_id' })
    }
    const { status, decision_conditions, decision_at } = request.body || {}
    const VALID_STATUSES = ['registered','acknowledged','circulation','objection_period',
      'under_review','deferred','approved','approved_with_conditions','refused','withdrawn','appealed']
    if (!VALID_STATUSES.includes(status)) {
      return reply.code(400).send({ success: false, error: 'bad_status' })
    }
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.permit_application
            SET status              = $2,
                decision_conditions = COALESCE($3, decision_conditions),
                decision_at         = COALESCE($4::date, decision_at),
                decision_officer    = CASE WHEN $2 IN ('approved','approved_with_conditions','refused')
                                          THEN $5 ELSE decision_officer END
          WHERE id = $1
          RETURNING *`,
        [request.params.id, status, decision_conditions || null,
         isDate(decision_at) ? decision_at : null, request.user.id],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'patch permit status failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Consultations ────────────────────────────────────────────────

  fastify.post('/permit-applications/:id/consultations', {
    preHandler: requireRole(fastify, ['planner', 'planning_clerk', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (!isStr(b.body_name, 120)) {
      return reply.code(400).send({ success: false, error: 'body_name required' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.application_consultation
           (permit_app_id, body_name, body_type, contact_name, contact_email,
            circulated_at, response_due_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [request.params.id, b.body_name, b.body_type || null,
         b.contact_name || null, b.contact_email || null,
         isDate(b.circulated_at) ? b.circulated_at : null,
         isDate(b.response_due_at) ? b.response_due_at : null,
         request.user.id],
      )
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
    preHandler: requireRole(fastify, ['planner', 'admin']),
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
                response_document_url = COALESCE($5, response_document_url)
          WHERE id = $1
          RETURNING *`,
        [request.params.cid, b.response_status,
         isDate(b.response_received_at) ? b.response_received_at : null,
         b.response_notes || null, b.response_document_url || null],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'patch consultation response failed')
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
    preHandler: requireRole(fastify, ['planner', 'admin']),
  }, async (request, reply) => {
    if (!isUuid(request.params.oid)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (typeof b.sustained !== 'boolean') {
      return reply.code(400).send({ success: false, error: 'sustained (boolean) required' })
    }
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.application_objection
            SET sustained           = $2,
                consideration_notes = COALESCE($3, consideration_notes),
                considered_at       = CURRENT_DATE,
                considered_by       = $4
          WHERE id = $1
          RETURNING *`,
        [request.params.oid, b.sustained, b.consideration_notes || null, request.user.id],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'patch objection consideration failed')
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
    preHandler: requireRole(fastify, ['eo', 'planner', 'admin', 'building_inspector']),
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
    preHandler: requireRole(fastify, ['eo', 'planner', 'admin', 'building_inspector']),
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
                appraised_at    = CASE WHEN $2 IN ('approved','approved_with_amendments','rejected')
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
}

module.exports = { developmentManagementRoutes }
