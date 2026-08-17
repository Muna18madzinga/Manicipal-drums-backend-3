#!/usr/bin/env node
/**
 * Smoke test for pushing a published style back out to QGIS.
 *
 * This exercises the one code path in the symbology architecture that writes a
 * PRODUCTION artifact — the 380 KB QGIS project QGIS Server serves the public
 * WMS from. So it runs against a TEMPORARY COPY via the `projectPath` option and
 * never touches the real file.
 *
 * Run: node test-gis-symbology-push.js
 */
require('dotenv').config()
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Client } = require('pg')

const pub = require('./src/services/gis/qgisPublish')
const imp = require('./src/services/gis/qgisImport')
const reg = require('./src/services/gis/styleRegistry')
const { checksum, canonicalJson } = require('./src/services/gis/styleDoc')

// The layer mapped into the QGIS project (gis_layer.qgis_layer).
const MAPPED_LAYER = 'vungu_proposed_peri_urban_zones'
const QGIS_NAME = 'proposed_peri_urban_zones'
const UNMAPPED_LAYER = 'roads'

const REAL_PROJECT = path.join(__dirname, 'qgis-projects', 'vungu-project.qgs')

let pass = 0
let fail = 0
const ok = (n) => { console.log(`  PASS  ${n}`); pass++ }
const bad = (n, d) => { console.log(`  FAIL  ${n}\n        ${d}`); fail++ }
const is = (n, actual, expected) => (
  String(actual) === String(expected) ? ok(n) : bad(n, `expected ${expected}, got ${actual}`))

