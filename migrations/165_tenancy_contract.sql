-- 165: the tenancy contract. Every relation says what kind of data it is, and the database reports any that breaks the rules of
-- its kind, so a new table cannot reach production unnoticed.
--
-- WHY. Tenancy (migrations 154, 155) protects the tables someone remembered to protect, for the routes someone remembered to
-- convert. Anything new is open by default: migration 154 made every new table in four schemas readable AND writable by the
-- application role, and nothing noticed that 101 relations holding authority-owned data have no row-level security at all, or
-- that the application role could read password hashes and MFA secrets. The fix is to invert the default: a relation is
-- classified before it ships, the classification decides what the application role may do, and a view lists every departure.
--
-- THE CLASSES (docs/TENANCY.md has the full contract)
--   tenant / tenant_child   rows belong to an authority; row-level security by authority is required (a child follows its parent)
--   tenant_view             a view over tenant data; it must run with the caller's rights (security_invoker)
--   personal                rows belong to a person; row-level security is required
--   sensitive               secrets and security records: the application role has NO table privileges (users: named columns only)
--   system                  internal plumbing: no privileges for the application role
--   reference               shared configuration: read only for the application role
--   national                national or custodian datasets: read only for the application role
--   pending                 authority-owned data that should be tenant data and is not yet. It is a DEBT, listed by tenancy.debt,
--                           and scripts/verify-tenancy.js refuses to let the count grow.
--
-- NEW OBJECTS ARE DEFAULT DENY. The default privileges that handed every new table to the application role are removed. A
-- migration that creates a table calls tenancy.classify() and, if the application is to use it, tenancy.grant_app().

CREATE SCHEMA IF NOT EXISTS tenancy;

CREATE TABLE IF NOT EXISTS tenancy.relation_class (
  relation text PRIMARY KEY,                       -- schema.name
  class    text NOT NULL CHECK (class IN ('tenant', 'tenant_child', 'tenant_view', 'personal', 'sensitive', 'reference', 'national', 'system', 'pending')),
  note     text
);

