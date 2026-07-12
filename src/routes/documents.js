/**
 * Citizen document upload + verification queue.
 *
 *   POST /api/documents                      Citizen uploads a doc
 *   GET  /api/documents/mine                 Citizen lists their docs
 *   GET  /api/documents/:id                  Citizen + staff
 *   GET  /api/documents/queue                Staff: pending docs
 *   POST /api/documents/:id/verify           Staff: pass / reject
 *   DELETE /api/documents/:id                Citizen (only when pending) / admin
 *
 * Rules:
 *   - Documents are stored on disk under uploads/citizen-documents/<userId>/
 *   - sha256 prevents the same file being uploaded twice for the same user.
 *   - Verification is performed via src/services/idVerifier.js. By default
 *     the manual verifier sets status='under_review'; a staff member moves
 *     it to verified | rejected via /verify.
 *   - Once verified, downstream code can trust extracted_id_number etc.
 */

const path = require('node:path')
const fs   = require('node:fs/promises')
const fsSync = require('node:fs')
const crypto = require('node:crypto')

const { requireAuth, requireRole } = require('../middleware/jwtAuth')
const idVerifier = require('../services/idVerifier')
const { scanBuffer } = require('../services/malwareScan')

const DOC_ROOT = process.env.CITIZEN_DOC_ROOT
  ? path.resolve(process.env.CITIZEN_DOC_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'citizen-documents')

const MAX_DOC_BYTES = 12 * 1024 * 1024
const ALLOWED_DOC_MIME = new Set([
  'image/jpeg', 'image/png', 'image/heic', 'image/webp',
  'application/pdf',
])

const VALID_KINDS = new Set([
  'national_id', 'passport', 'drivers_licence', 'proof_of_residence',
  'title_deed', 'company_registration', 'tax_clearance', 'other',
])

const STAFF_ROLES = ['admin', 'planning_clerk', 'planner', 'eo']

const isString = (v, max = 4096) =>
  typeof v === 'string' && v.length > 0 && v.length <= max

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

function docDTO(row) {
  // The verifier stores its machine assessment in verifier_payload (JSONB).
  // Surface the AI's recommendation + reason so the staff review queue can
  // show "AI says: pass/fail/uncertain" next to each document.
  const payload = row.verifier_payload && typeof row.verifier_payload === 'object'
    ? row.verifier_payload
    : {}
  return {
    id:                  row.id,
    userId:              row.user_id,
    docKind:             row.doc_kind,
    storageUrl:          row.storage_url,
    mimeType:            row.mime_type,
    bytes:               Number(row.bytes),
    sha256Hex:           row.sha256_hex,
    extractedName:       row.extracted_name,
    extractedIdNumber:   row.extracted_id_number,
    extractedDob:        row.extracted_dob,
    verificationStatus:  row.verification_status,
    verificationNotes:   row.verification_notes,
    verifiedBy:          row.verified_by,
    verifiedAt:          row.verified_at,
    verifierProvider:    row.verifier_provider,
    verifierConfidence:  row.verifier_confidence == null ? null : Number(row.verifier_confidence),
    // AI triage result (null for the manual verifier).
    aiRecommendation:    payload.recommendation ?? null,   // 'pass' | 'fail' | 'uncertain'
    aiReason:            payload.reason ?? null,
    createdAt:           row.created_at,
    updatedAt:           row.updated_at,
  }
}

