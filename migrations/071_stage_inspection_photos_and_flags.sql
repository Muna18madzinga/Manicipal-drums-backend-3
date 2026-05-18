-- Migration 071: Stage inspection photo evidence + anti-corruption flags.
--
-- Adds:
--   spatial_planning.stage_inspection_photo  — per-photo record with file
--                                              metadata, hash, GPS, captor.
--   spatial_planning.stage_inspection_flag   — anti-corruption / quality
--                                              concern raised against a
--                                              previous inspection by a
--                                              later inspector or planner.
--
-- Depends on: 070 (stage_inspection table).
-- Apply with: psql -d <db> -f migrations/071_stage_inspection_photos_and_flags.sql

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. PHOTO EVIDENCE
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS spatial_planning.stage_inspection_photo (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_inspection_id UUID NOT NULL
    REFERENCES spatial_planning.stage_inspection(id) ON DELETE CASCADE,

  -- File metadata.
  storage_url         TEXT NOT NULL,             -- /uploads/stage-photos/<sid>/<id>.<ext>
  mime_type           VARCHAR(40) NOT NULL,
  bytes               INT NOT NULL,
  sha256_hex          CHAR(64) NOT NULL,
  caption             VARCHAR(255),

  -- Capture metadata.
  taken_at            TIMESTAMP WITH TIME ZONE,
  taken_lng           DOUBLE PRECISION,
  taken_lat           DOUBLE PRECISION,

  -- Provenance.
  uploaded_by         UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  -- Prevent duplicate uploads of the same image to the same inspection.
  UNIQUE (stage_inspection_id, sha256_hex)
);

CREATE INDEX IF NOT EXISTS idx_stage_inspection_photo_inspection
  ON spatial_planning.stage_inspection_photo(stage_inspection_id);
CREATE INDEX IF NOT EXISTS idx_stage_inspection_photo_uploader
  ON spatial_planning.stage_inspection_photo(uploaded_by);

COMMENT ON TABLE spatial_planning.stage_inspection_photo IS
  'Photographic evidence captured during a stage inspection. Anti-corruption: every photo is hashed and tied to the uploader so it cannot be silently substituted.';

-- ════════════════════════════════════════════════════════════════════
-- 2. ANTI-CORRUPTION FLAGS
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS spatial_planning.stage_inspection_flag (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_inspection_id UUID NOT NULL
    REFERENCES spatial_planning.stage_inspection(id) ON DELETE CASCADE,

  reason_code         VARCHAR(40) NOT NULL
                        CHECK (reason_code IN (
                          'work_not_done',
                          'work_not_to_standard',
                          'photos_dont_match_site',
                          'safety_issue_missed',
                          'measurements_incorrect',
                          'fraudulent_pass',
                          'absent_during_inspection',
                          'other'
                        )),
  description         TEXT NOT NULL,
  evidence_photo_ids  UUID[] NOT NULL DEFAULT '{}'::UUID[],

  -- Submitter (the inspector or planner raising the concern).
  flagged_by          UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  flagged_by_role     VARCHAR(40) NOT NULL,

  -- Resolution lifecycle.
  status              VARCHAR(20) NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'under_review', 'upheld', 'dismissed', 'withdrawn')),
  resolution_notes    TEXT,
  resolved_by         UUID REFERENCES public.users(id) ON DELETE SET NULL,
  resolved_at         TIMESTAMP WITH TIME ZONE,

  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stage_inspection_flag_inspection
  ON spatial_planning.stage_inspection_flag(stage_inspection_id);
CREATE INDEX IF NOT EXISTS idx_stage_inspection_flag_status
  ON spatial_planning.stage_inspection_flag(status);
CREATE INDEX IF NOT EXISTS idx_stage_inspection_flag_flagger
  ON spatial_planning.stage_inspection_flag(flagged_by);

COMMENT ON TABLE spatial_planning.stage_inspection_flag IS
  'Anti-corruption / quality concern raised against a stage inspection. Allows a later inspector to formally report that a previous inspection was not carried out properly.';

-- Convenience view: latest flag count per stage_inspection.
CREATE OR REPLACE VIEW spatial_planning.stage_inspection_flag_summary AS
SELECT stage_inspection_id,
       COUNT(*)                                    AS total_flags,
       COUNT(*) FILTER (WHERE status = 'open')     AS open_flags,
       COUNT(*) FILTER (WHERE status = 'upheld')   AS upheld_flags,
       MAX(created_at)                             AS latest_flag_at
FROM spatial_planning.stage_inspection_flag
GROUP BY stage_inspection_id;

COMMIT;
