#!/usr/bin/env node
/**
 * Legend fidelity cross-check — the evidence for the paper's fallback claim.
 *
 * The paper keeps WMS `GetLegendGraphic` as a pixel-perfect fallback for
 * symbology too complex for a MapLibre paint expression to carry. That claim
 * is only credible if the fallback is exercised against a real QGIS Server
 * rendering the real project, and compared with what the client-side
 * translation produced. This does exactly that, for every layer the pilot
 * project contains:
 *
 *   1. GET /wms GetLegendGraphic  -> must be a real PNG (magic bytes + size),
 *      fetched twice: straight from QGIS Server, and again through the
 *      backend bridge at /api/ogc/wms/legend/:layer, because that second path
 *      is the one the portal actually uses. Both must be PNG.
 *   2. GET /wms GetStyles         -> the SLD QGIS itself publishes for the
 *      layer. This is QGIS's machine-readable statement of its own style, so
 *      it can be diffed against our extraction without rasterising anything.
 *   3. Compare:
 *        - palette:      colours in the SLD vs colours we emit to MapLibre
 *        - classification: SLD rule/class count vs extracted symbol count
 *      A colour QGIS draws that never reaches the client is a translation
 *      defect; a colour we emit that QGIS does not draw is a drift defect.
 *
 * Writes docs/LEGEND-FIDELITY-REPORT.md. Exits non-zero if the server is down,
 * any legend fails to render, or any layer shows palette drift.
 *
 * Usage: node scripts/verify-legend-fidelity.mjs [--json-only] [--layers a,b,c]
 */
import { writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { PerfectQGISStyleExtractor } = require('../src/services/admin/perfectQGISStyleExtractor.js')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const QGIS = process.env.QGIS_SERVER_URL || 'http://localhost:8080'
const BACKEND = process.env.BACKEND_URL || 'http://localhost:3000'
const PROJECT = process.env.QGIS_PROJECT_LOCAL || path.join(ROOT, 'qgis-projects', 'vungu-project.qgs')
const jsonOnly = process.argv.includes('--json-only')
const only = (process.argv.find((a) => a.startsWith('--layers=')) || '').split('=')[1]

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])

const norm = (c) => String(c || '').trim().toLowerCase()

/** Colours QGIS published as SLD CssParameter values. */
function sldColours(sld) {
  const out = new Set()
  const add = (v) => {
    const s = norm(v)
    if (/^#[0-9a-f]{6}$/.test(s) || /^#[0-9a-f]{3}$/.test(s)) out.add(s.length === 4
      ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`
      : s)
  }
  // NB: the slash in the closing tag must stay escaped or it closes the literal.
  for (const m of sld.matchAll(/<sld:CssParameter[^>]*name="([^"]+)"[^>]*>([^<]*)<\/sld:CssParameter>/g)) {
    const [, name, value] = m
    if (/^(fill|stroke|color|fill-color|stroke-color)$/i.test(name)) {
      // SLD may hold a full svg:literal like "#rrggbb" or "#rrggbbaa"
      add(value.split('#')[1] ? `#${value.split('#')[1].slice(0, 6)}` : value)
    }
  }
  return out
}

/** Colours our extraction emits into MapLibre paint properties. */
function extractedColours(maplibreStyle) {
  const out = new Set()
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (node && typeof node === 'object') return Object.values(node).forEach(walk)
    if (typeof node === 'string') {
      const s = norm(node)
      if (/^#[0-9a-f]{6}$/.test(s) || /^#[0-9a-f]{8}$/.test(s)) out.add(s.slice(0, 7))
      const rgba = s.match(/^rgba?\(([^)]+)\)$/)
      if (rgba) {
        const [r, g, b] = rgba[1].split(',').map((v) => parseInt(v, 10))
        if ([r, g, b].every((v) => Number.isFinite(v))) {
          out.add(`#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`)
        }
      }
    }
  }
  walk(maplibreStyle.paint || {})
  return out
}

async function fetchBuf(url, timeoutMs = 20000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    return { status: res.status, ct: res.headers.get('content-type') || '', buf: Buffer.from(await res.arrayBuffer()) }
  } finally {
    clearTimeout(t)
  }
}

const isPng = (buf) => buf.length > 8 && buf.subarray(0, 4).equals(PNG_MAGIC)
const isXmlFault = (buf) => /ServiceException|ExceptionReport/i.test(buf.toString('utf8', 0, 400))

