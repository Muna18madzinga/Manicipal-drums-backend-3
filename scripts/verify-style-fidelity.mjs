#!/usr/bin/env node
/**
 * Style-extraction fidelity report.
 *
 * The paper's central claim is that a QGIS renderer definition survives the
 * trip into MapLibre GL JS paint expressions. That claim is only worth
 * anything if it can be checked, so this walks every layer the portal serves
 * and every layer the QGIS project contains, extracts the style the way the
 * running bridge does, and records:
 *
 *   - which file the symbology was read from (provenance)
 *   - the renderer type and the attribute it classifies on
 *   - symbol count, distinct colours, hatch/gradient/label flags
 *   - whether the emitted MapLibre paint actually varies (a categorised
 *     renderer that collapses to one colour is a fidelity failure, however
 *     clean the extraction looked)
 *
 * Output: docs/STYLE-FIDELITY-REPORT.md and docs/style-fidelity.json
 * Exit code 1 if any layer fell back to the default style or failed outright.
 *
 * Usage: node scripts/verify-style-fidelity.mjs [--json-only]
 */
import { writeFileSync, existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { PerfectQGISStyleExtractor } = require('../src/services/admin/perfectQGISStyleExtractor.js')
const { LAYERS } = require('../src/config/spatialLayers.js')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT = process.env.QGIS_PROJECT_LOCAL || path.join(ROOT, 'qgis-projects', 'vungu-project.qgs')
const jsonOnly = process.argv.includes('--json-only')

/** Every colour literal that appears anywhere in a paint expression. */
function paintColours(paint) {
  const out = new Set()
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (node && typeof node === 'object') return Object.values(node).forEach(walk)
    // #rrggbb / #rgb, and the rgba() form QGIS alpha values parse into
    if (typeof node === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(node.trim())) {
      out.add(node.trim().toLowerCase())
    }
  }
  walk(paint)
  return out
}

async function inspect(extractor, layerName) {
  const row = { layer: layerName }
  try {
    const style = await extractor.extractCompleteStyle(layerName, PROJECT, {})
    const paint = style.maplibreStyle.paint || {}
    const colours = paintColours(paint)
    const layerType = style.maplibreStyle.type
    const primaryKey = layerType === 'line' ? 'line-color' : layerType === 'circle' ? 'circle-color' : 'fill-color'
    const primary = paint[primaryKey]

    row.ok = true
    row.styleSource = style.metadata.styleSource
    row.qmlPath = path.relative(ROOT, style.metadata.qmlPath)
    row.aliasOf = style.metadata.aliasOf || null
    row.fallback = Boolean(style.metadata.fallback)
    row.fallbackReason = style.metadata.fallbackReason
    row.renderer = style.qgisStyle.rendererType
    row.attribute = style.qgisStyle.attributeName || '-'
    row.maplibreType = layerType
    row.symbols = style.webStyle.symbols.length
    row.distinctColours = colours.size
    row.primary = Array.isArray(primary) ? primary[0] : typeof primary === 'string' ? 'match' : 'none'
    row.casingLayer = (style.maplibreStyle.additionalLayers || []).some((l) => l.placement === 'below')
    row.hatch = style.metadata.hasHatchPatterns
    row.gradient = style.metadata.hasGradients
    row.labels = style.metadata.hasLabels

    // A classified renderer whose output colour never varies has silently
    // collapsed -- the classic way a "faithful" bridge lies.
    row.varies = colours.size > 1
    const classified = row.renderer === 'categorizedSymbol' || row.renderer === 'graduatedSymbol'
    row.warnings = []
    if (row.fallback) row.warnings.push(`fallback style (${row.fallbackReason})`)
    if (classified && !row.varies) row.warnings.push('classified renderer produced a single colour')
    if (classified && Array.isArray(primary) && primary.length <= 2) {
      row.warnings.push('empty match expression')
    }
    if (row.symbols === 0) row.warnings.push('no symbols extracted')
    if (row.aliasOf) row.warnings.push(`style id resolved via alias (${row.aliasOf})`)
  } catch (error) {
    row.ok = false
    row.error = error.message
    row.warnings = ['extraction threw']
  }
  return row
}

