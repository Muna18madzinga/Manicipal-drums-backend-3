-- Phase 4, slice 2: everything that hangs off a permit follows its permit.
--
-- Migration 154 put row-level security on permit_application. A consultation, an objection, a building
-- plan, an inspection... lives in its own table, so on its own it would still show every authority's rows
-- to a connection that is subject to the policies. These policies make each child readable when its permit
-- is, and writable when the permit is the caller's own (or the caller lodged it). The permit lookup is
-- itself subject to permit_application's policy, so a combination authority's members read, never write.
--
-- Left out on purpose (their permit link is optional, so there is no owner to follow; see docs/TENANCY.md):
-- enforcement_order and what hangs off it, survey_task, planning_project, building_complaint,
-- health_premises, spatial_analysis_result, and committee meetings.

-- Can the caller change this permit? (own authority, a platform operator, or the citizen who lodged it)
CREATE OR REPLACE FUNCTION app.permit_writable(p uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT app.is_platform() OR EXISTS (
    SELECT 1 FROM spatial_planning.permit_application a
     WHERE a.id = p AND (a.authority_id = app.authority_id() OR a.created_by = app.user_id()))
$$;

-- Children that carry permit_app_id (all NOT NULL).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'application_consultation', 'application_objection', 'application_appeal', 'building_plan',
    'case_message', 'document_request', 'eo_handoff_package', 'generated_document',
    'occupation_certificate', 'permit_document', 'permit_event', 'public_notice',
    'statutory_clock_event', 'stage_inspection', 'agenda_item'
  ] LOOP
    IF to_regclass('spatial_planning.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE spatial_planning.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_select ON spatial_planning.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_write ON spatial_planning.%I', t);
    EXECUTE format($f$CREATE POLICY tenant_select ON spatial_planning.%1$I FOR SELECT USING (
        EXISTS (SELECT 1 FROM spatial_planning.permit_application p WHERE p.id = %1$I.permit_app_id))$f$, t);
    EXECUTE format($f$CREATE POLICY tenant_write ON spatial_planning.%1$I FOR ALL
        USING (app.permit_writable(permit_app_id)) WITH CHECK (app.permit_writable(permit_app_id))$f$, t);
  END LOOP;
END $$;

-- Children reached through another child.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('building_plan_annotation',    'building_plan_id',    'building_plan'),
      ('inspection_checklist_result', 'stage_inspection_id', 'stage_inspection'),
      ('stage_inspection_photo',      'stage_inspection_id', 'stage_inspection'),
      ('stage_inspection_flag',       'stage_inspection_id', 'stage_inspection'),
      ('stage_inspection_field_event','stage_inspection_id', 'stage_inspection')
    ) AS v(tbl, col, parent)
  LOOP
    IF to_regclass('spatial_planning.' || t.tbl) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE spatial_planning.%I ENABLE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_select ON spatial_planning.%I', t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_write ON spatial_planning.%I', t.tbl);
    EXECUTE format($f$CREATE POLICY tenant_select ON spatial_planning.%1$I FOR SELECT USING (
        EXISTS (SELECT 1 FROM spatial_planning.%3$I c WHERE c.id = %1$I.%2$I))$f$, t.tbl, t.col, t.parent);
    EXECUTE format($f$CREATE POLICY tenant_write ON spatial_planning.%1$I FOR ALL
        USING (EXISTS (SELECT 1 FROM spatial_planning.%3$I c WHERE c.id = %1$I.%2$I AND app.permit_writable(c.permit_app_id)))
        WITH CHECK (EXISTS (SELECT 1 FROM spatial_planning.%3$I c WHERE c.id = %1$I.%2$I AND app.permit_writable(c.permit_app_id)))$f$,
      t.tbl, t.col, t.parent);
  END LOOP;
END $$;

-- Views that read these tables answer with the caller's rights, not the owner's.
DO $$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY[
    'v_inspector_queue', 'v_eo_decision_queue', 'v_specialist_findings', 'v_inspection_progress',
    'stage_inspection_scoring', 'stage_inspection_flag_summary', 'v_survey_task'
  ] LOOP
    IF to_regclass('spatial_planning.' || v) IS NOT NULL THEN
      EXECUTE format('ALTER VIEW spatial_planning.%I SET (security_invoker = true)', v);
    END IF;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION app.permit_writable(uuid) TO vungu_app;