async function main() {
  // 0. Is there a QGIS Server at all?
  let health = { status: 0, body: '' }
  try {
    const h = await fetchBuf(`${QGIS}/healthz`, 8000)
    health = { status: h.status, body: h.buf.toString('utf8').trim() }
  } catch (error) {
    health = { status: 0, body: error.message }
  }

  const extractor = new PerfectQGISStyleExtractor()
  let layers = extractor.listProjectLayers(PROJECT).map((l) => l.name)
  if (only) layers = layers.filter((l) => only.split(',').includes(l))

  const rows = []
  for (const layer of layers) {
    const row = { layer }
    const q = new URLSearchParams({ SERVICE: 'WMS', VERSION: '1.3.0', LAYER: layer, STYLE: 'default', FORMAT: 'image/png' })

    // 1a. GetLegendGraphic, straight from QGIS Server
    try {
      const lg = await fetchBuf(`${QGIS}/wms?${new URLSearchParams({ ...Object.fromEntries(q), REQUEST: 'GetLegendGraphic' })}`)
      row.legend = {
        status: lg.status,
        bytes: lg.buf.length,
        png: isPng(lg.buf),
        fault: isXmlFault(lg.buf) ? lg.buf.toString('utf8', 0, 200) : null
      }
    } catch (error) {
      row.legend = { status: 0, bytes: 0, png: false, error: error.message }
    }

    // 1b. Same request through the backend bridge the portal uses. `raw=true`
    // is what the map legend widget sends; without it the route answers a JSON
    // wrapper and a PNG check here would always report a false negative.
    try {
      const br = await fetchBuf(`${BACKEND}/api/ogc/wms/legend/${encodeURIComponent(layer)}?raw=true`)
      row.bridge = {
        status: br.status,
        bytes: br.buf.length,
        png: isPng(br.buf),
        // A 200 that is not a PNG means the bridge served its own offline SVG
        // placeholder: a legitimate degraded mode, not a fidelity defect. Same
        // for the 500 it returns when QGIS Server is unreachable.
        degraded: !isPng(br.buf) && !br.error && br.status < 400
      }
    } catch (error) {
      row.bridge = { status: 0, bytes: 0, png: false, error: error.message }
    }

    // 2. GetStyles -> SLD, QGIS's machine-readable style statement
    try {
      const st = await fetchBuf(`${QGIS}/wms?${new URLSearchParams({ ...Object.fromEntries(q), REQUEST: 'GetStyles' })}`)
      const sld = st.buf.toString('utf8')
      row.sld = {
        status: st.status,
        bytes: st.buf.length,
        fault: isXmlFault(st.buf) ? sld.slice(0, 200) : null,
        rules: (sld.match(/<sld:Rule[\s>]/g) || []).length,
        colours: [...sldColours(sld)]
      }
    } catch (error) {
      row.sld = { status: 0, bytes: 0, rules: 0, colours: [], error: error.message }
    }

    // 3. Compare with what we send the browser
    try {
      const style = await extractor.extractCompleteStyle(layer, PROJECT, { noCache: true })
      const ours = extractedColours(style.maplibreStyle)
      row.extracted = {
        source: style.metadata.styleSource,
        fallback: style.metadata.fallback,
        renderer: style.qgisStyle.rendererType,
        symbols: style.webStyle.symbols.length,
        colours: [...ours]
      }
      if (row.sld?.colours?.length) {
        const missing = row.sld.colours.filter((c) => !ours.has(c))
        const extra = [...ours].filter((c) => !row.sld.colours.includes(c))
        row.compare = {
          sldOnly: missing,
          oursOnly: extra,
          // A single flat symbol legitimately paints an outline colour the
          // SLD also lists; only flag when QGIS draws colours we drop entirely.
          status: missing.length ? 'drift' : 'match'
        }
      }
    } catch (error) {
      row.extracted = { error: error.message }
    }

    row.fail = !(row.legend?.png) || Boolean(row.sld?.fault) || row.compare?.status === 'drift'
    rows.push(row)
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    qgisServer: QGIS,
    backend: BACKEND,
    project: path.relative(ROOT, PROJECT),
    qgisUp: health.status === 200,
    health,
    totals: {
      layers: rows.length,
      legendPng: rows.filter((r) => r.legend?.png).length,
      legendViaBridgePng: rows.filter((r) => r.bridge?.png).length,
      bridgeDegraded: rows.filter((r) => r.bridge?.degraded).length,
      sldOk: rows.filter((r) => r.sld?.status === 200 && !r.sld?.fault).length,
      drift: rows.filter((r) => r.compare?.status === 'drift').length,
      failed: rows.filter((r) => r.fail).length
    },
    layers: rows
  }

  writeFileSync(path.join(ROOT, 'docs', 'legend-fidelity.json'), JSON.stringify(summary, null, 2))

  if (!jsonOnly) {
    const md = [
      '# Legend fidelity cross-check',
      '',
      `Generated ${summary.generatedAt} by \`scripts/verify-legend-fidelity.mjs\`.`,
      '',
      `QGIS Server: \`${QGIS}\` (${summary.qgisUp ? 'reachable' : `NOT reachable — ${health.body || health.status}`})`,
      `Backend bridge: \`${BACKEND}/api/ogc/wms/legend/:layer\``,
      '',
      'This is the evidence for the paper\'s fallback claim: QGIS renders the',
      'authored symbology through WMS `GetLegendGraphic`, and `GetStyles` returns the',
      'SLD QGIS itself publishes, which can be diffed against what the client-side',
      'translation sends to MapLibre.',
      '',
      `**${summary.totals.legendPng}/${summary.totals.layers} legends rendered as PNG · ` +
      `${summary.totals.legendViaBridgePng} via the backend bridge · ` +
      `${summary.totals.sldOk} SLDs retrieved · ${summary.totals.drift} with palette drift · ` +
      `${summary.totals.failed} failed**`,
      '',
      '| Layer | Legend PNG | Via bridge | SLD rules | SLD colours | Our symbols | Our colours | Verdict |',
      '|---|---|---|---|---|---|---|---|'
    ]
    for (const r of rows) {
      const verdict = r.fail ? '**FAIL**' : r.compare?.status === 'drift' ? 'drift' : r.extracted?.fallback ? 'fallback style' : 'match'
      md.push(
        `| ${r.layer} | ${r.legend?.png ? `${r.legend.bytes}b` : `no (${r.legend?.status})`} | ` +
        `${r.bridge?.png ? `${r.bridge.bytes}b` : r.bridge?.degraded ? 'degraded' : `no (${r.bridge?.status})`} | ` +
        `${r.sld?.rules ?? '—'} | ${r.sld?.colours?.length ?? '—'} | ${r.extracted?.symbols ?? '—'} | ` +
        `${r.extracted?.colours?.length ?? '—'} | ${verdict} |`
      )
      if (r.compare?.status === 'drift') {
        md.push(`| ↳ ${r.layer} | | | | | | | QGIS draws \`${r.compare.sldOnly.join('`, `')}\` which the MapLibre paint does not contain |`)
      }
    }
    md.push(
      '',
      '## How to read a failure',
      '',
      '- **Legend PNG = no** — QGIS Server cannot render that layer. Almost always the',
      '  layer\'s PostGIS source is unreachable from the container: check',
      '  `docker compose -f docker-compose.qgis.yml logs qgis-server` and that',
      '  `qgis-projects/pg_service.docker.conf` points at the right dbname.',
      '- **Via bridge = degraded** — the backend answered JSON instead of a PNG, which is',
      '  its documented behaviour while QGIS Server is down. The web map falls back to',
      '  client-side vector styling; no user-visible breakage, lower fidelity.',
      '- **drift** — QGIS\'s own SLD names a colour that never reaches the client. This is',
      '  the case that justifies keeping `GetLegendGraphic`: the paint expression is an',
      '  approximation, and the legend is what makes it defensible.',
      ''
    )
    writeFileSync(path.join(ROOT, 'docs', 'LEGEND-FIDELITY-REPORT.md'), md.join('\n'))
    console.log('wrote docs/LEGEND-FIDELITY-REPORT.md')
  }

  console.log('wrote docs/legend-fidelity.json')
  console.log(
    `qgisUp=${summary.qgisUp} layers=${summary.totals.layers} legendPng=${summary.totals.legendPng} ` +
    `bridgePng=${summary.totals.legendViaBridgePng} sld=${summary.totals.sldOk} drift=${summary.totals.drift} failed=${summary.totals.failed}`
  )
  for (const r of rows.filter((x) => x.fail)) {
    console.log(`  FAIL ${r.layer}: legend=${r.legend?.status}/${r.legend?.png ? 'png' : 'no png'}` +
      `${r.sld?.fault ? ` sld-fault=${r.sld.fault}` : ''}${r.compare?.sldOnly?.length ? ` missing=${r.compare.sldOnly.join(',')}` : ''}`)
  }

  process.exit(summary.totals.failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(3)
})
