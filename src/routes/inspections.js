/**
 * Inspection bookings + stages + photos.
 *
 * Endpoints (all under /api):
 *
 *   GET    /inspection-stages                          public (read-only catalogue)
 *   POST   /applications/:appId/inspections            citizen — create booking for a stage
 *   POST   /inspections/:id/pay                        citizen — mark fee paid
 *                                                              (real payment flow lands in Turn C)
 *   POST   /inspections/:id/schedule                   inspector — set date + assign self
 *   POST   /inspections/:id/reschedule                 inspector — move date, sends email
 *   POST   /inspections/:id/complete                   inspector — passed/failed + notes
 *   POST   /inspections/:id/cancel                     citizen OR inspector
 *   GET    /inspections/:id                            citizen + assigned inspector
 *   GET    /applications/:appId/inspections            citizen — list mine
 *   GET    /inspector/queue                            inspector — my assigned + waitlist
 *
 *   POST   /inspections/:id/photos                     inspector — upload one photo
 *   GET    /inspections/:id/photos                     all parties — list photos
 *   DELETE /inspections/:id/photos/:photoId            inspector — soft-delete (hard delete row;
 *                                                              file pruning by a separate job)
 *
 * Authorisation rules:
 *   - Citizen actions require the user to be the application's user_id.
 *   - Inspector actions require the user's role to include 'building_inspector'.
 *   - Photo viewing is open to citizen owner + assigned inspector + admins.
 *
 * The citizen never picks an inspector or a date directly — they pay,
 * land on the waitlist, and the inspector assigns. If the inspector
 * reschedules later, the citizen is emailed automatically.
 */

const path = require('node:path')
const fs   = require('node:fs/promises')
const fsSync = require('node:fs')
const crypto = require('node:crypto')

const { requireAuth, requireRole } = require('../middleware/jwtAuth')
const notifier = require('../services/notifier')
const { scanBuffer } = require('../services/malwareScan')

// ════════════════════════════════════════════════════════════════════
// Stage catalogue — Manual 2021, Annexure 12
// ════════════════════════════════════════════════════════════════════
const STAGES = [
  { number: 1, name: 'Setting out',                                      requires: [] },
  { number: 2, name: 'Foundation trenches and footing levels',           requires: [1] },
  { number: 3, name: 'Foundation brickwork to floor level',              requires: [2] },
  { number: 4, name: 'Brickwork and window level',                       requires: [3] },
  { number: 5, name: 'Brickwork to wall plate',                          requires: [4] },
  { number: 6, name: 'Roof trusses',                                     requires: [5] },
  { number: 7, name: 'Drainage / sewerage work',                         requires: [3] },
  { number: 8, name: 'Final inspection',                                 requires: [6, 7] },
  { number: 9, name: 'Certificate of occupation',                        requires: [8] },
]
const STAGE_BY_NUMBER = new Map(STAGES.map(s => [s.number, s]))

// ════════════════════════════════════════════════════════════════════
// Photo storage
// ════════════════════════════════════════════════════════════════════
const PHOTO_ROOT = process.env.INSPECTION_PHOTO_ROOT
  ? path.resolve(process.env.INSPECTION_PHOTO_ROOT)
  : path.resolve(process.cwd(), 'uploads', 'inspection-photos')

const MAX_PHOTO_BYTES = 10 * 1024 * 1024  // 10 MB
const ALLOWED_PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic'])

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

// ════════════════════════════════════════════════════════════════════
// Tiny helpers
// ════════════════════════════════════════════════════════════════════
const isString = (v, max = 4096) =>
  typeof v === 'string' && v.length > 0 && v.length <= max
const isUuid = (v) =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

async function loadBookingForActor(fastify, request, reply, bookingId) {
  if (!isUuid(bookingId)) {
    reply.code(400).send({ success: false, error: 'bad_id' })
    return null
  }
  const { rows } = await fastify.pg.query(
    `SELECT b.*,
            COALESCE(da.user_id, b.citizen_id) AS citizen_user_id
     FROM inspection_bookings b
     LEFT JOIN development_applications da ON da.id = b.application_id
     WHERE b.id = $1`,
    [bookingId],
  )
  const booking = rows[0]
  if (!booking) {
    reply.code(404).send({ success: false, error: 'not_found' })
    return null
  }
  // Authorisation:
  //   - admins always
  //   - assigned inspector
  //   - any building inspector for read-list
  //   - the citizen who owns the application
  const u = request.user
  const isCitizenOwner = u.id === booking.citizen_user_id || u.id === booking.citizen_id
  const isAssignedInspector = booking.inspector_id === u.id
  const isAdminOrInspector  = u.role === 'admin' || u.role === 'building_inspector'
  if (!isCitizenOwner && !isAssignedInspector && !isAdminOrInspector) {
    reply.code(403).send({ success: false, error: 'forbidden' })
    return null
  }
  return booking
}

