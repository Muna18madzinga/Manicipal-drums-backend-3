/**
 * Reads the layer catalogue out of a QGIS project file (.qgs): which layers the project holds,
 * where each reads from, how they are grouped and ordered, which are switched on, and the
 * extent the author left the map on.
 *
 * WHY THE PROJECT
 * QGIS is where the planning officer authors the data (see docs/SSOT-spatial.md). The project
 * already says what the portal should show and how it is organised, so it is the one place to
 * declare that, rather than a registry, a tile config and a frontend list each keeping its own.
 *
 * WHAT THIS DOES NOT DECIDE
 * Whether a layer may be exposed, tiled or edited is the server's call (layer_publication,
 * config/spatialLayers.js); a saved project cannot widen it. Reading the project only DECLARES.
 *
 * IDENTITY is the database table in the layer's data source, never the layer's display name:
 * the project's "proposed_peri_urban_zones" reads the zones_master view.
 */
const fs = require('node:fs')
const { XMLParser } = require('fast-xml-parser')

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  isArray: (name) => ['layer-tree-layer', 'layer-tree-group', 'maplayer'].includes(name),
})

/** "table="public"."zones_master" (geom)" -> { schema, table }. Null when the source is not a table. */
function tableOf(datasource) {
  if (typeof datasource !== 'string') return null
  const q = datasource.replace(/&quot;/g, '"')
  const m = q.match(/table=(?:"([^"]+)"\.)?"([^"]+)"/) || q.match(/table=(?:([A-Za-z0-9_]+)\.)?([A-Za-z0-9_]+)\b/)
  return m ? { schema: m[1] || 'public', table: m[2] } : null
}

const text = (v) => (typeof v === 'string' ? v.trim() : v && typeof v === 'object' && '#text' in v ? String(v['#text']).trim() : '')

/** Parse project XML. Pure: no file access, so it can be tested on small fixtures. */
function parseProject(xml) {
  const doc = parser.parse(xml)
  const q = doc.qgis
  if (!q) throw new Error('not a QGIS project file')

  const byId = new Map()
  for (const ml of q.projectlayers?.maplayer ?? []) {
    const ds = text(ml.datasource)
    const t = tableOf(ds)
    byId.set(text(ml.id), {
      qgisId: text(ml.id),
      name: text(ml.layername),
      title: text(ml.title) || null,
      abstract: text(ml.abstract) || null,
      provider: text(ml.provider),
      geometry: ml['@_geometry'] || null,                       // Polygon | Line | Point
      minScale: Number(ml['@_minScale']) || null,
      maxScale: Number(ml['@_maxScale']) || null,
      scaleLimited: ml['@_hasScaleBasedVisibilityFlag'] === '1',
      table: t?.table ?? null,
      schema: t?.schema ?? null,
    })
  }

  // Walk the layer tree in drawing order (top of the tree is drawn on top).
  const layers = []
  const groups = []
  let order = 0
  const walk = (node, path, parentOn) => {
    // The XML parser collects children by tag, so a group and a layer that sit side by side lose
    // their relative position. Layers keep their order within each group, which is what the
    // catalogue uses; groups are listed before the layers that sit directly beside them.
    for (const g of node['layer-tree-group'] ?? []) {
      const on = parentOn && g['@_checked'] !== 'Qt::Unchecked'
      const name = g['@_name']
      groups.push({ path: [...path, name], name, checked: g['@_checked'] !== 'Qt::Unchecked', expanded: g['@_expanded'] === '1' })
      walk(g, [...path, name], on)
    }
    for (const l of node['layer-tree-layer'] ?? []) {
      const meta = byId.get(l['@_id'])
      if (!meta) continue
      const checked = l['@_checked'] !== 'Qt::Unchecked'
      layers.push({ ...meta, group: path, checked, defaultVisible: parentOn && checked, order: order++ })
    }
  }
  walk((q['layer-tree-group'] ?? [])[0] ?? {}, [], true)

  const ext = q.mapcanvas?.extent
  const extent = ext && [ext.xmin, ext.ymin, ext.xmax, ext.ymax].every((v) => Number.isFinite(Number(v)))
    ? [Number(ext.xmin), Number(ext.ymin), Number(ext.xmax), Number(ext.ymax)]
    : null

  return {
    title: q['@_projectname'] || text(q.title) || null,
    savedAt: q['@_saveDateTime'] || null,
    savedBy: q['@_saveUser'] || null,
    extent,
    groups,
    layers,
  }
}

let cache = { path: null, mtimeMs: 0, project: null }

/** The parsed project, re-read only when the file changes. */
function loadProject(path) {
  const { mtimeMs } = fs.statSync(path)
  if (cache.path === path && cache.mtimeMs === mtimeMs) return cache.project
  const project = parseProject(fs.readFileSync(path, 'utf8'))
  cache = { path, mtimeMs, project }
  return project
}

module.exports = { parseProject, loadProject, tableOf }
