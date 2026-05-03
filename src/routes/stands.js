/**
 * Stands routes — public list/detail + authenticated reserve flow.
 *
 *   GET  /api/stands                  → GeoJSON FeatureCollection of stands
 *                                       (default: status='available')
 *   GET  /api/stands/:id              → single stand row + zone + suggested plan summary
 *   POST /api/stands/:id/reserve      → authenticated; soft-reserves a stand for 30 min
 *
 * The list endpoint is intentionally cheap (no full geometry per row in
 * dense queries; the client gets the polygon when it zooms / filters).
 * It emits proper GeoJSON so MapLibre's `addSource({ type: 'geojson' })`
 * can consume it directly.
 */

const { requireAuth } = require('../middleware/jwtAuth')
const planningAssistant = require('../services/planningAssistant')

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
