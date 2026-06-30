-- Migration 092: edit history for digitized / imported GIS features
--
-- Records every change to spatial_planning.gis_feature (migration 091) so the
-- council has an audit trail of who changed what geometry and when — the GIS
-- equivalent of the case audit trail. Written by the application layer (the
-- /api/gis routes) so the ACTING user is captured, not just the row owner.
--
-- Idempotent: safe to re-run (CREATE … IF NOT EXISTS).
-- Apply with: node scripts/migrate-render.js  (092 is in the MIGRATIONS array)

BEGIN;

CREATE SCHEMA IF NOT EXISTS spatial_planning;

CREATE TABLE IF NOT EXISTS spatial_planning.gis_feature_history (
  id          bigserial PRIMARY KEY,
  feature_id  bigint,                                  -- gis_feature.id (null for bulk imports)
  layer       text,
  action      text        NOT NULL,                    -- create | update | delete | import
  props       jsonb,
  geom        geometry(Geometry, 4326),
  detail      jsonb,                                   -- extra context, e.g. {"count": 240} for imports
  actor       text,                                    -- users.id of the editor
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gis_feature_history_feature_idx ON spatial_planning.gis_feature_history (feature_id);
CREATE INDEX IF NOT EXISTS gis_feature_history_at_idx      ON spatial_planning.gis_feature_history (at DESC);

COMMIT;
