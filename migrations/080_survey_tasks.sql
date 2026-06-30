-- Migration 080: Surveyor survey tasks, findings, and cadastral records
--
-- Adds the dedicated survey workflow on top of the DM Handbook spine (070):
-- a planner/EO assigns a survey_task against a permit_application; the
-- surveyor captures findings, coordinates, beacons, layouts, and comments;
-- planner/EO read the findings back. All tables live in spatial_planning.
--
-- FK conventions (mirror 070):
--   permit_app_id → spatial_planning.permit_application(id) ON DELETE CASCADE
--   *_by / *_to / author_id → public.users(id) ON DELETE SET NULL
--
-- Depends on: migration 070 (permit_application, spatial_planning.set_updated_at()).
-- Apply with: node scripts/migrate-render.js  (080 is in the MIGRATIONS array)

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- SURVEY TASKS
-- A unit of survey work assigned by a planner/EO against an application
-- (or standalone cadastral work when permit_app_id is NULL).
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS spatial_planning.survey_task (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id       UUID REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,

  task_type           VARCHAR(30) NOT NULL DEFAULT 'general'
                        CHECK (task_type IN (
                          'verification', 'setting_out', 'pegging', 'layout',
                          'encroachment', 'beacon_check', 'general'
                        )),
  stand_number        VARCHAR(40),
  suburb_ward         VARCHAR(80),
  location            GEOMETRY(Point, 4326),

  instructions        TEXT,
  priority            VARCHAR(10) NOT NULL DEFAULT 'normal'
                        CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_date            DATE,

  status              VARCHAR(20) NOT NULL DEFAULT 'assigned'
                        CHECK (status IN (
                          'assigned', 'in_progress', 'submitted',
                          'accepted', 'returned', 'cancelled'
                        )),

  assigned_by         UUID REFERENCES public.users(id) ON DELETE SET NULL,
  assigned_to         UUID REFERENCES public.users(id) ON DELETE SET NULL,

  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_survey_task_permit_app ON spatial_planning.survey_task(permit_app_id);
CREATE INDEX IF NOT EXISTS idx_survey_task_assigned_to ON spatial_planning.survey_task(assigned_to);
CREATE INDEX IF NOT EXISTS idx_survey_task_status      ON spatial_planning.survey_task(status);
CREATE INDEX IF NOT EXISTS idx_survey_task_location    ON spatial_planning.survey_task USING GIST(location);

-- ════════════════════════════════════════════════════════════════════
-- SURVEY FINDINGS — surveyor's report back to planner/EO
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS spatial_planning.survey_finding (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_task_id      UUID NOT NULL REFERENCES spatial_planning.survey_task(id) ON DELETE CASCADE,

  summary             TEXT NOT NULL,
  recommendation      VARCHAR(20)
                        CHECK (recommendation IN (
                          'no_objection', 'objection', 'approve',
                          'approve_conditions', 'refuse', 'refer_back'
                        )),
  conditions          TEXT,
  notes               TEXT,

  submitted_by        UUID REFERENCES public.users(id) ON DELETE SET NULL,
  submitted_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_survey_finding_task ON spatial_planning.survey_finding(survey_task_id);

-- ════════════════════════════════════════════════════════════════════
-- CADASTRAL RECORDS — coordinates, beacons, layouts
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS spatial_planning.survey_coordinate (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_task_id      UUID NOT NULL REFERENCES spatial_planning.survey_task(id) ON DELETE CASCADE,
  label               VARCHAR(60),
  coord_system        VARCHAR(20) NOT NULL DEFAULT 'WGS84'
                        CHECK (coord_system IN ('WGS84', 'Lo31', 'Lo29', 'UTM35S', 'other')),
  easting             NUMERIC(14,3),
  northing            NUMERIC(14,3),
  longitude           DOUBLE PRECISION,
  latitude            DOUBLE PRECISION,
  elevation           NUMERIC(8,2),
  notes               TEXT,
  recorded_by         UUID REFERENCES public.users(id) ON DELETE SET NULL,
  recorded_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_survey_coordinate_task ON spatial_planning.survey_coordinate(survey_task_id);

CREATE TABLE IF NOT EXISTS spatial_planning.survey_beacon (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_task_id      UUID NOT NULL REFERENCES spatial_planning.survey_task(id) ON DELETE CASCADE,
  corner_label        VARCHAR(40),
  beacon_type         VARCHAR(20) NOT NULL DEFAULT 'iron_peg'
                        CHECK (beacon_type IN ('iron_peg', 'concrete_beacon', 'survey_nail', 'witness_beacon')),
  easting             NUMERIC(14,3),
  northing            NUMERIC(14,3),
  status              VARCHAR(15) NOT NULL DEFAULT 'intact'
                        CHECK (status IN ('intact', 'missing', 'damaged', 'replaced')),
  notes               TEXT,
  recorded_by         UUID REFERENCES public.users(id) ON DELETE SET NULL,
  recorded_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_survey_beacon_task ON spatial_planning.survey_beacon(survey_task_id);

CREATE TABLE IF NOT EXISTS spatial_planning.survey_layout (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_task_id      UUID REFERENCES spatial_planning.survey_task(id) ON DELETE SET NULL,
  layout_name         VARCHAR(120) NOT NULL,
  parent_property     VARCHAR(120),
  ward                VARCHAR(80),
  parent_area_ha      NUMERIC(10,3),
  stands_planned      INTEGER,
  status              VARCHAR(15) NOT NULL DEFAULT 'pre_survey'
                        CHECK (status IN ('pre_survey', 'designed', 'verified', 'approved', 'pegging', 'completed')),
  designer            VARCHAR(120),
  notes               TEXT,
  created_by          UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_survey_layout_task ON spatial_planning.survey_layout(survey_task_id);

-- ════════════════════════════════════════════════════════════════════
-- CROSS-ROLE COMMENTS — surveyor ↔ planner ↔ EO ↔ citizen
-- ════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS spatial_planning.survey_comment (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_task_id      UUID NOT NULL REFERENCES spatial_planning.survey_task(id) ON DELETE CASCADE,
  author_id           UUID REFERENCES public.users(id) ON DELETE SET NULL,
  author_role         VARCHAR(30),
  audience            VARCHAR(15) NOT NULL DEFAULT 'all'
                        CHECK (audience IN ('planner', 'eo', 'surveyor', 'citizen', 'all')),
  body                TEXT NOT NULL,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_survey_comment_task ON spatial_planning.survey_comment(survey_task_id);

-- ════════════════════════════════════════════════════════════════════
-- TRIGGERS — reuse spatial_planning.set_updated_at() from migration 070
-- ════════════════════════════════════════════════════════════════════
DO $$
DECLARE tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['survey_task', 'survey_layout'] LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%s_updated_at ON spatial_planning.%I;
       CREATE TRIGGER trg_%s_updated_at
       BEFORE UPDATE ON spatial_planning.%I
       FOR EACH ROW EXECUTE FUNCTION spatial_planning.set_updated_at()',
      tbl, tbl, tbl, tbl
    );
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════
-- VIEW — survey task joined with citizen application context, so the
-- surveyor reads the linked application THROUGH the task (no broad
-- permit-read grant needed). lng/lat exposed from the geometry.
-- ════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW spatial_planning.v_survey_task AS
SELECT
  st.id,
  st.permit_app_id,
  st.task_type,
  st.stand_number,
  st.suburb_ward,
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
  RAISE NOTICE '✅ Migration 080 complete — survey task workflow installed';
  RAISE NOTICE '   Tables : survey_task, survey_finding, survey_coordinate,';
  RAISE NOTICE '            survey_beacon, survey_layout, survey_comment';
  RAISE NOTICE '   View   : v_survey_task';
END $$;
