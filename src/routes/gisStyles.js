// src/routes/gisStyles.js
// ---------------------------------------------------------------------------
// The enterprise GIS symbology API. Every client -- web map, QGIS Desktop,
// future mobile -- resolves its cartography here rather than carrying a copy.
//
//   READS (public, cached)
//     GET  /api/gis/layers                              governed layer catalogue
//     GET  /api/gis/styles                              all published styles, compiled
//     GET  /api/gis/styles/:layerId                     published style (?target=maplibre|qml)
//     GET  /api/gis/layers/:layerId/config              data ref + style ref for map loading
//
//   READS (authenticated)
//     GET  /api/gis/styles/:layerId/versions            version history
//     GET  /api/gis/styles/:layerId/audit               who changed what, when
//     GET  /api/gis/styles/:layerId/diff?from=&to=      pre-publication comparison
//     GET  /api/gis/styles/:layerId/qgis-candidates     every candidate QGIS source
//     GET  /api/gis/styles/:layerId/version/:version    a specific version
//     GET  /api/gis/fidelity-report                     QGIS vs web, every layer
//
//   WRITES (admin / gis_officer only)
//     POST /api/gis/styles/:layerId/import-from-qgis    new DRAFT from the QGIS project
//     POST /api/gis/styles/:layerId/draft               new DRAFT from a style document
//     POST /api/gis/styles/:layerId/version/:v/submit   draft    -> review
//     POST /api/gis/styles/:layerId/version/:v/approve  review   -> approved
//     POST /api/gis/styles/:layerId/version/:v/publish  approved -> published
//     POST /api/gis/styles/:layerId/rollback            re-publish an earlier version
//     POST /api/gis/layers/:layerId/data-synced         record a DATA sync (not a style change)
//
// Publication is deliberately NOT a PUT on an existing style: no endpoint
// anywhere mutates a published style, because the database forbids it
// (migration 114). Changing cartography always means a new version.
// ---------------------------------------------------------------------------

const crypto = require('crypto')
const path = require('path')
const { requireRole } = require('../middleware/jwtAuth')
const registry = require('../services/gis/styleRegistry')
const { StyleRegistryError } = require('../services/gis/styleRegistry')
const qgisImport = require('../services/gis/qgisImport')
const qgisPublish = require('../services/gis/qgisPublish')

// Who may change production symbology. A planner consumes styling; they do not
// author it, so `planner` is absent here on purpose.
const STYLE_ADMINS = ['admin', 'gis_officer']
// Who may inspect version history and audit trails.
const STYLE_READERS = ['admin', 'gis_officer', 'planner', 'eo', 'surveyor']

const BACKEND_ROOT = path.join(__dirname, '..', '..')
const QGIS_PROJECT = process.env.QGIS_PROJECT_LOCAL
  || path.join(BACKEND_ROOT, 'qgis-projects', 'vungu-project.qgs')

/** Uniform error translation so a registry rule surfaces as its real status. */
function sendError(reply, err, fastify, context) {
  if (err instanceof StyleRegistryError) {
    return reply.code(err.statusCode || 400).send({
      success: false, error: err.code, message: err.message,
    })
  }
  fastify.log.error({ err, context }, 'gis style registry failure')
  return reply.code(500).send({
    success: false, error: 'internal_error', message: 'GIS style registry request failed',
  })
}

/** Identity of the acting user, for the audit trail. */
const actorOf = (request) => ({
  actor: request.user?.email || request.user?.username || request.user?.id || 'unknown',
  actorRole: request.user?.role || null,
})

const relToBackend = (p) => path.relative(BACKEND_ROOT, p).replace(/\\/g, '/')