INSERT INTO tenancy.relation_class (relation, class, note) VALUES
  ('admin.authority_area', 'national', 'national or custodian data: read only for the application role'),
  ('admin.authority_ward', 'reference', 'shared configuration: read only for the application role'),
  ('admin.village', 'national', 'national or custodian data: read only for the application role'),
  ('admin.ward', 'national', 'national or custodian data: read only for the application role'),
  ('council_ops.council_asset', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('council_ops.livestock_facility', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('council_ops.road_asset', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('council_ops.road_structure', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('council_ops.service_desk_ticket', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('council_ops.wash_asset', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('gis_ops.crs_registry', 'reference', 'shared configuration: read only for the application role'),
  ('gis_ops.datum_transformation', 'reference', 'shared configuration: read only for the application role'),
  ('integration.inbound_event', 'system', 'internal plumbing: no access for the application role'),
  ('integration.key_registry', 'system', 'internal plumbing: no access for the application role'),
  ('integration.outbox_event', 'system', 'internal plumbing: no access for the application role'),
  ('integration.reconciliation_item', 'system', 'internal plumbing: no access for the application role'),
  ('land.building', 'national', 'national or custodian data: read only for the application role'),
  ('land.general_plan', 'national', 'national or custodian data: read only for the application role'),
  ('land.parcel', 'national', 'national or custodian data: read only for the application role'),
  ('land.parcel_lineage', 'national', 'national or custodian data: read only for the application role'),
  ('planning_clerk.abutter_notification', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('planning_clerk.acknowledgement_letter', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('planning_clerk.correspondence', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('planning_clerk.fee_receipt', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('planning_clerk.notice_certificate', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('planning_clerk.permit_dispatch', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('planning_clerk.refusal_letter', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.activity_spatial_gaps', 'reference', 'shared configuration: read only for the application role'),
  ('public.activity_spatial_test', 'reference', 'shared configuration: read only for the application role'),
  ('public.activity_standard_kind', 'reference', 'shared configuration: read only for the application role'),
  ('public.admin_announcement', 'reference', 'shared configuration: read only for the application role'),
  ('public.admin_areas', 'national', 'national or custodian data: read only for the application role'),
  ('public.admin_audit_event', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.admin_ip_block', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.admin_login_attempt', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.admin_org_position', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.admin_setting', 'reference', 'shared configuration: read only for the application role'),
  ('public.admin_users', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.analytics', 'system', 'internal plumbing: no access for the application role'),
  ('public.api_token', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.application_comments', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.application_documents', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.application_drafts', 'personal', NULL),
  ('public.application_status_history', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.application_summary', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.application_timeline', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.audit_logs', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.authority_member', 'reference', 'shared configuration: read only for the application role'),
  ('public.buildings', 'national', 'national or custodian data: read only for the application role'),
  ('public.citizen_documents', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.country', 'national', 'national or custodian data: read only for the application role'),
  ('public.decision_pathway', 'reference', 'shared configuration: read only for the application role'),
  ('public.development_activity', 'reference', 'shared configuration: read only for the application role'),
  ('public.development_applications', 'personal', NULL),
  ('public.development_matrix', 'reference', 'shared configuration: read only for the application role'),
  ('public.districts', 'national', 'national or custodian data: read only for the application role'),
  ('public.exchange_rates', 'reference', 'shared configuration: read only for the application role'),
  ('public.farm_match', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.geography_columns', 'reference', 'shared configuration: read only for the application role'),
  ('public.geometry_columns', 'reference', 'shared configuration: read only for the application role'),
  ('public.gis_layer', 'reference', 'shared configuration: read only for the application role'),
  ('public.gis_published_style', 'reference', 'shared configuration: read only for the application role'),
  ('public.gis_style', 'reference', 'shared configuration: read only for the application role'),
  ('public.gis_style_audit', 'reference', 'shared configuration: read only for the application role'),
  ('public.gweru_business_centres', 'national', 'national or custodian data: read only for the application role'),
  ('public.gweru_chiefdoms', 'national', 'national or custodian data: read only for the application role'),
  ('public.gweru_health_centres', 'national', 'national or custodian data: read only for the application role'),
  ('public.gweru_peri_urban_zone', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.gweru_rivers', 'national', 'national or custodian data: read only for the application role'),
  ('public.gweru_rural_farms', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.gweru_rural_planning_boundary', 'national', 'national or custodian data: read only for the application role'),
  ('public.ingestion_jobs', 'system', 'internal plumbing: no access for the application role'),
  ('public.inspection_bookings', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.inspection_photos', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.inspection_status_events', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.invites', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.land_use_group_class', 'tenant_child', NULL),
  ('public.land_use_group_tree', 'tenant_view', NULL),
  ('public.land_use_groups', 'tenant_child', NULL),
  ('public.lands_registry_checks', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.lands_registry_deeds', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.landuse', 'national', 'national or custodian data: read only for the application role'),
  ('public.layer_data', 'system', 'internal plumbing: no access for the application role'),
  ('public.layer_publication', 'reference', 'shared configuration: read only for the application role'),
  ('public.layers', 'reference', 'shared configuration: read only for the application role'),
  ('public.local_authorities', 'reference', 'shared configuration: read only for the application role'),
  ('public.natural_areas', 'national', 'national or custodian data: read only for the application role'),
  ('public.natural_points', 'national', 'national or custodian data: read only for the application role'),
  ('public.notifications_outbox', 'system', 'internal plumbing: no access for the application role'),
  ('public.page_view', 'system', 'internal plumbing: no access for the application role'),
  ('public.parcel_zoning', 'tenant_child', NULL),
  ('public.payments', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.places', 'national', 'national or custodian data: read only for the application role'),
  ('public.places_areas', 'national', 'national or custodian data: read only for the application role'),
  ('public.places_of_worship_areas', 'national', 'national or custodian data: read only for the application role'),
  ('public.places_of_worship_points', 'national', 'national or custodian data: read only for the application role'),
  ('public.places_points', 'national', 'national or custodian data: read only for the application role'),
  ('public.plan_event', 'tenant_child', NULL),
  ('public.plan_instrument', 'tenant', NULL),
  ('public.plan_instrument_summary', 'tenant_view', NULL),
  ('public.plan_matrix_audit', 'tenant_view', NULL),
  ('public.plan_matrix_audit_summary', 'tenant_view', NULL),
  ('public.plan_profile', 'reference', 'shared configuration: read only for the application role'),
  ('public.plan_review_findings', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.plan_reviews', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.plan_signoff', 'tenant_child', NULL),
  ('public.plan_status_transition', 'reference', 'shared configuration: read only for the application role'),
  ('public.plan_zone_standard', 'tenant_child', NULL),
  ('public.plan_zone_type', 'tenant_child', NULL),
  ('public.plan_zone_type_class', 'tenant_child', NULL),
  ('public.planning_assistant_templates', 'reference', 'shared configuration: read only for the application role'),
  ('public.pois_areas', 'national', 'national or custodian data: read only for the application role'),
  ('public.pois_points', 'national', 'national or custodian data: read only for the application role'),
  ('public.proposed_peri_urban_zones', 'tenant_child', NULL),
  ('public.protected_areas', 'national', 'national or custodian data: read only for the application role'),
  ('public.provinces', 'national', 'national or custodian data: read only for the application role'),
  ('public.railways', 'national', 'national or custodian data: read only for the application role'),
  ('public.ref_application_statuses', 'reference', 'shared configuration: read only for the application role'),
  ('public.ref_scale_categories', 'reference', 'shared configuration: read only for the application role'),
  ('public.ref_stand_statuses', 'reference', 'shared configuration: read only for the application role'),
  ('public.ref_use_scales', 'reference', 'shared configuration: read only for the application role'),
  ('public.ref_zone_types', 'reference', 'shared configuration: read only for the application role'),
  ('public.reference_classification', 'reference', 'shared configuration: read only for the application role'),
  ('public.roads', 'national', 'national or custodian data: read only for the application role'),
  ('public.schema_migrations', 'system', 'internal plumbing: no access for the application role'),
  ('public.site_content', 'reference', 'shared configuration: read only for the application role'),
  ('public.spatial_concept', 'reference', 'shared configuration: read only for the application role'),
  ('public.spatial_concept_source', 'reference', 'shared configuration: read only for the application role'),
  ('public.spatial_concept_summary', 'reference', 'shared configuration: read only for the application role'),
  ('public.spatial_layers', 'reference', 'shared configuration: read only for the application role'),
  ('public.spatial_ref_sys', 'reference', 'shared configuration: read only for the application role'),
  ('public.stand_allocation', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.standard_kind', 'reference', 'shared configuration: read only for the application role'),
  ('public.stands', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.stands_tile_view', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.style_templates', 'reference', 'shared configuration: read only for the application role'),
  ('public.traffic_areas', 'national', 'national or custodian data: read only for the application role'),
  ('public.traffic_points', 'national', 'national or custodian data: read only for the application role'),
  ('public.transport_areas', 'national', 'national or custodian data: read only for the application role'),
  ('public.transport_points', 'national', 'national or custodian data: read only for the application role'),
  ('public.user_profiles', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.user_session', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.user_sessions', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.users', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.v_stands', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.validation_rules', 'reference', 'shared configuration: read only for the application role'),
  ('public.vungu_beyond_peri_urban_zones', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.vungu_cemeteries', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.vungu_clip_boundary', 'national', 'national or custodian data: read only for the application role'),
  ('public.vungu_farm_cadastre', 'national', 'national or custodian data: read only for the application role'),
  ('public.vungu_parcels', 'national', 'national or custodian data: read only for the application role'),
  ('public.vungu_waste_management', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.wards', 'national', 'national or custodian data: read only for the application role'),
  ('public.water_areas', 'national', 'national or custodian data: read only for the application role'),
  ('public.waterways', 'national', 'national or custodian data: read only for the application role'),
  ('public.zone_decision_status', 'tenant_view', NULL),
  ('public.zone_effective_controls', 'tenant_view', NULL),
  ('public.zone_land_use_controls', 'tenant_child', NULL),
  ('public.zones_master', 'tenant_view', NULL),
  ('revenue_link.account_link', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('revenue_link.billing_status', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.agenda_item', 'tenant_child', NULL),
  ('spatial_planning.application_appeal', 'tenant_child', NULL),
  ('spatial_planning.application_consultation', 'tenant_child', NULL),
  ('spatial_planning.application_objection', 'tenant_child', NULL),
  ('spatial_planning.available_stand', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.building_complaint', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.building_plan', 'tenant_child', NULL),
  ('spatial_planning.building_plan_annotation', 'tenant_child', NULL),
  ('spatial_planning.case_message', 'tenant_child', NULL),
  ('spatial_planning.checklist_category', 'reference', 'shared configuration: read only for the application role'),
  ('spatial_planning.checklist_item', 'reference', 'shared configuration: read only for the application role'),
  ('spatial_planning.committee_meeting', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.committee_member', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.control_point', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.document_request', 'tenant_child', NULL),
  ('spatial_planning.document_review', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.enforcement_compliance_check', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.enforcement_order', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.eo_handoff_package', 'tenant_child', NULL),
  ('spatial_planning.existing_use', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.generated_document', 'tenant_child', NULL),
  ('spatial_planning.gis_feature', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.gis_feature_history', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.health_abatement_notice', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.health_burial_permit', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.health_field_programme', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.health_food_handler_cert', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.health_licence_clearance', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.health_nuisance_complaint', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.health_outbreak', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.health_premises', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.health_premises_inspection', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.health_water_sample', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.inspection_checklist_result', 'tenant_child', NULL),
  ('spatial_planning.inspection_stage', 'reference', 'shared configuration: read only for the application role'),
  ('spatial_planning.meeting_attendance', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.occupation_certificate', 'tenant_child', NULL),
  ('spatial_planning.parcel_lineage', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.parcel_owner', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.permit_application', 'tenant_child', NULL),
  ('spatial_planning.permit_document', 'tenant_child', NULL),
  ('spatial_planning.permit_event', 'tenant_child', NULL),
  ('spatial_planning.permit_rule_snapshot', 'tenant_child', NULL),
  ('spatial_planning.planning_project', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.planning_revision', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.prohibition_order', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.property', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.property_assessment', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.public_notice', 'tenant_child', NULL),
  ('spatial_planning.spatial_analysis_result', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.stage_inspection', 'tenant_child', NULL),
  ('spatial_planning.stage_inspection_field_event', 'tenant_child', NULL),
  ('spatial_planning.stage_inspection_flag', 'tenant_child', NULL),
  ('spatial_planning.stage_inspection_flag_summary', 'tenant_view', NULL),
  ('spatial_planning.stage_inspection_photo', 'tenant_child', NULL),
  ('spatial_planning.stage_inspection_scoring', 'tenant_view', NULL),
  ('spatial_planning.statutory_clock_event', 'tenant_child', NULL),
  ('spatial_planning.statutory_plan', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.survey_beacon', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.survey_comment', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.survey_coordinate', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.survey_document', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.survey_finding', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.survey_layout', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.survey_parcel', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.survey_task', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.survey_task_control_point', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.v_application_summary', 'tenant_view', NULL),
  ('spatial_planning.v_eo_decision_queue', 'tenant_view', NULL),
  ('spatial_planning.v_inspection_progress', 'tenant_view', NULL),
  ('spatial_planning.v_inspector_queue', 'tenant_view', NULL),
  ('spatial_planning.v_specialist_findings', 'tenant_view', NULL),
  ('spatial_planning.v_survey_task', 'tenant_view', NULL),
  ('spatial_planning.zoning_designation', 'reference', 'shared configuration: read only for the application role'),
  ('survey.area_parcels', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.coordinate_point_history', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.coordinate_points', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.coordinate_points_full', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.features', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.land_parcels', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.land_parcels_full', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.layers', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.migrations_history', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.project_control_points', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.project_csv_imports', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.project_meridian_cache', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.projects', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.survey_projects', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.surveyor_profiles', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.surveyors', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.users', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.v_import_summary', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.workflow_states', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('survey.zim_control_points', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('gis_ops.layer', 'reference', 'shared configuration: read only for the application role'),
  ('gis_ops.feature', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('gis_ops.feature_version', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('gis_ops.edit_session', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('public.api_token_revocations', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.kyc_verifications', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.password_reset_token', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.payment_audit', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.payment_webhooks', 'sensitive', 'secrets and security records: no direct access for the application role'),
  ('public.rate_limit_log', 'system', 'internal plumbing: no access for the application role'),
  ('public.workflow_notifications', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.clerk_abutter_notice', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.clerk_acknowledgement', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.clerk_correspondence', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.clerk_dispatch', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.clerk_fee_receipt', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.clerk_file_movement', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.clerk_notice_certificate', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.clerk_public_inspection', 'pending', 'authority-owned data with no row-level security yet: a gap to close'),
  ('spatial_planning.clerk_refusal', 'pending', 'authority-owned data with no row-level security yet: a gap to close')
ON CONFLICT (relation) DO NOTHING;

-- Classify a relation (a migration that creates one calls this).
CREATE OR REPLACE FUNCTION tenancy.classify(p_relation text, p_class text, p_note text DEFAULT NULL) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO tenancy.relation_class (relation, class, note) VALUES (p_relation, p_class, p_note)
  ON CONFLICT (relation) DO UPDATE SET class = EXCLUDED.class, note = COALESCE(EXCLUDED.note, tenancy.relation_class.note)
$$;

-- Give the application role what a class of relation needs: 'read' or 'write' (plus the sequences of the table's columns).
CREATE OR REPLACE FUNCTION tenancy.grant_app(p_relation regclass, p_mode text DEFAULT 'read') RETURNS void AS $$
DECLARE seq regclass;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN RETURN; END IF;
  IF p_mode NOT IN ('read', 'write') THEN RAISE EXCEPTION 'mode must be read or write'; END IF;
  EXECUTE format('GRANT SELECT ON %s TO vungu_app', p_relation);
  IF p_mode = 'write' THEN
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON %s TO vungu_app', p_relation);
    FOR seq IN SELECT d.objid::regclass FROM pg_depend d WHERE d.refobjid = p_relation AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
                  AND (SELECT relkind FROM pg_class WHERE oid = d.objid) = 'S' LOOP
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO vungu_app', seq);
    END LOOP;
  END IF;
END $$ LANGUAGE plpgsql;

-- Does the application role hold this privilege? False when the role does not exist (a database without it has nothing to leak).
CREATE OR REPLACE FUNCTION tenancy.app_can(p_rel oid, p_priv text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') AND has_table_privilege('vungu_app', p_rel, p_priv)
$$;

-- Does a role hold this privilege? False when the role does not exist yet (the direct-client roles come with migration 166).
CREATE OR REPLACE FUNCTION tenancy.role_can(p_role name, p_rel oid, p_priv text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_role) AND has_table_privilege(p_role::text, p_rel, p_priv)
$$;

-- ---- the guard -------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW tenancy.violations AS
WITH rel AS (
  SELECT n.nspname || '.' || c.relname AS relation, c.oid, c.relkind, c.relrowsecurity AS rls, c.reloptions
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'v', 'm')
     AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'topology', 'tiger', 'tiger_data', 'app', 'tenancy')
     AND n.nspname NOT LIKE 'pg\_%' AND n.nspname NOT LIKE 'surveyor\_%'
)
SELECT r.relation, COALESCE(k.class, '(none)') AS class, v.rule, v.detail
  FROM rel r
  LEFT JOIN tenancy.relation_class k ON k.relation = r.relation
  CROSS JOIN LATERAL (
    SELECT 'unclassified'::text AS rule, 'not in tenancy.relation_class: classify it (tenancy.classify) before it ships'::text AS detail WHERE k.relation IS NULL
    UNION ALL
    SELECT 'needs_rls', 'a ' || k.class || ' relation needs row-level security and at least one policy'
     WHERE k.class IN ('tenant', 'tenant_child', 'personal') AND r.relkind IN ('r', 'p')
       AND NOT (r.rls AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = r.oid))
    UNION ALL
    SELECT 'view_runs_as_owner', 'a view over tenant or authority-owned data must be security_invoker, or it shows the owner''s rows to everyone'
     WHERE k.class IN ('tenant_view', 'pending') AND r.relkind = 'v'
       AND NOT (COALESCE(r.reloptions, ARRAY[]::text[]) && ARRAY['security_invoker=true', 'security_invoker=on'])
    UNION ALL
    SELECT 'writable', 'the application role can change a ' || k.class || ' relation'
     WHERE k.class IN ('reference', 'national')
       AND (tenancy.app_can(r.oid, 'INSERT') OR tenancy.app_can(r.oid, 'UPDATE') OR tenancy.app_can(r.oid, 'DELETE') OR tenancy.app_can(r.oid, 'TRUNCATE'))
    UNION ALL
    SELECT 'exposed_to_direct_clients', 'a direct client (QGIS, the tile server) can read a ' || k.class || ' relation: its rows are not scoped to an authority'
     WHERE k.class IN ('pending', 'personal', 'sensitive', 'system')
       AND (tenancy.role_can('tenancy_reader', r.oid, 'SELECT') OR tenancy.role_can('tenancy_author', r.oid, 'SELECT'))
    UNION ALL
    SELECT 'author_writes_unscoped', 'the author role can write a ' || k.class || ' relation: only tenant data bounded by row-level security may be written directly'
     WHERE k.class NOT IN ('tenant', 'tenant_child')
       AND (tenancy.role_can('tenancy_author', r.oid, 'INSERT') OR tenancy.role_can('tenancy_author', r.oid, 'UPDATE') OR tenancy.role_can('tenancy_author', r.oid, 'DELETE'))
    UNION ALL
    SELECT 'accessible', 'the application role has table privileges on a ' || k.class || ' relation'
     WHERE k.class IN ('sensitive', 'system')
       AND (tenancy.app_can(r.oid, 'SELECT') OR tenancy.app_can(r.oid, 'INSERT') OR tenancy.app_can(r.oid, 'UPDATE') OR tenancy.app_can(r.oid, 'DELETE') OR tenancy.app_can(r.oid, 'TRUNCATE'))
  ) v
UNION ALL
SELECT n.nspname || ' (default privileges)', '-', 'default_grant', 'new objects in this schema are granted to the application role automatically: they must be default deny'
  FROM pg_default_acl d JOIN pg_namespace n ON n.oid = d.defaclnamespace
 WHERE d.defaclacl::text LIKE '%vungu\_app=%';

-- The debt: authority-owned relations that still have no row-level security, by schema.
CREATE OR REPLACE VIEW tenancy.debt AS
SELECT split_part(k.relation, '.', 1) AS schema, count(*)::int AS relations, string_agg(split_part(k.relation, '.', 2), ', ' ORDER BY k.relation) AS names
  FROM tenancy.relation_class k
 WHERE k.class = 'pending' AND to_regclass(k.relation) IS NOT NULL
 GROUP BY 1;

-- ---- apply the contract to what exists ---------------------------------------------------------------------------------------
DO $$
DECLARE s text; r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN RETURN; END IF;

  -- new objects are default deny (the grants of migration 154)
  FOREACH s IN ARRAY ARRAY['public', 'land', 'spatial_planning', 'gis_ops'] LOOP
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s) THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM vungu_app', s);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM vungu_app', s);
    END IF;
  END LOOP;

  -- reference and national data: read only
  FOR r IN SELECT k.relation FROM tenancy.relation_class k WHERE k.class IN ('reference', 'national') AND to_regclass(k.relation) IS NOT NULL LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %s FROM vungu_app', r.relation::regclass);
  END LOOP;

  -- secrets and plumbing: nothing
  FOR r IN SELECT k.relation FROM tenancy.relation_class k WHERE k.class IN ('sensitive', 'system') AND to_regclass(k.relation) IS NOT NULL LOOP
    EXECUTE format('REVOKE ALL ON %s FROM vungu_app', r.relation::regclass);
  END LOOP;
END $$;

-- The one sensitive table the routes still need to read: who a person is, never how they sign in.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') AND to_regclass('public.users') IS NOT NULL THEN
    GRANT SELECT (id, email, name, full_name, role, active, status, authority_id, is_platform, department, job_title, organization)
      ON public.users TO vungu_app;
  END IF;
END $$;
