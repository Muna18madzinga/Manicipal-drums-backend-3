/**
 * Zoning matrix import — pure logic (no database, no I/O).
 *
 * A planner fills in one row per (zone type, land-use group):
 *
 *   zone,group_code,control_type,conditions,notes,authority
 *   Light Industry,I1,special_consent,"Buffer from residential required",,
 *
 * `zone` is the zone *type* as it is named on the map (proposed_peri_urban_zones.zone).
 * The matrix is stored per zone polygon, so each row is expanded to every polygon
 * of that name. A blank control_type means "not decided yet": the row is skipped
 * and reported, never loaded as a guess.
 *
 * planImport() checks everything and says what loading would do (insert / update /
 * unchanged); the caller decides whether to write it.
 */

const CONTROL_TYPES = ['permitted', 'special_consent', 'prohibited']
// Short codes used by the legacy API and the planner screen are accepted too.
const ALIASES = { p: 'permitted', sc: 'special_consent', x: 'prohibited' }

/** Parse CSV text (RFC 4180: quoted fields, doubled quotes, CRLF or LF) into row objects. */
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const src = String(text).replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((v) => v !== '')) rows.push(row)
      row = []
    } else field += c
  }
  row.push(field)
  if (row.some((v) => v !== '')) rows.push(row)
  if (!rows.length) return []
  const header = rows[0].map((h) => h.trim().toLowerCase())
  return rows.slice(1).map((r, i) => {
    const obj = { _line: i + 2 }
    header.forEach((h, j) => { obj[h] = (r[j] ?? '').trim() })
    return obj
  })
}

/** 'permitted' | 'special_consent' | 'prohibited', null if blank, undefined if not recognised. */
function normaliseControl(value) {
  const v = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (!v) return null
  if (CONTROL_TYPES.includes(v)) return v
  return ALIASES[v]
}

const same = (a, b) => (a ?? '') === (b ?? '')

/**
 * @param {object} input
 * @param {object[]} input.rows      parseCsv() output
 * @param {{id:number, zone:string}[]} input.zones     every zone polygon
 * @param {{id:string, group_code:string, is_active:boolean}[]} input.groups
 * @param {object[]} input.existing  live zone_land_use_controls rows
 * @param {string} [input.defaultAuthority]
 */
function planImport({ rows, zones, groups, existing, defaultAuthority = 'Vungu RDC' }) {
  const errors = []
  const cells = []
  let undecided = 0

  const zoneIds = new Map() // lower-case zone name -> { name, ids[] }
  for (const z of zones) {
    const key = String(z.zone).trim().toLowerCase()
    if (!zoneIds.has(key)) zoneIds.set(key, { name: z.zone, ids: [] })
    zoneIds.get(key).ids.push(z.id)
  }
  const groupByCode = new Map(groups.filter((g) => g.is_active).map((g) => [g.group_code.toLowerCase(), g]))
  const live = new Map(existing.filter((e) => !e.deleted_at).map((e) => [`${e.zone_id}|${e.land_use_group_id}`, e]))

  const seen = new Set()
  for (const r of rows) {
    const at = `line ${r._line}`
    const zoneKey = (r.zone || '').toLowerCase()
    const zone = zoneIds.get(zoneKey)
    const group = groupByCode.get((r.group_code || '').toLowerCase())
    const control = normaliseControl(r.control_type)

    if (!r.zone) { errors.push(`${at}: zone is required`); continue }
    if (!zone) {
      const hint = [...zoneIds.values()].map((z) => z.name).filter((n) => n.toLowerCase().includes(zoneKey.slice(0, 5)) || zoneKey.includes(n.toLowerCase().slice(0, 5)))
      errors.push(`${at}: unknown zone "${r.zone}"${hint.length ? ` (did you mean: ${hint.join('; ')}?)` : ''}`)
      continue
    }
    if (!r.group_code) { errors.push(`${at}: group_code is required`); continue }
    if (!group) { errors.push(`${at}: unknown or inactive land-use group "${r.group_code}" — add the group before loading rules for it`); continue }
    if (control === undefined) { errors.push(`${at}: control_type "${r.control_type}" must be permitted, special_consent or prohibited`); continue }

    const dup = `${zoneKey}|${group.group_code.toLowerCase()}`
    if (seen.has(dup)) { errors.push(`${at}: duplicate row for ${zone.name} × ${group.group_code}`); continue }
    seen.add(dup)

    if (control === null) { undecided++; continue }

    for (const zoneId of zone.ids) {
      const wanted = {
        zone_id: zoneId,
        land_use_group_id: group.id,
        control_type: control,
        conditions: r.conditions || null,
        notes: r.notes || null,
        authority: r.authority || defaultAuthority,
      }
      const current = live.get(`${zoneId}|${group.id}`)
      let action = 'insert'
      if (current) {
        action = same(current.control_type, wanted.control_type) && same(current.conditions, wanted.conditions)
          && same(current.notes, wanted.notes) && same(current.authority, wanted.authority) ? 'unchanged' : 'update'
      }
      cells.push({ ...wanted, action, zone: zone.name, group_code: group.group_code })
    }
  }

  // Coverage: which active groups each zone type still has no decision for.
  const decided = new Map()
  for (const c of cells) {
    if (!decided.has(c.zone)) decided.set(c.zone, new Set())
    decided.get(c.zone).add(c.group_code)
  }
  const allCodes = [...groupByCode.values()].map((g) => g.group_code)
  const coverage = [...zoneIds.values()].map((z) => {
    const have = decided.get(z.name) || new Set()
    return { zone: z.name, polygons: z.ids.length, decided: have.size, missing: allCodes.filter((c) => !have.has(c)) }
  })

  const count = (a) => cells.filter((c) => c.action === a).length
  return {
    cells,
    errors,
    undecided,
    coverage,
    summary: {
      rows: rows.length,
      cells: cells.length,
      inserts: count('insert'),
      updates: count('update'),
      unchanged: count('unchanged'),
      undecided,
      errors: errors.length,
    },
  }
}

/** A blank CSV for the planners: every zone type × every active group, decisions empty. */
function buildTemplate({ zones, groups }) {
  const names = [...new Set(zones.map((z) => z.zone))].sort((a, b) => a.localeCompare(b))
  const active = groups.filter((g) => g.is_active).sort((a, b) => a.group_code.localeCompare(b.group_code))
  const q = (v) => (/[",\n\r]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v)
  const lines = ['zone,group_code,group_description,control_type,conditions,notes,authority']
  for (const zone of names) {
    for (const g of active) lines.push([q(zone), q(g.group_code), q(g.description || ''), '', '', '', ''].join(','))
  }
  return lines.join('\n') + '\n'
}

module.exports = { CONTROL_TYPES, parseCsv, normaliseControl, planImport, buildTemplate }
