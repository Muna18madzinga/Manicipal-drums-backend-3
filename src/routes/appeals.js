// src/routes/appeals.js
// ─────────────────────────────────────────────────────────────────────────
// Statutory appeals against a determination — RTCP Act [Ch. 29:12] s.38.
//
//   POST  /permit-applications/:id/appeals   lodge an appeal
//   GET   /appeals                           the register (staff) / mine (citizen)
//   GET   /appeals/:id                       one appeal
//   PATCH /appeals/:id/status                acknowledge · set hearing · decide
//
// The table has existed since migration 070; nothing ever served it, so the
// citizen "Lodge appeal" button and the staff appeals register both called an
// endpoint that was not there. No migration is needed here — only the routes.
//
// Two rules the Act imposes, enforced here rather than in the UI:
//   - only a DETERMINED application can be appealed (approved, approved with
//     conditions, or refused). An appeal against a case still under review is
//     not an appeal, it is a complaint, and belongs in messages.
//   - lodging moves the permit to `appealed` where the workflow allows it, so
//     every register in the product agrees the case is before the Court.
//
// Table: spatial_planning.application_appeal (migration 070).
// ─────────────────────────────────────────────────────────────────────────

const { requireAuth, requireRole } = require('../middleware/jwtAuth')
const { canTransition } = require('../config/permitWorkflow')

// Who may work the register. An appeal is development-control business, so the
// same desks that determine an application can process the appeal against it.
const STAFF_ROLES = ['admin', 'eo', 'planner', 'planning_clerk']

const APPELLANT_TYPES = ['applicant', 'objector', 'third_party']
const STATUSES = ['lodged', 'acknowledged', 'hearing_scheduled', 'decided', 'withdrawn']
const DECISIONS = ['upheld', 'dismissed', 'remitted']

// Only a determined application can be appealed.
const APPEALABLE = ['approved', 'approved_with_conditions', 'refused']

/**
 * s.38 window. The council does not refuse a late appeal here — the Court
 * decides admissibility — but every register shows whether it arrived in time,
 * which is the fact the EO is asked about.
 */
const APPEAL_WINDOW_DAYS = 28

const isUuid = (v) =>
  typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)

const isStr = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max

const orNull = (v, max) => (isStr(v, max) ? v.trim() : null)

/** `YYYY-MM-DD`, or null. Anything else is undefined — a caller error. */
function dateOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined
  return Number.isNaN(new Date(v).getTime()) ? undefined : v
}

function appealDto(r) {
  return {
    id: r.id,
    permit_application_id: r.permit_app_id,
    appellant_type: r.appellant_type,
    appellant_name: r.appellant_name,
    appellant_address: r.appellant_address,
    grounds: r.appeal_grounds,
    lodged_at: r.lodged_at,
    document_url: r.document_url,
    status: r.status,
    hearing_date: r.hearing_date,
    decision: r.decision,
    decision_notes: r.decision_notes,
    decided_at: r.decided_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    // Denormalised so a register row needs no second query.
    dev_register_no: r.dev_register_no ?? null,
    tpd_reference: r.tpd_reference ?? null,
    stand_number: r.stand_number ?? null,
    suburb_ward: r.suburb_ward ?? null,
    applicant_name: r.applicant_name ?? null,
    permit_status: r.permit_status ?? null,
    permit_decided_at: r.permit_decided_at ?? null,
    // Was it lodged inside the s.38 window? Computed in SQL from the decision
    // date so the register and the case file can never disagree about it.
    days_after_decision: r.days_after_decision == null ? null : Number(r.days_after_decision),
    within_window: r.days_after_decision == null
      ? null
      : Number(r.days_after_decision) <= APPEAL_WINDOW_DAYS,
  }
}

const SELECT_APPEAL = `
  SELECT a.*,
         p.dev_register_no, p.tpd_reference, p.stand_number, p.suburb_ward,
         p.applicant_name, p.status AS permit_status,
         p.decision_at AS permit_decided_at,
         p.created_by, p.applicant_email,
         (a.lodged_at - p.decision_at) AS days_after_decision
    FROM spatial_planning.application_appeal a
    JOIN spatial_planning.permit_application p ON p.id = a.permit_app_id
`

