const fs = require('node:fs')
const path = require('node:path')
const { parseProject, tableOf } = require('../src/services/qgisCatalogue')
const { buildCatalogue, reconcile, NOT_IN_PROJECT } = require('../src/services/layerCatalogue')

const layer = (id, name, table, { checked = true, geometry = 'Polygon', schema = 'public' } = {}) => ({
  tree: `<layer-tree-layer checked="${checked ? 'Qt::Checked' : 'Qt::Unchecked'}" id="${id}" name="${name}" providerKey="postgres"/>`,
  map: `<maplayer geometry="${geometry}" minScale="0" maxScale="0" hasScaleBasedVisibilityFlag="0"><id>${id}</id><layername>${name}</layername>` +
       `<datasource>service='vungu' key='id' srid=4326 table=&quot;${schema}&quot;.&quot;${table}&quot; (geom)</datasource><provider encoding="">postgres</provider></maplayer>`,
})

function project({ root = [], groups = [], layers, extent = '<extent><xmin>29.3</xmin><ymin>-19.6</ymin><xmax>29.9</xmax><ymax>-19.1</ymax></extent>' }) {
  return `<qgis projectname="T" saveDateTime="2026-10-07T12:00:00" saveUser="u"><layer-tree-group>` +
    root.map((l) => l.tree).join('') +
    groups.map((g) => `<layer-tree-group checked="${g.checked === false ? 'Qt::Unchecked' : 'Qt::Checked'}" name="${g.name}">${g.layers.map((l) => l.tree).join('')}</layer-tree-group>`).join('') +
    `</layer-tree-group><mapcanvas>${extent}</mapcanvas><projectlayers>${layers.map((l) => l.map).join('')}</projectlayers></qgis>`
}

describe('reading a QGIS project', () => {
  test('identity is the table in the data source, not the layer name', () => {
    expect(tableOf(`service='vungu' key='id' table="public"."zones_master" (geom)`)).toEqual({ schema: 'public', table: 'zones_master' })
    expect(tableOf(`service='vungu' key='id' table=&quot;public&quot;.&quot;country&quot; (geom)`)).toEqual({ schema: 'public', table: 'country' })
    expect(tableOf('/data/file.gpkg|layername=x')).toBeNull()
  })

  test('layers, their tables, order, geometry and the opening extent', () => {
    const a = layer('a', 'proposed_peri_urban_zones', 'zones_master')
    const b = layer('b', 'roads', 'roads', { geometry: 'Line' })
    const p = parseProject(project({ root: [a, b], layers: [a, b] }))
    expect(p.layers.map((l) => [l.name, l.table, l.geometry, l.order])).toEqual([
      ['proposed_peri_urban_zones', 'zones_master', 'Polygon', 0], ['roads', 'roads', 'Line', 1]])
    expect(p.extent).toEqual([29.3, -19.6, 29.9, -19.1])
  })

  test('groups: a layer is on only if it and every group above it are checked', () => {
    const a = layer('a', 'a', 'a'); const b = layer('b', 'b', 'b'); const c = layer('c', 'c', 'c', { checked: false })
    const p = parseProject(project({
      groups: [{ name: 'Vungu planning', layers: [a, c] }, { name: 'Other authorities', checked: false, layers: [b] }],
      layers: [a, b, c],
    }))
    const by = Object.fromEntries(p.layers.map((l) => [l.name, l]))
    expect(by.a.group).toEqual(['Vungu planning']); expect(by.a.defaultVisible).toBe(true)
    expect(by.c.defaultVisible).toBe(false)              // its own box is off
    expect(by.b.group).toEqual(['Other authorities']); expect(by.b.defaultVisible).toBe(false)   // its group is off
  })

  test('a layer in the tree with no definition, and anything that is not a project, are refused or skipped', () => {
    const a = layer('a', 'a', 'a')
    expect(parseProject(project({ root: [a], layers: [] })).layers).toEqual([])
    expect(() => parseProject('<html/>')).toThrow(/not a QGIS project/)
  })

  test('the real project parses: ten layers, with the zones read through the view and the country table', () => {
    const p = parseProject(fs.readFileSync(path.join(__dirname, '..', 'qgis-projects', 'vungu-project.qgs'), 'utf8'))
    expect(p.layers.length).toBeGreaterThanOrEqual(1)
    expect(p.layers.every((l) => l.table)).toBe(true)
    expect(p.extent).toHaveLength(4)
  })
})

