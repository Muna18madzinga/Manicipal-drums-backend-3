-- Migration 130: ref schema — one lookup table per closed vocabulary
--
-- WHAT
--   * CREATE SCHEMA ref. Every closed vocabulary (status, type, category …)
--     that used to live as a hard-coded CHECK (col IN (...)) list — 135 columns
--     across 77 tables — becomes a row set in ref.<domain>
--     and the column gets a FOREIGN KEY … ON UPDATE CASCADE instead.
--     115 vocabulary tables (shared vocabularies are one table: priority, severity,
--     location_source, data_quality, stand_status, parcel_status, …).
--   * Adopts the old public.ref_* tables (078/126) into the schema:
--       ref_stand_statuses       -> ref.stand_status
--       ref_use_scales           -> ref.development_scale   (ref_scale_categories merged in: identical rows)
--       ref_zone_types           -> ref.zone_type
--       ref_application_statuses -> ref.application_status
--   * Replaces the gis_style_status ENUM with ref.style_status (same values) and
--     drops the unused application_status ENUM — one mechanism for vocabularies.
--   * Adds ref.osm_feature_class (fclass <-> Geofabrik numeric code) and
--     binds every OSM basemap table's fclass to it (migration 131 then drops the
--     now-redundant per-row `code` column).
--
-- Every ref table has the same shape:
--   code (PK) | label | description | sort_order | is_active
-- Stored values in the business tables do not change, so application code keeps
-- writing the same strings; the database now holds the labels and can be extended
-- with an INSERT instead of a DDL change.
--
-- Bug fixes folded in: user_status gains 'deleted' (auth.js soft-delete was
-- rejected by the old CHECK); development_scale gains 'all_scales'
-- (land_use_groups rows already use it).
--
-- IDEMPOTENT: CREATE … IF NOT EXISTS, INSERT … ON CONFLICT DO NOTHING, and the
-- bind helper skips tables/columns that do not exist (dump-only tables such as
-- gweru_rural_farms are absent on a migrations-only database) and FKs that are
-- already present. Safe to run twice.

BEGIN;

CREATE SCHEMA IF NOT EXISTS ref;
COMMENT ON SCHEMA ref IS
  'Reference/lookup data: one small table per closed vocabulary. Business tables reference ref.<domain>(code) by FOREIGN KEY.';

-- ---------------------------------------------------------------------------
-- helpers (session-local, vanish at disconnect)
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.ref_table(p_domain text, p_comment text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format($ddl$
    CREATE TABLE IF NOT EXISTS ref.%I (
      code        varchar(64)  PRIMARY KEY,
      label       varchar(120) NOT NULL,
      description text,
      sort_order  smallint     NOT NULL DEFAULT 0,
      is_active   boolean      NOT NULL DEFAULT true
    )$ddl$, p_domain);
  EXECUTE format('COMMENT ON TABLE ref.%I IS %L', p_domain, p_comment);
END $fn$;

-- Conform an adopted legacy table to the standard ref shape.
CREATE FUNCTION pg_temp.ref_conform(p_domain text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('ALTER TABLE ref.%I ADD COLUMN IF NOT EXISTS description text', p_domain);
  EXECUTE format('ALTER TABLE ref.%I ADD COLUMN IF NOT EXISTS sort_order smallint NOT NULL DEFAULT 0', p_domain);
  EXECUTE format('ALTER TABLE ref.%I ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true', p_domain);
END $fn$;

-- Replace enum-style CHECKs on one column with a FK to ref.<domain>(code).
-- Any live value missing from the domain is added (sort_order 900) so the FK
-- can never fail on environments whose data drifted from the old CHECK.
CREATE FUNCTION pg_temp.ref_bind(p_schema text, p_table text, p_col text, p_domain text) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  v_rel    regclass := to_regclass(format('%I.%I', p_schema, p_table));
  v_attnum smallint;
  v_fk     text := left(format('fk_%s_%s', p_table, p_col), 63);
  r        record;
BEGIN
  IF v_rel IS NULL THEN
    RAISE NOTICE 'ref_bind: %.% absent — skipped', p_schema, p_table; RETURN;
  END IF;
  SELECT attnum INTO v_attnum FROM pg_attribute
   WHERE attrelid = v_rel AND attname = p_col AND NOT attisdropped;
  IF v_attnum IS NULL THEN
    RAISE NOTICE 'ref_bind: %.%.% absent — skipped', p_schema, p_table, p_col; RETURN;
  END IF;

  EXECUTE format(
    'INSERT INTO ref.%1$I (code, label, sort_order)
       SELECT DISTINCT %2$I, initcap(replace(%2$I::text, ''_'', '' '')), 900
         FROM %3$s WHERE %2$I IS NOT NULL
     ON CONFLICT (code) DO NOTHING', p_domain, p_col, v_rel);

  FOR r IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = v_rel AND contype = 'c'
       AND conkey = ARRAY[v_attnum]
       AND pg_get_constraintdef(oid) ~ '(= ANY|IN \()'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_rel, r.conname);
  END LOOP;

  -- Drop any other FK on this column that points at a different table
  -- (e.g. the 078 stands.status_code -> public.ref_* pairs).
  FOR r IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = v_rel AND contype = 'f' AND conkey = ARRAY[v_attnum]
       AND confrelid <> format('ref.%I', p_domain)::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_rel, r.conname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = v_rel AND contype = 'f' AND conkey = ARRAY[v_attnum]
       AND confrelid = format('ref.%I', p_domain)::regclass
  ) THEN
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES ref.%I(code) ON UPDATE CASCADE',
      v_rel, v_fk, p_col, p_domain);
  END IF;
END $fn$;

-- ---------------------------------------------------------------------------
-- 1. Adopt the legacy public.ref_* tables
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.ref_stand_statuses') IS NOT NULL AND to_regclass('ref.stand_status') IS NULL THEN
    ALTER TABLE public.ref_stand_statuses SET SCHEMA ref;
    ALTER TABLE ref.ref_stand_statuses RENAME TO stand_status;
  END IF;
  IF to_regclass('public.ref_use_scales') IS NOT NULL AND to_regclass('ref.development_scale') IS NULL THEN
    ALTER TABLE public.ref_use_scales SET SCHEMA ref;
    ALTER TABLE ref.ref_use_scales RENAME TO development_scale;
  END IF;
  IF to_regclass('public.ref_zone_types') IS NOT NULL AND to_regclass('ref.zone_type') IS NULL THEN
    ALTER TABLE public.ref_zone_types SET SCHEMA ref;
    ALTER TABLE ref.ref_zone_types RENAME TO zone_type;
  END IF;
  IF to_regclass('public.ref_application_statuses') IS NOT NULL AND to_regclass('ref.application_status') IS NULL THEN
    ALTER TABLE public.ref_application_statuses SET SCHEMA ref;
    ALTER TABLE ref.ref_application_statuses RENAME TO application_status;
  END IF;
END $$;

SELECT pg_temp.ref_table('stand_status', 'Stand register status.');
SELECT pg_temp.ref_conform('stand_status');
SELECT pg_temp.ref_table('development_scale', 'Scale category of development (small/large/mixed).');
SELECT pg_temp.ref_conform('development_scale');
SELECT pg_temp.ref_table('zone_type', 'Planning zone type.');
SELECT pg_temp.ref_conform('zone_type');
SELECT pg_temp.ref_table('application_status', 'Legacy online development-application status (public.development_applications).');
SELECT pg_temp.ref_conform('application_status');

-- ref_scale_categories held exactly the same three rows as ref_use_scales.
-- Re-point its only FK (planning_assistant_templates.scale_category) and drop it.
DO $$
BEGIN
  IF to_regclass('public.ref_scale_categories') IS NOT NULL THEN
    INSERT INTO ref.development_scale (code, label)
      SELECT code, label FROM public.ref_scale_categories ON CONFLICT (code) DO NOTHING;
    ALTER TABLE IF EXISTS public.planning_assistant_templates DROP CONSTRAINT IF EXISTS fk_pat_scale_category;
    DROP TABLE public.ref_scale_categories;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Domains
