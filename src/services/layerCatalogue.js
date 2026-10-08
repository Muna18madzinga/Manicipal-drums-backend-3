/**
 * The layer catalogue: what the portal shows, built from the QGIS project and approved by the server.
 *
 *   QGIS project   DECLARES  which layers, in which groups and order, which are on, the opening extent
 *   layer_publication  APPROVES  which tables the portal may expose, and to whom (default deny)
 *   spatialLayers.js   RENDERS   how a table becomes vector tiles (the attribute allowlist lives there)
 *
 * A layer is listed only if the project declares it, the server has approved its table, and the
 * table exists. Everything the server exposes that the project does not yet declare is listed under
 * "Not yet in the QGIS project", so nothing vanishes while the project catches up and the gap is
 * visible. reconcile() reports every disagreement between the sources, including a project layer
 * whose table no longer exists.
 */

const NOT_IN_PROJECT = 'Not yet in the QGIS project'

// What the planner's map shows on arrival for layers the project does not declare yet: the
// orientation layers and Vungu's zones. Once a layer is in the project its own on/off state wins.
const LEGACY_DEFAULT_ON = new Set([
  'country', 'provinces', 'districts', 'wards', 'roads', 'railways', 'water_areas', 'waterways',
  'vungu_proposed_peri_urban_zones', 'vungu_beyond_peri_urban_zones',
])

const humanise = (s) => String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
const geomOf = (g) => ({ Polygon: 'polygon', Line: 'line', Point: 'point' }[g] || null)

/**
 * @param project   parsed project (qgisCatalogue.parseProject)
 * @param tileLayers config/spatialLayers LAYERS
 * @param approved  Map table -> { audience } from layer_publication
 * @param existing  Set of table/view names that exist in the database
 */
function buildCatalogue({ project, tileLayers, approved, existing }) {
  const tileByTable = new Map(tileLayers.map((t) => [t.table, t]))
  const inProject = new Set(project.layers.map((l) => l.table).filter(Boolean))

  const live = []
  for (const l of project.layers) {
    if (!l.table || !approved.has(l.table) || !existing.has(l.table)) continue
    const tile = tileByTable.get(l.table) || null
    live.push({
      id: tile ? tile.id : l.table,
      table: l.table,
      title: tile ? tile.title : humanise(l.table),
      projectName: l.name,
      group: l.group.length ? l.group : ['Layers'],
      geometryType: tile ? tile.geomType : geomOf(l.geometry),
      source: 'project',
      inProject: true,
      defaultVisible: l.defaultVisible,
      tile: !!tile,
      audience: approved.get(l.table).audience,
      order: l.order,
      minScale: l.minScale,
      maxScale: l.maxScale,
    })
  }

  // Approved by the server, real, but not declared by the project (yet).
  const legacy = []
  for (const [table, { audience }] of approved) {
    if (inProject.has(table) || !existing.has(table)) continue
    const tile = tileByTable.get(table) || null
    const id = tile ? tile.id : table
    legacy.push({
      id, table,
      title: tile ? tile.title : humanise(table),
      projectName: null,
      group: [NOT_IN_PROJECT],
      geometryType: tile ? tile.geomType : null,
      source: 'legacy',
      inProject: false,
      defaultVisible: LEGACY_DEFAULT_ON.has(id),
      tile: !!tile,
      audience,
      order: 1000,
      minScale: null,
      maxScale: null,
    })
  }
  legacy.sort((a, b) => a.title.localeCompare(b.title))

  const layers = [...live, ...legacy]
  const groups = []
  for (const l of layers) {
    const key = l.group.join(' / ')
    let g = groups.find((x) => x.name === key)
    if (!g) { g = { name: key, path: l.group, layers: [] }; groups.push(g) }
    g.layers.push(l)
  }
  return { project: { title: project.title, savedAt: project.savedAt, savedBy: project.savedBy, extent: project.extent }, groups, layers }
}

/**
 * Every place the sources disagree. Nothing here is fixed automatically: a person decides whether
 * the project, the publication list or the database is the one that is wrong.
 */
function reconcile({ project, tileLayers, approved, existing, registry }) {
  const projectTables = new Map()
  for (const l of project.layers) if (l.table) projectTables.set(l.table, [...(projectTables.get(l.table) || []), l.name])
  const declared = new Set(projectTables.keys())

  const out = {
    // The project points at a table that is not in the database. QGIS and QGIS Server show it broken.
    projectBroken: project.layers.filter((l) => l.table && !existing.has(l.table)).map((l) => ({ layer: l.name, table: l.table })),
    // The project has a layer the server has not approved: it is not shown until someone approves it.
    projectNotApproved: project.layers.filter((l) => l.table && existing.has(l.table) && !approved.has(l.table)).map((l) => ({ layer: l.name, table: l.table })),
    // Two project layers read the same table.
    projectDuplicates: [...projectTables].filter(([, names]) => names.length > 1).map(([table, layers]) => ({ table, layers })),
    // A layer whose name differs from the table it reads. Not an error (a view is read through a friendlier name),
    // but the name of the layer in the project must never be taken for what the data is: one named for Gweru
    // reads a Vungu table.
    projectNameDiffersFromTable: project.layers.filter((l) => l.table && l.name !== l.table).map((l) => ({ layer: l.name, table: l.table })),
    // Approved by the server but not in the project: shown under "Not yet in the QGIS project".
    approvedNotInProject: [...approved.keys()].filter((t) => existing.has(t) && !declared.has(t)).sort(),
    // Approved by the server but the table has gone.
    approvedMissingTable: [...approved.keys()].filter((t) => !existing.has(t)).sort(),
    // Tile layers the server can render that the project does not declare.
    tileNotInProject: tileLayers.filter((t) => !declared.has(t.table)).map((t) => t.id),
    // Older registry rows that the project does not declare (the registry is no longer a source).
    registryNotInProject: (registry || []).filter((r) => !declared.has(r.table_name)).map((r) => r.table_name).sort(),
  }
  out.summary = {
    projectLayers: project.layers.length,
    broken: out.projectBroken.length,
    notApproved: out.projectNotApproved.length,
    duplicates: out.projectDuplicates.length,
    nameDiffersFromTable: out.projectNameDiffersFromTable.length,
    approvedNotInProject: out.approvedNotInProject.length,
    approvedMissingTable: out.approvedMissingTable.length,
    tileNotInProject: out.tileNotInProject.length,
    registryNotInProject: out.registryNotInProject.length,
  }
  return out
}

module.exports = { buildCatalogue, reconcile, NOT_IN_PROJECT, LEGACY_DEFAULT_ON, humanise }
