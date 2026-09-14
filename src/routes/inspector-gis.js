// src/routes/inspector-gis.js
// ─────────────────────────────────────────────────────────────────────────
// Building Inspector GIS endpoints. Spatial work lives in
// src/services/inspectorSpatial.js; this file validates, authorises and writes.
//
//   GET  /inspector/sites                           map layers for every site
//   GET  /inspector/permits/:id/site-report         site checks for one permit
//   GET  /inspector/identify?lng&lat                what the registers hold here
//   GET  /stage-inspections/:sid/field-events       movement log
//   POST /stage-inspections/:sid/field-events       travelling | arrived | started | completed
//   GET  /stage-inspections/:sid/geo-verification   arrival + photo geotags vs site
//   PUT  /permit-applications/:id/site-location     record the site position (audited)
//
// All staff-only: responses carry applicant names and site positions.
// ─────────────────────────────────────────────────────────────────────────

const { requireRole } = require('../middleware/jwtAuth')
const spatial = require('../services/inspectorSpatial')

const STAFF_ROLES = [
  'admin', 'planner', 'planning_clerk', 'building_inspector',
  'eo', 'env_officer', 'surveyor', 'gis_officer',
]
const FIELD_EVENT_WRITERS = ['building_inspector', 'admin']
const SITE_LOCATION_WRITERS = ['building_inspector', 'gis_officer', 'planner', 'admin']

const FIELD_EVENT_TYPES = ['travelling', 'arrived', 'inspection_started', 'inspection_completed']
const SITE_LOCATION_SOURCES = ['field_gps', 'map_pick']
// A site position recorded from GPS must be at least this good.
const SITE_LOCATION_MAX_ACCURACY_M = 25

const isUuid = (v) =>
  typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)

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

function fieldEventDto(e) {
  const num = (v) => (v == null ? null : Number(v))
  return {
    id: e.id,
    stage_inspection_id: e.stage_inspection_id,
    event_type: e.event_type,
    recorded_at: e.recorded_at,
    recorded_by: e.recorded_by,
    recorded_by_name: e.recorded_by_name ?? null,
    observed_lat: num(e.observed_lat),
    observed_lng: num(e.observed_lng),
    accuracy_m: num(e.accuracy_m),
    note: e.note,
    site_distance_m: num(e.site_distance_m),
    geofence_result: e.geofence_result ?? null,
    site_precision: e.site_precision ?? null,
  }
}

