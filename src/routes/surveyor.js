/**
 * Surveyor routes — dedicated survey workflow (migration 080).
 *
 * Mounts under /api (registered in server.js). Tables in spatial_planning.
 *
 *   GET   /surveyor/jobs                      (surveyor) — my queue (assigned/unclaimed)
 *   POST  /surveyor/jobs                      (assigner) — planner/EO assigns a task
 *   GET   /surveyor/jobs/:id                  (reader)   — task + citizen-app context + records
 *   PATCH /surveyor/jobs/:id                  (surveyor) — claim / status transition
 *   POST  /surveyor/jobs/:id/findings         (surveyor) — submit findings + recommendation
 *   GET   /surveyor/jobs/:id/coordinates      (reader)
 *   POST  /surveyor/jobs/:id/coordinates      (surveyor)
 *   GET   /surveyor/jobs/:id/beacons          (reader)
 *   POST  /surveyor/jobs/:id/beacons          (surveyor)
 *   GET   /surveyor/jobs/:id/parcels          (reader)   — cadastral parcels (migration 099)
 *   POST  /surveyor/jobs/:id/parcels          (surveyor) — area/closure computed server-side
 *   GET   /surveyor/jobs/:id/control-points   (reader)   — reference monuments used (migration 100)
 *   POST  /surveyor/jobs/:id/control-points   (surveyor) — attach a control_point to this job
 *   GET   /surveyor/jobs/:id/documents        (reader)   — generated DSG cert / Report on Survey
 *   POST  /surveyor/jobs/:id/documents        (surveyor) — persist rendered document content
 *   GET   /surveyor/jobs/:id/comments         (reader)
 *   POST  /surveyor/jobs/:id/comments         (reader)   — cross-role thread
 *   GET   /surveyor/layouts                   (surveyor)
 *   POST  /surveyor/layouts                   (surveyor)
 *   GET   /permit-applications/:id/survey-tasks (assigner) — findings visible to planner/EO
 */

const { requireRole } = require('../middleware/jwtAuth')
const { computeAreaConsistency } = require('../utils/area-computation')

const SURVEYOR = ['surveyor', 'admin']
const ASSIGNERS = ['planner', 'eo', 'planning_clerk', 'admin']
const READERS = [...new Set([...SURVEYOR, ...ASSIGNERS])]

function isUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)
}
function isStr(v, max = 8192) {
  return typeof v === 'string' && v.length > 0 && v.length <= max
}
function isDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}
function num(v) {
  return v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null)
}

