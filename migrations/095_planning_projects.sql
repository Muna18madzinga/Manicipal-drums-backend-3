-- Migration 095: planning projects (in-browser land-subdivision tool)
--
-- Stores the designs produced by the planner's Phase-1 subdivision tool
-- (planning area + roads + constraints + blocks + lots + open space). The full
-- editable design is kept as a JSONB snapshot so the browser can round-trip it
-- without a rigid relational schema, while a few promoted columns (name,
-- source_parcel_id, area_sqm, lot_count) + a geometry column make listing and
-- spatial queries cheap.
--
-- Deliberately in its OWN table/schema so it never touches the permit/case
-- tables or the imported cadastre.
--
-- Idempotent: safe to re-run (CREATE … IF NOT EXISTS).
-- Apply locally with: node scripts/apply-local-migration.js 095_planning_projects.sql

BEGIN;

CREATE SCHEMA IF NOT EXISTS spatial_planning;

CREATE TABLE IF NOT EXISTS spatial_planning.planning_project (
  id               text PRIMARY KEY,                       -- client-generated project id
  name             text NOT NULL DEFAULT 'Untitled subdivision',
  source_parcel_id text,                                   -- cadastral parcel the area came from
  area_sqm         double precision,
  lot_count        integer NOT NULL DEFAULT 0,
  road_length_m    double precision,
  data             jsonb NOT NULL,                         -- full PlanningProject snapshot
  geom             geometry(MultiPolygon, 4326),           -- planning-area boundary (for spatial queries)
  created_by       text,                                   -- users.id as text (no FK: avoids id-type coupling)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS planning_project_geom_gix    ON spatial_planning.planning_project USING GIST (geom);
CREATE INDEX IF NOT EXISTS planning_project_parcel_idx  ON spatial_planning.planning_project (source_parcel_id);
CREATE INDEX IF NOT EXISTS planning_project_updated_idx ON spatial_planning.planning_project (updated_at DESC);

COMMIT;
