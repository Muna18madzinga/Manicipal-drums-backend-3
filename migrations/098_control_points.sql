-- Migration 098: National survey control point registry (surveypro-nov-alpha
-- integration, Phase 1). A monument (beacon/pillar) surveyed by the
-- Surveyor-General, referenced when tying cadastral work to known ground
-- control. Global, not scoped to any survey_task — surveyors look these up
-- by number/name, they don't create council work items against them here.
--
-- ponytail: no geom column, no bbox search, no map layer. Nothing today
-- transforms Lo-zone easting/northing to WGS84 for multiple zones (the
-- frontend's coordinateTransform.ts only handles Lo31), and there's no
-- import pipeline yet to populate rows — building spatial search for a
-- table with zero real data is premature. Add geom + GIST index + a map
-- layer once CSV import (Phase 3) actually loads monument data and someone
-- needs to see it on a map, not before.
--
-- Depends on: migration 070 (spatial_planning schema).

BEGIN;

CREATE TABLE IF NOT EXISTS spatial_planning.control_point (
  id          SERIAL PRIMARY KEY,
  monu_num    VARCHAR(20) NOT NULL UNIQUE,
  monu_name   VARCHAR(100) NOT NULL,
  type        VARCHAR(10) NOT NULL DEFAULT 'SEC'
                CHECK (type IN ('PRIM', 'SEC', 'TERT', 'QUART')),
  gauss_lo    SMALLINT CHECK (gauss_lo IN (25, 27, 29, 31, 33)),
  y_gauss     NUMERIC(15,3),
  x_gauss     NUMERIC(15,3),
  msl_hgt     NUMERIC(10,3),
  created_by  UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_control_point_name ON spatial_planning.control_point(monu_name);

COMMIT;

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 098 complete — control_point registry installed';
END $$;
