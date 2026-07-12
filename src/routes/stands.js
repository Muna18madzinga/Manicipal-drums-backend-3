/**
 * Stands routes — public list/detail + planner CRUD + reserve flow.
 *
 *   GET    /api/stands                  → GeoJSON FeatureCollection
 *   GET    /api/stands/:id              → single stand + zone + plan suggestion
 *   POST   /api/stands                  → planner/admin: create stand with geometry
 *   PUT    /api/stands/:id              → planner/admin: update stand details/geometry
 *   DELETE /api/stands/:id              → planner/admin: withdraw stand
 *   POST   /api/stands/:id/reserve      → authenticated: soft-reserve for 30 min
 *   POST   /api/stands/:id/release      → authenticated: release own reservation
 */

const { requireAuth, requireRole } = require('../middleware/jwtAuth')
const planningAssistant = require('../services/planningAssistant')
const { invalidateTileLayer, emitMapEvent } = require('./tiles')

const RESERVATION_TTL_MIN = 30

const STATUS_VALUES = new Set(['available', 'reserved', 'allocated', 'withdrawn'])

const isString = (v, max = 255) =>
  typeof v === 'string' && v.length > 0 && v.length <= max

const ALLOC_PURPOSES = new Set([
  'residential', 'commercial', 'industrial', 'institutional', 'agricultural', 'other',
])

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

