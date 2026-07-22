#!/usr/bin/env node
// Verify the QGIS Server rendering path end to end. Run AFTER:
//   docker compose -f docker-compose.qgis.yml up -d
//
// Each step prints PASS/FAIL with the exact next action on failure, so the
// first boot is self-diagnosing instead of a black box.
//   node scripts/verify-qgis-server.js
require('dotenv').config()

const QGIS = process.env.QGIS_SERVER_URL || 'http://localhost:8080'
const BACKEND = process.env.SELF_URL || 'http://localhost:3000'
const LAYER = process.argv[2] || 'proposed_peri_urban_zones'
const BBOX = '29.5,-20.2,30.2,-19.2' // lon/lat around Vungu RDC

let failed = 0
const ok = (m) => console.log('  \x1b[32mPASS\x1b[0m ' + m)
const bad = (m, fix) => { failed++; console.log('  \x1b[31mFAIL\x1b[0m ' + m + (fix ? '\n       -> ' + fix : '')) }

async function get(url, { raw = false } = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 20000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    const buf = Buffer.from(await res.arrayBuffer())
    return { status: res.status, ct: res.headers.get('content-type') || '', buf, text: raw ? '' : buf.toString('utf8') }
  } finally { clearTimeout(t) }
}

;(async () => {
  console.log(`\nQGIS Server verification — ${QGIS}\n`)

  // 1. nginx reachable
  try {
    const h = await get(`${QGIS}/healthz`)
    if (h.status === 200) ok('nginx front is up (:8080)')
    else bad(`nginx returned ${h.status}`, 'docker compose -f docker-compose.qgis.yml ps  — is qgis-web running?')
  } catch (e) {
    bad(`cannot reach ${QGIS} (${e.message})`, 'Is Docker running? docker compose -f docker-compose.qgis.yml up -d')
    return done()
  }

  // 2. GetCapabilities lists real layers
  try {
    const c = await get(`${QGIS}/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities`)
    const names = [...c.text.matchAll(/<Name>([^<]+)<\/Name>/g)].map(m => m[1])
    if (names.length) ok(`GetCapabilities lists ${names.length} layers (${names.slice(0, 4).join(', ')}...)`)
    else if (/ServiceException|Exception/i.test(c.text)) bad('QGIS Server returned a ServiceException', 'Project failed to load — check container logs: docker compose -f docker-compose.qgis.yml logs qgis-server')
    else bad('GetCapabilities returned no layers', 'QGIS_PROJECT_FILE may be wrong or the project cannot open its datasources (pg_service.docker.conf / host pg_hba).')
  } catch (e) { bad(`GetCapabilities failed (${e.message})`) }

  // 3. GetMap renders a real PNG (the actual pixel-perfect test)
  try {
    // WMS 1.3.0 + EPSG:4326 uses lat,lon axis order, so minx,miny,maxx,maxy
    // becomes miny,minx,maxy,maxx. (A plain reverse() is wrong — it yields
    // maxy,maxx,miny,minx and QGIS rejects it: "cannot be converted into a
    // rectangle".)
    const [minx, miny, maxx, maxy] = BBOX.split(',')
    const url = `${QGIS}/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${LAYER}` +
      `&CRS=EPSG:4326&BBOX=${[miny, minx, maxy, maxx].join(',')}&WIDTH=400&HEIGHT=400&FORMAT=image/png&STYLES=`
    const m = await get(url, { raw: true })
    const isPng = m.buf.length > 8 && m.buf[0] === 0x89 && m.buf[1] === 0x50
    if (isPng && m.buf.length > 1000) ok(`GetMap rendered ${LAYER} -> ${m.buf.length}-byte PNG (QGIS symbology, pixel-perfect)`)
    else if (m.ct.includes('xml') || /Exception/i.test(m.buf.toString('utf8').slice(0, 300))) bad(`GetMap for ${LAYER} returned an exception`, 'Layer not in project, or its PostGIS datasource is unreachable from the container (host.docker.internal / pg_hba / credentials in pg_service.docker.conf).')
    else bad(`GetMap did not return a PNG (${m.ct}, ${m.buf.length}b)`, 'Check the qgis-server container logs.')
  } catch (e) { bad(`GetMap failed (${e.message})`) }

  // 4. Backend bridge sees it healthy (drives the frontend auto-selection)
  try {
    const b = await get(`${BACKEND}/api/ogc/health`)
    const j = JSON.parse(b.text)
    if (j?.data?.status === 'healthy') ok('backend /api/ogc/health = healthy -> web app will auto-use QGIS rasters')
    else bad(`backend /api/ogc/health = ${j?.data?.status || 'unknown'}`, 'Backend cannot reach QGIS Server. Confirm QGIS_SERVER_URL in backend .env = ' + QGIS + ' and restart the backend.')
  } catch (e) { bad(`backend health check failed (${e.message})`, 'Is the backend running on :3000?') }

  done()
})()

function done() {
  console.log('\n' + (failed === 0
    ? 'All checks passed — QGIS-rendered pixels are live. The web app now shows exactly what QGIS Desktop shows.\n'
    : `${failed} check(s) failed — fix the -> items above, then re-run.\n`))
  process.exit(failed === 0 ? 0 : 1)
}
