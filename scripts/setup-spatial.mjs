#!/usr/bin/env node
// scripts/setup-spatial.mjs
//
// Rebuilds the entire spatial dataset on a fresh machine so a clone of this
// repo can reproduce every map layer. Run once after `npm install` and after
// PostGIS is reachable:
//
//   node scripts/setup-spatial.mjs
//
// It performs, idempotently:
//   1. zimbabwe.gpkg               -> 24 OSM basemap tables (native SRID 900914)
//   2. Vungu_RDC_Master_Plan.gpkg  ->  6 vungu_* master-plan tables (EPSG:4326)
//   3. data/seed/gweru_legacy.sql  ->  8 gweru_* legacy tables (no source file)
//   4. GiST indexes on every geom column
//
// Connection: set DATABASE_URL, or PGUSER/PGPASSWORD/PGHOST/PGPORT/PGDATABASE.
//
// Prerequisites on the target machine:
//   - PostgreSQL client tools (psql) — ships with any Postgres install.
//   - A GDAL `ogr2ogr` that has the PostgreSQL driver. QGIS and OSGeo4W both
//     ship one; the EnterpriseDB PostgreSQL bundle's ogr2ogr does NOT. The
//     script auto-discovers a suitable ogr2ogr (QGIS / OSGeo4W / PATH) and
//     points PROJ at that GDAL's own proj.db to avoid version clashes.
//   - The two .gpkg files are NOT in git (zimbabwe.gpkg is 1.47 GB). Fetch
//     them first with:
//        ZIMBABWE_GPKG_URL=https://... VUNGU_GPKG_URL=https://... \
//          node scripts/download-spatial-source.mjs
//     The live spatial tables already live in PostGIS once this script has
//     run; the .gpkg sources are only needed to (re-)import or to set up a
//     fresh database.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DATA = join(ROOT, 'data')

const ZIM_GPKG = process.env.ZIMBABWE_GPKG || join(DATA, 'zimbabwe.gpkg')
const VUNGU_GPKG = process.env.VUNGU_GPKG || join(DATA, 'Vungu_RDC_Master_Plan.gpkg')
const GWERU_SEED = join(DATA, 'seed', 'gweru_legacy.sql')

const DB_URL = process.env.DATABASE_URL ||
  `postgresql://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || 'postgres'}` +
  `@${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'Vungu_spatial333'}`

// 24 OSM basemap layers — source gpkg layer name == target table name.
const OSM_LAYERS = [
  'country', 'provinces', 'districts', 'wards',
  'landuse', 'admin_areas', 'places_areas',
  'water_areas', 'waterways', 'protected_areas', 'natural_areas',
  'roads', 'railways',
  'buildings', 'traffic_areas', 'transport_areas', 'pois_areas', 'places_of_worship_areas',
  'places_points', 'pois_points', 'traffic_points', 'transport_points', 'natural_points', 'places_of_worship_points',
]

// Vungu master-plan — source layer -> normalised table name. `zimbabwe` is
// intentionally skipped (the OSM `country` table already covers it).
const VUNGU_LAYERS = [
  ['Cemetery', 'vungu_cemeteries'],
  ['Waste management', 'vungu_waste_management'],
  ['Zim_national_farm_cadastre_wgs_84', 'vungu_farm_cadastre'],
  ['parcels', 'vungu_parcels'],
  ['proposed_peri_urban_zones', 'vungu_proposed_peri_urban_zones'],
  ['beyond_peri_urban_zones', 'vungu_beyond_peri_urban_zones'],
]

const isWin = process.platform === 'win32'
const exe = (n) => (isWin ? `${n}.exe` : n)

function whichDirs() {
  // Directories worth scanning for QGIS / OSGeo4W / PostgreSQL bins.
  const dirs = []
  if (isWin) {
    for (const base of ['C:/Program Files', 'C:/Program Files (x86)', 'C:/']) {
      try {
        for (const d of readdirSync(base)) {
          if (/^QGIS|^OSGeo4W/i.test(d)) dirs.push(join(base, d, 'bin'))
          if (/^PostgreSQL$/i.test(d)) {
            const pg = join(base, d)
            try { for (const v of readdirSync(pg)) dirs.push(join(pg, v, 'bin')) } catch {}
          }
        }
      } catch {}
    }
  }
  return dirs
}

function fromPath(name) {
  try {
    const out = execFileSync(isWin ? 'where' : 'which', [name], { encoding: 'utf8' })
    const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s && existsSync(s))
    return first || null
  } catch { return null }
}

function findPsql() {
  if (process.env.PSQL && existsSync(process.env.PSQL)) return process.env.PSQL
  const onPath = fromPath('psql')
  if (onPath) return onPath
  for (const d of whichDirs()) {
    const p = join(d, exe('psql'))
    if (existsSync(p)) return p
  }
  return null
}

function hasPgDriver(ogr) {
  try { return /PostgreSQL/.test(execFileSync(ogr, ['--formats'], { encoding: 'utf8' })) }
  catch { return false }
}

