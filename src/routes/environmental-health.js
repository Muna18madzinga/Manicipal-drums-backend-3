// src/routes/environmental-health.js
// ─────────────────────────────────────────────────────────────────────────
// The Environmental Health Officer's four registers, and the spatial
// questions an EHO asks of them.
//
//   GET    /eho/premises            POST /eho/premises        PATCH /eho/premises/:id
//   DELETE /eho/premises/:id        (soft)
//   GET    /eho/outbreaks           POST /eho/outbreaks       PATCH /eho/outbreaks/:id
//   GET    /eho/water-samples       POST /eho/water-samples
//   GET    /eho/complaints          POST /eho/complaints      PATCH /eho/complaints/:id
//
//   GET    /eho/map                       all four registers as GeoJSON layers
//   GET    /eho/nearby?lng&lat&radius_m   what the registers hold around a point
//   GET    /eho/outbreaks/:id/catchment   premises + water sources inside a cluster
//
// Tables: spatial_planning.health_* (migration 121).
//
// Staff-only throughout. These records name complainants, locate food premises
// and log disease clusters; none of it is public.
//
// A NOTE ON WHAT THESE ENDPOINTS REFUSE TO DO
// Nothing here decides anything. `/nearby` and `/catchment` report what is
// within a distance — they do not label a borehole unsafe, close a premises or
// declare a cluster contained. Those are the officer's decisions under the
// Public Health Act, and a distance is the evidence for one, not the making
// of it.
// ─────────────────────────────────────────────────────────────────────────

const { requireRole } = require('../middleware/jwtAuth')

// The EHO owns these registers. Admin shares every write for support.
const WRITE_ROLES = ['env_officer', 'admin']
// A planner circulating a permit beside a cholera cluster needs to see it, and
// a building inspector attending the same premises needs its history.
const READ_ROLES = [
  'admin', 'planner', 'planning_clerk', 'building_inspector',
  'eo', 'env_officer', 'surveyor', 'gis_officer',
]

const PREMISES_TYPES = [
  'bakery', 'butchery', 'restaurant', 'tea_room', 'boarding_house',
  'hotel', 'general_dealer', 'bottle_store', 'beerhall', 'creche',
  'school', 'hostel', 'tuck_shop', 'supermarket', 'factory',
  'workshop', 'nightclub', 'lodge', 'abattoir', 'other',
]
const DISEASES = ['cholera', 'typhoid', 'dysentery', 'food_poisoning', 'measles', 'tb', 'covid', 'other']
const OUTBREAK_STATUSES = ['investigating', 'contained', 'closed']
const WATER_RESULTS = ['potable', 'not_potable', 'borderline', 'pending']
const WATER_SOURCE_TYPES = ['borehole', 'piped_supply', 'reservoir', 'well', 'river', 'dam', 'spring', 'other']
const COMPLAINT_CATEGORIES = ['smell', 'smoke', 'noise', 'vermin', 'waste', 'water', 'other']
const COMPLAINT_STATUSES = ['open', 'investigating', 'abated', 'closed']
const POSITION_SOURCES = ['field_gps', 'map_pick', 'stand_register', 'permit_site', 'premises', 'ward_centroid']

// A catchment the officer has not set. 500 m is a starting radius for a
// water-borne cluster, not a standard — it is always overridable per outbreak.
const DEFAULT_CATCHMENT_M = 500
const MAX_RADIUS_M = 20000

const isUuid = (v) =>
  typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)

const isStr = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max
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

const f = (v) => (v == null ? null : Number(v))

/**
 * A position and its provenance, validated together. The schema refuses
 * provenance without a position; this refuses it at the door with a message
 * that says which field was wrong.
 */
function readPosition(b) {
  const pos = readLngLat(b.lng, b.lat)
  if (pos === undefined) return { error: 'bad_position' }
  const source = orNull(b.location_source, 20)
  if (source && !POSITION_SOURCES.includes(source)) return { error: 'bad_location_source' }
  const accuracy = num(b.location_accuracy_m, 0, 100000)
  if (accuracy === undefined) return { error: 'bad_accuracy' }
  if (!pos && (source || accuracy != null)) return { error: 'position_required_for_source' }
  return { pos, source, accuracy }
}

