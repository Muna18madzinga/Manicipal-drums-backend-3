// src/routes/gms-integration.js
// ─────────────────────────────────────────────────────────────────────────
// GMS <-> ERP integration console and endpoints.
//
//   POST /integration/inbound                     ERP, HMAC-signed (ERP_INBOUND_SECRET)
//   GET  /integration/status                      integrationView   health panel
//   GET  /integration/events                      integrationView   ?status&type&limit&offset
//   GET  /integration/events/:id                  integrationView
//   POST /integration/events/:id/retry            integration
//   POST /integration/events/:id/cancel           integration
//   GET  /integration/reconciliation              integrationView   ?kind&status
//   POST /integration/reconciliation/run          integration
//   POST /integration/reconciliation/:id/assign   integration       { assigned_to }
//   POST /integration/reconciliation/:id/resolve  integration       { note }
//
// Also owns the outbox worker and the nightly reconciliation, started on
// onReady and stopped on onClose. opts.worker === false (tests) or
// GMS_WORKER=off turns both off; opts.erpAdapter overrides the adapter.
//
// Registered as its own encapsulated plugin because the inbound signature is
// over the raw body, so this scope's JSON parser keeps request.rawBody.
// ─────────────────────────────────────────────────────────────────────────

const { requireRole } = require('../middleware/jwtAuth')
const { GMS } = require('../services/gms/roles')
const { createErpAdapter } = require('../services/gms/erpAdapter')
const { deliverOne, deliverDue } = require('../services/gms/outbox')
const { runReconciliation } = require('../services/gms/reconciliation')
const { handleInbound, verifySignature, envelopeError } = require('../services/gms/inbound')

const tags = ['GMS integration']
const WORKER_TICK_MS = 30_000
const RECON_HOUR = 2 // local server time

