#!/usr/bin/env node
/**
 * Build the farm match table: for every farm in the working register (gweru_rural_farms), its best
 * counterpart in the canonical candidate (vungu_parcels) and in the cadastre (vungu_farm_cadastre),
 * with a status a person can review.
 *
 *   node scripts/build-farm-match.js              refresh public.farm_match and print a summary
 *   node scripts/build-farm-match.js --csv FILE   also write the review sheet (default docs/farm-match-review.csv)
 *
 * NOTHING IS MERGED OR DELETED. The three farm datasets come from one cadastre extract in different
 * vintages; this only measures how they line up, so the 262 farms that carry a zone assignment
 * (zone_id) are not lost by a consolidation. A refresh recomputes the measurements and KEEPS any
 * decision a reviewer has recorded (decision, decided_by, decided_at).
 *
 * ZONE ASSIGNMENTS. gweru_rural_farms.zone_id was assigned against the ids of the OLD gweru_peri_urban_zone table
 * (ids up to 43); the canonical table (proposed_peri_urban_zones) has different ids (1-36), so read as they stand
 * almost every assignment points at the wrong zone. For each assigned farm this works out what it meant (old id ->
 * old zone -> the canonical zone with the same shape) and whether that agrees with the zone the farm
 * actually lies in (largest overlap): zone_check = agrees | differs | cannot_remap | no_assignment.
 *
 * Overlap is intersection-over-union of the two shapes (1.0 = the same shape). Status:
 *   exact       one parcel overlaps >= 0.99, no other comes close, no other farm claims it, and the names agree
 *   probable    one parcel overlaps >= 0.99 but the names differ or are missing; or overlaps 0.8-0.99 with the same name
 *   ambiguous   several parcels overlap >= 0.8, or another farm's best match is the same parcel
 *   weak        the best parcel overlaps only 0.5-0.8
 *   unmatched   no parcel overlaps >= 0.5
 *   no_geometry the farm has no shape
 */
const fs = require('node:fs')
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

const KNOWN = new Set(['--csv'])
const csvArg = (() => { const i = process.argv.indexOf('--csv'); return i === -1 ? null : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : path.join(__dirname, '..', 'docs', 'farm-match-review.csv')) })()
const same = (a, b) => a != null && b != null && String(a).trim().toLowerCase() === String(b).trim().toLowerCase()

const DDL = `
CREATE TABLE IF NOT EXISTS public.farm_match (
  farm_id          integer PRIMARY KEY,
  farm_name        text,
  zone_id          integer,
  farm_geometry    text NOT NULL,
  parcel_fid       integer,
  parcel_name      text,
  parcel_overlap   numeric,
  parcel_name_match boolean,
  parcels_close    integer,
  cadastre_fid     integer,
  cadastre_name    text,
  cadastre_overlap numeric,
  cadastre_name_match boolean,
  status           text NOT NULL CHECK (status IN ('exact','probable','ambiguous','weak','unmatched','no_geometry')),
  reason           text,
  zone_old_name    text,
  zone_remapped_id integer,
  zone_derived_id  integer,
  zone_derived_name text,
  zone_check       text,
  decision         text,
  decided_by       text,
  decided_at       timestamptz,
  computed_at      timestamptz NOT NULL DEFAULT now()
)`

// Best overlap of each farm with each candidate table, and how many candidates come close.
const MATCH_SQL = (cand, key) => `
  WITH pairs AS (
    SELECT f.id AS farm_id, c.${key} AS cand_id, c.name AS cand_name,
           ST_Area(ST_Intersection(ST_MakeValid(f.geom), ST_MakeValid(c.geom))) /
             NULLIF(ST_Area(ST_Union(ST_MakeValid(f.geom), ST_MakeValid(c.geom))), 0) AS iou
      FROM public.gweru_rural_farms f
      JOIN public.${cand} c ON c.geom && f.geom AND ST_Intersects(ST_MakeValid(f.geom), ST_MakeValid(c.geom))
     WHERE f.geom IS NOT NULL AND c.geom IS NOT NULL),
  ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY farm_id ORDER BY iou DESC NULLS LAST) AS rn,
              COUNT(*) FILTER (WHERE iou >= 0.8) OVER (PARTITION BY farm_id) AS close
      FROM pairs)
  SELECT farm_id, cand_id, cand_name, iou::float8 AS iou, close::int AS close FROM ranked WHERE rn = 1`

