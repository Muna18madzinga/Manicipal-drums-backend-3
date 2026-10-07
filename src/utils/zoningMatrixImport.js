/**
 * Zoning matrix import — pure logic (no database, no I/O).
 *
 * A planner fills in one row per (zone, land use):
 *
 *   zone,group_code,control_type,conditions,notes,authority
 *   Game Park Zone,D,prohibited,,,
 *   Light Industry,I1,special_consent,"Buffer from residential required",,
 *
 * `zone` names either
 *   - a zone TYPE (ref_zone_types code or label): the district development
 *     control matrix, e.g. "Communal Farming Zone". One row applies to that
 *     whole zone type; or
 *   - a zone polygon name (proposed_peri_urban_zones.zone): a local plan's own
 *     table. One row is expanded to every polygon of that name.
 * A zone type wins if a name matches both.
 *
 * `group_code` is a land use from land_use_groups (A, A1, ... Z).
 * `control_type` is permitted | special_consent | prohibited, or the matrix's own
 * P | SC | X. A BLANK control_type means "not decided yet" (exactly like a blank
 * cell in the council's matrix): the row is skipped and reported, never loaded
 * as a guess.
 *
 * planImport() checks everything and says what loading would do (insert / update /
 * unchanged); the caller decides whether to write it.
 */

const CONTROL_TYPES = ['permitted', 'special_consent', 'prohibited']
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
 * @param {{id:number, zone:string}[]} input.zones      every zone polygon
 * @param {{code:string, label:string}[]} [input.zoneTypes]
 * @param {{id:string, group_code:string, is_active:boolean}[]} input.groups
 * @param {object[]} input.existing  live zone_land_use_controls rows (zone_id or zone_type set)
 * @param {string} [input.defaultAuthority]
 */