async function gisStyleRoutes(fastify) {
  // ═══ Public reads ════════════════════════════════════════════════════════
  // Published symbology is not secret -- the citizen-facing map needs it, and
  // the vector tiles it styles are already public. Write access is restricted,
  // not the cartography itself.

  fastify.get('/gis/layers', async (request, reply) => {
    try {
      const layers = await registry.listLayers(fastify.pg, {
        includeInactive: request.query?.includeInactive === 'true',
      })
      reply.header('Cache-Control', 'public, max-age=300')
      return { success: true, data: layers, count: layers.length }
    } catch (err) { return sendError(reply, err, fastify, 'listLayers') }
  })

  /**
   * The whole published stylesheet in one request.
   *
   * The map needs 31 layers to draw a single frame; fetching them individually
   * would be 31 round trips to Zimbabwe and back. The ETag hashes every layer's
   * checksum, so a client revalidates the entire stylesheet in ONE conditional
   * request and gets 304 until something is actually published.
   */
  fastify.get('/gis/styles', async (request, reply) => {
    try {
      const target = request.query?.target === 'qml' ? 'qml' : 'maplibre'
      const { rows } = await fastify.pg.query(
        'SELECT * FROM gis_published_style WHERE style_id IS NOT NULL ORDER BY layer_id',
      )
      const styles = rows.map((row) => registry.withCompiled(row, target))

      const etag = `"gis-styles-${crypto.createHash('sha256')
        .update(styles.map((s) => `${s.layerId}:${s.styleVersion}:${s.checksum}`).join('|'))
        .digest('hex').slice(0, 32)}"`

      if (request.headers['if-none-match'] === etag) return reply.code(304).send()

      reply.header('ETag', etag)
      reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
      return {
        success: true,
        data: styles,
        count: styles.length,
        stylesheetVersion: etag.replace(/"/g, ''),
      }
    } catch (err) { return sendError(reply, err, fastify, 'listStyles') }
  })

  fastify.get('/gis/styles/:layerId', async (request, reply) => {
    try {
      const { layerId } = request.params
      const target = request.query?.target === 'qml' ? 'qml' : 'maplibre'
      const pinned = request.query?.version

      const style = pinned
        ? await registry.getVersion(fastify.pg, layerId, Number(pinned), { target })
        : await registry.getPublishedStyle(fastify.pg, layerId, { target })

      // A pinned version can never change -- migration 114 makes published
      // styles immutable -- so it is safe to cache for a year. An unpinned
      // request must revalidate, because which version is published can move.
      if (pinned) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      } else {
        const etag = `"${style.checksum}"`
        if (request.headers['if-none-match'] === etag) return reply.code(304).send()
        reply.header('ETag', etag)
        reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
      }

      if (target === 'qml') {
        return reply
          .header('Content-Type', 'application/xml; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${layerId}-v${style.styleVersion}.qml"`)
          .send(style.qml)
      }
      return { success: true, data: style }
    } catch (err) { return sendError(reply, err, fastify, 'getPublishedStyle') }
  })

  /**
   * What a map client needs to LOAD a layer: the data reference and the style
   * reference together, each with its own version. Returns `styleVersion` and a
   * pinned `styleUrl` so a client renders a known version and never silently
   * switches mid-session.
   */
  fastify.get('/gis/layers/:layerId/config', async (request, reply) => {
    try {
      const style = await registry.getPublishedStyle(fastify.pg, request.params.layerId, { target: 'maplibre' })
      reply.header('Cache-Control', 'public, max-age=60')
      return {
        success: true,
        data: {
          layerId: style.layerId,
          displayName: style.displayName,
          geometry: style.geometry,
          // data
          dataSource: style.dataSource,
          tileUrl: `/api/tiles/${style.layerId}/{z}/{x}/{y}.pbf`,
          sourceLayer: style.layerId,
          dataSyncedAt: style.dataSyncedAt,
          // style -- referenced by id + version, never by inline colours
          styleId: style.styleId,
          styleVersion: style.styleVersion,
          styleChecksum: style.checksum,
          stylePublishedAt: style.stylePublishedAt,
          styleUrl: `/api/gis/styles/${style.layerId}?version=${style.styleVersion}`,
          renderStrategy: style.renderStrategy,
          maplibre: style.maplibre,
          minZoom: style.minZoom,
          maxZoom: style.maxZoom,
          fidelity: style.fidelity,
        },
      }
    } catch (err) { return sendError(reply, err, fastify, 'layerConfig') }
  })

  // ═══ Authenticated reads ═════════════════════════════════════════════════

  fastify.get('/gis/styles/:layerId/versions',
    { preHandler: requireRole(fastify, STYLE_READERS) },
    async (request, reply) => {
      try {
        const versions = await registry.listVersions(fastify.pg, request.params.layerId)
        return { success: true, data: versions, count: versions.length }
      } catch (err) { return sendError(reply, err, fastify, 'listVersions') }
    })

  fastify.get('/gis/styles/:layerId/version/:version',
    { preHandler: requireRole(fastify, STYLE_READERS) },
    async (request, reply) => {
      try {
        const target = request.query?.target === 'qml' ? 'qml' : 'maplibre'
        const style = await registry.getVersion(
          fastify.pg, request.params.layerId, Number(request.params.version), { target },
        )
        return { success: true, data: style }
      } catch (err) { return sendError(reply, err, fastify, 'getVersion') }
    })

  fastify.get('/gis/styles/:layerId/audit',
    { preHandler: requireRole(fastify, STYLE_READERS) },
    async (request, reply) => {
      try {
        const events = await registry.getAudit(fastify.pg, request.params.layerId, {
          limit: request.query?.limit,
        })
        return { success: true, data: events, count: events.length }
      } catch (err) { return sendError(reply, err, fastify, 'getAudit') }
    })

  fastify.get('/gis/styles/:layerId/diff',
    { preHandler: requireRole(fastify, STYLE_READERS) },
    async (request, reply) => {
      try {
        const { from, to } = request.query || {}
        if (!from || !to) {
          return reply.code(400).send({
            success: false, error: 'missing_versions',
            message: 'both `from` and `to` version numbers are required',
          })
        }
        const diff = await registry.diffVersions(
          fastify.pg, request.params.layerId, Number(from), Number(to),
        )
        return { success: true, data: diff }
      } catch (err) { return sendError(reply, err, fastify, 'diffVersions') }
    })

  /**
   * Every candidate QGIS style for this layer, with provenance and any conflict.
   * Returned as a list, never reduced to one -- choosing silently between
   * disagreeing sources is what produced the drift this registry replaces.
   */
  fastify.get('/gis/styles/:layerId/qgis-candidates',
    { preHandler: requireRole(fastify, STYLE_READERS) },
    async (request, reply) => {
      try {
        const { layerId } = request.params
        const { rows } = await fastify.pg.query(
          'SELECT geometry, qgis_layer FROM gis_layer WHERE layer_id = $1', [layerId],
        )
        if (!rows[0]) {
          return reply.code(404).send({
            success: false, error: 'layer_not_found', message: `unknown layer "${layerId}"`,
          })
        }
        const found = qgisImport.findCandidates(rows[0].qgis_layer || layerId, {
          projectPath: QGIS_PROJECT,
          geometry: rows[0].geometry,
        })
        return {
          success: true,
          data: {
            layerId,
            qgisLayer: rows[0].qgis_layer || layerId,
            conflict: found.conflict,
            recommendedRole: found.recommended?.role || null,
            candidates: found.candidates.map((c) => ({
              role: c.role,
              precedence: c.precedence,
              sourcePath: relToBackend(c.sourcePath || ''),
              error: c.error || null,
              rendererType: c.doc?.renderer?.type || null,
              classCount: c.doc?.renderer?.categories?.length ?? c.doc?.renderer?.ranges?.length ?? null,
              fidelity: c.fidelity?.level || null,
              checksum: c.checksum || null,
              valid: c.validation ? c.validation.valid : null,
              validationErrors: c.validation?.errors || [],
              definition: c.doc || null,
            })),
          },
        }
      } catch (err) { return sendError(reply, err, fastify, 'qgisCandidates') }
    })

  fastify.get('/gis/fidelity-report',
    { preHandler: requireRole(fastify, STYLE_READERS) },
    async (request, reply) => {
      try {
        return { success: true, data: await registry.fidelityReport(fastify.pg) }
      } catch (err) { return sendError(reply, err, fastify, 'fidelityReport') }
    })

  // ═══ Writes -- admin / GIS officer only ══════════════════════════════════

  /**
   * Creates a DRAFT by re-reading the authoritative QGIS project. This is the
   * publishing pipeline's entry point: a GIS officer restyles a layer in QGIS
   * Desktop, saves the project, and calls this. No colour is ever retyped.
   */
  fastify.post('/gis/styles/:layerId/import-from-qgis',
    { preHandler: requireRole(fastify, STYLE_ADMINS) },
    async (request, reply) => {
      try {
        const { layerId } = request.params
        const { changeSummary = null, qgisLayer = null } = request.body || {}

        const { rows } = await fastify.pg.query(
          'SELECT geometry, qgis_layer FROM gis_layer WHERE layer_id = $1', [layerId],
        )
        if (!rows[0]) {
          return reply.code(404).send({
            success: false, error: 'layer_not_found', message: `unknown layer "${layerId}"`,
          })
        }
        const sourceName = qgisLayer || rows[0].qgis_layer || layerId

        const imported = qgisImport.importProject(QGIS_PROJECT).find((l) => l.layerId === sourceName)
        if (!imported) {
          return reply.code(404).send({
            success: false, error: 'qgis_layer_not_found',
            message: `no layer "${sourceName}" in ${path.basename(QGIS_PROJECT)}`,
          })
        }
        if (imported.error) {
          return reply.code(422).send({
            success: false, error: 'qgis_import_failed', message: imported.error,
          })
        }

        const result = await registry.createDraft(fastify.pg, {
          layerId,
          // The QGIS layer name and the tile-layer id differ for master-plan
          // layers, so retarget the document at the governed id.
          doc: { ...imported.doc, layerId },
          source: 'qgis',
          sourcePath: relToBackend(QGIS_PROJECT),
          sourceChecksum: imported.checksum,
          changeSummary: changeSummary || `imported from QGIS layer "${sourceName}"`,
          ...actorOf(request),
        })

        return reply.code(result.unchanged ? 200 : 201).send({
          success: true,
          data: {
            layerId,
            styleVersion: result.style.style_version,
            status: result.style.status,
            checksum: result.style.checksum,
            fidelity: result.fidelity.level,
            fidelityNotes: result.fidelity.notes,
            validationWarnings: result.validation.warnings,
            unchanged: result.unchanged,
          },
          message: result.unchanged
            || `draft v${result.style.style_version} created; submit it for approval to publish`,
        })
      } catch (err) { return sendError(reply, err, fastify, 'importFromQgis') }
    })

  fastify.post('/gis/styles/:layerId/draft',
    { preHandler: requireRole(fastify, STYLE_ADMINS) },
    async (request, reply) => {
      try {
        const { layerId } = request.params
        const {
          definition, styleName = null, changeSummary = null,
          source = 'manual', sourcePath = null,
        } = request.body || {}
        if (!definition) {
          return reply.code(400).send({
            success: false, error: 'missing_definition',
            message: 'a `definition` style document is required',
          })
        }
        const result = await registry.createDraft(fastify.pg, {
          layerId,
          doc: { ...definition, layerId },
          styleName,
          source,
          sourcePath,
          changeSummary,
          ...actorOf(request),
        })
        return reply.code(result.unchanged ? 200 : 201).send({
          success: true,
          data: {
            layerId,
            styleVersion: result.style.style_version,
            status: result.style.status,
            checksum: result.style.checksum,
            fidelity: result.fidelity.level,
            fidelityNotes: result.fidelity.notes,
            validationWarnings: result.validation.warnings,
            unchanged: result.unchanged,
          },
        })
      } catch (err) { return sendError(reply, err, fastify, 'createDraft') }
    })

  // Lifecycle transitions. Separate endpoints rather than one mutable `status`
  // field, so each is independently authorisable and reads as an action in the
  // audit log.
  const VERBS = [
    ['submit', 'review'],
    ['approve', 'approved'],
    ['publish', 'published'],
    ['deprecate', 'deprecated'],
    ['archive', 'archived'],
  ]
  for (const [verb, to] of VERBS) {
    fastify.post(`/gis/styles/:layerId/version/:version/${verb}`,
      { preHandler: requireRole(fastify, STYLE_ADMINS) },
      async (request, reply) => {
        try {
          const result = await registry.transition(fastify.pg, {
            layerId: request.params.layerId,
            version: Number(request.params.version),
            to,
            reason: request.body?.reason || null,
            ...actorOf(request),
          })
          return {
            success: true,
            data: {
              layerId: result.style.layer_id,
              styleVersion: result.style.style_version,
              status: result.style.status,
              approvedBy: result.style.approved_by,
              publishedBy: result.style.published_by,
              publishedAt: result.style.published_at,
              displacedVersion: result.displaced,
            },
            message: result.displaced
              ? `v${result.style.style_version} published; v${result.displaced} deprecated`
              : `v${result.style.style_version} is now ${to}`,
          }
        } catch (err) { return sendError(reply, err, fastify, `transition:${to}`) }
      })
  }

  fastify.post('/gis/styles/:layerId/rollback',
    { preHandler: requireRole(fastify, STYLE_ADMINS) },
    async (request, reply) => {
      try {
        const { toVersion, reason = null } = request.body || {}
        if (!toVersion) {
          return reply.code(400).send({
            success: false, error: 'missing_version',
            message: '`toVersion` is required -- name the version to restore',
          })
        }
        const result = await registry.rollback(fastify.pg, {
          layerId: request.params.layerId,
          toVersion: Number(toVersion),
          reason,
          ...actorOf(request),
        })
        return {
          success: true,
          data: {
            layerId: request.params.layerId,
            styleVersion: result.style.style_version,
            status: result.style.status,
            rolledBackFrom: result.displaced,
          },
          message: `rolled back to v${result.style.style_version}`
            + (result.displaced ? ` (v${result.displaced} deprecated)` : '')
            + '; spatial data unchanged',
        }
      } catch (err) { return sendError(reply, err, fastify, 'rollback') }
    })

  /**
   * Pushes the layer's PUBLISHED style out to QGIS: rewrites the renderer inside
   * the .qgs (so QGIS Server serves it) and writes the QML sidecar (so a planner
   * can Load Style in QGIS Desktop).
   *
   * This is the other half of the loop. A GIS officer who authors a change in
   * the console must be able to bring QGIS into line, or the .qgs would keep
   * contradicting the version the registry approved.
   *
   * `?dryRun=true` reports what would be written without touching anything.
   */
  fastify.post('/gis/styles/:layerId/push-to-qgis',
    { preHandler: requireRole(fastify, STYLE_ADMINS) },
    async (request, reply) => {
      try {
        const report = await qgisPublish.pushToQgis(fastify.pg, request.params.layerId, {
          dryRun: request.query?.dryRun === 'true' || request.body?.dryRun === true,
          ...actorOf(request),
        })
        const where = [
          report.wroteProject && 'the QGIS project',
          report.wroteQml && 'the QML sidecar',
        ].filter(Boolean).join(' and ')
        return {
          success: true,
          data: report,
          message: report.dryRun
            ? `dry run: v${report.styleVersion} would be written to ${where || 'nothing'}`
            : `v${report.styleVersion} pushed to ${where || 'nothing'}`
              + (report.wroteProject ? '; QGIS Server reloads on the project change' : ''),
        }
      } catch (err) { return sendError(reply, err, fastify, 'pushToQgis') }
    })

  /** Pushes every layer that has a published style. */
  fastify.post('/gis/styles/push-all',
    { preHandler: requireRole(fastify, STYLE_ADMINS) },
    async (request, reply) => {
      try {
        const result = await qgisPublish.pushAllToQgis(fastify.pg, {
          dryRun: request.query?.dryRun === 'true' || request.body?.dryRun === true,
          ...actorOf(request),
        })
        return {
          success: true,
          data: result,
          message: `${result.pushedToProject} layer(s) written into the QGIS project, `
            + `${result.qmlOnly} as QML sidecar only, ${result.failed} failed`,
        }
      } catch (err) { return sendError(reply, err, fastify, 'pushAllToQgis') }
    })

  /**
   * Records a spatial DATA synchronisation. Its own endpoint, so the UI can
   * show "data synced" and "style published" as the independent facts they are.
   */
  fastify.post('/gis/layers/:layerId/data-synced',
    { preHandler: requireRole(fastify, STYLE_ADMINS) },
    async (request, reply) => {
      try {
        const result = await registry.markDataSynced(
          fastify.pg, request.params.layerId, request.body?.syncedAt || null,
        )
        return {
          success: true,
          data: result,
          message: 'data sync recorded; symbology unaffected',
        }
      } catch (err) { return sendError(reply, err, fastify, 'markDataSynced') }
    })
}

module.exports = { gisStyleRoutes, STYLE_ADMINS, STYLE_READERS }
