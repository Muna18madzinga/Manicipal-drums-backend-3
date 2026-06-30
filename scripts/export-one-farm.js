// One-off: export a single real farm parcel as GeoJSON for a planner smoke test.
require('dotenv').config()
const { Pool } = require('pg')
const fs = require('fs')

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false })

;(async () => {
  // Pick one mid-sized farm (big enough to be a real subdivision, small enough
  // to subdivide quickly). area_ha between 50 and 300, prefer a clean polygon.
  const sql = `
    SELECT fid, name, province, district, status, area_ha,
           ST_AsGeoJSON(ST_SetSRID(geom, 4326)) AS geojson
      FROM vungu_farm_cadastre
     WHERE geom IS NOT NULL
       AND area_ha BETWEEN 8 AND 20
     ORDER BY area_ha DESC
     LIMIT 1`
  const { rows } = await pool.query(sql)
  if (!rows.length) { console.error('no farm found'); process.exit(2) }
  const r = rows[0]
  const feature = {
    type: 'Feature',
    properties: { id: r.fid, name: r.name, province: r.province, district: r.district, status: r.status, area_ha: r.area_ha },
    geometry: JSON.parse(r.geojson),
  }
  const out = process.argv[2] || 'farm.geojson'
  fs.writeFileSync(out, JSON.stringify(feature))
  console.log(`Exported "${r.name}" (${r.area_ha} ha, fid ${r.fid}) -> ${out}`)
  await pool.end()
})().catch(e => { console.error(e.message); process.exit(1) })
