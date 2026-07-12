// src/routes/gis.js
// ─────────────────────────────────────────────────────────────────────────
// GIS editing + spatial-analysis endpoints.
//
//   POST   /api/gis/features        digitize: persist a drawn GeoJSON geometry
//   GET    /api/gis/features        list digitized features as a FeatureCollection
//   DELETE /api/gis/features/:id    remove a digitized feature
//   GET    /api/gis/within          authoritative s.26(3) notification-radius
//                                   query: parcels within N metres of a point
//
// Digitized geometry lives in spatial_planning.gis_feature (migration 091) so it
// never mutates the imported cadastre. Writes require an editor role; the
// proximity query is open to any council-staff reader.
// ─────────────────────────────────────────────────────────────────────────

const { requireRole } = require('../middleware/jwtAuth')

const EDITORS = ['gis_officer', 'planner', 'admin']
const READERS = [
  'gis_officer', 'planner', 'planning_clerk', 'eo',
  'env_officer', 'building_inspector', 'surveyor', 'admin',
]

// Append one row to the GIS edit-history audit trail. Non-fatal: a logging
// failure must never block the actual edit.
async function logHistory(fastify, entry) {
  const {
    feature_id = null, layer = null, action,
    props = null, geometry = null, detail = null, actor = null,
  } = entry || {}
  try {
    await fastify.pg.query(
      `INSERT INTO spatial_planning.gis_feature_history
         (feature_id, layer, action, props, geom, detail, actor)
       VALUES ($1, $2, $3, $4::jsonb,
               CASE WHEN $5::text IS NULL THEN NULL
                    ELSE ST_SetSRID(ST_GeomFromGeoJSON($5), 4326) END,
               $6::jsonb, $7)`,
      [
        feature_id, layer, action,
        props != null ? JSON.stringify(props) : null,
        geometry != null ? (typeof geometry === 'string' ? geometry : JSON.stringify(geometry)) : null,
        detail != null ? JSON.stringify(detail) : null,
        actor,
      ],
    )
  } catch (err) {
    fastify.log.error({ err }, 'gis history log failed')
  }
}

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
async function gisRoutes(fastify) {
  // ── list digitized features as a GeoJSON FeatureCollection ───────────────
  fastify.get('/gis/features', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    const layer = request.query?.layer ? String(request.query.layer) : null
    try {
      const { rows } = await fastify.pg.query(
        `SELECT id, layer, props, created_by, created_at,
                ST_AsGeoJSON(geom)::json AS geometry
           FROM spatial_planning.gis_feature
          WHERE ($1::text IS NULL OR layer = $1) AND deleted_at IS NULL
          ORDER BY id DESC
          LIMIT 2000`,
        [layer],
      )
      return {
        type: 'FeatureCollection',
        features: rows.map((r) => ({
          type: 'Feature',
          id: r.id,
          geometry: r.geometry,
          properties: {
            ...(r.props || {}),
            id: r.id,
            layer: r.layer,
            created_by: r.created_by,
            created_at: r.created_at,
          },
        })),
      }
    } catch (err) {
      fastify.log.error({ err }, 'gis features list failed')
      return reply.code(500).send({ error: 'Failed to list features' })
    }
  })

  // ── persist one digitized feature ────────────────────────────────────────
  // Body: { geometry: <GeoJSON geometry>, properties?: object, layer?: string }
  fastify.post('/gis/features', { preHandler: requireRole(fastify, EDITORS) }, async (request, reply) => {
    const body = request.body || {}
    const geometry = body.geometry
    if (!geometry || typeof geometry !== 'object' || !geometry.type) {
      return reply.code(400).send({ error: 'geometry (GeoJSON) is required' })
    }
    const layer = body.layer ? String(body.layer).slice(0, 64) : 'digitized'
    const props = body.properties && typeof body.properties === 'object' ? body.properties : {}
    const actor = request.user?.id != null ? String(request.user.id) : null
    try {
      const { rows } = await fastify.pg.query(
        `INSERT INTO spatial_planning.gis_feature (layer, props, geom, created_by)
         VALUES ($1, $2::jsonb, spatial_planning.geom_from_geojson_checked($3, 4326), $4)
         RETURNING id, created_at`,
        [layer, JSON.stringify(props), JSON.stringify(geometry), actor],
      )
      await logHistory(fastify, { feature_id: rows[0].id, layer, action: 'create', props, geometry, actor })
      return reply.code(201).send({ success: true, id: rows[0].id, created_at: rows[0].created_at })
    } catch (err) {
      if (err.code === '22023') return reply.code(422).send({ error: 'invalid_geometry', message: err.message })
      fastify.log.error({ err }, 'gis feature insert failed')
      return reply.code(400).send({ error: 'Invalid geometry or insert failed' })
    }
  })

  // ── edit one feature's geometry/props (logged to history) ────────────────
  // Body: { geometry?: <GeoJSON geometry>, properties?: object }
  fastify.put('/gis/features/:id', { preHandler: requireRole(fastify, EDITORS) }, async (request, reply) => {
    const id = Number(request.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' })
    const body = request.body || {}
    const geometry = body.geometry && typeof body.geometry === 'object' ? body.geometry : null
    const props = body.properties && typeof body.properties === 'object' ? body.properties : null
    if (!geometry && !props) {
      return reply.code(400).send({ error: 'geometry or properties is required' })
    }
    const actor = request.user?.id != null ? String(request.user.id) : null
    try {
      const { rows } = await fastify.pg.query(
        `UPDATE spatial_planning.gis_feature
            SET geom = CASE WHEN $2::text IS NULL THEN geom
                            ELSE spatial_planning.geom_from_geojson_checked($2, 4326) END,
                props = COALESCE($3::jsonb, props),
                updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, layer, props, ST_AsGeoJSON(geom) AS geometry`,
        [id, geometry != null ? JSON.stringify(geometry) : null, props != null ? JSON.stringify(props) : null],
      )
      if (!rows.length) return reply.code(404).send({ error: 'not found' })
      await logHistory(fastify, {
        feature_id: id, layer: rows[0].layer, action: 'update',
        props: rows[0].props, geometry: rows[0].geometry, actor,
      })
      return { success: true, id }
    } catch (err) {
      if (err.code === '22023') return reply.code(422).send({ error: 'invalid_geometry', message: err.message })
      fastify.log.error({ err }, 'gis feature update failed')
      return reply.code(400).send({ error: 'Invalid geometry or update failed' })
    }
  })

  // ── delete one digitized feature ─────────────────────────────────────────
  fastify.delete('/gis/features/:id', { preHandler: requireRole(fastify, EDITORS) }, async (request, reply) => {
    const id = Number(request.params.id)
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'bad id' })
    const actor = request.user?.id != null ? String(request.user.id) : null
    try {
      // Soft delete (migration 103): the feature row stays recoverable; the
      // history table keeps its full 'delete' entry exactly as before.
      const { rows } = await fastify.pg.query(
        `UPDATE spatial_planning.gis_feature
            SET deleted_at = NOW(), deleted_by = $2
          WHERE id = $1 AND deleted_at IS NULL
         RETURNING layer, props, ST_AsGeoJSON(geom) AS geometry`,
        [id, actor],
      )
      if (!rows.length) return reply.code(404).send({ error: 'not found' })
      await logHistory(fastify, {
        feature_id: id, layer: rows[0].layer, action: 'delete',
        props: rows[0].props, geometry: rows[0].geometry, actor,
      })
      return { success: true, id }
    } catch (err) {
      fastify.log.error({ err }, 'gis feature delete failed')
      return reply.code(500).send({ error: 'Delete failed' })
    }
  })

  // ── bulk import (uploaded GeoJSON / KML / shapefile) ─────────────────────
  // Body: { layer: string, features: GeoJSON Feature[] }. Inserts all features
  // in one transaction so a failed import leaves nothing behind. bodyLimit is
  // raised because uploaded layers can be several MB of JSON.
  fastify.post(
    '/gis/import',
    { preHandler: requireRole(fastify, EDITORS), bodyLimit: 16 * 1024 * 1024 },
    async (request, reply) => {
      const body = request.body || {}
      const layer = body.layer ? String(body.layer).slice(0, 64) : 'imported'
      const features = Array.isArray(body.features)
        ? body.features
        : Array.isArray(body.featureCollection?.features)
          ? body.featureCollection.features
          : null
      if (!Array.isArray(features) || !features.length) {
        return reply.code(400).send({ error: 'features array is required' })
      }
      if (features.length > 10000) {
        return reply.code(413).send({ error: 'too many features (max 10000) — split the file' })
      }
      const createdBy = request.user?.id != null ? String(request.user.id) : null
      const client = await fastify.pg.connect()
      try {
        await client.query('BEGIN')
        let inserted = 0
        for (const f of features) {
          const geom = f && f.geometry
          if (!geom || !geom.type || !geom.coordinates) continue
          const props = f.properties && typeof f.properties === 'object' ? f.properties : {}
          // Bulk import of external files (SHP/KML/GeoJSON) may carry minor
          // invalidities — repair on the way in (allow_repair := true) rather
          // than failing the whole file; unrepairable geometry still aborts.
          await client.query(
            `INSERT INTO spatial_planning.gis_feature (layer, props, geom, created_by)
             VALUES ($1, $2::jsonb, spatial_planning.geom_from_geojson_checked($3, 4326, true), $4)`,
            [layer, JSON.stringify(props), JSON.stringify(geom), createdBy],
          )
          inserted++
        }
        await client.query('COMMIT')
        await logHistory(fastify, { layer, action: 'import', detail: { count: inserted }, actor: createdBy })
        return reply.code(201).send({ success: true, layer, inserted })
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        if (err.code === '22023') return reply.code(422).send({ error: 'invalid_geometry', message: err.message })
        fastify.log.error({ err }, 'gis import failed')
        return reply.code(400).send({ error: 'Import failed — check the geometry is valid GeoJSON.' })
      } finally {
        client.release()
      }
    },
  )

  // ── notification radius (s.26(3) abutting-owner analysis) ────────────────
  // Authoritative parcels-within-radius using ST_DWithin over the full
  // cadastre, not just what is rendered in the browser viewport.
  fastify.get('/gis/within', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    const lng = Number(request.query?.lng)
    const lat = Number(request.query?.lat)
    const radius = Math.min(Math.max(Number(request.query?.radius) || 100, 1), 5000)
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return reply.code(400).send({ error: 'lng and lat are required' })
    }
    try {
      const { rows } = await fastify.pg.query(
        `WITH site AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS g)
         SELECT COALESCE(NULLIF(name, ''), name_cfu, 'Parcel ' || fid) AS label,
                district, area_ha,
                ST_Distance(geom::geography, site.g) AS distance_m
           FROM vungu_parcels, site
          WHERE geom IS NOT NULL
            AND ST_DWithin(geom::geography, site.g, $3)
          ORDER BY distance_m
          LIMIT 500`,
        [lng, lat, radius],
      )
      return {
        success: true,
        radius_m: radius,
        count: rows.length,
        parcels: rows.map((r) => ({
          label: r.label,
          district: r.district,
          area_ha: r.area_ha != null ? Number(r.area_ha) : null,
          distance_m: Math.round(Number(r.distance_m)),
        })),
      }
    } catch (err) {
      fastify.log.error({ err }, 'gis within query failed')
      return reply.code(500).send({ error: 'Proximity query failed' })
    }
  })

  // ── edit history (audit trail) ───────────────────────────────────────────
  // Recent edits, newest first. Optional ?feature_id and ?layer filters.
  fastify.get('/gis/history', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    const fidRaw = request.query?.feature_id
    const featureId = fidRaw != null && fidRaw !== '' ? Number(fidRaw) : null
    const layer = request.query?.layer ? String(request.query.layer) : null
    const limit = Math.min(Math.max(Number(request.query?.limit) || 100, 1), 500)
    try {
      const { rows } = await fastify.pg.query(
        `SELECT id, feature_id, layer, action, detail, actor, at
           FROM spatial_planning.gis_feature_history
          WHERE ($1::bigint IS NULL OR feature_id = $1)
            AND ($2::text IS NULL OR layer = $2)
          ORDER BY at DESC
          LIMIT $3`,
        [featureId, layer, limit],
      )
      return { success: true, count: rows.length, history: rows }
    } catch (err) {
      fastify.log.error({ err }, 'gis history list failed')
      return reply.code(500).send({ error: 'Failed to list history' })
    }
  })
}

module.exports = { gisRoutes }
