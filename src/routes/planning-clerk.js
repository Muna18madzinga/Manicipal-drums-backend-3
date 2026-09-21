/**
 * Planning Clerk registers — correspondence, fees, acknowledgements,
 * dispatches, refusals, notice certificates, abutter notifications.
 * Tables: planning_clerk.* (migration 124). Empty until clerks record work.
 */
const { requireRole } = require('../middleware/jwtAuth')

const WRITE_ROLES = ['planning_clerk', 'admin']
const READ_ROLES = ['planning_clerk', 'admin', 'planner', 'eo', 'gis_officer']

const isUuid = (v) =>
  typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)

const isStr = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max
const orStr = (v, max) => (typeof v === 'string' && v.trim().length <= max ? v.trim() : '')

function isoDate(v) {
  if (v === null || v === undefined || v === '') return null
  if (typeof v !== 'string' || v.length > 40) return undefined
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : v
}

function optionalUuid(v) {
  if (v === null || v === undefined || v === '') return null
  return isUuid(v) ? v : undefined
}

function fail(request, reply, err, what) {
  request.log.error({ err }, `[planning-clerk] ${what} failed`)
  return reply.code(500).send({ success: false, error: 'internal' })
}

const CHANNELS = ['letter', 'email', 'phone', 'in_person', 'fax']
const FEE_KINDS = [
  'application', 'public_notice', 'plan_scrutiny',
  'inspection', 'occupation', 'appeal', 'other',
]
const PAYMENT_METHODS = ['cash', 'ecocash', 'eft', 'cheque', 'card']
const DELIVERY_METHODS = ['collected', 'registered_post', 'courier', 'email']
const ABUTTER_METHODS = ['registered_post', 'courier', 'hand_delivered']

function correspondenceDto(r) {
  return {
    id: r.id,
    direction: r.direction,
    date: r.date,
    permit_application_id: r.permit_application_id,
    ref_no: r.ref_no ?? '',
    party: r.party ?? '',
    subject: r.subject ?? '',
    channel: r.channel,
    attached_doc_ref: r.attached_doc_ref ?? '',
    notes: r.notes ?? '',
  }
}

function feeReceiptDto(r) {
  return {
    id: r.id,
    receipt_no: r.receipt_no,
    fee_kind: r.fee_kind,
    permit_application_id: r.permit_application_id,
    payer_name: r.payer_name ?? '',
    amount_zwl: Number(r.amount_zwl),
    paid_at: r.paid_at,
    payment_method: r.payment_method,
    reference: r.reference ?? '',
    issued_by: r.issued_by ?? '',
    notes: r.notes ?? '',
  }
}

function acknowledgementDto(r) {
  return {
    id: r.id,
    letter_no: r.letter_no,
    permit_application_id: r.permit_application_id,
    application_register_no: r.application_register_no ?? '',
    application_received_at: r.application_received_at,
    due_by: r.due_by,
    sent_at: r.sent_at,
    recipient: r.recipient ?? '',
    notes: r.notes ?? '',
  }
}

function dispatchDto(r) {
  return {
    id: r.id,
    permit_application_id: r.permit_application_id,
    dispatched_at: r.dispatched_at,
    dispatched_by: r.dispatched_by ?? '',
    delivery_method: r.delivery_method,
    recipient: r.recipient ?? '',
    proof_of_delivery_ref: r.proof_of_delivery_ref ?? '',
    notes: r.notes ?? '',
  }
}

function refusalDto(r) {
  return {
    id: r.id,
    letter_no: r.letter_no,
    permit_application_id: r.permit_application_id,
    council_resolution_date: r.council_resolution_date,
    due_by: r.due_by,
    sent_at: r.sent_at,
    recipient: r.recipient ?? '',
    reasons: r.reasons ?? '',
    notes: r.notes ?? '',
  }
}

function noticeCertDto(r) {
  return {
    id: r.id,
    permit_application_id: r.permit_application_id,
    newspaper_name: r.newspaper_name ?? '',
    advert_date: r.advert_date,
    certificate_received_at: r.certificate_received_at,
    filed_under_ref: r.filed_under_ref ?? '',
    notes: r.notes ?? '',
  }
}

