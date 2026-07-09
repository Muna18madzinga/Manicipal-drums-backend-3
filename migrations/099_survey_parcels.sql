-- Migration 099: Cadastral parcels tied to a survey task (surveypro-nov-alpha
-- integration, Phase 2). A parcel is the polygon boundary surveyed for a
-- survey_task (pegging/layout/verification), with area/closure computed
-- server-side from the submitted points — never trust a client-supplied
-- area figure.
--
-- ponytail: no PostGIS geom column, no separate survey_project layer.
-- Points are stored as raw P(Y,X) pairs (JSONB) — the same shape the
-- existing /surveyor/compute/area endpoint (migration 098's sibling,
-- src/routes/surveyorCompute.js) already accepts and returns. Nothing
-- renders these on a map yet (see 098's header for the same reasoning),
-- so there's no reason to carry a geometry/SRID and the CRS-transform
-- machinery that comes with it. Convert to real geometry in the phase
-- that builds the GeoPDF/plan output and actually needs it.
--
-- One survey_task can have many survey_parcel rows directly (matches the
-- existing survey_coordinate/survey_beacon/survey_layout convention from
-- migration 080 — no intermediate "project" table; a task IS the unit of
-- work, adding a join layer for a hypothetical multi-project task is
-- solving a problem nobody has hit yet).
--
-- Depends on: migration 080 (spatial_planning.survey_task).

BEGIN;

CREATE TABLE IF NOT EXISTS spatial_planning.survey_parcel (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_task_id   UUID NOT NULL REFERENCES spatial_planning.survey_task(id) ON DELETE CASCADE,
  points           JSONB NOT NULL,             -- [{y,x}, ...] south-oriented P(Y,X), >=3 points
  area_m2          NUMERIC(14,3) NOT NULL,      -- server-computed, see src/routes/surveyor.js
  perimeter_m      NUMERIC(12,3) NOT NULL,
  closure_error_m  NUMERIC(10,3) NOT NULL,
  closure_ratio    VARCHAR(30),
  status           VARCHAR(15) NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'finalized', 'approved')),
  created_by       UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_survey_parcel_task ON spatial_planning.survey_parcel(survey_task_id);

COMMIT;

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 099 complete — survey_parcel installed';
END $$;