function findOgr2ogr() {
  const tried = []
  if (process.env.OGR2OGR && existsSync(process.env.OGR2OGR)) {
    if (hasPgDriver(process.env.OGR2OGR)) return process.env.OGR2OGR
    tried.push(process.env.OGR2OGR)
  }
  const onPath = fromPath('ogr2ogr')
  if (onPath && hasPgDriver(onPath)) return onPath
  if (onPath) tried.push(onPath)
  for (const d of whichDirs()) {
    const p = join(d, exe('ogr2ogr'))
    if (existsSync(p) && hasPgDriver(p)) return p
    if (existsSync(p)) tried.push(p)
  }
  if (tried.length) {
    console.error('Found ogr2ogr but without the PostgreSQL driver:\n  ' + tried.join('\n  '))
  }
  return null
}

// GDAL needs its own PROJ database; a stale PROJ_LIB (e.g. from a PostgreSQL
// install) makes ogr2ogr fail with "proj.db ... DATABASE.LAYOUT.VERSION".
function gdalEnv(ogr) {
  const binDir = dirname(ogr)
  const shareProj = resolve(binDir, '..', 'share', 'proj')
  const shareGdal = resolve(binDir, '..', 'share', 'gdal')
  const env = { ...process.env }
  if (existsSync(shareProj)) { env.PROJ_LIB = shareProj; env.PROJ_DATA = shareProj }
  if (existsSync(shareGdal)) env.GDAL_DATA = shareGdal
  return env
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts })
}

function importLayer(ogr, env, gpkg, srcLayer, table, { srid } = {}) {
  const args = [
    '-f', 'PostgreSQL', `PG:${DB_URL}`, gpkg,
    '-nln', table,
    '-lco', 'GEOMETRY_NAME=geom',
    '-lco', 'FID=fid',
    '-lco', 'LAUNDER=YES',
    '-lco', 'SCHEMA=public',
    '-nlt', 'PROMOTE_TO_MULTI',
    '-overwrite',
    '--config', 'PG_USE_COPY', 'YES',
  ]
  // OSM layers keep their native SRID (900914); master-plan layers are tagged
  // as real EPSG:4326.
  if (srid) args.push('-t_srs', `EPSG:${srid}`)
  args.push(srcLayer)
  run(ogr, args, { env })
}

function main() {
  console.log('— Vungu spatial setup —')
  console.log('  DB     :', DB_URL.replace(/:[^:@/]+@/, ':****@'))

  const psql = findPsql()
  if (!psql) { console.error('psql not found. Install PostgreSQL client tools or set PSQL.'); process.exit(1) }
  const ogr = findOgr2ogr()
  if (!ogr) { console.error('No ogr2ogr with the PostgreSQL driver. Install QGIS or OSGeo4W, or set OGR2OGR.'); process.exit(1) }
  console.log('  psql   :', psql)
  console.log('  ogr2ogr:', ogr)
  const env = gdalEnv(ogr)

  const psqlExec = (sql) => run(psql, ['-d', DB_URL, '-v', 'ON_ERROR_STOP=1', '-c', sql])

  // 1. PostGIS
  console.log('\n[1/5] Ensuring PostGIS extension…')
  psqlExec('CREATE EXTENSION IF NOT EXISTS postgis;')

  // 2. OSM basemap
  if (!existsSync(ZIM_GPKG) || statSync(ZIM_GPKG).size < 1024) {
    console.error(`\nMissing or not LFS-pulled: ${ZIM_GPKG}\nRun "git lfs pull" first.`); process.exit(1)
  }
  console.log(`\n[2/5] Importing OSM basemap (${OSM_LAYERS.length} layers) from zimbabwe.gpkg…`)
  for (const layer of OSM_LAYERS) {
    process.stdout.write(`   • ${layer}\n`)
    importLayer(ogr, env, ZIM_GPKG, layer, layer) // native SRID 900914
  }

  // 3. Vungu master plan
  if (!existsSync(VUNGU_GPKG) || statSync(VUNGU_GPKG).size < 1024) {
    console.error(`\nMissing or not LFS-pulled: ${VUNGU_GPKG}\nRun "git lfs pull" first.`); process.exit(1)
  }
  console.log(`\n[3/5] Importing Vungu master plan (${VUNGU_LAYERS.length} layers)…`)
  for (const [src, table] of VUNGU_LAYERS) {
    process.stdout.write(`   • ${src} -> ${table}\n`)
    importLayer(ogr, env, VUNGU_GPKG, src, table, { srid: 4326 })
  }

  // 4. gweru_* legacy seed
  console.log('\n[4/5] Restoring gweru_* legacy tables…')
  if (existsSync(GWERU_SEED)) run(psql, ['-d', DB_URL, '-v', 'ON_ERROR_STOP=1', '-f', GWERU_SEED])
  else console.warn(`   (skipped — ${GWERU_SEED} not found)`)

  // 5. GiST indexes on every geom column
  console.log('\n[5/5] Building GiST indexes…')
  psqlExec(
    "DO $$ DECLARE r record; BEGIN " +
    "FOR r IN SELECT table_name FROM information_schema.columns " +
    "WHERE table_schema='public' AND column_name='geom' LOOP " +
    "EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I USING GIST (geom)', " +
    "r.table_name || '_geom_gist', r.table_name); END LOOP; END $$;"
  )

  console.log('\n✓ Spatial setup complete.')
}

main()