-- ---------------------------------------------------------------------------
SELECT pg_temp.ref_table('abatement_escalation', 'Escalation path when an abatement notice is not complied with (Public Health Act).');
INSERT INTO ref.abatement_escalation (code, label, sort_order) VALUES
  ('works_in_default', 'Works in default', 10),
  ('prosecution', 'Prosecution', 20),
  ('closure', 'Closure', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.abatement_escalation.sort_order = 0;
SELECT pg_temp.ref_table('abatement_notice_type', 'Kind of public-health notice served on a premises or person.');
INSERT INTO ref.abatement_notice_type (code, label, sort_order) VALUES
  ('abatement', 'Abatement', 10),
  ('closure', 'Closure', 20),
  ('works_in_default', 'Works in default', 30),
  ('prohibition', 'Prohibition', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.abatement_notice_type.sort_order = 0;
SELECT pg_temp.ref_table('abatement_status', 'Lifecycle of a served abatement notice.');
INSERT INTO ref.abatement_status (code, label, sort_order) VALUES
  ('served', 'Served', 10),
  ('extended', 'Extended', 20),
  ('complied', 'Complied', 30),
  ('non_complied', 'Non complied', 40),
  ('escalated', 'Escalated', 50),
  ('withdrawn', 'Withdrawn', 60)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.abatement_status.sort_order = 0;
SELECT pg_temp.ref_table('agenda_outcome', 'Committee resolution recorded against an agenda item.');
INSERT INTO ref.agenda_outcome (code, label, sort_order) VALUES
  ('pending', 'Pending', 10),
  ('approved', 'Approved', 20),
  ('approved_with_conditions', 'Approved with conditions', 30),
  ('refused', 'Refused', 40),
  ('deferred', 'Deferred', 50),
  ('noted', 'Noted', 60)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.agenda_outcome.sort_order = 0;
SELECT pg_temp.ref_table('agenda_purpose', 'Why an application is on a committee agenda.');
INSERT INTO ref.agenda_purpose (code, label, sort_order) VALUES
  ('determination', 'Determination', 10),
  ('consideration', 'Consideration', 20),
  ('deputation', 'Deputation', 30),
  ('noting', 'Noting', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.agenda_purpose.sort_order = 0;
SELECT pg_temp.ref_table('allocation_status', 'Whether a stand allocation is still in force.');
INSERT INTO ref.allocation_status (code, label, sort_order) VALUES
  ('active', 'Active', 10),
  ('revoked', 'Revoked', 20)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.allocation_status.sort_order = 0;
SELECT pg_temp.ref_table('appeal_decision', 'Administrative Court / appeal outcome.');
INSERT INTO ref.appeal_decision (code, label, sort_order) VALUES
  ('upheld', 'Upheld', 10),
  ('dismissed', 'Dismissed', 20),
  ('remitted', 'Remitted', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.appeal_decision.sort_order = 0;
SELECT pg_temp.ref_table('appeal_status', 'Lifecycle of an appeal against a planning decision.');
INSERT INTO ref.appeal_status (code, label, sort_order) VALUES
  ('lodged', 'Lodged', 10),
  ('acknowledged', 'Acknowledged', 20),
  ('hearing_scheduled', 'Hearing scheduled', 30),
  ('decided', 'Decided', 40),
  ('withdrawn', 'Withdrawn', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.appeal_status.sort_order = 0;
SELECT pg_temp.ref_table('appellant_type', 'Who lodged the appeal.');
INSERT INTO ref.appellant_type (code, label, sort_order) VALUES
  ('applicant', 'Applicant', 10),
  ('objector', 'Objector', 20),
  ('third_party', 'Third party', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.appellant_type.sort_order = 0;
SELECT pg_temp.ref_table('applicant_type', 'Self-declared citizen applicant category.');
INSERT INTO ref.applicant_type (code, label, sort_order) VALUES
  ('resident', 'Resident', 10),
  ('landowner', 'Landowner', 20),
  ('business', 'Business', 30),
  ('consultant', 'Consultant', 40),
  ('visitor', 'Visitor', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.applicant_type.sort_order = 0;
INSERT INTO ref.application_status (code, label, sort_order) VALUES
  ('submitted', 'Submitted', 10),
  ('under_review', 'Under review', 20),
  ('pending_payment', 'Pending payment', 30),
  ('approved', 'Approved', 40),
  ('conditionally_approved', 'Conditionally approved', 50),
  ('rejected', 'Rejected', 60),
  ('withdrawn', 'Withdrawn', 70),
  ('expired', 'Expired', 80)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.application_status.sort_order = 0;
SELECT pg_temp.ref_table('attendance_status', 'Committee member attendance at a meeting.');
INSERT INTO ref.attendance_status (code, label, sort_order) VALUES
  ('present', 'Present', 10),
  ('apology', 'Apology', 20),
  ('absent', 'Absent', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.attendance_status.sort_order = 0;
SELECT pg_temp.ref_table('beacon_status', 'Field condition of a survey beacon.');
INSERT INTO ref.beacon_status (code, label, sort_order) VALUES
  ('intact', 'Intact', 10),
  ('missing', 'Missing', 20),
  ('damaged', 'Damaged', 30),
  ('replaced', 'Replaced', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.beacon_status.sort_order = 0;
SELECT pg_temp.ref_table('beacon_type', 'Physical type of a survey beacon/peg.');
INSERT INTO ref.beacon_type (code, label, sort_order) VALUES
  ('iron_peg', 'Iron peg', 10),
  ('concrete_beacon', 'Concrete beacon', 20),
  ('survey_nail', 'Survey nail', 30),
  ('witness_beacon', 'Witness beacon', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.beacon_type.sort_order = 0;
SELECT pg_temp.ref_table('building_plan_status', 'Building plan appraisal lifecycle.');
INSERT INTO ref.building_plan_status (code, label, sort_order) VALUES
  ('submitted', 'Submitted', 10),
  ('under_appraisal', 'Under appraisal', 20),
  ('approved', 'Approved', 30),
  ('approved_with_amendments', 'Approved with amendments', 40),
  ('rejected', 'Rejected', 50),
  ('resubmitted', 'Resubmitted', 60)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.building_plan_status.sort_order = 0;
SELECT pg_temp.ref_table('burial_permit_kind', 'Kind of burial-related permit.');
INSERT INTO ref.burial_permit_kind (code, label, sort_order) VALUES
  ('burial', 'Burial', 10),
  ('exhumation', 'Exhumation', 20),
  ('reburial', 'Reburial', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.burial_permit_kind.sort_order = 0;
SELECT pg_temp.ref_table('case_message_type', 'Kind of message on a permit case thread.');
INSERT INTO ref.case_message_type (code, label, sort_order) VALUES
  ('internal_note', 'Internal note', 10),
  ('citizen_message', 'Citizen message', 20),
  ('specialist_comment', 'Specialist comment', 30),
  ('decision_comment', 'Decision comment', 40),
  ('document_request', 'Document request', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.case_message_type.sort_order = 0;
SELECT pg_temp.ref_table('checklist_result', 'Per-item inspection checklist outcome.');
INSERT INTO ref.checklist_result (code, label, sort_order) VALUES
  ('pass', 'Pass', 10),
  ('fail', 'Fail', 20),
  ('na', 'Not applicable', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.checklist_result.sort_order = 0;
SELECT pg_temp.ref_table('citizen_document_kind', 'KYC / supporting document kinds a citizen can upload.');
INSERT INTO ref.citizen_document_kind (code, label, sort_order) VALUES
  ('national_id', 'National ID', 10),
  ('passport', 'Passport', 20),
  ('drivers_licence', 'Drivers licence', 30),
  ('proof_of_residence', 'Proof of residence', 40),
  ('title_deed', 'Title deed', 50),
  ('settlement_letter', 'Settlement letter', 60),
  ('lodgers_permit', 'Lodgers permit', 70),
  ('occupation_certificate', 'Occupation certificate', 80),
  ('chiefs_letter', 'Chiefs letter', 90),
  ('company_registration', 'Company registration', 100),
  ('tax_clearance', 'Tax clearance', 110),
  ('other', 'Other', 120)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.citizen_document_kind.sort_order = 0;
SELECT pg_temp.ref_table('comment_audience', 'Who may see a survey comment.');
INSERT INTO ref.comment_audience (code, label, sort_order) VALUES
  ('planner', 'Planner', 10),
  ('eo', 'Environmental Officer (EO)', 20),
  ('surveyor', 'Surveyor', 30),
  ('citizen', 'Citizen', 40),
  ('all', 'All', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.comment_audience.sort_order = 0;
SELECT pg_temp.ref_table('complaint_category', 'Building-control complaint category.');
INSERT INTO ref.complaint_category (code, label, sort_order) VALUES
  ('building_without_permit', 'Building without permit', 10),
  ('deviation_from_plan', 'Deviation from plan', 20),
  ('dangerous_structure', 'Dangerous structure', 30),
  ('building_line_encroachment', 'Building line encroachment', 40),
  ('unsafe_site', 'Unsafe site', 50),
  ('occupation_without_certificate', 'Occupation without certificate', 60),
  ('other', 'Other', 70)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.complaint_category.sort_order = 0;
SELECT pg_temp.ref_table('complaint_severity', 'Urgency of a building-control complaint.');
INSERT INTO ref.complaint_severity (code, label, sort_order) VALUES
  ('routine', 'Routine', 10),
  ('urgent', 'Urgent', 20),
  ('emergency', 'Emergency', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.complaint_severity.sort_order = 0;
SELECT pg_temp.ref_table('complaint_status', 'Building-control complaint lifecycle.');
INSERT INTO ref.complaint_status (code, label, sort_order) VALUES
  ('received', 'Received', 10),
  ('assigned', 'Assigned', 20),
  ('inspected', 'Inspected', 30),
  ('substantiated', 'Substantiated', 40),
  ('unsubstantiated', 'Unsubstantiated', 50),
  ('closed', 'Closed', 60)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.complaint_status.sort_order = 0;
SELECT pg_temp.ref_table('compliance_status', 'Land-use compliance status of a farm/parcel.');
INSERT INTO ref.compliance_status (code, label, sort_order) VALUES
  ('compliant', 'Compliant', 10),
  ('non_compliant', 'Non compliant', 20),
  ('special_consent_required', 'Special consent required', 30),
  ('pending_review', 'Pending review', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.compliance_status.sort_order = 0;
SELECT pg_temp.ref_table('consultation_response', 'Response received from a consulted body.');
INSERT INTO ref.consultation_response (code, label, sort_order) VALUES
  ('pending', 'Pending', 10),
  ('no_objection', 'No objection', 20),
  ('objection', 'Objection', 30),
  ('conditional_approval', 'Conditional approval', 40),
  ('no_response', 'No response', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.consultation_response.sort_order = 0;
SELECT pg_temp.ref_table('consultation_task_status', 'Workflow status of a consultation task.');
INSERT INTO ref.consultation_task_status (code, label, sort_order) VALUES
  ('open', 'Open', 10),
  ('in_progress', 'In progress', 20),
  ('responded', 'Responded', 30),
  ('accepted', 'Accepted', 40),
  ('returned', 'Returned', 50),
  ('cancelled', 'Cancelled', 60)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.consultation_task_status.sort_order = 0;
SELECT pg_temp.ref_table('consultee_body_type', 'Type of statutory body consulted on an application.');
INSERT INTO ref.consultee_body_type (code, label, sort_order) VALUES
  ('water_authority', 'Water authority', 10),
  ('roads_authority', 'Roads authority', 20),
  ('environmental_agency', 'Environmental agency', 30),
  ('fire_brigade', 'Fire brigade', 40),
  ('electricity_utility', 'Electricity utility', 50),
  ('heritage_office', 'Heritage office', 60),
  ('rural_district_council', 'Rural district council', 70),
  ('military_authority', 'Military authority', 80),
  ('other', 'Other', 90)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.consultee_body_type.sort_order = 0;
SELECT pg_temp.ref_table('control_point_class', 'Trigonometrical control point order (PRIM..QUART, TSM).');
INSERT INTO ref.control_point_class (code, label, sort_order) VALUES
  ('PRIM', 'Primary', 10),
  ('SEC', 'Secondary', 20),
  ('TERT', 'Tertiary', 30),
  ('QUART', 'Quaternary', 40),
  ('TSM', 'Town survey mark', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.control_point_class.sort_order = 0;
SELECT pg_temp.ref_table('coordinate_system', 'Coordinate reference system a survey coordinate was captured in.');
INSERT INTO ref.coordinate_system (code, label, sort_order) VALUES
  ('WGS84', 'WGS 84', 10),
  ('Lo31', 'Gauss Lo31', 20),
  ('Lo29', 'Gauss Lo29', 30),
  ('UTM35S', 'UTM zone 35S', 40),
  ('other', 'Other', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.coordinate_system.sort_order = 0;
SELECT pg_temp.ref_table('correspondence_channel', 'Channel a letter/communication travelled by.');
INSERT INTO ref.correspondence_channel (code, label, sort_order) VALUES
  ('letter', 'Letter', 10),
  ('email', 'Email', 20),
  ('phone', 'Phone', 30),
  ('in_person', 'In person', 40),
  ('fax', 'Fax', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.correspondence_channel.sort_order = 0;
SELECT pg_temp.ref_table('correspondence_direction', 'Incoming or outgoing correspondence.');
INSERT INTO ref.correspondence_direction (code, label, sort_order) VALUES
  ('in', 'Incoming', 10),
  ('out', 'Outgoing', 20)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.correspondence_direction.sort_order = 0;
SELECT pg_temp.ref_table('council_asset_class', 'Class of council-owned asset.');
INSERT INTO ref.council_asset_class (code, label, sort_order) VALUES
  ('office', 'Office', 10),
  ('building', 'Building', 20),
  ('land', 'Land', 30),
  ('market', 'Market', 40),
  ('recreation', 'Recreation', 50),
  ('cemetery', 'Cemetery', 60),
  ('school', 'School', 70),
  ('clinic', 'Clinic', 80),
  ('other', 'Other', 90)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.council_asset_class.sort_order = 0;
SELECT pg_temp.ref_table('currency', 'ISO-style currency codes accepted for payment wallets.');
INSERT INTO ref.currency (code, label, sort_order) VALUES
  ('USD', 'USD', 10),
  ('ZWG', 'ZWG', 20)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.currency.sort_order = 0;
SELECT pg_temp.ref_table('data_quality', 'Provenance/quality grade of an imported council asset record.');
INSERT INTO ref.data_quality (code, label, sort_order) VALUES
  ('authoritative', 'Authoritative', 10),
  ('verified', 'Verified', 20),
  ('unverified', 'Unverified', 30),
  ('reference', 'Reference', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.data_quality.sort_order = 0;
SELECT pg_temp.ref_table('deed_status', 'Deeds Registry title status.');
INSERT INTO ref.deed_status (code, label, sort_order) VALUES
  ('active', 'Active', 10),
  ('transfer_pending', 'Transfer pending', 20),
  ('cancelled', 'Cancelled', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.deed_status.sort_order = 0;
SELECT pg_temp.ref_table('delivery_method', 'How a document was delivered or dispatched.');
INSERT INTO ref.delivery_method (code, label, sort_order) VALUES
  ('collected', 'Collected', 10),
  ('registered_post', 'Registered post', 20),
  ('courier', 'Courier', 30),
  ('email', 'Email', 40),
  ('hand_delivered', 'Hand delivered', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.delivery_method.sort_order = 0;
INSERT INTO ref.development_scale (code, label, sort_order) VALUES
  ('small_scale', 'Small scale', 10),
  ('large_scale', 'Large scale', 20),
  ('mixed_scale', 'Mixed scale', 30),
  ('all_scales', 'All scales', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.development_scale.sort_order = 0;
SELECT pg_temp.ref_table('development_type', 'Type of development applied for (RTCP Act s26).');
INSERT INTO ref.development_type (code, label, sort_order) VALUES
  ('new_building', 'New building', 10),
  ('alteration', 'Alteration', 20),
  ('extension', 'Extension', 30),
  ('change_of_use', 'Change of use', 40),
  ('subdivision', 'Subdivision', 50),
  ('consolidation', 'Consolidation', 60),
  ('rezoning', 'Rezoning', 70),
  ('other', 'Other', 80)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.development_type.sort_order = 0;
SELECT pg_temp.ref_table('document_request_status', 'Lifecycle of a request for more documents.');
INSERT INTO ref.document_request_status (code, label, sort_order) VALUES
  ('open', 'Open', 10),
  ('fulfilled', 'Fulfilled', 20),
  ('waived', 'Waived', 30),
  ('cancelled', 'Cancelled', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.document_request_status.sort_order = 0;
SELECT pg_temp.ref_table('document_review_decision', 'Outcome of an officer reviewing an uploaded document.');
INSERT INTO ref.document_review_decision (code, label, sort_order) VALUES
  ('approved', 'Approved', 10),
  ('rejected', 'Rejected', 20),
  ('replacement_requested', 'Replacement requested', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.document_review_decision.sort_order = 0;
SELECT pg_temp.ref_table('document_source', 'Where a permit document came from.');
INSERT INTO ref.document_source (code, label, sort_order) VALUES
  ('citizen', 'Citizen', 10),
  ('application', 'Application', 20),
  ('generated', 'Generated', 30),
  ('external', 'External', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.document_source.sort_order = 0;
SELECT pg_temp.ref_table('enforcement_order_type', 'Kind of enforcement order (RTCP Act s32-s34).');
INSERT INTO ref.enforcement_order_type (code, label, sort_order) VALUES
  ('enforcement_notice', 'Enforcement notice', 10),
  ('stop_notice', 'Stop notice', 20),
  ('breach_of_condition', 'Breach of condition', 30),
  ('retrospective_consent', 'Retrospective consent', 40),
  ('reinstatement', 'Reinstatement', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.enforcement_order_type.sort_order = 0;
SELECT pg_temp.ref_table('enforcement_status', 'Enforcement order lifecycle.');
INSERT INTO ref.enforcement_status (code, label, sort_order) VALUES
  ('draft', 'Draft', 10),
  ('issued', 'Issued', 20),
  ('served', 'Served', 30),
  ('complied', 'Complied', 40),
  ('non_complied', 'Non complied', 50),
  ('withdrawn', 'Withdrawn', 60),
  ('appealed', 'Appealed', 70)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.enforcement_status.sort_order = 0;
SELECT pg_temp.ref_table('fee_kind', 'Kind of fee on a clerk-issued receipt.');
INSERT INTO ref.fee_kind (code, label, sort_order) VALUES
  ('application', 'Application', 10),
  ('public_notice', 'Public notice', 20),
  ('plan_scrutiny', 'Plan scrutiny', 30),
  ('inspection', 'Inspection', 40),
  ('occupation', 'Occupation', 50),
  ('appeal', 'Appeal', 60),
  ('other', 'Other', 70)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.fee_kind.sort_order = 0;
SELECT pg_temp.ref_table('field_event_type', 'Inspector field check-in events.');
INSERT INTO ref.field_event_type (code, label, sort_order) VALUES
  ('travelling', 'Travelling', 10),
  ('arrived', 'Arrived', 20),
  ('inspection_started', 'Inspection started', 30),
  ('inspection_completed', 'Inspection completed', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.field_event_type.sort_order = 0;
SELECT pg_temp.ref_table('field_programme_status', 'Environmental-health field programme status.');
INSERT INTO ref.field_programme_status (code, label, sort_order) VALUES
  ('planned', 'Planned', 10),
  ('in_progress', 'In progress', 20),
  ('completed', 'Completed', 30),
  ('cancelled', 'Cancelled', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.field_programme_status.sort_order = 0;
SELECT pg_temp.ref_table('field_programme_type', 'Environmental-health field programme type.');
INSERT INTO ref.field_programme_type (code, label, sort_order) VALUES
  ('refuse_collection', 'Refuse collection', 10),
  ('illegal_dump_clearance', 'Illegal dump clearance', 20),
  ('disposal_site_check', 'Disposal site check', 30),
  ('latrine_construction', 'Latrine construction', 40),
  ('indoor_residual_spray', 'Indoor residual spray', 50),
  ('larviciding', 'Larviciding', 60),
  ('rodent_control', 'Rodent control', 70),
  ('health_education', 'Health education', 80),
  ('water_point_maintenance', 'Water point maintenance', 90),
  ('other', 'Other', 100)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.field_programme_type.sort_order = 0;
SELECT pg_temp.ref_table('finding_severity', 'Severity of an automated or manual review finding.');
INSERT INTO ref.finding_severity (code, label, sort_order) VALUES
  ('info', 'Info', 10),
  ('warn', 'Warn', 20),
  ('error', 'Error', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.finding_severity.sort_order = 0;
SELECT pg_temp.ref_table('generated_document_status', 'Lifecycle of a system-generated document.');
INSERT INTO ref.generated_document_status (code, label, sort_order) VALUES
  ('draft', 'Draft', 10),
  ('approved', 'Approved', 20),
  ('issued', 'Issued', 30),
  ('superseded', 'Superseded', 40),
  ('voided', 'Voided', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.generated_document_status.sort_order = 0;
SELECT pg_temp.ref_table('generated_document_type', 'Kinds of document the system generates.');
INSERT INTO ref.generated_document_type (code, label, sort_order) VALUES
  ('due_diligence_report', 'Due diligence report', 10),
  ('committee_report', 'Committee report', 20),
  ('decision_memo', 'Decision memo', 30),
  ('permit', 'Permit', 40),
  ('refusal_letter', 'Refusal letter', 50),
  ('outcome_letter', 'Outcome letter', 60),
  ('acknowledgement', 'Acknowledgement', 70),
  ('map_evidence', 'Map evidence', 80)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.generated_document_type.sort_order = 0;
SELECT pg_temp.ref_table('geofence_result', 'Whether an inspector check-in was on site.');
INSERT INTO ref.geofence_result (code, label, sort_order) VALUES
  ('on_site', 'On site', 10),
  ('off_site', 'Off site', 20),
  ('unverifiable', 'Unverifiable', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.geofence_result.sort_order = 0;
SELECT pg_temp.ref_table('geometry_type', 'Geometry class of a GIS layer.');
INSERT INTO ref.geometry_type (code, label, sort_order) VALUES
  ('polygon', 'Polygon', 10),
  ('line', 'Line', 20),
  ('point', 'Point', 30),
  ('raster', 'Raster', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.geometry_type.sort_order = 0;
SELECT pg_temp.ref_table('handoff_status', 'Planner-to-EO decision package status.');
INSERT INTO ref.handoff_status (code, label, sort_order) VALUES
  ('submitted', 'Submitted', 10),
  ('accepted', 'Accepted', 20),
  ('returned', 'Returned', 30),
  ('decided', 'Decided', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.handoff_status.sort_order = 0;
SELECT pg_temp.ref_table('inspection_booking_status', 'Citizen stage-inspection booking lifecycle.');
INSERT INTO ref.inspection_booking_status (code, label, sort_order) VALUES
  ('pending_payment', 'Pending payment', 10),
  ('waitlisted', 'Waitlisted', 20),
  ('scheduled', 'Scheduled', 30),
  ('rescheduled', 'Rescheduled', 40),
  ('in_progress', 'In progress', 50),
  ('passed', 'Passed', 60),
  ('failed', 'Failed', 70),
  ('cancelled', 'Cancelled', 80)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.inspection_booking_status.sort_order = 0;
SELECT pg_temp.ref_table('inspection_flag_reason', 'Reason an inspection result was flagged for review.');
INSERT INTO ref.inspection_flag_reason (code, label, sort_order) VALUES
  ('work_not_done', 'Work not done', 10),
  ('work_not_to_standard', 'Work not to standard', 20),
  ('photos_dont_match_site', 'Photos dont match site', 30),
  ('safety_issue_missed', 'Safety issue missed', 40),
  ('measurements_incorrect', 'Measurements incorrect', 50),
  ('fraudulent_pass', 'Fraudulent pass', 60),
  ('absent_during_inspection', 'Absent during inspection', 70),
  ('other', 'Other', 80)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.inspection_flag_reason.sort_order = 0;
SELECT pg_temp.ref_table('inspection_flag_status', 'Inspection flag review lifecycle.');
INSERT INTO ref.inspection_flag_status (code, label, sort_order) VALUES
  ('open', 'Open', 10),
  ('under_review', 'Under review', 20),
  ('upheld', 'Upheld', 30),
  ('dismissed', 'Dismissed', 40),
  ('withdrawn', 'Withdrawn', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.inspection_flag_status.sort_order = 0;
SELECT pg_temp.ref_table('land_use_control', 'Zone land-use control (permitted / prohibited / special consent).');
INSERT INTO ref.land_use_control (code, label, sort_order) VALUES
  ('permitted', 'Permitted', 10),
  ('prohibited', 'Prohibited', 20),
  ('special_consent', 'Special consent', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.land_use_control.sort_order = 0;
SELECT pg_temp.ref_table('land_use_purpose', 'Purpose a stand is allocated for.');
INSERT INTO ref.land_use_purpose (code, label, sort_order) VALUES
  ('residential', 'Residential', 10),
  ('commercial', 'Commercial', 20),
  ('industrial', 'Industrial', 30),
  ('institutional', 'Institutional', 40),
  ('agricultural', 'Agricultural', 50),
  ('other', 'Other', 60)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.land_use_purpose.sort_order = 0;
SELECT pg_temp.ref_table('layer_type', 'Type of user-defined map layer.');
INSERT INTO ref.layer_type (code, label, sort_order) VALUES
  ('vector', 'Vector', 10),
  ('raster', 'Raster', 20),
  ('point', 'Point', 30),
  ('polygon', 'Polygon', 40),
  ('line', 'Line', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.layer_type.sort_order = 0;
SELECT pg_temp.ref_table('licence_clearance_status', 'Health clearance decision for a trading licence.');
INSERT INTO ref.licence_clearance_status (code, label, sort_order) VALUES
  ('pending', 'Pending', 10),
  ('cleared', 'Cleared', 20),
  ('conditional', 'Conditional', 30),
  ('refused', 'Refused', 40),
  ('withdrawn', 'Withdrawn', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.licence_clearance_status.sort_order = 0;
SELECT pg_temp.ref_table('licence_type', 'Trading licence type requiring health clearance.');
INSERT INTO ref.licence_type (code, label, sort_order) VALUES
  ('shop', 'Shop', 10),
  ('liquor', 'Liquor', 20),
  ('hawker', 'Hawker', 30),
  ('food_outlet', 'Food outlet', 40),
  ('lodging', 'Lodging', 50),
  ('abattoir', 'Abattoir', 60),
  ('creche', 'Creche', 70),
  ('transport_of_food', 'Transport of food', 80),
  ('other', 'Other', 90)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.licence_type.sort_order = 0;
SELECT pg_temp.ref_table('livestock_facility_type', 'Type of livestock facility.');
INSERT INTO ref.livestock_facility_type (code, label, sort_order) VALUES
  ('dip_tank', 'Dip tank', 10),
  ('stock_pen', 'Stock pen', 20),
  ('watering_point', 'Watering point', 30),
  ('other', 'Other', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.livestock_facility_type.sort_order = 0;
SELECT pg_temp.ref_table('location_source', 'How a record''s map location was obtained.');
INSERT INTO ref.location_source (code, label, sort_order) VALUES
  ('field_gps', 'Field GPS', 10),
  ('map_pick', 'Map pick', 20),
  ('premises', 'Premises', 30),
  ('stand_register', 'Stand register', 40),
  ('permit_site', 'Permit site', 50),
  ('ward_centroid', 'Ward centroid', 60),
  ('intake', 'Intake', 70),
  ('case_file', 'Case file', 80)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.location_source.sort_order = 0;
SELECT pg_temp.ref_table('meeting_status', 'Committee meeting status.');
INSERT INTO ref.meeting_status (code, label, sort_order) VALUES
  ('scheduled', 'Scheduled', 10),
  ('held', 'Held', 20),
  ('cancelled', 'Cancelled', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.meeting_status.sort_order = 0;
SELECT pg_temp.ref_table('message_visibility', 'Who may read a case message.');
INSERT INTO ref.message_visibility (code, label, sort_order) VALUES
  ('internal', 'Internal', 10),
  ('specialist', 'Specialist', 20),
  ('citizen', 'Citizen', 30),
  ('public', 'Public (anonymous)', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.message_visibility.sort_order = 0;
SELECT pg_temp.ref_table('notice_service_method', 'How a statutory notice was served.');
INSERT INTO ref.notice_service_method (code, label, sort_order) VALUES
  ('hand', 'Hand', 10),
  ('registered_post', 'Registered post', 20),
  ('affixed', 'Affixed', 30),
  ('email', 'Email', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.notice_service_method.sort_order = 0;
SELECT pg_temp.ref_table('notifiable_disease', 'Notifiable diseases tracked for outbreaks.');
INSERT INTO ref.notifiable_disease (code, label, sort_order) VALUES
  ('cholera', 'Cholera', 10),
  ('typhoid', 'Typhoid', 20),
  ('dysentery', 'Dysentery', 30),
  ('food_poisoning', 'Food poisoning', 40),
  ('measles', 'Measles', 50),
  ('tb', 'TB', 60),
  ('covid', 'COVID-19', 70),
  ('other', 'Other', 80)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.notifiable_disease.sort_order = 0;
SELECT pg_temp.ref_table('notification_channel', 'Outbound notification channel.');
INSERT INTO ref.notification_channel (code, label, sort_order) VALUES
  ('email', 'Email', 10),
  ('sms', 'SMS', 20),
  ('in_app', 'In-app', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.notification_channel.sort_order = 0;
SELECT pg_temp.ref_table('notification_status', 'Outbound notification delivery status.');
INSERT INTO ref.notification_status (code, label, sort_order) VALUES
  ('pending', 'Pending', 10),
  ('sent', 'Sent', 20),
  ('failed', 'Failed', 30),
  ('cancelled', 'Cancelled', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.notification_status.sort_order = 0;
SELECT pg_temp.ref_table('nuisance_category', 'Public-health nuisance category.');
INSERT INTO ref.nuisance_category (code, label, sort_order) VALUES
  ('smell', 'Smell', 10),
  ('smoke', 'Smoke', 20),
  ('noise', 'Noise', 30),
  ('vermin', 'Vermin', 40),
  ('waste', 'Waste', 50),
  ('water', 'Water', 60),
  ('other', 'Other', 70)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.nuisance_category.sort_order = 0;
SELECT pg_temp.ref_table('nuisance_status', 'Public-health nuisance complaint lifecycle.');
INSERT INTO ref.nuisance_status (code, label, sort_order) VALUES
  ('open', 'Open', 10),
  ('investigating', 'Investigating', 20),
  ('abated', 'Abated', 30),
  ('closed', 'Closed', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.nuisance_status.sort_order = 0;
SELECT pg_temp.ref_table('outbreak_status', 'Disease outbreak investigation status.');
INSERT INTO ref.outbreak_status (code, label, sort_order) VALUES
  ('investigating', 'Investigating', 10),
  ('contained', 'Contained', 20),
  ('closed', 'Closed', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.outbreak_status.sort_order = 0;
SELECT pg_temp.ref_table('parcel_lineage_action', 'How a child parcel was derived from its parent.');
INSERT INTO ref.parcel_lineage_action (code, label, sort_order) VALUES
  ('subdivision', 'Subdivision', 10),
  ('consolidation', 'Consolidation', 20)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.parcel_lineage_action.sort_order = 0;
SELECT pg_temp.ref_table('parcel_party_role', 'Role of a person/company linked to a property.');
INSERT INTO ref.parcel_party_role (code, label, sort_order) VALUES
  ('owner', 'Owner', 10),
  ('occupier', 'Occupier', 20),
  ('agent', 'Agent', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.parcel_party_role.sort_order = 0;
SELECT pg_temp.ref_table('parcel_status', 'Survey parcel lifecycle.');
INSERT INTO ref.parcel_status (code, label, sort_order) VALUES
  ('draft', 'Draft', 10),
  ('finalized', 'Finalized', 20),
  ('approved', 'Approved', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.parcel_status.sort_order = 0;
SELECT pg_temp.ref_table('payment_gateway', 'Payment gateway driver used for a transaction.');
INSERT INTO ref.payment_gateway (code, label, sort_order) VALUES
  ('manual', 'Manual', 10),
  ('paynow', 'Paynow', 20),
  ('stripe', 'Stripe', 30),
  ('ecocash', 'EcoCash', 40),
  ('onemoney', 'OneMoney', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.payment_gateway.sort_order = 0;
SELECT pg_temp.ref_table('payment_method', 'Tender used at the council cash office.');
INSERT INTO ref.payment_method (code, label, sort_order) VALUES
  ('cash', 'Cash', 10),
  ('ecocash', 'EcoCash', 20),
  ('eft', 'EFT', 30),
  ('cheque', 'Cheque', 40),
  ('card', 'Card', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.payment_method.sort_order = 0;
SELECT pg_temp.ref_table('payment_purpose', 'What an online payment is for.');
INSERT INTO ref.payment_purpose (code, label, sort_order) VALUES
  ('application_fee', 'Application fee', 10),
  ('inspection_fee', 'Inspection fee', 20),
  ('permit_fee', 'Permit fee', 30),
  ('occupation_certificate', 'Occupation certificate', 40),
  ('other', 'Other', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.payment_purpose.sort_order = 0;
SELECT pg_temp.ref_table('payment_status', 'Online payment lifecycle.');
INSERT INTO ref.payment_status (code, label, sort_order) VALUES
  ('pending', 'Pending', 10),
  ('awaiting_provider', 'Awaiting provider', 20),
  ('paid', 'Paid', 30),
  ('failed', 'Failed', 40),
  ('cancelled', 'Cancelled', 50),
  ('refunded', 'Refunded', 60)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.payment_status.sort_order = 0;
SELECT pg_temp.ref_table('permit_status', 'Development permit application lifecycle (RTCP Act).');
INSERT INTO ref.permit_status (code, label, sort_order) VALUES
  ('pending_payment', 'Pending payment', 10),
  ('registered', 'Registered', 20),
  ('acknowledged', 'Acknowledged', 30),
  ('circulation', 'Circulation', 40),
  ('objection_period', 'Objection period', 50),
  ('under_review', 'Under review', 60),
  ('deferred', 'Deferred', 70),
  ('approved', 'Approved', 80),
  ('approved_with_conditions', 'Approved with conditions', 90),
  ('refused', 'Refused', 100),
  ('withdrawn', 'Withdrawn', 110),
  ('appealed', 'Appealed', 120)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.permit_status.sort_order = 0;
SELECT pg_temp.ref_table('plan_review_status', 'Automated/staff plan review status.');
INSERT INTO ref.plan_review_status (code, label, sort_order) VALUES
  ('pending', 'Pending', 10),
  ('auto_passed', 'Auto passed', 20),
  ('auto_warnings', 'Auto warnings', 30),
  ('auto_failed', 'Auto failed', 40),
  ('staff_approved', 'Staff approved', 50),
  ('staff_rejected', 'Staff rejected', 60)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.plan_review_status.sort_order = 0;
SELECT pg_temp.ref_table('premises_inspection_scope', 'Scope of a premises health inspection.');
INSERT INTO ref.premises_inspection_scope (code, label, sort_order) VALUES
  ('food_hygiene', 'Food hygiene', 10),
  ('sanitation', 'Sanitation', 20),
  ('water_supply', 'Water supply', 30),
  ('pest_control', 'Pest control', 40),
  ('staff_hygiene', 'Staff hygiene', 50),
  ('general', 'General', 60)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.premises_inspection_scope.sort_order = 0;
SELECT pg_temp.ref_table('premises_inspection_verdict', 'Outcome of a premises health inspection.');
INSERT INTO ref.premises_inspection_verdict (code, label, sort_order) VALUES
  ('pass', 'Pass', 10),
  ('fail', 'Fail', 20),
  ('conditional', 'Conditional', 30),
  ('pending', 'Pending', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.premises_inspection_verdict.sort_order = 0;
SELECT pg_temp.ref_table('premises_type', 'Type of premises registered with Environmental Health.');
INSERT INTO ref.premises_type (code, label, sort_order) VALUES
  ('bakery', 'Bakery', 10),
  ('butchery', 'Butchery', 20),
  ('restaurant', 'Restaurant', 30),
  ('tea_room', 'Tea room', 40),
  ('boarding_house', 'Boarding house', 50),
  ('hotel', 'Hotel', 60),
  ('general_dealer', 'General dealer', 70),
  ('bottle_store', 'Bottle store', 80),
  ('beerhall', 'Beerhall', 90),
  ('creche', 'Creche', 100),
  ('school', 'School', 110),
  ('hostel', 'Hostel', 120),
  ('tuck_shop', 'Tuck shop', 130),
  ('supermarket', 'Supermarket', 140),
  ('factory', 'Factory', 150),
  ('workshop', 'Workshop', 160),
  ('nightclub', 'Nightclub', 170),
  ('lodge', 'Lodge', 180),
  ('abattoir', 'Abattoir', 190),
  ('other', 'Other', 200)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.premises_type.sort_order = 0;
SELECT pg_temp.ref_table('priority', 'Work priority.');
INSERT INTO ref.priority (code, label, sort_order) VALUES
  ('low', 'Low', 10),
  ('normal', 'Normal', 20),
  ('high', 'High', 30),
  ('urgent', 'Urgent', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.priority.sort_order = 0;
SELECT pg_temp.ref_table('prohibition_status', 'Prohibition order lifecycle.');
INSERT INTO ref.prohibition_status (code, label, sort_order) VALUES
  ('issued', 'Issued', 10),
  ('served', 'Served', 20),
  ('challenged', 'Challenged', 30),
  ('confirmed', 'Confirmed', 40),
  ('lifted', 'Lifted', 50),
  ('withdrawn', 'Withdrawn', 60)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.prohibition_status.sort_order = 0;
SELECT pg_temp.ref_table('residency_status', 'Residency verification status of a citizen account.');
INSERT INTO ref.residency_status (code, label, sort_order) VALUES
  ('unverified', 'Unverified', 10),
  ('pending', 'Pending', 20),
  ('verified', 'Verified', 30),
  ('rejected', 'Rejected', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.residency_status.sort_order = 0;
SELECT pg_temp.ref_table('road_status', 'Road asset status.');
INSERT INTO ref.road_status (code, label, sort_order) VALUES
  ('active', 'Active', 10),
  ('proposed', 'Proposed', 20),
  ('decommissioned', 'Decommissioned', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.road_status.sort_order = 0;
SELECT pg_temp.ref_table('road_structure_type', 'Type of road structure.');
INSERT INTO ref.road_structure_type (code, label, sort_order) VALUES
  ('bridge', 'Bridge', 10),
  ('culvert', 'Culvert', 20),
  ('causeway', 'Causeway', 30),
  ('footbridge', 'Footbridge', 40),
  ('other', 'Other', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.road_structure_type.sort_order = 0;
SELECT pg_temp.ref_table('service_ticket_status', 'Service desk ticket lifecycle.');
INSERT INTO ref.service_ticket_status (code, label, sort_order) VALUES
  ('open', 'Open', 10),
  ('in_progress', 'In progress', 20),
  ('closed', 'Closed', 30),
  ('referred', 'Referred', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.service_ticket_status.sort_order = 0;
SELECT pg_temp.ref_table('site_precision', 'Precision of the site geometry used for a geofence check.');
INSERT INTO ref.site_precision (code, label, sort_order) VALUES
  ('boundary', 'Boundary', 10),
  ('point', 'Point', 20),
  ('area', 'Area', 30),
  ('none', 'None', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.site_precision.sort_order = 0;
SELECT pg_temp.ref_table('stage_inspection_result', 'Outcome of a building stage inspection.');
INSERT INTO ref.stage_inspection_result (code, label, sort_order) VALUES
  ('pass', 'Pass', 10),
  ('fail', 'Fail', 20),
  ('conditional_pass', 'Conditional pass', 30),
  ('reinspection_required', 'Reinspection required', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.stage_inspection_result.sort_order = 0;
INSERT INTO ref.stand_status (code, label, sort_order) VALUES
  ('available', 'Available', 10),
  ('reserved', 'Reserved', 20),
  ('allocated', 'Allocated', 30),
  ('withdrawn', 'Withdrawn', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.stand_status.sort_order = 0;
SELECT pg_temp.ref_table('statutory_clock_state', 'State of the statutory decision clock.');
INSERT INTO ref.statutory_clock_state (code, label, sort_order) VALUES
  ('running', 'Running', 10),
  ('paused', 'Paused', 20),
  ('stopped', 'Stopped', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.statutory_clock_state.sort_order = 0;
SELECT pg_temp.ref_table('statutory_plan_kind', 'Type of statutory plan (RTCP Act Part III/IV).');
INSERT INTO ref.statutory_plan_kind (code, label, sort_order) VALUES
  ('regional', 'Regional', 10),
  ('master', 'Master', 20),
  ('local', 'Local', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.statutory_plan_kind.sort_order = 0;
SELECT pg_temp.ref_table('statutory_plan_status', 'Statutory plan preparation lifecycle.');
INSERT INTO ref.statutory_plan_status (code, label, sort_order) VALUES
  ('draft', 'Draft', 10),
  ('exhibition', 'Exhibition', 20),
  ('objections', 'Objections', 30),
  ('submitted', 'Submitted', 40),
  ('approved', 'Approved', 50),
  ('operative', 'Operative', 60),
  ('altered', 'Altered', 70),
  ('repealed', 'Repealed', 80)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.statutory_plan_status.sort_order = 0;
SELECT pg_temp.ref_table('style_fidelity', 'How faithfully a QGIS style converts to web rendering.');
INSERT INTO ref.style_fidelity (code, label, sort_order) VALUES
  ('direct', 'Direct', 10),
  ('converted', 'Converted', 20),
  ('server', 'Server', 30),
  ('unsupported', 'Unsupported', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.style_fidelity.sort_order = 0;
SELECT pg_temp.ref_table('style_renderer', 'QGIS renderer type of a style.');
INSERT INTO ref.style_renderer (code, label, sort_order) VALUES
  ('single', 'Single', 10),
  ('categorized', 'Categorized', 20),
  ('graduated', 'Graduated', 30),
  ('rule_based', 'Rule based', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.style_renderer.sort_order = 0;
SELECT pg_temp.ref_table('style_source', 'Where a style definition came from.');
INSERT INTO ref.style_source (code, label, sort_order) VALUES
  ('qgis', 'QGIS', 10),
  ('statutory_schedule', 'Statutory schedule', 20),
  ('manual', 'Manual', 30),
  ('imported_sld', 'Imported SLD', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.style_source.sort_order = 0;
SELECT pg_temp.ref_table('survey_document_type', 'Survey documents generated for a task.');
INSERT INTO ref.survey_document_type (code, label, sort_order) VALUES
  ('dsg_certificate', 'DSG certificate', 10),
  ('report_on_survey', 'Report on survey', 20)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.survey_document_type.sort_order = 0;
SELECT pg_temp.ref_table('survey_layout_status', 'Township layout plan lifecycle.');
INSERT INTO ref.survey_layout_status (code, label, sort_order) VALUES
  ('pre_survey', 'Pre survey', 10),
  ('designed', 'Designed', 20),
  ('verified', 'Verified', 30),
  ('approved', 'Approved', 40),
  ('pegging', 'Pegging', 50),
  ('completed', 'Completed', 60)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.survey_layout_status.sort_order = 0;
SELECT pg_temp.ref_table('survey_recommendation', 'Surveyor recommendation on a task.');
INSERT INTO ref.survey_recommendation (code, label, sort_order) VALUES
  ('no_objection', 'No objection', 10),
  ('objection', 'Objection', 20),
  ('approve', 'Approve', 30),
  ('approve_conditions', 'Approve conditions', 40),
  ('refuse', 'Refuse', 50),
  ('refer_back', 'Refer back', 60)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.survey_recommendation.sort_order = 0;
SELECT pg_temp.ref_table('survey_task_status', 'Survey task lifecycle.');
INSERT INTO ref.survey_task_status (code, label, sort_order) VALUES
  ('assigned', 'Assigned', 10),
  ('in_progress', 'In progress', 20),
  ('submitted', 'Submitted', 30),
  ('accepted', 'Accepted', 40),
  ('returned', 'Returned', 50),
  ('cancelled', 'Cancelled', 60)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.survey_task_status.sort_order = 0;
SELECT pg_temp.ref_table('survey_task_type', 'Type of survey task.');
INSERT INTO ref.survey_task_type (code, label, sort_order) VALUES
  ('verification', 'Verification', 10),
  ('setting_out', 'Setting out', 20),
  ('pegging', 'Pegging', 30),
  ('layout', 'Layout', 40),
  ('encroachment', 'Encroachment', 50),
  ('beacon_check', 'Beacon check', 60),
  ('general', 'General', 70)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.survey_task_type.sort_order = 0;
SELECT pg_temp.ref_table('survey_user_type', 'Account type in the Survey Task Manager.');
INSERT INTO ref.survey_user_type (code, label, sort_order) VALUES
  ('registered_surveyor', 'Registered surveyor', 10),
  ('surveyor_in_training', 'Surveyor in training', 20),
  ('technician', 'Technician', 30),
  ('student', 'Student', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.survey_user_type.sort_order = 0;
SELECT pg_temp.ref_table('surveyor_type', 'Surveyor professional category.');
INSERT INTO ref.surveyor_type (code, label, sort_order) VALUES
  ('registered', 'Registered', 10),
  ('in_training', 'In training', 20),
  ('technician', 'Technician', 30),
  ('student', 'Student', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.surveyor_type.sort_order = 0;
SELECT pg_temp.ref_table('title_deed_type', 'Type of land title document.');
INSERT INTO ref.title_deed_type (code, label, sort_order) VALUES
  ('deed_of_transfer', 'Deed of transfer', 10),
  ('certificate_of_registered_title', 'Certificate of registered title', 20),
  ('deed_of_grant', 'Deed of grant', 30)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.title_deed_type.sort_order = 0;
SELECT pg_temp.ref_table('user_role', 'Portal role (RBAC).');
INSERT INTO ref.user_role (code, label, sort_order) VALUES
  ('admin', 'Admin', 10),
  ('planner', 'Planner', 20),
  ('viewer', 'Viewer', 30),
  ('eo', 'Environmental Officer (EO)', 40),
  ('env_officer', 'Environmental officer', 50),
  ('building_inspector', 'Building inspector', 60),
  ('planning_clerk', 'Planning clerk', 70),
  ('surveyor', 'Surveyor', 80),
  ('gis_officer', 'GIS officer', 90),
  ('public', 'Public (anonymous)', 100),
  ('registered', 'Registered', 110)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.user_role.sort_order = 0;
SELECT pg_temp.ref_table('user_status', 'Portal account status.');
INSERT INTO ref.user_status (code, label, sort_order) VALUES
  ('active', 'Active', 10),
  ('suspended', 'Suspended', 20),
  ('pending', 'Pending', 30),
  ('deleted', 'Deleted', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.user_status.sort_order = 0;
SELECT pg_temp.ref_table('verification_status', 'Verification lifecycle of an uploaded identity document.');
INSERT INTO ref.verification_status (code, label, sort_order) VALUES
  ('pending', 'Pending', 10),
  ('under_review', 'Under review', 20),
  ('verified', 'Verified', 30),
  ('rejected', 'Rejected', 40),
  ('expired', 'Expired', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.verification_status.sort_order = 0;
SELECT pg_temp.ref_table('wash_asset_type', 'Water, sanitation & hygiene asset type.');
INSERT INTO ref.wash_asset_type (code, label, sort_order) VALUES
  ('borehole', 'Borehole', 10),
  ('well', 'Well', 20),
  ('water_point', 'Water point', 30),
  ('tank', 'Tank', 40),
  ('reservoir', 'Reservoir', 50),
  ('pipeline', 'Pipeline', 60),
  ('scheme', 'Scheme', 70),
  ('treatment', 'Treatment', 80),
  ('pump', 'Pump', 90),
  ('toilet', 'Toilet', 100),
  ('septic', 'Septic', 110),
  ('waste_site', 'Waste site', 120),
  ('other', 'Other', 130)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.wash_asset_type.sort_order = 0;
SELECT pg_temp.ref_table('wash_operational_status', 'Operational condition of a WASH asset.');
INSERT INTO ref.wash_operational_status (code, label, sort_order) VALUES
  ('working', 'Working', 10),
  ('broken', 'Broken', 20),
  ('seasonal', 'Seasonal', 30),
  ('unknown', 'Unknown', 40),
  ('decommissioned', 'Decommissioned', 50)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.wash_operational_status.sort_order = 0;
SELECT pg_temp.ref_table('water_sample_result', 'Bacteriological water sample result.');
INSERT INTO ref.water_sample_result (code, label, sort_order) VALUES
  ('potable', 'Potable', 10),
  ('not_potable', 'Not potable', 20),
  ('borderline', 'Borderline', 30),
  ('pending', 'Pending', 40)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.water_sample_result.sort_order = 0;
SELECT pg_temp.ref_table('water_source_type', 'Water source a sample was taken from.');
INSERT INTO ref.water_source_type (code, label, sort_order) VALUES
  ('borehole', 'Borehole', 10),
  ('piped_supply', 'Piped supply', 20),
  ('reservoir', 'Reservoir', 30),
  ('well', 'Well', 40),
  ('river', 'River', 50),
  ('dam', 'Dam', 60),
  ('spring', 'Spring', 70),
  ('other', 'Other', 80)
ON CONFLICT (code) DO UPDATE SET sort_order = EXCLUDED.sort_order WHERE ref.water_source_type.sort_order = 0;

UPDATE ref.zone_type z SET sort_order = s.rn * 10
  FROM (SELECT code, row_number() OVER (ORDER BY category NULLS LAST, code) rn FROM ref.zone_type) s
 WHERE s.code = z.code AND z.sort_order = 0;
UPDATE ref.stand_status SET sort_order = sort_order * 10 WHERE sort_order < 10;

-- ---------------------------------------------------------------------------
-- 3. style_status: replace the gis_style_status ENUM with a lookup table
-- ---------------------------------------------------------------------------
SELECT pg_temp.ref_table('style_status', 'Governed style lifecycle (draft -> published -> archived).');
INSERT INTO ref.style_status (code, label, sort_order) VALUES
  ('draft', 'Draft', 10), ('review', 'In review', 20), ('approved', 'Approved', 30),
  ('published', 'Published', 40), ('deprecated', 'Deprecated', 50), ('archived', 'Archived', 60)
ON CONFLICT (code) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'gis_style_status') THEN
    DROP VIEW IF EXISTS public.gis_published_style;
    DROP INDEX IF EXISTS public.gis_style_one_published_per_layer;
    -- business-rule CHECKs that compare against enum literals (re-added below)
    ALTER TABLE public.gis_style DROP CONSTRAINT IF EXISTS gis_style_approved_fields;
    ALTER TABLE public.gis_style DROP CONSTRAINT IF EXISTS gis_style_no_unsupported_publish;
    ALTER TABLE public.gis_style ALTER COLUMN status DROP DEFAULT;
    ALTER TABLE public.gis_style ALTER COLUMN status TYPE varchar(20) USING status::text;
    ALTER TABLE public.gis_style ALTER COLUMN status SET DEFAULT 'draft';
    ALTER TABLE public.gis_style_audit ALTER COLUMN from_status TYPE varchar(20) USING from_status::text;
    ALTER TABLE public.gis_style_audit ALTER COLUMN to_status   TYPE varchar(20) USING to_status::text;
    DROP TYPE gis_style_status;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.gis_style') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS gis_style_one_published_per_layer
      ON public.gis_style (layer_id) WHERE status = 'published';
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gis_style_approved_fields') THEN
      ALTER TABLE public.gis_style ADD CONSTRAINT gis_style_approved_fields
        CHECK (status <> 'published' OR (approved_by IS NOT NULL AND published_at IS NOT NULL));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gis_style_no_unsupported_publish') THEN
      ALTER TABLE public.gis_style ADD CONSTRAINT gis_style_no_unsupported_publish
        CHECK (fidelity <> 'unsupported' OR status <> 'published');
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.gis_style') IS NOT NULL THEN
    PERFORM pg_temp.ref_bind('public', 'gis_style',       'status',      'style_status');
    PERFORM pg_temp.ref_bind('public', 'gis_style_audit', 'from_status', 'style_status');
    PERFORM pg_temp.ref_bind('public', 'gis_style_audit', 'to_status',   'style_status');
  END IF;
END $$;

-- Same definition as migration 114, minus the enum cast.
DO $$
BEGIN
  IF to_regclass('public.gis_layer') IS NOT NULL AND to_regclass('public.gis_published_style') IS NULL THEN
    CREATE VIEW public.gis_published_style AS
    SELECT l.layer_id, l.display_name, l.description, l.geometry, l.data_source,
           l.data_srid, l.data_synced_at, l.qgis_project, l.qgis_layer, l.owner,
           l.steward, l.access_roles,
           COALESCE(s.scale_min_zoom, l.min_zoom) AS min_zoom,
           COALESCE(s.scale_max_zoom, l.max_zoom) AS max_zoom,
           s.style_id, s.style_name, s.style_version, s.source, s.source_path,
           s.definition, s.renderer_type, s.classification_attribute,
           s.classification_method, s.opacity, s.fidelity, s.fidelity_notes,
           s.checksum, s.approved_by, s.published_by,
           s.published_at AS style_published_at
      FROM public.gis_layer l
      LEFT JOIN public.gis_style s ON s.layer_id = l.layer_id AND s.status = 'published'
     WHERE l.is_active;
  END IF;
END $$;

-- The application_status ENUM was never used by any column.
DROP TYPE IF EXISTS application_status;

-- ---------------------------------------------------------------------------
-- 4. OSM feature classes (Geofabrik fclass <-> numeric code, 1:1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref.osm_feature_class (
  fclass     varchar(64) PRIMARY KEY,
  osm_code   integer     UNIQUE,
  label      varchar(120) NOT NULL,
  is_active  boolean     NOT NULL DEFAULT true
);
COMMENT ON TABLE ref.osm_feature_class IS
  'Geofabrik OpenStreetMap feature classes. fclass is what tiles/QML style on; osm_code is the Geofabrik numeric code (moved here from every basemap row by migration 131).';

DO $$
DECLARE
  t text;
  osm_tables text[] := ARRAY[
    'buildings','roads','railways','waterways','water_areas','landuse','natural_areas',
    'natural_points','places_areas','places_points','places_of_worship_areas',
    'places_of_worship_points','pois_areas','pois_points','traffic_areas','traffic_points',
    'transport_areas','transport_points','protected_areas','admin_areas'];
  has_code boolean;
BEGIN
  FOREACH t IN ARRAY osm_tables LOOP
    CONTINUE WHEN to_regclass(format('public.%I', t)) IS NULL;
    SELECT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = t AND column_name = 'code')
      INTO has_code;
    EXECUTE format(
      'INSERT INTO ref.osm_feature_class (fclass, osm_code, label)
         SELECT fclass, %s, initcap(replace(fclass, ''_'', '' ''))
           FROM public.%I WHERE fclass IS NOT NULL GROUP BY fclass
       ON CONFLICT (fclass) DO NOTHING',
      CASE WHEN has_code THEN 'min(code)' ELSE 'NULL::integer' END, t);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = format('public.%I', t)::regclass
                      AND conname = left(format('fk_%s_fclass', t), 63)) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (fclass)
           REFERENCES ref.osm_feature_class(fclass) ON UPDATE CASCADE',
        t, left(format('fk_%s_fclass', t), 63));
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Bind columns to their domains
-- ---------------------------------------------------------------------------
SELECT pg_temp.ref_bind('spatial_planning', 'control_point', 'type', 'control_point_class');
SELECT pg_temp.ref_bind('survey', 'zim_control_points', 'type', 'control_point_class');
SELECT pg_temp.ref_bind('public', 'payments', 'wallet_ccy', 'currency');
SELECT pg_temp.ref_bind('spatial_planning', 'survey_coordinate', 'coord_system', 'coordinate_system');
SELECT pg_temp.ref_bind('spatial_planning', 'health_abatement_notice', 'notice_type', 'abatement_notice_type');
SELECT pg_temp.ref_bind('council_ops', 'road_asset', 'status', 'road_status');
SELECT pg_temp.ref_bind('public', 'stand_allocation', 'status', 'allocation_status');
SELECT pg_temp.ref_bind('public', 'users', 'status', 'user_status');
SELECT pg_temp.ref_bind('public', 'lands_registry_deeds', 'status', 'deed_status');
SELECT pg_temp.ref_bind('public', 'invites', 'role', 'user_role');
SELECT pg_temp.ref_bind('spatial_planning', 'application_appeal', 'appellant_type', 'appellant_type');
SELECT pg_temp.ref_bind('planning_clerk', 'fee_receipt', 'fee_kind', 'fee_kind');
SELECT pg_temp.ref_bind('public', 'payments', 'purpose', 'payment_purpose');
SELECT pg_temp.ref_bind('spatial_planning', 'document_review', 'decision', 'document_review_decision');
SELECT pg_temp.ref_bind('spatial_planning', 'survey_task', 'status', 'survey_task_status');
SELECT pg_temp.ref_bind('council_ops', 'road_asset', 'data_quality', 'data_quality');
SELECT pg_temp.ref_bind('spatial_planning', 'available_stand', 'status', 'stand_status');
SELECT pg_temp.ref_bind('public', 'stands', 'status', 'stand_status');
SELECT pg_temp.ref_bind('spatial_planning', 'health_premises', 'premises_type', 'premises_type');
SELECT pg_temp.ref_bind('spatial_planning', 'health_water_sample', 'source_type', 'water_source_type');
SELECT pg_temp.ref_bind('council_ops', 'wash_asset', 'asset_type', 'wash_asset_type');
SELECT pg_temp.ref_bind('spatial_planning', 'stage_inspection_field_event', 'site_precision', 'site_precision');
SELECT pg_temp.ref_bind('council_ops', 'road_structure', 'structure_type', 'road_structure_type');
SELECT pg_temp.ref_bind('spatial_planning', 'building_complaint', 'category', 'complaint_category');
SELECT pg_temp.ref_bind('spatial_planning', 'health_burial_permit', 'permit_kind', 'burial_permit_kind');
SELECT pg_temp.ref_bind('planning_clerk', 'fee_receipt', 'payment_method', 'payment_method');
SELECT pg_temp.ref_bind('spatial_planning', 'health_outbreak', 'disease', 'notifiable_disease');
SELECT pg_temp.ref_bind('spatial_planning', 'permit_document', 'source', 'document_source');
SELECT pg_temp.ref_bind('planning_clerk', 'permit_dispatch', 'delivery_method', 'delivery_method');
SELECT pg_temp.ref_bind('public', 'gweru_rural_farms', 'compliance_status', 'compliance_status');
SELECT pg_temp.ref_bind('public', 'gweru_rural_farms', 'title_deed_type', 'title_deed_type');
SELECT pg_temp.ref_bind('spatial_planning', 'agenda_item', 'purpose', 'agenda_purpose');
SELECT pg_temp.ref_bind('council_ops', 'livestock_facility', 'facility_type', 'livestock_facility_type');
SELECT pg_temp.ref_bind('public', 'gis_style', 'fidelity', 'style_fidelity');
SELECT pg_temp.ref_bind('spatial_planning', 'generated_document', 'status', 'generated_document_status');
SELECT pg_temp.ref_bind('spatial_planning', 'statutory_plan', 'status', 'statutory_plan_status');
SELECT pg_temp.ref_bind('spatial_planning', 'survey_parcel', 'status', 'parcel_status');
SELECT pg_temp.ref_bind('survey', 'land_parcels', 'status', 'parcel_status');
SELECT pg_temp.ref_bind('spatial_planning', 'enforcement_order', 'status', 'enforcement_status');
SELECT pg_temp.ref_bind('spatial_planning', 'survey_document', 'doc_type', 'survey_document_type');
SELECT pg_temp.ref_bind('spatial_planning', 'generated_document', 'doc_type', 'generated_document_type');
SELECT pg_temp.ref_bind('public', 'notifications_outbox', 'channel', 'notification_channel');
SELECT pg_temp.ref_bind('spatial_planning', 'enforcement_order', 'order_type', 'enforcement_order_type');
SELECT pg_temp.ref_bind('spatial_planning', 'health_water_sample', 'location_source', 'location_source');
SELECT pg_temp.ref_bind('spatial_planning', 'health_premises_inspection', 'location_source', 'location_source');
SELECT pg_temp.ref_bind('spatial_planning', 'health_nuisance_complaint', 'location_source', 'location_source');
SELECT pg_temp.ref_bind('spatial_planning', 'health_premises', 'location_source', 'location_source');
SELECT pg_temp.ref_bind('spatial_planning', 'health_field_programme', 'location_source', 'location_source');
SELECT pg_temp.ref_bind('spatial_planning', 'health_outbreak', 'location_source', 'location_source');
SELECT pg_temp.ref_bind('spatial_planning', 'health_premises_inspection', 'scope', 'premises_inspection_scope');
SELECT pg_temp.ref_bind('spatial_planning', 'health_abatement_notice', 'served_method', 'notice_service_method');
SELECT pg_temp.ref_bind('planning_clerk', 'correspondence', 'direction', 'correspondence_direction');
SELECT pg_temp.ref_bind('public', 'plan_review_findings', 'severity', 'finding_severity');
SELECT pg_temp.ref_bind('spatial_planning', 'building_plan_annotation', 'severity', 'finding_severity');
SELECT pg_temp.ref_bind('spatial_planning', 'survey_beacon', 'status', 'beacon_status');
SELECT pg_temp.ref_bind('spatial_planning', 'permit_application', 'location_source', 'location_source');
SELECT pg_temp.ref_bind('spatial_planning', 'case_message', 'visibility', 'message_visibility');
SELECT pg_temp.ref_bind('spatial_planning', 'case_message', 'message_type', 'case_message_type');
SELECT pg_temp.ref_bind('spatial_planning', 'health_outbreak', 'status', 'outbreak_status');
SELECT pg_temp.ref_bind('spatial_planning', 'survey_beacon', 'beacon_type', 'beacon_type');
SELECT pg_temp.ref_bind('spatial_planning', 'prohibition_order', 'status', 'prohibition_status');
SELECT pg_temp.ref_bind('planning_clerk', 'correspondence', 'channel', 'correspondence_channel');
SELECT pg_temp.ref_bind('spatial_planning', 'application_appeal', 'status', 'appeal_status');
SELECT pg_temp.ref_bind('spatial_planning', 'application_consultation', 'priority', 'priority');
SELECT pg_temp.ref_bind('spatial_planning', 'survey_task', 'priority', 'priority');
SELECT pg_temp.ref_bind('public', 'payments', 'driver', 'payment_gateway');
SELECT pg_temp.ref_bind('public', 'citizen_documents', 'doc_kind', 'citizen_document_kind');
SELECT pg_temp.ref_bind('spatial_planning', 'permit_application', 'development_type', 'development_type');
SELECT pg_temp.ref_bind('spatial_planning', 'survey_finding', 'recommendation', 'survey_recommendation');
SELECT pg_temp.ref_bind('council_ops', 'council_asset', 'asset_class', 'council_asset_class');
SELECT pg_temp.ref_bind('spatial_planning', 'stage_inspection_field_event', 'geofence_result', 'geofence_result');
SELECT pg_temp.ref_bind('spatial_planning', 'document_request', 'status', 'document_request_status');
SELECT pg_temp.ref_bind('council_ops', 'service_desk_ticket', 'status', 'service_ticket_status');
SELECT pg_temp.ref_bind('spatial_planning', 'application_consultation', 'task_status', 'consultation_task_status');
SELECT pg_temp.ref_bind('spatial_planning', 'health_nuisance_complaint', 'status', 'nuisance_status');
SELECT pg_temp.ref_bind('spatial_planning', 'stage_inspection_flag', 'status', 'inspection_flag_status');
SELECT pg_temp.ref_bind('spatial_planning', 'parcel_owner', 'role', 'parcel_party_role');
SELECT pg_temp.ref_bind('spatial_planning', 'health_premises_inspection', 'verdict', 'premises_inspection_verdict');
SELECT pg_temp.ref_bind('spatial_planning', 'stage_inspection', 'result', 'stage_inspection_result');
SELECT pg_temp.ref_bind('spatial_planning', 'inspection_checklist_result', 'result', 'checklist_result');
SELECT pg_temp.ref_bind('spatial_planning', 'agenda_item', 'outcome', 'agenda_outcome');
SELECT pg_temp.ref_bind('public', 'plan_reviews', 'status', 'plan_review_status');
SELECT pg_temp.ref_bind('public', 'payments', 'status', 'payment_status');
SELECT pg_temp.ref_bind('spatial_planning', 'health_licence_clearance', 'status', 'licence_clearance_status');
SELECT pg_temp.ref_bind('spatial_planning', 'application_consultation', 'response_status', 'consultation_response');
SELECT pg_temp.ref_bind('public', 'notifications_outbox', 'status', 'notification_status');
SELECT pg_temp.ref_bind('public', 'citizen_documents', 'verification_status', 'verification_status');
SELECT pg_temp.ref_bind('spatial_planning', 'permit_application', 'status', 'permit_status');
SELECT pg_temp.ref_bind('public', 'inspection_bookings', 'status', 'inspection_booking_status');
SELECT pg_temp.ref_bind('public', 'zone_land_use_controls', 'control_type', 'land_use_control');
SELECT pg_temp.ref_bind('spatial_planning', 'health_field_programme', 'status', 'field_programme_status');
SELECT pg_temp.ref_bind('spatial_planning', 'survey_comment', 'audience', 'comment_audience');
SELECT pg_temp.ref_bind('public', 'gis_layer', 'geometry', 'geometry_type');
SELECT pg_temp.ref_bind('spatial_planning', 'health_water_sample', 'result', 'water_sample_result');
SELECT pg_temp.ref_bind('spatial_planning', 'survey_layout', 'status', 'survey_layout_status');
SELECT pg_temp.ref_bind('spatial_planning', 'meeting_attendance', 'status', 'attendance_status');
SELECT pg_temp.ref_bind('public', 'users', 'role', 'user_role');
SELECT pg_temp.ref_bind('public', 'gis_style', 'source', 'style_source');
SELECT pg_temp.ref_bind('spatial_planning', 'building_complaint', 'status', 'complaint_status');
SELECT pg_temp.ref_bind('spatial_planning', 'health_field_programme', 'programme_type', 'field_programme_type');
SELECT pg_temp.ref_bind('spatial_planning', 'statutory_plan', 'kind', 'statutory_plan_kind');
SELECT pg_temp.ref_bind('survey', 'surveyor_profiles', 'surveyor_type', 'surveyor_type');
SELECT pg_temp.ref_bind('planning_clerk', 'abutter_notification', 'method', 'delivery_method');
SELECT pg_temp.ref_bind('survey', 'users', 'user_type', 'survey_user_type');
SELECT pg_temp.ref_bind('public', 'users', 'applicant_type', 'applicant_type');
SELECT pg_temp.ref_bind('public', 'stand_allocation', 'purpose', 'land_use_purpose');
SELECT pg_temp.ref_bind('spatial_planning', 'building_complaint', 'severity', 'complaint_severity');
SELECT pg_temp.ref_bind('spatial_planning', 'permit_application', 'clock_state', 'statutory_clock_state');
SELECT pg_temp.ref_bind('spatial_planning', 'committee_meeting', 'status', 'meeting_status');
SELECT pg_temp.ref_bind('spatial_planning', 'health_abatement_notice', 'status', 'abatement_status');
SELECT pg_temp.ref_bind('spatial_planning', 'health_licence_clearance', 'licence_type', 'licence_type');
SELECT pg_temp.ref_bind('public', 'gis_style', 'renderer_type', 'style_renderer');
SELECT pg_temp.ref_bind('public', 'planning_assistant_templates', 'scale_category', 'development_scale');
SELECT pg_temp.ref_bind('spatial_planning', 'health_nuisance_complaint', 'category', 'nuisance_category');
SELECT pg_temp.ref_bind('spatial_planning', 'parcel_lineage', 'action', 'parcel_lineage_action');
SELECT pg_temp.ref_bind('spatial_planning', 'eo_handoff_package', 'status', 'handoff_status');
SELECT pg_temp.ref_bind('spatial_planning', 'building_plan', 'status', 'building_plan_status');
SELECT pg_temp.ref_bind('public', 'development_applications', 'status', 'application_status');
SELECT pg_temp.ref_bind('spatial_planning', 'stage_inspection_field_event', 'event_type', 'field_event_type');
SELECT pg_temp.ref_bind('public', 'users', 'residency_status', 'residency_status');
SELECT pg_temp.ref_bind('spatial_planning', 'application_appeal', 'decision', 'appeal_decision');
SELECT pg_temp.ref_bind('public', 'layers', 'type', 'layer_type');
SELECT pg_temp.ref_bind('spatial_planning', 'survey_task', 'task_type', 'survey_task_type');
SELECT pg_temp.ref_bind('spatial_planning', 'application_consultation', 'body_type', 'consultee_body_type');
SELECT pg_temp.ref_bind('spatial_planning', 'stage_inspection_flag', 'reason_code', 'inspection_flag_reason');
SELECT pg_temp.ref_bind('council_ops', 'wash_asset', 'operational', 'wash_operational_status');
SELECT pg_temp.ref_bind('spatial_planning', 'health_abatement_notice', 'escalation', 'abatement_escalation');
SELECT pg_temp.ref_bind('council_ops', 'council_asset', 'data_quality', 'data_quality');
SELECT pg_temp.ref_bind('council_ops', 'livestock_facility', 'data_quality', 'data_quality');
SELECT pg_temp.ref_bind('council_ops', 'road_structure', 'data_quality', 'data_quality');
SELECT pg_temp.ref_bind('council_ops', 'wash_asset', 'data_quality', 'data_quality');
SELECT pg_temp.ref_bind('public', 'land_use_groups', 'use_scale', 'development_scale');
SELECT pg_temp.ref_bind('public', 'stands', 'use_scale', 'development_scale');
SELECT pg_temp.ref_bind('public', 'proposed_peri_urban_zones', 'scale_category', 'development_scale');
SELECT pg_temp.ref_bind('public', 'planning_assistant_templates', 'zone_type', 'zone_type');

COMMIT;
