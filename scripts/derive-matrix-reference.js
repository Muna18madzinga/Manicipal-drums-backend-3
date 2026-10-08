#!/usr/bin/env node
/**
 * Derive the reference data behind a development control matrix from a filled draft.
 *
 *   node scripts/derive-matrix-reference.js [--file docs/local-plan-matrix-template.csv] [--out docs/derived]
 *
 * Reads the draft (zone, group_code, group_description, control_type ...) and what the codebase already
 * holds (the 32 land-use groups with their category and HILUCS crosswalk, the starter palettes), and writes:
 *
 *   zones.csv                 every zone in the draft, with its profile, its nearest starter-palette zone, its
 *                             HILUCS class and what the audit found about its column
 *   land_use_groups.csv       every use group with its parent, category and HILUCS class
 *   development_activities.csv the kinds of development a permit can be for, and what each one tests
 *   matrix_flags.csv          cell and column findings to settle with the planners before the draft is trusted
 *
 * Reads the database; writes only the files above. Nothing is loaded into any plan.
 */
const fs = require('node:fs')
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1] }
const FILE = arg('file', path.join(__dirname, '..', 'docs', 'local-plan-matrix-template.csv'))
const OUT = arg('out', path.join(__dirname, '..', 'docs', 'derived'))

const csv = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => {
  const v = r[c] == null ? '' : String(r[c])
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}).join(','))].join('\n') + '\n'

function readDraft(file) {
  const lines = fs.readFileSync(file, 'utf8').replace(/\r/g, '').split('\n').filter(Boolean)
  const head = lines.shift().split(',')
  return lines.map((l) => { const c = l.split(','); const r = {}; head.forEach((h, i) => { r[h] = c[i] }); return r })
}

// The draft names 11 urban and 11 rural zones; which profile a zone belongs to follows from its position and
// name, and the proposed starter-palette zone is the closest named zone we already hold. Both are proposals.
const ZONE_MAP = {
  'Cemetery': ['urban', 'Open Space and Recreation', 'cemetery is a special use; may need its own zone type'],
  'Densification Zone [LDR]': ['urban', 'Low-Density Residential', 'a policy overlay on LDR land rather than a use zone: model as an overlay or a flag'],
  'Economic Corridor [Mixed Business]': ['urban', 'Town Centre / Mixed Use', ''],
  'High Density Residential': ['urban', 'High-Density Residential', ''],
  'Institutional': ['urban', 'Institutional and Community', ''],
  'Light Industry': ['urban', 'Light Industrial', ''],
  'Low Density Residential': ['urban', 'Low-Density Residential', ''],
  'Medium Density Residential': ['urban', 'Medium-Density Residential', ''],
  'Mixed Density Residential': ['urban', 'Medium-Density Residential', 'mixed density: confirm whether it is a distinct zone or a range'],
  'Railways Common User Facilities': ['urban', 'Transport and Utilities', ''],
  'Residential Agricultural Plots': ['urban', 'Urban Agriculture / Peri-urban Fringe', ''],
  'Communal Farming Zone': ['rural', 'Communal Agriculture', ''],
  'High Intensive Commercial Farming Zone': ['rural', 'Commercial Agriculture', ''],
  'Estates Zone (Large Farms)': ['rural', 'Commercial Agriculture', 'large-farm estates: distinct from intensive farming only by scale'],
  'Irrigation Scheme Zone': ['rural', 'Irrigation Scheme', ''],
  'Smallholder Estates Zone': ['rural', 'Smallholder and Resettlement Agriculture', ''],
  'Forestry / Conservation Zone': ['rural', 'Forestry', 'two intents in one zone: forestry and conservation'],
  'Game Park Zone': ['rural', 'Wildlife and Tourism', ''],
  'Game Corridor Zone': ['rural', 'Conservation and Protected Area', ''],
  'Urban Expansion Zone': ['rural', 'Future Urban / Development Reserve', ''],
  'Industrial Zone': ['rural', 'Rural Industry and Agro-processing', ''],
  'Commercial Zone': ['rural', 'Rural Commercial', ''],
}

// Use-group lettering follows the council's schedule. A code with a digit is a sub-class of the letter before it.
const parentOf = (code) => (/^[A-Z]\d+$/.test(code) && code !== 'L1' ? code[0] : null)

