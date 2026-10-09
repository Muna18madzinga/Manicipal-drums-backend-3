-- 162: the spatial concept registry, and the spatial tests each development activity needs.
--
-- WHY. Spatial tables are named after their authority or their import (vungu_parcels, gweru_rivers, pois_areas), so a second
-- council would need a second set of names, and the code names them (docs/SPATIAL-MODEL-AUDIT-2026-10-09.md). A *concept*
-- is the thing in the world ("a cadastral parcel", "a watercourse"), with one generic, authority-free code that is also the
-- stable layer id. Tables are then SOURCES of a concept. This migration does not rename or move any table: it records, as
-- data, which concept each table serves, which table is the canonical one today, and which concepts have no data at all.
--
-- It also ties the development activities (migration 157) to space. Each activity asks different spatial questions of a
-- site (which zone, how far from a watercourse, does the lot have a frontage). Those tests are recorded here as PROPOSALS
-- (evidence_status 'proposed', no distances: the numbers are statutory or the council's to state) and the view
-- activity_spatial_gaps shows which have no data and which are not implemented.
--
-- The names and statuses below are a snapshot of 9 October 2026 (see the audit); scripts/verify-spatial-registry.js checks
-- that every geometry table in the database is classified, so the registry cannot silently fall behind.

CREATE TABLE IF NOT EXISTS public.spatial_concept (
  code             text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name             text NOT NULL,
  domain           text NOT NULL CHECK (domain IN ('admin', 'land', 'planning', 'basemap', 'infrastructure', 'survey', 'application', 'constraint', 'proposal')),
  geometry_kind    text NOT NULL CHECK (geometry_kind IN ('polygon', 'line', 'point', 'mixed')),
  -- available: usable as it is; partial: exists but incomplete, clipped or duplicated; missing: no data
  status           text NOT NULL CHECK (status IN ('available', 'partial', 'missing')),
  -- true when each row belongs to an authority, so the table needs an authority or a jurisdiction (migration 154 pattern)
  authority_scoped boolean NOT NULL DEFAULT FALSE,
  -- where the concept should live under the naming convention (docs/SPATIAL-NAMING-CONVENTION.md); NULL = stays in place
  target_relation  text,
  description      text,
  note             text
);

CREATE TABLE IF NOT EXISTS public.spatial_concept_source (
  relation     text PRIMARY KEY,                      -- schema.table (or schema.view) as it is today
  concept_code text NOT NULL REFERENCES public.spatial_concept (code) ON UPDATE CASCADE,
  -- canonical: what the application reads today; target: designed for the concept but not yet populated or used;
  -- source: feeds the concept but is not the one the application reads; derived: a view over another source;
  -- legacy: still read, to be retired; duplicate: overlaps another source
  role         text NOT NULL CHECK (role IN ('canonical', 'target', 'source', 'derived', 'legacy', 'duplicate')),
  note         text
);
CREATE INDEX IF NOT EXISTS spatial_concept_source_concept_idx ON public.spatial_concept_source (concept_code);

INSERT INTO public.spatial_concept (code, name, domain, geometry_kind, status, authority_scoped, target_relation, description, note) VALUES
  -- administrative boundaries (national, from the OCHA/ZIMSTAT COD-AB set; wards to be replaced by the ZEC delimitation)
  ('admin_country',    'Country',                       'admin',    'polygon', 'available', FALSE, 'admin.country',  'The national boundary.', NULL),
  ('admin_province',   'Province',                      'admin',    'polygon', 'available', FALSE, 'admin.province', 'Provinces.', NULL),
  ('admin_district',   'District',                      'admin',    'polygon', 'available', FALSE, 'admin.district', 'Districts (the COD-AB set has 91, including urban councils).', NULL),
  ('admin_ward',       'Ward',                          'admin',    'polygon', 'available', FALSE, 'admin.ward',     'Wards, identified by pcode; ward names are not unique (1,961 wards, 46 names).', 'public.wards holds the data; admin.ward is the designed home and is empty'),
  ('admin_village',    'Village',                       'admin',    'point',   'partial',   FALSE, 'admin.village',  'Villages within wards.', 'table exists, empty'),
  ('authority_area',   'Local authority jurisdiction',  'admin',    'polygon', 'partial',   TRUE,  'admin.authority_area', 'The area a local authority administers: the union of its wards, versioned.', 'local_authorities.jurisdiction exists and is empty; the boundaries in use are interim (the Gweru district, and a clip)'),
  ('chiefdom',         'Traditional authority area',    'admin',    'polygon', 'partial',   FALSE, 'admin.chiefdom', 'Chiefdoms, relevant to communal land.', 'only 5 features, from the Gweru legacy set'),
  -- land
  ('cadastral_parcel', 'Cadastral parcel',              'land',     'polygon', 'partial',   TRUE,  'land.parcel',    'A stand, farm or plot with a legal identity.', 'four competing tables; land.parcel is the designed one and is empty'),
  ('building',         'Building footprint',            'land',     'polygon', 'partial',   FALSE, 'basemap.building', 'Building outlines from the basemap extract.', 'no use or type for 99.5% of footprints; clipped to the Gweru area; 605 identical duplicates'),
  -- planning
  ('planning_zone',    'Planning zone',                 'planning', 'polygon', 'available', TRUE,  'spatial_planning.zone', 'A zone polygon belonging to a plan; its name and type come from the plan, not from the polygon.', '12 pairs of polygons overlap'),
  ('planning_project', 'Planning project or layout',    'planning', 'polygon', 'partial',   TRUE,  'spatial_planning.planning_project', 'A layout or project area linked to an application.', NULL),
  -- basemap (Geofabrik/OSM schema: fid, osm_id, code, fclass, name)
  ('road',             'Road',                          'basemap',  'line',    'partial',   FALSE, 'basemap.road',      'Road centrelines with a functional class (fclass).', 'no road reserve width; names on 1% of roads; clipped'),
  ('railway',          'Railway',                       'basemap',  'line',    'available', FALSE, 'basemap.railway',   'Railway lines.', NULL),
  ('watercourse',      'River and stream',              'basemap',  'line',    'partial',   FALSE, 'basemap.watercourse', 'Rivers, streams and canals.', 'width is 0 (unknown) for every feature'),
  ('waterbody',        'Lake, dam and reservoir',       'basemap',  'polygon', 'available', FALSE, 'basemap.waterbody',  'Standing water.', 'some dams are classed under traffic in the source'),
  ('protected_area',   'Protected area',                'constraint', 'polygon', 'partial', FALSE, 'basemap.protected_area', 'National parks and nature reserves.', 'two features, one a duplicate of the other with a different class'),
  ('natural_feature',  'Natural feature',               'basemap',  'mixed',   'partial',   FALSE, 'basemap.natural_feature', 'Cliffs, springs, trees and similar.', 'sparse: 2 points, 0 areas'),
  ('landuse',          'Existing land use',             'basemap',  'polygon', 'partial',   FALSE, 'basemap.landuse',   'Land use polygons from the basemap (residential, farmland, industrial ...).', '121 polygons: coarse'),
  ('place',            'Named place',                   'basemap',  'point',   'partial',   FALSE, 'basemap.place',     'Villages, hamlets, business centres.', 'population is 0 (unknown)'),
  ('point_of_interest','Point of interest',             'basemap',  'mixed',   'available', FALSE, 'basemap.poi',       'Schools, clinics, towers, worship and other facilities.', 'the source splits these into areas and points'),
  ('transport_feature','Transport feature',             'basemap',  'mixed',   'partial',   FALSE, 'basemap.transport_feature', 'Railway crossings, stations, airports, parking, fuel, street lamps.', NULL),
  -- infrastructure the council holds
  ('cemetery',         'Cemetery',                      'infrastructure', 'polygon', 'partial', TRUE, 'council_ops.cemetery', 'Burial grounds.', 'one polygon, Vungu only'),
  ('waste_facility',   'Waste management site',         'infrastructure', 'polygon', 'partial', TRUE, 'council_ops.waste_facility', 'Landfills and similar.', NULL),
  ('council_asset',    'Council asset',                 'infrastructure', 'mixed', 'partial',   TRUE, 'council_ops.council_asset', 'Water and sanitation points, livestock facilities, road structures.', 'mostly empty'),
  ('council_road_asset','Council road asset',           'infrastructure', 'line',  'partial',   TRUE, 'council_ops.road_asset', 'The council road register, with condition data.', 'empty'),
  -- records of cases
  ('case_location',    'Location of a case',            'application', 'point', 'available',    TRUE, NULL, 'Where an application, order, complaint, inspection or sample is.', 'stays in each case table (location)'),
  ('managed_feature',  'User-edited feature',           'application', 'mixed', 'partial',      TRUE, NULL, 'Features drawn and edited in the portal.', NULL),
  ('survey_control_point','Survey control point',       'survey',   'point',   'partial',      FALSE, 'survey.coordinate_points', 'Control points and survey coordinates (CRS 22291, Cape datum).', 'a separate schema per surveyor exists and should not'),
  ('surveyed_parcel',  'Surveyed parcel',               'survey',   'polygon', 'partial',      FALSE, 'survey.land_parcels', 'Lots from a survey project.', NULL),
  -- constraints and proposals the activities need but nothing holds yet
  ('flood_zone',       'Flood-prone area',              'constraint', 'polygon', 'missing', FALSE, 'constraint.flood_zone', 'Land liable to flooding.', NULL),
  ('heritage_site',    'Heritage site',                 'constraint', 'mixed',   'missing', FALSE, 'constraint.heritage_site', 'Protected monuments and sites.', NULL),
  ('utility_servitude','Servitude or utility corridor', 'constraint', 'line',    'missing', FALSE, 'constraint.utility_servitude', 'Power lines, pipelines and their servitudes.', NULL),
  ('terrain',          'Terrain and slope',             'constraint', 'mixed',   'missing', FALSE, 'basemap.terrain', 'Elevation or slope (a DEM).', 'the code states there is no elevation layer'),
  ('proposed_site_plan','Applicant''s site plan',       'proposal', 'polygon',   'missing', TRUE,  'spatial_planning.proposed_site_plan', 'The footprint and boundaries the applicant proposes, as geometry.', 'an application records a point, not a footprint'),
  ('proposed_subdivision_layout','Applicant''s subdivision layout','proposal','polygon','missing', TRUE, 'spatial_planning.proposed_subdivision_layout', 'The lots the applicant proposes.', 'survey layouts exist as records without geometry'),
  ('proposed_zone_boundary','Proposed zone boundary',   'proposal', 'polygon',   'missing', TRUE,  'spatial_planning.proposed_zone_boundary', 'The area a rezoning application asks to change.', NULL)
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.spatial_concept_source (relation, concept_code, role, note) VALUES
  ('public.country',                 'admin_country',   'canonical', NULL),
  ('public.provinces',               'admin_province',  'canonical', NULL),
  ('public.districts',               'admin_district',  'canonical', NULL),
  ('public.admin_areas',             'admin_district',  'duplicate', 'OSM administrative boundaries (levels 4 and 6, 11 features); overlaps provinces and districts'),
  ('public.wards',                   'admin_ward',      'canonical', '1,961 wards from the COD-AB set; to be replaced by the ZEC delimitation (1,970)'),
  ('admin.ward',                     'admin_ward',      'target',    'designed home, empty'),
  ('admin.village',                  'admin_village',   'target',    'empty'),
  ('public.local_authorities',       'authority_area',  'target',    'the jurisdiction column, empty'),
  ('public.gweru_rural_planning_boundary', 'authority_area', 'legacy', 'interim boundary: the Gweru district, not Vungu RDC'),
  ('public.vungu_clip_boundary',     'authority_area',  'legacy',    'the clip used to cut the basemap extract'),
  ('public.gweru_chiefdoms',         'chiefdom',        'canonical', '5 features'),
  ('public.stands',                  'cadastral_parcel','source',    'urban stands, 20 rows, with allocation data'),
  ('public.v_stands',                'cadastral_parcel','derived',   'view over stands'),
  ('public.stands_tile_view',        'cadastral_parcel','derived',   'view over stands for the tile server'),
  ('public.vungu_parcels',           'cadastral_parcel','canonical', '733 parcels read by the parcel-zoning engine; attributes are text, areas stored four times and disagree with the geometry'),
  ('public.vungu_farm_cadastre',     'cadastral_parcel','duplicate', 'near-duplicate of vungu_parcels from the same extract'),
  ('public.gweru_rural_farms',       'cadastral_parcel','legacy',    'working farm register mixing shape, owner, title deed and compliance; its zone_id points at a retired table'),
  ('land.parcel',                    'cadastral_parcel','target',    'the designed model (validity dates, CRS, accuracy, ward key); empty'),
  ('public.buildings',               'building',        'canonical', '139,619 footprints'),
  ('land.building',                  'building',        'target',    'designed as building records on a parcel; empty'),
  ('public.proposed_peri_urban_zones','planning_zone',  'canonical', '36 polygons, linked to a plan and zone type'),
  ('public.zones_master',            'planning_zone',   'derived',   'view over proposed_peri_urban_zones for the map'),
  ('public.vungu_beyond_peri_urban_zones','planning_zone','source',  '16 polygons outside the peri-urban zones; not linked to a plan'),
  ('public.gweru_peri_urban_zone',   'planning_zone',   'legacy',    'old zone table, mostly duplicate; to be retired after the farm zone remap'),
  ('spatial_planning.planning_project','planning_project','canonical', NULL),
  ('spatial_planning.statutory_plan','planning_project','source',    'plan boundaries; empty'),
  ('public.roads',                   'road',            'canonical', '2,876 centrelines'),
  ('public.railways',                'railway',         'canonical', NULL),
  ('public.waterways',               'watercourse',     'canonical', NULL),
  ('public.water_areas',             'waterbody',       'canonical', NULL),
  ('public.protected_areas',         'protected_area',  'canonical', NULL),
  ('public.natural_areas',           'natural_feature', 'canonical', 'empty'),
  ('public.natural_points',          'natural_feature', 'source',    NULL),
  ('public.landuse',                 'landuse',         'canonical', NULL),
  ('public.places_areas',            'place',           'canonical', 'empty'),
  ('public.places_points',           'place',           'source',    NULL),
  ('public.places',                  'place',           'legacy',    'empty'),
  ('public.gweru_business_centres',  'place',           'source',    '67 points'),
  ('public.pois_areas',              'point_of_interest','canonical', NULL),
  ('public.pois_points',             'point_of_interest','source',   NULL),
  ('public.places_of_worship_areas', 'point_of_interest','source',   'worship, as areas'),
  ('public.places_of_worship_points','point_of_interest','source',   'worship, as points'),
  ('public.gweru_health_centres',    'point_of_interest','legacy',   'empty'),
  ('public.traffic_areas',           'transport_feature','canonical', 'includes dams and parking'),
  ('public.traffic_points',          'transport_feature','source',   'railway crossings, street lamps, fuel'),
  ('public.transport_areas',         'transport_feature','source',   NULL),
  ('public.transport_points',        'transport_feature','source',   'stations and an airport'),
  ('public.gweru_rivers',            'watercourse',     'source',    '260 features, a different dataset from waterways'),
  ('public.vungu_cemeteries',        'cemetery',        'canonical', NULL),
  ('public.vungu_waste_management',  'waste_facility',  'canonical', NULL),
  ('council_ops.council_asset',      'council_asset',   'canonical', NULL),
  ('council_ops.livestock_facility', 'council_asset',   'source',    NULL),
  ('council_ops.road_structure',     'council_asset',   'source',    NULL),
  ('council_ops.wash_asset',         'council_asset',   'source',    '6 rows'),
  ('council_ops.road_asset',         'council_road_asset','canonical', 'empty'),
  ('spatial_planning.permit_application','case_location','source',   'the location column'),
  ('spatial_planning.enforcement_order','case_location','source',    NULL),
  ('spatial_planning.prohibition_order','case_location','source',    NULL),
  ('spatial_planning.health_premises','case_location',  'source',    NULL),
  ('spatial_planning.health_premises_inspection','case_location','source', NULL),
  ('spatial_planning.health_nuisance_complaint','case_location','source', NULL),
  ('spatial_planning.health_outbreak','case_location',  'source',    NULL),
  ('spatial_planning.health_water_sample','case_location','source',  NULL),
  ('spatial_planning.health_field_programme','case_location','source', NULL),
  ('spatial_planning.survey_task',   'case_location',   'source',    NULL),
  ('spatial_planning.spatial_analysis_result','case_location','source', 'never written by the code'),
  ('spatial_planning.gis_feature',   'managed_feature', 'canonical', NULL),
  ('spatial_planning.gis_feature_history','managed_feature','source', 'append-only history, no spatial index'),
  ('public.layer_data',              'managed_feature', 'legacy',    'generic uploaded features'),
  ('survey.coordinate_points',       'survey_control_point','canonical', NULL),
  ('survey.coordinate_points_full',  'survey_control_point','derived',   NULL),
  ('survey.land_parcels',            'surveyed_parcel', 'canonical', NULL),
  ('survey.land_parcels_full',       'surveyed_parcel', 'derived',   NULL),
  ('survey.area_parcels',            'surveyed_parcel', 'derived',   NULL),
  ('survey.features',                'managed_feature', 'source',    NULL)
ON CONFLICT (relation) DO NOTHING;

-- ---- the spatial tests each development activity needs -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.activity_spatial_test (
  activity_code   text NOT NULL REFERENCES public.development_activity (code) ON UPDATE CASCADE ON DELETE CASCADE,
  test_code       text NOT NULL CHECK (test_code ~ '^[a-z][a-z0-9_]*$'),
  concept_code    text NOT NULL REFERENCES public.spatial_concept (code) ON UPDATE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('locate', 'within', 'intersects', 'clearance', 'adjacency', 'frontage', 'area', 'coverage', 'slope')),
  -- the distance or limit, where one applies. NULL here: statutory values and the council's own are theirs to state.
  distance_m      numeric,
  severity        text NOT NULL CHECK (severity IN ('blocks', 'flags', 'informs')),
  description     text NOT NULL,
  implemented     boolean NOT NULL DEFAULT FALSE,
  implemented_in  text,
  evidence_status text NOT NULL DEFAULT 'proposed' CHECK (evidence_status IN ('proposed', 'secondary_source', 'confirmed')),
  PRIMARY KEY (activity_code, test_code)
);

