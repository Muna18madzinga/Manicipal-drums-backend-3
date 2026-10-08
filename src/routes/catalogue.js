/**
 * The layer catalogue — one answer to "what layers does the portal have, and how are they organised".
 *
 *   GET /api/catalogue                          staff: groups, layers, default visibility, opening extent
 *   GET /api/admin/catalogue/reconciliation     admin: every place the sources disagree
 *
 * Built from the QGIS project (declares), layer_publication (approves) and config/spatialLayers.js
 * (renders). See services/layerCatalogue.js. Read-only: nothing here changes any source.
 */
const path = require('node:path')
const { requireRole, requireAdmin } = require('../middleware/jwtAuth')
const { LAYERS } = require('../config/spatialLayers')
const { loadProject } = require('../services/qgisCatalogue')
const { buildCatalogue, reconcile } = require('../services/layerCatalogue')

const STAFF = ['admin', 'planner', 'planning_clerk', 'building_inspector', 'eo', 'env_officer', 'surveyor', 'gis_officer']

function projectPath() {
  return path.join(__dirname, '..', '..', 'qgis-projects', path.basename(process.env.QGIS_PROJECT || 'vungu-project.qgs'))
}

async function catalogueRoutes(fastify) {
  const pg = fastify.pg

  async function sources() {
    const project = loadProject(projectPath())
    const { rows: pub } = await pg.query('SELECT table_name, audience FROM public.layer_publication')
    const { rows: tbl } = await pg.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")
    return {
      project,
      tileLayers: LAYERS,
      approved: new Map(pub.map((r) => [r.table_name, { audience: r.audience }])),
      existing: new Set(tbl.map((r) => r.table_name)),
    }
  }

  fastify.get('/catalogue', { preHandler: requireRole(fastify, STAFF) }, async (request, reply) => {
    try {
      return reply.send({ success: true, data: buildCatalogue(await sources()) })
    } catch (err) {
      request.log.error({ err }, 'catalogue failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/admin/catalogue/reconciliation', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    try {
      const s = await sources()
      const { rows: registry } = await pg.query(
        'SELECT table_name FROM public.spatial_layers WHERE is_visible').catch(() => ({ rows: [] }))
      return reply.send({ success: true, data: reconcile({ ...s, registry }) })
    } catch (err) {
      request.log.error({ err }, 'catalogue reconciliation failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

module.exports = { catalogueRoutes }
