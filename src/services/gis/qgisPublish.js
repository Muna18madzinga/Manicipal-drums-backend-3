// src/services/gis/qgisPublish.js
// ---------------------------------------------------------------------------
// Pushes a PUBLISHED registry style back out to QGIS, closing the loop:
//
//   QGIS Desktop ──import──► registry ──publish──► web map
//                                 └────push──────► QGIS project (.qgs)
//                                 └────push──────► canonical-qml/<layer>.qml
//
// Why this direction exists: a GIS officer can author a change in the web
// console (a class colour, a stroke width) instead of in QGIS Desktop. That
// change is only real once it is a published version — and QGIS must then be
// brought into line, or the authority the registry holds would be contradicted
// by whatever the .qgs still says. Pushing is how QGIS Server and QGIS Desktop
// end up rendering the version the registry approved.
//
// SAFETY, because this writes a production artifact:
//   * only a PUBLISHED version may be pushed. Pushing a draft would put
//     unapproved cartography into QGIS Server, which serves the public WMS.
//   * the .qgs is backed up before every modification, per layer, timestamped.
//   * only the matched layer's <renderer-v2> is replaced. Nothing else in the
//     380 KB project file is touched — not datasources, not layer order, not
//     the other nine layers' symbology.
//   * the rewrite is re-parsed before it is committed to disk. A rewrite that
//     would not parse is discarded, because an unreadable project file takes
//     QGIS Server's whole WMS down rather than just one layer.
// ---------------------------------------------------------------------------

const fs = require('fs')
const path = require('path')

const { compileQml, qmlRenderer } = require('./compile')
const { validate } = require('./styleDoc')
const registry = require('./styleRegistry')
const { StyleRegistryError } = require('./styleRegistry')
const qgisImport = require('./qgisImport')

const BACKEND_ROOT = path.join(__dirname, '..', '..', '..')
const QGIS_PROJECT = process.env.QGIS_PROJECT_LOCAL
  || path.join(BACKEND_ROOT, 'qgis-projects', 'vungu-project.qgs')

const fail = (msg, code, status = 400) => { throw new StyleRegistryError(msg, code, status) }
const relToBackend = (p) => path.relative(BACKEND_ROOT, p).replace(/\\/g, '/')

/** Compact UTC stamp for backup filenames: 20260817-141900. */
function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

/**
 * Replaces the <renderer-v2> element inside ONE <maplayer> block.
 *
 * Deliberately not a single greedy regex over the whole file: a pattern like
 * `<maplayer[\s\S]*?<layername>X</layername>[\s\S]*?<renderer-v2 …>` can run
 * past the target layer and rewrite a LATER layer's renderer when the target
 * has none. Splitting on the block boundary first makes the edit local by
 * construction.
 *
 * Returns { xml, replaced }.
 */
function replaceRendererInProject(xml, qgisLayerName, rendererXml) {
  const OPEN = '<maplayer'
  const parts = xml.split(OPEN)   // parts[0] precedes the first <maplayer>
  const needle = `<layername>${qgisLayerName}</layername>`
  let replaced = false

  for (let i = 1; i < parts.length; i++) {
    if (!parts[i].includes(needle)) continue

    const end = parts[i].indexOf('</maplayer>')
    if (end === -1) continue
    const block = parts[i].slice(0, end)
    const tail = parts[i].slice(end)

    const rStart = block.indexOf('<renderer-v2')
    if (rStart === -1) continue
    const rClose = block.indexOf('</renderer-v2>', rStart)
    if (rClose === -1) continue

    parts[i] = block.slice(0, rStart)
      + rendererXml
      + block.slice(rClose + '</renderer-v2>'.length)
      + tail
    replaced = true
    break
  }

  return { xml: parts.join(OPEN), replaced }
}

/**
 * Pushes a layer's published style to QGIS.
 *
 * Always writes the QML sidecar (`canonical-qml/<name>.qml`) so a planner can
 * Load Style in QGIS Desktop. Additionally rewrites the .qgs renderer when the
 * layer is mapped to a real QGIS layer — that is what QGIS Server serves, and
 * the project watcher reloads it.
 *
 * `dryRun` reports what would happen and writes nothing.
 */
