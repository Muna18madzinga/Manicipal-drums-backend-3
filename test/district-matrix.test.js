const fs = require('fs')
const path = require('path')
const { parseCsv, planImport, buildTemplate } = require('../src/utils/zoningMatrixImport')
const { buildGrid, ZONE_USES_SQL, ZONE_TYPE_USES_SQL, RULES_COUNT_SQL } = require('../src/utils/zoneUses')

const zoneTypes = [
  { code: 'Communal Farming Zone', label: 'Communal Farming Zone', display_order: 1 },
  { code: 'Game Park Zone', label: 'Game Park Zone', display_order: 7 },
  { code: 'Residential Zone', label: 'Residential Zone', display_order: null }, // not a district-matrix column
]
const zones = [{ id: 1, zone: 'Light Industry' }, { id: 2, zone: 'Light Industry' }]
const groups = [
  { id: 'g-b', group_code: 'B', description: 'Residential buildings', display_order: 5, is_active: true },
  { id: 'g-a', group_code: 'A', description: 'Detached dwellings', display_order: 1, is_active: true },
  { id: 'g-d', group_code: 'D', description: 'Shops', display_order: 9, is_active: true },
]
const HEAD = 'zone,group_code,control_type,conditions,notes,authority\n'
const plan = (csv, existing = []) => planImport({ rows: parseCsv(csv), zones, zoneTypes, groups, existing })

describe('zone-type targets (the district matrix)', () => {
  test('a row naming a zone type becomes ONE type-level cell, not polygon cells', () => {
    const p = plan(HEAD + 'Game Park Zone,A,X,,,\n')
    expect(p.summary).toMatchObject({ cells: 1, inserts: 1, errors: 0 })
    expect(p.cells[0]).toMatchObject({ zone_type: 'Game Park Zone', zone_id: null, control_type: 'prohibited' })
  })

  test('the matrix codes P / SC / X are accepted, and the name matches code or label in any case', () => {
    const p = plan(HEAD + 'game park zone,A,SC,,,\nCOMMUNAL FARMING ZONE,B,P,,,\n')
    expect(p.cells.map((c) => `${c.zone_type}:${c.control_type}`)).toEqual(['Game Park Zone:special_consent', 'Communal Farming Zone:permitted'])
  })

  test('a polygon-name row still expands to every polygon of that name', () => {
    const p = plan(HEAD + 'Light Industry,D,SC,,,\n')
    expect(p.cells.map((c) => [c.zone_id, c.zone_type])).toEqual([[1, null], [2, null]])
  })

  test('a blank cell is undecided, as in the council matrix, and is not loaded', () => {
    const p = plan(HEAD + 'Game Park Zone,D,,,,\n')
    expect(p.summary).toMatchObject({ cells: 0, undecided: 1, errors: 0 })
  })

  test('type-level rows compare against live type-level rows only', () => {
    const live = [{ zone_id: null, zone_type: 'Game Park Zone', land_use_group_id: 'g-a', control_type: 'prohibited', conditions: null, notes: null, authority: 'Vungu RDC', deleted_at: null }]
    expect(plan(HEAD + 'Game Park Zone,A,X,,,\n', live).summary).toMatchObject({ unchanged: 1, inserts: 0 })
    expect(plan(HEAD + 'Game Park Zone,A,P,,,\n', live).summary).toMatchObject({ updates: 1 })
    expect(plan(HEAD + 'Communal Farming Zone,A,X,,,\n', live).summary).toMatchObject({ inserts: 1 }) // other type
  })

  test('coverage is reported only for zones named in the CSV, as types or polygons', () => {
    const p = plan(HEAD + 'Game Park Zone,A,X,,,\n')
    expect(p.coverage).toEqual([{ zone: 'Game Park Zone', kind: 'type', polygons: null, decided: 1, missing: ['B', 'D'] }])
  })
})

describe('buildTemplate (district)', () => {
  test('district template: only matrix zone types, in column order, uses in row order', () => {
    const lines = buildTemplate({ zones, zoneTypes, groups }).trim().split('\n')
    expect(lines).toHaveLength(1 + 2 * 3)
    expect(lines[1]).toBe('Communal Farming Zone,A,Detached dwellings,,,,')
    expect(lines.slice(1, 4).map((l) => l.split(',')[1])).toEqual(['A', 'B', 'D']) // by display_order, not code
    expect(lines.some((l) => l.startsWith('Residential Zone'))).toBe(false)
  })

  test('local template: zone polygon names instead', () => {
    const lines = buildTemplate({ zones, zoneTypes, groups, level: 'local' }).trim().split('\n')
    expect(lines).toHaveLength(1 + 1 * 3)
    expect(lines[1].startsWith('Light Industry,')).toBe(true)
  })
})

