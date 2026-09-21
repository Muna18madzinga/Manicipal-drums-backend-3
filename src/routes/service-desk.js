// src/routes/service-desk.js
// ─────────────────────────────────────────────────────────────────────────
// Citizen service-desk tickets — intake for catalogue counters that do not
// yet have a dedicated register (rates, trading licence request, nuisance,
// road works, social welfare, survey). Ticket only; no licence issuance.
//
//   POST /service-desk/tickets       any authenticated user
//   GET  /service-desk/tickets       staff roles
//   GET  /service-desk/tickets/mine  current user
//
// Table: council_ops.service_desk_ticket (migration 125).
// ─────────────────────────────────────────────────────────────────────────

const { requireAuth, requireRole } = require('../middleware/jwtAuth')

const STAFF_ROLES = [
  'planning_clerk', 'env_officer', 'admin', 'planner',
  'gis_officer', 'building_inspector', 'surveyor',
]

const SERVICE_IDS = new Set([
  'rates-enquiry',
  'trading-licence',
  'nuisance',
  'road-works',
  'social-welfare',
  'survey-request',
])

const STATUSES = new Set(['open', 'in_progress', 'closed', 'referred'])

const isStr = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max
const orNull = (v, max) => (isStr(v, max) ? v.trim() : null)

function ticketDto(r) {
  return {
    id: r.id,
    service_id: r.service_id,
    department: r.department,
    title: r.title,
    requester_user_id: r.requester_user_id,
    requester_name: r.requester_name,
    contact_phone: r.contact_phone,
    contact_email: r.contact_email,
    location_text: r.location_text,
    details: r.details,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

async function serviceDeskRoutes(fastify) {
  const pg = fastify.pg

  fastify.post('/service-desk/tickets', {
    preHandler: requireAuth(fastify),
  }, async (request, reply) => {
    const b = request.body || {}

    if (!isStr(b.service_id, 80) || !SERVICE_IDS.has(b.service_id.trim())) {
      return reply.code(400).send({ success: false, error: 'bad_service_id' })
    }
    if (!isStr(b.department, 120)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'department' })
    }
    if (!isStr(b.title, 200)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'title' })
    }
    if (!isStr(b.details, 4000)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'details' })
    }

    const requesterName = orNull(b.requester_name, 160)
      || request.user?.full_name
      || request.user?.name
      || null
    const contactPhone = orNull(b.contact_phone, 40)
    const contactEmail = orNull(b.contact_email, 160)
    const locationText = orNull(b.location_text, 500)

    try {
      const { rows } = await pg.query(
        `INSERT INTO council_ops.service_desk_ticket
           (service_id, department, title, requester_user_id, requester_name,
            contact_phone, contact_email, location_text, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          b.service_id.trim(),
          b.department.trim(),
          b.title.trim(),
          request.user.id,
          requesterName,
          contactPhone,
          contactEmail,
          locationText,
          b.details.trim(),
        ],
      )
      return reply.code(201).send({ success: true, data: ticketDto(rows[0]) })
    } catch (err) {
      request.log.error({ err }, 'create service desk ticket failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/service-desk/tickets/mine', {
    preHandler: requireAuth(fastify),
  }, async (request, reply) => {
    try {
      const { rows } = await pg.query(
        `SELECT * FROM council_ops.service_desk_ticket
          WHERE requester_user_id = $1
          ORDER BY created_at DESC
          LIMIT 100`,
        [request.user.id],
      )
      return reply.send({ success: true, data: rows.map(ticketDto) })
    } catch (err) {
      request.log.error({ err }, 'list my service desk tickets failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/service-desk/tickets', {
    preHandler: requireRole(fastify, STAFF_ROLES),
  }, async (request, reply) => {
    const q = request.query || {}
    const status = STATUSES.has(q.status) ? q.status : null
    const serviceId = isStr(q.service_id, 80) ? q.service_id.trim() : null
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500)

    const where = []
    const params = []
    if (status) {
      params.push(status)
      where.push(`status = $${params.length}`)
    }
    if (serviceId) {
      params.push(serviceId)
      where.push(`service_id = $${params.length}`)
    }
    params.push(limit)
    const sql = `
      SELECT * FROM council_ops.service_desk_ticket
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT $${params.length}`

    try {
      const { rows } = await pg.query(sql, params)
      return reply.send({ success: true, data: rows.map(ticketDto) })
    } catch (err) {
      request.log.error({ err }, 'list service desk tickets failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

module.exports = { serviceDeskRoutes }