// ── DTOs ────────────────────────────────────────────────────────────────
function premisesDto(r) {
  return {
    id: r.id,
    reference: r.reference,
    name: r.name,
    premises_type: r.premises_type,
    stand_number: r.stand_number,
    suburb_ward: r.suburb_ward,
    operator_name: r.operator_name,
    operator_contact: r.operator_contact,
    permit_app_id: r.permit_app_id,
    fitness_certificate_no: r.fitness_certificate_no,
    fitness_certificate_expiry: r.fitness_certificate_expiry,
    last_inspected_at: r.last_inspected_at,
    notes: r.notes,
    lng: f(r.lng),
    lat: f(r.lat),
    location_source: r.location_source,
    location_accuracy_m: f(r.location_accuracy_m),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

function outbreakDto(r) {
  return {
    id: r.id,
    reference: r.reference,
    disease: r.disease,
    first_reported_at: r.first_reported_at,
    suspected_source: r.suspected_source,
    cases_count: r.cases_count,
    ward: r.ward,
    status: r.status,
    actions_taken: r.actions_taken,
    catchment_m: r.catchment_m,
    lng: f(r.lng),
    lat: f(r.lat),
    location_source: r.location_source,
    location_accuracy_m: f(r.location_accuracy_m),
    reported_by_name: r.reported_by_name ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    closed_at: r.closed_at,
  }
}

function sampleDto(r) {
  return {
    id: r.id,
    reference: r.reference,
    source_label: r.source_label,
    source_type: r.source_type,
    sampled_at: r.sampled_at,
    ecoli_count: r.ecoli_count,
    faecal_coliform: r.faecal_coliform,
    free_chlorine: f(r.free_chlorine),
    ph: f(r.ph),
    result: r.result,
    actions_taken: r.actions_taken,
    lng: f(r.lng),
    lat: f(r.lat),
    location_source: r.location_source,
    location_accuracy_m: f(r.location_accuracy_m),
    sampled_by_name: r.sampled_by_name ?? null,
    created_at: r.created_at,
  }
}

function complaintDto(r) {
  return {
    id: r.id,
    reference: r.reference,
    category: r.category,
    description: r.description,
    status: r.status,
    premises_id: r.premises_id,
    premises_name: r.premises_name ?? null,
    stand_number: r.stand_number,
    suburb_ward: r.suburb_ward,
    location_note: r.location_note,
    anonymous: r.anonymous,
    // The schema forbids storing these against an anonymous report. This
    // forbids returning anything that ever slips past it.
    complainant_name: r.anonymous ? null : r.complainant_name,
    complainant_contact: r.anonymous ? null : r.complainant_contact,
    abatement_notice_ref: r.abatement_notice_ref,
    lng: f(r.lng),
    lat: f(r.lat),
    location_source: r.location_source,
    location_accuracy_m: f(r.location_accuracy_m),
    received_at: r.received_at,
    received_by_name: r.received_by_name ?? null,
    updated_at: r.updated_at,
    closed_at: r.closed_at,
  }
}

// Geometry never leaves as WKB. Every read projects lng/lat so the DTOs and
// the map endpoint agree on one representation.
const XY = (alias) => `ST_X(${alias}.location) AS lng, ST_Y(${alias}.location) AS lat`

function pointSql(lngParam, latParam) {
  return `CASE WHEN ${lngParam}::double precision IS NULL THEN NULL
               ELSE ST_SetSRID(ST_MakePoint(${lngParam}::double precision, ${latParam}::double precision), 4326) END`
}

async function environmentalHealthRoutes(fastify) {
  const pg = fastify.pg

  /** PR-2026-0007. The year is the year of creation; the counter never resets. */
  async function nextReference(client, seq, prefix) {
    const { rows } = await client.query(`SELECT nextval('spatial_planning.${seq}') AS n`)
    return `${prefix}-${new Date().getFullYear()}-${String(rows[0].n).padStart(4, '0')}`
  }

  const fail = (request, reply, err, what) => {
    request.log.error({ err }, `[eho] ${what} failed`)
    return reply.code(500).send({ success: false, error: 'internal' })
  }

  // ══ PREMISES REGISTER ═════════════════════════════════════════════════
  const SELECT_PREMISES = `
    SELECT p.*, ${XY('p')}
      FROM spatial_planning.health_premises p
     WHERE p.deleted_at IS NULL`

  fastify.get('/eho/premises', { preHandler: requireRole(fastify, READ_ROLES) }, async (request, reply) => {
    const q = request.query || {}
    const type = PREMISES_TYPES.includes(q.type) ? q.type : null
    const search = isStr(q.search, 120) ? q.search.trim() : null
    // Premises not inspected in this many days. The Act sets no single
    // interval, so the caller names one rather than the server inventing it.
    const dueDays = int(q.due_days, 1, 3650)
    const limit = Math.min(Number(q.limit) || 200, 500)
    const offset = Math.max(Number(q.offset) || 0, 0)

    try {
      const { rows } = await pg.query(
        `${SELECT_PREMISES}
           AND ($1::text IS NULL OR p.premises_type = $1)
           AND ($2::text IS NULL OR (
                 p.name ILIKE '%' || $2 || '%'
              OR p.reference ILIKE '%' || $2 || '%'
              OR p.stand_number ILIKE '%' || $2 || '%'
              OR p.suburb_ward ILIKE '%' || $2 || '%'))
           AND ($3::int IS NULL OR p.last_inspected_at IS NULL
                OR p.last_inspected_at < NOW() - ($3 || ' days')::interval)
         ORDER BY p.name ASC
         LIMIT $4 OFFSET $5`,
        [type, search, dueDays, limit, offset],
      )
      return reply.send({ success: true, data: rows.map(premisesDto) })
    } catch (err) { return fail(request, reply, err, 'list premises') }
  })

  fastify.post('/eho/premises', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.name, 200)) return reply.code(400).send({ success: false, error: 'missing_field', field: 'name' })
    if (!PREMISES_TYPES.includes(b.premises_type)) {
      return reply.code(400).send({ success: false, error: 'bad_premises_type' })
    }
    const p = readPosition(b)
    if (p.error) return reply.code(400).send({ success: false, error: p.error })

    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const reference = await nextReference(client, 'health_premises_seq', 'PR')
      const { rows } = await client.query(
        `INSERT INTO spatial_planning.health_premises
           (reference, name, premises_type, stand_number, suburb_ward, operator_name,
            operator_contact, permit_app_id, fitness_certificate_no, fitness_certificate_expiry,
            notes, location, location_source, location_accuracy_m, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${pointSql('$12', '$13')},$14,$15,$16)
         RETURNING *, ${XY('health_premises')}`,
        [
          reference, b.name.trim(), b.premises_type, orNull(b.stand_number, 40),
          orNull(b.suburb_ward, 120), orNull(b.operator_name, 160), orNull(b.operator_contact, 40),
          isUuid(b.permit_app_id) ? b.permit_app_id : null,
          orNull(b.fitness_certificate_no, 40), orNull(b.fitness_certificate_expiry, 20),
          orNull(b.notes, 4000),
          p.pos ? p.pos.lng : null, p.pos ? p.pos.lat : null,
          p.source, p.accuracy, request.user.id,
        ],
      )
      await client.query('COMMIT')
      return reply.code(201).send({ success: true, data: premisesDto(rows[0]) })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      return fail(request, reply, err, 'create premises')
    } finally { client.release() }
  })

  fastify.patch('/eho/premises/:id', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (b.premises_type !== undefined && !PREMISES_TYPES.includes(b.premises_type)) {
      return reply.code(400).send({ success: false, error: 'bad_premises_type' })
    }
    const hasPos = b.lng !== undefined || b.lat !== undefined
    const p = hasPos ? readPosition(b) : { pos: null, source: null, accuracy: null }
    if (p.error) return reply.code(400).send({ success: false, error: p.error })
    const inspectedAt = b.last_inspected_at === undefined ? null : orNull(b.last_inspected_at, 40)

    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.health_premises SET
           name                = COALESCE($2, name),
           premises_type       = COALESCE($3, premises_type),
           stand_number        = COALESCE($4, stand_number),
           suburb_ward         = COALESCE($5, suburb_ward),
           operator_name       = COALESCE($6, operator_name),
           operator_contact    = COALESCE($7, operator_contact),
           fitness_certificate_no     = COALESCE($8, fitness_certificate_no),
           fitness_certificate_expiry = COALESCE($9::date, fitness_certificate_expiry),
           notes               = COALESCE($10, notes),
           last_inspected_at   = COALESCE($11::timestamptz, last_inspected_at),
           location            = CASE WHEN $12::boolean THEN ${pointSql('$13', '$14')} ELSE location END,
           location_source     = CASE WHEN $12::boolean THEN $15 ELSE location_source END,
           location_accuracy_m = CASE WHEN $12::boolean THEN $16 ELSE location_accuracy_m END,
           updated_at          = NOW()
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING *, ${XY('health_premises')}`,
        [
          id, orNull(b.name, 200), b.premises_type ?? null, orNull(b.stand_number, 40),
          orNull(b.suburb_ward, 120), orNull(b.operator_name, 160), orNull(b.operator_contact, 40),
          orNull(b.fitness_certificate_no, 40), orNull(b.fitness_certificate_expiry, 20),
          orNull(b.notes, 4000), inspectedAt,
          hasPos, p.pos ? p.pos.lng : null, p.pos ? p.pos.lat : null, p.source, p.accuracy,
        ],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: premisesDto(rows[0]) })
    } catch (err) { return fail(request, reply, err, 'update premises') }
  })

  fastify.delete('/eho/premises/:id', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.health_premises
            SET deleted_at = NOW(), deleted_by = $2, updated_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id`,
        [id, request.user.id],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: { id } })
    } catch (err) { return fail(request, reply, err, 'delete premises') }
  })

  // ══ OUTBREAK LOG ══════════════════════════════════════════════════════
  const SELECT_OUTBREAK = `
    SELECT o.*, ${XY('o')}, u.full_name AS reported_by_name
      FROM spatial_planning.health_outbreak o
      LEFT JOIN public.users u ON u.id = o.reported_by`

  fastify.get('/eho/outbreaks', { preHandler: requireRole(fastify, READ_ROLES) }, async (request, reply) => {
    const q = request.query || {}
    const status = OUTBREAK_STATUSES.includes(q.status) ? q.status : null
    const disease = DISEASES.includes(q.disease) ? q.disease : null
    const openOnly = q.open === 'true' || q.open === true
    try {
      const { rows } = await pg.query(
        `${SELECT_OUTBREAK}
          WHERE ($1::text IS NULL OR o.status = $1)
            AND ($2::text IS NULL OR o.disease = $2)
            AND ($3::boolean IS NOT TRUE OR o.status <> 'closed')
          ORDER BY o.first_reported_at DESC
          LIMIT 500`,
        [status, disease, openOnly],
      )
      return reply.send({ success: true, data: rows.map(outbreakDto) })
    } catch (err) { return fail(request, reply, err, 'list outbreaks') }
  })

  fastify.post('/eho/outbreaks', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const b = request.body || {}
    if (!DISEASES.includes(b.disease)) return reply.code(400).send({ success: false, error: 'bad_disease' })
    if (!isStr(b.suspected_source, 2000)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'suspected_source' })
    }
    if (!isStr(b.ward, 120)) return reply.code(400).send({ success: false, error: 'missing_field', field: 'ward' })
    const cases = b.cases_count === undefined ? 1 : int(b.cases_count, 1, 99999)
    if (cases === undefined) return reply.code(400).send({ success: false, error: 'bad_cases_count' })
    const catchment = b.catchment_m === undefined ? DEFAULT_CATCHMENT_M : int(b.catchment_m, 10, MAX_RADIUS_M)
    if (catchment === undefined) return reply.code(400).send({ success: false, error: 'bad_catchment' })
    const p = readPosition(b)
    if (p.error) return reply.code(400).send({ success: false, error: p.error })

    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const reference = await nextReference(client, 'health_outbreak_seq', 'OB')
      const { rows } = await client.query(
        `INSERT INTO spatial_planning.health_outbreak
           (reference, disease, suspected_source, cases_count, ward, actions_taken,
            catchment_m, location, location_source, location_accuracy_m, reported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,${pointSql('$8', '$9')},$10,$11,$12)
         RETURNING *, ${XY('health_outbreak')}`,
        [
          reference, b.disease, b.suspected_source.trim(), cases, b.ward.trim(),
          orNull(b.actions_taken, 4000), catchment,
          p.pos ? p.pos.lng : null, p.pos ? p.pos.lat : null,
          p.source, p.accuracy, request.user.id,
        ],
      )
      await client.query('COMMIT')
      return reply.code(201).send({ success: true, data: outbreakDto(rows[0]) })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      return fail(request, reply, err, 'create outbreak')
    } finally { client.release() }
  })

  fastify.patch('/eho/outbreaks/:id', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (b.status !== undefined && !OUTBREAK_STATUSES.includes(b.status)) {
      return reply.code(400).send({ success: false, error: 'bad_status' })
    }
    const cases = b.cases_count === undefined ? null : int(b.cases_count, 1, 99999)
    if (cases === undefined) return reply.code(400).send({ success: false, error: 'bad_cases_count' })
    const catchment = b.catchment_m === undefined ? null : int(b.catchment_m, 10, MAX_RADIUS_M)
    if (catchment === undefined) return reply.code(400).send({ success: false, error: 'bad_catchment' })
    const hasPos = b.lng !== undefined || b.lat !== undefined
    const p = hasPos ? readPosition(b) : { pos: null, source: null, accuracy: null }
    if (p.error) return reply.code(400).send({ success: false, error: p.error })

    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.health_outbreak SET
           status          = COALESCE($2, status),
           cases_count     = COALESCE($3, cases_count),
           suspected_source = COALESCE($4, suspected_source),
           actions_taken   = COALESCE($5, actions_taken),
           catchment_m     = COALESCE($6, catchment_m),
           location        = CASE WHEN $7::boolean THEN ${pointSql('$8', '$9')} ELSE location END,
           location_source = CASE WHEN $7::boolean THEN $10 ELSE location_source END,
           location_accuracy_m = CASE WHEN $7::boolean THEN $11 ELSE location_accuracy_m END,
           -- The closing date is set by the transition, never sent by a client:
           -- the schema requires the two to agree and this is where they do.
           closed_at       = CASE WHEN COALESCE($2, status) = 'closed'
                                  THEN COALESCE(closed_at, NOW()) ELSE NULL END,
           closed_by       = CASE WHEN COALESCE($2, status) = 'closed'
                                  THEN COALESCE(closed_by, $12) ELSE NULL END,
           updated_at      = NOW()
         WHERE id = $1
         RETURNING *, ${XY('health_outbreak')}`,
        [
          id, b.status ?? null, cases, orNull(b.suspected_source, 2000),
          orNull(b.actions_taken, 4000), catchment,
          hasPos, p.pos ? p.pos.lng : null, p.pos ? p.pos.lat : null, p.source, p.accuracy,
          request.user.id,
        ],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: outbreakDto(rows[0]) })
    } catch (err) { return fail(request, reply, err, 'update outbreak') }
  })

  // ══ WATER QUALITY ═════════════════════════════════════════════════════
  const SELECT_SAMPLE = `
    SELECT s.*, ${XY('s')}, u.full_name AS sampled_by_name
      FROM spatial_planning.health_water_sample s
      LEFT JOIN public.users u ON u.id = s.sampled_by`

  fastify.get('/eho/water-samples', { preHandler: requireRole(fastify, READ_ROLES) }, async (request, reply) => {
    const q = request.query || {}
    const result = WATER_RESULTS.includes(q.result) ? q.result : null
    const failingOnly = q.failing === 'true' || q.failing === true
    try {
      const { rows } = await pg.query(
        `${SELECT_SAMPLE}
          WHERE ($1::text IS NULL OR s.result = $1)
            AND ($2::boolean IS NOT TRUE OR s.result IN ('not_potable', 'borderline'))
          ORDER BY s.sampled_at DESC
          LIMIT 500`,
        [result, failingOnly],
      )
      return reply.send({ success: true, data: rows.map(sampleDto) })
    } catch (err) { return fail(request, reply, err, 'list water samples') }
  })

  fastify.post('/eho/water-samples', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.source_label, 200)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'source_label' })
    }
    if (b.source_type !== undefined && b.source_type !== null && b.source_type !== ''
        && !WATER_SOURCE_TYPES.includes(b.source_type)) {
      return reply.code(400).send({ success: false, error: 'bad_source_type' })
    }
    const result = b.result === undefined ? 'pending' : b.result
    if (!WATER_RESULTS.includes(result)) return reply.code(400).send({ success: false, error: 'bad_result' })

    const ecoli = int(b.ecoli_count, 0, 1000000)
    const faecal = int(b.faecal_coliform, 0, 1000000)
    const chlorine = num(b.free_chlorine, 0, 999)
    const ph = num(b.ph, 0, 14)
    if ([ecoli, faecal, chlorine, ph].includes(undefined)) {
      return reply.code(400).send({ success: false, error: 'bad_measurement' })
    }
    const p = readPosition(b)
    if (p.error) return reply.code(400).send({ success: false, error: p.error })

    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const reference = await nextReference(client, 'health_water_sample_seq', 'WS')
      const { rows } = await client.query(
        `INSERT INTO spatial_planning.health_water_sample
           (reference, source_label, source_type, ecoli_count, faecal_coliform, free_chlorine,
            ph, result, actions_taken, location, location_source, location_accuracy_m, sampled_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,${pointSql('$10', '$11')},$12,$13,$14)
         RETURNING *, ${XY('health_water_sample')}`,
        [
          reference, b.source_label.trim(), orNull(b.source_type, 20), ecoli, faecal, chlorine,
          ph, result, orNull(b.actions_taken, 4000),
          p.pos ? p.pos.lng : null, p.pos ? p.pos.lat : null,
          p.source, p.accuracy, request.user.id,
        ],
      )
      await client.query('COMMIT')
      return reply.code(201).send({ success: true, data: sampleDto(rows[0]) })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      return fail(request, reply, err, 'create water sample')
    } finally { client.release() }
  })

  // ══ NUISANCE COMPLAINTS ═══════════════════════════════════════════════
  const SELECT_COMPLAINT = `
    SELECT c.*, ${XY('c')}, u.full_name AS received_by_name, p.name AS premises_name
      FROM spatial_planning.health_nuisance_complaint c
      LEFT JOIN public.users u ON u.id = c.received_by
      LEFT JOIN spatial_planning.health_premises p ON p.id = c.premises_id`

  fastify.get('/eho/complaints', { preHandler: requireRole(fastify, READ_ROLES) }, async (request, reply) => {
    const q = request.query || {}
    const status = COMPLAINT_STATUSES.includes(q.status) ? q.status : null
    const category = COMPLAINT_CATEGORIES.includes(q.category) ? q.category : null
    const openOnly = q.open === 'true' || q.open === true
    try {
      const { rows } = await pg.query(
        `${SELECT_COMPLAINT}
          WHERE ($1::text IS NULL OR c.status = $1)
            AND ($2::text IS NULL OR c.category = $2)
            AND ($3::boolean IS NOT TRUE OR c.status NOT IN ('abated', 'closed'))
          ORDER BY c.received_at DESC
          LIMIT 500`,
        [status, category, openOnly],
      )
      return reply.send({ success: true, data: rows.map(complaintDto) })
    } catch (err) { return fail(request, reply, err, 'list complaints') }
  })

  fastify.post('/eho/complaints', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const b = request.body || {}
    if (!COMPLAINT_CATEGORIES.includes(b.category)) {
      return reply.code(400).send({ success: false, error: 'bad_category' })
    }
    if (!isStr(b.description, 4000)) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'description' })
    }
    const p = readPosition(b)
    if (p.error) return reply.code(400).send({ success: false, error: p.error })

    const stand = orNull(b.stand_number, 40)
    const ward = orNull(b.suburb_ward, 120)
    const note = orNull(b.location_note, 2000)
    const premisesId = isUuid(b.premises_id) ? b.premises_id : null
    // Somewhere must be identifiable, or nobody can be sent to look.
    if (!stand && !ward && !note && !p.pos && !premisesId) {
      return reply.code(400).send({ success: false, error: 'missing_field', field: 'location' })
    }

    const anonymous = b.anonymous === true
    const name = anonymous ? null : orNull(b.complainant_name, 160)
    const contact = anonymous ? null : orNull(b.complainant_contact, 40)

    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const reference = await nextReference(client, 'health_nuisance_complaint_seq', 'NC')
      const { rows } = await client.query(
        `INSERT INTO spatial_planning.health_nuisance_complaint
           (reference, category, description, premises_id, stand_number, suburb_ward,
            location_note, complainant_name, complainant_contact, anonymous,
            location, location_source, location_accuracy_m, received_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${pointSql('$11', '$12')},$13,$14,$15)
         RETURNING *, ${XY('health_nuisance_complaint')}`,
        [
          reference, b.category, b.description.trim(), premisesId, stand, ward, note,
          name, contact, anonymous,
          p.pos ? p.pos.lng : null, p.pos ? p.pos.lat : null,
          p.source, p.accuracy, request.user.id,
        ],
      )
      await client.query('COMMIT')
      const { rows: full } = await client.query(`${SELECT_COMPLAINT} WHERE c.id = $1`, [rows[0].id])
      return reply.code(201).send({ success: true, data: complaintDto(full[0] ?? rows[0]) })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      return fail(request, reply, err, 'create complaint')
    } finally { client.release() }
  })

  fastify.patch('/eho/complaints/:id', { preHandler: requireRole(fastify, WRITE_ROLES) }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}
    if (b.status !== undefined && !COMPLAINT_STATUSES.includes(b.status)) {
      return reply.code(400).send({ success: false, error: 'bad_status' })
    }
    const hasPos = b.lng !== undefined || b.lat !== undefined
    const p = hasPos ? readPosition(b) : { pos: null, source: null, accuracy: null }
    if (p.error) return reply.code(400).send({ success: false, error: p.error })

    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.health_nuisance_complaint SET
           status               = COALESCE($2, status),
           abatement_notice_ref = COALESCE($3, abatement_notice_ref),
           description          = COALESCE($4, description),
           premises_id          = COALESCE($5, premises_id),
           location             = CASE WHEN $6::boolean THEN ${pointSql('$7', '$8')} ELSE location END,
           location_source      = CASE WHEN $6::boolean THEN $9 ELSE location_source END,
           location_accuracy_m  = CASE WHEN $6::boolean THEN $10 ELSE location_accuracy_m END,
           closed_at            = CASE WHEN COALESCE($2, status) IN ('abated', 'closed')
                                       THEN COALESCE(closed_at, NOW()) ELSE NULL END,
           closed_by            = CASE WHEN COALESCE($2, status) IN ('abated', 'closed')
                                       THEN COALESCE(closed_by, $11) ELSE NULL END,
           updated_at           = NOW()
         WHERE id = $1
         RETURNING id`,
        [
          id, b.status ?? null, orNull(b.abatement_notice_ref, 40), orNull(b.description, 4000),
          isUuid(b.premises_id) ? b.premises_id : null,
          hasPos, p.pos ? p.pos.lng : null, p.pos ? p.pos.lat : null, p.source, p.accuracy,
          request.user.id,
        ],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      const { rows: full } = await pg.query(`${SELECT_COMPLAINT} WHERE c.id = $1`, [id])
      return reply.send({ success: true, data: complaintDto(full[0]) })
    } catch (err) { return fail(request, reply, err, 'update complaint') }
  })

  // ══ SPATIAL ═══════════════════════════════════════════════════════════

  /**
   * Every positioned register record as GeoJSON, ready for MapLibre.
   *
   * Unpositioned rows are counted, never silently dropped: an outbreak log
   * where half the entries never got a coordinate must say so, or the map
   * quietly understates the district's caseload.
   */
  fastify.get('/eho/map', { preHandler: requireRole(fastify, READ_ROLES) }, async (request, reply) => {
    const collection = (rows, props) => ({
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        id: r.id,
        geometry: { type: 'Point', coordinates: [Number(r.lng), Number(r.lat)] },
        properties: props(r),
      })),
    })
    try {
      const [prem, out, water, comp, missing] = await Promise.all([
        pg.query(`${SELECT_PREMISES} AND p.location IS NOT NULL LIMIT 5000`),
        pg.query(`${SELECT_OUTBREAK} WHERE o.location IS NOT NULL LIMIT 2000`),
        pg.query(`${SELECT_SAMPLE} WHERE s.location IS NOT NULL LIMIT 2000`),
        pg.query(`${SELECT_COMPLAINT} WHERE c.location IS NOT NULL LIMIT 2000`),
        pg.query(`
          SELECT
            (SELECT COUNT(*)::int FROM spatial_planning.health_premises
              WHERE location IS NULL AND deleted_at IS NULL) AS premises,
            (SELECT COUNT(*)::int FROM spatial_planning.health_outbreak
              WHERE location IS NULL) AS outbreaks,
            (SELECT COUNT(*)::int FROM spatial_planning.health_water_sample
              WHERE location IS NULL) AS water_samples,
            (SELECT COUNT(*)::int FROM spatial_planning.health_nuisance_complaint
              WHERE location IS NULL) AS complaints`),
      ])
      return reply.send({
        success: true,
        data: {
          premises: collection(prem.rows, (r) => ({
            id: r.id, reference: r.reference, name: r.name, premisesType: r.premises_type,
            ward: r.suburb_ward, stand: r.stand_number,
            lastInspectedAt: r.last_inspected_at,
            certificateExpiry: r.fitness_certificate_expiry,
            positionSource: r.location_source,
          })),
          outbreaks: collection(out.rows, (r) => ({
            id: r.id, reference: r.reference, disease: r.disease, status: r.status,
            casesCount: r.cases_count, ward: r.ward, catchmentM: r.catchment_m,
            firstReportedAt: r.first_reported_at, positionSource: r.location_source,
          })),
          waterSamples: collection(water.rows, (r) => ({
            id: r.id, reference: r.reference, sourceLabel: r.source_label,
            sourceType: r.source_type, result: r.result, sampledAt: r.sampled_at,
            ecoliCount: r.ecoli_count, positionSource: r.location_source,
          })),
          complaints: collection(comp.rows, (r) => ({
            id: r.id, reference: r.reference, category: r.category, status: r.status,
            receivedAt: r.received_at, premisesName: r.premises_name,
            positionSource: r.location_source,
          })),
          unpositioned: missing.rows[0],
        },
      })
    } catch (err) { return fail(request, reply, err, 'map layers') }
  })

  /**
   * What the health registers hold within `radius_m` of a point.
   *
   * This is the query an EHO runs standing in a street: a complaint comes in
   * about a smell, and the question is what else is here — which food premises,
   * which failed borehole, which open cluster.
   */
  fastify.get('/eho/nearby', { preHandler: requireRole(fastify, READ_ROLES) }, async (request, reply) => {
    const q = request.query || {}
    const pos = readLngLat(q.lng, q.lat)
    if (!pos) {
      return reply.code(400).send({
        success: false, error: 'bad_request', message: 'lng and lat must be valid coordinates.',
      })
    }
    const radius = q.radius_m === undefined ? 500 : int(q.radius_m, 10, MAX_RADIUS_M)
    if (radius === undefined) return reply.code(400).send({ success: false, error: 'bad_radius' })

    const dist = (r) => Math.round(Number(r.distance_m))
    const args = [pos.lng, pos.lat, radius]
    // The distance comes back in the same pass, so the client never recomputes
    // it and gets a different number from the server's.
    const PT = 'ST_SetSRID(ST_MakePoint($1,$2),4326)'
    const D = (a) => `ROUND(ST_Distance(${a}.location::geography, ${PT}::geography)::numeric, 1) AS distance_m`
    const within = (a) => `ST_DWithin(${a}.location::geography, ${PT}::geography, $3)`

    try {
      const [prem, out, water, comp] = await Promise.all([
        pg.query(`SELECT p.*, ${XY('p')}, ${D('p')} FROM spatial_planning.health_premises p
                   WHERE p.deleted_at IS NULL AND ${within('p')}
                   ORDER BY distance_m LIMIT 100`, args),
        pg.query(`SELECT o.*, ${XY('o')}, ${D('o')} FROM spatial_planning.health_outbreak o
                   WHERE ${within('o')} ORDER BY distance_m LIMIT 100`, args),
        pg.query(`SELECT s.*, ${XY('s')}, ${D('s')} FROM spatial_planning.health_water_sample s
                   WHERE ${within('s')} ORDER BY distance_m LIMIT 100`, args),
        pg.query(`SELECT c.*, ${XY('c')}, ${D('c')} FROM spatial_planning.health_nuisance_complaint c
                   WHERE ${within('c')} ORDER BY distance_m LIMIT 100`, args),
      ])
      return reply.send({
        success: true,
        data: {
          point: [pos.lng, pos.lat],
          radiusM: radius,
          premises: prem.rows.map((r) => ({ ...premisesDto(r), distanceM: dist(r) })),
          outbreaks: out.rows.map((r) => ({ ...outbreakDto(r), distanceM: dist(r) })),
          waterSamples: water.rows.map((r) => ({ ...sampleDto(r), distanceM: dist(r) })),
          complaints: comp.rows.map((r) => ({ ...complaintDto(r), distanceM: dist(r) })),
        },
      })
    } catch (err) { return fail(request, reply, err, 'nearby') }
  })

  /**
   * What is inside an outbreak's catchment.
   *
   * The first hour of a cholera report: which food premises are in the zone and
   * must be visited, and which tested water sources are in it — the ones that
   * failed first. `radius_m` overrides the outbreak's recorded catchment for a
   * what-if without editing the record.
   */
  fastify.get('/eho/outbreaks/:id/catchment', {
    preHandler: requireRole(fastify, READ_ROLES),
  }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const override = request.query?.radius_m === undefined
      ? null : int(request.query.radius_m, 10, MAX_RADIUS_M)
    if (override === undefined) return reply.code(400).send({ success: false, error: 'bad_radius' })

    try {
      const { rows: found } = await pg.query(`${SELECT_OUTBREAK} WHERE o.id = $1`, [id])
      const outbreak = found[0]
      if (!outbreak) return reply.code(404).send({ success: false, error: 'not_found' })

      // An outbreak with no position has no catchment. Saying so is the honest
      // answer; returning an empty list would read as "nothing is at risk".
      if (outbreak.lng == null) {
        return reply.send({
          success: true,
          data: {
            outbreak: outbreakDto(outbreak),
            radiusM: null, positioned: false,
            premises: [], waterSamples: [], complaints: [],
            limitations: ['This outbreak has no recorded position, so no catchment can be drawn. Record where the cluster is centred to run this query.'],
          },
        })
      }

      const radius = override ?? outbreak.catchment_m ?? DEFAULT_CATCHMENT_M
      const args = [Number(outbreak.lng), Number(outbreak.lat), radius, id]
      const D = (a) => `ROUND(ST_Distance(${a}.location::geography,
                        ST_SetSRID(ST_MakePoint($1,$2),4326)::geography)::numeric, 1) AS distance_m`
      const within = (a) => `ST_DWithin(${a}.location::geography,
                             ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $3)`

      const [prem, water, comp] = await Promise.all([
        pg.query(
          `SELECT p.*, ${XY('p')}, ${D('p')} FROM spatial_planning.health_premises p
            WHERE p.deleted_at IS NULL AND ${within('p')}
            ORDER BY distance_m LIMIT 300`, args.slice(0, 3)),
        pg.query(
          `SELECT s.*, ${XY('s')}, ${D('s')} FROM spatial_planning.health_water_sample s
            WHERE ${within('s')}
            -- Failed and borderline sources first: they are the ones that
            -- explain a water-borne cluster.
            ORDER BY CASE s.result WHEN 'not_potable' THEN 0 WHEN 'borderline' THEN 1
                                   WHEN 'pending' THEN 2 ELSE 3 END, distance_m
            LIMIT 300`, args.slice(0, 3)),
        pg.query(
          `SELECT c.*, ${XY('c')}, ${D('c')} FROM spatial_planning.health_nuisance_complaint c
            WHERE ${within('c')} AND c.category IN ('water', 'waste', 'smell')
            ORDER BY distance_m LIMIT 300`, args.slice(0, 3)),
      ])

      const dist = (r) => Math.round(Number(r.distance_m))
      const samples = water.rows.map((r) => ({ ...sampleDto(r), distanceM: dist(r) }))
      const limitations = []
      if (!samples.length) {
        limitations.push('No water source in this catchment has been sampled. That is an absence of testing, not a clean result.')
      }
      if (outbreak.location_source === 'ward_centroid') {
        limitations.push('The outbreak is positioned at the ward centroid, not a surveyed point. Treat the catchment as indicative.')
      }

      return reply.send({
        success: true,
        data: {
          outbreak: outbreakDto(outbreak),
          radiusM: radius,
          positioned: true,
          usedRecordedCatchment: override == null,
          premises: prem.rows.map((r) => ({ ...premisesDto(r), distanceM: dist(r) })),
          waterSamples: samples,
          complaints: comp.rows.map((r) => ({ ...complaintDto(r), distanceM: dist(r) })),
          limitations,
        },
      })
    } catch (err) { return fail(request, reply, err, 'catchment') }
  })
}

module.exports = { environmentalHealthRoutes, _internals: { readLngLat, readPosition } }