const STATUSES = new Set(['pending', 'sent', 'acknowledged', 'failed', 'cancelled'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function gmsIntegrationRoutes(fastify, opts = {}) {
  const pg = fastify.pg
  const adapter = opts.erpAdapter || createErpAdapter()
  const viewer = { preHandler: requireRole(fastify, GMS.integrationView) }
  const operator = { preHandler: requireRole(fastify, GMS.integration) }

  fastify.removeContentTypeParser('application/json')
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body
    try {
      done(null, body ? JSON.parse(body) : {})
    } catch (err) {
      err.statusCode = 400
      done(err)
    }
  })

  fastify.post('/integration/inbound', { schema: { tags, summary: 'Receive a signed ERP event' } }, async (request, reply) => {
    if (!process.env.ERP_INBOUND_SECRET) {
      return reply.code(503).send({ success: false, error: 'inbound_not_configured' })
    }
    if (!verifySignature(request.rawBody || '', request.headers['x-erp-signature'], process.env.ERP_INBOUND_SECRET)) {
      return reply.code(401).send({ success: false, error: 'bad_signature' })
    }
    const bad = envelopeError(request.body)
    if (bad) return reply.code(400).send({ success: false, error: 'bad_envelope', field: bad })
    const result = await handleInbound(pg, request.body)
    // 200 either way: a duplicate is a success from the sender's view, which
    // is what stops it redelivering.
    return { success: true, ...result }
  })

  fastify.get('/integration/status', { ...viewer, schema: { tags, summary: 'Integration health' } }, async () => {
    const { rows: [s] } = await pg.query(`
      SELECT
        (SELECT max(acknowledged_at) FROM integration.outbox_event) AS last_acknowledged_at,
        (SELECT max(received_at) FROM integration.inbound_event) AS last_inbound_at,
        (SELECT count(*) FROM integration.outbox_event WHERE status = 'pending')::int AS queue_depth,
        (SELECT count(*) FROM integration.outbox_event WHERE status = 'failed')::int AS failed,
        (SELECT count(*) FROM integration.outbox_event
          WHERE occurred_at > now() - interval '24 hours')::int AS events_24h,
        (SELECT count(*) FROM integration.outbox_event
          WHERE occurred_at > now() - interval '24 hours' AND status = 'failed')::int AS failed_24h,
        (SELECT max(last_seen_at) FROM integration.reconciliation_item) AS last_reconciliation_at`)
    const { rows: recon } = await pg.query(
      `SELECT kind, count(*)::int AS open FROM integration.reconciliation_item
        WHERE status = 'open' GROUP BY kind ORDER BY kind`)
    return {
      success: true,
      data: {
        ...s,
        adapter: adapter.name,
        error_rate_24h: s.events_24h ? s.failed_24h / s.events_24h : 0,
        reconciliation_open: Object.fromEntries(recon.map((r) => [r.kind, r.open])),
      },
    }
  })

  fastify.get('/integration/events', { ...viewer, schema: { tags, summary: 'Outbox event log' } }, async (request, reply) => {
    const { status, type } = request.query || {}
    if (status && !STATUSES.has(status)) return reply.code(400).send({ success: false, error: 'bad_status' })
    const limit = Math.min(Number(request.query?.limit) || 100, 500)
    const offset = Math.max(Number(request.query?.offset) || 0, 0)
    const { rows } = await pg.query(
      `SELECT event_id, type, version, occurred_at, source, idempotency_key, status,
              attempts, next_attempt_at, last_error, acknowledged_at
         FROM integration.outbox_event
        WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR type = $2)
        ORDER BY occurred_at DESC LIMIT $3 OFFSET $4`,
      [status || null, type || null, limit, offset],
    )
    return { success: true, data: rows }
  })

  fastify.get('/integration/events/:id', { ...viewer, schema: { tags, summary: 'One event with its payload' } }, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).send({ success: false, error: 'not_found' })
    const { rows: [ev] } = await pg.query('SELECT * FROM integration.outbox_event WHERE event_id = $1', [request.params.id])
    if (!ev) return reply.code(404).send({ success: false, error: 'not_found' })
    return { success: true, data: ev }
  })

  fastify.post('/integration/events/:id/retry', { ...operator, schema: { tags, summary: 'Retry a failed event now' } }, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).send({ success: false, error: 'not_found' })
    const { rowCount } = await pg.query(
      `UPDATE integration.outbox_event SET status = 'pending', next_attempt_at = now()
        WHERE event_id = $1 AND status IN ('failed', 'pending')`,
      [request.params.id],
    )
    if (!rowCount) return reply.code(409).send({ success: false, error: 'not_retryable' })
    const result = await deliverOne(pg, adapter, request.params.id)
    return { success: true, data: result }
  })

  fastify.post('/integration/events/:id/cancel', { ...operator, schema: { tags, summary: 'Cancel an undelivered event' } }, async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).send({ success: false, error: 'not_found' })
    const { rowCount } = await pg.query(
      `UPDATE integration.outbox_event SET status = 'cancelled'
        WHERE event_id = $1 AND status IN ('failed', 'pending')`,
      [request.params.id],
    )
    if (!rowCount) return reply.code(409).send({ success: false, error: 'not_cancellable' })
    return { success: true }
  })

  fastify.get('/integration/reconciliation', { ...viewer, schema: { tags, summary: 'Reconciliation queues' } }, async (request) => {
    const { kind, status } = request.query || {}
    const { rows } = await pg.query(
      `SELECT r.*, u.email AS resolved_by_email
         FROM integration.reconciliation_item r
         LEFT JOIN public.users u ON u.id = r.resolved_by
        WHERE ($1::text IS NULL OR r.kind = $1) AND r.status = COALESCE($2, 'open')
        ORDER BY r.kind, r.ref_key LIMIT 1000`,
      [kind || null, status || null],
    )
    return { success: true, data: rows }
  })

  fastify.post('/integration/reconciliation/run', { ...operator, schema: { tags, summary: 'Run reconciliation now' } }, async () => {
    return { success: true, data: await runReconciliation(pg) }
  })

  fastify.post('/integration/reconciliation/:id/assign', { ...operator, schema: { tags, summary: 'Assign a reconciliation item' } }, async (request, reply) => {
    const to = typeof request.body?.assigned_to === 'string' ? request.body.assigned_to.trim().slice(0, 120) : ''
    if (!to) return reply.code(400).send({ success: false, error: 'missing_field', field: 'assigned_to' })
    const { rows: [r] } = await pg.query(
      `UPDATE integration.reconciliation_item SET assigned_to = $2
        WHERE id = $1 AND status = 'open' RETURNING *`,
      [Number(request.params.id) || 0, to],
    )
    if (!r) return reply.code(404).send({ success: false, error: 'not_found' })
    return { success: true, data: r }
  })

  fastify.post('/integration/reconciliation/:id/resolve', { ...operator, schema: { tags, summary: 'Resolve a reconciliation item with a note' } }, async (request, reply) => {
    const note = typeof request.body?.note === 'string' ? request.body.note.trim().slice(0, 2000) : ''
    if (!note) return reply.code(400).send({ success: false, error: 'missing_field', field: 'note' })
    const { rows: [r] } = await pg.query(
      `UPDATE integration.reconciliation_item
          SET status = 'resolved', resolution_note = $2, resolved_by = $3, resolved_at = now()
        WHERE id = $1 AND status = 'open' RETURNING *`,
      [Number(request.params.id) || 0, note, request.user.id],
    )
    if (!r) return reply.code(404).send({ success: false, error: 'not_found' })
    return { success: true, data: r }
  })

  // ── Worker ──────────────────────────────────────────────────────────
  if (opts.worker === false || process.env.GMS_WORKER === 'off') return

  let timer
  let lastReconDay = null
  let busy = false
  async function tick() {
    if (busy) return
    busy = true
    try {
      await deliverDue(pg, adapter)
      const now = new Date()
      const today = now.toDateString()
      if (now.getHours() >= RECON_HOUR && lastReconDay !== today) {
        lastReconDay = today
        const r = await runReconciliation(pg)
        fastify.log.info(r, 'nightly reconciliation ran')
      }
    } catch (err) {
      fastify.log.warn({ err }, 'GMS integration worker tick failed')
    } finally {
      busy = false
    }
  }
  fastify.addHook('onReady', async () => {
    timer = setInterval(tick, WORKER_TICK_MS)
    timer.unref()
  })
  fastify.addHook('onClose', async () => clearInterval(timer))
}

module.exports = { gmsIntegrationRoutes }