async function surveyorRoutes(fastify) {
  const pg = fastify.pg

  // Load a task from the view and enforce visibility:
  //  - assigners (planner/EO/clerk/admin) see any task
  //  - a surveyor sees unclaimed tasks and their own; another surveyor's
  //    claimed task returns 404 (own-row gating)
  async function loadTask(request, reply) {
    const { id } = request.params
    if (!isUuid(id)) { reply.code(400).send({ success: false, error: 'bad_id' }); return null }
    const { rows } = await pg.query('SELECT * FROM spatial_planning.v_survey_task WHERE id = $1', [id])
    const task = rows[0]
    if (!task) { reply.code(404).send({ success: false, error: 'not_found' }); return null }
    const role = request.user.role
    const isAssigner = ASSIGNERS.includes(role)
    if (!isAssigner && role !== 'admin'
        && task.assigned_to && task.assigned_to !== request.user.id) {
      reply.code(404).send({ success: false, error: 'not_found' }); return null
    }
    return task
  }

  // ── Queue ──────────────────────────────────────────────────────────
  // Surveyors see their own queue (unclaimed + own); assigners (planner/EO/
  // clerk/admin) see every task — they need oversight across all surveyors,
  // not just tasks that happen to be assigned to their own user id.
  fastify.get('/surveyor/jobs', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    const { status, ward } = request.query
    const isAssigner = ASSIGNERS.includes(request.user.role)
    try {
      const { rows } = await pg.query(
        `SELECT * FROM spatial_planning.v_survey_task
          WHERE ($1::text IS NULL OR status = $1)
            AND ($2::text IS NULL OR suburb_ward ILIKE '%' || $2 || '%')
            AND ($4::boolean = true OR assigned_to = $3 OR assigned_to IS NULL)
          ORDER BY
            CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
            due_date NULLS LAST, created_at DESC
          LIMIT 200`,
        [status || null, ward || null, request.user.id, isAssigner],
      )
      return reply.send({ success: true, data: rows })
    } catch (err) {
      request.log.error({ err }, 'list survey jobs failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Assign (planner / EO connection) ───────────────────────────────
  fastify.post('/surveyor/jobs', { preHandler: requireRole(fastify, ASSIGNERS) }, async (request, reply) => {
    const b = request.body || {}
    const TASK_TYPES = ['verification', 'setting_out', 'pegging', 'layout', 'encroachment', 'beacon_check', 'general']
    if (b.task_type && !TASK_TYPES.includes(b.task_type)) {
      return reply.code(400).send({ success: false, error: 'bad_task_type' })
    }
    if (b.permit_app_id && !isUuid(b.permit_app_id)) {
      return reply.code(400).send({ success: false, error: 'bad_permit_app_id' })
    }
    if (b.assigned_to && !isUuid(b.assigned_to)) {
      return reply.code(400).send({ success: false, error: 'bad_assigned_to' })
    }
    const lng = num(b.lng)
    const lat = num(b.lat)
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.survey_task
           (permit_app_id, task_type, stand_number, suburb_ward, location,
            instructions, priority, due_date, assigned_by, assigned_to)
         VALUES ($1,$2,$3,$4,
           CASE WHEN $5::double precision IS NOT NULL AND $6::double precision IS NOT NULL
                THEN ST_SetSRID(ST_MakePoint($5,$6),4326) ELSE NULL END,
           $7,$8,$9,$10,$11)
         RETURNING *`,
        [b.permit_app_id || null, b.task_type || 'general', b.stand_number || null,
         b.suburb_ward || null, lng, lat, b.instructions || null,
         b.priority || 'normal', isDate(b.due_date) ? b.due_date : null,
         request.user.id, b.assigned_to || null],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'create survey task failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Detail (task + citizen-application context + records) ──────────
  fastify.get('/surveyor/jobs/:id', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    const task = await loadTask(request, reply); if (!task) return
    try {
      const [findings, coords, beacons, comments] = await Promise.all([
        pg.query('SELECT * FROM spatial_planning.survey_finding WHERE survey_task_id=$1 ORDER BY submitted_at DESC', [task.id]),
        pg.query('SELECT * FROM spatial_planning.survey_coordinate WHERE survey_task_id=$1 ORDER BY recorded_at', [task.id]),
        pg.query('SELECT * FROM spatial_planning.survey_beacon WHERE survey_task_id=$1 ORDER BY recorded_at', [task.id]),
        pg.query('SELECT * FROM spatial_planning.survey_comment WHERE survey_task_id=$1 ORDER BY created_at', [task.id]),
      ])
      return reply.send({
        success: true,
        data: { ...task, findings: findings.rows, coordinates: coords.rows, beacons: beacons.rows, comments: comments.rows },
      })
    } catch (err) {
      request.log.error({ err }, 'load survey task failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Claim / status ─────────────────────────────────────────────────
  // Surveyors claim and progress their own tasks. Assigners (planner/EO/
  // clerk) take the municipal review actions on a submitted report — accept
  // it, return it for more work, or cancel an instruction — mirroring how a
  // Town Planning memo to the survey section is closed out in practice.
  fastify.patch('/surveyor/jobs/:id', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    const task = await loadTask(request, reply); if (!task) return
    const b = request.body || {}
    const VALID = ['assigned', 'in_progress', 'submitted', 'accepted', 'returned', 'cancelled']
    if (b.status && !VALID.includes(b.status)) {
      return reply.code(400).send({ success: false, error: 'bad_status' })
    }
    const isSurveyorRole = SURVEYOR.includes(request.user.role)
    const isAssigner = ASSIGNERS.includes(request.user.role)
    if (!isSurveyorRole) {
      const REVIEW_ONLY = ['accepted', 'returned', 'cancelled']
      if (b.claim === true || (b.status && !REVIEW_ONLY.includes(b.status))) {
        return reply.code(403).send({ success: false, error: 'review_actions_only' })
      }
    }
    const ZONES = [25, 27, 29, 31, 33]
    if (b.gauss_lo && !ZONES.includes(Number(b.gauss_lo))) {
      return reply.code(400).send({ success: false, error: 'bad_gauss_lo' })
    }
    // Reassignment: `assigned_to` uuid hands the task to a named surveyor (an
    // assigner/supervisor action); `assigned_to: null` releases it back to the
    // unclaimed pool. A surveyor may only release — not push work onto a named
    // colleague — mirroring how the survey section reallocates a memo.
    const reassign = Object.prototype.hasOwnProperty.call(b, 'assigned_to')
    if (reassign) {
      if (b.assigned_to !== null && !isUuid(b.assigned_to)) {
        return reply.code(400).send({ success: false, error: 'bad_assigned_to' })
      }
      if (b.assigned_to !== null && !isAssigner) {
        return reply.code(403).send({ success: false, error: 'reassign_requires_assigner' })
      }
    }
    const claim = b.claim === true
    try {
      const { rows } = await pg.query(
        `UPDATE spatial_planning.survey_task
            SET status = COALESCE($2, status),
                assigned_to = CASE WHEN $3 THEN $4
                                   WHEN $6 THEN $7::uuid
                                   ELSE assigned_to END,
                gauss_lo = COALESCE($5, gauss_lo)
          WHERE id = $1
          RETURNING *`,
        [task.id, b.status || null, claim, request.user.id, b.gauss_lo ? Number(b.gauss_lo) : null,
         reassign, reassign ? b.assigned_to : null],
      )
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'update survey task failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Findings (report back to planner / EO) ─────────────────────────
  fastify.post('/surveyor/jobs/:id/findings', { preHandler: requireRole(fastify, SURVEYOR) }, async (request, reply) => {
    const task = await loadTask(request, reply); if (!task) return
    const b = request.body || {}
    if (!isStr(b.summary)) return reply.code(400).send({ success: false, error: 'summary required' })
    const RECS = ['no_objection', 'objection', 'approve', 'approve_conditions', 'refuse', 'refer_back']
    if (b.recommendation && !RECS.includes(b.recommendation)) {
      return reply.code(400).send({ success: false, error: 'bad_recommendation' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.survey_finding
           (survey_task_id, summary, recommendation, conditions, notes, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [task.id, b.summary, b.recommendation || null, b.conditions || null, b.notes || null, request.user.id],
      )
      // Submitting findings advances the task to 'submitted' (unless already accepted).
      await pg.query(
        `UPDATE spatial_planning.survey_task SET status='submitted' WHERE id=$1 AND status <> 'accepted'`,
        [task.id],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'submit survey finding failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Coordinates ────────────────────────────────────────────────────
  fastify.get('/surveyor/jobs/:id/coordinates', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    const task = await loadTask(request, reply); if (!task) return
    const { rows } = await pg.query('SELECT * FROM spatial_planning.survey_coordinate WHERE survey_task_id=$1 ORDER BY recorded_at', [task.id])
    return reply.send({ success: true, data: rows })
  })
  fastify.post('/surveyor/jobs/:id/coordinates', { preHandler: requireRole(fastify, SURVEYOR) }, async (request, reply) => {
    const task = await loadTask(request, reply); if (!task) return
    const b = request.body || {}
    const SYS = ['WGS84', 'Lo31', 'Lo29', 'UTM35S', 'other']
    if (b.coord_system && !SYS.includes(b.coord_system)) return reply.code(400).send({ success: false, error: 'bad_coord_system' })
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.survey_coordinate
           (survey_task_id, label, coord_system, easting, northing, longitude, latitude, elevation, notes, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [task.id, b.label || null, b.coord_system || 'WGS84', num(b.easting), num(b.northing),
         num(b.longitude), num(b.latitude), num(b.elevation), b.notes || null, request.user.id],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'create survey coordinate failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Beacons ────────────────────────────────────────────────────────
  fastify.get('/surveyor/jobs/:id/beacons', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    const task = await loadTask(request, reply); if (!task) return
    const { rows } = await pg.query('SELECT * FROM spatial_planning.survey_beacon WHERE survey_task_id=$1 ORDER BY recorded_at', [task.id])
    return reply.send({ success: true, data: rows })
  })
  fastify.post('/surveyor/jobs/:id/beacons', { preHandler: requireRole(fastify, SURVEYOR) }, async (request, reply) => {
    const task = await loadTask(request, reply); if (!task) return
    const b = request.body || {}
    const TYPES = ['iron_peg', 'concrete_beacon', 'survey_nail', 'witness_beacon']
    const STATUS = ['intact', 'missing', 'damaged', 'replaced']
    if (b.beacon_type && !TYPES.includes(b.beacon_type)) return reply.code(400).send({ success: false, error: 'bad_beacon_type' })
    if (b.status && !STATUS.includes(b.status)) return reply.code(400).send({ success: false, error: 'bad_status' })
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.survey_beacon
           (survey_task_id, corner_label, beacon_type, easting, northing, status, notes, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [task.id, b.corner_label || null, b.beacon_type || 'iron_peg', num(b.easting), num(b.northing),
         b.status || 'intact', b.notes || null, request.user.id],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'create survey beacon failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Parcels (area/closure computed server-side, never trust the client) ──
  fastify.get('/surveyor/jobs/:id/parcels', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    const task = await loadTask(request, reply); if (!task) return
    const { rows } = await pg.query('SELECT * FROM spatial_planning.survey_parcel WHERE survey_task_id=$1 ORDER BY created_at DESC', [task.id])
    return reply.send({ success: true, data: rows })
  })
  fastify.post('/surveyor/jobs/:id/parcels', { preHandler: requireRole(fastify, SURVEYOR) }, async (request, reply) => {
    const task = await loadTask(request, reply); if (!task) return
    const b = request.body || {}
    const points = b.points
    if (!Array.isArray(points) || points.length < 3
        || !points.every((p) => p && Number.isFinite(p.y) && Number.isFinite(p.x))) {
      return reply.code(400).send({ success: false, error: 'points must be an array of at least 3 {y,x} numbers' })
    }
    let computed
    try {
      computed = computeAreaConsistency(points, { includeResiduals: true })
    } catch (err) {
      return reply.code(400).send({ success: false, error: err.message })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.survey_parcel
           (survey_task_id, points, area_m2, perimeter_m, closure_error_m, closure_ratio, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [task.id, JSON.stringify(points), computed.area.abs_m2, computed.closure.perimeter,
         computed.closure.error, computed.closure.ratioFormatted, request.user.id],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'create survey parcel failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Reference control points used on this job ──────────────────────
  fastify.get('/surveyor/jobs/:id/control-points', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    const task = await loadTask(request, reply); if (!task) return
    const { rows } = await pg.query(
      `SELECT cp.* FROM spatial_planning.survey_task_control_point tcp
         JOIN spatial_planning.control_point cp ON cp.id = tcp.control_point_id
        WHERE tcp.survey_task_id = $1 ORDER BY cp.monu_num`,
      [task.id],
    )
    return reply.send({ success: true, data: rows })
  })
  fastify.post('/surveyor/jobs/:id/control-points', { preHandler: requireRole(fastify, SURVEYOR) }, async (request, reply) => {
    const task = await loadTask(request, reply); if (!task) return
    const controlPointId = Number((request.body || {}).control_point_id)
    if (!Number.isInteger(controlPointId)) {
      return reply.code(400).send({ success: false, error: 'control_point_id required' })
    }
    try {
      await pg.query(
        `INSERT INTO spatial_planning.survey_task_control_point (survey_task_id, control_point_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [task.id, controlPointId],
      )
      return reply.code(201).send({ success: true })
    } catch (err) {
      request.log.error({ err }, 'attach control point failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Generated documents (DSG certificate / Report on Survey) ───────
  fastify.get('/surveyor/jobs/:id/documents', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    const task = await loadTask(request, reply); if (!task) return
    const { rows } = await pg.query(
      `SELECT id, survey_task_id, doc_type, title, content, generated_by, created_at
         FROM spatial_planning.survey_document WHERE survey_task_id=$1 ORDER BY created_at DESC`,
      [task.id],
    )
    return reply.send({ success: true, data: rows })
  })
  fastify.post('/surveyor/jobs/:id/documents', { preHandler: requireRole(fastify, SURVEYOR) }, async (request, reply) => {
    const task = await loadTask(request, reply); if (!task) return
    const b = request.body || {}
    const DOC_TYPES = ['dsg_certificate', 'report_on_survey']
    if (!DOC_TYPES.includes(b.doc_type)) return reply.code(400).send({ success: false, error: 'bad_doc_type' })
    if (!isStr(b.title, 200)) return reply.code(400).send({ success: false, error: 'title required' })
    if (!isStr(b.content, 200000)) return reply.code(400).send({ success: false, error: 'content required' })
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.survey_document (survey_task_id, doc_type, title, content, generated_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, survey_task_id, doc_type, title, content, generated_by, created_at`,
        [task.id, b.doc_type, b.title, b.content, request.user.id],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'create survey document failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Comments (cross-role thread) ───────────────────────────────────
  fastify.get('/surveyor/jobs/:id/comments', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    const task = await loadTask(request, reply); if (!task) return
    const { rows } = await pg.query('SELECT * FROM spatial_planning.survey_comment WHERE survey_task_id=$1 ORDER BY created_at', [task.id])
    return reply.send({ success: true, data: rows })
  })
  fastify.post('/surveyor/jobs/:id/comments', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    const task = await loadTask(request, reply); if (!task) return
    const b = request.body || {}
    if (!isStr(b.body, 4096)) return reply.code(400).send({ success: false, error: 'body required' })
    const AUD = ['planner', 'eo', 'surveyor', 'citizen', 'all']
    if (b.audience && !AUD.includes(b.audience)) return reply.code(400).send({ success: false, error: 'bad_audience' })
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.survey_comment
           (survey_task_id, author_id, author_role, audience, body)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [task.id, request.user.id, request.user.role, b.audience || 'all', b.body],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'create survey comment failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Layouts (standalone cadastral register) ────────────────────────
  fastify.get('/surveyor/layouts', { preHandler: requireRole(fastify, SURVEYOR) }, async (request, reply) => {
    const { rows } = await pg.query('SELECT * FROM spatial_planning.survey_layout ORDER BY created_at DESC LIMIT 200')
    return reply.send({ success: true, data: rows })
  })
  fastify.post('/surveyor/layouts', { preHandler: requireRole(fastify, SURVEYOR) }, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.layout_name, 120)) return reply.code(400).send({ success: false, error: 'layout_name required' })
    const STATUS = ['pre_survey', 'designed', 'verified', 'approved', 'pegging', 'completed']
    if (b.status && !STATUS.includes(b.status)) return reply.code(400).send({ success: false, error: 'bad_status' })
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.survey_layout
           (survey_task_id, layout_name, parent_property, ward, parent_area_ha, stands_planned, status, designer, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [b.survey_task_id && isUuid(b.survey_task_id) ? b.survey_task_id : null, b.layout_name,
         b.parent_property || null, b.ward || null, num(b.parent_area_ha), num(b.stands_planned),
         b.status || 'pre_survey', b.designer || null, b.notes || null, request.user.id],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'create survey layout failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Planner / EO: survey tasks + findings for an application ────────
  fastify.get('/permit-applications/:id/survey-tasks', { preHandler: requireRole(fastify, ASSIGNERS) }, async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
    try {
      const { rows } = await pg.query(
        `SELECT t.*,
           (SELECT json_agg(f ORDER BY f.submitted_at DESC)
              FROM spatial_planning.survey_finding f WHERE f.survey_task_id = t.id) AS findings
         FROM spatial_planning.v_survey_task t
        WHERE t.permit_app_id = $1
        ORDER BY t.created_at DESC`,
        [id],
      )
      return reply.send({ success: true, data: rows })
    } catch (err) {
      request.log.error({ err }, 'list application survey tasks failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

module.exports = { surveyorRoutes }
