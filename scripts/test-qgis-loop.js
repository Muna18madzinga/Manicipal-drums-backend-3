// Smoke test: PyQGIS plugin sync loop (push -> PostGIS -> catalogue -> pull).
// Run: node scripts/test-qgis-loop.js   (backend must be listening on :3000)
require('dotenv').config()
const { signApiToken } = require('../src/middleware/jwtAuth')

const BASE = 'http://localhost:3000'
const token = signApiToken({ id: 'qgis-smoke-test', pluginName: 'vungu-qgis-plugin' })
const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }

const payload = {
  layer_name: 'Plugin Loop Test',
  crs: 'EPSG:4326',
  field_types: { name: 'String', area_ha: 'Real', approved: 'Boolean' },
  style: { renderer: 'singleSymbol', fill: '#8bc34a' },
  features: [
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[29.80, -19.40], [29.81, -19.40], [29.81, -19.41], [29.80, -19.41], [29.80, -19.40]]] }, properties: { name: 'Stand A', area_ha: 1.25, approved: true } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[29.82, -19.40], [29.83, -19.40], [29.83, -19.41], [29.82, -19.41], [29.82, -19.40]]] }, properties: { name: 'Stand B', area_ha: 2.5, approved: false } },
  ],
}

;(async () => {
  // 1. push
  const up = await fetch(`${BASE}/api/qgis/sync/upload`, { method: 'POST', headers: H, body: JSON.stringify(payload) })
  const upBody = await up.json()
  console.log('PUSH  ', up.status, JSON.stringify(upBody.data || upBody))
  if (!upBody.success) process.exit(1)

  // 2. catalogue
  const cat = await (await fetch(`${BASE}/api/dynamic-layers/layers`)).json()
  const found = (cat.data || []).find(l => l.id === upBody.data.layer_id)
  console.log('CATALOG', found ? `registered: ${found.id} (${found.type})` : 'NOT FOUND')

  // 3. pull
  const down = await fetch(`${BASE}/api/qgis/sync/download/${upBody.data.layer_id}`, { headers: H })
  const downBody = await down.json()
  const feats = downBody.data ? downBody.data.features : []
  console.log('PULL  ', down.status, `${feats.length} features, fields: ${Object.keys(downBody.data ? downBody.data.field_types : {}).join(',')}`)
  const a = feats.find(f => f.properties.name === 'Stand A')
  console.log('ROUNDTRIP', a && Number(a.properties.area_ha) === 1.25 && a.geometry.type === 'Polygon' ? 'OK' : 'MISMATCH')

  // 4. unauthorized push must 401
  const bad = await fetch(`${BASE}/api/qgis/sync/upload`, { method: 'POST', headers: { 'Authorization': 'Bearer vungu-api-forged', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  console.log('FORGED', bad.status === 401 ? '401 OK' : `UNEXPECTED ${bad.status}`)
  process.exit(0)
})().catch(e => { console.error('FAIL', e.message); process.exit(1) })