async function inspectorGisRoutes(fastify) {
  const pg = fastify.pg

  // ── map layers ──────────────────────────────────────────────────────
  fastify.get('/inspector/sites', {
    preHandler: requireRole(fastify, STAFF_ROLES),
  }, async (request, reply) => {
    const scope = request.query?.scope === 'all' ? 'all' : 'inspectable'
    try {
      const data = await spatial.listInspectorSites(pg, { scope })
      return { success: true, data }
    } catch (err) {
      request.log.error({ err }, '[inspector-gis] sites failed')
      return reply.code(500).send({
        success: false, error: 'sites_failed', message: 'Inspection sites could not be loaded.',
      })
    }
  })

  // ── site report ─────────────────────────────────────────────────────
  fastify.get('/inspector/permits/:id/site-report', {
    preHandler: requireRole(fastify, STAFF_ROLES),
  }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    try {
      const data = await spatial.getSiteReport(pg, id)
      if (!data) return reply.code(404).send({ success: false, error: 'not_found' })
      return { success: true, data }
    } catch (err) {
      request.log.error({ err, permitId: id }, '[inspector-gis] site report failed')
      return reply.code(500).send({
        success: false, error: 'site_report_failed', message: 'The site checks could not be run.',
      })
    }
  })

  // ── identify ────────────────────────────────────────────────────────
  fastify.get('/inspector/identify', {
    preHandler: requireRole(fastify, STAFF_ROLES),
  }, async (request, reply) => {
    const pt = readLngLat(request.query?.lng, request.query?.lat)
    if (!pt) {
      return reply.code(400).send({
        success: false, error: 'bad_request', message: 'lng and lat must be valid coordinates.',
      })
    }
    try {
      return { success: true, data: await spatial.identifyAt(pg, pt.lng, pt.lat) }
    } catch (err) {
      request.log.error({ err }, '[inspector-gis] identify failed')
      return reply.code(500).send({
        success: false, error: 'identify_failed', message: 'The location could not be identified.',
      })
    }
  })

  // ── field events ────────────────────────────────────────────────────
  fastify.get('/stage-inspections/:sid/field-events', {
    preHandler: requireRole(fastify, STAFF_ROLES),
  }, async (request, reply) => {
    const { sid } = request.params
    if (!isUuid(sid)) return reply.code(400).send({ success: false, error: 'bad_id' })
    try {
      const exists = await pg.query('SELECT 1 FROM spatial_planning.stage_inspection WHERE id = $1', [sid])
      if (!exists.rows[0]) return reply.code(404).send({ success: false, error: 'inspection_not_found' })
      const r = await pg.query(
        `SELECT e.*, COALESCE(u.full_name, u.name) AS recorded_by_name
           FROM spatial_planning.stage_inspection_field_event e
           LEFT JOIN public.users u ON u.id = e.recorded_by
          WHERE e.stage_inspection_id = $1
          ORDER BY e.recorded_at, e.id`,
        [sid],
      )
      return { success: true, data: r.rows.map(fieldEventDto) }
    } catch (err) {
      request.log.error({ err }, '[inspector-gis] list field events failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/stage-inspections/:sid/field-events', {
    preHandler: requireRole(fastify, FIELD_EVENT_WRITERS),
  }, async (request, reply) => {
    const { sid } = request.params
    if (!isUuid(sid)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}

    if (!FIELD_EVENT_TYPES.includes(b.event_type)) {
      return reply.code(400).send({ success: false, error: 'bad_event_type', allowed: FIELD_EVENT_TYPES })
    }
    const fix = readLngLat(b.observed_lng, b.observed_lat)
    if (fix === undefined) {
      return reply.code(400).send({
        success: false, error: 'bad_coordinates',
        message: 'Send both observed_lat and observed_lng as valid coordinates, or neither.',
      })
    }
    let accuracy = null
    if (b.accuracy_m !== undefined && b.accuracy_m !== null) {
      accuracy = Number(b.accuracy_m)
      if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000) {
        return reply.code(400).send({ success: false, error: 'bad_accuracy' })
      }
      if (!fix) return reply.code(400).send({ success: false, error: 'accuracy_without_fix' })
    }
    if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > 1000)) {
      return reply.code(400).send({ success: false, error: 'bad_note' })
    }

    try {
      const insp = await pg.query(
        'SELECT id, permit_app_id, inspector_id FROM spatial_planning.stage_inspection WHERE id = $1',
        [sid],
      )
      const row = insp.rows[0]
      if (!row) return reply.code(404).send({ success: false, error: 'inspection_not_found' })
      // Attendance is personal evidence: nobody logs it for someone else's visit.
      if (row.inspector_id && row.inspector_id !== request.user.id && request.user.role !== 'admin') {
        return reply.code(403).send({
          success: false, error: 'not_assigned',
          message: 'This inspection is assigned to another inspector.',
        })
      }

      // Geofence is computed here, from the server's site record, and frozen on
      // the row. The client never supplies a distance or a verdict.
      let siteDistance = null
      let geofence = null
      let precision = null
      if (fix) {
        const site = await spatial.resolvePermitSite(pg, row.permit_app_id)
        precision = site?.precision || 'none'
        siteDistance = site ? await spatial.distanceToSite(pg, site, fix.lng, fix.lat) : null
        geofence = spatial.geofenceVerdict({ precision, distanceM: siteDistance, accuracyM: accuracy })
      }

      const ins = await pg.query(
        `INSERT INTO spatial_planning.stage_inspection_field_event
           (stage_inspection_id, event_type, recorded_by, observed_lat, observed_lng, accuracy_m, note,
            site_distance_m, geofence_result, site_precision)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [sid, b.event_type, request.user.id,
          fix ? fix.lat : null, fix ? fix.lng : null, accuracy,
          typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null,
          siteDistance, geofence, precision],
      )
      return reply.code(201).send({ success: true, data: fieldEventDto(ins.rows[0]) })
    } catch (err) {
      request.log.error({ err }, '[inspector-gis] record field event failed')
      return reply.code(500).send({ success: false, error: 'internal', message: 'The field event was not recorded.' })
    }
  })

  // ── evidence geo-verification ───────────────────────────────────────
  fastify.get('/stage-inspections/:sid/geo-verification', {
    preHandler: requireRole(fastify, STAFF_ROLES),
  }, async (request, reply) => {
    const { sid } = request.params
    if (!isUuid(sid)) return reply.code(400).send({ success: false, error: 'bad_id' })
    try {
      const data = await spatial.getGeoVerification(pg, sid)
      if (!data) return reply.code(404).send({ success: false, error: 'inspection_not_found' })
      return { success: true, data }
    } catch (err) {
      request.log.error({ err }, '[inspector-gis] geo verification failed')
      return reply.code(500).send({
        success: false, error: 'geo_verification_failed', message: 'Evidence positions could not be checked.',
      })
    }
  })

  // ── record the site position ────────────────────────────────────────
  fastify.put('/permit-applications/:id/site-location', {
    preHandler: requireRole(fastify, SITE_LOCATION_WRITERS),
  }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    const b = request.body || {}

    const pt = readLngLat(b.lng, b.lat)
    if (!pt) {
      return reply.code(400).send({ success: false, error: 'bad_coordinates', message: 'lng and lat are required.' })
    }
    if (!SITE_LOCATION_SOURCES.includes(b.source)) {
      return reply.code(400).send({ success: false, error: 'bad_source', allowed: SITE_LOCATION_SOURCES })
    }
    let accuracy = null
    if (b.accuracy_m !== undefined && b.accuracy_m !== null) {
      accuracy = Number(b.accuracy_m)
      if (!Number.isFinite(accuracy) || accuracy < 0) {
        return reply.code(400).send({ success: false, error: 'bad_accuracy' })
      }
    }
    if (b.source === 'field_gps' && (accuracy == null || accuracy > SITE_LOCATION_MAX_ACCURACY_M)) {
      return reply.code(422).send({
        success: false, error: 'accuracy_insufficient',
        message: `A GPS fix must be accurate to ${SITE_LOCATION_MAX_ACCURACY_M} m or better to record a site position.`,
        maxAccuracyM: SITE_LOCATION_MAX_ACCURACY_M,
      })
    }
    const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
    if (reason.length < 10 || reason.length > 1000) {
      return reply.code(400).send({
        success: false, error: 'reason_required',
        message: 'Give a reason of at least 10 characters for the audit record.',
      })
    }

    let boundaryChecked = true
    try {
      const inside = await spatial.insideCouncilBoundary(pg, pt.lng, pt.lat)
      if (inside === null) boundaryChecked = false
      else if (!inside) {
        return reply.code(422).send({
          success: false, error: 'outside_jurisdiction',
          message: 'That position is outside the council planning boundary.',
        })
      }
    } catch (err) {
      request.log.error({ err }, '[inspector-gis] boundary check failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }

    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const before = await client.query(
        `SELECT id, ST_X(location) AS lng, ST_Y(location) AS lat, location_source, revision
           FROM spatial_planning.permit_application WHERE id = $1 FOR UPDATE`,
        [id],
      )
      if (!before.rows[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ success: false, error: 'not_found' })
      }
      const prev = before.rows[0]
      const upd = await client.query(
        `UPDATE spatial_planning.permit_application
            SET location            = ST_SetSRID(ST_MakePoint($2, $3), 4326),
                location_source     = $4,
                location_accuracy_m = $5,
                location_set_by     = $6,
                location_set_at     = NOW(),
                revision            = revision + 1,
                updated_at          = NOW()
          WHERE id = $1
          RETURNING revision`,
        [id, pt.lng, pt.lat, b.source, accuracy, request.user.id],
      )
      const moved = prev.lng == null ? null : await client.query(
        `SELECT ST_Distance(ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                            ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography) AS d`,
        [prev.lng, prev.lat, pt.lng, pt.lat],
      )
      const movedM = moved ? Math.round(Number(moved.rows[0].d) * 10) / 10 : null
      await client.query(
        `INSERT INTO spatial_planning.permit_event (permit_app_id, event_type, actor_id, actor_role, detail)
         VALUES ($1, 'site_location_set', $2, $3, $4::jsonb)`,
        [id, request.user.id, request.user.role, JSON.stringify({
          source: b.source,
          accuracy_m: accuracy,
          reason,
          new: { lng: pt.lng, lat: pt.lat },
          previous: prev.lng == null ? null : { lng: Number(prev.lng), lat: Number(prev.lat), source: prev.location_source },
          moved_m: movedM,
          boundary_checked: boundaryChecked,
        })],
      )
      await client.query('COMMIT')

      const site = await spatial.resolvePermitSite(pg, id)
      return {
        success: true,
        data: {
          site: site ? spatial.siteDto(site) : null,
          revision: upd.rows[0].revision,
          movedM,
          boundaryChecked,
        },
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      request.log.error({ err }, '[inspector-gis] set site location failed')
      return reply.code(500).send({ success: false, error: 'internal', message: 'The site position was not saved.' })
    } finally {
      client.release()
    }
  })
}

module.exports = { inspectorGisRoutes, _internals: { readLngLat } }
