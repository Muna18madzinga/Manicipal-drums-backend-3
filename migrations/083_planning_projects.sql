-- 083_planning_projects.sql
-- Persistence for the planner's land-subdivision design sessions
-- (usePlanningTools / PlanningPanel). The browser holds the interactive
-- design and POSTs a full snapshot here; this table stores it as JSONB plus
-- a few extracted columns for listing and ownership.

CREATE TABLE IF NOT EXISTS planning_projects (
  id          TEXT PRIMARY KEY,                       -- client-generated proj-<ts>-<n>
  name        TEXT NOT NULL DEFAULT 'Untitled subdivision',
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  snapshot    JSONB NOT NULL,                         -- full PlanningProject blob
  area_sqm    NUMERIC(14,2),                          -- planning-area size (for the list)
  lot_count   INTEGER NOT NULL DEFAULT 0,             -- subdivided lot count (for the list)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_planning_projects_created_by ON planning_projects(created_by);
CREATE INDEX IF NOT EXISTS idx_planning_projects_updated   ON planning_projects(updated_at DESC);
