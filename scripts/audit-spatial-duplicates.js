#!/usr/bin/env node
/**
 * Audit the spatial tables that look like duplicates or that are named for an authority.
 *
 *   node scripts/audit-spatial-duplicates.js            print the report
 *   node scripts/audit-spatial-duplicates.js --json     the same as JSON
 *
 * READ-ONLY. For each table: what it holds, whether its geometry is sound, what depends on it
 * (views, foreign keys, triggers), and where it is mentioned in the code and the QGIS project.
 * For each pair of tables that may hold the same thing: how well their features overlap, so a
 * duplicate is established by comparing the geometry, not by trusting a name.
 *
 * Why it exists: a table was dropped as "unused" while the QGIS project still read it, because the
 * references were looked for in code only. This looks in the QGIS project and the tile config too.
 */
const fs = require('node:fs')
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

const ROOT = path.join(__dirname, '..')
const REPOS = [ROOT, path.join(ROOT, '..', 'app-frontend')]
const SKIP = new Set(['node_modules', '.git', 'backups', 'attic', 'dist', '.vite'])
const EXT = new Set(['.js', '.ts', '.vue', '.sql', '.qgs', '.qml', '.py', '.json', '.md'])

// Tables to audit: anything named for an authority, plus the canonical tables they may duplicate.
const EXTRA = ['proposed_peri_urban_zones', 'zones_master', 'stands', 'country', 'districts', 'wards']
// Pairs that may hold the same features.
const PAIRS = [
  ['gweru_beyond_periurban_zones', 'vungu_beyond_peri_urban_zones'],
  ['gweru_peri_urban_zone', 'proposed_peri_urban_zones'],
  ['gweru_rural_farms', 'vungu_farm_cadastre'],
  ['vungu_farm_cadastre', 'vungu_parcels'],
  ['gweru_rural_farms', 'vungu_parcels'],
]

function* walk(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (EXT.has(path.extname(e.name))) yield p
  }
}

/** Files that mention each table name (whole word). Reads the QGIS project and configs, not only code. */
function mentions(tables) {
  const found = Object.fromEntries(tables.map((t) => [t, []]))
  const res = tables.map((t) => [t, new RegExp(`\\b${t}\\b`)])
  for (const repo of REPOS) {
    for (const file of walk(repo)) {
      let text
      try { if (fs.statSync(file).size > 6_000_000) continue; text = fs.readFileSync(file, 'utf8') } catch { continue }
      for (const [t, re] of res) if (re.test(text)) found[t].push(path.relative(path.join(ROOT, '..'), file).replace(/\\/g, '/'))
    }
  }
  return found
}

