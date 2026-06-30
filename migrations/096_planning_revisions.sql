-- Migration 096: planning project revisions + optimistic locking
--
-- Adds a monotonically-increasing `revision` to each planning_project (for
-- optimistic concurrency — "no silent overwrite") and an immutable
-- planning_revision history table (one row per saved revision). Implements the
-- "revision-on-save" decision from the architecture (Part IV §14/§16): every
-- validated Save bumps the project revision and appends an immutable snapshot.
--
-- Idempotent: safe to re-run.
-- Apply locally with: node scripts/apply-local-migration.js 096_planning_revisions.sql

BEGIN;

ALTER TABLE spatial_planning.planning_project
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS spatial_planning.planning_revision (
  id          bigserial PRIMARY KEY,
  project_id  text NOT NULL REFERENCES spatial_planning.planning_project(id) ON DELETE CASCADE,
  revision    integer NOT NULL,
  name        text,
  status      text NOT NULL DEFAULT 'draft',
  data        jsonb NOT NULL,                  -- immutable PlanningProject snapshot at this revision
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, revision)
);

CREATE INDEX IF NOT EXISTS planning_revision_project_idx
  ON spatial_planning.planning_revision (project_id, revision DESC);

COMMIT;
