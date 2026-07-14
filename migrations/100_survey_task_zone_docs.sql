-- Migration 100: job-level zone selection, reference control points, and
-- generated survey documents (survey-suite-nov-alpha integration, Phase 5).
--
-- Three small additive pieces, bundled because each is a handful of lines
-- and they're all in service of the same goal (QGIS export + DSG
-- certificate / Report on Survey documents need to know which Lo-zone and
-- which reference monuments a job used):
--
--   1. survey_task.gauss_lo — the working central-meridian zone for this
--      job, so exports know which zone to transform from instead of
--      hardcoding Lo31 everywhere. Defaults to 31 (the zone the frontend's
--      coordinateTransform.ts already hardcodes as "the standard system
--      used in Zimbabwe for cadastral mapping") — additive, existing rows
--      get a sane default, nothing breaks.
--
--   2. survey_task_control_point — which national control_point monuments
--      (migration 098) were used as reference for a given job. Plain link
--      table, no extra metadata columns — add a note field when someone
--      needs to record *why* a point was used, not speculatively now.
--
--   3. survey_document — rendered DSG Certificate / Report on Survey
--      content, stored as HTML in the DB (not a file). ponytail: this is
--      the SAME lesson migration 087 already learned for the permit
--      workflow's generated_document table (Render's filesystem is
--      ephemeral, a file on disk is lost on redeploy) — but that table is
--      hard-wired to permit_app_id NOT NULL with a doc_type CHECK list
--      scoped to permit decisions, so it doesn't fit survey_task work
--      (which can be standalone, no permit_app_id at all). Same pattern,
--      new table, rather than loosening a constraint on a table another
--      workflow depends on.
--
-- Depends on: 080 (survey_task), 098 (control_point).

BEGIN;

ALTER TABLE spatial_planning.survey_task
  ADD COLUMN IF NOT EXISTS gauss_lo SMALLINT NOT NULL DEFAULT 31
    CHECK (gauss_lo IN (25, 27, 29, 31, 33));

CREATE TABLE IF NOT EXISTS spatial_planning.survey_task_control_point (
  survey_task_id   UUID NOT NULL REFERENCES spatial_planning.survey_task(id) ON DELETE CASCADE,
  control_point_id INTEGER NOT NULL REFERENCES spatial_planning.control_point(id) ON DELETE CASCADE,
  PRIMARY KEY (survey_task_id, control_point_id)
);

CREATE TABLE IF NOT EXISTS spatial_planning.survey_document (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_task_id UUID NOT NULL REFERENCES spatial_planning.survey_task(id) ON DELETE CASCADE,
  doc_type       VARCHAR(20) NOT NULL CHECK (doc_type IN ('dsg_certificate', 'report_on_survey')),
  title          VARCHAR(200) NOT NULL,
  content        TEXT NOT NULL,           -- rendered HTML, printable via browser print-to-PDF
  generated_by   UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_survey_document_task ON spatial_planning.survey_document(survey_task_id);

-- v_survey_task (080) lists columns explicitly rather than st.* — add the
-- new column here too or loadTask() in src/routes/surveyor.js never sees it.
CREATE OR REPLACE VIEW spatial_planning.v_survey_task AS
SELECT
  st.id,
  st.permit_app_id,
  st.task_type,
  st.stand_number,
  st.suburb_ward,
  st.gauss_lo,
  ST_X(st.location)    AS lng,
  ST_Y(st.location)    AS lat,
  st.instructions,
  st.priority,
  st.due_date,
  st.status,
  st.assigned_by,
  st.assigned_to,
  st.created_at,
  st.updated_at,
  pa.applicant_name,
  pa.applicant_phone,
  pa.applicant_email,
  pa.development_type,
  pa.description       AS application_description,
  pa.status            AS application_status,
  pa.site_plan_url,
  pa.dev_register_no,
  pa.tpd_reference,
  (SELECT COUNT(*) FROM spatial_planning.survey_finding f WHERE f.survey_task_id = st.id) AS finding_count
FROM spatial_planning.survey_task st
LEFT JOIN spatial_planning.permit_application pa ON pa.id = st.permit_app_id;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 100 complete — survey_task.gauss_lo, survey_task_control_point, survey_document installed';
END $$;
