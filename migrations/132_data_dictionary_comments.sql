-- Migration 132: data dictionary — a description on every schema, table and view
--
-- After 130/131 every table has one purpose; this migration writes that purpose
-- into the catalogue so pgAdmin, DBeaver, QGIS (layer abstract) and
-- `\dt+` / `\dv+` show it. docs/DATABASE.md is generated from these comments
-- (node scripts/generate-data-dictionary.js).
--
-- Only objects WITHOUT a comment are written — hand-written comments from
-- earlier migrations are kept. Absent objects (dump-only tables on a
-- migrations-only database) are skipped.
--
-- IDEMPOTENT: re-running changes nothing.

BEGIN;

CREATE FUNCTION pg_temp.doc(p_obj text, p_comment text) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  v_oid  regclass := to_regclass(p_obj);
  v_kind char;
BEGIN
  IF v_oid IS NULL OR obj_description(v_oid, 'pg_class') IS NOT NULL THEN
    RETURN;
  END IF;
  SELECT relkind INTO v_kind FROM pg_class WHERE oid = v_oid;
  EXECUTE format('COMMENT ON %s %s IS %L',
                 CASE v_kind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
                 v_oid, p_comment);
END $fn$;

CREATE FUNCTION pg_temp.doc_schema(p_schema text, p_comment text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  -- 'standard public schema' is PostgreSQL's placeholder, not a description.
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = p_schema)
     AND COALESCE(obj_description((SELECT oid FROM pg_namespace WHERE nspname = p_schema), 'pg_namespace'),
                  'standard public schema') = 'standard public schema' THEN
    EXECUTE format('COMMENT ON SCHEMA %I IS %L', p_schema, p_comment);
  END IF;
END $fn$;

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------
SELECT pg_temp.doc_schema('public',           'Identity & access, payments, notifications, GIS layer/style registry, stands register, zones, and the PostGIS basemap (admin boundaries, OSM, imported cadastre).');
SELECT pg_temp.doc_schema('spatial_planning', 'Development control case file (RTCP Act): permit applications and everything hanging off them — consultation, objections, committee, decisions, building plans, stage inspections, enforcement, survey tasks, environmental health.');
SELECT pg_temp.doc_schema('planning_clerk',   'Planning clerk statutory registers: acknowledgement/refusal letters, notices, receipts, dispatch, correspondence.');
SELECT pg_temp.doc_schema('council_ops',      'Council operations asset registers (roads, WASH, buildings, livestock facilities) and the service desk.');
SELECT pg_temp.doc_schema('survey',           'Survey Task Manager: surveyor accounts/profiles, survey projects, coordinate imports, land parcels, national trig control points.');
SELECT pg_temp.doc_schema('surveyor_surveyor_demo_surveyor', 'Per-surveyor isolated workspace created by survey.migrate_surveyor_to_schema() (one schema per registered surveyor).');

-- ---------------------------------------------------------------------------
-- public — identity & access
-- ---------------------------------------------------------------------------
SELECT pg_temp.doc('public.users',              'Portal accounts (citizens and council staff). role -> ref.user_role, status -> ref.user_status; sign-in allowed only when status = ''active''.');
SELECT pg_temp.doc('public.invites',            'One-time staff invitation tokens (role -> ref.user_role).');
SELECT pg_temp.doc('public.citizen_documents',  'Citizen KYC / supporting documents with verification outcome.');
SELECT pg_temp.doc('public.analytics',          'Product analytics events (who did what, when).');
SELECT pg_temp.doc('public.schema_migrations',  'Applied migration files (scripts/migrate-render.js).');
SELECT pg_temp.doc('public.site_content',       'Editable public-site content blocks, keyed by slug.');
SELECT pg_temp.doc('public.local_authorities',  'Contact details of local planning authorities.');
SELECT pg_temp.doc('public.lands_registry_deeds',  'Deeds Registry extract used to verify title claims.');
SELECT pg_temp.doc('public.lands_registry_checks', 'Audit of title-deed verification lookups against lands_registry_deeds.');