async function documentRoutes(fastify) {
  try { await ensureDir(DOC_ROOT) } catch { /* noop */ }

  // ── Upload ──────────────────────────────────────────────────────────
  fastify.post('/documents', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      if (!request.isMultipart()) {
        return reply.code(415).send({ success: false, error: 'expected_multipart' })
      }
      let file = null
      let docKind = null
      const parts = request.parts({ limits: { fileSize: MAX_DOC_BYTES, files: 1 } })
      for await (const part of parts) {
        if (part.type === 'file') {
          if (file) { await part.toBuffer().catch(() => null); continue }
          if (!ALLOWED_DOC_MIME.has(part.mimetype)) {
            return reply.code(415).send({
              success: false, error: 'bad_mime',
              message: `Allowed: ${[...ALLOWED_DOC_MIME].join(', ')}`,
            })
          }
          const buf = await part.toBuffer()
          if (!buf || buf.length === 0) {
            return reply.code(400).send({ success: false, error: 'empty_file' })
          }
          file = { mimetype: part.mimetype, filename: part.filename, buffer: buf }
        } else if (part.type === 'field') {
          if (part.fieldname === 'docKind' && isString(part.value, 32)) {
            docKind = part.value
          }
        }
      }
      if (!file) return reply.code(400).send({ success: false, error: 'no_file' })
      if (!docKind || !VALID_KINDS.has(docKind)) {
        return reply.code(400).send({ success: false, error: 'bad_kind' })
      }

      // Malware scan (H7) before the file touches disk or the DB. Uses clamd
      // when CLAMAV_HOST is set, else a conservative heuristic. An infected
      // upload is rejected outright and never persisted.
      const scan = await scanBuffer(file.buffer, { mime: file.mimetype, log: request.log })
      if (!scan.clean) {
        request.log.warn({ signature: scan.signature, engine: scan.engine, userId: request.user.id },
          'rejected infected upload')
        return reply.code(422).send({
          success: false, error: 'malware_detected',
          message: 'This file failed a security scan and was not accepted.',
        })
      }

      const userId = request.user.id
      const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex')

      // Reject duplicate for same user.
      const dupRes = await fastify.pg.query(
        `SELECT id, verification_status FROM citizen_documents
         WHERE user_id = $1 AND sha256_hex = $2 AND deleted_at IS NULL`,
        [userId, sha256],
      )
      if (dupRes.rows[0]) {
        return reply.code(409).send({
          success: false, error: 'duplicate',
          message: 'You have already uploaded this document.',
          existingId: dupRes.rows[0].id,
        })
      }

      const id = crypto.randomUUID()
      const ext = ({
        'image/jpeg':'.jpg', 'image/png':'.png', 'image/webp':'.webp',
        'image/heic':'.heic', 'application/pdf':'.pdf',
      })[file.mimetype] || ''
      const dir = path.join(DOC_ROOT, userId)
      await ensureDir(dir)
      const diskPath = path.join(dir, `${id}${ext}`)
      const storageUrl = `/uploads/citizen-documents/${userId}/${id}${ext}`

      await fs.writeFile(diskPath, file.buffer)

      // Insert in 'pending'. The verifier flips to under_review/verified/rejected.
      const { rows } = await fastify.pg.query(
        `INSERT INTO citizen_documents
           (id, user_id, doc_kind, storage_url, mime_type, bytes, sha256_hex)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [id, userId, docKind, storageUrl, file.mimetype, file.buffer.length, sha256],
      )
      const inserted = rows[0]

      // Run the configured verifier (defaults to manual).
      const verifierName = process.env.ID_VERIFIER || 'manual'
      let verifier
      try {
        verifier = idVerifier.getVerifier(verifierName)
      } catch (err) {
        request.log.warn({ err }, 'unknown verifier; falling back to manual')
        verifier = idVerifier.getVerifier('manual')
      }

      let result = null
      try {
        result = await verifier.verify({ doc: inserted, fileBuffer: file.buffer })
      } catch (err) {
        request.log.warn({ err }, 'verifier failed; leaving doc pending')
        result = null
      }

      if (result) {
        // When the verifier reaches a terminal decision on its own (an AI
        // pass/fail), stamp verified_at so the timeline reads correctly even
        // though no staff member touched it.
        const autoDecided = result.status === 'verified' || result.status === 'rejected'
        await fastify.pg.query(
          `UPDATE citizen_documents SET
             verification_status = $2,
             verification_notes  = COALESCE($9, verification_notes),
             verifier_provider   = $3,
             verifier_payload    = $4::JSONB,
             verifier_confidence = $5,
             verified_at         = CASE WHEN $10 THEN NOW() ELSE verified_at END,
             extracted_name      = COALESCE($6, extracted_name),
             extracted_id_number = COALESCE($7, extracted_id_number),
             extracted_dob       = COALESCE($8, extracted_dob),
             updated_at          = NOW()
           WHERE id = $1`,
          [
            inserted.id,
            result.status,
            result.provider,
            JSON.stringify(result.payload || {}),
            result.confidence == null ? null : Number(result.confidence),
            result.extracted?.name      ?? null,
            result.extracted?.idNumber  ?? null,
            result.extracted?.dob       ?? null,
            result.notes ?? null,
            autoDecided,
          ],
        )
      }

      const final = await fastify.pg.query(
        `SELECT * FROM citizen_documents WHERE id = $1`, [inserted.id],
      )
      return reply.send({ success: true, data: docDTO(final.rows[0]) })
    } catch (err) {
      if (err && err.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ success: false, error: 'too_large' })
      }
      request.log.error({ err }, 'doc upload failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── My documents ────────────────────────────────────────────────────
  fastify.get('/documents/mine', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT * FROM citizen_documents WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
        [request.user.id],
      )
      return reply.send({ success: true, data: rows.map(docDTO) })
    } catch (err) {
      request.log.error({ err }, 'docs list mine failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Single doc (owner / staff) ──────────────────────────────────────
  fastify.get('/documents/:id', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT * FROM citizen_documents WHERE id = $1 AND deleted_at IS NULL`,
        [request.params.id],
      )
      const row = rows[0]
      if (!row) return reply.code(404).send({ success: false, error: 'not_found' })
      const u = request.user
      if (row.user_id !== u.id && !STAFF_ROLES.includes(u.role)) {
        return reply.code(403).send({ success: false, error: 'forbidden' })
      }
      return reply.send({ success: true, data: docDTO(row) })
    } catch (err) {
      request.log.error({ err }, 'doc get failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Staff queue ─────────────────────────────────────────────────────
  fastify.get('/documents/queue', { preHandler: requireRole(fastify, STAFF_ROLES) }, async (_request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT cd.*, COALESCE(u.full_name, u.name) AS owner_name, u.email AS owner_email
         FROM citizen_documents cd
         LEFT JOIN users u ON u.id = cd.user_id
         WHERE cd.verification_status IN ('pending', 'under_review')
           AND cd.deleted_at IS NULL
         ORDER BY cd.created_at ASC
         LIMIT 200`,
      )
      return reply.send({
        success: true,
        data: rows.map(r => ({
          ...docDTO(r),
          ownerName:  r.owner_name,
          ownerEmail: r.owner_email,
        })),
      })
    } catch (err) {
      reply.log.error({ err }, 'docs queue failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Staff verify ────────────────────────────────────────────────────
  fastify.post('/documents/:id/verify', { preHandler: requireRole(fastify, STAFF_ROLES) }, async (request, reply) => {
    try {
      const { id } = request.params
      const { decision, notes, extracted } = request.body || {}
      if (!['verified', 'rejected'].includes(decision)) {
        return reply.code(400).send({ success: false, error: 'bad_decision' })
      }
      const ex = extracted && typeof extracted === 'object' ? extracted : {}
      const { rows } = await fastify.pg.query(
        `UPDATE citizen_documents SET
           verification_status = $2,
           verification_notes  = $3,
           verified_by         = $4,
           verified_at         = NOW(),
           extracted_name      = COALESCE($5, extracted_name),
           extracted_id_number = COALESCE($6, extracted_id_number),
           extracted_dob       = COALESCE($7, extracted_dob),
           updated_at          = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          id, decision,
          isString(notes, 2000) ? notes : null,
          request.user.id,
          isString(ex.name, 255) ? ex.name : null,
          isString(ex.idNumber, 64) ? ex.idNumber : null,
          isString(ex.dob, 32) ? ex.dob : null,
        ],
      )
      const row = rows[0]
      if (!row) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: docDTO(row) })
    } catch (err) {
      request.log.error({ err }, 'doc verify failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Delete (owner while pending; admin always) ──────────────────────
  fastify.delete('/documents/:id', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT * FROM citizen_documents WHERE id = $1 AND deleted_at IS NULL`,
        [request.params.id],
      )
      const row = rows[0]
      if (!row) return reply.code(404).send({ success: false, error: 'not_found' })

      const u = request.user
      const isOwner = row.user_id === u.id
      const isAdmin = u.role === 'admin'
      if (!isOwner && !isAdmin) {
        return reply.code(403).send({ success: false, error: 'forbidden' })
      }
      if (isOwner && !['pending', 'under_review'].includes(row.verification_status)) {
        return reply.code(409).send({ success: false, error: 'not_deletable' })
      }
      // Soft delete (migration 103): the row and the stored file both stay so
      // the record is recoverable; every read filters deleted_at IS NULL.
      await fastify.pg.query(
        `UPDATE citizen_documents SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1`,
        [row.id, u.id],
      )
      return reply.send({ success: true })
    } catch (err) {
      request.log.error({ err }, 'doc delete failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

module.exports = { documentRoutes }