describe('buildGrid (the matrix as the council prints it)', () => {
  test('uses down, zone types across, P / SC / X per cell and null where undecided', () => {
    const grid = buildGrid({
      zoneTypes: [{ code: 'Z1', label: 'One', display_order: 1 }, { code: 'Z2', label: 'Two', display_order: 2 }],
      landUses: [{ group_code: 'A', description: 'Dwellings', group_category: 'residential' }, { group_code: 'U', description: 'Parking', group_category: 'commercial' }],
      cells: [{ zone_type: 'Z1', group_code: 'A', control_type: 'permitted', conditions: null }, { zone_type: 'Z2', group_code: 'A', control_type: 'special_consent', conditions: 'x' }],
    })
    expect(grid.zone_types.map((z) => z.code)).toEqual(['Z1', 'Z2'])
    expect(grid.land_uses[0].cells.map((c) => c && c.permission_code)).toEqual(['P', 'SC'])
    expect(grid.land_uses[1].cells).toEqual([null, null])
  })
})

describe('SQL', () => {
  test('polygon reads go through the view, which already applies soft delete; type reads hit the table', () => {
    expect(ZONE_USES_SQL).toMatch(/FROM zone_effective_controls/)
    expect(RULES_COUNT_SQL).toMatch(/zone_effective_controls/)
    expect(ZONE_TYPE_USES_SQL).toMatch(/t\.plan_instrument_id = \$1/) // scoped to one plan
    expect(ZONE_TYPE_USES_SQL).toMatch(/t\.code = \$2/)
    expect(ZONE_TYPE_USES_SQL).toMatch(/c\.deleted_at IS NULL/)
    for (const sql of [ZONE_USES_SQL, ZONE_TYPE_USES_SQL]) expect(sql).toMatch(/ORDER BY g\.display_order/)
  })
})

describe('the committed sample matrix (docs/district-development-control-matrix.csv)', () => {
  const rows = parseCsv(fs.readFileSync(path.join(__dirname, '..', 'docs', 'district-development-control-matrix.csv'), 'utf8'))
  const types = [...new Set(rows.map((r) => r.zone))].map((z, i) => ({ code: z, label: z, display_order: i + 1 }))
  const uses = [...new Set(rows.map((r) => r.group_code))].map((c, i) => ({ id: 'g-' + c, group_code: c, description: c, display_order: i + 1, is_active: true }))

  test('is the 11-zone × 32-use matrix, every cell present once', () => {
    expect(types).toHaveLength(11)
    expect(uses).toHaveLength(32)
    expect(rows).toHaveLength(11 * 32)
  })

  test('loads with no errors: 337 decisions (171 P, 84 SC, 82 X) and 15 blanks left undecided', () => {
    const p = planImport({ rows, zones: [], zoneTypes: types, groups: uses, existing: [] })
    expect(p.errors).toEqual([])
    expect(p.summary).toMatchObject({ cells: 337, undecided: 15 })
    const n = (t) => p.cells.filter((c) => c.control_type === t).length
    expect([n('permitted'), n('special_consent'), n('prohibited')]).toEqual([171, 84, 82])
  })

  test('the only blanks are use U (parking garage) everywhere and D1 (farm stores) in the last four zones', () => {
    const blanks = rows.filter((r) => !r.control_type).map((r) => `${r.group_code}`)
    expect(blanks.filter((c) => c === 'U')).toHaveLength(11)
    expect(blanks.filter((c) => c === 'D1')).toHaveLength(4)
    expect(blanks).toHaveLength(15)
  })
})

describe('planImport with a plan\'s own zone types', () => {
  test('cells keep the plan zone type id, so the loader writes them to that plan', () => {
    const { planImport } = require('../src/utils/zoningMatrixImport')
    const out = planImport({
      rows: [{ zone: 'Communal Farming Zone', group_code: 'A', control_type: 'P' }],
      zones: [],
      zoneTypes: [{ id: 'pzt-1', code: 'Communal Farming Zone', label: 'Communal Farming Zone' }],
      groups: [{ id: 'g1', group_code: 'A', is_active: true }],
      existing: [],
    })
    expect(out.cells[0].plan_zone_type_id).toBe('pzt-1')
    expect(out.cells[0].zone_type).toBeNull()
  })
})
