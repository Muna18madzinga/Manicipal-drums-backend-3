-- Migration 072: Per-item inspection scoring + photo evidence linkage.
--
-- The DM Handbook 2021 inspection process now requires the inspector to
-- attach a photo, a comment, and a numeric score (0.0–10.0) for every
-- applicable checklist item. The system — not the inspector — decides
-- whether the stage has passed, based on the average score and a
-- minimum-score safety rule.
--
-- Scoring policy (computed by SQL view + backend handler):
--   avg >= 8.0 AND min >= 5.0           → pass
--   avg >= 6.0 AND min >= 4.0           → conditional_pass
--   avg >= 4.0                          → reinspection_required
--   any individual score < 3.0          → fail (safety / critical item)
--   avg <  4.0                          → fail
--
-- Depends on: 070 (inspection_checklist_result), 071 (stage_inspection_photo).
-- Apply with: psql -d <db> -f migrations/072_per_item_inspection_scoring.sql

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. EXTEND inspection_checklist_result
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE spatial_planning.inspection_checklist_result
  ADD COLUMN IF NOT EXISTS score    NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS photo_id UUID
    REFERENCES spatial_planning.stage_inspection_photo(id) ON DELETE SET NULL;

-- Score must be either NULL (not yet scored / not applicable) or in [0,10].
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'inspection_checklist_result_score_range'
  ) THEN
    ALTER TABLE spatial_planning.inspection_checklist_result
      ADD CONSTRAINT inspection_checklist_result_score_range
        CHECK (score IS NULL OR (score >= 0 AND score <= 10));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_checklist_result_photo
  ON spatial_planning.inspection_checklist_result(photo_id)
  WHERE photo_id IS NOT NULL;

COMMENT ON COLUMN spatial_planning.inspection_checklist_result.score IS
  'Inspector-assigned score 0.0–10.0 for this checklist item. NULL if not applicable.';
COMMENT ON COLUMN spatial_planning.inspection_checklist_result.photo_id IS
  'Optional photo evidence specifically captured for this checklist item.';

-- ════════════════════════════════════════════════════════════════════
-- 2. SCORING VIEW — system-computed pass/fail per stage
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW spatial_planning.stage_inspection_scoring AS
WITH scored AS (
  SELECT r.stage_inspection_id,
         r.checklist_item_id,
         r.score,
         r.photo_id,
         r.result AS item_result
  FROM spatial_planning.inspection_checklist_result r
  WHERE r.result <> 'na'
),
agg AS (
  SELECT stage_inspection_id,
         COUNT(*)                                  AS item_count,
         COUNT(score)                              AS scored_count,
         COUNT(photo_id)                           AS photo_count,
         ROUND(AVG(score)::NUMERIC, 2)             AS avg_score,
         MIN(score)                                AS min_score,
         MAX(score)                                AS max_score
  FROM scored
  GROUP BY stage_inspection_id
)
SELECT a.*,
       CASE
         -- Any single critical-low score → fail.
         WHEN a.min_score IS NOT NULL AND a.min_score <  3.0 THEN 'fail'
         WHEN a.avg_score IS NULL                            THEN NULL
         WHEN a.avg_score >= 8.0 AND a.min_score >= 5.0      THEN 'pass'
         WHEN a.avg_score >= 6.0 AND a.min_score >= 4.0      THEN 'conditional_pass'
         WHEN a.avg_score >= 4.0                             THEN 'reinspection_required'
         ELSE                                                     'fail'
       END AS computed_result
FROM agg a;

COMMENT ON VIEW spatial_planning.stage_inspection_scoring IS
  'System-computed pass/fail/conditional/reinspect for each stage inspection, based on the average of per-item scores. Inspector cannot override this — see backend handler.';

COMMIT;