async function appealRoutes(fastify) {
  const pg = fastify.pg

  const isStaff = (user) => STAFF_ROLES.includes(user?.role)

  /** Append-only audit trail, shared with development-management.js. */
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

  // ── lodge ───────────────────────────────────────────────────────────
  // Staff lodge over the counter; the applicant lodges from the citizen
  // portal against their own application, which is why this is requireAuth
  // with an ownership check rather than a role gate.
  fastify.post('/permit-applications/:id/appeals', {
    preHandler: requireAuth(fastify),
  }, async (request, reply) => {
    const permitId = request.params.id
    if (!isUuid(permitId)) return reply.code(400).send({ success: false, error: 'bad_id' })

    const b = request.body || {}
    if (!isStr(b.grounds, 8000)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'grounds' })
    }

    const appellantType = b.appellant_type === undefined ? 'applicant' : b.appellant_type
    if (!APPELLANT_TYPES.includes(appellantType)) {
      return reply.code(400).send({ success: false, error: 'bad_appellant_type' })
    }

    const lodgedAt = dateOrNull(b.lodged_at)
    if (lodgedAt === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_date', field: 'lodged_at' })
    }

    try {
      const { rows: permits } = await pg.query(
        `SELECT id, status, applicant_email, applicant_name, created_by
           FROM spatial_planning.permit_application
          WHERE id = $1`,
        [permitId],
      )
      if (!permits.length) return reply.code(404).send({ success: false, error: 'not_found' })
      const permit = permits[0]

      // A citizen may only appeal their own application. Matching on the
      // account that lodged it, falling back to the email captured on the
      // application for counter-captured cases.
      if (!isStaff(request.user)) {
        const ownsIt = (permit.created_by && permit.created_by === request.user?.id)
          || (permit.applicant_email && request.user?.email
              && permit.applicant_email.toLowerCase() === String(request.user.email).toLowerCase())
        if (!ownsIt) return reply.code(403).send({ success: false, error: 'forbidden' })
      }

      if (!APPEALABLE.includes(permit.status)) {
        return reply.code(409).send({
          success: false,
          error: 'not_determined',
          message: 'Only a determined application can be appealed.',
        })
      }

      // The appellant's own name for a citizen; staff must say who is appealing.
      const appellantName = orNull(b.appellant_name, 255)
        || (isStaff(request.user) ? null : (request.user?.name || permit.applicant_name))
      if (!appellantName) {
        return reply.code(400).send({ success: false, error: 'missing_field', field: 'appellant_name' })
      }

      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.application_appeal
           (permit_app_id, appellant_type, appellant_name, appellant_address,
            appeal_grounds, lodged_at, document_url, hearing_date)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::date, CURRENT_DATE),$7,$8)
         RETURNING id`,
        [
          permitId, appellantType, appellantName, orNull(b.appellant_address, 2000),
          b.grounds.trim(), lodgedAt, orNull(b.document_url, 2000),
          dateOrNull(b.hearing_date) || null,
        ],
      )

      // The case is now before the Court, and every register should say so.
      // A status the workflow will not accept is left alone rather than forced:
      // the appeal is the record that matters, not the badge on the permit.
      if (canTransition(permit.status, 'appealed')) {
        await pg.query(
          `UPDATE spatial_planning.permit_application
              SET status = 'appealed', updated_at = NOW()
            WHERE id = $1`,
          [permitId],
        )
      }

      await logEvent(permitId, 'appeal_lodged', request, {
        appeal_id: rows[0].id, appellant_type: appellantType,
      })

      const { rows: full } = await pg.query(`${SELECT_APPEAL} WHERE a.id = $1`, [rows[0].id])
      return reply.code(201).send({ success: true, data: appealDto(full[0]) })
    } catch (err) {
      request.log.error({ err }, 'lodge appeal failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── register ────────────────────────────────────────────────────────
  // Staff see the whole register; anyone else sees only their own appeals,
  // whether or not they asked for `mine`.
  fastify.get('/appeals', {
    preHandler: requireAuth(fastify),
  }, async (request, reply) => {
    const q = request.query || {}
    const where = []
    const params = []
    const add = (sql, value) => { params.push(value); where.push(sql.replace('$$', `$${params.length}`)) }

    if (STATUSES.includes(q.status)) add('a.status = $$', q.status)
    if (isUuid(q.permit_application_id)) add('a.permit_app_id = $$', q.permit_application_id)
    if (DECISIONS.includes(q.decision)) add('a.decision = $$', q.decision)
    if (q.open === 'true' || q.open === true) where.push(`a.status NOT IN ('decided','withdrawn')`)
    if (isStr(q.search, 120)) {
      params.push(`%${q.search.trim()}%`)
      const p = `$${params.length}`
      where.push(`(a.appellant_name ILIKE ${p} OR a.appeal_grounds ILIKE ${p}
                   OR p.dev_register_no ILIKE ${p} OR p.tpd_reference ILIKE ${p}
                   OR p.stand_number ILIKE ${p} OR p.applicant_name ILIKE ${p})`)
    }

    if (!isStaff(request.user)) {
      params.push(request.user?.id || null)
      const uid = `$${params.length}`
      params.push(String(request.user?.email || '').toLowerCase())
      const mail = `$${params.length}`
      where.push(`(p.created_by = ${uid} OR LOWER(p.applicant_email) = ${mail})`)
    }

    const limit = Math.min(Number(q.limit) || 100, 500)
    const offset = Math.max(Number(q.offset) || 0, 0)

    try {
      const { rows } = await pg.query(
        `${SELECT_APPEAL}
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY a.lodged_at DESC, a.created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        params,
      )
      return reply.send({ success: true, data: rows.map(appealDto) })
    } catch (err) {
      request.log.error({ err }, 'list appeals failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── one appeal ──────────────────────────────────────────────────────
  fastify.get('/appeals/:id', {
    preHandler: requireAuth(fastify),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    try {
      const { rows } = await pg.query(`${SELECT_APPEAL} WHERE a.id = $1`, [request.params.id])
      if (!rows.length) return reply.code(404).send({ success: false, error: 'not_found' })
      const r = rows[0]
      if (!isStaff(request.user)) {
        const ownsIt = (r.created_by && r.created_by === request.user?.id)
          || (r.applicant_email && request.user?.email
              && String(r.applicant_email).toLowerCase() === String(request.user.email).toLowerCase())
        if (!ownsIt) return reply.code(403).send({ success: false, error: 'forbidden' })
      }
      return reply.send({ success: true, data: appealDto(r) })
    } catch (err) {
      request.log.error({ err }, 'get appeal failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── acknowledge · schedule hearing · decide ─────────────────────────
  // Staff only: an appellant never advances their own appeal.
  fastify.patch('/appeals/:id/status', {
    preHandler: requireRole(fastify, STAFF_ROLES),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}

    if (!STATUSES.includes(b.status)) {
      return reply.code(400).send({ success: false, error: 'bad_status', allowed: STATUSES })
    }
    if (b.decision !== undefined && b.decision !== null && !DECISIONS.includes(b.decision)) {
      return reply.code(400).send({ success: false, error: 'bad_decision', allowed: DECISIONS })
    }
    const hearingDate = dateOrNull(b.hearing_date)
    if (hearingDate === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_date', field: 'hearing_date' })
    }
    // A hearing date is what "hearing_scheduled" means; without one the status
    // says a hearing is set and the register cannot say when.
    if (b.status === 'hearing_scheduled' && !hearingDate) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'hearing_date' })
    }
    // A decided appeal without an outcome is the gap that leaves a case
    // sitting in `appealed` forever with nobody able to say what the Court held.
    if (b.status === 'decided' && !DECISIONS.includes(b.decision)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'decision' })
    }

    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.application_appeal
            SET status         = $2::varchar,
                hearing_date   = COALESCE($3::date, hearing_date),
                decision       = CASE WHEN $2::text = 'decided' THEN $4::varchar ELSE decision END,
                decision_notes = COALESCE($5::text, decision_notes),
                decided_at     = CASE WHEN $2::text = 'decided'
                                      THEN COALESCE(decided_at, CURRENT_DATE)
                                      ELSE decided_at END,
                updated_at     = NOW()
          WHERE id = $1
          RETURNING permit_app_id`,
        [
          request.params.id, b.status, hearingDate,
          b.decision ?? null, orNull(b.notes ?? b.decision_notes, 8000),
        ],
      )
      if (!rows.length) return reply.code(404).send({ success: false, error: 'not_found' })

      await logEvent(rows[0].permit_app_id, 'appeal_status_changed', request, {
        appeal_id: request.params.id, status: b.status, decision: b.decision ?? null,
      })

      // A remitted appeal sends the application back for re-determination.
      // Upheld and dismissed do not move the permit: what follows is a fresh
      // determination the EO records through the decision route, with its
      // letter and its conditions, not a status nudged from here.
      if (b.status === 'decided' && b.decision === 'remitted') {
        await pg.query(
          `UPDATE spatial_planning.permit_application
              SET status = 'under_review', updated_at = NOW()
            WHERE id = $1 AND status = 'appealed'`,
          [rows[0].permit_app_id],
        )
      }

      const { rows: full } = await pg.query(`${SELECT_APPEAL} WHERE a.id = $1`, [request.params.id])
      return reply.send({ success: true, data: appealDto(full[0]) })
    } catch (err) {
      request.log.error({ err }, 'update appeal status failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

module.exports = { appealRoutes, APPEAL_WINDOW_DAYS }
