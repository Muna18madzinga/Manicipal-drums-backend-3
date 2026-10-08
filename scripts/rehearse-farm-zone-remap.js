#!/usr/bin/env node
/**
 * Rehearse migration 153 (farm zone remap) on the real data, then ROLL BACK. Changes nothing.
 *
 *   node scripts/rehearse-farm-zone-remap.js            run it, check it, undo it
 *   node scripts/rehearse-farm-zone-remap.js --csv      also write docs/farm-zone-remap-review.csv
 *
 * Inside one transaction it: applies the migration; checks every remapped farm now points at a zone
 * that exists and has the same shape as the old zone; applies it AGAIN and checks nothing moves;
 * runs the down script and checks every farm's original zone_id is back; and finally rolls the whole
 * transaction back. The review sheet lists what a person must look at: the farms whose assigned zone
 * differs from the zone they lie in, and the farms that could not be remapped.
 */
const fs = require('node:fs')
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

const ROOT = path.join(__dirname, '..')
const strip = (sql) => sql.replace(/^\s*BEGIN;\s*$/gm, '').replace(/^\s*COMMIT;\s*$/gm, '')
const UP = strip(fs.readFileSync(path.join(ROOT, 'migrations', '153_farm_zone_remap.sql'), 'utf8'))
const DOWN = strip(fs.readFileSync(path.join(ROOT, 'migrations', '153_farm_zone_remap.down.sql'), 'utf8'))
const writeCsv = process.argv.includes('--csv')

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()
  let failures = 0
  const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failures++ }
  const one = async (sql, p) => (await client.query(sql, p)).rows[0]
  try {
    await client.query('BEGIN')
    const before = (await client.query('SELECT id, zone_id FROM public.gweru_rural_farms WHERE zone_id IS NOT NULL ORDER BY id')).rows
    console.log(`Before: ${before.length} farms carry a zone_id.`)

    await client.query(UP)
    const s = await one(`SELECT COUNT(*) FILTER (WHERE zone_remap_status = 'remapped')::int ok,
                                COUNT(*) FILTER (WHERE zone_remap_status = 'remapped_differs_from_location')::int differs,
                                COUNT(*) FILTER (WHERE zone_remap_status = 'unmapped')::int unmapped,
                                COUNT(*)::int total
                           FROM public.gweru_rural_farms WHERE zone_remap_status IS NOT NULL`)
    console.log(`After:  ${s.total} farms touched: ${s.ok} remapped and agree with where they lie, ${s.differs} remapped but differ from where they lie, ${s.unmapped} unmapped (zone_id now NULL).`)

    check(s.total === before.length, 'every farm that had a zone_id is accounted for')
    check((await one(`SELECT COUNT(*)::int n FROM public.gweru_rural_farms f
                        WHERE f.zone_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.proposed_peri_urban_zones z WHERE z.id = f.zone_id)`)).n === 0,
      'no farm points at a zone id that does not exist')
    check((await one(`SELECT COUNT(*)::int n FROM public.farm_zone_remap r
                        JOIN public.gweru_peri_urban_zone o ON o.id = r.old_zone_id
                        JOIN public.proposed_peri_urban_zones z ON z.id = r.new_zone_id
                       WHERE ST_Area(ST_Intersection(ST_MakeValid(o.geom), ST_MakeValid(z.geom))) /
                             NULLIF(ST_Area(ST_Union(ST_MakeValid(o.geom), ST_MakeValid(z.geom))), 0) < 0.99`)).n === 0,
      'every remapped zone has the same shape as the old zone it replaces')
    check((await one(`SELECT COUNT(*)::int n FROM public.gweru_rural_farms f JOIN public.farm_zone_remap r ON r.farm_id = f.id
                        WHERE f.zone_id_legacy IS DISTINCT FROM r.old_zone_id`)).n === 0, 'every original value is kept in zone_id_legacy')
    check((await one(`SELECT COUNT(*)::int n FROM public.gweru_rural_farms f
                        WHERE f.zone_id IS NOT NULL AND f.zone_id IN (SELECT id FROM public.proposed_peri_urban_zones)
                          AND (SELECT zone FROM public.proposed_peri_urban_zones WHERE id = f.zone_id) IS DISTINCT FROM
                              (SELECT zone FROM public.gweru_peri_urban_zone WHERE id = f.zone_id_legacy)
                          AND (SELECT zone FROM public.gweru_peri_urban_zone WHERE id = f.zone_id_legacy) NOT IN ('Cemetry')`)).n === 0,
      'a remapped farm keeps its zone NAME (apart from the corrected spelling of Cemetery)')

    const snap = (await client.query('SELECT id, zone_id FROM public.gweru_rural_farms ORDER BY id')).rows
    await client.query(UP)
    const again = (await client.query('SELECT id, zone_id FROM public.gweru_rural_farms ORDER BY id')).rows
    check(JSON.stringify(snap) === JSON.stringify(again), 'applying it a second time changes nothing')

    if (writeCsv) {
      const rows = (await client.query(`SELECT r.farm_id, f.name AS farm_name, r.old_zone_id, r.old_zone_name, r.new_zone_id, r.new_zone_name,
                                               r.lies_in_zone_id, r.lies_in_zone_name, r.basis, r.agrees
                                          FROM public.farm_zone_remap r JOIN public.gweru_rural_farms f ON f.id = r.farm_id
                                         WHERE r.new_zone_id IS NULL OR r.agrees IS NOT TRUE
                                         ORDER BY (r.new_zone_id IS NULL) DESC, r.old_zone_name, r.farm_id`)).rows
      const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
      const cols = ['farm_id', 'farm_name', 'old_zone_id', 'old_zone_name', 'new_zone_id', 'new_zone_name', 'lies_in_zone_id', 'lies_in_zone_name', 'basis', 'agrees']
      const file = path.join(ROOT, 'docs', 'farm-zone-remap-review.csv')
      fs.writeFileSync(file, [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n')
      console.log(`Review sheet: ${path.relative(ROOT, file)} (${rows.length} farms for a person to look at)`)
    }

    await client.query(DOWN)
    const restored = (await client.query('SELECT id, zone_id FROM public.gweru_rural_farms WHERE zone_id IS NOT NULL ORDER BY id')).rows
    check(JSON.stringify(restored) === JSON.stringify(before), 'the down script puts every original zone_id back exactly')
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
    await pool.end()
  }
  const after = await new Pool({ connectionString: process.env.DATABASE_URL }).query("SELECT to_regclass('public.farm_zone_remap') t, (SELECT COUNT(*) FROM information_schema.columns WHERE table_name='gweru_rural_farms' AND column_name='zone_id_legacy')::int c").then((r) => r.rows[0])
  console.log(`Rolled back: farm_zone_remap exists = ${after.t !== null}, zone_id_legacy column present = ${after.c > 0} (both should be false/0).`)
  console.log(failures ? `${failures} check(s) FAILED` : 'ALL CHECKS PASSED (nothing was changed)')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