async function pushToQgis(db, layerId, {
  actor = null, actorRole = null, dryRun = false, projectPath = QGIS_PROJECT,
} = {}) {
  // Resolve the PUBLISHED style only. getPublishedStyle throws
  // `no_published_style` when a layer has none, which is the correct refusal.
  const style = await registry.getPublishedStyle(db, layerId, { target: 'none' })

  if (style.status !== 'published') {
    fail(`${layerId} v${style.styleVersion} is "${style.status}"; only a published version may be pushed to QGIS`,
      'not_published')
  }
  const v = validate(style.definition)
  if (!v.valid) {
    fail(`${layerId} v${style.styleVersion} fails validation and will not be pushed: ${v.errors.join('; ')}`,
      'invalid_style')
  }

  const qml = compileQml(style.definition, {
    layerId,
    styleVersion: style.styleVersion,
    styleId: style.styleId,
    checksum: style.checksum,
    publishedAt: style.stylePublishedAt,
  })

  // The QGIS layer name differs from the tile-layer id for the master-plan
  // layers; fall back to the layer id for a standalone sidecar.
  const qgisLayer = style.qgisLayer || null
  const qmlDir = path.join(path.dirname(projectPath), 'canonical-qml')
  const qmlPath = path.join(qmlDir, `${qgisLayer || layerId}.qml`)

  const report = {
    layerId,
    styleVersion: style.styleVersion,
    checksum: style.checksum,
    qgisLayer,
    qmlPath: relToBackend(qmlPath),
    projectPath: relToBackend(projectPath),
    wroteQml: false,
    wroteProject: false,
    backupPath: null,
    dryRun,
    warnings: [],
  }

  if (!qgisLayer) {
    report.warnings.push(
      `"${layerId}" is not mapped to a layer in the QGIS project, so only the QML `
      + 'sidecar is written. Add the layer to the project and set gis_layer.qgis_layer '
      + 'to have QGIS Server render it.',
    )
  }

  if (dryRun) return report

  // ── QML sidecar ──────────────────────────────────────────────────────────
  fs.mkdirSync(qmlDir, { recursive: true })
  fs.writeFileSync(qmlPath, qml, 'utf-8')
  report.wroteQml = true

  // ── QGIS project renderer ────────────────────────────────────────────────
  if (qgisLayer) {
    if (!fs.existsSync(projectPath)) {
      report.warnings.push(`QGIS project not found at ${relToBackend(projectPath)}; only the QML sidecar was written.`)
    } else {
      const before = fs.readFileSync(projectPath, 'utf-8')
      const { xml: after, replaced } = replaceRendererInProject(
        before, qgisLayer, qmlRenderer(style.definition),
      )

      if (!replaced) {
        report.warnings.push(
          `No <renderer-v2> found inside the <maplayer> for "${qgisLayer}"; the project `
          + 'was left untouched. Only the QML sidecar was written.',
        )
      } else {
        // Verify before committing: write a temp file, re-parse it, and only
        // then back up the live project and swap it in.
        const tmp = `${projectPath}.tmp-${stamp()}`
        fs.writeFileSync(tmp, after, 'utf-8')
        try {
          const check = qgisImport.importProject(tmp).find((l) => l.layerId === qgisLayer)
          if (!check || check.error) {
            throw new Error(check?.error || `layer "${qgisLayer}" not readable after rewrite`)
          }
          const backupDir = path.join(path.dirname(projectPath), '_backups')
          fs.mkdirSync(backupDir, { recursive: true })
          const backupPath = path.join(
            backupDir, `${path.basename(projectPath, '.qgs')}.${qgisLayer}.${stamp()}.qgs`,
          )
          fs.copyFileSync(projectPath, backupPath)
          fs.renameSync(tmp, projectPath)
          report.wroteProject = true
          report.backupPath = relToBackend(backupPath)
        } catch (e) {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
          fail(`rewriting the QGIS project would have produced an unreadable file (${e.message}); nothing was changed`,
            'qgis_rewrite_failed', 500)
        }
      }
    }
  }

  // ── Audit ────────────────────────────────────────────────────────────────
  const client = await db.connect()
  try {
    await registry.writeAudit(client, {
      layerId,
      styleId: style.styleId,
      event: 'pushed_to_qgis',
      toVersion: style.styleVersion,
      styleChecksum: style.checksum,
      sourcePath: report.wroteProject ? report.projectPath : report.qmlPath,
      actor,
      actorRole,
      reason: `pushed v${style.styleVersion} to QGIS`,
      detail: {
        qgisLayer,
        wroteQml: report.wroteQml,
        wroteProject: report.wroteProject,
        qmlPath: report.qmlPath,
        backupPath: report.backupPath,
        warnings: report.warnings,
      },
    })
  } finally {
    client.release()
  }

  return report
}

/**
 * Pushes every layer that has a published style. Continues past a failure so
 * one bad layer cannot block the rest, and reports each outcome.
 */
async function pushAllToQgis(db, opts = {}) {
  const layers = await registry.listLayers(db)
  const results = []
  for (const l of layers) {
    if (!l.style_id) continue
    try {
      results.push({ ok: true, ...(await pushToQgis(db, l.layer_id, opts)) })
    } catch (e) {
      results.push({ ok: false, layerId: l.layer_id, error: e.message, code: e.code || null })
    }
  }
  return {
    total: results.length,
    pushedToProject: results.filter((r) => r.wroteProject).length,
    qmlOnly: results.filter((r) => r.ok && !r.wroteProject).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  }
}

module.exports = {
  pushToQgis,
  pushAllToQgis,
  replaceRendererInProject,
  QGIS_PROJECT,
}
