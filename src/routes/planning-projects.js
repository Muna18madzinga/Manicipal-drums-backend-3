/**
 * Planning project routes — persistence for the planner's land-subdivision
 * design sessions (usePlanningTools / PlanningPanel in the frontend).
 *
 *   GET    /api/planning/projects        → list current user's projects (admin: all)
 *   GET    /api/planning/projects/:id     → full project snapshot
 *   POST   /api/planning/projects         → upsert a project snapshot
 *   DELETE /api/planning/projects/:id     → delete a project
 *
 * The browser holds the live interactive design; it POSTs a full snapshot
 * (planningArea, roads, constraints, blocks, lots, openSpace, rules). We store
 * it as JSONB and extract name/area/lot_count for the project list.
 */

const { requireAuth, requireRole } = require('../middleware/jwtAuth')

const PLANNER_ROLES = ['planner', 'gis_officer', 'admin']

async function planningProjectsRoutes(fastify) {
  // Ensure the table exists even if the migration runner hasn't been updated
  // on this environment — idempotent and cheap (runs once at registration).
  await fastify.pg.query(`
    CREATE TABLE IF NOT EXISTS planning_projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL DEFAULT 'Untitled subdivision',
      created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
      snapshot    JSONB NOT NULL,
      area_sqm    NUMERIC(14,2),
      lot_count   INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch((err) => fastify.log.warn({ err }, 'planning_projects ensure-table failed'))

  // ── List ────────────────────────────────────────────────────────────────
  fastify.get('/planning/projects', {
    preHandler: requireRole(fastify, PLANNER_ROLES),
  }, async (request, reply) => {
    try {
      const isAdmin = request.user.role === 'admin'
      const params = []
      let where = ''
      if (!isAdmin) { params.push(request.user.id); where = 'WHERE created_by = $1' }
      const { rows } = await fastify.pg.query(
        `SELECT id, name, area_sqm, lot_count, created_at, updated_at
           FROM planning_projects ${where}
          ORDER BY updated_at DESC
          LIMIT 200`,
        params,
      )
      return reply.send({
        success: true,
        data: rows.map(r => ({
          id: r.id,
          name: r.name,
          areaSqm: r.area_sqm == null ? null : Number(r.area_sqm),
          lotCount: r.lot_count,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      })
    } catch (err) {
      request.log.error({ err }, 'list planning projects failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Get one ─────────────────────────────────────────────────────────────
  fastify.get('/planning/projects/:id', {
    preHandler: requireRole(fastify, PLANNER_ROLES),
  }, async (request, reply) => {
    try {
      const { id } = request.params
      const { rows } = await fastify.pg.query(
        `SELECT snapshot, created_by FROM planning_projects WHERE id = $1`,
        [id],
      )
      const row = rows[0]
      if (!row) return reply.code(404).send({ success: false, error: 'not_found' })
      if (request.user.role !== 'admin' && row.created_by && row.created_by !== request.user.id) {
        return reply.code(403).send({ success: false, error: 'forbidden' })
      }
      return reply.send({ success: true, data: row.snapshot })
    } catch (err) {
      request.log.error({ err }, 'get planning project failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Upsert (save) ───────────────────────────────────────────────────────
  fastify.post('/planning/projects', {
    preHandler: requireRole(fastify, PLANNER_ROLES),
  }, async (request, reply) => {
    try {
      const snap = request.body || {}
      if (!snap.id || typeof snap.id !== 'string') {
        return reply.code(400).send({ success: false, error: 'project id required' })
      }
      const name = typeof snap.name === 'string' && snap.name.trim() ? snap.name.trim() : 'Untitled subdivision'
      const areaSqm = snap.planningArea?.areaSqm ?? null
      const lotCount = Array.isArray(snap.lots) ? snap.lots.length : 0

      // Ownership guard: don't let a non-admin overwrite someone else's project.
      const { rows: existing } = await fastify.pg.query(
        `SELECT created_by FROM planning_projects WHERE id = $1`, [snap.id],
      )
      if (existing[0] && request.user.role !== 'admin'
          && existing[0].created_by && existing[0].created_by !== request.user.id) {
        return reply.code(403).send({ success: false, error: 'forbidden' })
      }

      const { rows } = await fastify.pg.query(
        `INSERT INTO planning_projects (id, name, created_by, snapshot, area_sqm, lot_count, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW())
         ON CONFLICT (id) DO UPDATE SET
           name       = EXCLUDED.name,
           snapshot   = EXCLUDED.snapshot,
           area_sqm   = EXCLUDED.area_sqm,
           lot_count  = EXCLUDED.lot_count,
           updated_at = NOW()
         RETURNING id, name, area_sqm, lot_count, updated_at`,
        [snap.id, name, request.user.id, JSON.stringify(snap), areaSqm, lotCount],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'save planning project failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Delete ──────────────────────────────────────────────────────────────
  fastify.delete('/planning/projects/:id', {
    preHandler: requireRole(fastify, PLANNER_ROLES),
  }, async (request, reply) => {
    try {
      const { id } = request.params
      const guard = request.user.role === 'admin' ? '' : 'AND (created_by = $2 OR created_by IS NULL)'
      const params = request.user.role === 'admin' ? [id] : [id, request.user.id]
      const { rowCount } = await fastify.pg.query(
        `DELETE FROM planning_projects WHERE id = $1 ${guard}`, params,
      )
      if (rowCount === 0) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true })
    } catch (err) {
      request.log.error({ err }, 'delete planning project failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

module.exports = { planningProjectsRoutes }
