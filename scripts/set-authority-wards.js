#!/usr/bin/env node
/**
 * Say which wards belong to an authority (admin.authority_ward, migration 163). An authority's area is the union of them.
 *
 *   node scripts/set-authority-wards.js --authority VUNGU --like 'ZW1704%' --basis interim --note "..."         dry run
 *   node scripts/set-authority-wards.js --authority VUNGU --wards ZW170401,ZW170402 --basis proclamation \
 *        --ref "SI 12 of 2026" --from 2026-01-01 --apply                                                         write
 *   node scripts/set-authority-wards.js --authority VUNGU --like 'ZW1704%' --end --apply                         end membership today
 *   node scripts/set-authority-wards.js --list [--authority VUNGU]                                               what exists
 *
 * Wards are chosen by code (--wards, comma separated) or by pattern (--like). --basis says where the membership comes from:
 * proclamation | delimitation | interim | proposed. Nobody draws a boundary here: a council's area is its wards.
 * A dry run (the default) shows what would change and the area it would give; --apply writes it in one transaction. A ward that
 * already belongs to another authority is refused, never moved: end that membership first.
 */
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

const KNOWN = new Set(['--authority', '--wards', '--like', '--basis', '--ref', '--note', '--from', '--end', '--apply', '--list'])
const USAGE = 'Usage: --authority <code> (--wards a,b | --like PATTERN) --basis <proclamation|delimitation|interim|proposed> [--ref text] [--note text] [--from YYYY-MM-DD] [--end] [--apply] | --list [--authority code]'
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) }
const BASES = ['proclamation', 'delimitation', 'interim', 'proposed']

async function main() {
  const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && !KNOWN.has(a))
  if (unknown.length) { console.error(`Unknown option(s): ${unknown.join(' ')}\n${USAGE}`); process.exit(2) }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const q = async (c, s, a) => (await c.query(s, a)).rows
  try {
    const code = arg('authority')
    if (process.argv.includes('--list')) {
      const rows = await q(pool, `SELECT a.code, aw.basis, count(*)::int AS wards, min(aw.valid_from)::text AS from_date, max(aw.instrument_ref) AS ref
                                    FROM admin.authority_ward aw JOIN local_authorities a ON a.id = aw.authority_id
                                   WHERE (aw.valid_to IS NULL OR aw.valid_to > CURRENT_DATE) AND ($1::text IS NULL OR a.code = $1)
                                   GROUP BY 1, 2 ORDER BY 1, 2`, [typeof code === 'string' ? code.toUpperCase() : null])
      console.log(rows.length ? rows.map((r) => `${r.code.padEnd(12)} ${String(r.wards).padStart(4)} wards  ${r.basis.padEnd(12)} since ${r.from_date}${r.ref ? '  (' + r.ref + ')' : ''}`).join('\n') : 'No ward memberships.')
      return
    }
    if (typeof code !== 'string') { console.error(USAGE); process.exit(2) }
    const end = process.argv.includes('--end'), apply = process.argv.includes('--apply')
    const basis = arg('basis')
    if (!end && !BASES.includes(basis)) { console.error(`--basis must be one of ${BASES.join(', ')}\n${USAGE}`); process.exit(2) }
    const from = typeof arg('from') === 'string' ? arg('from') : new Date().toISOString().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) { console.error('--from must be a date, YYYY-MM-DD'); process.exit(2) }

    const auth = (await q(pool, 'SELECT id, code, kind FROM local_authorities WHERE code = $1', [code.toUpperCase()]))[0]
    if (!auth) throw new Error(`No authority with the code ${code}.`)
    if (auth.kind === 'combination') throw new Error(`${auth.code} is a combination authority: it covers the wards of its members, so give them the wards.`)

    const list = typeof arg('wards') === 'string' ? arg('wards').split(',').map((s) => s.trim()).filter(Boolean) : null
    const like = typeof arg('like') === 'string' ? arg('like') : null
    if (!list && !like) { console.error('Choose the wards with --wards or --like.\n' + USAGE); process.exit(2) }
    const wards = list
      ? await q(pool, 'SELECT ward_code FROM admin.ward WHERE ward_code = ANY($1::text[]) AND valid_to IS NULL ORDER BY 1', [list])
      : await q(pool, 'SELECT ward_code FROM admin.ward WHERE ward_code LIKE $1 AND valid_to IS NULL ORDER BY 1', [like])
    if (list) {
      const found = new Set(wards.map((w) => w.ward_code))
      const missing = list.filter((w) => !found.has(w))
      if (missing.length) throw new Error(`No such ward: ${missing.join(', ')}.`)
    }
    if (!wards.length) throw new Error('No ward matches.')
    const codes = wards.map((w) => w.ward_code)

    const current = await q(pool, `SELECT ward_code, authority_id FROM admin.authority_ward WHERE ward_code = ANY($1::text[]) AND valid_from <= CURRENT_DATE AND (valid_to IS NULL OR valid_to > CURRENT_DATE)`, [codes])
    const mine = new Set(current.filter((c) => c.authority_id === auth.id).map((c) => c.ward_code))
    const others = current.filter((c) => c.authority_id !== auth.id)

    if (end) {
      console.log(`${auth.code}: ${mine.size} of ${codes.length} wards are current and would end today.`)
      if (apply && mine.size) {
        await pool.query(`UPDATE admin.authority_ward SET valid_to = CURRENT_DATE WHERE authority_id = $1 AND ward_code = ANY($2::text[]) AND valid_from < CURRENT_DATE AND (valid_to IS NULL OR valid_to > CURRENT_DATE)`, [auth.id, [...mine]])
        console.log('  ended.')
      } else if (!apply) console.log('  (dry run: nothing written; add --apply)')
      return
    }
    if (others.length) throw new Error(`${others.length} ward(s) already belong to another authority (${[...new Set(others.map((o) => o.ward_code))].slice(0, 5).join(', ')}...). End that membership first.`)
    const todo = codes.filter((c) => !mine.has(c))
    console.log(`${auth.code}: ${codes.length} ward(s) chosen, ${mine.size} already members, ${todo.length} to add (${basis}, from ${from}).`)
    if (!todo.length) return
    const area = (await q(pool, `SELECT round((st_area(st_union(geom)::geography) / 1e6)::numeric) AS km2 FROM admin.ward WHERE ward_code = ANY($1::text[])`, [codes]))[0].km2
    console.log(`  these wards cover about ${area} km2.`)
    if (!apply) { console.log('  (dry run: nothing written; add --apply)'); return }
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`INSERT INTO admin.authority_ward (authority_id, ward_code, valid_from, basis, instrument_ref, note)
                     SELECT $1, w, $3::date, $4, $5, $6 FROM unnest($2::text[]) AS w`,
        [auth.id, todo, from, basis, typeof arg('ref') === 'string' ? arg('ref') : null, typeof arg('note') === 'string' ? arg('note') : null])
      await c.query('COMMIT')
      const a = (await q(pool, 'SELECT wards, basis, provisional FROM admin.authority_area WHERE authority_id = $1', [auth.id]))[0]
      console.log(`  written. ${auth.code}'s area is now ${a.wards} wards (${a.basis}${a.provisional ? ', provisional' : ''}).`)
    } catch (err) { await c.query('ROLLBACK').catch(() => {}); throw err } finally { c.release() }
  } finally {
    await pool.end()
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