function bookingDTO(b) {
  return {
    id:             b.id,
    applicationId:  b.application_id,
    stageNumber:    b.stage_number,
    stageName:      b.stage_name,
    citizenId:      b.citizen_id,
    inspectorId:    b.inspector_id,
    status:         b.status,
    feePaidAt:      b.fee_paid_at,
    scheduledFor:   b.scheduled_for,
    completedAt:    b.completed_at,
    passed:         b.passed,
    citizenNotes:   b.citizen_notes,
    inspectorNotes: b.inspector_notes,
    createdAt:      b.created_at,
    updatedAt:      b.updated_at,
  }
}

// ════════════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════════════
async function inspectionRoutes(fastify) {
  // Make sure photo dir exists at boot. Best-effort — failures are
  // surfaced when the upload route is actually called.
  try { await ensureDir(PHOTO_ROOT) } catch { /* noop */ }

  // ────────────────────────────────────────────────────────────────
  // Public: stage catalogue.
  // ────────────────────────────────────────────────────────────────
  fastify.get('/inspection-stages', async (_request, reply) => {
    return reply.send({ success: true, data: STAGES })
  })

  // ────────────────────────────────────────────────────────────────
  // Citizen: create a booking for a stage.
  // Idempotent — re-posting the same (app, stage) returns the existing
  // row (UNIQUE constraint on the table backs this).
  // ────────────────────────────────────────────────────────────────
  fastify.post('/applications/:appId/inspections', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { appId } = request.params
      const { stageNumber, citizenNotes } = request.body || {}

      const stage = STAGE_BY_NUMBER.get(Number(stageNumber))
      if (!stage) {
        return reply.code(400).send({ success: false, error: 'bad_stage' })
      }

      // Ensure caller owns the application.
      const { rows: appRows } = await fastify.pg.query(
        `SELECT id, user_id, status FROM development_applications WHERE id = $1`,
        [appId],
      )
      const app = appRows[0]
      if (!app) return reply.code(404).send({ success: false, error: 'application_not_found' })
      if (app.user_id !== request.user.id && request.user.role !== 'admin') {
        return reply.code(403).send({ success: false, error: 'forbidden' })
      }

      // Insert. The (application_id, stage_number) UNIQUE constraint
      // means re-bookings return the existing row.
      const { rows } = await fastify.pg.query(
        `INSERT INTO inspection_bookings
           (application_id, stage_number, stage_name, citizen_id, citizen_notes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (application_id, stage_number) DO UPDATE
           SET citizen_notes = COALESCE(EXCLUDED.citizen_notes, inspection_bookings.citizen_notes),
               updated_at = NOW()
         RETURNING *`,
        [appId, stage.number, stage.name, request.user.id, isString(citizenNotes, 1000) ? citizenNotes : null],
      )
      return reply.send({ success: true, data: bookingDTO(rows[0]) })
    } catch (err) {
      request.log.error({ err }, 'create booking failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ────────────────────────────────────────────────────────────────
  // Citizen: mark the inspection fee as paid.
  // Real payment integration arrives in Turn C; this endpoint encodes
  // the state transition pending_payment → waitlisted and emits the
  // "you're on the waitlist" email.
  // ────────────────────────────────────────────────────────────────
  fastify.post('/inspections/:id/pay', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const booking = await loadBookingForActor(fastify, request, reply, request.params.id)
      if (!booking) return
      if (booking.status !== 'pending_payment') {
        return reply.code(409).send({ success: false, error: 'wrong_state', message: 'Inspection fee already settled.' })
      }

      const { rows } = await fastify.pg.query(
        `UPDATE inspection_bookings
            SET status      = 'waitlisted',
                fee_paid_at = NOW(),
                updated_at  = NOW()
          WHERE id = $1
          RETURNING *`,
        [booking.id],
      )
      const row = rows[0]

      await fastify.pg.query(
        `INSERT INTO inspection_status_events (booking_id, from_status, to_status, actor_id, actor_role)
         VALUES ($1, 'pending_payment', 'waitlisted', $2, $3)`,
        [row.id, request.user.id, request.user.role],
      )

      // Email the citizen (they paid for the booking — tell them they're
      // on the waitlist now).
      const recipient = await loadCitizenContact(fastify, row)
      if (recipient.email) {
        await notifier.enqueue(fastify.pg, {
          userId: recipient.userId, email: recipient.email,
          kind: 'inspection_waitlisted',
          templateData: {
            applicationId: row.application_id,
            stageNumber:   row.stage_number,
            stageName:     row.stage_name,
            name:          recipient.name,
          },
          payload: { bookingId: row.id, applicationId: row.application_id, stageNumber: row.stage_number },
        })
      }

      return reply.send({ success: true, data: bookingDTO(row) })
    } catch (err) {
      request.log.error({ err }, 'pay booking failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ────────────────────────────────────────────────────────────────
  // Inspector: schedule a waitlisted booking. Assigns self by default.
  // ────────────────────────────────────────────────────────────────
  fastify.post('/inspections/:id/schedule', { preHandler: requireRole(fastify, ['building_inspector', 'admin']) }, async (request, reply) => {
    try {
      const booking = await loadBookingForActor(fastify, request, reply, request.params.id)
      if (!booking) return
      const { scheduledFor, inspectorId, inspectorNotes } = request.body || {}
      const when = isString(scheduledFor) ? new Date(scheduledFor) : null
      if (!when || Number.isNaN(when.getTime())) {
        return reply.code(400).send({ success: false, error: 'bad_date' })
      }
      if (when.getTime() < Date.now() - 60_000) {
        return reply.code(400).send({ success: false, error: 'date_in_past' })
      }
      if (booking.status === 'pending_payment') {
        return reply.code(409).send({ success: false, error: 'unpaid' })
      }

      const assignedInspector = isUuid(inspectorId) ? inspectorId : request.user.id

      const { rows } = await fastify.pg.query(
        `UPDATE inspection_bookings
            SET status        = 'scheduled',
                inspector_id  = $2,
                scheduled_for = $3,
                inspector_notes = COALESCE($4, inspector_notes),
                updated_at    = NOW()
          WHERE id = $1
          RETURNING *`,
        [booking.id, assignedInspector, when.toISOString(), isString(inspectorNotes, 2000) ? inspectorNotes : null],
      )
      const row = rows[0]
      await fastify.pg.query(
        `INSERT INTO inspection_status_events (booking_id, from_status, to_status, scheduled_for, actor_id, actor_role)
         VALUES ($1, $2, 'scheduled', $3, $4, $5)`,
        [row.id, booking.status, when.toISOString(), request.user.id, request.user.role],
      )

      const recipient = await loadCitizenContact(fastify, row)
      if (recipient.email) {
        await notifier.enqueue(fastify.pg, {
          userId: recipient.userId, email: recipient.email,
          kind: 'inspection_scheduled',
          templateData: {
            applicationId: row.application_id,
            stageNumber:   row.stage_number,
            stageName:     row.stage_name,
            scheduledFor:  row.scheduled_for,
            name:          recipient.name,
          },
          payload: { bookingId: row.id, scheduledFor: row.scheduled_for },
        })
      }

      return reply.send({ success: true, data: bookingDTO(row) })
    } catch (err) {
      request.log.error({ err }, 'schedule booking failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ────────────────────────────────────────────────────────────────
  // Inspector: reschedule. Sends an email regardless.
  // ────────────────────────────────────────────────────────────────
  fastify.post('/inspections/:id/reschedule', { preHandler: requireRole(fastify, ['building_inspector', 'admin']) }, async (request, reply) => {
    try {
      const booking = await loadBookingForActor(fastify, request, reply, request.params.id)
      if (!booking) return
      if (!['scheduled', 'rescheduled'].includes(booking.status)) {
        return reply.code(409).send({ success: false, error: 'not_scheduled' })
      }
      const { scheduledFor } = request.body || {}
      const when = isString(scheduledFor) ? new Date(scheduledFor) : null
      if (!when || Number.isNaN(when.getTime())) {
        return reply.code(400).send({ success: false, error: 'bad_date' })
      }

      const { rows } = await fastify.pg.query(
        `UPDATE inspection_bookings
            SET status         = 'rescheduled',
                scheduled_for  = $2,
                updated_at     = NOW()
          WHERE id = $1
          RETURNING *`,
        [booking.id, when.toISOString()],
      )
      const row = rows[0]
      await fastify.pg.query(
        `INSERT INTO inspection_status_events (booking_id, from_status, to_status, scheduled_for, actor_id, actor_role)
         VALUES ($1, $2, 'rescheduled', $3, $4, $5)`,
        [row.id, booking.status, when.toISOString(), request.user.id, request.user.role],
      )

      const recipient = await loadCitizenContact(fastify, row)
      if (recipient.email) {
        await notifier.enqueue(fastify.pg, {
          userId: recipient.userId, email: recipient.email,
          kind: 'inspection_rescheduled',
          templateData: {
            applicationId: row.application_id,
            stageNumber:   row.stage_number,
            stageName:     row.stage_name,
            oldDate:       booking.scheduled_for,
            newDate:       row.scheduled_for,
            name:          recipient.name,
          },
          payload: { bookingId: row.id, oldDate: booking.scheduled_for, newDate: row.scheduled_for },
        })
      }

      return reply.send({ success: true, data: bookingDTO(row) })
    } catch (err) {
      request.log.error({ err }, 'reschedule failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ────────────────────────────────────────────────────────────────
  // Inspector: complete. passed = true/false.
  // ────────────────────────────────────────────────────────────────
  fastify.post('/inspections/:id/complete', { preHandler: requireRole(fastify, ['building_inspector', 'admin']) }, async (request, reply) => {
    try {
      const booking = await loadBookingForActor(fastify, request, reply, request.params.id)
      if (!booking) return
      const { passed, notes } = request.body || {}
      if (typeof passed !== 'boolean') {
        return reply.code(400).send({ success: false, error: 'bad_passed' })
      }

      const newStatus = passed ? 'passed' : 'failed'
      const { rows } = await fastify.pg.query(
        `UPDATE inspection_bookings
            SET status          = $2,
                passed          = $3,
                completed_at    = NOW(),
                inspector_notes = COALESCE($4, inspector_notes),
                updated_at      = NOW()
          WHERE id = $1
          RETURNING *`,
        [booking.id, newStatus, passed, isString(notes, 4000) ? notes : null],
      )
      const row = rows[0]
      await fastify.pg.query(
        `INSERT INTO inspection_status_events (booking_id, from_status, to_status, actor_id, actor_role, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.id, booking.status, newStatus, request.user.id, request.user.role, notes || null],
      )

      const recipient = await loadCitizenContact(fastify, row)
      if (recipient.email) {
        await notifier.enqueue(fastify.pg, {
          userId: recipient.userId, email: recipient.email,
          kind: 'inspection_completed',
          templateData: {
            applicationId: row.application_id,
            stageNumber:   row.stage_number,
            stageName:     row.stage_name,
            passed,
            notes,
            name:          recipient.name,
          },
          payload: { bookingId: row.id, passed },
        })
      }

      return reply.send({ success: true, data: bookingDTO(row) })
    } catch (err) {
      request.log.error({ err }, 'complete failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ────────────────────────────────────────────────────────────────
  // Citizen or inspector: cancel a booking that has not been completed.
  // ────────────────────────────────────────────────────────────────
  fastify.post('/inspections/:id/cancel', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const booking = await loadBookingForActor(fastify, request, reply, request.params.id)
      if (!booking) return
      if (['passed', 'failed', 'cancelled'].includes(booking.status)) {
        return reply.code(409).send({ success: false, error: 'not_cancellable' })
      }
      const { rows } = await fastify.pg.query(
        `UPDATE inspection_bookings
            SET status     = 'cancelled',
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [booking.id],
      )
      await fastify.pg.query(
        `INSERT INTO inspection_status_events (booking_id, from_status, to_status, actor_id, actor_role)
         VALUES ($1, $2, 'cancelled', $3, $4)`,
        [booking.id, booking.status, request.user.id, request.user.role],
      )
      return reply.send({ success: true, data: bookingDTO(rows[0]) })
    } catch (err) {
      request.log.error({ err }, 'cancel failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ────────────────────────────────────────────────────────────────
  // Read endpoints
  // ────────────────────────────────────────────────────────────────
  fastify.get('/inspections/:id', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    const booking = await loadBookingForActor(fastify, request, reply, request.params.id)
    if (!booking) return
    const { rows: events } = await fastify.pg.query(
      `SELECT id, from_status, to_status, scheduled_for, actor_id, actor_role, notes, created_at
       FROM inspection_status_events WHERE booking_id = $1 ORDER BY id ASC`,
      [booking.id],
    )
    const { rows: photos } = await fastify.pg.query(
      `SELECT id, storage_url, mime_type, bytes, width_px, height_px, caption, taken_at, created_at
       FROM inspection_photos WHERE booking_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`,
      [booking.id],
    )
    return reply.send({
      success: true,
      data: {
        ...bookingDTO(booking),
        events,
        photos,
      },
    })
  })

  fastify.get('/applications/:appId/inspections', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    const { appId } = request.params
    // Caller must own the application or be staff.
    const { rows: appRows } = await fastify.pg.query(
      `SELECT user_id FROM development_applications WHERE id = $1`,
      [appId],
    )
    const app = appRows[0]
    if (!app) return reply.code(404).send({ success: false, error: 'application_not_found' })
    const u = request.user
    const isStaff = ['admin', 'building_inspector', 'planner', 'planning_clerk', 'eo', 'env_officer', 'surveyor', 'gis_officer'].includes(u.role)
    if (app.user_id !== u.id && !isStaff) {
      return reply.code(403).send({ success: false, error: 'forbidden' })
    }
    const { rows } = await fastify.pg.query(
      `SELECT * FROM inspection_bookings WHERE application_id = $1
       ORDER BY stage_number ASC`,
      [appId],
    )
    return reply.send({ success: true, data: rows.map(bookingDTO) })
  })

  fastify.get('/inspector/queue', { preHandler: requireRole(fastify, ['building_inspector', 'admin']) }, async (request, reply) => {
    // Two buckets: the inspector's assigned + dated work, and the
    // unassigned waitlist they can pick from.
    const { rows: assigned } = await fastify.pg.query(
      `SELECT * FROM inspection_bookings
       WHERE inspector_id = $1
         AND status IN ('scheduled', 'rescheduled', 'in_progress')
       ORDER BY scheduled_for ASC NULLS LAST`,
      [request.user.id],
    )
    const { rows: waitlist } = await fastify.pg.query(
      `SELECT * FROM inspection_bookings
       WHERE status = 'waitlisted'
       ORDER BY fee_paid_at ASC
       LIMIT 50`,
    )
    return reply.send({
      success: true,
      data: {
        assigned: assigned.map(bookingDTO),
        waitlist: waitlist.map(bookingDTO),
      },
    })
  })

  // ════════════════════════════════════════════════════════════════
  // PHOTOS
  // ════════════════════════════════════════════════════════════════
  fastify.post('/inspections/:id/photos', {
    preHandler: requireRole(fastify, ['building_inspector', 'admin']),
  }, async (request, reply) => {
    try {
      const booking = await loadBookingForActor(fastify, request, reply, request.params.id)
      if (!booking) return

      // Multipart upload — supports a single file under field name 'photo'
      // plus optional 'caption', 'takenAt', 'lng', 'lat' fields.
      // Requires @fastify/multipart, registered in server.js.
      if (!request.isMultipart()) {
        return reply.code(415).send({ success: false, error: 'expected_multipart' })
      }

      let file = null
      let caption = null
      let takenAt = null
      let lng = null, lat = null

      const parts = request.parts({ limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } })
      for await (const part of parts) {
        if (part.type === 'file') {
          if (file) {
            // Drain extra files defensively.
            await part.toBuffer().catch(() => null)
            continue
          }
          if (!ALLOWED_PHOTO_MIME.has(part.mimetype)) {
            return reply.code(415).send({ success: false, error: 'bad_mime', message: `Allowed: ${[...ALLOWED_PHOTO_MIME].join(', ')}` })
          }
          const buf = await part.toBuffer()
          if (!buf || buf.length === 0) {
            return reply.code(400).send({ success: false, error: 'empty_file' })
          }
          file = { mimetype: part.mimetype, filename: part.filename, buffer: buf }
        } else if (part.type === 'field') {
          if (part.fieldname === 'caption' && isString(part.value, 255)) caption = part.value
          if (part.fieldname === 'takenAt' && isString(part.value, 64))  takenAt = part.value
          if (part.fieldname === 'lng' && isString(part.value, 32))      lng = Number(part.value)
          if (part.fieldname === 'lat' && isString(part.value, 32))      lat = Number(part.value)
        }
      }
      if (!file) return reply.code(400).send({ success: false, error: 'no_file' })

      // Malware scan (H7) before the photo is persisted.
      const scan = await scanBuffer(file.buffer, { mime: file.mimetype, log: request.log })
      if (!scan.clean) {
        request.log.warn({ signature: scan.signature, engine: scan.engine }, 'rejected infected inspection photo')
        return reply.code(422).send({ success: false, error: 'malware_detected', message: 'This file failed a security scan and was not accepted.' })
      }

      const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex')
      const id = crypto.randomUUID()
      const ext = ({
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic',
      })[file.mimetype] || ''
      const dir = path.join(PHOTO_ROOT, booking.id)
      await ensureDir(dir)
      const diskPath = path.join(dir, `${id}${ext}`)
      const storageUrl = `/uploads/inspection-photos/${booking.id}/${id}${ext}`

      await fs.writeFile(diskPath, file.buffer)

      const { rows } = await fastify.pg.query(
        `INSERT INTO inspection_photos
           (id, booking_id, uploaded_by, storage_url, mime_type, bytes, sha256_hex, caption, taken_at, taken_lng, taken_lat)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (booking_id, sha256_hex) DO UPDATE
           SET caption = COALESCE(EXCLUDED.caption, inspection_photos.caption)
         RETURNING *`,
        [
          id, booking.id, request.user.id,
          storageUrl, file.mimetype, file.buffer.length,
          sha256, caption,
          takenAt && !Number.isNaN(Date.parse(takenAt)) ? new Date(takenAt).toISOString() : null,
          Number.isFinite(lng) ? lng : null,
          Number.isFinite(lat) ? lat : null,
        ],
      )
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      // Multipart fileSize abort throws specifically; treat as 413.
      if (err && err.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.code(413).send({ success: false, error: 'too_large', message: 'Photo exceeds 10 MB.' })
      }
      request.log.error({ err }, 'photo upload failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/inspections/:id/photos', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    const booking = await loadBookingForActor(fastify, request, reply, request.params.id)
    if (!booking) return
    const { rows } = await fastify.pg.query(
      `SELECT id, storage_url, mime_type, bytes, width_px, height_px,
              caption, taken_at, taken_lng, taken_lat, created_at
       FROM inspection_photos
       WHERE booking_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC`,
      [booking.id],
    )
    return reply.send({ success: true, data: rows })
  })

  fastify.delete('/inspections/:id/photos/:photoId', {
    preHandler: requireRole(fastify, ['building_inspector', 'admin']),
  }, async (request, reply) => {
    try {
      const booking = await loadBookingForActor(fastify, request, reply, request.params.id)
      if (!booking) return
      const { photoId } = request.params
      if (!isUuid(photoId)) return reply.code(400).send({ success: false, error: 'bad_id' })
      // Soft delete (migration 103): inspection photos are statutory evidence —
      // the row and the stored file both stay; reads filter deleted_at IS NULL.
      const { rows } = await fastify.pg.query(
        `UPDATE inspection_photos SET deleted_at = NOW(), deleted_by = $3
         WHERE id = $1 AND booking_id = $2 AND deleted_at IS NULL
         RETURNING id`,
        [photoId, booking.id, request.user.id],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true })
    } catch (err) {
      request.log.error({ err }, 'photo delete failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

/**
 * Resolve the citizen email/name for notifications. We try (in order):
 *   1. development_applications.user_id → users row
 *   2. inspection_bookings.citizen_id  → users row
 * Falls back to anonymous { email: null } so the caller can decide
 * whether to emit a notification at all.
 */
async function loadCitizenContact(fastify, booking) {
  const candidates = [booking.citizen_id, booking.application_id ? null : null].filter(Boolean)
  // Try app's user_id first.
  const { rows: appRows } = await fastify.pg.query(
    `SELECT da.user_id,
            u.email, COALESCE(u.full_name, u.name) AS name
     FROM development_applications da
     LEFT JOIN users u ON u.id::text = da.user_id
     WHERE da.id = $1`,
    [booking.application_id],
  )
  if (appRows[0] && appRows[0].email) {
    return { userId: appRows[0].user_id, email: appRows[0].email, name: appRows[0].name }
  }
  // Fallback: citizen_id on the booking itself.
  if (booking.citizen_id) {
    const { rows } = await fastify.pg.query(
      `SELECT id, email, COALESCE(full_name, name) AS name FROM users WHERE id::text = $1`,
      [booking.citizen_id],
    )
    if (rows[0]) return { userId: rows[0].id, email: rows[0].email, name: rows[0].name }
  }
  return { userId: null, email: null, name: null }
  // candidates intentionally unused — kept here as a structural hint
  // for future expansion (multi-recipient: e.g. agent + citizen).
  void candidates
}

module.exports = { inspectionRoutes }