const ACTIVITIES = [
  ['new_building', 'New building', 'use', true, 'coverage,height,setback,parking', 'The use being built is looked up in the matrix for the parcel\'s zone; building standards then apply.'],
  ['extension', 'Extension', 'standards', false, 'coverage,height,setback', 'The use is unchanged, so the matrix is not consulted; the extended building must still meet the zone\'s standards.'],
  ['alteration', 'Alteration', 'standards', false, 'height,setback', 'As for an extension; the matrix applies only if the alteration changes the use.'],
  ['change_of_use', 'Change of use', 'use', true, 'parking', 'From the existing use group (spatial_planning.existing_use) to the proposed one; the matrix decides whether the proposed use is permitted, by special consent, or prohibited.'],
  ['subdivision', 'Subdivision', 'parcel', true, 'min_stand_area,frontage', 'Tests the resulting parcels against the zone\'s minimum stand size, and the intended use against the matrix.'],
  ['consolidation', 'Consolidation', 'parcel', false, 'max_stand_area', 'Merges parcels; tests the combined parcel against the zone\'s standards.'],
  ['rezoning', 'Rezoning', 'zone', false, '', 'Asks to change the zone itself, so the matrix for the current zone does not decide it; follows the plan-amendment route.'],
  ['other', 'Other', 'manual', false, '', 'Assessed by an officer; no automatic test.'],
]