describe('the catalogue', () => {
  const tileLayers = [
    { id: 'country', table: 'country', title: 'Country', geomType: 'polygon' },
    { id: 'vungu_proposed_peri_urban_zones', table: 'zones_master', title: 'Proposed Peri-Urban Zones', geomType: 'polygon' },
    { id: 'wards', table: 'wards', title: 'Wards', geomType: 'polygon' },
    { id: 'roads', table: 'roads', title: 'Roads', geomType: 'line' },
  ]
  const approved = new Map(['country', 'zones_master', 'wards', 'roads', 'gweru_rivers', 'secret_table'].map((t) => [t, { audience: 'staff' }]))
  const existing = new Set(['country', 'zones_master', 'wards', 'roads', 'gweru_rivers', 'secret_table', 'unapproved'])
  const z = layer('z', 'proposed_peri_urban_zones', 'zones_master'); const c = layer('c', 'zimbabwe', 'country')
  const g = layer('g', 'gweru_rivers', 'gweru_rivers', { geometry: 'Line' })
  const u = layer('u', 'unapproved', 'unapproved'); const ghost = layer('x', 'gone', 'dropped_table')

  const proj = (extra = []) => parseProject(project({
    groups: [{ name: 'Vungu planning', layers: [z] }, { name: 'Boundaries', layers: [c] }, { name: 'Other authorities', checked: false, layers: [g] }],
    root: extra, layers: [z, c, g, ...extra.length ? [u, ghost] : []],
  }))

  test('a project layer is listed under its group, titled from its table and tied to its tile layer', () => {
    const cat = buildCatalogue({ project: proj(), tileLayers, approved, existing })
    const zones = cat.layers.find((l) => l.table === 'zones_master')
    expect(zones).toMatchObject({ id: 'vungu_proposed_peri_urban_zones', title: 'Proposed Peri-Urban Zones', tile: true, inProject: true, defaultVisible: true, group: ['Vungu planning'] })
    expect(cat.layers.find((l) => l.table === 'country').projectName).toBe('zimbabwe')
    expect(cat.project.extent).toHaveLength(4)
  })

  test('what the server exposes but the project does not declare is listed apart, so nothing vanishes', () => {
    const cat = buildCatalogue({ project: proj(), tileLayers, approved, existing })
    const legacy = cat.groups.find((x) => x.name === NOT_IN_PROJECT).layers.map((l) => l.id).sort()
    expect(legacy).toEqual(['roads', 'secret_table', 'wards'])
    expect(cat.layers.find((l) => l.id === 'wards')).toMatchObject({ source: 'legacy', inProject: false, defaultVisible: true })   // orientation layer
    expect(cat.layers.find((l) => l.id === 'secret_table').defaultVisible).toBe(false)
  })

  test('a project layer is never listed unless the server approved its table and the table exists', () => {
    const cat = buildCatalogue({ project: proj([u, ghost]), tileLayers, approved, existing })
    expect(cat.layers.find((l) => l.table === 'unapproved')).toBeUndefined()
    expect(cat.layers.find((l) => l.table === 'dropped_table')).toBeUndefined()
  })

  test('the Gweru group stays off by default', () => {
    const cat = buildCatalogue({ project: proj(), tileLayers, approved, existing })
    expect(cat.layers.find((l) => l.table === 'gweru_rivers')).toMatchObject({ defaultVisible: false, group: ['Other authorities'] })
  })
})

describe('reconciliation', () => {
  const tileLayers = [{ id: 'country', table: 'country' }, { id: 'wards', table: 'wards' }]
  const a = layer('a', 'zimbabwe', 'country'); const b = layer('b', 'gone', 'dropped_table'); const d = layer('d', 'again', 'country')
  const p = parseProject(project({ root: [a, b, d], layers: [a, b, d] }))
  const r = reconcile({
    project: p, tileLayers,
    approved: new Map([['country', { audience: 'staff' }], ['wards', { audience: 'staff' }], ['vanished', { audience: 'staff' }]]),
    existing: new Set(['country', 'wards', 'stray']),
    registry: [{ table_name: 'country' }, { table_name: 'stray' }],
  })

  test('names a project layer whose table is gone, the thing that broke QGIS when a table was dropped', () => {
    expect(r.projectBroken).toEqual([{ layer: 'gone', table: 'dropped_table' }])
  })
  test('finds two project layers on one table, and a layer name that differs from its table', () => {
    expect(r.projectDuplicates).toEqual([{ table: 'country', layers: ['zimbabwe', 'again'] }])
    expect(r.projectNameDiffersFromTable.map((x) => x.layer)).toEqual(['zimbabwe', 'gone', 'again'])
  })
  test('lists what is approved but undeclared or missing, tile layers the project lacks, and old registry rows', () => {
    expect(r.approvedNotInProject).toEqual(['wards'])
    expect(r.approvedMissingTable).toEqual(['vanished'])
    expect(r.tileNotInProject).toEqual(['wards'])
    expect(r.registryNotInProject).toEqual(['stray'])
    expect(r.summary).toMatchObject({ projectLayers: 3, broken: 1, duplicates: 1 })
  })
})
