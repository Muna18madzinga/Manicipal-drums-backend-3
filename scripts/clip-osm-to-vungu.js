/**
 * Clip OSM basemap tables to Vungu RDC (raw PostGIS only — no GPKG queries).
 * Boundary: public.vungu_clip_boundary (wards ZW1704% + 250m).
 *
 *   node scripts/clip-osm-to-vungu.js
 *   node scripts/clip-osm-to-vungu.js --tables=roads,waterways
 */
const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/vungu_master_db_v1'

const OSM_TABLES = [
  // smaller first
  'places',
  'places_points',
  'natural_points',
  'traffic_points',
  'transport_points',
  'places_of_worship_points',
  'pois_points',
  'places_of_worship_areas',
  'pois_areas',
  'traffic_areas',
  'transport_areas',
  'protected_areas',
  'natural_areas',
  'admin_areas',
  'places_areas',
  'water_areas',
  'waterways',
  'railways',
  'landuse',
  'roads',
  'buildings', // largest last
]

function parseTables() {
  const arg = process.argv.find((a) => a.startsWith('--tables='))
  if (!arg) return OSM_TABLES
  const set = new Set(arg.slice('--tables='.length).split(',').map((s) => s.trim()).filter(Boolean))
  return OSM_TABLES.filter((t) => set.has(t))
}

