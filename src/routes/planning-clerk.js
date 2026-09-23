// src/routes/planning-clerk.js
// ─────────────────────────────────────────────────────────────────────────
// The Planning Clerk's registers (migration 125).
//
//   GET    /planning-clerk/overview                  one round trip for the dashboard
//   GET    /planning-clerk/deadlines                 every statutory clock, in one list
//   GET    /planning-clerk/search?q=                 the counter lookup
//   GET    /planning-clerk/file/:permitId            one file, all nine registers
//   GET    /planning-clerk/registers/:register       list · filter · paginate
//   GET    /planning-clerk/registers/:register/export   the same query, as CSV
//   POST   /planning-clerk/registers/:register       create
//   PATCH  /planning-clerk/registers/:register/:id   correct
//   POST   /planning-clerk/registers/:register/:id/void   strike through, with a reason
//
// WHY THE REGISTERS SHARE ONE HANDLER
// There are nine of them and they are the same shape: a dated row against a
// file, written by a named officer, listed newest-first, searched over three
// or four text columns, never deleted. Writing that nine times would be nine
// places for the actor stamp to be forgotten, nine SQL builders to keep
// parameterised and nine CSV writers to keep escaping. REGISTERS below is the
// only description of each one; everything else is derived from it, and a new
// register is an entry in that object rather than a new file.
//
// The four endpoints above it are hand-written because they are not register
// CRUD: they answer questions that span the registers.
//
// THERE IS NO DELETE
// A register the clerk can delete rows from is not evidence. Correcting a row
// is a PATCH (the trail is admin_audit_event and updated_at); withdrawing one
// is a void, which keeps the row, the reason and the name. The database
// enforces the reason; this file enforces that no DELETE exists to call.
//
// WHO MAY READ AND WRITE
// Writes are the clerk's and the admin's. Reads are wider — the planner, the
// EO and the inspector all need to know whether the acknowledgement went out
// and where the physical file is — but no wider than council staff: the
// correspondence log carries citizens' names, addresses and phone numbers.
// ─────────────────────────────────────────────────────────────────────────

const { requireRole } = require('../middleware/jwtAuth')

// Everyone in the planning office can read a register; the clerk keeps it.
const READ_ROLES = ['planning_clerk', 'admin', 'planner', 'eo', 'gis_officer', 'inspector', 'env_officer']
const WRITE_ROLES = ['planning_clerk', 'admin']

// ── Field types ─────────────────────────────────────────────────────────
// Each is a validator that returns { ok, value } or { ok: false, why }. They
// are the trust boundary: nothing reaches SQL that has not been through one.

const T = {
  str: (max, { lower = false } = {}) => (raw) => {
    if (typeof raw !== 'string') return { ok: false, why: 'must be text' }
    const v = raw.trim()
    if (!v) return { ok: false, why: 'must not be blank' }
    if (v.length > max) return { ok: false, why: `must be ${max} characters or fewer` }
    return { ok: true, value: lower ? v.toLowerCase() : v }
  },
  text: (max = 8000) => (raw) => {
    if (typeof raw !== 'string') return { ok: false, why: 'must be text' }
    const v = raw.trim()
    if (v.length > max) return { ok: false, why: `must be ${max} characters or fewer` }
    return { ok: true, value: v || null }
  },
  enum: (allowed) => (raw) => {
    if (typeof raw !== 'string' || !allowed.includes(raw)) {
      return { ok: false, why: `must be one of ${allowed.join(', ')}` }
    }
    return { ok: true, value: raw }
  },
  ts: () => (raw) => {
    const d = new Date(String(raw))
    if (Number.isNaN(d.getTime())) return { ok: false, why: 'must be a date and time' }
    return { ok: true, value: d.toISOString() }
  },
  date: () => (raw) => {
    const s = String(raw)
    // A bare YYYY-MM-DD is a calendar date and must not be shifted by the
    // server's zone on the way in — an advert published on the 3rd becoming
    // the 2nd is a defective notice.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: true, value: s }
    const d = new Date(s)
    if (Number.isNaN(d.getTime())) return { ok: false, why: 'must be a date' }
    return { ok: true, value: d.toISOString().slice(0, 10) }
  },
  money: () => (raw) => {
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return { ok: false, why: 'must be an amount of zero or more' }
    if (n > 99_999_999_999) return { ok: false, why: 'is implausibly large' }
    return { ok: true, value: Math.round(n * 100) / 100 }
  },
  int: (min, max) => (raw) => {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min || n > max) {
      return { ok: false, why: `must be a whole number between ${min} and ${max}` }
    }
    return { ok: true, value: n }
  },
  bool: () => (raw) => {
    if (typeof raw === 'boolean') return { ok: true, value: raw }
    if (raw === 'true' || raw === 'false') return { ok: true, value: raw === 'true' }
    return { ok: false, why: 'must be true or false' }
  },
  uuid: () => (raw) => {
    if (typeof raw !== 'string'
      || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(raw)) {
      return { ok: false, why: 'must be an identifier' }
    }
    return { ok: true, value: raw }
  },
}

const isUuid = (v) => T.uuid()(v).ok

const SENT_METHODS = ['registered_post', 'ordinary_post', 'email', 'hand', 'courier']