-- public — legacy online application (pre permit_application)
SELECT pg_temp.doc('public.development_applications',   'Citizen online application wizard submissions (legacy intake; permit_application.dev_app_id links the formal case). status -> ref.application_status.');
SELECT pg_temp.doc('public.application_comments',       'Comments on a development_applications row.');
SELECT pg_temp.doc('public.application_documents',      'Documents attached to a development_applications row.');
SELECT pg_temp.doc('public.application_drafts',         'Unsubmitted application wizard drafts (JSON).');
SELECT pg_temp.doc('public.application_status_history', 'Status transitions of development_applications.');
SELECT pg_temp.doc('public.application_timeline',       'Human-readable timeline events of development_applications.');
SELECT pg_temp.doc('public.application_summary',        'Read model: development_applications with document counts.');
SELECT pg_temp.doc('public.plan_reviews',               'Uploaded building plans awaiting automated/staff review.');
SELECT pg_temp.doc('public.plan_review_findings',       'Findings raised against a plan_reviews upload (severity -> ref.finding_severity).');
SELECT pg_temp.doc('public.inspection_photos',          'Photos attached to an inspection_bookings visit.');
SELECT pg_temp.doc('public.inspection_status_events',   'Status transitions of inspection_bookings.');

-- public — money & messaging
SELECT pg_temp.doc('public.payments',  'Online payments through a gateway (payment_gateway), in USD with the ZWG equivalent at rate_used.');

-- public — stands, zones, land use
SELECT pg_temp.doc('public.proposed_peri_urban_zones', 'THE planning-zone table (master plan peri-urban zones). stands.zone_id and zone_land_use_controls.zone_id reference it. Served to tiles through zones_master.');
SELECT pg_temp.doc('public.zone_land_use_controls',    'Zone x land-use-group control matrix: permitted / prohibited / special consent (ref.land_use_control).');
SELECT pg_temp.doc('public.land_use_groups',           'Land-use groups used by the zone control matrix.');
SELECT pg_temp.doc('public.beyond_peri_urban_zones',   'Beyond-peri-urban settlement zones; ward_pcode -> wards. Tiles/QGIS read the view vungu_beyond_peri_urban_zones.');

-- public — GIS registry
SELECT pg_temp.doc('public.layers',              'User-defined map layers (features in layer_data).');
SELECT pg_temp.doc('public.layer_data',          'Features of a user-defined layer (layers).');
SELECT pg_temp.doc('public.spatial_layers',      'Catalogue of PostGIS tables exposed as dynamic GeoJSON layers (/api/dynamic-layers).');
SELECT pg_temp.doc('public.gis_style',           'Governed, versioned layer styles (status -> ref.style_status; one published per layer, published rows immutable).');
SELECT pg_temp.doc('public.gis_style_audit',     'Append-only audit trail of gis_style lifecycle events.');
SELECT pg_temp.doc('public.gis_published_style', 'Read model: each active gis_layer with its currently published style.');
SELECT pg_temp.doc('public.places',              'Gazetteer used by public place search.');

-- public — basemap: administrative boundaries (OCHA COD-AB)
SELECT pg_temp.doc('public.admin_areas', 'OSM administrative areas (Vungu clip).');