async function main() {
  if (!existsSync(PROJECT)) {
    console.error(`QGIS project not found: ${PROJECT}`)
    process.exit(2)
  }

  const extractor = new PerfectQGISStyleExtractor()

  // Portal layer ids (what the map asks for by name) plus the layers only the
  // project knows about -- the gweru_* pilot layers are served by WMS/WFS but
  // are not in spatialLayers.js.
  const projectLayers = extractor.listProjectLayers(PROJECT).map((l) => l.name)
  const targets = [...new Set([...LAYERS.map((l) => l.id), ...projectLayers])]

  const rows = []
  for (const target of targets) rows.push(await inspect(extractor, target))
  const failed = rows.filter((r) => !r.ok)
  const fellBack = rows.filter((r) => r.ok && r.fallback)
  const warned = rows.filter((r) => r.warnings && r.warnings.length)

  const bySource = rows.filter((r) => r.ok).reduce((acc, r) => {
    acc[r.styleSource] = (acc[r.styleSource] || 0) + 1
    return acc
  }, {})

  const report = {
    generatedAt: new Date().toISOString(),
    project: path.relative(ROOT, PROJECT),
    totals: {
      layers: rows.length,
      extracted: rows.length - failed.length,
      fallbacks: fellBack.length,
      errors: failed.length,
      warnings: warned.length
    },
    bySource,
    layers: rows
  }

  const jsonPath = path.join(ROOT, 'docs', 'style-fidelity.json')
  writeFileSync(jsonPath, JSON.stringify(report, null, 2))

  if (!jsonOnly) {
    const md = [
      '# Style extraction fidelity report',
      '',
      `Generated ${report.generatedAt} by \`scripts/verify-style-fidelity.mjs\` against`,
      `\`${report.project}\`. This is the evidence behind the paper's claim that QGIS`,
      'renderer definitions translate into MapLibre GL JS paint expressions.',
      '',
      `**${report.totals.extracted}/${report.totals.layers} layers extracted · ` +
      `${report.totals.fallbacks} fell back to the default style · ` +
      `${report.totals.errors} errored · ${report.totals.warnings} carry warnings**`,
      '',
      'Style sources: ' + Object.entries(bySource).map(([k, v]) => `\`${k}\` ${v}`).join(', '),
      '',
      '| Layer | Source | Renderer | Classified on | Syms | Colours | Varies | Hatch | Grad | Labels | Notes |',
      '|---|---|---|---|---|---|---|---|---|---|---|'
    ]
    for (const r of rows) {
      md.push(
        `| ${r.layer} | ${r.ok ? r.styleSource : '—'} | ${r.renderer || '—'} | ${r.attribute || '—'} | ` +
        `${r.symbols ?? '—'} | ${r.distinctColours ?? '—'} | ${r.ok ? (r.varies ? 'yes' : 'no') : '—'} | ` +
        `${r.ok ? (r.hatch ? 'yes' : 'no') : '—'} | ${r.ok ? (r.gradient ? 'yes' : 'no') : '—'} | ` +
        `${r.ok ? (r.labels ? 'yes' : 'no') : '—'} | ${r.warnings?.length ? r.warnings.join('; ') : r.error || ''} |`
      )
    }
    md.push(
      '',
      '## Reading this table',
      '',
      '- **Source** is the file the symbology came from: `project-file` (the .qgs QGIS',
      '  Server serves), `qml-sidecar` / `canonical-qml` (exported QML), `qml-env-dir`',
      '  (`$QGIS_QML_DIR`), or `default` when nothing was found.',
      '- **Varies** is the check that matters: a `categorizedSymbol` or',
      '  `graduatedSymbol` renderer must emit more than one colour, otherwise the',
      '  classification reached MapLibre as a flat style.',
      '- **Fallback** rows render, but with the flat default symbol rather than the',
      '  council\'s authored symbology. They are the rows to fix first.',
      '',
      'A live cross-check against QGIS Server `GetLegendGraphic` needs QGIS Server',
      'running (`npm run qgis:up`) and is not part of this offline pass.',
      ''
    )
    const mdPath = path.join(ROOT, 'docs', 'STYLE-FIDELITY-REPORT.md')
    writeFileSync(mdPath, md.join('\n'))
    console.log(`wrote ${path.relative(ROOT, mdPath)}`)
  }

  console.log(`wrote ${path.relative(ROOT, jsonPath)}`)
  console.log(
    `layers=${report.totals.layers} extracted=${report.totals.extracted} ` +
    `fallbacks=${report.totals.fallbacks} errors=${report.totals.errors} warnings=${report.totals.warnings}`
  )
  for (const r of rows.filter((x) => !x.ok || x.warnings?.length)) {
    console.log(`  ${r.ok ? 'warn' : 'FAIL'} ${r.layer}: ${(r.warnings || [r.error]).join('; ')}`)
  }

  process.exit(fellBack.length || failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(3)
})
