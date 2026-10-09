-- 169: the spatial_planning registers become tenant data (first batch of the tenancy debt, migration 165's `pending` list).
--
-- Every existing row is Vungu's (it is the only authority with data); the backfill authority is named, as make_tenant requires.
-- Each table is treated one of two ways:
--   ROOT   it carries its own authority_id (default: the caller's authority) and the standard policies, because it is not
--          reached through a parent that is always present: a property, a health premises, a survey task whose permit is optional.
--   CHILD  it has a mandatory parent that is already tenant data, and follows it (make_tenant_child).
-- Tables that may be filed before a permit exists (a nullable permit link) are roots, never children: a child of nothing would
-- belong to nobody.
--
-- Guarded by to_regclass so a database that is behind the migration chain converts what it has and the rest follows when it catches up.

DO $$
DECLARE r text; c record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.local_authorities WHERE code = 'VUNGU') THEN
    RAISE NOTICE 'no VUNGU authority here: spatial_planning stays pending until it is converted by hand';
    RETURN;
  END IF;

  FOREACH r IN ARRAY ARRAY[
    -- the property register and what is filed against stands
    'property', 'available_stand', 'control_point',
    -- planning and committee
    'planning_project', 'committee_meeting', 'committee_member', 'spatial_analysis_result', 'document_review',
    -- enforcement and complaints
    'enforcement_order', 'prohibition_order', 'building_complaint',
    -- survey
    'survey_task', 'survey_layout',
    -- environmental health
    'health_premises', 'health_nuisance_complaint', 'health_abatement_notice', 'health_licence_clearance', 'health_outbreak',
    'health_water_sample', 'health_field_programme', 'health_burial_permit',
    -- the GIS editing register
    'gis_feature', 'gis_feature_history',
    -- the planning clerk's registers that may exist before a permit does
    'clerk_correspondence', 'clerk_fee_receipt', 'clerk_public_inspection'
  ] LOOP
    IF to_regclass('spatial_planning.' || r) IS NOT NULL THEN PERFORM tenancy.make_tenant(('spatial_planning.' || r)::regclass, 'VUNGU'); END IF;
  END LOOP;

  FOR c IN SELECT * FROM (VALUES
    ('existing_use', 'property', 'property_id'), ('parcel_owner', 'property', 'property_id'),
    ('property_assessment', 'property', 'property_id'), ('parcel_lineage', 'property', 'child_property_id'),
    ('planning_revision', 'planning_project', 'project_id'),
    ('meeting_attendance', 'committee_meeting', 'meeting_id'),
    ('enforcement_compliance_check', 'enforcement_order', 'enforcement_order_id'),
    ('survey_beacon', 'survey_task', 'survey_task_id'), ('survey_comment', 'survey_task', 'survey_task_id'),
    ('survey_coordinate', 'survey_task', 'survey_task_id'), ('survey_document', 'survey_task', 'survey_task_id'),
    ('survey_finding', 'survey_task', 'survey_task_id'), ('survey_parcel', 'survey_task', 'survey_task_id'),
    ('survey_task_control_point', 'survey_task', 'survey_task_id'),
    ('health_food_handler_cert', 'health_premises', 'premises_id'), ('health_premises_inspection', 'health_premises', 'premises_id'),
    ('clerk_acknowledgement', 'permit_application', 'permit_application_id'), ('clerk_dispatch', 'permit_application', 'permit_application_id'),
    ('clerk_refusal', 'permit_application', 'permit_application_id'), ('clerk_notice_certificate', 'permit_application', 'permit_application_id'),
    ('clerk_abutter_notice', 'permit_application', 'permit_application_id'), ('clerk_file_movement', 'permit_application', 'permit_application_id')
  ) AS t(child, parent, fk) LOOP
    IF to_regclass('spatial_planning.' || c.child) IS NOT NULL THEN
      PERFORM tenancy.make_tenant_child(('spatial_planning.' || c.child)::regclass, ('spatial_planning.' || c.parent)::regclass, c.fk);
    END IF;
  END LOOP;
END $$;

-- statutory_plan already has an authority_id, but it is a text label ('lpa'), not the authority. Its owner gets its own column.
DO $$
DECLARE vungu integer;
BEGIN
  IF to_regclass('spatial_planning.statutory_plan') IS NULL THEN RETURN; END IF;
  SELECT id INTO vungu FROM public.local_authorities WHERE code = 'VUNGU';
  IF vungu IS NULL THEN RETURN; END IF;
  ALTER TABLE spatial_planning.statutory_plan ADD COLUMN IF NOT EXISTS local_authority_id integer REFERENCES public.local_authorities (id);
  UPDATE spatial_planning.statutory_plan SET local_authority_id = vungu WHERE local_authority_id IS NULL;
  ALTER TABLE spatial_planning.statutory_plan ALTER COLUMN local_authority_id SET DEFAULT app.authority_id();
  ALTER TABLE spatial_planning.statutory_plan ALTER COLUMN local_authority_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_statutory_plan_local_authority ON spatial_planning.statutory_plan (local_authority_id);
  ALTER TABLE spatial_planning.statutory_plan ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_select ON spatial_planning.statutory_plan;
  DROP POLICY IF EXISTS tenant_write ON spatial_planning.statutory_plan;
  CREATE POLICY tenant_select ON spatial_planning.statutory_plan FOR SELECT
    USING (app.is_platform() OR local_authority_id = ANY (app.visible_authorities()));
  CREATE POLICY tenant_write ON spatial_planning.statutory_plan FOR ALL
    USING (app.is_platform() OR local_authority_id = app.authority_id())
    WITH CHECK (app.is_platform() OR local_authority_id = app.authority_id());
  PERFORM tenancy.grant_app('spatial_planning.statutory_plan'::regclass, 'write');
  PERFORM tenancy.classify('spatial_planning.statutory_plan', 'tenant', 'rows belong to an authority through local_authority_id (the text authority_id is a label)');
END $$;
