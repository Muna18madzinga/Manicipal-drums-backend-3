-- Migration 108: link a planning project to its statutory permit case
--
-- "Export to Map" in the Planning Studio is now a statutory hand-off: the
-- submitted design links to the permit application it supports, so the case
-- file shows the GIS proposal and the audit trail records the submission
-- (permit_event, migration 082). Nullable: studio projects can still exist
-- without a case.
--
-- Idempotent: safe to re-run.
-- Apply locally with: node scripts/apply-local-migration.js 108_planning_project_case_link.sql

BEGIN;

ALTER TABLE spatial_planning.planning_project
  ADD COLUMN IF NOT EXISTS permit_app_id uuid
    REFERENCES spatial_planning.permit_application(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS planning_project_permit_idx
  ON spatial_planning.planning_project (permit_app_id)
  WHERE permit_app_id IS NOT NULL;

COMMIT;
