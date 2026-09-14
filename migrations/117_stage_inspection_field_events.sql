-- 117_stage_inspection_field_events.sql
-- Append-only field activity log for a stage inspection:
--   travelling -> arrived -> inspection_started -> inspection_completed
--
-- Reconstructed 2026-09-13 from the live Vungu_spatial333 schema (the table
-- existed locally without a migration). Movement states live here, never in
-- stage_inspection.result, whose vocabulary is the statutory outcome only.

BEGIN;

CREATE TABLE IF NOT EXISTS spatial_planning.stage_inspection_field_event (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_inspection_id UUID NOT NULL
    REFERENCES spatial_planning.stage_inspection(id) ON DELETE CASCADE,
  event_type          VARCHAR(30) NOT NULL
    CHECK (event_type IN ('travelling', 'arrived', 'inspection_started', 'inspection_completed')),
  recorded_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  recorded_by         UUID REFERENCES public.users(id) ON DELETE SET NULL,
  -- A GPS fix is optional (often unavailable on site) but never half-present.
  observed_lat        NUMERIC(10, 7),
  observed_lng        NUMERIC(10, 7),
  accuracy_m          NUMERIC(8, 2),
  note                TEXT,
  CONSTRAINT stage_inspection_field_event_coords_paired
    CHECK ((observed_lat IS NULL) = (observed_lng IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_si_field_event_inspection
  ON spatial_planning.stage_inspection_field_event(stage_inspection_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_si_field_event_type
  ON spatial_planning.stage_inspection_field_event(stage_inspection_id, event_type);

COMMENT ON TABLE spatial_planning.stage_inspection_field_event IS
  'Append-only inspector movement log. The arrived event carries the attendance GPS fix.';

COMMIT;
