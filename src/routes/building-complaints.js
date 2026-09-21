// src/routes/building-complaints.js
// ─────────────────────────────────────────────────────────────────────────
// Public reports of unauthorised or dangerous building work.
//
//   POST  /building-complaints              record a report (counter or phone)
//   GET   /building-complaints              the register, filtered
//   GET   /building-complaints/:id          one report
//   PATCH /building-complaints/:id/triage   severity, assignment, permit match
//   POST  /building-complaints/:id/finding  what was found on site
//   POST  /building-complaints/:id/close    close without a site finding
//
// Staff-only. A complaint names a member of the public who has informed on a
// neighbour, and in a small district that is not a neutral fact — see the
// anonymity constraint in migration 120.
//
// Table: spatial_planning.building_complaint (migration 120).
// ─────────────────────────────────────────────────────────────────────────

const { requireRole } = require('../middleware/jwtAuth')

// Anyone at the counter can take a report; a clerk should never have to find an
// inspector before writing down that a wall is falling into the road.
const INTAKE_ROLES = [
  'admin', 'planner', 'planning_clerk', 'building_inspector', 'eo', 'env_officer',
  // Citizens may lodge a report themselves — same table, same triage queue.
  'registered', 'public', 'viewer',
]
const READ_ROLES = [
  'admin', 'planner', 'planning_clerk', 'building_inspector', 'eo', 'env_officer',
  'surveyor', 'gis_officer',
]
// The finding is the inspector's professional judgement and is theirs to record.
const INSPECT_ROLES = ['building_inspector', 'admin']
const TRIAGE_ROLES = ['building_inspector', 'planner', 'planning_clerk', 'admin']

const CATEGORIES = [
  'building_without_permit', 'deviation_from_plan', 'dangerous_structure',
  'building_line_encroachment', 'unsafe_site', 'occupation_without_certificate', 'other',
]
const SEVERITIES = ['routine', 'urgent', 'emergency']
const STATUSES = ['received', 'assigned', 'inspected', 'substantiated', 'unsubstantiated', 'closed']

const isUuid = (v) =>
  typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)

const isStr = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max

/** Trimmed string, or null for absent. Never an empty string in the column. */
const orNull = (v, max) => (isStr(v, max) ? v.trim() : null)

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
  if (lng === 0 && lat === 0) return undefined     // a null-island default, never a real fix
  return { lng, lat }
}

function complaintDto(r) {
  const num = (v) => (v == null ? null : Number(v))
  return {
    id: r.id,
    reference: r.reference,
    category: r.category,
    severity: r.severity,
    status: r.status,
    description: r.description,
    stand_number: r.stand_number,
    suburb_ward: r.suburb_ward,
    location_note: r.location_note,
    observed_lat: num(r.observed_lat),
    observed_lng: num(r.observed_lng),
    anonymous: r.anonymous,
    // An anonymous report never leaks contact details, whatever a future
    // caller asks for. The schema forbids storing them; this forbids
    // returning anything that later slips past it.
    reporter_name: r.anonymous ? null : r.reporter_name,
    reporter_phone: r.anonymous ? null : r.reporter_phone,
    permit_app_id: r.permit_app_id,
    received_at: r.received_at,
    received_by_name: r.received_by_name ?? null,
    assigned_to: r.assigned_to,
    assigned_to_name: r.assigned_to_name ?? null,
    inspected_at: r.inspected_at,
    inspected_by_name: r.inspected_by_name ?? null,
    finding: r.finding,
    closed_at: r.closed_at,
    updated_at: r.updated_at,
  }
}

const SELECT_COMPLAINT = `
  SELECT c.*,
         rb.full_name AS received_by_name,
         ab.full_name AS assigned_to_name,
         ib.full_name AS inspected_by_name
    FROM spatial_planning.building_complaint c
    LEFT JOIN public.users rb ON rb.id = c.received_by
    LEFT JOIN public.users ab ON ab.id = c.assigned_to
    LEFT JOIN public.users ib ON ib.id = c.inspected_by
`