function planImport({ rows, zones, zoneTypes = [], groups, existing, defaultAuthority = 'Vungu RDC' }) {
  const errors = []
  const cells = []
  let undecided = 0

  // Targets a CSV row can name. Zone types first so they win a clash.
  const targets = new Map() // lower-case name -> { kind, name, code?, ids? }
  for (const t of zoneTypes) {
    // A plan's zone types carry an id; older callers pass only the global code.
    const target = { kind: 'type', name: t.label || t.code, code: t.code, id: t.id ?? null }
    targets.set(String(t.code).trim().toLowerCase(), target)
    if (t.label) targets.set(String(t.label).trim().toLowerCase(), target)
  }
  for (const z of zones) {
    const key = String(z.zone).trim().toLowerCase()
    if (!targets.has(key)) targets.set(key, { kind: 'zone', name: z.zone, ids: [] })
    const t = targets.get(key)
    if (t.kind === 'zone') t.ids.push(z.id)
  }

  const groupByCode = new Map(groups.filter((g) => g.is_active).map((g) => [g.group_code.toLowerCase(), g]))
  const live = new Map()
  for (const e of existing.filter((x) => !x.deleted_at)) {
    const typeKey = e.plan_zone_type_id ?? e.zone_type
    live.set(typeKey ? `type:${typeKey}|${e.land_use_group_id}` : `zone:${e.zone_id}|${e.land_use_group_id}`, e)
  }

  const seen = new Set()
  const mentioned = new Map() // target name -> target
  for (const r of rows) {
    const at = `line ${r._line}`
    const zoneKey = (r.zone || '').toLowerCase()
    const target = targets.get(zoneKey)
    const group = groupByCode.get((r.group_code || '').toLowerCase())
    const control = normaliseControl(r.control_type)

    if (!r.zone) { errors.push(`${at}: zone is required`); continue }
    if (!target) {
      const names = [...new Set([...targets.values()].map((t) => t.name))]
      const hint = names.filter((n) => n.toLowerCase().includes(zoneKey.slice(0, 5)) || zoneKey.includes(n.toLowerCase().slice(0, 5)))
      errors.push(`${at}: unknown zone "${r.zone}"${hint.length ? ` (did you mean: ${hint.join('; ')}?)` : ''}`)
      continue
    }
    if (!r.group_code) { errors.push(`${at}: group_code is required`); continue }
    if (!group) { errors.push(`${at}: unknown or inactive land-use group "${r.group_code}" — add the land use before loading rules for it`); continue }
    if (control === undefined) { errors.push(`${at}: control_type "${r.control_type}" must be permitted, special_consent or prohibited (or P, SC, X)`); continue }

    const dup = `${target.kind}:${target.name.toLowerCase()}|${group.group_code.toLowerCase()}`
    if (seen.has(dup)) { errors.push(`${at}: duplicate row for ${target.name} × ${group.group_code}`); continue }
    seen.add(dup)
    mentioned.set(target.name, target)

    if (control === null) { undecided++; continue }

    const base = {
      land_use_group_id: group.id,
      control_type: control,
      conditions: r.conditions || null,
      notes: r.notes || null,
      authority: r.authority || defaultAuthority,
      zone: target.name,
      group_code: group.group_code,
    }
    // A type-level cell points at the plan's own zone type when it has an id, else at the
    // global text code (older callers).
    const wantedTargets = target.kind === 'type'
      ? [{
          zone_type: target.id ? null : target.code,
          plan_zone_type_id: target.id,
          zone_id: null,
          key: `type:${target.id ?? target.code}|${group.id}`,
        }]
      : target.ids.map((id) => ({ zone_type: null, plan_zone_type_id: null, zone_id: id, key: `zone:${id}|${group.id}` }))

    for (const w of wantedTargets) {
      const current = live.get(w.key)
      let action = 'insert'
      if (current) {
        action = same(current.control_type, base.control_type) && same(current.conditions, base.conditions)
          && same(current.notes, base.notes) && same(current.authority, base.authority) ? 'unchanged' : 'update'
      }
      cells.push({ ...base, zone_type: w.zone_type, plan_zone_type_id: w.plan_zone_type_id, zone_id: w.zone_id, action })
    }
  }

  // Coverage: for every zone named in the CSV, which active land uses have no decision.
  const decided = new Map()
  for (const c of cells) {
    if (!decided.has(c.zone)) decided.set(c.zone, new Set())
    decided.get(c.zone).add(c.group_code)
  }
  const allCodes = [...groupByCode.values()].map((g) => g.group_code)
  const coverage = [...mentioned.values()].map((t) => {
    const have = decided.get(t.name) || new Set()
    return {
      zone: t.name,
      kind: t.kind,
      polygons: t.kind === 'zone' ? t.ids.length : null,
      decided: have.size,
      missing: allCodes.filter((c) => !have.has(c)),
    }
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

/**
 * A blank CSV for the planners.
 *  - 'district': every district zone type (ref_zone_types with a display_order,
 *    in the matrix's column order) x every active land use (in its row order);
 *  - 'local': every zone polygon name x every active land use;
 *  - 'plan': ALL of one plan's own zone types (ordered by display_order, then name) x
 *    that plan's active land uses (the loader passes only that plan's rows).
 * Decisions are left empty. Defaults to 'district' when zone types are given.
 */
function buildTemplate({ zones, zoneTypes = [], groups, level }) {
  const lvl = level || (zoneTypes.some((t) => t.display_order != null) ? 'district' : 'local')
  const byOrder = (a, b) => (a.display_order ?? 1e9) - (b.display_order ?? 1e9) || String(a.code).localeCompare(String(b.code))
  const names = lvl === 'plan'
    ? [...zoneTypes].sort(byOrder).map((t) => t.code)
    : lvl === 'district'
      ? zoneTypes.filter((t) => t.display_order != null).sort((a, b) => a.display_order - b.display_order).map((t) => t.code)
      : [...new Set(zones.map((z) => z.zone))].sort((a, b) => a.localeCompare(b))
  const active = groups.filter((g) => g.is_active).sort((a, b) =>
    (a.display_order ?? 1e9) - (b.display_order ?? 1e9) || a.group_code.localeCompare(b.group_code))
  const q = (v) => (/[",\n\r]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v)
  const lines = ['zone,group_code,group_description,control_type,conditions,notes,authority']
  for (const zone of names) {
    for (const g of active) lines.push([q(zone), q(g.group_code), q(g.description || ''), '', '', '', ''].join(','))
  }
  return lines.join('\n') + '\n'
}

module.exports = { CONTROL_TYPES, parseCsv, normaliseControl, planImport, buildTemplate }
