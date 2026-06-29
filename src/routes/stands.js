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

  // ── Planner/GIS: MERGE stands (land consolidation) ──────────────────────
  // Unions ≥2 contiguous stands into one new parcel and withdraws the
  // originals — the cadastral "consolidation" operation. Transactional:
  // either the new stand is created and all parents withdrawn, or nothing.
  fastify.post('/stands/merge', {
    preHandler: requireRole(fastify, ['planner', 'gis_officer', 'admin']),
  }, async (request, reply) => {
    const { standIds, standNumber, ward, zoneType, useScale, priceUsd, description } = request.body || {}

    if (!Array.isArray(standIds) || standIds.length < 2)
      return reply.code(400).send({ success: false, error: 'merge requires at least 2 standIds' })
    if (!isString(standNumber, 64))
      return reply.code(400).send({ success: false, error: 'standNumber required for merged stand' })

    try {
      const result = await fastify.pg.transact(async (client) => {
        // Lock the source rows; reject if any is allocated or missing.
        const { rows: sources } = await client.query(
          `SELECT id, ward, zone_id, zone_type, use_scale, status,
                  ST_AsText(geom) AS wkt
             FROM stands
            WHERE id = ANY($1::uuid[])
            FOR UPDATE`,
          [standIds],
        )
        if (sources.length !== standIds.length) throw { code: 'NOT_FOUND' }
        if (sources.some(s => s.status === 'allocated')) throw { code: 'ALLOCATED' }

        // Union must yield a single contiguous Polygon. ST_Union of
        // disjoint parcels yields a MultiPolygon — reject those: you cannot
        // consolidate non-adjacent stands into one parcel.
        const { rows: u } = await client.query(
          `SELECT GeometryType(g) AS gtype,
                  ST_AsGeoJSON(g) AS geojson,
                  ROUND(ST_Area(g::geography)::numeric, 2) AS area_sqm
             FROM (
               SELECT ST_UnaryUnion(ST_Collect(geom)) AS g
                 FROM stands WHERE id = ANY($1::uuid[])
             ) q`,
          [standIds],
        )
        if (u[0].gtype !== 'POLYGON') throw { code: 'NOT_CONTIGUOUS' }

        const wardVal = isString(ward, 64) ? ward : sources[0].ward
        const zoneId  = sources[0].zone_id
        const { rows: created } = await client.query(
          `INSERT INTO stands
             (stand_number, ward, zone_id, zone_type, use_scale,
              price_usd, description, geom, area_sqm, created_by, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,
                   ST_SetSRID(ST_GeomFromGeoJSON($8),4326),$9,$10,'available')
           RETURNING id, stand_number, ward, area_sqm, status,
                     ST_AsGeoJSON(geom)::json AS geometry`,
          [standNumber, wardVal, zoneId,
           zoneType || sources[0].zone_type, useScale || sources[0].use_scale,
           priceUsd || null, description || `Consolidated from ${sources.length} stands`,
           u[0].geojson, u[0].area_sqm, request.user.id],
        )

        await client.query(
          `UPDATE stands SET status='withdrawn', updated_at=NOW()
            WHERE id = ANY($1::uuid[])`,
          [standIds],
        )
        return created[0]
      })

      invalidateTileLayer('stands'); emitMapEvent({ layer: 'stands', action: 'updated' })
      return reply.code(201).send({ success: true, data: result })
    } catch (err) {
      if (err.code === 'NOT_FOUND')      return reply.code(404).send({ success: false, error: 'one or more stands not found' })
      if (err.code === 'ALLOCATED')      return reply.code(409).send({ success: false, error: 'cannot merge an allocated stand' })
      if (err.code === 'NOT_CONTIGUOUS') return reply.code(422).send({ success: false, error: 'stands are not adjacent — consolidation requires touching boundaries' })
      if (err.code === '23505')          return reply.code(409).send({ success: false, error: 'stand_number already exists in this ward' })
      request.log.error({ err }, 'merge stands failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Planner/GIS: SPLIT a stand (subdivision) ────────────────────────────
  // Cuts one stand with a blade LineString (ST_Split) into ≥2 child parcels,
  // withdraws the parent. The cadastral "subdivision" operation.
  fastify.post('/stands/:id/split', {
    preHandler: requireRole(fastify, ['planner', 'gis_officer', 'admin']),
  }, async (request, reply) => {
    const { id } = request.params
    const { blade } = request.body || {}
    if (!blade || blade.type !== 'LineString')
      return reply.code(400).send({ success: false, error: 'blade must be a GeoJSON LineString' })

    try {
      const result = await fastify.pg.transact(async (client) => {
        const { rows: parents } = await client.query(
          `SELECT id, stand_number, ward, zone_id, zone_type, use_scale,
                  price_usd, status
             FROM stands WHERE id = $1 FOR UPDATE`,
          [id],
        )
        const parent = parents[0]
        if (!parent) throw { code: 'NOT_FOUND' }
        if (parent.status === 'allocated') throw { code: 'ALLOCATED' }

        // ST_Split returns a GeometryCollection; dump it into individual
        // polygons. Require ≥2 to be a real subdivision.
        const { rows: parts } = await client.query(
          `SELECT ST_AsGeoJSON(geom)::json AS geometry,
                  ROUND(ST_Area(geom::geography)::numeric, 2) AS area_sqm
             FROM (
               SELECT (ST_Dump(ST_Split(s.geom,
                        ST_SetSRID(ST_GeomFromGeoJSON($2),4326)))).geom AS geom
                 FROM stands s WHERE s.id = $1
             ) q
            WHERE GeometryType(geom) = 'POLYGON'
            ORDER BY ST_Area(geom) DESC`,
          [id, JSON.stringify(blade)],
        )
        if (parts.length < 2) throw { code: 'NO_SPLIT' }

        // Child numbering: parent-A, parent-B, … (skips collisions defensively).
        const suffixes = 'ABCDEFGHIJ'.split('')
        const children = []
        for (let i = 0; i < parts.length; i++) {
          const childNum = `${parent.stand_number}-${suffixes[i] || (i + 1)}`
          const { rows: c } = await client.query(
            `INSERT INTO stands
               (stand_number, ward, zone_id, zone_type, use_scale,
                price_usd, description, geom, area_sqm, created_by, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,
                     ST_SetSRID(ST_GeomFromGeoJSON($8),4326),$9,$10,'available')
             RETURNING id, stand_number, area_sqm, status,
                       ST_AsGeoJSON(geom)::json AS geometry`,
            [childNum, parent.ward, parent.zone_id, parent.zone_type, parent.use_scale,
             null, `Subdivided from ${parent.stand_number}`,
             parts[i].geometry, parts[i].area_sqm, request.user.id],
          )
          children.push(c[0])
        }

        await client.query(
          `UPDATE stands SET status='withdrawn', updated_at=NOW() WHERE id=$1`,
          [id],
        )
        return { parent: parent.stand_number, children }
      })

      invalidateTileLayer('stands'); emitMapEvent({ layer: 'stands', action: 'updated' })
      return reply.code(201).send({ success: true, data: result })
    } catch (err) {
      if (err.code === 'NOT_FOUND') return reply.code(404).send({ success: false, error: 'stand not found' })
      if (err.code === 'ALLOCATED') return reply.code(409).send({ success: false, error: 'cannot subdivide an allocated stand' })
      if (err.code === 'NO_SPLIT')  return reply.code(422).send({ success: false, error: 'blade does not divide the stand into 2+ parts — draw a line fully across it' })
      if (err.code === '23505')     return reply.code(409).send({ success: false, error: 'a child stand_number already exists in this ward' })
      request.log.error({ err }, 'split stand failed')
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
