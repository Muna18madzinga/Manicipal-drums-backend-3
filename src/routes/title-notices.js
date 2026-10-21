/**
 * Section 73 notices (Rural District Councils Act).
 * Staff draft, issue, serve, record the Administrative Court appeal, and act
 * only when the database stage is may_act. The person served reads their own
 * notice and the 28-day window.
 */
const { requireAuth, requireRole } = require('../middleware/jwtAuth')
const { DRAFTERS, ISSUERS, RECORDERS, ACTORS, noticeText } = require('../services/titleNotice')

const isStr = (v, max = 4000) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
const CLASSES = new Set(['use_restriction', 'building_requirements', 'scheme_or_plan', 'other'])
const ACTIONS = new Set(['demolish', 'prohibit_use', 'execute_work'])
const PARTIES = new Set(['owner', 'occupier', 'both'])
const METHODS = new Set(['personal', 'registered_post', 'affixed'])
const OUTCOMES = new Set(['dismissed', 'allowed', 'withdrawn', 'abandoned'])

const LIST_SQL = `
  SELECT n.*, council_ops.title_notice_stage(n.id) AS stage
    FROM council_ops.title_notice n`

async function titleNoticeRoutes(fastify) {
  const pg = fastify.pg
  const draft = { preHandler: requireRole(fastify, DRAFTERS) }
  const issue = { preHandler: requireRole(fastify, ISSUERS) }
  const record = { preHandler: requireRole(fastify, RECORDERS) }
  const act = { preHandler: requireRole(fastify, ACTORS) }
  const auth = { preHandler: requireAuth(fastify) }

  fastify.get('/title-notices', record, async (_req, reply) => {
    const { rows } = await pg.query(`${LIST_SQL} ORDER BY n.created_at DESC LIMIT 200`)
    return reply.send({ success: true, data: rows })
  })

  fastify.get('/title-notices/mine', auth, async (request, reply) => {
    const { rows } = await pg.query(
      `${LIST_SQL}
        WHERE n.status = 'issued'
          AND (
            EXISTS (
              SELECT 1 FROM council_ops.title_notice_service s
               WHERE s.notice_id = n.id AND lower(s.party_email) = lower($1)
            )
            OR EXISTS (
              SELECT 1 FROM spatial_planning.permit_application pa
               WHERE pa.created_by = $2 AND upper(pa.stand_number) = upper(n.stand_number)
            )
          )
        ORDER BY n.issued_at DESC NULLS LAST
        LIMIT 50`,
      [request.user.email, request.user.id],
    )
    const ids = rows.map((r) => r.id)
    let services = []
    if (ids.length) {
      const svc = await pg.query(
        `SELECT * FROM council_ops.title_notice_service WHERE notice_id = ANY($1::uuid[]) ORDER BY served_on`,
        [ids],
      )
      services = svc.rows
    }
    const data = rows.map((n) => ({
      ...n,
      notice_text: noticeText(n),
      services: services.filter((s) => s.notice_id === n.id),
    }))
    return reply.send({ success: true, data })
  })

  fastify.get('/title-notices/:id', record, async (request, reply) => {
    const { rows } = await pg.query(`${LIST_SQL} WHERE n.id = $1`, [request.params.id])
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    const [services, appeals, actions] = await Promise.all([
      pg.query('SELECT * FROM council_ops.title_notice_service WHERE notice_id = $1 ORDER BY served_on', [rows[0].id]),
      pg.query('SELECT * FROM council_ops.title_notice_appeal WHERE notice_id = $1 ORDER BY lodged_at', [rows[0].id]),
      pg.query('SELECT * FROM council_ops.title_notice_action WHERE notice_id = $1 ORDER BY taken_at', [rows[0].id]),
    ])
    return reply.send({
      success: true,
      data: {
        ...rows[0],
        notice_text: noticeText(rows[0]),
        services: services.rows,
        appeals: appeals.rows,
        actions: actions.rows,
      },
    })
  })

  fastify.post('/title-notices', draft, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.stand_number, 60) || !isStr(b.condition_text, 4000) || !isStr(b.grounds, 4000)) {
      return reply.code(400).send({ success: false, error: 'stand_number, condition_text and grounds required' })
    }
    if (!CLASSES.has(b.condition_class) || !ACTIONS.has(b.proposed_action)) {
      return reply.code(400).send({ success: false, error: 'bad_class_or_action' })
    }
    const { rows } = await pg.query(
      `INSERT INTO council_ops.title_notice
         (stand_number, condition_text, condition_class, proposed_action, grounds,
          wilful, work_description, no_occupier_reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [b.stand_number.trim(), b.condition_text.trim(), b.condition_class, b.proposed_action,
        b.grounds.trim(), b.wilful === true, b.work_description || null,
        b.no_occupier_reason || null, request.user.id],
    )
    return reply.code(201).send({ success: true, data: rows[0] })
  })

  fastify.post('/title-notices/:id/issue', issue, async (request, reply) => {
    const { rows: cur } = await pg.query('SELECT * FROM council_ops.title_notice WHERE id = $1', [request.params.id])
    const n = cur[0]
    if (!n) return reply.code(404).send({ success: false, error: 'not_found' })
    if (n.status !== 'draft') return reply.code(409).send({ success: false, error: 'not_draft' })
    if (n.proposed_action === 'demolish' && !n.wilful) {
      return reply.code(400).send({ success: false, error: 'demolition_requires_wilful' })
    }
    if (n.proposed_action === 'execute_work' && !n.work_description) {
      return reply.code(400).send({ success: false, error: 'work_description_required' })
    }
    const { rows } = await pg.query(
      `UPDATE council_ops.title_notice
          SET status = 'issued', issued_at = now(), issued_by = $2
        WHERE id = $1 AND status = 'draft'
        RETURNING *`,
      [request.params.id, request.user.id],
    )
    const stage = await pg.query('SELECT council_ops.title_notice_stage($1) AS stage', [rows[0].id])
    return reply.send({ success: true, data: { ...rows[0], stage: stage.rows[0].stage, notice_text: noticeText(rows[0]) } })
  })

  fastify.post('/title-notices/:id/withdraw', issue, async (request, reply) => {
    const reason = request.body?.reason
    if (!isStr(reason, 1000)) return reply.code(400).send({ success: false, error: 'reason required' })
    const { rows } = await pg.query(
      `UPDATE council_ops.title_notice
          SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = $2, withdraw_reason = $3
        WHERE id = $1 AND status = 'issued'
        RETURNING *, council_ops.title_notice_stage(id) AS stage`,
      [request.params.id, request.user.id, reason.trim()],
    )
    if (!rows[0]) return reply.code(409).send({ success: false, error: 'not_issued' })
    return reply.send({ success: true, data: rows[0] })
  })

  fastify.post('/title-notices/:id/service', record, async (request, reply) => {
    const b = request.body || {}
    if (!PARTIES.has(b.party) || !METHODS.has(b.method) || !isStr(b.party_name, 200) || !isDate(b.served_on)) {
      return reply.code(400).send({ success: false, error: 'party, party_name, served_on and method required' })
    }
    const { rows: n } = await pg.query(
      `SELECT status FROM council_ops.title_notice WHERE id = $1`, [request.params.id])
    if (!n[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    if (n[0].status !== 'issued') return reply.code(409).send({ success: false, error: 'notice_not_issued' })
    const { rows } = await pg.query(
      `INSERT INTO council_ops.title_notice_service
         (notice_id, party, party_name, party_email, served_on, method, proof, served_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [request.params.id, b.party, b.party_name.trim(), b.party_email || null,
        b.served_on, b.method, b.proof || null, request.user.id],
    )
    const stage = await pg.query('SELECT council_ops.title_notice_stage($1) AS stage', [request.params.id])
    return reply.code(201).send({ success: true, data: rows[0], stage: stage.rows[0].stage })
  })

  fastify.post('/title-notices/:id/appeals', record, async (request, reply) => {
    const b = request.body || {}
    if (!isDate(b.lodged_at)) return reply.code(400).send({ success: false, error: 'lodged_at required' })
    const { rows: svc } = await pg.query(
      `SELECT MIN(served_on) AS first_served FROM council_ops.title_notice_service WHERE notice_id = $1`,
      [request.params.id],
    )
    if (!svc[0]?.first_served) return reply.code(409).send({ success: false, error: 'serve_before_appeal' })
    const served = svc[0].first_served
    const firstServed = served instanceof Date ? served.toISOString().slice(0, 10) : String(served).slice(0, 10)
    if (b.lodged_at < firstServed) {
      return reply.code(400).send({ success: false, error: 'appeal_before_service' })
    }
    const { rows } = await pg.query(
      `INSERT INTO council_ops.title_notice_appeal (notice_id, lodged_at, court_ref, notes, recorded_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [request.params.id, b.lodged_at, b.court_ref || null, b.notes || null, request.user.id],
    )
    const stage = await pg.query('SELECT council_ops.title_notice_stage($1) AS stage', [request.params.id])
    return reply.code(201).send({ success: true, data: rows[0], stage: stage.rows[0].stage })
  })

  fastify.patch('/title-notices/appeals/:appealId', record, async (request, reply) => {
    const b = request.body || {}
    if (!OUTCOMES.has(b.outcome) || !isDate(b.decided_at)) {
      return reply.code(400).send({ success: false, error: 'outcome and decided_at required' })
    }
    const { rows } = await pg.query(
      `UPDATE council_ops.title_notice_appeal
          SET outcome = $2, decided_at = $3, notes = COALESCE($4, notes)
        WHERE id = $1 AND outcome IS NULL
        RETURNING *`,
      [request.params.appealId, b.outcome, b.decided_at, b.notes || null],
    )
    if (!rows[0]) return reply.code(409).send({ success: false, error: 'appeal_already_decided' })
    const stage = await pg.query('SELECT council_ops.title_notice_stage($1) AS stage', [rows[0].notice_id])
    return reply.send({ success: true, data: rows[0], stage: stage.rows[0].stage })
  })

  fastify.post('/title-notices/:id/actions', act, async (request, reply) => {
    const b = request.body || {}
    if (!ACTIONS.has(b.action)) return reply.code(400).send({ success: false, error: 'action required' })
    try {
      const { rows } = await pg.query(
        `INSERT INTO council_ops.title_notice_action (notice_id, action, notes, taken_by)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [request.params.id, b.action, b.notes || null, request.user.id],
      )
      return reply.code(201).send({ success: true, data: rows[0], stage: 'actioned' })
    } catch (err) {
      if (err.code === '23514') {
        return reply.code(409).send({
          success: false,
          error: 'action_refused',
          message: 'The council may act only when the notice is at may_act, and only as the notice said it would.',
        })
      }
      throw err
    }
  })

  fastify.post('/title-notices/:id/seen', auth, async (request, reply) => {
    const { rows } = await pg.query(
      `UPDATE council_ops.title_notice_service
          SET seen_at = COALESCE(seen_at, now())
        WHERE notice_id = $1 AND lower(party_email) = lower($2)
        RETURNING id, seen_at`,
      [request.params.id, request.user.email],
    )
    if (!rows.length) return reply.code(404).send({ success: false, error: 'not_your_notice' })
    return reply.send({ success: true, data: rows })
  })
}

module.exports = { titleNoticeRoutes }
