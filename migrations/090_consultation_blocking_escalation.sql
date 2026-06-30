-- Migration 090: technical-circulation upgrades — blocking findings + escalation
--
-- Migration 085 promoted application_consultation to a real "case task" with a
-- priority, a task_status lifecycle and a task_type. The EO Planner's Technical
-- Circulation screen also needs to record two more things per referral:
--
--   1. blocking      — is this department's finding a BLOCKING condition for the
--                      determination (must be resolved) or non-blocking (advisory)?
--   2. escalated_at   — when the referral was escalated / reminded (overdue chase).
--
-- (assigned_to + response_due_at already exist from 082/070; priority/task_status
--  from 085.)
--
-- Depends on: 070 (application_consultation), 085 (priority/task_status/task_type).
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS).
-- Apply with: node scripts/migrate-render.js  (090 is in the MIGRATIONS array)

BEGIN;

ALTER TABLE spatial_planning.application_consultation
  ADD COLUMN IF NOT EXISTS blocking     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN spatial_planning.application_consultation.blocking IS
  'TRUE = this referral''s finding is a blocking condition for the determination; FALSE = advisory / non-blocking.';
COMMENT ON COLUMN spatial_planning.application_consultation.escalated_at IS
  'Set when the referral is escalated / reminded (overdue chase). NULL until first escalation.';

COMMIT;

DO $$
BEGIN
  RAISE NOTICE '✅ Migration 090 complete — consultation blocking + escalation';
END $$;
