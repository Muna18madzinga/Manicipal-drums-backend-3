const { parseCsv, normaliseControl, planImport, buildTemplate } = require('../src/utils/zoningMatrixImport')
const { groupUses, ZONE_USES_SQL, PERMISSION_CODE, CONTROL_TYPE } = require('../src/utils/zoneUses')

const zones = [
  { id: 1, zone: 'Light Industry' },
  { id: 2, zone: 'Economic Corridor [Mixed Business]' },
  { id: 3, zone: 'Economic Corridor [Mixed Business]' },
]
const groups = [
  { id: 'g-i1', group_code: 'I1', description: 'Light Industrial', is_active: true },
  { id: 'g-c2', group_code: 'C2', description: 'General Commercial', is_active: true },
  { id: 'g-old', group_code: 'OLD', description: 'Retired', is_active: false },
]
const plan = (csv, existing = []) => planImport({ rows: parseCsv(csv), zones, groups, existing })
const HEAD = 'zone,group_code,control_type,conditions,notes,authority\n'

describe('parseCsv', () => {
  test('handles quotes, commas in fields, doubled quotes and CRLF', () => {
    const rows = parseCsv('zone,group_code,conditions\r\n"Economic Corridor [Mixed Business]",C2,"Hours 6am-10pm, ""licensed"""\r\n')
    expect(rows).toHaveLength(1)
    expect(rows[0].zone).toBe('Economic Corridor [Mixed Business]')
    expect(rows[0].conditions).toBe('Hours 6am-10pm, "licensed"')
    expect(rows[0]._line).toBe(2)
  })

  test('skips blank lines and a UTF-8 BOM', () => {
    expect(parseCsv('﻿zone,group_code\n\nLight Industry,I1\n\n')).toHaveLength(1)
  })
})

describe('normaliseControl', () => {
  test('accepts the three values, the legacy P/SC/X codes and spacing variants', () => {
    expect(normaliseControl('Permitted')).toBe('permitted')
    expect(normaliseControl('special consent')).toBe('special_consent')
    expect(normaliseControl('SC')).toBe('special_consent')
    expect(normaliseControl('X')).toBe('prohibited')
  })
  test('blank is null (undecided); anything else is undefined (invalid)', () => {
    expect(normaliseControl('')).toBeNull()
    expect(normaliseControl('maybe')).toBeUndefined()
  })
})

describe('planImport', () => {
  test('a zone type is expanded to every polygon with that name', () => {
    const p = plan(HEAD + 'Economic Corridor [Mixed Business],C2,permitted,,,\n')
    expect(p.summary).toMatchObject({ cells: 2, inserts: 2, errors: 0 })
    expect(p.cells.map((c) => c.zone_id).sort()).toEqual([2, 3])
    expect(p.cells[0]).toMatchObject({ land_use_group_id: 'g-c2', control_type: 'permitted', authority: 'Vungu RDC' })
  })

  test('blank control_type is undecided and is never loaded', () => {
    const p = plan(HEAD + 'Light Industry,I1,,,,\n')
    expect(p.summary).toMatchObject({ cells: 0, undecided: 1, errors: 0 })
  })

  test('reports unknown zone, unknown/inactive group and bad control type, loading nothing from them', () => {
    const p = plan(HEAD + 'Light Industrie,I1,permitted,,,\nLight Industry,ZZ,permitted,,,\nLight Industry,OLD,permitted,,,\nLight Industry,C2,sometimes,,,\n')
    expect(p.summary.cells).toBe(0)
    expect(p.errors).toHaveLength(4)
    expect(p.errors[0]).toMatch(/line 2: unknown zone "Light Industrie"/)
    expect(p.errors[1]).toMatch(/unknown or inactive land-use group "ZZ"/)
    expect(p.errors[2]).toMatch(/"OLD"/)
    expect(p.errors[3]).toMatch(/must be permitted, special_consent or prohibited/)
  })

  test('rejects a duplicate zone × group row', () => {
    const p = plan(HEAD + 'Light Industry,I1,permitted,,,\nlight industry,i1,prohibited,,,\n')
    expect(p.errors.some((e) => /duplicate/.test(e))).toBe(true)
  })

  test('compares with live rows: unchanged, update and insert', () => {
    const live = [
      { zone_id: 1, land_use_group_id: 'g-i1', control_type: 'permitted', conditions: null, notes: null, authority: 'Vungu RDC', deleted_at: null },
    ]
    expect(plan(HEAD + 'Light Industry,I1,permitted,,,\n', live).summary).toMatchObject({ unchanged: 1, updates: 0, inserts: 0 })
    expect(plan(HEAD + 'Light Industry,I1,special_consent,,,\n', live).summary).toMatchObject({ unchanged: 0, updates: 1, inserts: 0 })
    expect(plan(HEAD + 'Light Industry,C2,permitted,,,\n', live).summary).toMatchObject({ inserts: 1 })
  })

  test('a soft-deleted live row does not count as existing', () => {
    const live = [{ zone_id: 1, land_use_group_id: 'g-i1', control_type: 'permitted', conditions: null, notes: null, authority: 'Vungu RDC', deleted_at: '2026-01-01' }]
    expect(plan(HEAD + 'Light Industry,I1,permitted,,,\n', live).summary.inserts).toBe(1)
  })

  test('coverage lists the active groups a zone type still has no decision for', () => {
    const p = plan(HEAD + 'Light Industry,I1,permitted,,,\n')
    const li = p.coverage.find((c) => c.zone === 'Light Industry')
    expect(li).toMatchObject({ polygons: 1, decided: 1, missing: ['C2'] }) // OLD is inactive: not expected
  })
})

