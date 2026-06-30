-- 082_planner_case_and_audit.sql
-- ────────────────────────────────────────────────────────────────────────
-- Make the permit_application the real system-of-record for the planner's
-- working case file. Before this migration the planner's assessment,
-- conditions of approval, committee report, zoning snapshot and proposal
-- detail lived ONLY in browser localStorage (see usePlannerCase.ts) — not
-- shared, not auditable, lost on device change. This migration:
--
--   1. Adds the case-file columns to spatial_planning.permit_application.
--   2. Adds a per-referral `assigned_to` to application_consultation so a
--      specialist can be tasked (and respond) on a circulation.
--   3. Adds an append-only audit log (permit_event) — who did what, when, why.
--
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS / CREATE … IF NOT EXISTS).
-- ────────────────────────────────────────────────────────────────────────

-- 1. Planner case-file fields on the permit ------------------------------
ALTER TABLE spatial_planning.permit_application
  ADD COLUMN IF NOT EXISTS estimated_cost          NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS plinth_area             NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS floors                  INTEGER,
  ADD COLUMN IF NOT EXISTS parking_bays            INTEGER,
  ADD COLUMN IF NOT EXISTS title_deed_no           VARCHAR(60),
  ADD COLUMN IF NOT EXISTS classification          VARCHAR(40),
  ADD COLUMN IF NOT EXISTS recommendation          VARCHAR(40),
  ADD COLUMN IF NOT EXISTS recommendation_reasons  TEXT,
  ADD COLUMN IF NOT EXISTS due_diligence           JSONB,
  ADD COLUMN IF NOT EXISTS committee_report        JSONB,
  ADD COLUMN IF NOT EXISTS zoning_assessment       JSONB,
  ADD COLUMN IF NOT EXISTS permit_conditions       JSONB,
  ADD COLUMN IF NOT EXISTS assigned_to             UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS statutory_due_date      DATE;

CREATE INDEX IF NOT EXISTS idx_permit_app_assigned_to
  ON spatial_planning.permit_application(assigned_to)
  WHERE assigned_to IS NOT NULL;

COMMENT ON COLUMN spatial_planning.permit_application.permit_conditions IS
  'Structured conditions of approval (array of {id,text,test flags}). The authoritative, enforceable list — inspectors and citizens read this.';

-- 2. Per-referral assignment --------------------------------------------
ALTER TABLE spatial_planning.application_consultation
  ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_consultation_assigned_to
  ON spatial_planning.application_consultation(assigned_to)
  WHERE assigned_to IS NOT NULL;

-- 3. Append-only audit log ----------------------------------------------
--    Every mutating planner/officer action appends one row. Never updated
--    or deleted in normal operation — the statutory "who/what/when/why".
CREATE TABLE IF NOT EXISTS spatial_planning.permit_event (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_app_id  UUID NOT NULL REFERENCES spatial_planning.permit_application(id) ON DELETE CASCADE,
  event_type     VARCHAR(60) NOT NULL,
  actor_id       UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_role     VARCHAR(40),
  detail         JSONB,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_permit_event_app
  ON spatial_planning.permit_event(permit_app_id, created_at DESC);

COMMENT ON TABLE spatial_planning.permit_event IS
  'Append-only audit trail for a permit application (status changes, case updates, referrals, decisions). Display source for "who did what, when".';