async function main() {
  const asJson = process.argv.includes('--json')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const q = async (sql, p) => (await pool.query(sql, p)).rows
  try {
    const named = (await q("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name LIKE 'gweru\\_%' OR table_name LIKE 'vungu\\_%') ORDER BY 1")).map((r) => r.table_name)
    const tables = [...new Set([...named, ...EXTRA])]
    const refs = mentions(tables)

    const report = { tables: {}, pairs: [] }
    for (const t of tables) {
      const exists = (await q("SELECT to_regclass($1) AS r", [`public.${t}`]))[0].r
      if (!exists) { report.tables[t] = { exists: false, mentionedIn: refs[t] }; continue }
      const kind = (await q("SELECT relkind FROM pg_class WHERE oid = $1::regclass", [`public.${t}`]))[0].relkind
      const cols = (await q("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [t])).map((r) => r.column_name)
      const geomCol = (await q("SELECT f_geometry_column c, srid, type FROM geometry_columns WHERE f_table_schema='public' AND f_table_name=$1 LIMIT 1", [t]))[0]
      let rows = null, invalid = null, nullGeom = null
      try { rows = (await q(`SELECT COUNT(*)::int n FROM public."${t}"`))[0].n } catch { /* view without rows access */ }
      if (geomCol && rows !== null) {
        const g = geomCol.c
        const r = (await q(`SELECT COUNT(*) FILTER (WHERE ${g} IS NULL)::int nulls, COUNT(*) FILTER (WHERE ${g} IS NOT NULL AND NOT ST_IsValid(${g}))::int invalid FROM public."${t}"`))[0]
        nullGeom = r.nulls; invalid = r.invalid
      }
      const pk = (await q(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = $1::regclass AND i.indisprimary`, [`public.${t}`])).map((r) => r.attname)
      const views = (await q(`SELECT DISTINCT d.relname FROM pg_depend dep JOIN pg_rewrite r ON r.oid = dep.objid JOIN pg_class d ON d.oid = r.ev_class WHERE dep.refobjid = $1::regclass AND d.relname <> $2`, [`public.${t}`, t])).map((r) => r.relname)
      const fkIn = (await q("SELECT conrelid::regclass::text AS t, conname FROM pg_constraint WHERE confrelid = $1::regclass", [`public.${t}`])).map((r) => `${r.t} (${r.conname})`)
      const fkOut = (await q("SELECT confrelid::regclass::text AS t FROM pg_constraint WHERE conrelid = $1::regclass AND contype='f'", [`public.${t}`])).map((r) => r.t)
      const triggers = (await q("SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal", [`public.${t}`])).map((r) => r.tgname)
      report.tables[t] = {
        exists: true, kind: kind === 'v' ? 'view' : 'table', rows, geometry: geomCol ? `${geomCol.type} srid ${geomCol.srid}` : null,
        nullGeometry: nullGeom, invalidGeometry: invalid, primaryKey: pk, columns: cols, viewsOnIt: views, fkReferencedBy: fkIn, fkReferences: fkOut, triggers,
        mentionedIn: refs[t],
      }
    }

    for (const [a, b] of PAIRS) {
      const ta = report.tables[a], tb = report.tables[b]
      if (!ta?.exists || !tb?.exists || !ta.geometry || !tb.geometry) { report.pairs.push({ a, b, skipped: 'one side missing' }); continue }
      const ga = (await q("SELECT f_geometry_column c FROM geometry_columns WHERE f_table_schema='public' AND f_table_name=$1 LIMIT 1", [a]))[0].c
      const gb = (await q("SELECT f_geometry_column c FROM geometry_columns WHERE f_table_schema='public' AND f_table_name=$1 LIMIT 1", [b]))[0].c
      // For each feature of A, its best overlap (intersection over union) with any feature of B.
      const best = await q(`
        SELECT a.ctid::text AS id,
               COALESCE((SELECT MAX(ST_Area(ST_Intersection(ST_MakeValid(a."${ga}"), ST_MakeValid(b."${gb}"))) /
                                    NULLIF(ST_Area(ST_Union(ST_MakeValid(a."${ga}"), ST_MakeValid(b."${gb}"))), 0))
                           FROM public."${b}" b WHERE b."${gb}" && a."${ga}" AND ST_Intersects(ST_MakeValid(a."${ga}"), ST_MakeValid(b."${gb}"))), 0) AS iou
          FROM public."${a}" a WHERE a."${ga}" IS NOT NULL`)
      const n = best.length
      const sorted = best.map((r) => Number(r.iou)).sort((x, y) => x - y)
      report.pairs.push({
        a, b, featuresInA: n, featuresInB: tb.rows,
        identical: sorted.filter((v) => v >= 0.99).length,
        similar: sorted.filter((v) => v >= 0.8 && v < 0.99).length,
        different: sorted.filter((v) => v > 0 && v < 0.8).length,
        noCounterpart: sorted.filter((v) => v === 0).length,
        medianOverlap: n ? Number(sorted[Math.floor(n / 2)].toFixed(3)) : null,
      })
    }

    if (asJson) { console.log(JSON.stringify(report, null, 2)); return }
    console.log('TABLES\n')
    for (const [t, i] of Object.entries(report.tables)) {
      if (!i.exists) { console.log(`${t}: DOES NOT EXIST   mentioned in ${i.mentionedIn.length} file(s)`); continue }
      console.log(`${t}  [${i.kind}, ${i.rows ?? '?'} rows, ${i.geometry ?? 'no geometry'}${i.invalidGeometry ? `, ${i.invalidGeometry} INVALID` : ''}${i.nullGeometry ? `, ${i.nullGeometry} null geom` : ''}]`)
      console.log(`   pk: ${i.primaryKey.join(',') || 'NONE'}   triggers: ${i.triggers.join(',') || '-'}`)
      console.log(`   views on it: ${i.viewsOnIt.join(', ') || '-'}   fk in: ${i.fkReferencedBy.join(', ') || '-'}   fk out: ${i.fkReferences.join(', ') || '-'}`)
      console.log(`   mentioned in ${i.mentionedIn.length} file(s): ${i.mentionedIn.slice(0, 8).join(', ')}${i.mentionedIn.length > 8 ? ', …' : ''}`)
    }
    console.log('\nPAIRS (overlap of each feature in A with its best match in B; 1.0 = same shape)\n')
    for (const p of report.pairs) {
      if (p.skipped) { console.log(`${p.a}  vs  ${p.b}: ${p.skipped}`); continue }
      console.log(`${p.a} (${p.featuresInA}) vs ${p.b} (${p.featuresInB}): identical ${p.identical}, similar ${p.similar}, different ${p.different}, no counterpart ${p.noCounterpart}, median ${p.medianOverlap}`)
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