async function main() {
  const rows = readDraft(FILE)
  const zones = [...new Set(rows.map((r) => r.zone))]
  const cell = new Map(rows.map((r) => [`${r.zone}|${r.group_code}`, r.control_type || '']))
  const codes = []; const desc = {}
  rows.forEach((r) => { if (!codes.includes(r.group_code)) { codes.push(r.group_code); desc[r.group_code] = r.group_description } })
  const col = (z) => codes.map((c) => cell.get(`${z}|${c}`) || '-')

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const q = async (s, a) => (await pool.query(s, a)).rows
  const plan = (await q("SELECT id FROM plan_instrument WHERE title LIKE 'Vungu RDC peri-urban%' ORDER BY created_at LIMIT 1"))[0]
  const luDb = Object.fromEntries((await q(
    `SELECT g.group_code, g.group_category, g.use_scale,
            (SELECT string_agg(c.code || ':' || c.relation, ' ' ORDER BY c.code) FROM land_use_group_class c WHERE c.land_use_group_id = g.id) AS hilucs
       FROM land_use_groups g WHERE g.plan_instrument_id = $1`, [plan.id])).map((r) => [r.group_code, r]))
  const palette = Object.fromEntries((await q(
    `SELECT z.code, z.category,
            (SELECT string_agg(c.code || ':' || c.relation, ' ' ORDER BY c.code) FROM plan_zone_type_class c WHERE c.plan_zone_type_id = z.id) AS hilucs
       FROM plan_zone_type z JOIN plan_instrument i ON i.id = z.plan_instrument_id WHERE i.title LIKE '%starter palette%'`)).map((r) => [r.code, r]))
  await pool.end()

  // ---- audit of the columns and cells ----
  const flags = []
  const flag = (severity, zone, group, kind, detail) => flags.push({ severity, zone, group_code: group || '', kind, detail })
  const dwellings = ['A', 'A1', 'A2', 'A3']
  const urban = zones.filter((z) => ZONE_MAP[z] && ZONE_MAP[z][0] === 'urban')
  const copyOf = {}
  zones.forEach((z) => {
    if (ZONE_MAP[z]?.[0] !== 'rural') return
    const differ = (u) => col(u).filter((v, i) => v !== col(z)[i]).length
    const hit = urban.find((u) => differ(u) === 0) || urban.find((u) => differ(u) <= 1)
    if (hit) copyOf[z] = hit
  })

  zones.forEach((z) => {
    const profile = ZONE_MAP[z]?.[0] || 'unknown'
    const pal = ZONE_MAP[z]?.[1]
    const ct = palette[pal]?.category
    const permitted = codes.filter((c) => cell.get(`${z}|${c}`) === 'P').length
    if (!ZONE_MAP[z]) flag('review', z, '', 'unmapped_zone', 'this zone has no proposed starter-palette zone')
    if (copyOf[z]) flag('error', z, '', 'column_copied', `this zone's whole column equals the urban zone "${copyOf[z]}" (within one cell): the rural block looks like the urban block relabelled`)
    if (permitted >= 28) flag('warning', z, '', 'default_fill', `permits ${permitted} of ${codes.length} uses: looks like a default fill, not a considered column`)
    if (ct === 'residential') {
      const ok = dwellings.filter((c) => ['P', 'SC'].includes(cell.get(`${z}|${c}`)))
      if (!dwellings.some((c) => cell.get(`${z}|${c}`) === 'P')) flag('error', z, '', 'residential_zone_without_dwellings',
        `a ${ct} zone that does not permit any dwelling group outright (${dwellings.map((c) => c + '=' + (cell.get(`${z}|${c}`) || '-')).join(' ')}): the column may be shifted or mislabelled`)
      else if (ok.length === 0) flag('error', z, '', 'residential_zone_without_dwellings', 'no dwelling group is allowed at all')
    }
  })
  rows.forEach((r) => {
    if (!r.control_type) flag('warning', r.zone, r.group_code, 'blank_cell', `${r.group_description}: no decision recorded`)
  })
  const rank = { P: 0, SC: 1, X: 2 }
  zones.forEach((z) => codes.forEach((c) => {
    const par = parentOf(c); if (!par) return
    const a = cell.get(`${z}|${c}`), b = cell.get(`${z}|${par}`)
    if (a in rank && b in rank && rank[a] < rank[b] - 1) flag('review', z, c, 'sub_class_more_permissive_than_class', `${c} (${desc[c]}) is ${a} but its class ${par} is ${b}`)
  }))
  const missingLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((l) => !codes.some((c) => c === l || c.startsWith(l)))
  flag('review', '', '', 'lettering_gaps', `the use groups skip letters ${missingLetters.join(', ')} (and have L1 without L): check the council's schedule of use classes for groups the draft omits`)
  const conds = rows.filter((r) => r.conditions || r.notes).length
  flag('review', '', '', 'no_conditions', `${conds} of ${rows.length} cells carry a condition or note: a special-consent decision with no stated condition cannot be assessed`)

  // ---- outputs ----
  fs.mkdirSync(OUT, { recursive: true })
  const zoneRows = zones.map((z) => {
    const [profile, pal, note] = ZONE_MAP[z] || ['unknown', '', '']
    const nz = flags.filter((f) => f.zone === z && f.severity !== 'review').map((f) => f.kind).join(' ')
    return {
      name: z, profile, proposed_palette_zone: pal, category: palette[pal]?.category || '', hilucs_proposed: palette[pal]?.hilucs || '',
      permitted: codes.filter((c) => cell.get(`${z}|${c}`) === 'P').length,
      special_consent: codes.filter((c) => cell.get(`${z}|${c}`) === 'SC').length,
      prohibited: codes.filter((c) => cell.get(`${z}|${c}`) === 'X').length,
      blank: codes.filter((c) => !cell.get(`${z}|${c}`)).length,
      audit: nz, note,
    }
  })
  fs.writeFileSync(path.join(OUT, 'zones.csv'), csv(zoneRows, ['name', 'profile', 'proposed_palette_zone', 'category', 'hilucs_proposed', 'permitted', 'special_consent', 'prohibited', 'blank', 'audit', 'note']))
  const luRows = codes.map((c) => ({
    code: c, description: desc[c], parent_code: parentOf(c) || '', category: luDb[c]?.group_category || '', use_scale: luDb[c]?.use_scale || '', hilucs: luDb[c]?.hilucs || '',
  }))
  fs.writeFileSync(path.join(OUT, 'land_use_groups.csv'), csv(luRows, ['code', 'description', 'parent_code', 'category', 'use_scale', 'hilucs']))
  fs.writeFileSync(path.join(OUT, 'development_activities.csv'), csv(ACTIVITIES.map(([code, name, tests, matrix, standards, how]) => ({ code, name, tests, matrix_lookup: matrix, standards_kinds: standards, how_it_is_assessed: how })),
    ['code', 'name', 'tests', 'matrix_lookup', 'standards_kinds', 'how_it_is_assessed']))
  fs.writeFileSync(path.join(OUT, 'matrix_flags.csv'), csv(flags, ['severity', 'zone', 'group_code', 'kind', 'detail']))

  const by = flags.reduce((a, f) => { a[f.kind] = (a[f.kind] || 0) + 1; return a }, {})
  console.log(`${zones.length} zones, ${codes.length} use groups, ${rows.length} cells`)
  console.log('findings:', JSON.stringify(by))
  console.log(`written to ${OUT}`)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