;(async () => {
  if (!fs.existsSync(REAL_PROJECT)) {
    console.error(`QGIS project not found at ${REAL_PROJECT}; nothing to test.`)
    process.exit(0)
  }

  const c = new Client(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.PGHOST || 'localhost',
          user: process.env.PGUSER,
          password: process.env.PGPASSWORD,
          database: process.env.PGDATABASE,
          port: process.env.PGPORT || 5432,
        },
  )
  await c.connect()
  const db = {
    query: (...a) => c.query(...a),
    connect: async () => ({ query: (...a) => c.query(...a), release: () => {} }),
  }

  // Sandbox: a throwaway copy, so the real project is never written.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vungu-qgis-push-'))
  const project = path.join(sandbox, 'vungu-project.qgs')
  fs.copyFileSync(REAL_PROJECT, project)
  const originalSize = fs.statSync(project).size

  console.log(`\nQGIS symbology push — sandboxed at ${sandbox}\n`)

  console.log('1. Refuses to push what must not be pushed')
  try {
    await pub.pushToQgis(db, '__no_such_layer__', { projectPath: project })
    bad('unknown layer is refused', 'it succeeded')
  } catch (e) {
    ok(`unknown layer is refused — ${e.code || e.message.slice(0, 40)}`)
  }

  console.log('\n2. Pushes a mapped layer into the project')
  const r = await pub.pushToQgis(db, MAPPED_LAYER, {
    projectPath: project, actor: 'push.test', actorRole: 'gis_officer',
  })
  is('the QML sidecar is written', r.wroteQml, true)
  is('the project renderer is rewritten', r.wroteProject, true)
  is('no warnings', r.warnings.length, 0)
  r.backupPath
    ? ok(`a backup is taken before the write (${path.basename(r.backupPath)})`)
    : bad('a backup is taken before the write', 'backupPath is null')
  fs.existsSync(path.join(sandbox, 'canonical-qml', `${QGIS_NAME}.qml`))
    ? ok('the QML lands beside the project')
    : bad('the QML lands beside the project', 'file missing')

  console.log('\n3. The project survives the rewrite')
  const after = imp.importProject(project)
  is('all 10 layers still parse', after.filter((l) => !l.error).length, 10)
  const target = after.find((l) => l.layerId === QGIS_NAME)
  is('the target keeps its classification attribute', target.doc.renderer.attribute, 'zone')
  is('the target keeps all 11 classes', target.doc.renderer.categories.length, 11)

  // Only ONE layer's renderer may change. Compare every sibling against the
  // pristine original — a greedy regex would silently rewrite a later layer.
  const before = imp.importProject(REAL_PROJECT)
  const drifted = []
  for (const b of before) {
    if (b.layerId === QGIS_NAME || b.error) continue
    const a2 = after.find((x) => x.layerId === b.layerId)
    if (!a2 || a2.error) { drifted.push(`${b.layerId} (unreadable)`); continue }
    if (canonicalJson(a2.doc) !== canonicalJson(b.doc)) drifted.push(b.layerId)
  }
  drifted.length === 0
    ? ok('no sibling layer was touched')
    : bad('no sibling layer was touched', `drifted: ${drifted.join(', ')}`)

  const grew = fs.statSync(project).size
  Math.abs(grew - originalSize) < originalSize * 0.5
    ? ok(`project size is sane (${originalSize} -> ${grew} bytes)`)
    : bad('project size is sane', `${originalSize} -> ${grew} bytes`)

  console.log('\n4. Symbology round-trips losslessly')
  // Push then re-import must reproduce the SAME cartography. `scale` is
  // deliberately excluded: a layer's zoom range says where its tiles are SERVED
  // (from the tile registry), whereas QGIS scale-visibility says where a
  // cartographer wants it DRAWN. Writing one into the other would make QGIS hide
  // the layer in print layouts, so the push does not carry it.
  const live = await reg.getPublishedStyle(db, MAPPED_LAYER, { target: 'none' })
  const strip = (d) => {
    const { scale, ...rest } = d
    return { ...rest, layerId: MAPPED_LAYER }
  }
  const liveSum = checksum(strip(live.definition))
  const backSum = checksum(strip(target.doc))
  liveSum === backSum
    ? ok('renderer, classes, fallback, labels and opacity are identical after a round trip')
    : bad('symbology round-trips', `${liveSum.slice(7, 19)} vs ${backSum.slice(7, 19)}`)

  console.log('\n5. An unmapped layer gets a sidecar and says so')
  const u = await pub.pushToQgis(db, UNMAPPED_LAYER, {
    projectPath: project, actor: 'push.test', actorRole: 'gis_officer',
  })
  is('the QML is still written', u.wroteQml, true)
  is('the project is NOT touched', u.wroteProject, false)
  u.warnings.some((w) => w.includes('not mapped'))
    ? ok('the caller is told why QGIS Server will not render it')
    : bad('the caller is warned', JSON.stringify(u.warnings))

  console.log('\n6. Only PUBLISHED versions reach QGIS')
  await c.query(
    `INSERT INTO gis_layer (layer_id, display_name, geometry)
     VALUES ('__push_unpublished__', 'Unpublished test', 'polygon')
     ON CONFLICT (layer_id) DO NOTHING`,
  )
  try {
    await pub.pushToQgis(db, '__push_unpublished__', { projectPath: project })
    bad('a layer with no published style is refused', 'it succeeded')
  } catch (e) {
    is('a layer with no published style is refused', e.code, 'no_published_style')
  }
  await c.query("DELETE FROM gis_layer WHERE layer_id = '__push_unpublished__'")

  console.log('\n7. The push is auditable')
  const audit = await reg.getAudit(db, MAPPED_LAYER, { limit: 10 })
  const pushEvent = audit.find((e) => e.event === 'pushed_to_qgis')
  pushEvent
    ? ok(`recorded: ${pushEvent.event} v${pushEvent.to_version} by ${pushEvent.actor}`)
    : bad('the push is recorded in the audit log', 'no pushed_to_qgis event found')
  pushEvent?.detail?.qgisLayer === QGIS_NAME
    ? ok('the audit names the QGIS layer written')
    : bad('the audit names the QGIS layer', JSON.stringify(pushEvent?.detail))

  fs.rmSync(sandbox, { recursive: true, force: true })
  await c.end()

  console.log(`\n${pass} passed, ${fail} failed`)
  console.log(`real project untouched: ${REAL_PROJECT}\n`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('\nharness error:', e.message, '\n', e.stack); process.exit(1) })
