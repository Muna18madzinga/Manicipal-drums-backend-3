#!/usr/bin/env node
/**
 * Retire a spatial table that duplicates a canonical one, only if that is provably safe.
 *
 *   node scripts/retire-duplicate-table.js --table gweru_beyond_periurban_zones --canonical vungu_beyond_peri_urban_zones
 *   node scripts/retire-duplicate-table.js --table ... --canonical ... --apply
 *
 * Dry run unless --apply. It REFUSES, and says why, unless ALL of these hold:
 *   1. every feature of the table has a counterpart in the canonical table with the same shape
 *      (overlap >= 0.99); rows with no geometry are reported and need --ignore-null-geometry
 *   2. no QGIS project layer reads the table (the layer's data source, not its name)
 *   3. no foreign key, view or trigger-bearing dependent needs it (views, FKs)
 *   4. no code, config, SQL or test file mentions it, except files you name with --reviewed
 *      after reading them (documents are listed but do not block)
 *   5. a pg_dump of the table has been taken (backups/, outside version control)
 * On --apply it runs in one transaction: removes the table's rows from the layer registry and the
 * publication list, drops the table. The dump is how to bring it back.
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')
const { findReferences } = require('../src/services/spatialReferences')

const ROOT = path.join(__dirname, '..')
const KNOWN = new Set(['--table', '--canonical', '--apply', '--ignore-null-geometry', '--reviewed'])
const USAGE = 'Usage: --table <name> --canonical <name> [--ignore-null-geometry] [--reviewed file,file] [--apply]'
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1] }
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/

function pgDump() {
  for (const p of ['pg_dump', 'C:/Program Files/PostgreSQL/18/bin/pg_dump.exe', 'C:/Program Files/PostgreSQL/17/bin/pg_dump.exe', 'C:/Program Files/PostgreSQL/16/bin/pg_dump.exe']) {
    if (spawnSync(p, ['--version']).status === 0) return p
  }
  return null
}

async function main() {
  const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && !KNOWN.has(a))
  if (unknown.length) { console.error(`Unknown option(s): ${unknown.join(' ')}\n${USAGE}`); process.exit(2) }
  const table = arg('table'), canonical = arg('canonical')
  if (!table || !canonical || !IDENT.test(table) || !IDENT.test(canonical)) { console.error(USAGE); process.exit(2) }
  const apply = process.argv.includes('--apply')
  const reviewed = (arg('reviewed') || '').split(',').map((s) => s.trim()).filter(Boolean)

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const q = async (sql, p) => (await pool.query(sql, p)).rows
  const refusals = []
  const notes = []
  try {
    const geom = async (t) => (await q("SELECT f_geometry_column c FROM geometry_columns WHERE f_table_schema='public' AND f_table_name=$1 LIMIT 1", [t]))[0]?.c
    const gt = await geom(table), gc = await geom(canonical)
    if (!gt) throw new Error(`${table} does not exist or has no geometry`)
    if (!gc) throw new Error(`${canonical} does not exist or has no geometry`)

    // 1. Same features?
    const rows = (await q(`SELECT COUNT(*)::int n, COUNT(*) FILTER (WHERE "${gt}" IS NULL)::int nulls FROM public."${table}"`))[0]
    const sim = await q(`
      SELECT COALESCE((SELECT MAX(ST_Area(ST_Intersection(ST_MakeValid(a."${gt}"), ST_MakeValid(b."${gc}"))) /
                                  NULLIF(ST_Area(ST_Union(ST_MakeValid(a."${gt}"), ST_MakeValid(b."${gc}"))), 0))
                         FROM public."${canonical}" b WHERE b."${gc}" && a."${gt}" AND ST_Intersects(ST_MakeValid(a."${gt}"), ST_MakeValid(b."${gc}"))), 0) AS iou
        FROM public."${table}" a WHERE a."${gt}" IS NOT NULL`)
    const unmatched = sim.filter((r) => Number(r.iou) < 0.99).length
    notes.push(`${table}: ${rows.n} rows, ${rows.n - rows.nulls} with geometry; ${sim.length - unmatched} match a ${canonical} feature (overlap >= 0.99)`)
    if (unmatched) refusals.push(`${unmatched} feature(s) of ${table} have no matching feature in ${canonical}: they would be lost`)
    if (rows.nulls) {
      if (process.argv.includes('--ignore-null-geometry')) notes.push(`${rows.nulls} row(s) with no geometry will be lost (--ignore-null-geometry)`)
      else refusals.push(`${rows.nulls} row(s) of ${table} have no geometry: re-run with --ignore-null-geometry if they are junk`)
    }

    // 2 and 4. Who uses it?
    const refs = findReferences(table, {
      roots: [ROOT, path.join(ROOT, '..', 'app-frontend')],
      projectFile: path.join(ROOT, 'qgis-projects', path.basename(process.env.QGIS_PROJECT || 'vungu-project.qgs')),
      exclude: ['scripts/retire-duplicate-table.js', 'scripts/audit-spatial-duplicates.js', ...reviewed],
    })
    if (refs.projectLayers.length) refusals.push(`the QGIS project still has a layer that reads ${table}: ${refs.projectLayers.join(', ')}. Remove it in QGIS first`)
    if (refs.code.length) refusals.push(`${refs.code.length} code/config file(s) mention ${table}: ${refs.code.join(', ')} (read them; name the harmless ones with --reviewed)`)
    if (reviewed.length) notes.push(`reviewed by you and ignored: ${reviewed.join(', ')}`)
    if (refs.docs.length) notes.push(`${refs.docs.length} document(s) mention it (not blocking; update them): ${refs.docs.slice(0, 6).join(', ')}${refs.docs.length > 6 ? ', ...' : ''}`)

    // 3. Dependents in the database.
    const views = (await q(`SELECT DISTINCT d.relname FROM pg_depend dep JOIN pg_rewrite r ON r.oid = dep.objid JOIN pg_class d ON d.oid = r.ev_class WHERE dep.refobjid = $1::regclass AND d.relname <> $2`, [`public.${table}`, table])).map((r) => r.relname)
    const fks = (await q("SELECT conrelid::regclass::text AS t FROM pg_constraint WHERE confrelid = $1::regclass", [`public.${table}`])).map((r) => r.t)
    if (views.length) refusals.push(`views depend on it: ${views.join(', ')}`)
    if (fks.length) refusals.push(`foreign keys point at it from: ${fks.join(', ')}`)

    notes.forEach((n) => console.log('  ' + n))
    if (refusals.length) {
      console.log(`\nREFUSED: ${table} is not safe to retire.`)
      refusals.forEach((r) => console.log('  - ' + r))
      process.exit(1)
    }
    console.log(`\n${table} is a verified duplicate of ${canonical} and nothing uses it.`)
    if (!apply) { console.log('Dry run: nothing changed. Add --apply to retire it (a dump is taken first).'); return }

    // 5. The way back.
    const dump = pgDump()
    if (!dump) throw new Error('pg_dump not found; refusing to drop without a dump')
    fs.mkdirSync(path.join(ROOT, 'backups'), { recursive: true })
    const file = path.join(ROOT, 'backups', `${table}-${new Date().toISOString().slice(0, 10)}.sql`)
    const d = spawnSync(dump, ['-t', `public.${table}`, '--no-owner', '-f', file, process.env.DATABASE_URL], { encoding: 'utf8' })
    if (d.status !== 0 || !fs.existsSync(file)) throw new Error('pg_dump failed: ' + (d.stderr || '').slice(0, 200))
    console.log(`Dump written: ${path.relative(ROOT, file)} (${fs.statSync(file).size} bytes)`)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const a = await client.query('DELETE FROM public.layer_publication WHERE table_name = $1', [table])
      const b = await client.query('DELETE FROM public.spatial_layers WHERE table_name = $1', [table]).catch(() => ({ rowCount: 0 }))
      await client.query(`DROP TABLE public."${table}"`)
      await client.query('COMMIT')
      console.log(`Retired ${table}: dropped, ${a.rowCount} publication row(s) and ${b.rowCount} registry row(s) removed.`)
      console.log(`To undo: psql -f ${path.relative(ROOT, file)}`)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
