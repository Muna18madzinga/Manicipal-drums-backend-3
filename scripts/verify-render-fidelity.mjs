#!/usr/bin/env node
/**
 * Render-fidelity proof — does the portal ever invent symbology?
 *
 * The paper claims QGIS is the authority and that symbology too complex for
 * MapLibre is rendered by QGIS Server instead of approximated. That is a claim
 * about a DECISION, so it can be checked: every style is pushed through the
 * same import -> classify -> compile pipeline the registry uses, and two
 * invariants are asserted.
 *
 *   I1  Anything classified `server`/`unsupported` must compile to ZERO MapLibre
 *       layers. A single emitted layer means the client draws an approximation
 *       of a style the portal was supposed to delegate.
 *   I2  Nothing classified `server`/`unsupported` may be published as vector.
 *       compileMaplibre refuses to emit layers for those, so `strategy` must be
 *       `wms` (or `none`), never `vector`.
 *
 * The interesting part is the fixture project. vungu-project.qgs contains no
 * gradient, shapeburst, pattern-tile or marker-line symbology, so against real
 * council data every layer classifies cleanly and the claim is untested — a
 * harness that only reads the real project would pass no matter what the code
 * did. test/fixtures/qgs/untranslatable-symbols.qgs supplies the cases the
 * corpus lacks, and its `*_control` layers guard the opposite failure: routing
 * everything to QGIS Server would also "pass" a naive check.
 *
 * Before the SERVER_ONLY_CLASSES table existed, every one of those fixture
 * layers classified `direct` and compiled to a flat vector layer — a
 * GradientFill became solid #cccccc grey, because it has no `color` property.
 * The report prints that invented colour, because the mechanism that stops it
 * shipping is the fidelity rung, not the colour.
 *
 * Output: docs/RENDER-FIDELITY-REPORT.md, docs/render-fidelity.json
 * Exit 1 on any invariant violation or fixture misclassification.
 *
 * Usage: node scripts/verify-render-fidelity.mjs [--json-only]
 */
import { writeFileSync, existsSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { importProject, importQml } = require('../src/services/gis/qgisImport.js')
const { compileMaplibre } = require('../src/services/gis/compile.js')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT = process.env.QGIS_PROJECT_LOCAL || path.join(ROOT, 'qgis-projects', 'vungu-project.qgs')
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'qgs', 'untranslatable-symbols.qgs')
const CANONICAL = path.join(ROOT, 'qgis-projects', 'canonical-qml')
const jsonOnly = process.argv.includes('--json-only')

/**
 * What each fixture layer MUST classify as. Exact level, not a range: the
 * controls are what stop this file from being satisfied by a blanket "send
 * everything to WMS" change.
 */
const FIXTURE_EXPECTATIONS = {
  // MapLibre expresses these exactly — they must stay vector.
  solid_fill_control: 'direct',
  solid_line_control: 'direct',
  circle_marker_control: 'converted', // mm marker size -> px
  // The pre-existing brush-hatch rule; must not be displaced by the new ones.
  brush_hatch_control: 'server',
  // Symbology MapLibre cannot express at all.
  gradient_fill: 'server',
  shapeburst_fill: 'server',
  line_pattern_fill: 'server',
  point_pattern_fill: 'server',
  svg_fill: 'server',
  stacked_fill_with_gradient: 'server',
  marker_line: 'server',
  font_marker: 'server',
}

/** The colour the vector path would have invented, if it were allowed to run. */
function inventedColour(doc) {
  const r = doc?.renderer
  const sym = r?.symbol
    || r?.categories?.[0]?.symbol
    || r?.ranges?.[0]?.symbol
    || r?.rules?.[0]?.symbol
  const fill = sym?.fill
  if (!fill) return null
  return [fill.color, `opacity ${fill.opacity}`].filter(Boolean).join(' ')
}

/** Pushes one imported style through the invariants. */
function assess(entry) {
  const row = {
    layer: entry.layerId,
    level: entry.fidelity.level,
    strategy: null,
    vectorLayers: null,
    serverOnly: entry.doc.renderer.serverOnly || [],
    notes: entry.fidelity.notes.map((n) => n.note),
    valid: entry.validation.valid,
    validationErrors: entry.validation.errors,
  }
  row.inventedColour = inventedColour(entry.doc)
  row.serverOnly = row.serverOnly.map((e) => e.cls)

  const compiled = compileMaplibre(entry.doc, { fidelity: entry.fidelity })
  row.strategy = compiled.strategy
  row.vectorLayers = compiled.layers.length

  const delegated = row.level === 'server' || row.level === 'unsupported'
  const violations = []
  if (delegated && row.vectorLayers > 0) {
    violations.push(`classified "${row.level}" but still compiled ${row.vectorLayers} MapLibre layer(s) — the client would draw an approximation`)
  }
  if (delegated && row.strategy === 'vector') {
    violations.push(`classified "${row.level}" but strategy is "vector"`)
  }
  if (delegated && row.level === 'server' && row.strategy !== 'wms') {
    violations.push(`classified "server" but strategy is "${row.strategy}", expected "wms"`)
  }
  if (!delegated && row.vectorLayers === 0) {
    violations.push(`classified "${row.level}" but compiled no MapLibre layer — nothing to draw`)
  }
  row.violations = violations
  return row
}

