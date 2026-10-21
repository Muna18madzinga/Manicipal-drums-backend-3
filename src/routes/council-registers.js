/**
 * Statutory registers — RDC Act use cases that were previously not built:
 *   A5  by-law / tariff register (ss76, 88–94)
 *   P10 annual district development plan (s74)
 *   G11 compulsory acquisition (s78)
 *   C15 / X6 section 109 rates clearance
 *   F7  expense recovery (s151 / action costs)
 *
 * Tables: council_ops.* (migration 181).
 */
const { requireRole, requireAuth } = require('../middleware/jwtAuth')

const STAFF = [
  'admin', 'planner', 'planning_clerk', 'eo', 'gis_officer',
  'building_inspector', 'env_officer', 'surveyor',
]
const WRITERS = ['admin', 'planner', 'planning_clerk', 'eo']
const FINANCE_WRITERS = ['admin', 'planner', 'planning_clerk', 'eo']

const isStr = (v, max = 500) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max

async function ensureSchema(pg) {
  // Light touch: if migration 181 not applied, create via bootstrap path fails loudly.
  await pg.query('SELECT 1 FROM council_ops.bylaw_register LIMIT 0')
}

function certNo() {
  const y = new Date().getFullYear()
  const r = Math.floor(100000 + Math.random() * 900000)
  return `VRDC-S109-${y}-${r}`
}