async function main() {
  const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && !KNOWN.has(a))
  if (unknown.length) { console.error(`Unknown option(s): ${unknown.join(' ')}\nUsage: [--csv FILE]`); process.exit(2) }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const q = async (sql, p) => (await pool.query(sql, p)).rows
  try {
    const farms = await q(`SELECT id, name, zone_id, geom IS NULL AS no_geom, (geom IS NOT NULL AND NOT ST_IsValid(geom)) AS invalid FROM public.gweru_rural_farms ORDER BY id`)
    // What each assignment meant, and where the farm actually lies.
    const zoneInfo = new Map((await q(`
      WITH old_to_canonical AS (
        SELECT g.id AS old_id, g.zone AS old_name,
               (SELECT z.id FROM public.proposed_peri_urban_zones z
                 WHERE g.geom IS NOT NULL AND z.geom && g.geom AND ST_Intersects(ST_MakeValid(g.geom), ST_MakeValid(z.geom))
                   AND ST_Area(ST_Intersection(ST_MakeValid(g.geom), ST_MakeValid(z.geom))) /
                       NULLIF(ST_Area(ST_Union(ST_MakeValid(g.geom), ST_MakeValid(z.geom))), 0) >= 0.99
                 ORDER BY z.id LIMIT 1) AS canonical_id
          FROM public.gweru_peri_urban_zone g)
      SELECT f.id AS farm_id, o.old_name, o.canonical_id AS remapped_id,
             d.id AS derived_id, d.zone AS derived_name
        FROM public.gweru_rural_farms f
        LEFT JOIN old_to_canonical o ON o.old_id = f.zone_id
        LEFT JOIN LATERAL (
          SELECT z.id, z.zone FROM public.proposed_peri_urban_zones z
           WHERE f.geom IS NOT NULL AND z.geom && f.geom AND ST_Intersects(ST_MakeValid(z.geom), ST_MakeValid(f.geom))
           ORDER BY ST_Area(ST_Intersection(ST_MakeValid(z.geom), ST_MakeValid(f.geom))) DESC LIMIT 1) d ON TRUE`)).map((r) => [r.farm_id, r]))
    const parcels = new Map((await q(MATCH_SQL('vungu_parcels', 'fid'))).map((r) => [r.farm_id, r]))
    const cadastre = new Map((await q(MATCH_SQL('vungu_farm_cadastre', 'fid'))).map((r) => [r.farm_id, r]))

    // A parcel that is the best match of more than one farm is claimed twice.
    const claims = new Map()
    for (const m of parcels.values()) if (m.iou >= 0.5) claims.set(m.cand_id, (claims.get(m.cand_id) || 0) + 1)

    const rows = farms.map((f) => {
      const p = parcels.get(f.id), c = cadastre.get(f.id)
      let status, reason
      if (f.no_geom) { status = 'no_geometry'; reason = 'the farm has no shape' }
      else if (!p || p.iou < 0.5) { status = 'unmatched'; reason = 'no parcel overlaps it by half' }
      else if (p.close > 1) { status = 'ambiguous'; reason = `${p.close} parcels overlap it by 0.8 or more` }
      else if ((claims.get(p.cand_id) || 0) > 1) { status = 'ambiguous'; reason = `parcel ${p.cand_id} is also the best match of ${claims.get(p.cand_id) - 1} other farm(s)` }
      else if (p.iou >= 0.99) {
        const nm = same(f.name, p.cand_name) || (f.name == null && p.cand_name == null)
        status = nm ? 'exact' : 'probable'
        reason = nm ? 'same shape and name' : 'same shape; the names differ or are missing'
      } else if (p.iou >= 0.8 && same(f.name, p.cand_name)) { status = 'probable'; reason = 'similar shape and the same name' }
      else if (p.iou >= 0.8) { status = 'weak'; reason = 'similar shape but the names differ or are missing' }
      else { status = 'weak'; reason = `the best parcel overlaps only ${p.iou.toFixed(2)}` }
      return {
        farm_id: f.id, farm_name: f.name, zone_id: f.zone_id,
        farm_geometry: f.no_geom ? 'missing' : f.invalid ? 'invalid' : 'ok',
        parcel_fid: p?.cand_id ?? null, parcel_name: p?.cand_name ?? null, parcel_overlap: p ? Number(p.iou.toFixed(4)) : null,
        parcel_name_match: p ? same(f.name, p.cand_name) : null, parcels_close: p?.close ?? 0,
        cadastre_fid: c?.cand_id ?? null, cadastre_name: c?.cand_name ?? null, cadastre_overlap: c ? Number(c.iou.toFixed(4)) : null,
        cadastre_name_match: c ? same(f.name, c.cand_name) : null,
        status, reason,
        ...(() => {
          const z = zoneInfo.get(f.id) || {}
          const check = f.zone_id == null ? 'no_assignment'
            : z.remapped_id == null ? 'cannot_remap'
            : z.derived_id == null ? 'differs'
            : z.remapped_id === z.derived_id ? 'agrees' : 'differs'
          return { zone_old_name: f.zone_id == null ? null : z.old_name ?? null, zone_remapped_id: z.remapped_id ?? null, zone_derived_id: z.derived_id ?? null, zone_derived_name: z.derived_name ?? null, zone_check: check }
        })(),
      }
    })

    await pool.query(DDL)
    for (const c of ['zone_old_name text', 'zone_remapped_id integer', 'zone_derived_id integer', 'zone_derived_name text', 'zone_check text']) {
      await pool.query(`ALTER TABLE public.farm_match ADD COLUMN IF NOT EXISTS ${c}`)
    }
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      for (const r of rows) {
        await client.query(
          `INSERT INTO public.farm_match (farm_id, farm_name, zone_id, farm_geometry, parcel_fid, parcel_name, parcel_overlap, parcel_name_match, parcels_close,
                                          cadastre_fid, cadastre_name, cadastre_overlap, cadastre_name_match, status, reason,
                                          zone_old_name, zone_remapped_id, zone_derived_id, zone_derived_name, zone_check)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
           ON CONFLICT (farm_id) DO UPDATE SET
             farm_name = EXCLUDED.farm_name, zone_id = EXCLUDED.zone_id, farm_geometry = EXCLUDED.farm_geometry,
             parcel_fid = EXCLUDED.parcel_fid, parcel_name = EXCLUDED.parcel_name, parcel_overlap = EXCLUDED.parcel_overlap,
             parcel_name_match = EXCLUDED.parcel_name_match, parcels_close = EXCLUDED.parcels_close,
             cadastre_fid = EXCLUDED.cadastre_fid, cadastre_name = EXCLUDED.cadastre_name, cadastre_overlap = EXCLUDED.cadastre_overlap,
             cadastre_name_match = EXCLUDED.cadastre_name_match, status = EXCLUDED.status, reason = EXCLUDED.reason,
             zone_old_name = EXCLUDED.zone_old_name, zone_remapped_id = EXCLUDED.zone_remapped_id, zone_derived_id = EXCLUDED.zone_derived_id,
             zone_derived_name = EXCLUDED.zone_derived_name, zone_check = EXCLUDED.zone_check, computed_at = now()`,
          [r.farm_id, r.farm_name, r.zone_id, r.farm_geometry, r.parcel_fid, r.parcel_name, r.parcel_overlap, r.parcel_name_match, r.parcels_close,
            r.cadastre_fid, r.cadastre_name, r.cadastre_overlap, r.cadastre_name_match, r.status, r.reason,
            r.zone_old_name, r.zone_remapped_id, r.zone_derived_id, r.zone_derived_name, r.zone_check])
      }
      // A farm that is no longer in the register has nothing left to match.
      await client.query('DELETE FROM public.farm_match WHERE farm_id <> ALL($1::int[])', [rows.map((r) => r.farm_id)])
      await client.query('COMMIT')
    } catch (err) { await client.query('ROLLBACK').catch(() => {}); throw err } finally { client.release() }

    const by = (pred) => rows.filter(pred).reduce((o, r) => { o[r.status] = (o[r.status] || 0) + 1; return o }, {})
    const order = ['exact', 'probable', 'ambiguous', 'weak', 'unmatched', 'no_geometry']
    const fmt = (o) => order.filter((s) => o[s]).map((s) => `${s} ${o[s]}`).join(', ') || '-'
    console.log(`${rows.length} farms in gweru_rural_farms, matched against vungu_parcels (${parcels.size} overlap something) and vungu_farm_cadastre`)
    console.log('all farms:                     ' + fmt(by(() => true)))
    console.log('farms with a zone assignment:  ' + fmt(by((r) => r.zone_id != null)) + `   (${rows.filter((r) => r.zone_id != null).length} in all)`)
    const safe = rows.filter((r) => r.zone_id != null && r.status === 'exact').length
    console.log(`farm-to-parcel matches that are exact, among the assigned farms: ${safe} of ${rows.filter((r) => r.zone_id != null).length}`)
    const zc = rows.filter((r) => r.zone_id != null).reduce((o, r) => { o[r.zone_check] = (o[r.zone_check] || 0) + 1; return o }, {})
    const asRead = rows.filter((r) => r.zone_id != null && r.zone_id === r.zone_derived_id).length
    console.log(`zone_id as it stands points at the zone the farm lies in for ${asRead} of ${rows.filter((r) => r.zone_id != null).length} assigned farms (the ids no longer line up)`)
    console.log('zone assignment once remapped from the old ids: ' + Object.entries(zc).map(([k, v]) => `${k} ${v}`).join(', '))
    const kept = (await q('SELECT COUNT(*)::int n FROM public.farm_match WHERE decision IS NOT NULL'))[0].n
    if (kept) console.log(`${kept} reviewer decision(s) kept`)

    if (csvArg) {
      const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
      const cols = ['status', 'reason', 'farm_id', 'farm_name', 'zone_id', 'farm_geometry', 'parcel_fid', 'parcel_name', 'parcel_overlap', 'parcels_close', 'cadastre_fid', 'cadastre_name', 'cadastre_overlap', 'zone_check', 'zone_old_name', 'zone_derived_name']
      const sorted = [...rows].sort((a, b) => order.indexOf(b.status) - order.indexOf(a.status) || (b.zone_id != null) - (a.zone_id != null) || a.farm_id - b.farm_id)
      fs.writeFileSync(csvArg, [...[cols.join(',')], ...sorted.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n')
      console.log(`Review sheet written: ${path.relative(path.join(__dirname, '..'), csvArg)} (worst cases first)`)
    }
  } finally {
    await pool.end()
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