function abutterDto(r) {
  return {
    id: r.id,
    permit_application_id: r.permit_application_id,
    abutter_name: r.abutter_name ?? '',
    abutter_address: r.abutter_address ?? '',
    notified_at: r.notified_at,
    method: r.method,
    receipt_ref: r.receipt_ref ?? '',
    notes: r.notes ?? '',
  }
}

async function planningClerkRoutes(fastify) {
  const pg = fastify.pg

  // ── Correspondence ────────────────────────────────────────────────────
  fastify.get('/clerk/correspondence', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const q = request.query || {}
    const permitId = optionalUuid(q.permit_application_id)
    if (permitId === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_permit_id' })
    }
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500)
    try {
      const { rows } = await pg.query(
        `SELECT * FROM planning_clerk.correspondence
          WHERE ($1::uuid IS NULL OR permit_application_id = $1)
          ORDER BY date DESC, created_at DESC
          LIMIT $2`,
        [permitId, limit],
      )
      return reply.send({ success: true, data: rows.map(correspondenceDto) })
    } catch (err) {
      return fail(request, reply, err, 'list correspondence')
    }
  })

  fastify.post('/clerk/correspondence', {
    preHandler: requireRole(fastify, WRITE_ROLES),
  }, async (request, reply) => {
    const b = request.body || {}
    if (b.direction !== 'in' && b.direction !== 'out') {
      return reply.code(400).send({ success: false, error: 'bad_direction' })
    }
    const date = isoDate(b.date)
    if (date === undefined || date === null) {
      return reply.code(400).send({ success: false, error: 'bad_date' })
    }
    if (!CHANNELS.includes(b.channel)) {
      return reply.code(400).send({ success: false, error: 'bad_channel' })
    }
    const permitId = optionalUuid(b.permit_application_id)
    if (permitId === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_permit_id' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO planning_clerk.correspondence
           (direction, date, permit_application_id, ref_no, party, subject,
            channel, attached_doc_ref, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          b.direction, date, permitId,
          orStr(b.ref_no, 120), orStr(b.party, 255), orStr(b.subject, 500),
          b.channel, orStr(b.attached_doc_ref, 255), orStr(b.notes, 4000),
        ],
      )
      return reply.code(201).send({ success: true, data: correspondenceDto(rows[0]) })
    } catch (err) {
      return fail(request, reply, err, 'create correspondence')
    }
  })

  // ── Fee receipts ──────────────────────────────────────────────────────
  fastify.get('/clerk/fee-receipts', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const q = request.query || {}
    const permitId = optionalUuid(q.permit_application_id)
    if (permitId === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_permit_id' })
    }
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500)
    try {
      const { rows } = await pg.query(
        `SELECT * FROM planning_clerk.fee_receipt
          WHERE ($1::uuid IS NULL OR permit_application_id = $1)
          ORDER BY paid_at DESC, created_at DESC
          LIMIT $2`,
        [permitId, limit],
      )
      return reply.send({ success: true, data: rows.map(feeReceiptDto) })
    } catch (err) {
      return fail(request, reply, err, 'list fee receipts')
    }
  })

  fastify.post('/clerk/fee-receipts', {
    preHandler: requireRole(fastify, WRITE_ROLES),
  }, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.receipt_no, 64)) {
      return reply.code(400).send({ success: false, error: 'missing_receipt_no' })
    }
    if (!FEE_KINDS.includes(b.fee_kind)) {
      return reply.code(400).send({ success: false, error: 'bad_fee_kind' })
    }
    if (!PAYMENT_METHODS.includes(b.payment_method)) {
      return reply.code(400).send({ success: false, error: 'bad_payment_method' })
    }
    const paidAt = isoDate(b.paid_at)
    if (paidAt === undefined || paidAt === null) {
      return reply.code(400).send({ success: false, error: 'bad_paid_at' })
    }
    const amount = Number(b.amount_zwl)
    if (!Number.isFinite(amount) || amount < 0) {
      return reply.code(400).send({ success: false, error: 'bad_amount' })
    }
    const permitId = optionalUuid(b.permit_application_id)
    if (permitId === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_permit_id' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO planning_clerk.fee_receipt
           (receipt_no, fee_kind, permit_application_id, payer_name, amount_zwl,
            paid_at, payment_method, reference, issued_by, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          b.receipt_no.trim(), b.fee_kind, permitId,
          orStr(b.payer_name, 255), amount, paidAt, b.payment_method,
          orStr(b.reference, 120), orStr(b.issued_by, 160), orStr(b.notes, 4000),
        ],
      )
      return reply.code(201).send({ success: true, data: feeReceiptDto(rows[0]) })
    } catch (err) {
      if (err && err.code === '23505') {
        return reply.code(409).send({ success: false, error: 'duplicate_receipt_no' })
      }
      return fail(request, reply, err, 'create fee receipt')
    }
  })

  // ── Acknowledgements ──────────────────────────────────────────────────
  fastify.get('/clerk/acknowledgements', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const q = request.query || {}
    const permitId = optionalUuid(q.permit_application_id)
    if (permitId === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_permit_id' })
    }
    const overdue = q.overdue === 'true' || q.overdue === true
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500)
    try {
      const { rows } = await pg.query(
        `SELECT * FROM planning_clerk.acknowledgement_letter
          WHERE ($1::uuid IS NULL OR permit_application_id = $1)
            AND ($2::boolean IS FALSE OR (sent_at IS NULL AND due_by < NOW()))
          ORDER BY due_by ASC, created_at DESC
          LIMIT $3`,
        [permitId, overdue, limit],
      )
      return reply.send({ success: true, data: rows.map(acknowledgementDto) })
    } catch (err) {
      return fail(request, reply, err, 'list acknowledgements')
    }
  })

  fastify.post('/clerk/acknowledgements', {
    preHandler: requireRole(fastify, WRITE_ROLES),
  }, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.letter_no, 64)) {
      return reply.code(400).send({ success: false, error: 'missing_letter_no' })
    }
    if (!isUuid(b.permit_application_id)) {
      return reply.code(400).send({ success: false, error: 'bad_permit_id' })
    }
    const receivedAt = isoDate(b.application_received_at)
    const dueBy = isoDate(b.due_by)
    if (receivedAt === undefined || receivedAt === null) {
      return reply.code(400).send({ success: false, error: 'bad_application_received_at' })
    }
    if (dueBy === undefined || dueBy === null) {
      return reply.code(400).send({ success: false, error: 'bad_due_by' })
    }
    const sentAt = isoDate(b.sent_at)
    if (sentAt === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_sent_at' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO planning_clerk.acknowledgement_letter
           (letter_no, permit_application_id, application_register_no,
            application_received_at, due_by, sent_at, recipient, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          b.letter_no.trim(), b.permit_application_id,
          orStr(b.application_register_no, 120),
          receivedAt, dueBy, sentAt,
          orStr(b.recipient, 255), orStr(b.notes, 4000),
        ],
      )
      return reply.code(201).send({ success: true, data: acknowledgementDto(rows[0]) })
    } catch (err) {
      if (err && err.code === '23505') {
        return reply.code(409).send({ success: false, error: 'duplicate_letter_no' })
      }
      return fail(request, reply, err, 'create acknowledgement')
    }
  })

  fastify.patch('/clerk/acknowledgements/:id/mark-sent', {
    preHandler: requireRole(fastify, WRITE_ROLES),
  }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    try {
      const { rows } = await pg.query(
        `UPDATE planning_clerk.acknowledgement_letter
            SET sent_at = COALESCE(sent_at, NOW()), updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [id],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: acknowledgementDto(rows[0]) })
    } catch (err) {
      return fail(request, reply, err, 'mark acknowledgement sent')
    }
  })

  // ── Permit dispatches ─────────────────────────────────────────────────
  fastify.get('/clerk/dispatches', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const q = request.query || {}
    const permitId = optionalUuid(q.permit_application_id)
    if (permitId === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_permit_id' })
    }
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500)
    try {
      const { rows } = await pg.query(
        `SELECT * FROM planning_clerk.permit_dispatch
          WHERE ($1::uuid IS NULL OR permit_application_id = $1)
          ORDER BY dispatched_at DESC, created_at DESC
          LIMIT $2`,
        [permitId, limit],
      )
      return reply.send({ success: true, data: rows.map(dispatchDto) })
    } catch (err) {
      return fail(request, reply, err, 'list dispatches')
    }
  })

  fastify.post('/clerk/dispatches', {
    preHandler: requireRole(fastify, WRITE_ROLES),
  }, async (request, reply) => {
    const b = request.body || {}
    if (!isUuid(b.permit_application_id)) {
      return reply.code(400).send({ success: false, error: 'bad_permit_id' })
    }
    const dispatchedAt = isoDate(b.dispatched_at)
    if (dispatchedAt === undefined || dispatchedAt === null) {
      return reply.code(400).send({ success: false, error: 'bad_dispatched_at' })
    }
    if (!DELIVERY_METHODS.includes(b.delivery_method)) {
      return reply.code(400).send({ success: false, error: 'bad_delivery_method' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO planning_clerk.permit_dispatch
           (permit_application_id, dispatched_at, dispatched_by, delivery_method,
            recipient, proof_of_delivery_ref, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          b.permit_application_id, dispatchedAt,
          orStr(b.dispatched_by, 160), b.delivery_method,
          orStr(b.recipient, 255), orStr(b.proof_of_delivery_ref, 255),
          orStr(b.notes, 4000),
        ],
      )
      return reply.code(201).send({ success: true, data: dispatchDto(rows[0]) })
    } catch (err) {
      return fail(request, reply, err, 'create dispatch')
    }
  })

  // ── Refusal letters ───────────────────────────────────────────────────
  fastify.get('/clerk/refusals', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const q = request.query || {}
    const permitId = optionalUuid(q.permit_application_id)
    if (permitId === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_permit_id' })
    }
    const overdue = q.overdue === 'true' || q.overdue === true
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500)
    try {
      const { rows } = await pg.query(
        `SELECT * FROM planning_clerk.refusal_letter
          WHERE ($1::uuid IS NULL OR permit_application_id = $1)
            AND ($2::boolean IS FALSE OR (sent_at IS NULL AND due_by < NOW()))
          ORDER BY due_by ASC, created_at DESC
          LIMIT $3`,
        [permitId, overdue, limit],
      )
      return reply.send({ success: true, data: rows.map(refusalDto) })
    } catch (err) {
      return fail(request, reply, err, 'list refusals')
    }
  })

  fastify.post('/clerk/refusals', {
    preHandler: requireRole(fastify, WRITE_ROLES),
  }, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.letter_no, 64)) {
      return reply.code(400).send({ success: false, error: 'missing_letter_no' })
    }
    if (!isUuid(b.permit_application_id)) {
      return reply.code(400).send({ success: false, error: 'bad_permit_id' })
    }
    const resolutionDate = isoDate(b.council_resolution_date)
    const dueBy = isoDate(b.due_by)
    if (resolutionDate === undefined || resolutionDate === null) {
      return reply.code(400).send({ success: false, error: 'bad_council_resolution_date' })
    }
    if (dueBy === undefined || dueBy === null) {
      return reply.code(400).send({ success: false, error: 'bad_due_by' })
    }
    const sentAt = isoDate(b.sent_at)
    if (sentAt === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_sent_at' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO planning_clerk.refusal_letter
           (letter_no, permit_application_id, council_resolution_date, due_by,
            sent_at, recipient, reasons, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          b.letter_no.trim(), b.permit_application_id,
          resolutionDate, dueBy, sentAt,
          orStr(b.recipient, 255), orStr(b.reasons, 4000), orStr(b.notes, 4000),
        ],
      )
      return reply.code(201).send({ success: true, data: refusalDto(rows[0]) })
    } catch (err) {
      if (err && err.code === '23505') {
        return reply.code(409).send({ success: false, error: 'duplicate_letter_no' })
      }
      return fail(request, reply, err, 'create refusal')
    }
  })

  fastify.patch('/clerk/refusals/:id/mark-sent', {
    preHandler: requireRole(fastify, WRITE_ROLES),
  }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    try {
      const { rows } = await pg.query(
        `UPDATE planning_clerk.refusal_letter
            SET sent_at = COALESCE(sent_at, NOW()), updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [id],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: refusalDto(rows[0]) })
    } catch (err) {
      return fail(request, reply, err, 'mark refusal sent')
    }
  })

  // ── Notice certificates ───────────────────────────────────────────────
  fastify.get('/clerk/notice-certificates', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const q = request.query || {}
    const permitId = optionalUuid(q.permit_application_id)
    if (permitId === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_permit_id' })
    }
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500)
    try {
      const { rows } = await pg.query(
        `SELECT * FROM planning_clerk.notice_certificate
          WHERE ($1::uuid IS NULL OR permit_application_id = $1)
          ORDER BY advert_date DESC, created_at DESC
          LIMIT $2`,
        [permitId, limit],
      )
      return reply.send({ success: true, data: rows.map(noticeCertDto) })
    } catch (err) {
      return fail(request, reply, err, 'list notice certificates')
    }
  })

  fastify.post('/clerk/notice-certificates', {
    preHandler: requireRole(fastify, WRITE_ROLES),
  }, async (request, reply) => {
    const b = request.body || {}
    if (!isUuid(b.permit_application_id)) {
      return reply.code(400).send({ success: false, error: 'bad_permit_id' })
    }
    const advertDate = isoDate(b.advert_date)
    const receivedAt = isoDate(b.certificate_received_at)
    if (advertDate === undefined || advertDate === null) {
      return reply.code(400).send({ success: false, error: 'bad_advert_date' })
    }
    if (receivedAt === undefined || receivedAt === null) {
      return reply.code(400).send({ success: false, error: 'bad_certificate_received_at' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO planning_clerk.notice_certificate
           (permit_application_id, newspaper_name, advert_date,
            certificate_received_at, filed_under_ref, notes)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [
          b.permit_application_id, orStr(b.newspaper_name, 255),
          advertDate, receivedAt,
          orStr(b.filed_under_ref, 120), orStr(b.notes, 4000),
        ],
      )
      return reply.code(201).send({ success: true, data: noticeCertDto(rows[0]) })
    } catch (err) {
      return fail(request, reply, err, 'create notice certificate')
    }
  })

  // ── Abutter notifications ─────────────────────────────────────────────
  fastify.get('/clerk/abutter-notifications', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const q = request.query || {}
    const permitId = optionalUuid(q.permit_application_id)
    if (permitId === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_permit_id' })
    }
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500)
    try {
      const { rows } = await pg.query(
        `SELECT * FROM planning_clerk.abutter_notification
          WHERE ($1::uuid IS NULL OR permit_application_id = $1)
          ORDER BY notified_at DESC, created_at DESC
          LIMIT $2`,
        [permitId, limit],
      )
      return reply.send({ success: true, data: rows.map(abutterDto) })
    } catch (err) {
      return fail(request, reply, err, 'list abutter notifications')
    }
  })

  fastify.post('/clerk/abutter-notifications', {
    preHandler: requireRole(fastify, WRITE_ROLES),
  }, async (request, reply) => {
    const b = request.body || {}
    if (!isUuid(b.permit_application_id)) {
      return reply.code(400).send({ success: false, error: 'bad_permit_id' })
    }
    const notifiedAt = isoDate(b.notified_at)
    if (notifiedAt === undefined || notifiedAt === null) {
      return reply.code(400).send({ success: false, error: 'bad_notified_at' })
    }
    if (!ABUTTER_METHODS.includes(b.method)) {
      return reply.code(400).send({ success: false, error: 'bad_method' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO planning_clerk.abutter_notification
           (permit_application_id, abutter_name, abutter_address, notified_at,
            method, receipt_ref, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          b.permit_application_id, orStr(b.abutter_name, 255),
          orStr(b.abutter_address, 500), notifiedAt, b.method,
          orStr(b.receipt_ref, 120), orStr(b.notes, 4000),
        ],
      )
      return reply.code(201).send({ success: true, data: abutterDto(rows[0]) })
    } catch (err) {
      return fail(request, reply, err, 'create abutter notification')
    }
  })
}

module.exports = { planningClerkRoutes }
