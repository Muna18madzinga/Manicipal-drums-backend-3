// scripts/verify-spatial-tables.js
// Confirms the zimbabwe.gpkg layers exist in PostGIS and prints their
// table name, geometry column, SRID and row count. Run before building
// the layer registry so the registry reflects what is actually there.
const { Pool } = require('pg')

const EXPECTED = [
  'country', 'provinces', 'districts', 'wards',
  'roads', 'railways', 'waterways',
  'buildings', 'landuse', 'water_areas', 'protected_areas', 'natural_areas',
  'admin_areas', 'places_areas', 'traffic_areas', 'transport_areas',
  'pois_areas', 'places_of_worship_areas',
  'places_points', 'pois_points', 'traffic_points', 'transport_points',
  'natural_points', 'places_of_worship_points',
]

async function main() {
  const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://postgres:cairo2025@localhost:5432/vungu_master_db_v1'
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('render.com')
      ? { rejectUnauthorized: false }
      : undefined,
  })
  try {
    const { rows } = await pool.query(
      `SELECT f_table_name AS table, f_geometry_column AS geom_col, srid, type
       FROM geometry_columns
       WHERE f_table_schema = 'public'
       ORDER BY f_table_name`
    )
    const found = new Map(rows.map((r) => [r.table, r]))
    console.log('=== geometry_columns (public schema) ===')
    for (const r of rows) {
      console.log(`  ${r.table.padEnd(26)} geom=${r.geom_col} srid=${r.srid} type=${r.type}`)
    }
    console.log('\n=== expected zimbabwe.gpkg layers ===')
    const missing = []
    for (const name of EXPECTED) {
      const hit = found.get(name)
      if (!hit) { missing.push(name); console.log(`  MISSING  ${name}`); continue }
      const { rows: cnt } = await pool.query(`SELECT count(*)::int AS n FROM "${name}"`)
      console.log(`  OK       ${name.padEnd(26)} rows=${cnt[0].n} srid=${hit.srid} geom=${hit.geom_col}`)
    }
    if (missing.length) {
      console.log(`\n${missing.length} layer(s) missing: ${missing.join(', ')}`)
      console.log('If these are absent, the GeoPackage import is incomplete — import them with ogr2ogr before continuing.')
      process.exitCode = 1
    } else {
      console.log('\nAll expected layers present.')
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