describe('buildTemplate', () => {
  test('one row per zone type × active group, decisions blank, quoting preserved', () => {
    const csv = buildTemplate({ zones, groups })
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('zone,group_code,group_description,control_type,conditions,notes,authority')
    expect(lines).toHaveLength(1 + 2 * 2) // 2 zone types × 2 active groups
    expect(csv).toContain('Light Industry,I1,Light Industrial,,,,')
    // round-trips through the parser with every decision undecided
    const p = planImport({ rows: parseCsv(csv), zones, groups, existing: [] })
    expect(p.summary).toMatchObject({ rows: 4, cells: 0, undecided: 4, errors: 0 })
  })
})

describe('zoneUses (what the API serves)', () => {
  const rows = [
    { group_code: 'C2', group_description: 'General Commercial', group_category: 'commercial', control_type: 'permitted', conditions: 'Licence', notes: null },
    { group_code: 'I1', group_description: 'Light Industrial', group_category: 'industrial', control_type: 'special_consent', conditions: null, notes: 'Buffer' },
    { group_code: 'P', group_description: 'Prohibited Uses', group_category: 'prohibited', control_type: 'prohibited', conditions: null, notes: null },
  ]

  test('groups rows into the three lists the clients expect', () => {
    const g = groupUses(rows)
    expect(g.permitted_uses.map((u) => u.group_code)).toEqual(['C2'])
    expect(g.consent_required_uses.map((u) => u.group_code)).toEqual(['I1'])
    expect(g.prohibited_uses.map((u) => u.group_code)).toEqual(['P'])
    expect(g.permitted_uses[0]).toMatchObject({ description: 'General Commercial', category: 'commercial', conditions: 'Licence', max_units: null, min_lot_size_sqm: null })
  })

  test('an empty matrix gives three empty lists, not an error', () => {
    expect(groupUses([])).toEqual({ permitted_uses: [], prohibited_uses: [], consent_required_uses: [] })
  })

  test('reads only live rows of active groups, and the code maps round-trip', () => {
    expect(ZONE_USES_SQL).toMatch(/c\.deleted_at IS NULL/)
    expect(ZONE_USES_SQL).toMatch(/g\.is_active = TRUE/)
    expect(ZONE_USES_SQL).not.toMatch(/development_matrix/)
    for (const [type, code] of Object.entries(PERMISSION_CODE)) expect(CONTROL_TYPE[code]).toBe(type)
  })
})
