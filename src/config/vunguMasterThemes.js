/**
 * Vungu Master Plan / Study map themes (33+).
 * Each theme is a real operational catalogue entry.
 * status: live = PostGIS layer exists in spatialLayers; schema_ready = table
 * reserved for import; unavailable = not yet loaded — NEVER fabricate geometry.
 */
const { allLayers } = require('./spatialLayers')

/** @typedef {'live'|'schema_ready'|'unavailable'|'reference_osm'|'partial'} ThemeStatus */

/**
 * @type {Array<{
 *   id: string
 *   theme: string
 *   department: string
 *   category: string
 *   layerIds: string[]
 *   status: ThemeStatus
 *   note: string
 * }>}
 */
const MASTER_THEMES = [
  { id: 'admin-boundary', theme: 'Vungu RDC boundary / districts', department: 'Planning & Environment', category: 'Administrative', layerIds: ['districts', 'country'], status: 'live', note: 'District and country polygons from operational tiles.' },
  { id: 'wards', theme: 'Wards / ward boundaries', department: 'Planning & Environment', category: 'Administrative', layerIds: ['wards'], status: 'live', note: 'Authoritative ward polygons when loaded in PostGIS.' },
  { id: 'chiefdoms', theme: 'Chiefdoms / headman areas', department: 'Governance', category: 'Administrative', layerIds: [], status: 'unavailable', note: 'Schema reserved — import council chiefdom layer; do not invent boundaries.' },
  { id: 'area-committees', theme: 'Area committees', department: 'Governance', category: 'Administrative', layerIds: [], status: 'unavailable', note: 'Awaiting council GIS delivery.' },
  { id: 'peri-urban', theme: 'Peri-urban / Gweru interface', department: 'Planning & Environment', category: 'Planning', layerIds: ['vungu_proposed_peri_urban_zones'], status: 'live', note: 'Master-plan peri-urban zones where published.' },
  { id: 'landuse', theme: 'Land uses', department: 'Planning & Environment', category: 'Land Use', layerIds: ['landuse', 'admin_areas', 'places_areas'], status: 'live', note: 'Includes OSM-derived landuse as reference; Vungu farm/parcel overlays where present.' },
  { id: 'parcels', theme: 'Parcels / stands', department: 'Planning & Environment', category: 'Land', layerIds: ['vungu_parcels', 'stands', 'vungu_farm_cadastre'], status: 'live', note: 'Council operational cadastre references — not Deeds title.' },
  { id: 'zoning', theme: 'Zoning / planning zones', department: 'Planning & Environment', category: 'Planning', layerIds: ['vungu_proposed_peri_urban_zones'], status: 'live', note: 'Published zone layers only.' },
  { id: 'settlements', theme: 'Settlements / villages / growth points', department: 'Planning & Environment', category: 'Settlement', layerIds: ['places_points', 'places_areas'], status: 'reference_osm', note: 'Settlement points from catalogue; verify before statutory use.' },
  { id: 'roads', theme: 'Roads / road hierarchy', department: 'Roads & Works', category: 'Transport', layerIds: ['roads'], status: 'reference_osm', note: 'Road centreline reference. Works asset register is separate (ops module).' },
  { id: 'rail', theme: 'Railway', department: 'Roads & Works', category: 'Transport', layerIds: ['railways'], status: 'reference_osm', note: 'Reference railway geometry.' },
  { id: 'bridges', theme: 'Bridges / culverts / causeways', department: 'Roads & Works', category: 'Transport', layerIds: [], status: 'schema_ready', note: 'Use council_ops.road_structure after import.' },
  { id: 'rivers', theme: 'Rivers / streams / catchments', department: 'WASH / Environment', category: 'Water', layerIds: ['waterways', 'water_areas'], status: 'live', note: 'Hydrology from operational catalogue.' },
  { id: 'boreholes', theme: 'Boreholes / water points / schemes', department: 'DSSWC / WASH', category: 'WASH', layerIds: [], status: 'schema_ready', note: 'Use council_ops.wash_asset — import DSSWC inventory.' },
  { id: 'sanitation', theme: 'Sanitation / waste sites', department: 'WASH / Environment', category: 'WASH', layerIds: ['vungu_waste_management'], status: 'live', note: 'Waste management polygons where published; toilets/septic await import.' },
  { id: 'wetlands', theme: 'Wetlands / flood-prone / ESA', department: 'Environment', category: 'Environment', layerIds: ['water_areas', 'protected_areas', 'natural_areas'], status: 'live', note: 'Protected and natural overlays; formal flood model not claimed.' },
  { id: 'vegetation', theme: 'Vegetation / forests / soils', department: 'Environment', category: 'Environment', layerIds: ['natural_areas', 'natural_points'], status: 'reference_osm', note: 'Natural features reference — soils layer unavailable until imported.' },
  { id: 'pollution', theme: 'Pollution / degradation', department: 'Environment', category: 'Environment', layerIds: [], status: 'unavailable', note: 'Environmental monitoring points not loaded.' },
  { id: 'mining', theme: 'Mining / claims / degradation', department: 'Environment / Mining', category: 'Mining', layerIds: [], status: 'unavailable', note: 'Do not invent mining claims.' },
  { id: 'irrigation', theme: 'Irrigation / gardens / agricultural schemes', department: 'Agriculture', category: 'Agriculture', layerIds: [], status: 'unavailable', note: 'Awaiting agricultural scheme GIS.' },
  { id: 'dip-tanks', theme: 'Dip tanks / stock pens / watering points', department: 'Agriculture', category: 'Agriculture', layerIds: [], status: 'schema_ready', note: 'council_ops.livestock_facility ready for import.' },
  { id: 'schools', theme: 'Schools / ECD / education', department: 'Social Services', category: 'Social', layerIds: ['pois_points', 'pois_areas'], status: 'reference_osm', note: 'Filter POI education classes; dedicated school register pending.' },
  { id: 'health', theme: 'Clinics / health facilities', department: 'Social Services', category: 'Social', layerIds: ['pois_points'], status: 'reference_osm', note: 'Health POIs as reference until MoHCC/council register imported.' },
  { id: 'telecoms', theme: 'Telecoms / towers / coverage', department: 'LED / ICT', category: 'Telecoms', layerIds: [], status: 'unavailable', note: 'No authoritative tower layer loaded.' },
  { id: 'heritage', theme: 'Heritage / recreation / tourism', department: 'LED / Culture', category: 'Heritage', layerIds: ['vungu_cemeteries'], status: 'partial', note: 'Cemeteries live; heritage sites unavailable.' },
  { id: 'business', theme: 'Businesses / markets / LED', department: 'LED', category: 'Economy', layerIds: [], status: 'unavailable', note: 'LED database spatial link pending.' },
  { id: 'council-facilities', theme: 'Council offices / facilities', department: 'Administration', category: 'Assets', layerIds: [], status: 'schema_ready', note: 'council_ops.council_asset ready for import.' },
  { id: 'projects', theme: 'Council projects', department: 'Management', category: 'Projects', layerIds: [], status: 'unavailable', note: 'Project map module Phase 2.' },
]

function resolveThemeStatus(theme, liveLayerIds) {
  if (!theme.layerIds.length) return theme.status
  const anyLive = theme.layerIds.some((id) => liveLayerIds.has(id))
  if (anyLive && (theme.status === 'live' || theme.status === 'reference_osm' || theme.status === 'partial')) {
    return theme.status
  }
  if (anyLive) return 'live'
  return theme.status === 'schema_ready' ? 'schema_ready' : 'unavailable'
}

function getMasterThemeCatalogue() {
  const live = new Set(allLayers().map((l) => l.id))
  return MASTER_THEMES.map((t) => ({
    ...t,
    status: resolveThemeStatus(t, live),
    layersPresent: t.layerIds.filter((id) => live.has(id)),
  }))
}

module.exports = { MASTER_THEMES, getMasterThemeCatalogue }
