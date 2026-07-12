/**
 * Plan auto-review routes.
 *
 *   POST /api/applications/:appId/plan-reviews   Citizen uploads a plan
 *   GET  /api/applications/:appId/plan-reviews   Citizen + staff list
 *   GET  /api/plan-reviews/:id                   Citizen owner / staff
 *   POST /api/plan-reviews/:id/decide            Staff staff_approved | staff_rejected
 *
 * The upload endpoint:
 *   1. saves the file under uploads/plan-reviews/<appId>/<id>.{pdf,dwg,dxf}
 *   2. runs runDeterministicChecks() and inserts plan_review_findings
 *   3. sets plan_reviews.status from those findings
 *   4. returns the row + findings
 *
 * Citizens see WARN findings as advisory but can still submit.
 * ERROR findings prevent submission to the planner queue (the citizen
 * needs to upload a corrected plan first).
 */

const path = require('node:path')
const fs   = require('node:fs/promises')
const fsSync = require('node:fs')
const crypto = require('node:crypto')

const { requireAuth, requireRole } = require('../middleware/jwtAuth')
const planReview = require('../services/planReview')
const { scanBuffer } = require('../services/malwareScan')

const PLAN_ROOT = process.env.PLAN_REVIEW_ROOT
  ? path.resolve(process.env.PLAN_REVIEW_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'plan-reviews')

const MAX_PLAN_BYTES = 60 * 1024 * 1024
const ALLOWED_PLAN_MIME = new Set([
  'application/pdf',
  'application/acad', 'application/x-dwg', 'image/vnd.dwg',
  'application/dxf',  'application/x-dxf',  'image/x-dxf',
  'application/octet-stream', // Tolerated for raw .dwg uploads
])

const STAFF_ROLES = ['admin', 'planner', 'eo', 'env_officer', 'planning_clerk', 'building_inspector', 'surveyor', 'gis_officer']

const isString = (v, max = 4096) =>
  typeof v === 'string' && v.length > 0 && v.length <= max

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

function reviewDTO(row) {
  return {
    id:             row.id,
    applicationId:  row.application_id,
    uploadedBy:     row.uploaded_by,
    storageUrl:     row.storage_url,
    mimeType:       row.mime_type,
    bytes:          Number(row.bytes),
    sha256Hex:      row.sha256_hex,
    status:         row.status,
    notes:          row.notes,
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
  }
}