// ── The registers ───────────────────────────────────────────────────────
// `req` fields must be present on create. `fields` not marked `req` are
// optional on create and settable on PATCH. A field marked `fixed` is set at
// create and never changed afterwards: the receipt number on a receipt and
// the letter number on a letter are the document's identity, and a counter
// that can renumber yesterday's receipt has no cashbook.

const REGISTERS = {
  correspondence: {
    table: 'clerk_correspondence',
    label: 'Correspondence log',
    dateColumn: 'logged_at',
    actorIdColumn: 'logged_by',
    actorNameColumn: 'logged_by_name',
    search: ['ref_no', 'party', 'subject', 'attached_doc_ref'],
    fields: {
      direction: { req: true, check: T.enum(['in', 'out']) },
      logged_at: { check: T.ts() },
      permit_application_id: { check: T.uuid(), nullable: true },
      ref_no: { req: true, check: T.str(60) },
      party: { req: true, check: T.str(200) },
      subject: { req: true, check: T.str(300) },
      channel: { req: true, check: T.enum(['letter', 'email', 'phone', 'in_person', 'fax']) },
      attached_doc_ref: { check: T.text(120), nullable: true },
      notes: { check: T.text(), nullable: true },
    },
  },

  receipts: {
    table: 'clerk_fee_receipt',
    label: 'Fee receipt register',
    dateColumn: 'paid_at',
    actorIdColumn: 'issued_by',
    actorNameColumn: 'issued_by_name',
    search: ['receipt_no', 'payer_name', 'reference'],
    fields: {
      receipt_no: { req: true, fixed: true, check: T.str(40) },
      fee_kind: {
        req: true,
        check: T.enum(['application', 'public_notice', 'plan_scrutiny', 'inspection',
          'occupation', 'appeal', 'search', 'copies', 'other']),
      },
      permit_application_id: { check: T.uuid(), nullable: true },
      payer_name: { req: true, check: T.str(200) },
      amount: { req: true, check: T.money() },
      currency: { req: true, check: T.enum(['USD', 'ZWG']) },
      paid_at: { check: T.ts() },
      payment_method: { req: true, check: T.enum(['cash', 'ecocash', 'eft', 'cheque', 'card']) },
      reference: { check: T.text(120), nullable: true },
      notes: { check: T.text(), nullable: true },
    },
  },

  acknowledgements: {
    table: 'clerk_acknowledgement',
    label: 'Acknowledgement letters',
    dateColumn: 'created_at',
    actorIdColumn: 'drafted_by',
    actorNameColumn: 'drafted_by_name',
    search: ['letter_no', 'application_register_no', 'recipient'],
    fields: {
      letter_no: { req: true, fixed: true, check: T.str(40) },
      permit_application_id: { req: true, fixed: true, check: T.uuid() },
      application_register_no: { check: T.text(40), nullable: true },
      received_at: { req: true, check: T.ts() },
      due_by: { req: true, check: T.ts() },
      determination_due_by: { check: T.ts(), nullable: true },
      sent_at: { check: T.ts(), nullable: true },
      sent_method: { check: T.enum(SENT_METHODS), nullable: true },
      recipient: { req: true, check: T.str(300) },
      notes: { check: T.text(), nullable: true },
    },
  },

  dispatches: {
    table: 'clerk_dispatch',
    label: 'Permit dispatch',
    dateColumn: 'dispatched_at',
    actorIdColumn: 'dispatched_by',
    actorNameColumn: 'dispatched_by_name',
    search: ['recipient', 'proof_of_delivery_ref'],
    fields: {
      permit_application_id: { req: true, fixed: true, check: T.uuid() },
      dispatched_at: { check: T.ts() },
      delivery_method: {
        req: true,
        check: T.enum(['collected', 'registered_post', 'courier', 'email']),
      },
      recipient: { req: true, check: T.str(300) },
      proof_of_delivery_ref: { check: T.text(120), nullable: true },
      notes: { check: T.text(), nullable: true },
    },
  },

  refusals: {
    table: 'clerk_refusal',
    label: 'Refusal letters',
    dateColumn: 'council_resolution_date',
    actorIdColumn: 'drafted_by',
    actorNameColumn: 'drafted_by_name',
    search: ['letter_no', 'recipient', 'reasons'],
    fields: {
      letter_no: { req: true, fixed: true, check: T.str(40) },
      permit_application_id: { req: true, fixed: true, check: T.uuid() },
      council_resolution_date: { req: true, check: T.ts() },
      due_by: { req: true, check: T.ts() },
      sent_at: { check: T.ts(), nullable: true },
      sent_method: { check: T.enum(SENT_METHODS), nullable: true },
      recipient: { req: true, check: T.str(300) },
      reasons: { req: true, check: T.str(8000) },
      notes: { check: T.text(), nullable: true },
    },
  },

  certificates: {
    table: 'clerk_notice_certificate',
    label: 'Newspaper notice certificates',
    dateColumn: 'advert_date',
    actorIdColumn: 'filed_by',
    actorNameColumn: 'filed_by_name',
    search: ['newspaper_name', 'filed_under_ref'],
    fields: {
      permit_application_id: { req: true, fixed: true, check: T.uuid() },
      newspaper_name: { req: true, check: T.str(160) },
      advert_date: { req: true, check: T.date() },
      second_advert_date: { check: T.date(), nullable: true },
      certificate_received_at: { check: T.date(), nullable: true },
      objection_closes_on: { check: T.date(), nullable: true },
      filed_under_ref: { req: true, check: T.str(120) },
      notes: { check: T.text(), nullable: true },
    },
  },

  abutters: {
    table: 'clerk_abutter_notice',
    label: 'Abutting-owner notifications',
    dateColumn: 'notified_at',
    actorIdColumn: 'served_by',
    actorNameColumn: 'served_by_name',
    search: ['abutter_name', 'abutter_stand_number', 'abutter_address', 'receipt_ref'],
    fields: {
      permit_application_id: { req: true, fixed: true, check: T.uuid() },
      abutter_name: { req: true, check: T.str(200) },
      abutter_stand_number: { check: T.text(40), nullable: true },
      abutter_address: { req: true, check: T.str(300) },
      notified_at: { check: T.ts() },
      method: {
        req: true,
        check: T.enum(['registered_post', 'courier', 'hand_delivered', 'email']),
      },
      receipt_ref: { check: T.text(120), nullable: true },
      responded: { check: T.bool() },
      notes: { check: T.text(), nullable: true },
    },
  },

  movements: {
    table: 'clerk_file_movement',
    label: 'File movement register',
    dateColumn: 'issued_at',
    actorIdColumn: 'issued_by',
    actorNameColumn: 'issued_by_name',
    search: ['holder_name', 'purpose'],
    fields: {
      permit_application_id: { req: true, fixed: true, check: T.uuid() },
      issued_at: { check: T.ts() },
      holder_name: { req: true, check: T.str(160) },
      holder_id: { check: T.uuid(), nullable: true },
      destination: {
        req: true,
        check: T.enum(['planner', 'eo_planner', 'gis_officer', 'building_inspector',
          'env_officer', 'committee', 'legal', 'treasury', 'registry',
          'chief_executive', 'external', 'other']),
      },
      purpose: { req: true, check: T.str(300) },
      due_back_on: { req: true, check: T.date() },
      returned_at: { check: T.ts(), nullable: true },
      returned_condition: { check: T.enum(['intact', 'incomplete', 'damaged']), nullable: true },
      notes: { check: T.text(), nullable: true },
    },
  },

  inspections: {
    table: 'clerk_public_inspection',
    label: 'Public inspection register',
    dateColumn: 'inspected_at',
    actorIdColumn: 'attended_by',
    actorNameColumn: 'attended_by_name',
    search: ['subject_description', 'requester_name', 'requester_contact'],
    fields: {
      inspected_at: { check: T.ts() },
      permit_application_id: { check: T.uuid(), nullable: true },
      subject_description: { req: true, check: T.str(300) },
      requester_name: { req: true, check: T.str(200) },
      requester_contact: { check: T.text(120), nullable: true },
      requester_capacity: {
        req: true,
        check: T.enum(['member_of_public', 'owner', 'agent', 'conveyancer',
          'surveyor', 'developer', 'other_authority', 'media']),
      },
      request_kind: {
        req: true,
        check: T.enum(['inspection', 'certified_copy', 'planning_search', 'plan_copy']),
      },
      copies_issued: { check: T.int(0, 500) },
      fee_receipt_id: { check: T.uuid(), nullable: true },
      notes: { check: T.text(), nullable: true },
    },
  },
}

