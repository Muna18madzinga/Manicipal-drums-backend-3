/**
 * Plan workbench — the staff API for onboarding an authority and managing its plans.
 *
 *   GET  /api/workbench/plans                    every plan, with its sign-off and next steps
 *   GET  /api/workbench/plans/:id                one plan: summary, sign-off, allowed next statuses, history
 *   POST /api/workbench/authorities              add an authority (admin)
 *   POST /api/workbench/plans/adopt              give an authority its own copy of a template
 *   POST /api/workbench/plans/:id/matrix/import  { csv, apply }  validate a sheet; write it only when apply is true
 *   POST /api/workbench/plans/:id/signoff        { comment }  the authority's planner signs the plan off
 *   POST /api/workbench/plans/:id/zone-types/:code/review  { status, reviewer }  record where a zone column stands in review
 *   POST /api/workbench/plans/:id/status         { status, gazette_ref, effective_from }  one step along the chain
 *   POST /api/workbench/plans/:id/version        start the next version of an approved or gazetted plan
 *
 * Every write is attributed to the signed-in user and recorded in the plan's event history.
 * The rules (sign-off must be current to approve; gazette reference and date to gazette; an
 * approved plan's rules are frozen) live in the database (migration 150) so no client can
 * bypass them; this layer maps their refusals to readable 409/400 responses.
 *
 * Role-based for now (admin, planner). Per-authority scoping comes with row-level security.
 */
const { requireRole } = require('../middleware/jwtAuth')
const { importCsv } = require('../services/planMatrixImport')
const { tenantPool } = require('../lib/tenancy')

const WRITE_ROLES = ['admin', 'planner']
const READ_ROLES = ['admin', 'planner', 'planning_clerk', 'eo', 'gis_officer']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_CSV_CHARS = 1_000_000
const PLAN_TYPES = ['district_master', 'local', 'layout', 'scheme']
const KINDS = ['rural', 'urban', 'combination']

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v)
const actorOf = (request) => ({ id: request.user.id, role: request.user.role, name: request.user.name || request.user.email })

/**
 * Database refusals that are rules, not faults: show their message (they are our own text).
 * 23514 check_violation, 22023 invalid_parameter, 23505 unique_violation.
 */
function ruleRefusal(err) {
  if (!err) return null
  if (err.code === '23514' || err.code === '22023') return { status: 409, message: err.message }
  if (err.code === '23505') return { status: 409, message: 'That already exists.' }
  if (err.code === '42501') return { status: 403, message: 'That belongs to another authority.' }
  if (err.code === 'P0001' && /unknown|not a|needs|only|cannot|template|sign-off|newer version|exist/i.test(err.message)) return { status: 409, message: err.message }
  return null
}

const NEXT_SQL = `SELECT to_status FROM plan_status_transition WHERE from_status = $1 ORDER BY to_status`

const PLAN_SQL = `
  SELECT s.*, i.gazette_ref, i.effective_to, i.supersedes_id, i.derived_from_id, i.source_document, i.notes,
         plan_signoff_is_current(i.id) AS signoff_current,
         (SELECT row_to_json(x) FROM (SELECT signer_name, signer_role, comment, signed_at FROM plan_signoff
                                       WHERE plan_instrument_id = i.id ORDER BY signed_at DESC, id LIMIT 1) x) AS last_signoff,
         plan_is_frozen(i.id) AS frozen
    FROM plan_instrument_summary s JOIN plan_instrument i ON i.id = s.id`

