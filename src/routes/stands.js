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
const { invalidateTileLayer } = require('./tiles')

const RESERVATION_TTL_MIN = 30

const STATUS_VALUES = new Set(['available', 'reserved', 'allocated', 'withdrawn'])

const isString = (v, max = 255) =>
  typeof v === 'string' && v.length > 0 && v.length <= max

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
      invalidateTileLayer('stands')
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
      invalidateTileLayer('stands')
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
      invalidateTileLayer('stands')
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
}

module.exports = { standsRoutes }