async function planReviewRoutes(fastify) {
  try { await ensureDir(PLAN_ROOT) } catch { /* noop */ }

  // ── Upload + auto-review ────────────────────────────────────────────
  fastify.post('/applications/:appId/plan-reviews', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { appId } = request.params
      // Verify application ownership.
      const { rows: appRows } = await fastify.pg.query(
        `SELECT id, user_id FROM development_applications WHERE id = $1`,
        [appId],
      )
      const app = appRows[0]
      if (!app) return reply.code(404).send({ success: false, error: 'application_not_found' })
      if (app.user_id !== request.user.id && !STAFF_ROLES.includes(request.user.role)) {
        return reply.code(403).send({ success: false, error: 'forbidden' })
      }

      if (!request.isMultipart()) {
        return reply.code(415).send({ success: false, error: 'expected_multipart' })
      }

      let file = null
      const parts = request.parts({ limits: { fileSize: MAX_PLAN_BYTES, files: 1 } })
      for await (const part of parts) {
        if (part.type === 'file') {
          if (file) { await part.toBuffer().catch(() => null); continue }
          if (!ALLOWED_PLAN_MIME.has(part.mimetype)) {
            return reply.code(415).send({
              success: false, error: 'bad_mime',
              message: `Allowed: ${[...ALLOWED_PLAN_MIME].join(', ')}`,
            })
          }
          const buf = await part.toBuffer()
          if (!buf || buf.length === 0) {
            return reply.code(400).send({ success: false, error: 'empty_file' })
          }
          file = { mimetype: part.mimetype, filename: part.filename, buffer: buf }
        }
      }
      if (!file) return reply.code(400).send({ success: false, error: 'no_file' })

      // Malware scan (H7) before the plan is persisted. clamd (when configured)
      // scans all types; the heuristic fallback covers EICAR + executables.
      const scan = await scanBuffer(file.buffer, { mime: file.mimetype, log: request.log })
      if (!scan.clean) {
        request.log.warn({ signature: scan.signature, engine: scan.engine }, 'rejected infected building plan')
        return reply.code(422).send({ success: false, error: 'malware_detected', message: 'This file failed a security scan and was not accepted.' })
      }

      // Run deterministic checks BEFORE persisting — gives us the
      // sha256 + the kind so we can de-dup and pick the right extension.
      const det = planReview.runDeterministicChecks({
        buffer: file.buffer, mime: file.mimetype, bytes: file.buffer.length,
        allowedKinds: ['pdf', 'dwg', 'dxf'],
      })

      // Dedup against same file already submitted for this application.
      if (det.sha256_hex) {
        const dup = await fastify.pg.query(
          `SELECT id, status FROM plan_reviews WHERE application_id = $1 AND sha256_hex = $2`,
          [appId, det.sha256_hex],
        )
        if (dup.rows[0]) {
          return reply.code(409).send({
            success: false, error: 'duplicate',
            existingId: dup.rows[0].id,
            message: 'This exact plan has already been uploaded for this application.',
          })
        }
      }

      const id = crypto.randomUUID()
      const ext = ({ pdf: '.pdf', dwg: '.dwg', dxf: '.dxf' })[det.kind] || ''
      const dir = path.join(PLAN_ROOT, appId)
      await ensureDir(dir)
      const diskPath = path.join(dir, `${id}${ext}`)
      const storageUrl = `/uploads/plan-reviews/${appId}/${id}${ext}`

      await fs.writeFile(diskPath, file.buffer)

      // Insert row + findings inside a single transaction.
      const client = await fastify.pg.connect()
      try {
        await client.query('BEGIN')
        const status = planReview.statusFromFindings(det.findings)

        const { rows } = await client.query(
          `INSERT INTO plan_reviews
             (id, application_id, uploaded_by, storage_url, mime_type, bytes, sha256_hex, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [id, appId, request.user.id, storageUrl, file.mimetype, file.buffer.length, det.sha256_hex, status],
        )
        const inserted = rows[0]

        for (const f of det.findings) {
          await client.query(
            `INSERT INTO plan_review_findings (review_id, severity, code, message, source, bbox)
             VALUES ($1, $2, $3, $4, $5::JSONB, $6::JSONB)`,
            [
              inserted.id, f.severity, f.code, f.message,
              f.source ? JSON.stringify(f.source) : null,
              f.bbox   ? JSON.stringify(f.bbox)   : null,
            ],
          )
        }
        await client.query('COMMIT')

        return reply.send({
          success: true,
          data: { ...reviewDTO(inserted), findings: det.findings },
        })
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    } catch (err) {
      if (err && err.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ success: false, error: 'too_large' })
      }
      request.log.error({ err }, 'plan upload failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── List for application ────────────────────────────────────────────
  fastify.get('/applications/:appId/plan-reviews', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { appId } = request.params
      const { rows: appRows } = await fastify.pg.query(
        `SELECT user_id FROM development_applications WHERE id = $1`,
        [appId],
      )
      const app = appRows[0]
      if (!app) return reply.code(404).send({ success: false, error: 'application_not_found' })
      const u = request.user
      if (app.user_id !== u.id && !STAFF_ROLES.includes(u.role)) {
        return reply.code(403).send({ success: false, error: 'forbidden' })
      }
      const { rows } = await fastify.pg.query(
        `SELECT * FROM plan_reviews WHERE application_id = $1 ORDER BY created_at DESC`,
        [appId],
      )
      return reply.send({ success: true, data: rows.map(reviewDTO) })
    } catch (err) {
      request.log.error({ err }, 'plan list failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Single + findings ───────────────────────────────────────────────
  fastify.get('/plan-reviews/:id', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT pr.*, da.user_id AS owner_user_id
         FROM plan_reviews pr
         LEFT JOIN development_applications da ON da.id = pr.application_id
         WHERE pr.id = $1`,
        [request.params.id],
      )
      const row = rows[0]
      if (!row) return reply.code(404).send({ success: false, error: 'not_found' })
      const u = request.user
      if (row.owner_user_id !== u.id && !STAFF_ROLES.includes(u.role)) {
        return reply.code(403).send({ success: false, error: 'forbidden' })
      }
      const { rows: findings } = await fastify.pg.query(
        `SELECT id, severity, code, message, source, bbox, created_at
         FROM plan_review_findings
         WHERE review_id = $1
         ORDER BY
           CASE severity WHEN 'error' THEN 1 WHEN 'warn' THEN 2 ELSE 3 END,
           id`,
        [row.id],
      )
      return reply.send({ success: true, data: { ...reviewDTO(row), findings } })
    } catch (err) {
      request.log.error({ err }, 'plan get failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Staff decide ────────────────────────────────────────────────────
  fastify.post('/plan-reviews/:id/decide', { preHandler: requireRole(fastify, STAFF_ROLES) }, async (request, reply) => {
    try {
      const { id } = request.params
      const { decision, notes } = request.body || {}
      if (!['staff_approved', 'staff_rejected'].includes(decision)) {
        return reply.code(400).send({ success: false, error: 'bad_decision' })
      }
      const { rows } = await fastify.pg.query(
        `UPDATE plan_reviews SET status = $2, notes = COALESCE($3, notes), updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, decision, isString(notes, 4000) ? notes : null],
      )
      const row = rows[0]
      if (!row) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: reviewDTO(row) })
    } catch (err) {
      request.log.error({ err }, 'plan decide failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

module.exports = { planReviewRoutes }
