// src/routes/planning.js
// ─────────────────────────────────────────────────────────────────────────
// Persistence for the in-browser land-subdivision planner (Phase 1).
//
//   GET    /api/planning/projects          list saved projects (summary rows)
//   GET    /api/planning/projects/:id       full PlanningProject snapshot
//   POST   /api/planning/projects           create / update (upsert by id)
//   DELETE /api/planning/projects/:id       remove a project
//   GET    /api/planning/areas/:areaId/lots lots for a planning area (from JSON)
//
// Designs live in spatial_planning.planning_project (migration 095) as a JSONB
// snapshot + a few promoted columns. This NEVER touches the permit/case tables
// or the cadastre. Writes need an editor role; reads are open to planners/GIS.
// ─────────────────────────────────────────────────────────────────────────

const { requireRole } = require('../middleware/jwtAuth')

const EDITORS = ['planner', 'admin']
const READERS = ['planner', 'gis_officer', 'admin']

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
async function planningRoutes(fastify) {
  // ── list projects (summary) ──────────────────────────────────────────────
  fastify.get('/planning/projects', { preHandler: requireRole(fastify, READERS) }, async (_request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT id, name, source_parcel_id, area_sqm, lot_count, road_length_m, updated_at
           FROM spatial_planning.planning_project
          WHERE deleted_at IS NULL
          ORDER BY updated_at DESC
          LIMIT 200`,
      )
      return reply.send({ data: rows })
    } catch (err) {
      fastify.log.error({ err }, 'planning list failed')
      return reply.code(500).send({ success: false, error: 'list_failed' })
    }
  })

  // ── get one (full snapshot) ──────────────────────────────────────────────
  fastify.get('/planning/projects/:id', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT data, revision FROM spatial_planning.planning_project WHERE id = $1 AND deleted_at IS NULL`,
        [String(request.params.id)],
      )
      if (!rows.length) return reply.code(404).send({ success: false, error: 'not_found' })
      // Surface the authoritative revision so the client can send it back as the
      // optimistic-lock base on its next save (no silent overwrite).
      return reply.send({ data: { ...rows[0].data, revision: rows[0].revision } })
    } catch (err) {
      fastify.log.error({ err }, 'planning get failed')
      return reply.code(500).send({ success: false, error: 'get_failed' })
    }
  })

  // ── create / update (upsert by id) ───────────────────────────────────────
  fastify.post('/planning/projects', { preHandler: requireRole(fastify, EDITORS) }, async (request, reply) => {
    const p = request.body || {}
    if (!p.id) return reply.code(400).send({ success: false, error: 'missing_id' })

    const area = p.planningArea || {}
    const geom = area.geom ? JSON.stringify(area.geom) : null
    const lotCount = Array.isArray(p.lots) ? p.lots.length : 0
    const roadLen = (p.metrics && Number(p.metrics.roadLengthM)) || null
    const actor = request.user?.id != null ? String(request.user.id) : null
    // Optimistic-lock base: the revision the client last loaded/saved (null = don't check).
    const baseRevision = Number.isInteger(p.baseRevision) ? p.baseRevision : null
    const status = (p.status && String(p.status)) || 'draft'
    // Statutory case link (migration 108). Validate shape here; the FK validates existence.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const permitAppId = (typeof p.permitAppId === 'string' && UUID_RE.test(p.permitAppId)) ? p.permitAppId : null

    const client = await fastify.pg.connect()
    try {
      await client.query('BEGIN')

      // Lock the row (if any) and read the authoritative current revision.
      const cur = await client.query(
        `SELECT revision, permit_app_id FROM spatial_planning.planning_project WHERE id = $1 FOR UPDATE`,
        [String(p.id)],
      )
      const exists = cur.rows.length > 0
      const currentRevision = exists ? Number(cur.rows[0].revision) : 0

      // Conflict: the project moved on since the client loaded it → never overwrite.
      if (exists && baseRevision !== null && baseRevision !== currentRevision) {
        await client.query('ROLLBACK')
        return reply.code(409).send({ success: false, error: 'revision_conflict', currentRevision })
      }

      const newRevision = currentRevision + 1

      await client.query(
        `INSERT INTO spatial_planning.planning_project
           (id, name, source_parcel_id, area_sqm, lot_count, road_length_m, data, geom, revision, created_by, permit_app_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb,
                 CASE WHEN $8::text IS NULL THEN NULL
                      ELSE ST_Multi(spatial_planning.geom_from_geojson_checked($8, 4326)) END,
                 $9, $10, $11, now())
         ON CONFLICT (id) DO UPDATE SET
           name             = EXCLUDED.name,
           source_parcel_id = EXCLUDED.source_parcel_id,
           area_sqm         = EXCLUDED.area_sqm,
           lot_count        = EXCLUDED.lot_count,
           road_length_m    = EXCLUDED.road_length_m,
           data             = EXCLUDED.data,
           geom             = EXCLUDED.geom,
           revision         = EXCLUDED.revision,
           permit_app_id    = COALESCE(EXCLUDED.permit_app_id, planning_project.permit_app_id),
           deleted_at       = NULL,
           deleted_by       = NULL,
           updated_at       = now()`,
        [
          String(p.id),
          p.name || 'Untitled subdivision',
          area.sourceParcelId || null,
          area.areaSqm != null ? Number(area.areaSqm) : null,
          lotCount,
          roadLen,
          JSON.stringify({ ...p, revision: newRevision }),
          geom,
          newRevision,
          actor,
          permitAppId,
        ],
      )

      // Append the immutable revision snapshot (history).
      await client.query(
        `INSERT INTO spatial_planning.planning_revision
           (project_id, revision, name, status, data, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [String(p.id), newRevision, p.name || 'Untitled subdivision', status, JSON.stringify({ ...p, revision: newRevision }), actor],
      )

      // Statutory hand-off: a submitted revision linked to a permit case writes
      // the case audit event (migration 082) in the SAME transaction — the
      // submission and its audit row commit or roll back together.
      const linkedCase = permitAppId || (exists ? cur.rows[0].permit_app_id : null)
      if (status === 'submitted' && linkedCase) {
        await client.query(
          `INSERT INTO spatial_planning.permit_event
             (permit_app_id, event_type, actor_id, actor_role, detail)
           VALUES ($1, 'gis_proposal_submitted', $2, $3, $4::jsonb)`,
          [linkedCase, request.user?.id || null, request.user?.role || null,
           JSON.stringify({
             project_id: String(p.id),
             name: p.name || 'Untitled subdivision',
             revision: newRevision,
             lot_count: lotCount,
             area_sqm: area.areaSqm != null ? Number(area.areaSqm) : null,
             road_length_m: roadLen,
           })],
        )
      }

      await client.query('COMMIT')
      return reply.send({ data: { id: p.id, lotCount, revision: newRevision, permitAppId: linkedCase } })
    } catch (err) {
      try { await client.query('ROLLBACK') } catch { /* ignore */ }
      if (err.code === '22023') return reply.code(422).send({ success: false, error: 'invalid_geometry', message: err.message })
      if (err.code === '23503') return reply.code(422).send({ success: false, error: 'bad_case_link' })
      fastify.log.error({ err }, 'planning save failed')
      return reply.code(500).send({ success: false, error: 'save_failed' })
    } finally {
      client.release()
    }
  })

  // ── delete ───────────────────────────────────────────────────────────────
  fastify.delete('/planning/projects/:id', { preHandler: requireRole(fastify, EDITORS) }, async (request, reply) => {
    try {
      // Soft delete (migration 103): the snapshot and its revision history stay;
      // re-saving the same project id resurrects it (upsert clears deleted_at).
      await fastify.pg.query(
        `UPDATE spatial_planning.planning_project
            SET deleted_at = NOW(), deleted_by = $2
          WHERE id = $1 AND deleted_at IS NULL`,
        [String(request.params.id), request.user?.id != null ? String(request.user.id) : null],
      )
      return reply.send({ data: { ok: true } })
    } catch (err) {
      fastify.log.error({ err }, 'planning delete failed')
      return reply.code(500).send({ success: false, error: 'delete_failed' })
    }
  })

  // ── lots for a planning area (read out of the stored snapshot) ───────────
  fastify.get('/planning/areas/:areaId/lots', { preHandler: requireRole(fastify, READERS) }, async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT data->'lots' AS lots
           FROM spatial_planning.planning_project
          WHERE data->'planningArea'->>'id' = $1 AND deleted_at IS NULL
          ORDER BY updated_at DESC
          LIMIT 1`,
        [String(request.params.areaId)],
      )
      return reply.send({ data: rows.length ? (rows[0].lots || []) : [] })
    } catch (err) {
      fastify.log.error({ err }, 'planning lots failed')
      return reply.code(500).send({ success: false, error: 'lots_failed' })
    }
  })
}

module.exports = { planningRoutes }