-- public — basemap: OpenStreetMap (Geofabrik), clipped to Vungu (fclass -> ref.osm_feature_class)
SELECT pg_temp.doc('public.buildings',                'OSM building footprints (Vungu clip).');
SELECT pg_temp.doc('public.roads',                    'OSM road centre-lines (Vungu clip).');
SELECT pg_temp.doc('public.railways',                 'OSM railways (Vungu clip).');
SELECT pg_temp.doc('public.waterways',                'OSM rivers/streams (Vungu clip).');
SELECT pg_temp.doc('public.water_areas',              'OSM water bodies (Vungu clip).');
SELECT pg_temp.doc('public.landuse',                  'OSM land-use polygons (Vungu clip).');
SELECT pg_temp.doc('public.natural_areas',            'OSM natural-feature polygons (Vungu clip).');
SELECT pg_temp.doc('public.natural_points',           'OSM natural-feature points (Vungu clip).');
SELECT pg_temp.doc('public.places_areas',             'OSM settlement polygons (Vungu clip).');
SELECT pg_temp.doc('public.places_points',            'OSM settlement points (Vungu clip).');
SELECT pg_temp.doc('public.places_of_worship_areas',  'OSM places of worship, polygons (Vungu clip).');
SELECT pg_temp.doc('public.places_of_worship_points', 'OSM places of worship, points (Vungu clip).');
SELECT pg_temp.doc('public.pois_areas',               'OSM points of interest, polygons (Vungu clip).');
SELECT pg_temp.doc('public.pois_points',              'OSM points of interest (Vungu clip).');
SELECT pg_temp.doc('public.traffic_areas',            'OSM traffic-related polygons (parking etc., Vungu clip).');
SELECT pg_temp.doc('public.traffic_points',           'OSM traffic points (signals, crossings, Vungu clip).');
SELECT pg_temp.doc('public.transport_areas',          'OSM transport polygons (stations, Vungu clip).');
SELECT pg_temp.doc('public.transport_points',         'OSM transport points (stops, Vungu clip).');
SELECT pg_temp.doc('public.protected_areas',          'OSM protected areas (Vungu clip).');

-- public — basemap: council / master-plan imports
SELECT pg_temp.doc('public.vungu_farm_cadastre',          'Vungu master plan: farm cadastre (whole farms), imported from the council GeoPackage.');
SELECT pg_temp.doc('public.vungu_parcels',                'Vungu master plan: subdivided parcels, imported from the council GeoPackage.');
SELECT pg_temp.doc('public.vungu_cemeteries',             'Vungu master plan: cemeteries.');
SELECT pg_temp.doc('public.vungu_waste_management',       'Vungu master plan: waste management sites.');
SELECT pg_temp.doc('public.gweru_rural_farms',            'Gweru rural farms with land-use compliance attributes (land-use management module).');
SELECT pg_temp.doc('public.gweru_rural_planning_boundary','Gweru rural district planning boundary.');
SELECT pg_temp.doc('public.gweru_rivers',                 'Gweru rural district rivers (QGIS project layer).');
SELECT pg_temp.doc('public.gweru_health_centres',         'Gweru rural district health facilities (MoHCC survey attributes).');
SELECT pg_temp.doc('public.gweru_business_centres',       'Gweru rural district business centres.');
SELECT pg_temp.doc('public.gweru_chiefdoms',              'Gweru rural district chiefdoms (QGIS project layer).');

