// src/routes/statutory-plans.js
// Statutory plan register (RTCP Act [Ch. 29:12] Parts II & IV) — persistence
// for the frontend usePlans composable (src/statutory/composables/usePlans.ts),
// which owns the lifecycle rules; this layer validates shape/enums and stores
// the plan document. Table: spatial_planning.statutory_plan (migration 101).

const { requireRole } = require('../middleware/jwtAuth')

// Reading the plan register is a staff function; writing (plan preparation,
// s7/s16) is the town planner's duty. Committee/director determination roles
// don't exist in the auth store yet — admin covers governance until they do.
const READ_ROLES = ['planner', 'planning_clerk', 'eo', 'gis_officer',
  'env_officer', 'building_inspector', 'surveyor', 'admin']
const WRITE_ROLES = ['planner', 'admin']

const KINDS = ['regional', 'master', 'local']
const STATUSES = ['draft', 'exhibition', 'objections', 'submitted',
  'approved', 'operative', 'altered', 'repealed']

/** Returns an error message, or null if the plan document is storable. */
function validatePlanDoc(doc) {
  if (!doc || typeof doc !== 'object') return 'plan document required'
  if (typeof doc.id !== 'string' || !doc.id.trim() || doc.id.length > 60) return 'invalid id'
  if (!KINDS.includes(doc.kind)) return `kind must be one of ${KINDS.join(', ')}`
  if (typeof doc.name !== 'string' || !doc.name.trim() || doc.name.length > 255) return 'invalid name'
  if (!STATUSES.includes(doc.status)) return `status must be one of ${STATUSES.join(', ')}`
  return null
}

/**
 * Insert or update a plan document. `boundary` (GeoJSON Polygon/MultiPolygon)
 * is optional; sending none preserves any previously stored boundary.
 */
async function upsertPlan(pg, doc, userId) {
  await pg.query(
    `INSERT INTO spatial_planning.statutory_plan
       (id, kind, name, authority_id, status, effective_date, doc, boundary, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             CASE WHEN $8::text IS NULL THEN NULL
                  ELSE ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($8::text), 4326)) END,
             $9)
     ON CONFLICT (id) DO UPDATE SET
       kind = EXCLUDED.kind,
       name = EXCLUDED.name,
       authority_id = EXCLUDED.authority_id,
       status = EXCLUDED.status,
       effective_date = EXCLUDED.effective_date,
       doc = EXCLUDED.doc,
       boundary = COALESCE(EXCLUDED.boundary, spatial_planning.statutory_plan.boundary),
       updated_at = NOW()`,
    [
      doc.id, doc.kind, doc.name.trim(), doc.authorityId || 'lpa', doc.status,
      doc.effectiveDate || null, JSON.stringify(doc),
      doc.boundary ? JSON.stringify(doc.boundary) : null,
      userId || null,
    ],
  )
  return { id: doc.id }
}

async function listPlans(pg) {
  const r = await pg.query(
    `SELECT doc FROM spatial_planning.statutory_plan ORDER BY created_at`)
  return r.rows.map(x => x.doc)
}

/**
 * Operative plans (s71) applying at a point. A NULL boundary means the plan
 * applies authority-wide.
 */
async function plansForPoint(pg, lng, lat) {
  const r = await pg.query(
    `SELECT doc FROM spatial_planning.statutory_plan
     WHERE status = 'operative'
       AND (boundary IS NULL
            OR ST_Contains(boundary, ST_SetSRID(ST_MakePoint($1, $2), 4326)))
     ORDER BY created_at`,
    [lng, lat],
  )
  return r.rows.map(x => x.doc)
}

/**
 * Fastify plugin. Register with prefix '/api'; routes live under /api/statutory.
 * @param {import('fastify').FastifyInstance} fastify
 */
async function statutoryPlansRoutes(fastify) {
  fastify.get('/statutory/plans',
    { preHandler: requireRole(fastify, READ_ROLES) },
    async (request, reply) => {
      try {
        return { success: true, data: await listPlans(fastify.pg) }
      } catch (err) {
        request.log.error({ err }, 'list statutory plans failed')
        return reply.code(500).send({ success: false, error: 'internal' })
      }
    })

  fastify.post('/statutory/plans',
    { preHandler: requireRole(fastify, WRITE_ROLES) },
    async (request, reply) => {
      const doc = request.body
      const invalid = validatePlanDoc(doc)
      if (invalid) {
        return reply.code(400).send({ success: false, error: 'bad_request', message: invalid })
      }
      try {
        const data = await upsertPlan(fastify.pg, doc, request.user && request.user.id)
        return { success: true, data }
      } catch (err) {
        request.log.error({ err }, 'save statutory plan failed')
        return reply.code(500).send({ success: false, error: 'internal' })
      }
    })

  fastify.get('/statutory/plans/for-parcel',
    { preHandler: requireRole(fastify, READ_ROLES) },
    async (request, reply) => {
      const lng = Number(request.query && request.query.lng)
      const lat = Number(request.query && request.query.lat)
      if (!Number.isFinite(lng) || !Number.isFinite(lat)
          || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        return reply.code(400).send({
          success: false, error: 'bad_request', message: 'valid lng and lat are required',
        })
      }
      try {
        return { success: true, data: await plansForPoint(fastify.pg, lng, lat) }
      } catch (err) {
        request.log.error({ err }, 'plans for parcel failed')
        return reply.code(500).send({ success: false, error: 'internal' })
      }
    })
}

module.exports = { statutoryPlansRoutes, upsertPlan, listPlans, plansForPoint, validatePlanDoc }