async function councilRegistersRoutes(fastify) {
  const pg = fastify.pg
  const staff = { preHandler: requireRole(fastify, STAFF) }
  const write = { preHandler: requireRole(fastify, WRITERS) }
  const auth = { preHandler: requireAuth(fastify) }

  // ── A5 By-law register ──────────────────────────────────────────────
  fastify.get('/registers/bylaws', staff, async (request, reply) => {
    await ensureSchema(pg)
    const status = request.query?.status
    const params = []
    let where = ''
    if (isStr(status, 40)) {
      params.push(status)
      where = `WHERE status = $${params.length}`
    }
    const { rows } = await pg.query(
      `SELECT * FROM council_ops.bylaw_register ${where} ORDER BY updated_at DESC LIMIT 200`,
      params,
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.post('/registers/bylaws', write, async (request, reply) => {
    await ensureSchema(pg)
    const b = request.body || {}
    if (!isStr(b.title, 300) || !isStr(b.kind, 40)) {
      return reply.code(400).send({ success: false, error: 'title and kind required' })
    }
    const { rows } = await pg.query(
      `INSERT INTO council_ops.bylaw_register
         (kind, title, reference_no, chapter_code, area_scope, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'draft'),$7,$8)
       RETURNING *`,
      [b.kind, b.title.trim(), b.reference_no || null, b.chapter_code || null,
        b.area_scope || null, b.status || 'draft', b.notes || null, request.user.id],
    )
    return reply.code(201).send({ success: true, data: rows[0] })
  })

  fastify.patch('/registers/bylaws/:id', write, async (request, reply) => {
    await ensureSchema(pg)
    const b = request.body || {}
    const { rows } = await pg.query(
      `UPDATE council_ops.bylaw_register SET
         status = COALESCE($2, status),
         minister_approved_at = COALESCE($3::date, minister_approved_at),
         in_force_from = COALESCE($4::date, in_force_from),
         passed_at = COALESCE($5::date, passed_at),
         notes = COALESCE($6, notes),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [request.params.id, b.status || null, b.minister_approved_at || null,
        b.in_force_from || null, b.passed_at || null, b.notes || null],
    )
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    return reply.send({ success: true, data: rows[0] })
  })

  // ── P10 Annual district plan ────────────────────────────────────────
  fastify.get('/registers/annual-plans', staff, async (_request, reply) => {
    await ensureSchema(pg)
    const { rows } = await pg.query(
      `SELECT *, (deadline_1_august < CURRENT_DATE AND status NOT IN ('council_approved','submitted_provincial','superseded')) AS past_deadline
         FROM council_ops.annual_district_plan
        ORDER BY plan_year DESC LIMIT 50`,
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.post('/registers/annual-plans', write, async (request, reply) => {
    await ensureSchema(pg)
    const b = request.body || {}
    const year = Number(b.plan_year)
    if (!Number.isInteger(year) || !isStr(b.title, 300)) {
      return reply.code(400).send({ success: false, error: 'plan_year and title required' })
    }
    const { rows } = await pg.query(
      `INSERT INTO council_ops.annual_district_plan (plan_year, title, summary, status, created_by)
       VALUES ($1,$2,$3,COALESCE($4,'draft'),$5)
       ON CONFLICT (plan_year) DO UPDATE SET title = EXCLUDED.title, summary = EXCLUDED.summary, updated_at = now()
       RETURNING *`,
      [year, b.title.trim(), b.summary || null, b.status || 'draft', request.user.id],
    )
    return reply.code(201).send({ success: true, data: rows[0] })
  })

  fastify.patch('/registers/annual-plans/:id', write, async (request, reply) => {
    await ensureSchema(pg)
    const b = request.body || {}
    const { rows } = await pg.query(
      `UPDATE council_ops.annual_district_plan SET
         status = COALESCE($2, status),
         council_approved_at = CASE WHEN $2 = 'council_approved' THEN COALESCE($3::date, CURRENT_DATE) ELSE council_approved_at END,
         submitted_provincial_at = CASE WHEN $2 = 'submitted_provincial' THEN COALESCE($4::date, CURRENT_DATE) ELSE submitted_provincial_at END,
         summary = COALESCE($5, summary),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [request.params.id, b.status || null, b.council_approved_at || null,
        b.submitted_provincial_at || null, b.summary || null],
    )
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    return reply.send({ success: true, data: rows[0] })
  })

  // ── G11 Compulsory acquisition ──────────────────────────────────────
  fastify.get('/registers/acquisitions', staff, async (_request, reply) => {
    await ensureSchema(pg)
    const { rows } = await pg.query(
      `SELECT * FROM council_ops.compulsory_acquisition ORDER BY created_at DESC LIMIT 200`,
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.post('/registers/acquisitions', write, async (request, reply) => {
    await ensureSchema(pg)
    const b = request.body || {}
    if (!isStr(b.purpose, 40)) {
      return reply.code(400).send({ success: false, error: 'purpose required' })
    }
    const { rows } = await pg.query(
      `INSERT INTO council_ops.compulsory_acquisition
         (stand_number, parcel_ref, purpose, purpose_detail, status, notes, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5,'proposed'),$6,$7) RETURNING *`,
      [b.stand_number || null, b.parcel_ref || null, b.purpose, b.purpose_detail || null,
        b.status || 'proposed', b.notes || null, request.user.id],
    )
    return reply.code(201).send({ success: true, data: rows[0] })
  })

  fastify.patch('/registers/acquisitions/:id', write, async (request, reply) => {
    await ensureSchema(pg)
    const b = request.body || {}
    const { rows } = await pg.query(
      `UPDATE council_ops.compulsory_acquisition SET
         status = COALESCE($2, status),
         minister_consent_ref = COALESCE($3, minister_consent_ref),
         minister_consented_at = COALESCE($4::date, minister_consented_at),
         gazette_ref = COALESCE($5, gazette_ref),
         notes = COALESCE($6, notes),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [request.params.id, b.status || null, b.minister_consent_ref || null,
        b.minister_consented_at || null, b.gazette_ref || null, b.notes || null],
    )
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    return reply.send({ success: true, data: rows[0] })
  })

  // ── C15 Section 109 rates clearance ─────────────────────────────────
  // Citizen can request; staff review/issue.
  fastify.get('/registers/rates-clearances', staff, async (request, reply) => {
    await ensureSchema(pg)
    const stand = request.query?.stand_number
    const params = []
    let where = ''
    if (isStr(stand, 60)) {
      params.push(stand)
      where = `WHERE stand_number = $${params.length}`
    }
    const { rows } = await pg.query(
      `SELECT * FROM council_ops.rates_clearance ${where} ORDER BY created_at DESC LIMIT 200`,
      params,
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.get('/registers/rates-clearances/mine', auth, async (request, reply) => {
    await ensureSchema(pg)
    const { rows } = await pg.query(
      `SELECT id, stand_number, applicant_name, status, certificate_no, issued_at, valid_until, created_at
         FROM council_ops.rates_clearance
        WHERE requested_by = $1
        ORDER BY created_at DESC LIMIT 50`,
      [request.user.id],
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.post('/registers/rates-clearances', auth, async (request, reply) => {
    await ensureSchema(pg)
    const b = request.body || {}
    if (!isStr(b.stand_number, 60) || !isStr(b.applicant_name, 200)) {
      return reply.code(400).send({ success: false, error: 'stand_number and applicant_name required' })
    }
    // Pull assessment balance when present (ERP link may fill this later).
    let outstanding = null
    let band = null
    try {
      const { rows: pr } = await pg.query(
        `SELECT pa.rates_balance
           FROM spatial_planning.property p
           LEFT JOIN spatial_planning.property_assessment pa ON pa.property_id = p.id
          WHERE UPPER(p.stand_number) = UPPER($1) LIMIT 1`,
        [b.stand_number.trim()],
      )
      if (pr[0]?.rates_balance != null) {
        outstanding = Number(pr[0].rates_balance)
        band = outstanding > 0 ? 'arrears' : 'paid_up'
      }
    } catch { /* thin DB */ }

    const { rows } = await pg.query(
      `INSERT INTO council_ops.rates_clearance
         (stand_number, applicant_name, applicant_email, charges_outstanding_usd, erp_status_band, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.stand_number.trim(), b.applicant_name.trim(), b.applicant_email || request.user.email || null,
        outstanding, band, request.user.id],
    )
    return reply.code(201).send({ success: true, data: rows[0] })
  })

  fastify.post('/registers/rates-clearances/:id/decide', {
    preHandler: requireRole(fastify, FINANCE_WRITERS),
  }, async (request, reply) => {
    await ensureSchema(pg)
    const b = request.body || {}
    const decision = b.decision === 'refuse' ? 'refused' : 'cleared'
    if (decision === 'refused' && !isStr(b.refusal_reason, 500)) {
      return reply.code(400).send({ success: false, error: 'refusal_reason required' })
    }
    const outstanding = b.charges_outstanding_usd != null ? Number(b.charges_outstanding_usd) : null
    if (decision === 'cleared' && outstanding != null && outstanding > 0) {
      return reply.code(400).send({
        success: false,
        error: 'cannot_clear_with_arrears',
        message: 'Section 109 requires all charges for the period to be paid.',
      })
    }
    const no = decision === 'cleared' ? certNo() : null
    const { rows } = await pg.query(
      `UPDATE council_ops.rates_clearance SET
         status = $2,
         charges_outstanding_usd = COALESCE($3, charges_outstanding_usd),
         certificate_no = COALESCE($4, certificate_no),
         issued_at = CASE WHEN $2 = 'cleared' THEN now() ELSE issued_at END,
         valid_until = CASE WHEN $2 = 'cleared' THEN (CURRENT_DATE + 90) ELSE valid_until END,
         refusal_reason = $5,
         reviewed_by = $6,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [request.params.id, decision, outstanding, no, b.refusal_reason || null, request.user.id],
    )
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    return reply.send({ success: true, data: rows[0] })
  })

  // Paper hand-off of an issued certificate to the Deeds Registry (X6).
  fastify.post('/registers/rates-clearances/:id/handoff', {
    preHandler: requireRole(fastify, FINANCE_WRITERS),
  }, async (request, reply) => {
    await ensureSchema(pg)
    const ref = request.body?.deeds_handoff_ref
    if (!isStr(ref, 80)) {
      return reply.code(400).send({ success: false, error: 'deeds_handoff_ref required' })
    }
    const { rows } = await pg.query(
      `UPDATE council_ops.rates_clearance SET
         deeds_handoff_at = now(),
         deeds_handoff_ref = $2,
         deeds_handed_by = $3,
         updated_at = now()
       WHERE id = $1 AND status = 'cleared'
       RETURNING *`,
      [request.params.id, ref.trim(), request.user.id],
    )
    if (!rows[0]) return reply.code(409).send({ success: false, error: 'clearance_not_issued' })
    return reply.send({ success: true, data: rows[0] })
  })

  // G10 — Minister's approval of an estate layout (RDC Act s86).
  fastify.get('/registers/estate-approvals', staff, async (_req, reply) => {
    const { rows } = await pg.query(
      `SELECT * FROM council_ops.estate_development_approval ORDER BY created_at DESC LIMIT 200`,
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.post('/registers/estate-approvals', write, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.title, 300)) return reply.code(400).send({ success: false, error: 'title required' })
    const { rows } = await pg.query(
      `INSERT INTO council_ops.estate_development_approval (title, area_scope, notes, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [b.title.trim(), b.area_scope || null, b.notes || null, request.user.id],
    )
    return reply.code(201).send({ success: true, data: rows[0] })
  })

  fastify.patch('/registers/estate-approvals/:id', write, async (request, reply) => {
    const b = request.body || {}
    const next = b.status
    const allowed = new Set(['draft', 'advertised', 'awaiting_minister', 'approved', 'refused'])
    if (next && !allowed.has(next)) return reply.code(400).send({ success: false, error: 'bad_status' })
    if (next === 'approved' && !isStr(b.minister_ref, 80)) {
      return reply.code(400).send({ success: false, error: 'minister_ref required' })
    }
    const { rows } = await pg.query(
      `UPDATE council_ops.estate_development_approval SET
         status = COALESCE($2, status),
         advertised_at = CASE WHEN $2 = 'advertised' THEN COALESCE(advertised_at, CURRENT_DATE) ELSE advertised_at END,
         objections_close_at = CASE
           WHEN $2 = 'advertised' THEN COALESCE(objections_close_at, CURRENT_DATE + 21)
           ELSE objections_close_at END,
         minister_ref = COALESCE($3, minister_ref),
         minister_approved_at = CASE WHEN $2 = 'approved' THEN COALESCE($4::date, CURRENT_DATE) ELSE minister_approved_at END,
         notes = COALESCE($5, notes),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [request.params.id, next || null, b.minister_ref || null, b.minister_approved_at || null, b.notes || null],
    )
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    if (rows[0].status === 'approved' && rows[0].objections_close_at
        && new Date(rows[0].objections_close_at) > new Date()) {
      return reply.send({
        success: true,
        data: rows[0],
        warning: 'Objections are still open. Allocation waits until the advertised period has closed.',
      })
    }
    return reply.send({ success: true, data: rows[0] })
  })

  // ── F7 Expense recovery ─────────────────────────────────────────────
  fastify.get('/registers/expense-recoveries', staff, async (_request, reply) => {
    await ensureSchema(pg)
    const { rows } = await pg.query(
      `SELECT * FROM council_ops.expense_recovery ORDER BY created_at DESC LIMIT 200`,
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.post('/registers/expense-recoveries', write, async (request, reply) => {
    await ensureSchema(pg)
    const b = request.body || {}
    const amount = Number(b.amount_usd)
    if (!isStr(b.description, 500) || !Number.isFinite(amount) || amount < 0) {
      return reply.code(400).send({ success: false, error: 'description and amount_usd required' })
    }
    const { rows } = await pg.query(
      `INSERT INTO council_ops.expense_recovery
         (title_notice_id, stand_number, description, amount_usd, status, notes, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5,'assessed'),$6,$7) RETURNING *`,
      [b.title_notice_id || null, b.stand_number || null, b.description.trim(), amount,
        b.status || 'assessed', b.notes || null, request.user.id],
    )
    return reply.code(201).send({ success: true, data: rows[0] })
  })

  fastify.patch('/registers/expense-recoveries/:id', write, async (request, reply) => {
    await ensureSchema(pg)
    const b = request.body || {}
    const recovered = b.recovered_usd != null ? Number(b.recovered_usd) : null
    const { rows } = await pg.query(
      `UPDATE council_ops.expense_recovery SET
         status = COALESCE($2, status),
         recovered_usd = COALESCE($3, recovered_usd),
         notes = COALESCE($4, notes),
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [request.params.id, b.status || null, recovered, b.notes || null],
    )
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    return reply.send({ success: true, data: rows[0] })
  })
}

module.exports = { councilRegistersRoutes }
