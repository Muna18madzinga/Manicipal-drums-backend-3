-- Migration 086: EO Planner decision workspace — first-class returns
--
-- Migration 085 created the eo_handoff_package (the "Submit to EO Planner"
-- bundle) with an eo_decision / eo_notes / status lifecycle. What it did not
-- model was the EO Planner *returning* a case to a specific role for more work
-- (return-to-Planner, return-to-GIS-Officer, return-to-Surveyor, etc.). That
-- action is core to the EO decision workspace: the EO can Approve / Approve
-- with conditions / Refuse, OR send the case back with a reason.
--
-- This migration makes returns first-class so they are queryable (not buried in
-- the permit_event audit detail):
--   1. eo_handoff_package.returned_to_role — which role the case went back to
--   2. eo_handoff_package.return_reason     — why (the EO's note to that role)
--   3. v_eo_decision_queue                  — the EO inbox: every permit that is
--      awaiting an EO determination, with its latest handoff state.
--
-- The decision actions themselves (eo_decision, returned_to_role,
-- citizen_info_requested) are recorded in spatial_planning.permit_event, whose
-- event_type is a free VARCHAR(60) — no enum migration required.
--
-- Depends on: 085 (eo_handoff_package, case_message, permit_event), 082
--             (permit_application case columns), 070 (permit_application).
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE VIEW).
-- Apply with: node scripts/migrate-render.js  (086 is in the MIGRATIONS array)

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. First-class returns on the EO handoff package
-- ════════════════════════════════════════════════════════════════════
ALTER TABLE spatial_planning.eo_handoff_package
  ADD COLUMN IF NOT EXISTS returned_to_role VARCHAR(40),
  ADD COLUMN IF NOT EXISTS return_reason    TEXT;

COMMENT ON COLUMN spatial_planning.eo_handoff_package.returned_to_role IS
  'When status = ''returned'': the role the EO Planner sent the case back to (planner | gis_officer | surveyor | env_officer | building_inspector).';
COMMENT ON COLUMN spatial_planning.eo_handoff_package.return_reason IS
  'When status = ''returned'': the EO Planner''s reason / instruction to that role.';

-- ════════════════════════════════════════════════════════════════════
-- 2. v_eo_decision_queue — the EO Planner inbox
-- ════════════════════════════════════════════════════════════════════
-- Every permit currently awaiting an EO determination, with the latest handoff
-- package state and a deemed-refusal countdown (RTCP Act s.26, 90-day clock).
-- The route GET /eo-planner/cases reads this.
CREATE OR REPLACE VIEW spatial_planning.v_eo_decision_queue AS
  SELECT
    pa.id,
    pa.dev_register_no,
    pa.tpd_reference,
    pa.stand_number,
    pa.suburb_ward,
    pa.applicant_name,
    pa.development_type,
    pa.description,
    pa.status,
    (pa.fee_paid_at IS NOT NULL) AS fee_paid,
    pa.received_at,
    pa.statutory_due_date,
    pa.recommendation,
    pa.created_at,
    pa.updated_at,
    ST_X(pa.location) AS lng,
    ST_Y(pa.location) AS lat,
    -- Latest handoff package state (NULL until a planner submits to EO).
    hp.id             AS handoff_id,
    hp.status         AS handoff_status,
    hp.recommendation AS handoff_recommendation,
    hp.submitted_by   AS handoff_submitted_by,
    hp.created_at     AS handoff_submitted_at,
    hp.returned_to_role,
    -- Deemed-refusal countdown in days (negative = breached). NULL if no clock.
    CASE WHEN pa.received_at IS NOT NULL
         THEN 90 - FLOOR(EXTRACT(EPOCH FROM (NOW() - pa.received_at)) / 86400)::int
         ELSE NULL END AS days_to_deemed
  FROM spatial_planning.permit_application pa
  LEFT JOIN LATERAL (
    SELECT * FROM spatial_planning.eo_handoff_package h
     WHERE h.permit_app_id = pa.id
     ORDER BY h.created_at DESC
     LIMIT 1
  ) hp ON TRUE
  WHERE pa.status IN (
    'awaiting_eo_decision', 'under_review', 'circulation',
    'objection_period', 'deferred'
  );

COMMENT ON VIEW spatial_planning.v_eo_decision_queue IS
  'EO Planner inbox: permits awaiting determination with latest handoff state + deemed-refusal countdown. Read by GET /eo-planner/cases.';

COMMIT;

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 086 complete — EO decision returns installed';
  RAISE NOTICE '   Altered: eo_handoff_package (+returned_to_role, +return_reason)';
  RAISE NOTICE '   View   : v_eo_decision_queue';
END $$;