-- ---------------------------------------------------------------------------
-- spatial_planning — the case file
-- ---------------------------------------------------------------------------
SELECT pg_temp.doc('spatial_planning.application_consultation', 'Circulation of an application to a statutory body and its response (consultee_body_type, consultation_response).');
SELECT pg_temp.doc('spatial_planning.application_objection',    'Objection lodged during the public-notice period and its consideration.');
SELECT pg_temp.doc('spatial_planning.application_appeal',       'Appeal against a planning decision (appeal_status, appeal_decision).');
SELECT pg_temp.doc('spatial_planning.available_stand',          'Stands advertised as available on the public portal.');
SELECT pg_temp.doc('spatial_planning.agenda_item',              'An application on a committee meeting agenda, with its resolution.');
SELECT pg_temp.doc('spatial_planning.meeting_attendance',       'Committee member attendance per meeting.');
SELECT pg_temp.doc('spatial_planning.document_request',         'Request to the applicant for additional documents.');
SELECT pg_temp.doc('spatial_planning.document_review',          'Officer review of an uploaded permit document.');
SELECT pg_temp.doc('spatial_planning.permit_document',          'Documents attached to a permit application (upload or generated).');
SELECT pg_temp.doc('spatial_planning.generated_document',       'System-generated letters/reports/permits, versioned (supersedes).');
SELECT pg_temp.doc('spatial_planning.eo_handoff_package',       'Planner recommendation package handed to the Executive Officer for decision.');
SELECT pg_temp.doc('spatial_planning.building_plan',            'Building plan submission (per revision) and its appraisal.');
SELECT pg_temp.doc('spatial_planning.building_plan_annotation', 'Mark-up comments on a building plan page.');
SELECT pg_temp.doc('spatial_planning.occupation_certificate',   'Certificate of occupation issued after final inspection.');
SELECT pg_temp.doc('spatial_planning.stage_inspection',         'Building stage inspection visit (one row per attempt).');
SELECT pg_temp.doc('spatial_planning.inspection_stage',         'Reference: the building inspection stages and their prerequisites (DM Handbook).');
SELECT pg_temp.doc('spatial_planning.checklist_category',       'Reference: inspection checklist categories.');
SELECT pg_temp.doc('spatial_planning.checklist_item',           'Reference: inspection checklist items and the stages they apply to.');
SELECT pg_temp.doc('spatial_planning.inspection_checklist_result', 'Per-item checklist outcome of a stage inspection.');
SELECT pg_temp.doc('spatial_planning.enforcement_order',        'Enforcement / stop notice served for unauthorised development.');
SELECT pg_temp.doc('spatial_planning.enforcement_compliance_check', 'Site visit checking compliance with an enforcement order.');
SELECT pg_temp.doc('spatial_planning.prohibition_order',        'Prohibition order (escalation of an enforcement order).');
SELECT pg_temp.doc('spatial_planning.property_assessment',      'Rating roll values for a property (1:1 with property).');
SELECT pg_temp.doc('spatial_planning.parcel_owner',             'Owners/occupiers/agents linked to a property.');
SELECT pg_temp.doc('spatial_planning.parcel_lineage',           'Parent -> child property derivation (subdivision / consolidation).');
SELECT pg_temp.doc('spatial_planning.existing_use',             'Recorded existing land use of a property.');
SELECT pg_temp.doc('spatial_planning.zoning_designation',       'Zoning designation history of a property.');
SELECT pg_temp.doc('spatial_planning.planning_project',         'Planning Studio subdivision project (layout JSON + geometry).');
SELECT pg_temp.doc('spatial_planning.planning_revision',        'Saved revisions of a planning_project.');
SELECT pg_temp.doc('spatial_planning.gis_feature',              'Features drawn by GIS officers in editable layers.');
SELECT pg_temp.doc('spatial_planning.gis_feature_history',      'Change history of gis_feature (who changed what).');
SELECT pg_temp.doc('spatial_planning.control_point',            'Survey control points (Gauss conform) used by survey tasks.');
SELECT pg_temp.doc('spatial_planning.survey_task',              'Survey task assigned to a surveyor (verification, pegging, layout …).');
SELECT pg_temp.doc('spatial_planning.survey_task_control_point','Control points used on a survey task (M:N).');
SELECT pg_temp.doc('spatial_planning.survey_beacon',            'Beacons recorded on a survey task.');
SELECT pg_temp.doc('spatial_planning.survey_coordinate',        'Coordinates captured on a survey task.');
SELECT pg_temp.doc('spatial_planning.survey_parcel',            'Parcel computed from survey coordinates (area, closure).');
SELECT pg_temp.doc('spatial_planning.survey_finding',           'Surveyor findings and recommendation for a task.');
SELECT pg_temp.doc('spatial_planning.survey_comment',           'Discussion on a survey task.');
SELECT pg_temp.doc('spatial_planning.survey_document',          'Documents generated for a survey task (DSG certificate, report).');
SELECT pg_temp.doc('spatial_planning.survey_layout',            'Township layout plan prepared under a survey task.');
SELECT pg_temp.doc('spatial_planning.stage_inspection_flag_summary', 'Read model: open inspection flags per inspection.');
SELECT pg_temp.doc('spatial_planning.v_application_summary',    'Read model: permit application with consultation/objection/plan/inspection counts.');
SELECT pg_temp.doc('spatial_planning.v_inspection_progress',    'Read model: inspection stage progress per application.');
SELECT pg_temp.doc('spatial_planning.v_inspector_queue',        'Read model: building inspector work queue.');
SELECT pg_temp.doc('spatial_planning.v_survey_task',            'Read model: survey tasks with application and finding.');