async function tableExists(client, name) {
  const { rows } = await client.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`])
  return rows[0].ok
}

async function ensureBoundary(client) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '129_clip_osm_to_vungu.sql'), 'utf8')
  await client.query(sql)
  const { rows } = await client.query(`
    SELECT ROUND((ST_Area(geom::geography)/1e6)::numeric, 1) AS km2
    FROM public.vungu_clip_boundary WHERE id = 1
  `)
  console.log('vungu_clip_boundary ready, km²=', rows[0]?.km2)
}

async function clipTable(client, table) {
  if (!(await tableExists(client, table))) {
    console.log(`[skip] ${table} missing`)
    return null
  }

  // Cheap estimate (no full scan)
  const { rows: est } = await client.query(
    `SELECT COALESCE(n_live_tup, 0)::bigint AS n FROM pg_stat_user_tables
     WHERE schemaname='public' AND relname=$1`,
    [table],
  )
  console.log(`[start] ${table} (stats≈${est[0]?.n ?? '?'})`)

  const tmp = `${table}__vungu_clip`
  const t0 = Date.now()
  await client.query(`DROP TABLE IF EXISTS public.${tmp}`)
  await client.query(`
    CREATE TABLE public.${tmp} AS
    SELECT t.*
    FROM public.${table} t
    WHERE t.geom && (SELECT geom FROM public.vungu_clip_boundary WHERE id = 1)
      AND ST_Intersects(t.geom, (SELECT geom FROM public.vungu_clip_boundary WHERE id = 1))
  `)

  const { rows: kept } = await client.query(`SELECT COUNT(*)::bigint AS n FROM public.${tmp}`)
  console.log(`  created ${tmp}: ${kept[0].n} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

  const { rows: cols } = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1`,
    [tmp],
  )
  const names = new Set(cols.map((c) => c.column_name))
  if (names.has('fid')) {
    await client.query(`ALTER TABLE public.${tmp} ADD PRIMARY KEY (fid)`)
  }
  if (names.has('geom')) {
    await client.query(`CREATE INDEX ON public.${tmp} USING GIST (geom)`)
  }

  await client.query('BEGIN')
  try {
    await client.query(`DROP TABLE public.${table}`)
    await client.query(`ALTER TABLE public.${tmp} RENAME TO ${table}`)
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }

  // Best-effort index rename
  await client.query(`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'i'
          AND c.relname LIKE '${table}__vungu_clip%'
      LOOP
        BEGIN
          EXECUTE format('ALTER INDEX %I RENAME TO %I', r.relname,
            CASE WHEN r.relname LIKE '%pkey' THEN '${table}_pk'
                 ELSE '${table}_geom_geom_idx' END);
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
      END LOOP;
    END $$;
  `)

  await client.query(`ANALYZE public.${table}`)
  console.log(`[done] ${table} → ${kept[0].n} rows`)
  return { table, kept: Number(kept[0].n) }
}

async function writeInventory(client, results) {
  const exact = []
  for (const t of OSM_TABLES) {
    if (!(await tableExists(client, t))) continue
    // Prefer stats; only exact-count small/medium tables (< 500k est)
    const { rows: est } = await client.query(
      `SELECT COALESCE(n_live_tup, 0)::bigint AS n FROM pg_stat_user_tables
       WHERE schemaname='public' AND relname=$1`,
      [t],
    )
    let n = Number(est[0]?.n || 0)
    if (n < 500000) {
      const { rows } = await client.query(`SELECT COUNT(*)::bigint AS n FROM public.${t}`)
      n = Number(rows[0].n)
    }
    exact.push({ table: t, rows: n })
  }
  const { rows: allTables } = await client.query(`
    SELECT c.relname AS table_name,
           COALESCE(s.n_live_tup, 0)::bigint AS est_rows,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY pg_total_relation_size(c.oid) DESC, c.relname
  `)

  const md = [
    '# Live database tables (PostGIS) — Vungu clip',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    'Runtime map/tile queries use these **raw Postgres tables** only. GeoPackage is import-only — never queried at request time.',
    '',
    '## Clip boundary',
    '',
    '- `public.vungu_clip_boundary` — wards `pcode LIKE \'ZW1704%\'` + 250 m buffer',
    '',
    '## OSM feature tables (exact counts)',
    '',
    '| Table | Rows |',
    '|-------|-----:|',
    ...exact.map((r) => `| \`${r.table}\` | ${r.rows.toLocaleString('en-US')} |`),
    '',
    '## Clip results (this run)',
    '',
    '| Table | Kept |',
    '|-------|-----:|',
    ...results.filter(Boolean).map((r) => `| \`${r.table}\` | ${r.kept.toLocaleString('en-US')} |`),
    '',
    '## All public base tables',
    '',
    '| Table | Est. rows | Size |',
    '|-------|----------:|-----:|',
    ...allTables.map((r) => `| \`${r.table_name}\` | ${r.est_rows} | ${r.total_size} |`),
    '',
    '## How tiles read data',
    '',
    '1. `spatialLayers.js` maps layer id → PostGIS `table`',
    '2. `GET /tiles/:layer/:z/:x/:y.pbf` → `ST_AsMVT` on that table',
    '3. No `.gpkg` / ogr2ogr at request time',
    '',
  ].join('\n')

  const outDir = path.join(__dirname, '..', 'docs')
  fs.writeFileSync(path.join(outDir, 'LIVE-DATABASE-TABLES.md'), md)
  fs.writeFileSync(path.join(outDir, 'clip-osm-results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
  console.log('Wrote docs/LIVE-DATABASE-TABLES.md')
}

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(DATABASE_URL) && !process.env.ALLOW_REMOTE_CLIP) {
    console.error('Refusing non-localhost without ALLOW_REMOTE_CLIP=1')
    process.exit(1)
  }
  const tables = parseTables()
  const pool = new Pool({ connectionString: DATABASE_URL })
  const client = await pool.connect()
  try {
    await client.query('SET statement_timeout = 0')
    await client.query("SET maintenance_work_mem = '1GB'")
    await ensureBoundary(client)
    const results = []
    for (const t of tables) {
      results.push(await clipTable(client, t))
    }
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await client.query(`
      INSERT INTO schema_migrations (filename, applied_at)
      VALUES ('129_clip_osm_to_vungu.sql', NOW())
      ON CONFLICT (filename) DO UPDATE SET applied_at = EXCLUDED.applied_at
    `)
    await writeInventory(client, results)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