const REGISTER_KEYS = Object.keys(REGISTERS)

// ── Helpers ─────────────────────────────────────────────────────────────

function pageArgs(query, { defaultLimit = 100, maxLimit = 500 } = {}) {
  const limit = Math.min(maxLimit, Math.max(1, Number(query?.limit) || defaultLimit))
  const offset = Math.max(0, Number(query?.offset) || 0)
  return { limit, offset }
}

/** RFC 4180 field: quote when it must be, double any quote inside. */
function csvField(value) {
  if (value === null || value === undefined) return ''
  const s = value instanceof Date ? value.toISOString() : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(rows, columns) {
  const lines = [columns.join(',')]
  for (const row of rows) lines.push(columns.map((c) => csvField(row[c])).join(','))
  return `${lines.join('\r\n')}\r\n`
}

/**
 * The officer's name as it should stand in the register.
 *
 * Denormalised beside the FK for the same reason the audit trail denormalises
 * the email: the FK is ON DELETE SET NULL, and a register entry that says
 * "someone" once the officer leaves the council is not evidence of who did it.
 */
function actorName(user) {
  const named = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim()
  return named || user?.full_name || user?.name || user?.email || 'Unknown officer'
}

/**
 * Turn a request body into columns and values, or into the list of what is
 * wrong with it.
 *
 * `mode` is 'create' or 'patch'. On create the required fields must all be
 * present; on patch only what was sent is touched, and `fixed` fields are
 * refused rather than ignored — a caller that sent one believes it changed.
 */
function bind(register, body, mode) {
  const errors = {}
  const columns = []
  const values = []

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: { _body: 'expected an object' } }
  }

  for (const [name, spec] of Object.entries(register.fields)) {
    const present = Object.prototype.hasOwnProperty.call(body, name)
    const raw = body[name]

    if (!present) {
      if (mode === 'create' && spec.req) errors[name] = 'is required'
      continue
    }

    if (mode === 'patch' && spec.fixed) {
      errors[name] = 'cannot be changed once the entry is written'
      continue
    }

    if (raw === null || raw === '') {
      if (spec.req) { errors[name] = 'is required'; continue }
      if (!spec.nullable) { errors[name] = 'cannot be cleared'; continue }
      columns.push(name)
      values.push(null)
      continue
    }

    const result = spec.check(raw)
    if (!result.ok) { errors[name] = result.why; continue }
    columns.push(name)
    values.push(result.value)
  }

  // A key the register does not have is a caller bug, and silently dropping
  // it is how a clerk comes to believe a field was saved.
  for (const name of Object.keys(body)) {
    if (!Object.prototype.hasOwnProperty.call(register.fields, name)) {
      errors[name] = 'is not a field of this register'
    }
  }

  if (Object.keys(errors).length) return { errors }
  return { columns, values }
}

