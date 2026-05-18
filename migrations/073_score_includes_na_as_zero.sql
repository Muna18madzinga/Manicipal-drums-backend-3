-- Migration 073: N/A checklist items now count as score 0 in stage average.
--
-- Previously (migration 072) the scoring view excluded N/A items entirely
-- from the average, which let inspectors avoid a low average by marking
-- items as N/A. Per RDC requirement, the rule is now stricter:
--
--   "If an item is N/A, its score is 0 — every inspection produces an
--    average across ALL items."
--
-- This replaces the view in-place. No schema or data migration needed.
--
-- Apply with: psql -d <db> -f migrations/073_score_includes_na_as_zero.sql

BEGIN;

CREATE OR REPLACE VIEW spatial_planning.stage_inspection_scoring AS
WITH all_items AS (
  -- Every checklist row contributes to the average. N/A items get a
  -- score of 0; non-na items use whatever score the inspector recorded
  -- (NULL becomes 0 too, as a defensive fallback).
  SELECT r.stage_inspection_id,
         r.checklist_item_id,
         COALESCE(r.score, 0) AS effective_score,
         r.score              AS raw_score,    -- nullable; used for scored_count
         r.photo_id,
         r.result             AS item_result
  FROM spatial_planning.inspection_checklist_result r
),
agg AS (
  SELECT stage_inspection_id,
         COUNT(*)                                                AS item_count,
         COUNT(raw_score) FILTER (WHERE item_result <> 'na')     AS scored_count,
         COUNT(photo_id)                                         AS photo_count,
         ROUND(AVG(effective_score)::NUMERIC, 2)                 AS avg_score,
         MIN(effective_score)                                    AS min_score,
         MAX(effective_score)                                    AS max_score
  FROM all_items
  GROUP BY stage_inspection_id
)
SELECT a.*,
       CASE
         -- Any single critical-low effective score → fail. With N/A=0
         -- this also catches stages that over-use N/A.
         WHEN a.min_score IS NOT NULL AND a.min_score <  3.0 THEN 'fail'
         WHEN a.avg_score IS NULL                            THEN NULL
         WHEN a.avg_score >= 8.0 AND a.min_score >= 5.0      THEN 'pass'
         WHEN a.avg_score >= 6.0 AND a.min_score >= 4.0      THEN 'conditional_pass'
         WHEN a.avg_score >= 4.0                             THEN 'reinspection_required'
         ELSE                                                     'fail'
       END AS computed_result
FROM agg a;

COMMENT ON VIEW spatial_planning.stage_inspection_scoring IS
  'System-computed pass/fail per stage inspection. N/A items count as score 0 in the average — DM Handbook 2021 strict-scoring rule (migration 073).';

COMMIT;