-- ---------------------------------------------------------------------------
-- planning_clerk
-- ---------------------------------------------------------------------------
SELECT pg_temp.doc('planning_clerk.acknowledgement_letter', 'Register of acknowledgement letters sent for received applications.');
SELECT pg_temp.doc('planning_clerk.refusal_letter',         'Register of refusal letters sent after council resolution.');
SELECT pg_temp.doc('planning_clerk.notice_certificate',     'Newspaper advert certificates filed for an application.');
SELECT pg_temp.doc('planning_clerk.abutter_notification',   'Notices sent to abutting owners (delivery_method).');
SELECT pg_temp.doc('planning_clerk.fee_receipt',            'Cash-office receipts for planning fees (fee_kind, payment_method).');
SELECT pg_temp.doc('planning_clerk.permit_dispatch',        'Dispatch of issued permits to applicants (delivery_method).');
SELECT pg_temp.doc('planning_clerk.correspondence',         'Incoming/outgoing correspondence register.');

-- ---------------------------------------------------------------------------
-- council_ops
-- ---------------------------------------------------------------------------
SELECT pg_temp.doc('council_ops.council_asset',       'Council-owned buildings, land and facilities.');
SELECT pg_temp.doc('council_ops.road_asset',          'Council road inventory.');
SELECT pg_temp.doc('council_ops.road_structure',      'Bridges, culverts and causeways on council roads.');
SELECT pg_temp.doc('council_ops.wash_asset',          'Water, sanitation & hygiene infrastructure.');
SELECT pg_temp.doc('council_ops.livestock_facility',  'Dip tanks, stock pens and watering points.');
SELECT pg_temp.doc('council_ops.service_desk_ticket', 'Citizen service requests routed to a department.');

-- ---------------------------------------------------------------------------
-- survey (Survey Task Manager)
-- ---------------------------------------------------------------------------
SELECT pg_temp.doc('survey.users',              'Survey Task Manager login accounts (separate from public.users by design: surveyor tenancy).');
SELECT pg_temp.doc('survey.surveyor_profiles',  'Professional profile of a survey user (registration, firm, supervisor).');
SELECT pg_temp.doc('survey.surveyors',          'Registered surveyors directory.');
SELECT pg_temp.doc('survey.projects',           'Top-level survey project containers.');
SELECT pg_temp.doc('survey.survey_projects',    'Survey jobs (client, township, meridian, workflow state).');
SELECT pg_temp.doc('survey.layers',             'Layers inside a survey project.');
SELECT pg_temp.doc('survey.features',           'Features inside a survey project layer.');
SELECT pg_temp.doc('survey.coordinate_points',  'Surveyed coordinate points (per project / CSV import).');
SELECT pg_temp.doc('survey.coordinate_points_full', 'Read model: coordinate points with project and import details.');
SELECT pg_temp.doc('survey.land_parcels_full',  'Read model: land parcels with project, surveyor and import details.');
SELECT pg_temp.doc('survey.v_import_summary',   'Read model: CSV import summary (points, parcels, importer).');
SELECT pg_temp.doc('surveyor_surveyor_demo_surveyor.survey_projects',   'Demo surveyor workspace: survey jobs.');
SELECT pg_temp.doc('surveyor_surveyor_demo_surveyor.coordinate_points', 'Demo surveyor workspace: coordinate points.');
SELECT pg_temp.doc('surveyor_surveyor_demo_surveyor.land_parcels',      'Demo surveyor workspace: land parcels.');

COMMIT;