/**
 * A constraint violation, said in the clerk's language.
 *
 * The CHECK constraints in migration 125 are the real rules — a posted permit
 * must carry a tracking number, a void must carry a reason, a file can be in
 * one place at a time. Letting those surface as a Postgres error string would
 * make the clerk read `clerk_dispatch_posted_is_tracked` off the screen.
 */
const CONSTRAINT_MESSAGES = {
  clerk_receipt_electronic_referenced:
    'An EFT or card receipt needs the transaction reference, or it cannot be reconciled against the bank statement.',
  clerk_dispatch_posted_is_tracked:
    'A permit sent by registered post or courier needs the tracking number as proof of delivery.',
  clerk_abutter_posted_is_tracked:
    'A notice sent by registered post or courier needs the delivery receipt reference.',
  clerk_ack_due_after_receipt:
    'The acknowledgement cannot be due before the application was received.',
  clerk_ack_sent_has_method:
    'Record how the letter was sent.',
  clerk_refusal_due_after_resolution:
    'The refusal letter cannot be due before the Council resolved to refuse.',
  clerk_refusal_sent_has_method:
    'Record how the letter was sent.',
  clerk_cert_second_after_first:
    'The second insertion cannot be dated before the first.',
  clerk_movement_return_dated:
    'Recording a file as returned needs its condition on return.',
  clerk_inspection_copies_receipted:
    'Copies are a charged service — attach the fee receipt before recording them as issued.',
  uq_clerk_ack_live_per_permit:
    'This application already has an acknowledgement letter. Void the existing one before writing another.',
  uq_clerk_refusal_live_per_permit:
    'This application already has a refusal letter. Void the existing one before writing another.',
  uq_clerk_movement_one_open_per_file:
    'This file is already signed out and has not come back. Record its return first.',
  clerk_fee_receipt_receipt_no_key:
    'That receipt number is already in the cashbook.',
  clerk_acknowledgement_letter_no_key:
    'That letter number is already in the register.',
  clerk_refusal_letter_no_key:
    'That letter number is already in the register.',
}

function dbError(reply, err) {
  const named = err?.constraint && CONSTRAINT_MESSAGES[err.constraint]
  if (named) {
    return reply.code(409).send({ success: false, error: 'rejected', message: named })
  }
  // 23503 foreign_key_violation — the file, or the receipt, is not there.
  if (err?.code === '23503') {
    return reply.code(409).send({
      success: false,
      error: 'rejected',
      message: 'That application or receipt is not on file.',
    })
  }
  if (err?.code === '23514' || err?.code === '23505') {
    return reply.code(409).send({
      success: false,
      error: 'rejected',
      message: 'The register would not accept that entry.',
    })
  }
  throw err
}

// The permit columns the clerk's screens read. Listed rather than SELECT *:
// permit_application carries the applicant's ID number and phone, and a
// register screen has no business shipping those to every reader.
const PERMIT_SUMMARY = `
  p.id, p.tpd_reference, p.dev_register_no, p.stand_number, p.suburb_ward,
  p.applicant_name, p.development_type, p.status, p.received_at, p.created_at`