INSERT INTO public.activity_spatial_test (activity_code, test_code, concept_code, kind, severity, description, implemented, implemented_in) VALUES
  -- new building
  ('new_building', 'locate_parcel',        'cadastral_parcel', 'locate',     'blocks',  'Find the parcel the application concerns.', TRUE, 'resolve_stand_parcel, lodge_permit_zoning'),
  ('new_building', 'locate_zone',          'planning_zone',    'locate',     'blocks',  'Find the zone, and the plan it belongs to, that governs the parcel.', TRUE, 'parcel_zoning_for, rule_snapshot'),
  ('new_building', 'footprint_in_parcel',  'proposed_site_plan','within',    'flags',   'The proposed footprint lies inside the parcel.', FALSE, NULL),
  ('new_building', 'setbacks',             'proposed_site_plan','clearance', 'flags',   'Distance from the footprint to each boundary against the zone''s setback standards.', FALSE, NULL),
  ('new_building', 'coverage',             'proposed_site_plan','coverage',  'flags',   'Footprint area as a share of the parcel against the zone''s coverage standard.', FALSE, NULL),
  ('new_building', 'watercourse_clearance','watercourse',      'clearance',  'flags',   'Distance from the footprint to a river or stream.', FALSE, 'the Planning Studio uses a fixed 30 m constant in code (planningSpatial.js)'),
  ('new_building', 'waterbody_clearance',  'waterbody',        'clearance',  'flags',   'Distance from the footprint to a dam or lake.', FALSE, NULL),
  ('new_building', 'protected_area',       'protected_area',   'intersects', 'flags',   'The parcel or footprint touches a protected area.', FALSE, 'the Planning Studio treats it as no-go (planningSpatial.js)'),
  ('new_building', 'road_access',          'road',             'frontage',   'flags',   'The parcel has access to a road of a suitable class.', FALSE, NULL),
  ('new_building', 'railway_clearance',    'railway',          'clearance',  'flags',   'Distance from the footprint to a railway.', FALSE, NULL),
  ('new_building', 'cemetery_clearance',   'cemetery',         'clearance',  'flags',   'Distance from the footprint to a cemetery.', FALSE, NULL),
  ('new_building', 'flood_risk',           'flood_zone',       'intersects', 'flags',   'The parcel lies in a flood-prone area.', FALSE, NULL),
  ('new_building', 'heritage',             'heritage_site',    'clearance',  'flags',   'The parcel is on or near a heritage site.', FALSE, NULL),
  ('new_building', 'servitude',            'utility_servitude','intersects', 'flags',   'The footprint crosses a power-line or pipeline servitude.', FALSE, NULL),
  ('new_building', 'slope',                'terrain',          'slope',      'informs', 'Slope of the site.', FALSE, NULL),
  ('new_building', 'notify_neighbours',    'cadastral_parcel', 'adjacency',  'informs', 'The parcels that touch this one, whose owners are told when the decision is special consent.', FALSE, 'the pathway records adjacent_owners_notified as a flag only'),
  -- extension
  ('extension', 'locate_zone',             'planning_zone',    'locate',     'blocks',  'Find the zone and plan that govern the parcel.', TRUE, 'parcel_zoning_for, rule_snapshot'),
  ('extension', 'existing_building',       'building',         'coverage',   'informs', 'Footprint already on the parcel, so coverage includes it.', FALSE, NULL),
  ('extension', 'footprint_in_parcel',     'proposed_site_plan','within',    'flags',   'The extended footprint lies inside the parcel.', FALSE, NULL),
  ('extension', 'setbacks',                'proposed_site_plan','clearance', 'flags',   'Distance from the extended footprint to each boundary.', FALSE, NULL),
  ('extension', 'coverage',                'proposed_site_plan','coverage',  'flags',   'Total coverage after the extension.', FALSE, NULL),
  -- alteration
  ('alteration', 'locate_zone',            'planning_zone',    'locate',     'blocks',  'Find the zone and plan that govern the parcel.', TRUE, 'parcel_zoning_for, rule_snapshot'),
  ('alteration', 'existing_building',      'building',         'locate',     'informs', 'The building being altered.', FALSE, NULL),
  -- change of use
  ('change_of_use', 'locate_parcel',       'cadastral_parcel', 'locate',     'blocks',  'Find the parcel the application concerns.', TRUE, 'resolve_stand_parcel, lodge_permit_zoning'),
  ('change_of_use', 'locate_zone',         'planning_zone',    'locate',     'blocks',  'Find the zone and plan that govern the parcel.', TRUE, 'parcel_zoning_for, rule_snapshot'),
  ('change_of_use', 'existing_use',        'landuse',          'locate',     'informs', 'The use the land has today, to compare with the one proposed.', FALSE, NULL),
  ('change_of_use', 'notify_neighbours',   'cadastral_parcel', 'adjacency',  'informs', 'The parcels that touch this one, whose owners are told when the decision is special consent.', FALSE, NULL),
  -- subdivision
  ('subdivision', 'locate_parcel',         'cadastral_parcel', 'locate',     'blocks',  'Find the parcel being subdivided.', TRUE, 'resolve_stand_parcel, lodge_permit_zoning'),
  ('subdivision', 'locate_zone',           'planning_zone',    'locate',     'blocks',  'Find the zone and plan that govern the parcel.', TRUE, 'parcel_zoning_for, rule_snapshot'),
  ('subdivision', 'lots_in_parcel',        'proposed_subdivision_layout','within', 'flags', 'The proposed lots lie inside the parcel and do not overlap.', FALSE, NULL),
  ('subdivision', 'lot_area',              'proposed_subdivision_layout','area',  'flags',  'Each lot''s area against the zone''s minimum stand area.', FALSE, NULL),
  ('subdivision', 'lot_frontage',          'road',             'frontage',   'flags',   'Each lot''s frontage on a road against the zone''s minimum frontage.', FALSE, NULL),
  ('subdivision', 'watercourse_clearance', 'watercourse',      'clearance',  'flags',   'Lots against the clearance from a river or stream.', FALSE, NULL),
  ('subdivision', 'flood_risk',            'flood_zone',       'intersects', 'flags',   'Lots in a flood-prone area.', FALSE, NULL),
  ('subdivision', 'notify_neighbours',     'cadastral_parcel', 'adjacency',  'informs', 'The parcels that touch this one, whose owners are told when the decision is special consent.', FALSE, NULL),
  -- consolidation
  ('consolidation', 'locate_parcels',      'cadastral_parcel', 'locate',     'blocks',  'Find every parcel to be merged.', FALSE, NULL),
  ('consolidation', 'parcels_touch',       'cadastral_parcel', 'adjacency',  'blocks',  'The parcels are contiguous.', FALSE, NULL),
  ('consolidation', 'same_zone',           'planning_zone',    'locate',     'flags',   'The parcels fall in the same zone.', FALSE, NULL),
  ('consolidation', 'combined_area',       'cadastral_parcel', 'area',       'flags',   'The combined area against the zone''s maximum stand area.', FALSE, NULL),
  -- rezoning
  ('rezoning', 'locate_zone',              'planning_zone',    'locate',     'informs', 'The zone the land is in today.', TRUE, 'parcel_zoning_for'),
  ('rezoning', 'proposed_boundary',        'proposed_zone_boundary','within', 'flags',  'The area asked to change, and what it overlaps.', FALSE, NULL),
  ('rezoning', 'affected_parcels',         'cadastral_parcel', 'intersects', 'informs', 'The parcels inside and beside the area, whose owners must be told.', FALSE, NULL)