async function buildingComplaintRoutes(fastify) {
  const pg = fastify.pg

  /** BC-2026-0007. The year is the year of receipt; the counter never resets. */
  async function nextReference(client) {
    const { rows } = await client.query(
      `SELECT nextval('spatial_planning.building_complaint_seq') AS n`,
    )
    return `BC-${new Date().getFullYear()}-${String(rows[0].n).padStart(4, '0')}`
  }

  // ── intake ──────────────────────────────────────────────────────────
  fastify.post('/building-complaints', {
    preHandler: requireRole(fastify, INTAKE_ROLES),
  }, async (request, reply) => {
    const b = request.body || {}

    if (!isStr(b.description, 4000)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'description' })
    }
    if (!CATEGORIES.includes(b.category)) {
      return reply.code(400).send({ success: false, error: 'bad_category' })
    }
    const severity = b.severity === undefined ? 'routine' : b.severity
    if (!SEVERITIES.includes(severity)) {
      return reply.code(400).send({ success: false, error: 'bad_severity' })
    }

    const pos = readLngLat(b.observed_lng, b.observed_lat)
    if (pos === undefined) {
      return reply.code(400).send({ success: false, error: 'bad_position' })
    }

    // Somewhere must be identifiable, or nobody can be sent to look. A stand
    // number, a ward, or written directions — any one of the three.
    const stand = orNull(b.stand_number, 40)
    const ward = orNull(b.suburb_ward, 120)
    const note = orNull(b.location_note, 2000)
    if (!stand && !ward && !note && !pos) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'location' })
    }

    const anonymous = b.anonymous === true
    // Honour the promise at the door, not later: an anonymous report simply
    // never carries the details, whatever the form sent.
    const reporterName = anonymous ? null : orNull(b.reporter_name, 160)
    const reporterPhone = anonymous ? null : orNull(b.reporter_phone, 40)

    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const reference = await nextReference(client)
      const { rows } = await client.query(
        `INSERT INTO spatial_planning.building_complaint
           (reference, category, severity, description, stand_number, suburb_ward,
            location_note, observed_lat, observed_lng, reporter_name, reporter_phone,
            anonymous, permit_app_id, received_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          reference, b.category, severity, b.description.trim(), stand, ward, note,
          pos ? pos.lat : null, pos ? pos.lng : null,
          reporterName, reporterPhone, anonymous,
          isUuid(b.permit_app_id) ? b.permit_app_id : null,
          request.user.id,
        ],
      )
      await client.query('COMMIT')
      return reply.code(201).send({ success: true, data: complaintDto(rows[0]) })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      request.log.error({ err }, 'create building complaint failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    } finally {
      client.release()
    }
  })

  // ── register ────────────────────────────────────────────────────────
  fastify.get('/building-complaints', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const q = request.query || {}
    const status = STATUSES.includes(q.status) ? q.status : null
    const category = CATEGORIES.includes(q.category) ? q.category : null
    const severity = SEVERITIES.includes(q.severity) ? q.severity : null
    // `open` is the inspector's default view: everything not yet disposed of.
    const openOnly = q.open === 'true' || q.open === true
    const search = isStr(q.search, 120) ? q.search.trim() : null
    const limit = Math.min(Number(q.limit) || 50, 200)
    const offset = Math.max(Number(q.offset) || 0, 0)

    try {
      const { rows } = await pg.query(
        `${SELECT_COMPLAINT}
          WHERE ($1::text IS NULL OR c.status = $1)
            AND ($2::text IS NULL OR c.category = $2)
            AND ($3::text IS NULL OR c.severity = $3)
            AND ($4::boolean IS NOT TRUE OR c.status NOT IN ('closed','unsubstantiated'))
            AND ($5::text IS NULL OR (
                  c.reference ILIKE '%' || $5 || '%'
               OR c.stand_number ILIKE '%' || $5 || '%'
               OR c.suburb_ward ILIKE '%' || $5 || '%'
               OR c.description ILIKE '%' || $5 || '%'))
          ORDER BY
            -- Worst first, then oldest: an emergency reported yesterday
            -- outranks a routine report taken this morning.
            CASE c.severity WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
            c.received_at ASC
          LIMIT $6 OFFSET $7`,
        [status, category, severity, openOnly, search, limit, offset],
      )
      const { rows: counts } = await pg.query(
        `SELECT status, severity, COUNT(*)::int AS n
           FROM spatial_planning.building_complaint
          GROUP BY status, severity`,
      )
      return reply.send({
        success: true,
        data: rows.map(complaintDto),
        summary: {
          open: counts.filter(c => !['closed', 'unsubstantiated'].includes(c.status))
            .reduce((n, c) => n + c.n, 0),
          emergency: counts.filter(c => c.severity === 'emergency'
            && !['closed', 'unsubstantiated'].includes(c.status))
            .reduce((n, c) => n + c.n, 0),
          awaiting_visit: counts.filter(c => ['received', 'assigned'].includes(c.status))
            .reduce((n, c) => n + c.n, 0),
          total: counts.reduce((n, c) => n + c.n, 0),
        },
      })
    } catch (err) {
      request.log.error({ err }, 'list building complaints failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/building-complaints/:id', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    try {
      const { rows } = await pg.query(`${SELECT_COMPLAINT} WHERE c.id = $1`, [request.params.id])
      if (!rows.length) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: complaintDto(rows[0]) })
    } catch (err) {
      request.log.error({ err }, 'get building complaint failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── triage ──────────────────────────────────────────────────────────
  // Severity, who is going, and which permit on the register this is about.
  // Deliberately cannot set a finding or close the case — those are the two
  // acts that need somebody to have actually stood on the site.
  fastify.patch('/building-complaints/:id/triage', {
    preHandler: requireRole(fastify, TRIAGE_ROLES),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}

    if (b.severity !== undefined && !SEVERITIES.includes(b.severity)) {
      return reply.code(400).send({ success: false, error: 'bad_severity' })
    }
    if (b.assigned_to !== undefined && b.assigned_to !== null && !isUuid(b.assigned_to)) {
      return reply.code(400).send({ success: false, error: 'bad_assignee' })
    }
    if (b.permit_app_id !== undefined && b.permit_app_id !== null && !isUuid(b.permit_app_id)) {
      return reply.code(400).send({ success: false, error: 'bad_permit' })
    }

    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.building_complaint
            SET severity      = COALESCE($2, severity),
                assigned_to   = CASE WHEN $3::boolean THEN $4::uuid ELSE assigned_to END,
                permit_app_id = CASE WHEN $5::boolean THEN $6::uuid ELSE permit_app_id END,
                stand_number  = COALESCE($7, stand_number),
                -- Assigning someone moves a received report forward; nothing
                -- else about triage changes a status that is already past it.
                status        = CASE WHEN $3::boolean AND $4::uuid IS NOT NULL AND status = 'received'
                                     THEN 'assigned' ELSE status END,
                updated_at    = NOW()
          WHERE id = $1
          RETURNING id`,
        [
          request.params.id,
          b.severity ?? null,
          b.assigned_to !== undefined, b.assigned_to ?? null,
          b.permit_app_id !== undefined, b.permit_app_id ?? null,
          orNull(b.stand_number, 40),
        ],
      )
      if (!rows.length) return reply.code(404).send({ success: false, error: 'not_found' })
      const { rows: full } = await pg.query(`${SELECT_COMPLAINT} WHERE c.id = $1`, [request.params.id])
      return reply.send({ success: true, data: complaintDto(full[0]) })
    } catch (err) {
      if (err.code === '23503') return reply.code(400).send({ success: false, error: 'unknown_reference' })
      request.log.error({ err }, 'triage building complaint failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── finding ─────────────────────────────────────────────────────────
  fastify.post('/building-complaints/:id/finding', {
    preHandler: requireRole(fastify, INSPECT_ROLES),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}

    // Substantiated or not is the whole point of the visit, so it is required
    // and has no default — a defaulted verdict is a verdict nobody reached.
    if (b.outcome !== 'substantiated' && b.outcome !== 'unsubstantiated') {
      return reply.code(400).send({ success: false, error: 'bad_outcome' })
    }
    if (!isStr(b.finding, 4000)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'finding' })
    }

    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.building_complaint
            SET status       = $2,
                finding      = $3,
                inspected_at = COALESCE(inspected_at, NOW()),
                inspected_by = COALESCE(inspected_by, $4),
                updated_at   = NOW()
          WHERE id = $1
            -- A closed complaint is a closed record. Reopening is a separate
            -- act nobody has asked for; silently rewriting one is not.
            AND status <> 'closed'
          RETURNING id`,
        [request.params.id, b.outcome, b.finding.trim(), request.user.id],
      )
      if (!rows.length) return reply.code(409).send({ success: false, error: 'not_found_or_closed' })
      const { rows: full } = await pg.query(`${SELECT_COMPLAINT} WHERE c.id = $1`, [request.params.id])
      return reply.send({ success: true, data: complaintDto(full[0]) })
    } catch (err) {
      request.log.error({ err }, 'record complaint finding failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── close ───────────────────────────────────────────────────────────
  fastify.post('/building-complaints/:id/close', {
    preHandler: requireRole(fastify, INSPECT_ROLES),
  }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const note = orNull((request.body || {}).note, 4000)
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.building_complaint
            SET status     = 'closed',
                finding    = COALESCE(finding, $2),
                closed_at  = NOW(),
                closed_by  = $3,
                updated_at = NOW()
          WHERE id = $1 AND status <> 'closed'
          RETURNING id`,
        [request.params.id, note, request.user.id],
      )
      if (!rows.length) return reply.code(409).send({ success: false, error: 'not_found_or_closed' })
      const { rows: full } = await pg.query(`${SELECT_COMPLAINT} WHERE c.id = $1`, [request.params.id])
      return reply.send({ success: true, data: complaintDto(full[0]) })
    } catch (err) {
      request.log.error({ err }, 'close building complaint failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

module.exports = { buildingComplaintRoutes }