async function planningClerkRoutes(fastify) {
  const canRead = { preHandler: requireRole(fastify, READ_ROLES) }
  const canWrite = { preHandler: requireRole(fastify, WRITE_ROLES) }

  /** Resolve :register, or answer 404 and return null. */
  function pick(request, reply) {
    const key = String(request.params.register || '')
    const register = Object.prototype.hasOwnProperty.call(REGISTERS, key) ? REGISTERS[key] : null
    if (!register) {
      reply.code(404).send({
        success: false,
        error: 'unknown_register',
        message: `No such register. Known registers: ${REGISTER_KEYS.join(', ')}.`,
      })
      return null
    }
    return register
  }

  /**
   * The WHERE clause every list and export shares.
   *
   * Column names come from REGISTERS, never from the query, so the only way
   * caller input reaches SQL is as a $n parameter.
   */
  function listWhere(register, query, params = []) {
    const clauses = []

    if (String(query.include_voided) !== 'true') clauses.push('r.voided_at IS NULL')

    if (query.permit && isUuid(query.permit)) {
      params.push(query.permit)
      clauses.push(`r.permit_application_id = $${params.length}`)
    }
    if (query.from) {
      const d = new Date(String(query.from))
      if (!Number.isNaN(d.getTime())) {
        params.push(d.toISOString())
        clauses.push(`r.${register.dateColumn} >= $${params.length}`)
      }
    }
    if (query.to) {
      const d = new Date(String(query.to))
      if (!Number.isNaN(d.getTime())) {
        params.push(d.toISOString())
        clauses.push(`r.${register.dateColumn} <= $${params.length}`)
      }
    }
    const q = typeof query.q === 'string' ? query.q.trim() : ''
    if (q && register.search.length) {
      params.push(`%${q}%`)
      const n = params.length
      clauses.push(`(${register.search.map((c) => `r.${c} ILIKE $${n}`).join(' OR ')})`)
    }
    if (query.outstanding === 'true' && register.fields.sent_at) {
      clauses.push('r.sent_at IS NULL')
    }
    if (query.open === 'true' && register.fields.returned_at) {
      clauses.push('r.returned_at IS NULL')
    }

    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
  }

  // ═════════════════════════════════════════════════════════════════════
  // OVERVIEW — one round trip for the dashboard
  // ═════════════════════════════════════════════════════════════════════
  // The console used to build this screen from six separate reads of the
  // whole permit table, 500 rows each, and then count them in the browser.
  // On a rural link that is most of a megabyte to show eight numbers. This
  // is one query, and the counting happens where the rows already are.
  fastify.get('/planning-clerk/overview', canRead, async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(`
        WITH permits AS (
          SELECT
            count(*) FILTER (WHERE received_at = current_date)                 AS received_today,
            count(*) FILTER (WHERE received_at >= date_trunc('week', now())::date) AS received_this_week,
            count(*) FILTER (WHERE status IN ('pending_payment','registered','acknowledged')
                               AND fee_paid_at IS NULL)                        AS unpaid,
            count(*) FILTER (WHERE status IN ('circulation','objection_period')) AS in_notice,
            count(*) FILTER (WHERE status IN ('approved','approved_with_conditions')) AS approved,
            count(*) FILTER (WHERE status = 'refused')                         AS refused,
            count(*)                                                           AS total
          FROM spatial_planning.permit_application
        ),
        ack AS (
          SELECT
            count(*) FILTER (WHERE sent_at IS NULL)                            AS outstanding,
            count(*) FILTER (WHERE sent_at IS NULL AND due_by < now())         AS overdue,
            count(*) FILTER (WHERE determination_due_by IS NOT NULL
                               AND determination_due_by < now() + interval '14 days') AS determination_soon
          FROM spatial_planning.clerk_acknowledgement WHERE voided_at IS NULL
        ),
        ref AS (
          SELECT
            count(*) FILTER (WHERE sent_at IS NULL)                            AS outstanding,
            count(*) FILTER (WHERE sent_at IS NULL AND due_by < now())         AS overdue
          FROM spatial_planning.clerk_refusal WHERE voided_at IS NULL
        ),
        mv AS (
          SELECT
            count(*) FILTER (WHERE returned_at IS NULL)                        AS files_out,
            count(*) FILTER (WHERE returned_at IS NULL AND due_back_on < current_date) AS files_overdue
          FROM spatial_planning.clerk_file_movement WHERE voided_at IS NULL
        ),
        fees AS (
          SELECT
            COALESCE(sum(amount) FILTER (WHERE currency = 'USD'
              AND paid_at >= date_trunc('day', now())), 0)                     AS today_usd,
            COALESCE(sum(amount) FILTER (WHERE currency = 'ZWG'
              AND paid_at >= date_trunc('day', now())), 0)                     AS today_zwg,
            COALESCE(sum(amount) FILTER (WHERE currency = 'USD'
              AND paid_at >= date_trunc('month', now())), 0)                   AS month_usd,
            COALESCE(sum(amount) FILTER (WHERE currency = 'ZWG'
              AND paid_at >= date_trunc('month', now())), 0)                   AS month_zwg,
            count(*) FILTER (WHERE paid_at >= date_trunc('day', now()))        AS today_count
          FROM spatial_planning.clerk_fee_receipt WHERE voided_at IS NULL
        ),
        corr AS (
          SELECT
            count(*) FILTER (WHERE direction = 'in'
              AND logged_at >= date_trunc('day', now()))                       AS in_today,
            count(*) FILTER (WHERE direction = 'out'
              AND logged_at >= date_trunc('day', now()))                       AS out_today
          FROM spatial_planning.clerk_correspondence WHERE voided_at IS NULL
        ),
        insp AS (
          SELECT count(*) FILTER (WHERE inspected_at >= date_trunc('day', now())) AS today
          FROM spatial_planning.clerk_public_inspection WHERE voided_at IS NULL
        ),
        cert AS (
          SELECT count(*) FILTER (WHERE objection_closes_on IS NOT NULL
                                    AND objection_closes_on >= current_date) AS objection_windows_open
          FROM spatial_planning.clerk_notice_certificate WHERE voided_at IS NULL
        )
        SELECT to_jsonb(permits) AS permits, to_jsonb(ack) AS acknowledgements,
               to_jsonb(ref) AS refusals, to_jsonb(mv) AS movements,
               to_jsonb(fees) AS fees, to_jsonb(corr) AS correspondence,
               to_jsonb(insp) AS inspections, to_jsonb(cert) AS certificates
        FROM permits, ack, ref, mv, fees, corr, insp, cert`)

      const recent = await fastify.pg.query(`
        SELECT ${PERMIT_SUMMARY}
        FROM spatial_planning.permit_application p
        WHERE p.received_at = current_date
        ORDER BY p.created_at DESC LIMIT 8`)

      return reply.send({
        success: true,
        data: { ...rows[0], received_today_list: recent.rows, as_of: new Date().toISOString() },
      })
    } catch (err) {
      request.log.error({ err }, 'planning clerk overview failed')
      return reply.code(500).send({ success: false, error: 'overview_failed' })
    }
  })

  // ═════════════════════════════════════════════════════════════════════
  // DEADLINES — every statutory clock the clerk is answerable for
  // ═════════════════════════════════════════════════════════════════════
  // Four different rules, four different tables, one list. Scattering them
  // across the sections that happen to own each table is how a five-day
  // acknowledgement is missed while the clerk is working the refusal queue.
  //
  // `days_left` is computed here, from the database's clock. A browser with
  // a wrong date would otherwise show a deadline as met when it is not.
  fastify.get('/planning-clerk/deadlines', canRead, async (request, reply) => {
    const horizon = Math.min(180, Math.max(1, Number(request.query?.days) || 30))
    try {
      const { rows } = await fastify.pg.query(`
        SELECT * FROM (
          SELECT 'acknowledgement' AS kind, a.id, a.permit_application_id,
                 a.letter_no AS reference, a.recipient AS party,
                 a.due_by AS due_at, a.sent_at AS satisfied_at,
                 p.tpd_reference, p.stand_number, p.applicant_name,
                 'Acknowledge within 5 working days of receipt' AS rule
          FROM spatial_planning.clerk_acknowledgement a
          LEFT JOIN spatial_planning.permit_application p ON p.id = a.permit_application_id
          WHERE a.voided_at IS NULL AND a.sent_at IS NULL

          UNION ALL
          -- The determination clock is read from the permit, not from the
          -- clerk's copy of it in the acknowledgement letter: the planner's
          -- clock machinery (clock_state, clock_paused_days) maintains
          -- statutory_due_date, and two sources would drift the moment the
          -- clock was paused for further information.
          SELECT 'determination', p.id, p.id,
                 p.tpd_reference, p.applicant_name,
                 p.statutory_due_date::timestamptz, NULL::timestamptz,
                 p.tpd_reference, p.stand_number, p.applicant_name,
                 'Determine within 3 months or the application is deemed refused'
          FROM spatial_planning.permit_application p
          WHERE p.statutory_due_date IS NOT NULL
            AND COALESCE(p.clock_state, 'running') = 'running'
            AND p.status NOT IN ('approved','approved_with_conditions','refused','withdrawn')

          UNION ALL
          SELECT 'refusal', r.id, r.permit_application_id,
                 r.letter_no, r.recipient, r.due_by, r.sent_at,
                 p.tpd_reference, p.stand_number, p.applicant_name,
                 'Serve the refusal within 7 days of the Council resolution'
          FROM spatial_planning.clerk_refusal r
          LEFT JOIN spatial_planning.permit_application p ON p.id = r.permit_application_id
          WHERE r.voided_at IS NULL AND r.sent_at IS NULL

          UNION ALL
          SELECT 'objection_window', c.id, c.permit_application_id,
                 c.filed_under_ref, c.newspaper_name,
                 c.objection_closes_on::timestamptz, NULL::timestamptz,
                 p.tpd_reference, p.stand_number, p.applicant_name,
                 'Objection period closes'
          FROM spatial_planning.clerk_notice_certificate c
          LEFT JOIN spatial_planning.permit_application p ON p.id = c.permit_application_id
          WHERE c.voided_at IS NULL AND c.objection_closes_on IS NOT NULL

          UNION ALL
          SELECT 'file_return', m.id, m.permit_application_id,
                 m.holder_name, m.purpose,
                 m.due_back_on::timestamptz, m.returned_at,
                 p.tpd_reference, p.stand_number, p.applicant_name,
                 'Physical file due back in registry'
          FROM spatial_planning.clerk_file_movement m
          LEFT JOIN spatial_planning.permit_application p ON p.id = m.permit_application_id
          WHERE m.voided_at IS NULL AND m.returned_at IS NULL
        ) d
        WHERE d.due_at IS NOT NULL AND d.due_at <= now() + ($1 || ' days')::interval
        ORDER BY d.due_at ASC
        LIMIT 500`, [String(horizon)])

      const now = Date.now()
      return reply.send({
        success: true,
        data: rows.map((r) => ({
          ...r,
          days_left: Math.floor((new Date(r.due_at).getTime() - now) / 86_400_000),
          overdue: new Date(r.due_at).getTime() < now,
        })),
        meta: { horizon_days: horizon, as_of: new Date().toISOString() },
      })
    } catch (err) {
      request.log.error({ err }, 'planning clerk deadlines failed')
      return reply.code(500).send({ success: false, error: 'deadlines_failed' })
    }
  })

  // ═════════════════════════════════════════════════════════════════════
  // SEARCH — the counter lookup
  // ═════════════════════════════════════════════════════════════════════
  // Someone is at the desk asking about their file. They have one of: the
  // TPD reference, the register number, the stand number, or their own name.
  // This takes any of them.
  fastify.get('/planning-clerk/search', canRead, async (request, reply) => {
    const q = typeof request.query?.q === 'string' ? request.query.q.trim() : ''
    if (q.length < 2) {
      return reply.send({ success: true, data: [], meta: { query: q, reason: 'too_short' } })
    }
    const { limit } = pageArgs(request.query, { defaultLimit: 25, maxLimit: 100 })
    try {
      const { rows } = await fastify.pg.query(`
        SELECT ${PERMIT_SUMMARY},
               (SELECT m.holder_name FROM spatial_planning.clerk_file_movement m
                 WHERE m.permit_application_id = p.id AND m.returned_at IS NULL
                   AND m.voided_at IS NULL
                 ORDER BY m.issued_at DESC LIMIT 1)                     AS file_held_by,
               EXISTS (SELECT 1 FROM spatial_planning.clerk_acknowledgement a
                        WHERE a.permit_application_id = p.id AND a.voided_at IS NULL
                          AND a.sent_at IS NOT NULL)                    AS acknowledged
        FROM spatial_planning.permit_application p
        WHERE p.tpd_reference ILIKE $1 OR p.dev_register_no ILIKE $1
           OR p.stand_number ILIKE $1 OR p.applicant_name ILIKE $1
           OR p.suburb_ward ILIKE $1 OR p.street_address ILIKE $1
        ORDER BY
          -- An exact reference match is the file they asked for; everything
          -- else is a guess and belongs underneath it.
          (p.tpd_reference ILIKE $2 OR p.dev_register_no ILIKE $2
            OR p.stand_number ILIKE $2) DESC,
          p.created_at DESC
        LIMIT $3`, [`%${q}%`, q, limit])
      return reply.send({ success: true, data: rows, meta: { query: q } })
    } catch (err) {
      request.log.error({ err }, 'planning clerk search failed')
      return reply.code(500).send({ success: false, error: 'search_failed' })
    }
  })

  // ═════════════════════════════════════════════════════════════════════
  // ONE FILE — everything the clerk holds for it
  // ═════════════════════════════════════════════════════════════════════
  // Nine parallel reads rather than nine round trips. The clerk opens this
  // with a member of the public standing at the counter.
  fastify.get('/planning-clerk/file/:permitId', canRead, async (request, reply) => {
    const { permitId } = request.params
    if (!isUuid(permitId)) {
      return reply.code(400).send({ success: false, error: 'bad_id' })
    }
    try {
      const permit = await fastify.pg.query(
        `SELECT ${PERMIT_SUMMARY}, p.street_address, p.stand_area_sqm, p.description,
                p.applicant_email, p.applicant_phone, p.decision_at, p.decision_conditions, p.statutory_due_date,
                p.clock_state, p.updated_at
         FROM spatial_planning.permit_application p WHERE p.id = $1`, [permitId])
      if (!permit.rowCount) {
        return reply.code(404).send({ success: false, error: 'not_found' })
      }

      const entries = await Promise.all(REGISTER_KEYS.map(async (key) => {
        const reg = REGISTERS[key]
        const { rows } = await fastify.pg.query(
          `SELECT r.* FROM spatial_planning.${reg.table} r
           WHERE r.permit_application_id = $1
           ORDER BY r.${reg.dateColumn} DESC LIMIT 200`, [permitId])
        return [key, rows]
      }))

      return reply.send({
        success: true,
        data: { permit: permit.rows[0], registers: Object.fromEntries(entries) },
      })
    } catch (err) {
      request.log.error({ err }, 'planning clerk file read failed')
      return reply.code(500).send({ success: false, error: 'file_failed' })
    }
  })

  // ═════════════════════════════════════════════════════════════════════
  // REGISTERS — list, export, create, correct, void
  // ═════════════════════════════════════════════════════════════════════

  /** The registers and their field definitions, so the client validates the same rules. */
  fastify.get('/planning-clerk/registers', canRead, async (_request, reply) => reply.send({
    success: true,
    data: REGISTER_KEYS.map((key) => ({
      key,
      label: REGISTERS[key].label,
      date_column: REGISTERS[key].dateColumn,
      searchable: REGISTERS[key].search,
      fields: Object.fromEntries(Object.entries(REGISTERS[key].fields).map(([n, s]) => [
        n, { required: !!s.req, fixed: !!s.fixed, nullable: !!s.nullable },
      ])),
    })),
  }))

  fastify.get('/planning-clerk/registers/:register', canRead, async (request, reply) => {
    const register = pick(request, reply)
    if (!register) return undefined
    const { limit, offset } = pageArgs(request.query)
    const where = listWhere(register, request.query)
    try {
      const { rows } = await fastify.pg.query(
        `SELECT r.*, p.tpd_reference, p.dev_register_no, p.stand_number,
                p.applicant_name, p.status AS permit_status,
                count(*) OVER() AS total_count
         FROM spatial_planning.${register.table} r
         LEFT JOIN spatial_planning.permit_application p ON p.id = r.permit_application_id
         ${where.sql}
         ORDER BY r.${register.dateColumn} DESC, r.created_at DESC
         LIMIT $${where.params.length + 1} OFFSET $${where.params.length + 2}`,
        [...where.params, limit, offset])

      const total = rows.length ? Number(rows[0].total_count) : 0
      return reply.send({
        success: true,
        data: rows.map(({ total_count, ...r }) => r),
        meta: { total, limit, offset, register: request.params.register },
      })
    } catch (err) {
      request.log.error({ err }, 'planning clerk register list failed')
      return reply.code(500).send({ success: false, error: 'list_failed' })
    }
  })

  fastify.get('/planning-clerk/registers/:register/export', canRead, async (request, reply) => {
    const register = pick(request, reply)
    if (!register) return undefined
    const where = listWhere(register, request.query)
    try {
      const { rows } = await fastify.pg.query(
        `SELECT r.*, p.tpd_reference, p.stand_number, p.applicant_name
         FROM spatial_planning.${register.table} r
         LEFT JOIN spatial_planning.permit_application p ON p.id = r.permit_application_id
         ${where.sql}
         ORDER BY r.${register.dateColumn} DESC
         LIMIT 20000`, where.params)

      const columns = rows.length ? Object.keys(rows[0]) : ['id']
      const stamp = new Date().toISOString().slice(0, 10)
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition',
          `attachment; filename="${request.params.register}-${stamp}.csv"`)
        .send(toCsv(rows, columns))
    } catch (err) {
      request.log.error({ err }, 'planning clerk register export failed')
      return reply.code(500).send({ success: false, error: 'export_failed' })
    }
  })

  fastify.post('/planning-clerk/registers/:register', canWrite, async (request, reply) => {
    const register = pick(request, reply)
    if (!register) return undefined

    const bound = bind(register, request.body, 'create')
    if (bound.errors) {
      return reply.code(400).send({ success: false, error: 'invalid', fields: bound.errors })
    }

    const columns = [...bound.columns, register.actorIdColumn, register.actorNameColumn]
    const values = [...bound.values, request.user.id, actorName(request.user)]
    const placeholders = values.map((_, i) => `$${i + 1}`)

    try {
      const { rows } = await fastify.pg.query(
        `INSERT INTO spatial_planning.${register.table} (${columns.join(', ')})
         VALUES (${placeholders.join(', ')}) RETURNING *`, values)
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      const handled = dbError(reply, err)
      if (handled) return handled
      request.log.error({ err }, 'planning clerk register create failed')
      return reply.code(500).send({ success: false, error: 'create_failed' })
    }
  })

  fastify.patch('/planning-clerk/registers/:register/:id', canWrite, async (request, reply) => {
    const register = pick(request, reply)
    if (!register) return undefined
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })

    const bound = bind(register, request.body, 'patch')
    if (bound.errors) {
      return reply.code(400).send({ success: false, error: 'invalid', fields: bound.errors })
    }
    if (!bound.columns.length) {
      return reply.code(400).send({ success: false, error: 'nothing_to_change' })
    }

    const sets = bound.columns.map((c, i) => `${c} = $${i + 2}`)
    try {
      const { rows } = await fastify.pg.query(
        `UPDATE spatial_planning.${register.table}
         SET ${sets.join(', ')}
         WHERE id = $1 AND voided_at IS NULL
         RETURNING *`, [id, ...bound.values])
      if (!rows.length) {
        // Either it is not there, or it is voided — and a voided entry is
        // deliberately not correctable, because correcting one would be a
        // way to bring a struck-through entry back without saying so.
        return reply.code(404).send({
          success: false,
          error: 'not_found',
          message: 'No live entry with that identifier. A voided entry cannot be corrected.',
        })
      }
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      const handled = dbError(reply, err)
      if (handled) return handled
      request.log.error({ err }, 'planning clerk register patch failed')
      return reply.code(500).send({ success: false, error: 'update_failed' })
    }
  })

  fastify.post('/planning-clerk/registers/:register/:id/void', canWrite, async (request, reply) => {
    const register = pick(request, reply)
    if (!register) return undefined
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })

    const reasonCheck = T.str(1000)(request.body?.reason ?? '')
    if (!reasonCheck.ok) {
      return reply.code(400).send({
        success: false,
        error: 'invalid',
        fields: { reason: 'A void needs a reason — it stays in the register beside the entry.' },
      })
    }

    try {
      const { rows } = await fastify.pg.query(
        `UPDATE spatial_planning.${register.table}
         SET voided_at = now(),
             voided_reason = $2
         WHERE id = $1 AND voided_at IS NULL
         RETURNING *`,
        [id, `${reasonCheck.value} — voided by ${actorName(request.user)}`])
      if (!rows.length) {
        return reply.code(404).send({ success: false, error: 'not_found' })
      }
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      const handled = dbError(reply, err)
      if (handled) return handled
      request.log.error({ err }, 'planning clerk register void failed')
      return reply.code(500).send({ success: false, error: 'void_failed' })
    }
  })
}

module.exports = { planningClerkRoutes, REGISTERS }