ON CONFLICT (activity_code, test_code) DO NOTHING;

-- ---- views ------------------------------------------------------------------------------------------------------
-- Each concept with how many sources it has, and which one the application reads.
CREATE OR REPLACE VIEW public.spatial_concept_summary WITH (security_invoker = true) AS
SELECT c.code, c.name, c.domain, c.status, c.authority_scoped, c.target_relation,
       count(s.*)::int                                                         AS sources,
       max(s.relation) FILTER (WHERE s.role = 'canonical')                     AS canonical_relation,
       count(*) FILTER (WHERE s.role IN ('duplicate', 'legacy'))::int          AS to_retire
  FROM public.spatial_concept c
  LEFT JOIN public.spatial_concept_source s ON s.concept_code = c.code
 GROUP BY c.code;

-- Each spatial test with whether its data exists and whether anything performs it.
CREATE OR REPLACE VIEW public.activity_spatial_gaps WITH (security_invoker = true) AS
SELECT t.activity_code, a.name AS activity, t.test_code, t.kind, t.severity, t.concept_code, c.name AS concept,
       c.status AS data_status, t.implemented, t.implemented_in,
       CASE WHEN t.implemented THEN 'done'
            WHEN c.status = 'missing' THEN 'no data'
            WHEN c.status = 'partial' THEN 'data is partial'
            ELSE 'data exists, not built' END AS gap
  FROM public.activity_spatial_test t
  JOIN public.development_activity a ON a.code = t.activity_code
  JOIN public.spatial_concept c ON c.code = t.concept_code;

GRANT SELECT ON public.spatial_concept, public.spatial_concept_source, public.activity_spatial_test,
                public.spatial_concept_summary, public.activity_spatial_gaps TO vungu_app;
