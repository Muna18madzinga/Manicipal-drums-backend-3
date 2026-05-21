// src/config/spatialLayers.js
// Single source of truth for the PostGIS layers served as vector tiles.
// `id` is also the MVT source-layer name used by the frontend.

const GEOM_COLUMN = 'geom'   // change if Task 1 reported a different column
// ogr2ogr imported zimbabwe.gpkg under SRS 900914 — that SRS row is literally
// WGS 84 (CRS84): "+proj=longlat +datum=WGS84 +no_defs", same coords as EPSG:4326,
// just a non-standard SRID assigned because the GeoPackage's source CRS lacked
// an EPSG code. We honour the actual stored SRID rather than rewrite 5.7M rows.
const GEOM_SRID = 900914

/**
 * @typedef {Object} SpatialLayer
 * @property {string} id          unique id + MVT source-layer name
 * @property {string} table       PostGIS table name
 * @property {'polygon'|'line'|'point'} geomType
 * @property {'admin'|'landuse'|'hydro'|'transport'|'structures'|'poi'} group
 * @property {string} title       human label
 * @property {string[]} attributes columns exposed inside each tile
 * @property {number} minzoom
 * @property {number} maxzoom
 * @property {{maxZoom:number, where:string}|null} lowZoomFilter
 */

/** @type {SpatialLayer[]} */
const LAYERS = [
  // --- admin boundaries (always available) ---
  { id: 'country',   table: 'country',   geomType: 'polygon', group: 'admin', title: 'Country',   attributes: ['fid', 'name_en', 'pcode', 'level'], minzoom: 0,  maxzoom: 22, lowZoomFilter: null },
  { id: 'provinces', table: 'provinces', geomType: 'polygon', group: 'admin', title: 'Provinces', attributes: ['fid', 'name_en', 'pcode', 'level'], minzoom: 0,  maxzoom: 22, lowZoomFilter: null },
  { id: 'districts', table: 'districts', geomType: 'polygon', group: 'admin', title: 'Districts', attributes: ['fid', 'name_en', 'pcode', 'level'], minzoom: 5,  maxzoom: 22, lowZoomFilter: null },
  { id: 'wards',     table: 'wards',     geomType: 'polygon', group: 'admin', title: 'Wards',     attributes: ['fid', 'name_en', 'pcode', 'level'], minzoom: 8,  maxzoom: 22, lowZoomFilter: null },

  // --- landuse ---
  { id: 'landuse',      table: 'landuse',      geomType: 'polygon', group: 'landuse', title: 'Land Use',     attributes: ['fid', 'name', 'fclass'], minzoom: 8,  maxzoom: 22, lowZoomFilter: null },
  { id: 'admin_areas',  table: 'admin_areas',  geomType: 'polygon', group: 'landuse', title: 'Admin Areas',  attributes: ['fid', 'name', 'fclass'], minzoom: 8,  maxzoom: 22, lowZoomFilter: null },
  { id: 'places_areas', table: 'places_areas', geomType: 'polygon', group: 'landuse', title: 'Place Areas',  attributes: ['fid', 'name', 'fclass'], minzoom: 10, maxzoom: 22, lowZoomFilter: null },

  // --- hydrology / nature ---
  { id: 'water_areas',     table: 'water_areas',     geomType: 'polygon', group: 'hydro', title: 'Water Bodies',    attributes: ['fid', 'name', 'fclass'], minzoom: 8,  maxzoom: 22, lowZoomFilter: null },
  { id: 'waterways',       table: 'waterways',       geomType: 'line',    group: 'hydro', title: 'Waterways',       attributes: ['fid', 'name', 'fclass'], minzoom: 8,  maxzoom: 22, lowZoomFilter: null },
  { id: 'protected_areas', table: 'protected_areas', geomType: 'polygon', group: 'hydro', title: 'Protected Areas', attributes: ['fid', 'fclass'],         minzoom: 6,  maxzoom: 22, lowZoomFilter: null },
  { id: 'natural_areas',   table: 'natural_areas',   geomType: 'polygon', group: 'hydro', title: 'Natural Areas',   attributes: ['fid', 'name', 'fclass'], minzoom: 8,  maxzoom: 22, lowZoomFilter: null },

  // --- transport ---
  { id: 'roads',    table: 'roads',    geomType: 'line', group: 'transport', title: 'Roads',    attributes: ['fid', 'name', 'fclass', 'ref', 'oneway'], minzoom: 8,  maxzoom: 22,
    lowZoomFilter: { maxZoom: 12, where: "fclass IN ('motorway','trunk','primary','secondary')" } },
  { id: 'railways', table: 'railways', geomType: 'line', group: 'transport', title: 'Railways', attributes: ['fid', 'name', 'fclass'], minzoom: 8, maxzoom: 22, lowZoomFilter: null },

  // --- structures (dense — high zoom only) ---
  { id: 'buildings',              table: 'buildings',              geomType: 'polygon', group: 'structures', title: 'Buildings',          attributes: ['fid', 'name', 'fclass', 'type'], minzoom: 14, maxzoom: 22, lowZoomFilter: null },
  { id: 'traffic_areas',          table: 'traffic_areas',          geomType: 'polygon', group: 'structures', title: 'Traffic Areas',      attributes: ['fid', 'name', 'fclass'],         minzoom: 13, maxzoom: 22, lowZoomFilter: null },
  { id: 'transport_areas',        table: 'transport_areas',        geomType: 'polygon', group: 'structures', title: 'Transport Areas',    attributes: ['fid', 'name', 'fclass'],         minzoom: 13, maxzoom: 22, lowZoomFilter: null },
  { id: 'pois_areas',             table: 'pois_areas',             geomType: 'polygon', group: 'structures', title: 'POI Areas',          attributes: ['fid', 'name', 'fclass'],         minzoom: 13, maxzoom: 22, lowZoomFilter: null },
  { id: 'places_of_worship_areas', table: 'places_of_worship_areas', geomType: 'polygon', group: 'structures', title: 'Worship Areas',    attributes: ['fid', 'name', 'fclass'],         minzoom: 13, maxzoom: 22, lowZoomFilter: null },

  // --- points of interest ---
  { id: 'places_points',            table: 'places_points',            geomType: 'point', group: 'poi', title: 'Places',           attributes: ['fid', 'name', 'fclass', 'population'], minzoom: 6,  maxzoom: 22, lowZoomFilter: null },
  { id: 'pois_points',              table: 'pois_points',              geomType: 'point', group: 'poi', title: 'Points of Interest', attributes: ['fid', 'name', 'fclass'],            minzoom: 13, maxzoom: 22, lowZoomFilter: null },
  { id: 'traffic_points',           table: 'traffic_points',           geomType: 'point', group: 'poi', title: 'Traffic Points',   attributes: ['fid', 'name', 'fclass'],              minzoom: 14, maxzoom: 22, lowZoomFilter: null },
  { id: 'transport_points',         table: 'transport_points',         geomType: 'point', group: 'poi', title: 'Transport Points', attributes: ['fid', 'name', 'fclass'],              minzoom: 13, maxzoom: 22, lowZoomFilter: null },
  { id: 'natural_points',           table: 'natural_points',           geomType: 'point', group: 'poi', title: 'Natural Points',   attributes: ['fid', 'name', 'fclass'],              minzoom: 13, maxzoom: 22, lowZoomFilter: null },
  { id: 'places_of_worship_points', table: 'places_of_worship_points', geomType: 'point', group: 'poi', title: 'Worship Points',   attributes: ['fid', 'name', 'fclass'],              minzoom: 13, maxzoom: 22, lowZoomFilter: null },
]

const BY_ID = new Map(LAYERS.map((l) => [l.id, l]))

/** @returns {SpatialLayer|undefined} */
function getLayer(id) {
  return BY_ID.get(id)
}

/** @returns {SpatialLayer[]} */
function allLayers() {
  return LAYERS
}

module.exports = { LAYERS, getLayer, allLayers, GEOM_COLUMN, GEOM_SRID }