/** Geometry for a standalone .qml, taken from the symbol type it declares. */
function geometryFromQml(qmlPath) {
  const xml = readdirSync ? require('fs').readFileSync(qmlPath, 'utf-8') : ''
  if (/type="fill"/.test(xml)) return 'polygon'
  if (/type="line"/.test(xml)) return 'line'
  return 'point'
}

function main() {
  const problems = []
  const fixtureRows = []

  // ── 1. The fixture: the cases the real corpus does not contain ─────────────
  if (!existsSync(FIXTURE)) {
    console.error(`fixture project not found: ${FIXTURE}`)
    process.exit(2)
  }
  const fixtureEntries = importProject(FIXTURE)
  const seen = new Set()

  for (const entry of fixtureEntries) {
    if (entry.error) {
      problems.push(`fixture ${entry.layerId || '?'}: import failed — ${entry.error}`)
      continue
    }
    seen.add(entry.layerId)
    const row = assess(entry)
    row.expected = FIXTURE_EXPECTATIONS[entry.layerId] || null

    if (!row.expected) {
      problems.push(`fixture ${entry.layerId}: no expectation declared in the harness — add one, or the case is untested`)
    } else if (row.level !== row.expected) {
      problems.push(`fixture ${entry.layerId}: classified "${row.level}", expected "${row.expected}"`)
    }
    if (!row.valid) {
      problems.push(`fixture ${entry.layerId}: failed structural validation — ${row.validationErrors.join('; ')}`)
    }
    for (const v of row.violations) problems.push(`fixture ${entry.layerId}: ${v}`)
    fixtureRows.push(row)
  }

  for (const [name, expected] of Object.entries(FIXTURE_EXPECTATIONS)) {
    if (!seen.has(name)) problems.push(`fixture layer "${name}" is missing from ${path.basename(FIXTURE)}`)
  }

  // ── 2. The real project: what QGIS Server itself renders ──────────────────
  const projectRows = []
  if (existsSync(PROJECT)) {
    for (const entry of importProject(PROJECT)) {
      if (entry.error) {
        projectRows.push({ layer: entry.qgisLayerName || entry.layerId, error: entry.error, level: null, strategy: null, vectorLayers: null, violations: [] })
        continue
      }
      const row = assess(entry)
      for (const v of row.violations) problems.push(`project ${row.layer}: ${v}`)
      projectRows.push(row)
    }
  } else {
    problems.push(`QGIS project not found: ${PROJECT}`)
  }

  // ── 3. The generated QML corpus, for coverage of the wider registry ────────
  const canonicalRows = []
  if (existsSync(CANONICAL)) {
    for (const file of readdirSync(CANONICAL).filter((f) => f.endsWith('.qml'))) {
      const full = path.join(CANONICAL, file)
      try {
        const entry = importQml(full, { layerId: file.replace(/\.qml$/, ''), geometry: geometryFromQml(full) })
        const row = assess(entry)
        // Generated output, so an import failure is a finding, not a fatal.
        row.geometryInferred = true
        for (const v of row.violations) problems.push(`canonical-qml ${row.layer}: ${v}`)
        canonicalRows.push(row)
      } catch (e) {
        canonicalRows.push({ layer: file.replace(/\.qml$/, ''), error: e.message, level: null, strategy: null, vectorLayers: null, violations: [] })
      }
    }
  }

  const all = [...fixtureRows, ...projectRows, ...canonicalRows]
  const byLevel = all.reduce((acc, r) => {
    const k = r.error ? 'import-error' : r.level
    acc[k] = (acc[k] || 0) + 1
    return acc
  }, {})
  const byStrategy = all.reduce((acc, r) => {
    const k = r.error ? 'import-error' : r.strategy
    acc[k] = (acc[k] || 0) + 1
    return acc
  }, {})

  const report = {
    generatedAt: new Date().toISOString(),
    fixtures: path.relative(ROOT, FIXTURE),
    project: path.relative(ROOT, PROJECT),
    canonicalQml: path.relative(ROOT, CANONICAL),
    totals: {
      styles: all.length,
      fixtures: fixtureRows.length,
      project: projectRows.length,
      canonical: canonicalRows.length,
      violations: all.reduce((n, r) => n + r.violations.length, 0),
      problems: problems.length
    },
    byLevel,
    byStrategy,
    problems,
    layers: all
  }

  writeFileSync(path.join(ROOT, 'docs', 'render-fidelity.json'), JSON.stringify(report, null, 2))

  if (!jsonOnly) {
    const md = [
      '# Render fidelity proof',
      '',
      `Generated ${report.generatedAt} by \`scripts/verify-render-fidelity.mjs\`.`,
      '',
      'The paper claims symbology too complex for MapLibre is rendered by QGIS',
      'Server rather than approximated. This checks the decision itself, on both',
      'the real project and a fixture built from the QGIS symbol layers the real',
      'project happens not to contain.',
      '',
      `**${report.totals.styles} styles · ${report.totals.violations} invariant violations · ` +
      `${report.totals.problems} problems**`,
      '',
      'Levels: ' + Object.entries(byLevel).map(([k, v]) => `\`${k}\` ${v}`).join(', '),
      '',
      'Strategies: ' + Object.entries(byStrategy).map(([k, v]) => `\`${k}\` ${v}`).join(', '),
      '',
      '## Fixture cases (the ones the corpus lacks)',
      '',
      '| Layer | Expected | Classified | Strategy | MapLibre layers | QGIS classes | Vector would have drawn |',
      '|---|---|---|---|---|---|---|'
    ]
    for (const r of fixtureRows) {
      md.push(
        `| ${r.layer} | ${r.expected} | ${r.level} | ${r.strategy} | ${r.vectorLayers} | ` +
        `${r.serverOnly.length ? r.serverOnly.join(', ') : '—'} | ${r.inventedColour || '—'} |`
      )
    }
    md.push(
      '',
      'The last column is the point of the fixture. None of those styles had a',
      'faithful vector rendering available — the colour shown is what the',
      'translator would have invented. What stops it reaching a citizen is the',
      'fidelity rung, not the colour.',
      '',
      '## Real project (what QGIS Server renders)',
      '',
      '| Layer | Classified | Strategy | MapLibre layers | Notes |',
      '|---|---|---|---|---|'
    )
    for (const r of projectRows) {
      md.push(
        `| ${r.layer} | ${r.error ? 'import error' : r.level} | ${r.strategy ?? '—'} | ${r.vectorLayers ?? '—'} | ` +
        `${r.error ? r.error : r.notes.map((n) => n.replace(/^[^:]*: /, '')).join('; ').slice(0, 160) || '—'} |`
      )
    }
    const interesting = canonicalRows.filter((r) => r.level === 'server' || r.level === 'unsupported' || r.error)
    md.push(
      '',
      `## Generated QML corpus (${canonicalRows.length} files)`,
      '',
      interesting.length
        ? 'Layers that delegate to QGIS Server or fail to import:'
        : 'No generated style delegates to QGIS Server; every one compiles to MapLibre layers.',
      '',
      '| Layer | Classified | Strategy | QGIS classes |',
      '|---|---|---|---|'
    )
    for (const r of interesting) {
      md.push(`| ${r.layer} | ${r.error ? 'import error' : r.level} | ${r.strategy ?? '—'} | ${(r.serverOnly || []).join(', ') || r.error || '—'} |`)
    }
    if (problems.length) {
      md.push('', '## Problems', '')
      for (const p of problems) md.push(`- ${p}`)
    }
    md.push(
      '',
      '## What this does and does not prove',
      '',
      '- It proves the routing decision is made from the authored symbology and',
      '  that a delegated layer contributes no MapLibre layers, so no client',
      '  can draw the approximation.',
      '- It does not prove QGIS Server renders those layers correctly. That leg',
      '  needs a running server: `npm run qgis:up` then',
      '  `npm run qgis:verify`, and `npm run verify:legends` for the legend',
      '  cross-check. See docs/LEGEND-FIDELITY-REPORT.md.',
      ''
    )
    writeFileSync(path.join(ROOT, 'docs', 'RENDER-FIDELITY-REPORT.md'), md.join('\n'))
    console.log('wrote docs/RENDER-FIDELITY-REPORT.md')
  }

  console.log('wrote docs/render-fidelity.json')
  console.log(
    `styles=${report.totals.styles} fixtures=${report.totals.fixtures} ` +
    `violations=${report.totals.violations} problems=${report.totals.problems}`
  )
  console.log(`levels: ${Object.entries(byLevel).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  console.log(`strategies: ${Object.entries(byStrategy).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  for (const p of problems.slice(0, 25)) console.log(`  PROBLEM ${p}`)

  process.exit(problems.length ? 1 : 0)
}

main()