// Next allocation reference in the VRDC-STD-YYYY-NNNNNN series (mirrors the
// receipt-number generator in services/paymentDriver.js). Called inside the
// allocate transaction so the MAX+1 read and the insert are atomic.
async function nextAllocationRef(client) {
  const year = new Date().getFullYear()
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(NULLIF(REGEXP_REPLACE(reference_no, '^VRDC-STD-\\d{4}-', ''), '')::INT), 0) + 1 AS n
       FROM stand_allocation
      WHERE reference_no LIKE 'VRDC-STD-' || $1 || '-%'`,
    [String(year)],
  )
  return `VRDC-STD-${year}-${String(rows[0].n).padStart(6, '0')}`
}

function pickStatuses(raw) {
  if (!raw) return ['available']
  const list = String(raw).split(',').map(s => s.trim()).filter(Boolean)
  return list.filter(s => STATUS_VALUES.has(s))
}

async function standsRoutes(fastify) {
  // ── Public: list as GeoJSON ─────────────────────────────────────────
  fastify.get('/stands', async (request, reply) => {
    try {
      const { ward, zoneType, q, bbox } = request.query || {}
      const statuses = pickStatuses(request.query?.status)

      // Defensive parameter binding — never interpolate strings.
      const params = [statuses]
      const where  = ['s.status = ANY($1::text[])']

      if (isString(ward, 64)) {
        params.push(ward)
        where.push(`s.ward = $${params.length}`)
      }
      if (isString(zoneType, 64)) {
        params.push(zoneType)
        where.push(`s.zone_type = $${params.length}`)
      }
      if (isString(q, 64)) {
        params.push(`%${q}%`)
        where.push(`s.stand_number ILIKE $${params.length}`)
      }
      if (isString(bbox, 100)) {
        const parts = bbox.split(',').map(Number)
        if (parts.length === 4 && parts.every(Number.isFinite)) {
          const [minLng, minLat, maxLng, maxLat] = parts
          params.push(minLng, minLat, maxLng, maxLat)
          where.push(
            `s.geom && ST_MakeEnvelope(
               $${params.length - 3}, $${params.length - 2},
               $${params.length - 1}, $${params.length},
               4326)`,
          )
        }
      }

      const sql = `
        SELECT
          s.id, s.stand_number, s.ward, s.zone_id, s.zone_type,
          s.use_scale, s.area_sqm, s.frontage_m, s.depth_m,
          s.price_usd, s.status, s.description,
          ST_AsGeoJSON(s.geom)::JSON     AS geometry,
          ST_X(s.centroid)               AS centroid_lng,
          ST_Y(s.centroid)               AS centroid_lat
        FROM stands s
        WHERE ${where.join(' AND ')}
        ORDER BY s.ward, s.stand_number
        LIMIT 5000`
      const { rows } = await fastify.pg.query(sql, params)

      const features = rows.map(r => ({
        type: 'Feature',
        id: r.id,
        geometry: r.geometry,
        properties: {
          id:           r.id,
          standNumber:  r.stand_number,
          ward:         r.ward,
          zoneId:       r.zone_id,
          zoneType:     r.zone_type,
          useScale:     r.use_scale,
          areaSqm:      r.area_sqm == null ? null : Number(r.area_sqm),
          frontageM:    r.frontage_m == null ? null : Number(r.frontage_m),
          depthM:       r.depth_m == null ? null : Number(r.depth_m),
          priceUsd:     r.price_usd == null ? null : Number(r.price_usd),
          status:       r.status,
          description:  r.description,
          centroid:     [r.centroid_lng, r.centroid_lat],
        },
      }))

      return reply.send({
        type: 'FeatureCollection',
        features,
      })
    } catch (err) {
      request.log.error({ err }, 'list stands failed')
      return reply.code(500).send({
        type: 'FeatureCollection',
        features: [],
        error: 'internal',
      })
    }
  })

  // ── Public: single stand + suggested plan summary ───────────────────
  fastify.get('/stands/:id', async (request, reply) => {
    try {
      const { id } = request.params
      const { rows } = await fastify.pg.query(
        `SELECT
           s.id, s.stand_number, s.ward, s.zone_id, s.zone_type,
           s.use_scale, s.area_sqm, s.frontage_m, s.depth_m,
           s.price_usd, s.status, s.description,
           s.reserved_until, s.allocated_at,
           ST_AsGeoJSON(s.geom)::JSON  AS geometry,
           ST_X(s.centroid)            AS centroid_lng,
           ST_Y(s.centroid)            AS centroid_lat,
           z.zone, z.zone_type AS zone_zone_type,
           z.scale_category, z.authority, z.zone_description
         FROM stands s
         LEFT JOIN proposed_peri_urban_zones z ON z.id = s.zone_id
         WHERE s.id = $1`,
        [id],
      )
      const r = rows[0]
      if (!r) return reply.code(404).send({ success: false, error: 'not_found' })

      // Suggested plan summary (read-only).
      let suggested = null
      try {
        suggested = await planningAssistant.suggestPlan(fastify.pg, { standId: r.id })
      } catch (err) {
        request.log.warn({ err }, 'planning assistant suggest failed')
      }

      return reply.send({
        success: true,
        data: {
          id:           r.id,
          standNumber:  r.stand_number,
          ward:         r.ward,
          zoneId:       r.zone_id,
          zoneType:     r.zone_type,
          useScale:     r.use_scale,
          areaSqm:      r.area_sqm == null ? null : Number(r.area_sqm),
          frontageM:    r.frontage_m == null ? null : Number(r.frontage_m),
          depthM:       r.depth_m == null ? null : Number(r.depth_m),
          priceUsd:     r.price_usd == null ? null : Number(r.price_usd),
          status:       r.status,
          description:  r.description,
          reservedUntil: r.reserved_until,
          allocatedAt:  r.allocated_at,
          geometry:     r.geometry,
          centroid:     [r.centroid_lng, r.centroid_lat],
          zone: r.zone_id ? {
            id:           r.zone_id,
            name:         r.zone,
            zoneType:     r.zone_zone_type,
            scaleCategory: r.scale_category,
            authority:    r.authority,
            description:  r.zone_description,
          } : null,
          suggestedPlan: suggested,
        },
      })
    } catch (err) {
      request.log.error({ err }, 'get stand failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Auth: reserve a stand (soft, 30 min) ────────────────────────────
  // Idempotent: if the same user re-calls within the TTL, the existing
  // reservation is extended rather than rejected.
  fastify.post('/stands/:id/reserve', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { id } = request.params
      const userId = request.user.id

      const { rows } = await fastify.pg.query(
        `UPDATE stands
            SET status         = 'reserved',
                reserved_by    = $2,
                reserved_at    = NOW(),
                reserved_until = NOW() + ($3 || ' minutes')::INTERVAL,
                updated_at     = NOW()
          WHERE id = $1
            AND (
              status = 'available'
              OR (status = 'reserved' AND (reserved_by = $2 OR reserved_until < NOW()))
            )
          RETURNING id, stand_number, status, reserved_until`,
        [id, userId, RESERVATION_TTL_MIN],
      )
      const row = rows[0]
      if (!row) {
        return reply.code(409).send({
          success: false,
          error:   'unavailable',
          message: 'This stand is no longer available to reserve.',
        })
      }
      return reply.send({ success: true, data: row })
    } catch (err) {
      request.log.error({ err }, 'reserve stand failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Planner: create stand ───────────────────────────────────────────────
  fastify.post('/stands', {
    preHandler: requireRole(fastify, ['planner', 'gis_officer', 'admin']),
  }, async (request, reply) => {
    try {
      const {
        standNumber, ward, zoneId, zoneType, useScale,
        frontageM, depthM, priceUsd, description, geometry,
      } = request.body || {}

      if (!isString(standNumber, 64)) return reply.code(400).send({ success: false, error: 'standNumber required' })
      if (!isString(ward, 64))        return reply.code(400).send({ success: false, error: 'ward required' })
      if (!geometry || geometry.type !== 'Polygon')
        return reply.code(400).send({ success: false, error: 'geometry must be a GeoJSON Polygon' })

      const geomJson = JSON.stringify(geometry)
      const { rows } = await fastify.pg.query(
        `INSERT INTO stands
           (stand_number, ward, zone_id, zone_type, use_scale,
            frontage_m, depth_m, price_usd, description,
            geom, area_sqm, created_by, status)
         VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9,
           ST_SetSRID(ST_GeomFromGeoJSON($10), 4326),
           ROUND(ST_Area(ST_SetSRID(ST_GeomFromGeoJSON($10), 4326)::geography)::numeric, 2),
           $11, 'available'
         )
         RETURNING id, stand_number, ward, status,
                   ROUND(ST_Area(geom::geography)::numeric, 2) AS area_sqm`,
        [standNumber, ward, zoneId || null, zoneType || null, useScale || null,
         frontageM || null, depthM || null, priceUsd || null, description || null,
         geomJson, request.user.id],
      )
      invalidateTileLayer('stands'); emitMapEvent({ layer: 'stands', action: 'updated' })
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ success: false, error: 'stand_number already exists in this ward' })
      request.log.error({ err }, 'create stand failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Planner: update stand ───────────────────────────────────────────────
  fastify.put('/stands/:id', {
    preHandler: requireRole(fastify, ['planner', 'gis_officer', 'admin']),
  }, async (request, reply) => {
    try {
      const { id } = request.params
      const {
        standNumber, ward, zoneId, zoneType, useScale,
        frontageM, depthM, priceUsd, description, status, geometry,
      } = request.body || {}

      const sets = ['updated_at = NOW()']
      const params = [id]

      if (standNumber != null)  { params.push(standNumber);  sets.push(`stand_number = $${params.length}`) }
      if (ward != null)         { params.push(ward);         sets.push(`ward = $${params.length}`) }
      if (zoneId !== undefined) { params.push(zoneId);       sets.push(`zone_id = $${params.length}`) }
      if (zoneType != null)     { params.push(zoneType);     sets.push(`zone_type = $${params.length}`) }
      if (useScale != null)     { params.push(useScale);     sets.push(`use_scale = $${params.length}`) }
      if (frontageM != null)    { params.push(frontageM);    sets.push(`frontage_m = $${params.length}`) }
      if (depthM != null)       { params.push(depthM);       sets.push(`depth_m = $${params.length}`) }
      if (priceUsd != null)     { params.push(priceUsd);     sets.push(`price_usd = $${params.length}`) }
      if (description != null)  { params.push(description);  sets.push(`description = $${params.length}`) }
      if (status != null && STATUS_VALUES.has(status)) { params.push(status); sets.push(`status = $${params.length}`) }
      if (geometry?.type === 'Polygon') {
        const g = JSON.stringify(geometry)
        params.push(g)
        const n = params.length
        sets.push(`geom = ST_SetSRID(ST_GeomFromGeoJSON($${n}), 4326)`)
        sets.push(`area_sqm = ROUND(ST_Area(ST_SetSRID(ST_GeomFromGeoJSON($${n}), 4326)::geography)::numeric, 2)`)
      }

      if (sets.length === 1) return reply.code(400).send({ success: false, error: 'no fields to update' })

      const { rows } = await fastify.pg.query(
        `UPDATE stands SET ${sets.join(', ')} WHERE id = $1 RETURNING id, stand_number, ward, status`,
        params,
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      invalidateTileLayer('stands'); emitMapEvent({ layer: 'stands', action: 'updated' })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'update stand failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Planner: withdraw (soft-delete) stand ──────────────────────────────
  fastify.delete('/stands/:id', {
    preHandler: requireRole(fastify, ['planner', 'gis_officer', 'admin']),
  }, async (request, reply) => {
    try {
      const { id } = request.params
      const { rows } = await fastify.pg.query(
        `UPDATE stands SET status = 'withdrawn', updated_at = NOW()
          WHERE id = $1 AND status != 'allocated'
          RETURNING id, stand_number, status`,
        [id],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found_or_allocated' })
      invalidateTileLayer('stands'); emitMapEvent({ layer: 'stands', action: 'updated' })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'withdraw stand failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Auth: release my reservation ────────────────────────────────────
  fastify.post('/stands/:id/release', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { id } = request.params
      const userId = request.user.id
      const { rowCount } = await fastify.pg.query(
        `UPDATE stands
            SET status         = 'available',
                reserved_by    = NULL,
                reserved_at    = NULL,
                reserved_until = NULL,
                updated_at     = NOW()
          WHERE id = $1 AND status = 'reserved' AND reserved_by = $2`,
        [id, userId],
      )
      if (rowCount === 0) {
        return reply.code(404).send({ success: false, error: 'not_reserved_by_caller' })
      }
      return reply.send({ success: true })
    } catch (err) {
      request.log.error({ err }, 'release stand failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ══════════════════════════════════════════════════════════════════════
  // STAND NUMBER ALLOCATION (H3 — migration 105)
  // The numbering authority + auditable allocation register. Allocation is no
  // longer a lossy stamp on `stands`; every allocation is a recorded, reversible
  // register entry with a reference number, authorising officer, and history.
  // ══════════════════════════════════════════════════════════════════════

  const ALLOC_ROLES = ['planner', 'admin']

  // ── Sequential stand-number suggestion for a ward ─────────────────────────
  // Advisory: returns the next free number in the ward's sequence (optionally
  // within a prefix, e.g. "STD-"). Uniqueness is still enforced by the
  // stands UNIQUE(ward, stand_number) constraint at create time.
  fastify.get('/stands/next-number', {
    preHandler: requireRole(fastify, ['planner', 'gis_officer', 'admin']),
  }, async (request, reply) => {
    const ward = request.query?.ward
    const prefix = isString(request.query?.prefix, 32) ? String(request.query.prefix) : ''
    if (!isString(ward, 64)) return reply.code(400).send({ success: false, error: 'ward required' })
    try {
      // Largest trailing-integer suffix among this ward's stand numbers that
      // match the prefix; the next number is that + 1. Rows with no trailing
      // digits (m IS NULL) are ignored.
      const { rows } = await fastify.pg.query(
        `SELECT COALESCE(MAX((m[1])::int), 0) + 1 AS n
           FROM stands, LATERAL regexp_match(stand_number, '(\\d+)$') AS m
          WHERE ward = $1 AND stand_number LIKE $2 || '%' AND m IS NOT NULL`,
        [ward, prefix],
      )
      const n = Number(rows[0]?.n) || 1
      return reply.send({
        success: true,
        data: { ward, prefix, next_number: n, suggested_stand_number: `${prefix}${n}` },
      })
    } catch (err) {
      request.log.error({ err }, 'next stand number failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Allocate a stand to an allottee ──────────────────────────────────────
  // Body: { allocatedTo?: uuid, allotteeName?: string, purpose?, conditions? }
  // Transactional: creates the register entry and flips the stand to allocated
  // atomically. The partial unique index (migration 105) makes a double
  // allocation impossible even under a race.
  fastify.post('/stands/:id/allocate', {
    preHandler: requireRole(fastify, ALLOC_ROLES),
  }, async (request, reply) => {
    const { id } = request.params
    const b = request.body || {}
    const allocatedTo  = isString(b.allocatedTo, 64) ? b.allocatedTo : null
    const allotteeName = isString(b.allotteeName, 160) ? b.allotteeName : null
    if (!allocatedTo && !allotteeName) {
      return reply.code(400).send({ success: false, error: 'allocatedTo or allotteeName required' })
    }
    const purpose = ALLOC_PURPOSES.has(b.purpose) ? b.purpose : 'residential'
    const conditions = isString(b.conditions, 4096) ? b.conditions : null

    const client = await fastify.pg.connect()
    try {
      await client.query('BEGIN')
      // Lock the stand row; only available/reserved stands can be allocated.
      const standRes = await client.query(
        `SELECT id, stand_number, ward, status FROM stands WHERE id = $1 FOR UPDATE`, [id])
      const stand = standRes.rows[0]
      if (!stand) { await client.query('ROLLBACK'); return reply.code(404).send({ success: false, error: 'not_found' }) }
      if (!['available', 'reserved'].includes(stand.status)) {
        await client.query('ROLLBACK')
        return reply.code(409).send({
          success: false, error: 'not_allocatable',
          message: `Stand is '${stand.status}' and cannot be allocated.`,
        })
      }

      const referenceNo = await nextAllocationRef(client)
      const allocRes = await client.query(
        `INSERT INTO stand_allocation
           (stand_id, reference_no, allocated_to, allottee_name, purpose, conditions, authorized_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, reference_no, purpose, allocated_at, status`,
        [id, referenceNo, allocatedTo, allotteeName, purpose, conditions, request.user.id],
      )
      await client.query(
        `UPDATE stands
            SET status = 'allocated', allocated_to = $2, allocated_at = NOW(),
                reserved_by = NULL, reserved_at = NULL, reserved_until = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [id, allocatedTo],
      )
      await client.query('COMMIT')
      invalidateTileLayer('stands'); emitMapEvent({ layer: 'stands', action: 'updated' })
      return reply.code(201).send({
        success: true,
        data: { ...allocRes.rows[0], stand_id: id, stand_number: stand.stand_number, ward: stand.ward },
      })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      // Lost the race for the partial unique index (someone allocated first).
      if (err.code === '23505') return reply.code(409).send({ success: false, error: 'already_allocated' })
      request.log.error({ err }, 'allocate stand failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    } finally {
      client.release()
    }
  })

  // ── Revoke the active allocation (soft: history preserved) ───────────────
  fastify.post('/stands/:id/revoke-allocation', {
    preHandler: requireRole(fastify, ALLOC_ROLES),
  }, async (request, reply) => {
    const { id } = request.params
    const reason = isString(request.body?.reason, 4096) ? request.body.reason : null
    const client = await fastify.pg.connect()
    try {
      await client.query('BEGIN')
      const upd = await client.query(
        `UPDATE stand_allocation
            SET status = 'revoked', revoked_at = NOW(), revoked_by = $2, revoke_reason = $3
          WHERE stand_id = $1 AND status = 'active' AND deleted_at IS NULL
          RETURNING id, reference_no`,
        [id, request.user.id, reason],
      )
      if (!upd.rows[0]) {
        await client.query('ROLLBACK')
        return reply.code(404).send({ success: false, error: 'no_active_allocation' })
      }
      await client.query(
        `UPDATE stands SET status = 'available', allocated_to = NULL, allocated_at = NULL, updated_at = NOW()
          WHERE id = $1`,
        [id],
      )
      await client.query('COMMIT')
      invalidateTileLayer('stands'); emitMapEvent({ layer: 'stands', action: 'updated' })
      return reply.send({ success: true, data: upd.rows[0] })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      request.log.error({ err }, 'revoke allocation failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    } finally {
      client.release()
    }
  })

  // ── Allocation history for a stand (active + revoked) ────────────────────
  fastify.get('/stands/:id/allocations', {
    preHandler: requireRole(fastify, ['planner', 'gis_officer', 'planning_clerk', 'eo', 'admin']),
  }, async (request, reply) => {
    const { rows } = await fastify.pg.query(
      `SELECT a.id, a.reference_no, a.allocated_to, a.allottee_name, a.purpose,
              a.conditions, a.status, a.allocated_at, a.revoked_at, a.revoke_reason,
              COALESCE(au.full_name, au.name) AS authorized_by_name,
              COALESCE(al.full_name, al.name) AS allottee_user_name
         FROM stand_allocation a
         LEFT JOIN public.users au ON au.id = a.authorized_by
         LEFT JOIN public.users al ON al.id = a.allocated_to
        WHERE a.stand_id = $1 AND a.deleted_at IS NULL
        ORDER BY a.allocated_at DESC`,
      [request.params.id],
    )
    return reply.send({ success: true, data: rows })
  })

  // ── Allocation certificate (HTML) ────────────────────────────────────────
  fastify.get('/stand-allocations/:aid/certificate', {
    preHandler: requireRole(fastify, ['planner', 'gis_officer', 'planning_clerk', 'eo', 'admin']),
  }, async (request, reply) => {
    const { rows } = await fastify.pg.query(
      `SELECT a.reference_no, a.allottee_name, a.purpose, a.conditions, a.status,
              a.allocated_at, s.stand_number, s.ward,
              ROUND(ST_Area(s.geom::geography)::numeric, 2) AS area_sqm,
              COALESCE(al.full_name, al.name) AS allottee_user_name,
              COALESCE(au.full_name, au.name) AS authorized_by_name
         FROM stand_allocation a
         JOIN stands s ON s.id = a.stand_id
         LEFT JOIN public.users al ON al.id = a.allocated_to
         LEFT JOIN public.users au ON au.id = a.authorized_by
        WHERE a.id = $1 AND a.deleted_at IS NULL`,
      [request.params.aid],
    )
    const r = rows[0]
    if (!r) return reply.code(404).send({ success: false, error: 'not_found' })
    const allottee = r.allottee_name || r.allottee_user_name || '—'
    const dateStr = new Date(r.allocated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    const revoked = r.status === 'revoked'
    const html = `<!doctype html><meta charset="utf-8"><title>Stand Allocation ${escapeHtml(r.reference_no)}</title>
<div style="font-family:Georgia,serif;max-width:720px;margin:2rem auto;color:#1a1a1a;line-height:1.6">
  <h1 style="text-align:center;font-size:1.4rem;margin:0">Vungu Rural District Council</h1>
  <p style="text-align:center;margin:.25rem 0 1.5rem;letter-spacing:.05em">CERTIFICATE OF STAND ALLOCATION</p>
  ${revoked ? '<p style="text-align:center;color:#b00020;font-weight:bold">** THIS ALLOCATION HAS BEEN REVOKED **</p>' : ''}
  <table style="width:100%;border-collapse:collapse">
    <tr><td style="padding:.4rem 0;width:40%"><strong>Reference</strong></td><td>${escapeHtml(r.reference_no)}</td></tr>
    <tr><td style="padding:.4rem 0"><strong>Stand number</strong></td><td>${escapeHtml(r.stand_number)}, ${escapeHtml(r.ward)}</td></tr>
    <tr><td style="padding:.4rem 0"><strong>Area</strong></td><td>${escapeHtml(r.area_sqm)} m²</td></tr>
    <tr><td style="padding:.4rem 0"><strong>Allottee</strong></td><td>${escapeHtml(allottee)}</td></tr>
    <tr><td style="padding:.4rem 0"><strong>Purpose</strong></td><td>${escapeHtml(r.purpose)}</td></tr>
    <tr><td style="padding:.4rem 0"><strong>Date of allocation</strong></td><td>${escapeHtml(dateStr)}</td></tr>
    <tr><td style="padding:.4rem 0;vertical-align:top"><strong>Conditions</strong></td><td>${escapeHtml(r.conditions || 'None')}</td></tr>
  </table>
  <p style="margin-top:2.5rem">Authorised by: <strong>${escapeHtml(r.authorized_by_name || '—')}</strong></p>
  <p style="font-size:.8rem;color:#666;margin-top:2rem">This certificate records the allocation of the above stand. It is not a title deed and confers no rights of ownership until a lease or deed of grant is executed by the Council.</p>
</div>`
    reply.header('Content-Type', 'text/html; charset=utf-8')
    return reply.send(html)
  })
}

module.exports = { standsRoutes }