async function planWorkbenchRoutes(fastify) {
  const pg = fastify.pg
  // Every database call for a request runs as that person: the database refuses what their authority may not touch.
  const db = (request) => tenantPool(pg, request.user)
  const reader = { preHandler: requireRole(fastify, READ_ROLES) }
  const writer = { preHandler: requireRole(fastify, WRITE_ROLES) }
  const adminOnly = { preHandler: requireRole(fastify, ['admin']) }

  const fail = (request, reply, err, what) => {
    const rule = ruleRefusal(err)
    if (rule) return reply.code(rule.status).send({ success: false, error: 'refused', message: rule.message })
    request.log.error({ err }, `${what} failed`)
    return reply.code(500).send({ success: false, error: 'internal' })
  }
  const needPlan = async (request, reply) => {
    const { id } = request.params
    if (!isUuid(id)) { reply.code(400).send({ success: false, error: 'bad_id' }); return null }
    const { rows } = await db(request).query('SELECT id, is_template, status FROM plan_instrument WHERE id = $1', [id])
    if (!rows[0]) { reply.code(404).send({ success: false, error: 'not_found' }); return null }
    return rows[0]
  }

  fastify.get('/workbench/plans', reader, async (request, reply) => {
    try {
      const { rows } = await db(request).query(`${PLAN_SQL} ORDER BY s.is_template DESC, s.authority_name NULLS FIRST, s.title, s.version`)
      return reply.send({ success: true, count: rows.length, data: rows })
    } catch (err) { return fail(request, reply, err, 'list workbench plans') }
  })

  fastify.get('/workbench/plans/:id', reader, async (request, reply) => {
    try {
      if (!(await needPlan(request, reply))) return
      const { rows } = await db(request).query(`${PLAN_SQL} WHERE i.id = $1`, [request.params.id])
      const plan = rows[0]
      const next = plan.is_template ? [] : (await db(request).query(NEXT_SQL, [plan.status])).rows.map((r) => r.to_status)
      const events = (await db(request).query(
        `SELECT e.event_type, e.actor_role, e.detail, e.at, u.email AS actor_email
           FROM plan_event e LEFT JOIN users u ON u.id = e.actor_id
          WHERE e.plan_instrument_id = $1 ORDER BY e.at DESC LIMIT 100`, [request.params.id])).rows
      const zoneTypes = (await db(request).query(
        `SELECT code, name, category, review_status, reviewed_by, reviewed_at FROM plan_zone_type WHERE plan_instrument_id = $1 ORDER BY display_no NULLS LAST, name`,
        [request.params.id])).rows
      return reply.send({ success: true, data: { plan, next_statuses: next, events, zone_types: zoneTypes } })
    } catch (err) { return fail(request, reply, err, 'get workbench plan') }
  })

  // Findings about a plan's matrix that a planner should settle (migration 160). Advisory: nothing is blocked.
  fastify.get('/workbench/plans/:id/audit', reader, async (request, reply) => {
    try {
      if (!(await needPlan(request, reply))) return
      const { rows } = await db(request).query(
        `SELECT severity, kind, zone_code, group_code, detail FROM plan_matrix_audit WHERE plan_instrument_id = $1
          ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, kind, zone_code NULLS LAST, group_code NULLS LAST`,
        [request.params.id])
      const count = (sev) => rows.filter((r) => r.severity === sev).length
      return reply.send({ success: true, data: { errors: count('error'), warnings: count('warning'), reviews: count('review'), findings: rows } })
    } catch (err) { return fail(request, reply, err, 'audit workbench plan') }
  })

  // Adding an authority is a platform decision, not an authority administrator's: authorities are shared
  // and a council's own IT administrator must not be able to create or alter another's.
  fastify.post('/workbench/authorities', adminOnly, async (request, reply) => {
    if (request.user.is_platform !== true) {
      return reply.code(403).send({ success: false, error: 'platform_only', message: 'Adding an authority is for the platform operator.' })
    }
    const b = request.body || {}
    const code = typeof b.code === 'string' ? b.code.trim().toUpperCase() : ''
    const members = Array.isArray(b.members) ? b.members.map((m) => String(m).trim().toUpperCase()) : []
    if (!/^[A-Z0-9-]{2,30}$/.test(code)) return reply.code(400).send({ success: false, error: 'bad_code' })
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 255) return reply.code(400).send({ success: false, error: 'bad_name' })
    if (!KINDS.includes(b.kind)) return reply.code(400).send({ success: false, error: 'bad_kind' })
    if (b.kind === 'combination' && members.length < 2) return reply.code(400).send({ success: false, error: 'combination_needs_members' })
    if (b.kind !== 'combination' && members.length) return reply.code(400).send({ success: false, error: 'members_only_for_combination' })
    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const { rows: [a] } = await client.query(
        `INSERT INTO local_authorities (authority_name, code, kind, authority_type, province)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, code, authority_name, kind`,
        [b.name.trim(), code, b.kind, typeof b.type === 'string' ? b.type : null, typeof b.province === 'string' ? b.province : null])
      for (const m of members) {
        const { rows } = await client.query('SELECT id FROM local_authorities WHERE code = $1', [m])
        if (!rows.length) throw Object.assign(new Error(`member authority ${m} does not exist`), { code: '22023' })
        await client.query('INSERT INTO authority_member (combination_id, member_id) VALUES ($1, $2)', [a.id, rows[0].id])
      }
      await client.query('COMMIT')
      return reply.code(201).send({ success: true, data: a })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      return fail(request, reply, err, 'add authority')
    } finally { client.release() }
  })

  fastify.post('/workbench/plans/adopt', writer, async (request, reply) => {
    const b = request.body || {}
    if (!Number.isInteger(b.authority_id)) return reply.code(400).send({ success: false, error: 'bad_authority' })
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 255) return reply.code(400).send({ success: false, error: 'bad_title' })
    const planType = b.plan_type === undefined ? 'local' : b.plan_type
    if (!PLAN_TYPES.includes(planType)) return reply.code(400).send({ success: false, error: 'bad_plan_type' })
    if (b.template_id !== undefined && !isUuid(b.template_id)) return reply.code(400).send({ success: false, error: 'bad_template' })
    if (b.profile !== undefined && !['rural', 'urban'].includes(b.profile)) return reply.code(400).send({ success: false, error: 'bad_profile' })
    try {
      const { rows: t } = b.template_id
        ? await db(request).query('SELECT id FROM plan_instrument WHERE id = $1 AND is_template', [b.template_id])
        : await db(request).query(
          `SELECT i.id FROM plan_instrument i JOIN plan_profile p ON p.id = i.profile_id
            WHERE i.is_default_template AND p.code = $1`, [b.profile || 'rural'])
      if (!t[0]) return reply.code(404).send({ success: false, error: 'template_not_found' })
      const { rows: [{ id }] } = await db(request).query('SELECT adopt_plan_template($1, $2, $3, $4, $5) AS id',
        [t[0].id, b.authority_id, b.title.trim(), planType, 'draft'])
      await db(request).query('SELECT log_plan_event($1, $2, $3, $4, $5::jsonb)',
        [id, 'adopted', request.user.id, request.user.role, JSON.stringify({ template: t[0].id })])
      return reply.code(201).send({ success: true, data: { id } })
    } catch (err) { return fail(request, reply, err, 'adopt template') }
  })

  fastify.post('/workbench/plans/:id/matrix/import', writer, async (request, reply) => {
    const plan = await needPlan(request, reply)
    if (!plan) return
    const b = request.body || {}
    if (typeof b.csv !== 'string' || !b.csv.trim()) return reply.code(400).send({ success: false, error: 'csv_required' })
    if (b.csv.length > MAX_CSV_CHARS) return reply.code(413).send({ success: false, error: 'csv_too_large' })
    if (b.apply !== undefined && typeof b.apply !== 'boolean') return reply.code(400).send({ success: false, error: 'apply_must_be_boolean' })
    try {
      const r = await importCsv(db(request), request.params.id, b.csv, { apply: b.apply === true, actor: request.user })
      return reply.send({
        success: true,
        data: { applied: r.applied, plan: r.plan, summary: r.summary, errors: r.errors, coverage: r.coverage },
      })
    } catch (err) { return fail(request, reply, err, 'matrix import') }
  })

  fastify.post('/workbench/plans/:id/signoff', writer, async (request, reply) => {
    const plan = await needPlan(request, reply)
    if (!plan) return
    const a = actorOf(request)
    const comment = typeof (request.body || {}).comment === 'string' ? request.body.comment.slice(0, 2000) : null
    try {
      const { rows } = await db(request).query('SELECT sign_off_plan($1, $2, $3, $4, $5) AS id', [request.params.id, a.id, a.name, a.role, comment])
      return reply.code(201).send({ success: true, data: { id: rows[0].id } })
    } catch (err) { return fail(request, reply, err, 'sign off') }
  })

  // Where a zone column stands in the council's review. Marking it reviewed names who did it; editing any decision in it
  // afterwards puts it back in review (migration 161). The plan stays provisional until it is approved or gazetted.
  const REVIEW_STATUSES = ['unreviewed', 'in_review', 'reviewed']
  fastify.post('/workbench/plans/:id/zone-types/:code/review', writer, async (request, reply) => {
    const plan = await needPlan(request, reply)
    if (!plan) return
    const b = request.body || {}
    if (!REVIEW_STATUSES.includes(b.status)) return reply.code(400).send({ success: false, error: 'bad_status' })
    const code = typeof request.params.code === 'string' ? request.params.code : ''
    if (!code || code.length > 200) return reply.code(400).send({ success: false, error: 'bad_zone_type' })
    const a = actorOf(request)
    const reviewer = typeof b.reviewer === 'string' && b.reviewer.trim() ? b.reviewer.trim().slice(0, 200) : a.name
    try {
      const { rows } = await db(request).query('SELECT id FROM plan_zone_type WHERE plan_instrument_id = $1 AND code = $2', [request.params.id, code])
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      await db(request).query('SELECT set_zone_type_review($1, $2, $3, $4, $5)', [rows[0].id, b.status, reviewer, a.id, a.role])
      return reply.send({ success: true, data: { zone_type: code, review_status: b.status, reviewer: b.status === 'reviewed' ? reviewer : null } })
    } catch (err) { return fail(request, reply, err, 'review zone type') }
  })

  fastify.post('/workbench/plans/:id/status', writer, async (request, reply) => {
    const plan = await needPlan(request, reply)
    if (!plan) return
    const b = request.body || {}
    if (typeof b.status !== 'string') return reply.code(400).send({ success: false, error: 'status_required' })
    if (b.effective_from !== undefined && b.effective_from !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.effective_from))) {
      return reply.code(400).send({ success: false, error: 'bad_effective_from' })
    }
    if (b.gazette_ref !== undefined && b.gazette_ref !== null && (typeof b.gazette_ref !== 'string' || b.gazette_ref.length > 200)) {
      return reply.code(400).send({ success: false, error: 'bad_gazette_ref' })
    }
    const a = actorOf(request)
    try {
      const { rows } = await db(request).query('SELECT set_plan_status($1, $2, $3, $4, $5, $6) AS status',
        [request.params.id, b.status, a.id, a.role, b.gazette_ref || null, b.effective_from || null])
      return reply.send({ success: true, data: { status: rows[0].status } })
    } catch (err) { return fail(request, reply, err, 'set plan status') }
  })

  fastify.post('/workbench/plans/:id/version', writer, async (request, reply) => {
    const plan = await needPlan(request, reply)
    if (!plan) return
    const a = actorOf(request)
    try {
      const { rows } = await db(request).query('SELECT new_plan_version($1, $2, $3) AS id', [request.params.id, a.id, a.role])
      return reply.code(201).send({ success: true, data: { id: rows[0].id } })
    } catch (err) { return fail(request, reply, err, 'new plan version') }
  })
}

module.exports = { planWorkbenchRoutes, ruleRefusal }
