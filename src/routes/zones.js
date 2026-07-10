/**
 * Planning Zones routes — mutable zone management for planners and EO.
 *
 * Works with the application-level zone tables (proposed_peri_urban_zones /
 * zone_land_use_controls) that sit alongside the read-only gpkg-imported
 * vungu_proposed_peri_urban_zones spatial table.
 *
 *   GET    /api/zones                      → all zones as GeoJSON FeatureCollection
 *   GET    /api/zones/:id                  → single zone + land-use controls
 *   POST   /api/zones                      → create zone (planner/eo/admin)
 *   PUT    /api/zones/:id                  → update zone properties/geometry
 *   DELETE /api/zones/:id                  → soft-deactivate zone
 *   GET    /api/zones/:id/controls         → land-use controls for this zone
 *   POST   /api/zones/:id/controls         → add/update a land-use control
 *   DELETE /api/zones/:id/controls/:cid    → remove a land-use control
 */

const { requireRole } = require('../middleware/jwtAuth')

const ZONE_ROLES = ['planner', 'eo', 'gis_officer', 'admin']

async function zonesRoutes(fastify) {

  // ── List zones as GeoJSON ───────────────────────────────────────────
  fastify.get('/zones', async (request, reply) => {
    try {
      const { ward, zoneType, scaleCategory, active } = request.query || {}
      const params = []
      const where  = []

      if (active !== 'false') {
        where.push('z.is_active = true')
      }
      if (ward) {
        params.push(`%${ward}%`)
        where.push(`z.ward ILIKE $${params.length}`)
      }
      if (zoneType) {
        params.push(zoneType)
        where.push(`z.zone_type = $${params.length}`)
      }
      if (scaleCategory) {
        params.push(scaleCategory)
        where.push(`z.scale_category = $${params.length}`)
      }

      const sql = `
        SELECT
          z.id, z.zone, z.zone_code, z.zone_type, z.scale_category,
          z.authority, z.zone_description, z.ward, z.area_ha, z.is_active,
          z.created_at, z.updated_at,
          ST_AsGeoJSON(z.geom)::JSON AS geometry,
          ST_X(ST_Centroid(z.geom)) AS centroid_lng,
          ST_Y(ST_Centroid(z.geom)) AS centroid_lat
        FROM vungu_proposed_peri_urban_zones z
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY z.zone, z.id
        LIMIT 2000`

      const { rows } = await fastify.pg.query(sql, params)

      const features = rows.map(r => ({
        type: 'Feature',
        id: r.id,
        geometry: r.geometry,
        properties: {
          id: r.id, zone: r.zone, zoneCode: r.zone_code,
          zoneType: r.zone_type, scaleCategory: r.scale_category,
          authority: r.authority, description: r.zone_description,
          ward: r.ward, areaHa: r.area_ha, isActive: r.is_active,
          centroid: [r.centroid_lng, r.centroid_lat],
          createdAt: r.created_at, updatedAt: r.updated_at,
        },
      }))

      return reply.send({ type: 'FeatureCollection', features })
    } catch (err) {
      request.log.error({ err }, 'list zones failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Single zone + land-use controls ────────────────────────────────
  fastify.get('/zones/:id', async (request, reply) => {
    try {
      const { id } = request.params
      const { rows } = await fastify.pg.query(
        `SELECT z.id, z.zone, z.zone_code, z.zone_type, z.scale_category,
                z.authority, z.zone_description, z.ward, z.area_ha, z.is_active,
                z.created_at, z.updated_at,
                ST_AsGeoJSON(z.geom)::JSON AS geometry
         FROM vungu_proposed_peri_urban_zones z WHERE z.id = $1`,
        [id],
      )
      const r = rows[0]
      if (!r) return reply.code(404).send({ success: false, error: 'not_found' })

      // Fetch land-use controls
      const { rows: controls } = await fastify.pg.query(
        `SELECT zlc.id, zlc.control_type, zlc.authority, zlc.notes,
                lug.group_code, lug.description AS use_description,
                lug.development_category, lug.use_scale
         FROM zone_land_use_controls zlc
         JOIN land_use_groups lug ON lug.group_id = zlc.land_use_group_id
         WHERE zlc.zone_id = $1 AND zlc.deleted_at IS NULL
         ORDER BY zlc.control_type, lug.group_code`,
        [id],
      )

      return reply.send({
        success: true,
        data: {
          ...r,
          landUseControls: controls,
        },
      })
    } catch (err) {
      request.log.error({ err }, 'get zone failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Create zone ─────────────────────────────────────────────────────
  fastify.post('/zones', {
    preHandler: requireRole(fastify, ZONE_ROLES),
  }, async (request, reply) => {
    try {
      const {
        zone, zoneCode, zoneType, scaleCategory, authority,
        description, ward, geometry,
      } = request.body || {}

      if (!zone) return reply.code(400).send({ success: false, error: 'zone name required' })
      if (!geometry || geometry.type !== 'Polygon')
        return reply.code(400).send({ success: false, error: 'geometry must be a GeoJSON Polygon' })

      const geomJson = JSON.stringify(geometry)
      const { rows } = await fastify.pg.query(
        `INSERT INTO vungu_proposed_peri_urban_zones
           (zone, zone_code, zone_type, scale_category, authority,
            zone_description, ward, geom, area_ha, is_active, created_at, updated_at)
         VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           ST_SetSRID(ST_GeomFromGeoJSON($8), 4326),
           ROUND(ST_Area(ST_SetSRID(ST_GeomFromGeoJSON($8), 4326)::geography)::numeric / 10000, 4),
           true, NOW(), NOW()
         )
         RETURNING id, zone, zone_type, scale_category, ward`,
        [zone, zoneCode || null, zoneType || null, scaleCategory || null,
         authority || 'Vungu RDC', description || null, ward || null, geomJson],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'create zone failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Update zone ─────────────────────────────────────────────────────
  fastify.put('/zones/:id', {
    preHandler: requireRole(fastify, ZONE_ROLES),
  }, async (request, reply) => {
    try {
      const { id } = request.params
      const {
        zone, zoneCode, zoneType, scaleCategory, authority,
        description, ward, isActive, geometry,
      } = request.body || {}

      const sets = ['updated_at = NOW()']
      const params = [id]

      if (zone != null)          { params.push(zone);          sets.push(`zone = $${params.length}`) }
      if (zoneCode != null)      { params.push(zoneCode);      sets.push(`zone_code = $${params.length}`) }
      if (zoneType != null)      { params.push(zoneType);      sets.push(`zone_type = $${params.length}`) }
      if (scaleCategory != null) { params.push(scaleCategory); sets.push(`scale_category = $${params.length}`) }
      if (authority != null)     { params.push(authority);     sets.push(`authority = $${params.length}`) }
      if (description != null)   { params.push(description);   sets.push(`zone_description = $${params.length}`) }
      if (ward != null)          { params.push(ward);          sets.push(`ward = $${params.length}`) }
      if (isActive != null)      { params.push(isActive);      sets.push(`is_active = $${params.length}`) }
      if (geometry?.type === 'Polygon') {
        const g = JSON.stringify(geometry)
        params.push(g)
        const n = params.length
        sets.push(`geom = ST_SetSRID(ST_GeomFromGeoJSON($${n}), 4326)`)
        sets.push(`area_ha = ROUND(ST_Area(ST_SetSRID(ST_GeomFromGeoJSON($${n}), 4326)::geography)::numeric / 10000, 4)`)
      }

      if (sets.length === 1) return reply.code(400).send({ success: false, error: 'no fields to update' })

      const { rows } = await fastify.pg.query(
        `UPDATE vungu_proposed_peri_urban_zones SET ${sets.join(', ')} WHERE id = $1
         RETURNING id, zone, zone_type, scale_category, ward, is_active`,
        params,
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'update zone failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Soft-delete zone ────────────────────────────────────────────────
  fastify.delete('/zones/:id', {
    preHandler: requireRole(fastify, ZONE_ROLES),
  }, async (request, reply) => {
    try {
      const { id } = request.params
      const { rows } = await fastify.pg.query(
        `UPDATE vungu_proposed_peri_urban_zones
          SET is_active = false, updated_at = NOW()
          WHERE id = $1
          RETURNING id, zone, is_active`,
        [id],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'deactivate zone failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Land-use controls for a zone ───────────────────────────────────
  fastify.get('/zones/:id/controls', async (request, reply) => {
    try {
      const { id } = request.params
      const { rows } = await fastify.pg.query(
        `SELECT zlc.id, zlc.control_type, zlc.authority, zlc.notes,
                lug.group_id, lug.group_code, lug.description,
                lug.development_category, lug.use_scale
         FROM zone_land_use_controls zlc
         JOIN land_use_groups lug ON lug.group_id = zlc.land_use_group_id
         WHERE zlc.zone_id = $1 AND zlc.deleted_at IS NULL
         ORDER BY
           CASE zlc.control_type
             WHEN 'permitted'       THEN 1
             WHEN 'special_consent' THEN 2
             WHEN 'prohibited'      THEN 3
             ELSE 4
           END,
           lug.group_code`,
        [id],
      )
      return reply.send({ success: true, data: rows })
    } catch (err) {
      request.log.error({ err }, 'list zone controls failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Add/upsert a land-use control ──────────────────────────────────
  fastify.post('/zones/:id/controls', {
    preHandler: requireRole(fastify, ZONE_ROLES),
  }, async (request, reply) => {
    try {
      const { id } = request.params
      const { landUseGroupId, controlType, authority, notes } = request.body || {}

      if (!landUseGroupId) return reply.code(400).send({ success: false, error: 'landUseGroupId required' })
      const VALID = new Set(['permitted', 'prohibited', 'special_consent'])
      if (!VALID.has(controlType)) return reply.code(400).send({ success: false, error: 'invalid controlType' })

      const { rows } = await fastify.pg.query(
        `INSERT INTO zone_land_use_controls
           (zone_id, land_use_group_id, control_type, authority, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (zone_id, land_use_group_id)
           DO UPDATE SET control_type = EXCLUDED.control_type,
                         authority    = COALESCE(EXCLUDED.authority, zone_land_use_controls.authority),
                         notes        = EXCLUDED.notes,
                         deleted_at   = NULL,
                         deleted_by   = NULL,
                         updated_at   = NOW()
         RETURNING id, control_type`,
        [id, landUseGroupId, controlType, authority || 'Vungu RDC', notes || null],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'add zone control failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Remove a land-use control ───────────────────────────────────────
  fastify.delete('/zones/:id/controls/:cid', {
    preHandler: requireRole(fastify, ZONE_ROLES),
  }, async (request, reply) => {
    try {
      const { id, cid } = request.params
      // Soft delete (migration 103): zoning controls are planning policy records.
      // Re-adding the same zone/group pair resurrects the row via the upsert above.
      const { rowCount } = await fastify.pg.query(
        `UPDATE zone_land_use_controls
            SET deleted_at = NOW(), deleted_by = $3
          WHERE id = $1 AND zone_id = $2 AND deleted_at IS NULL`,
        [cid, id, request.user.id],
      )
      if (rowCount === 0) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true })
    } catch (err) {
      request.log.error({ err }, 'remove zone control failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

module.exports = { zonesRoutes }
