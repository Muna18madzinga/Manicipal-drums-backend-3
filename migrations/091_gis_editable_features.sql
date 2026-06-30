-- Migration 091: editable GIS features (in-browser digitizing)
--
-- Until now every spatial layer was READ-ONLY: officers edited geometry offline
-- in QGIS and re-imported. This adds a single editable table so a GIS officer
-- or planner can DIGITIZE geometry in the web map (MapToolbar) and PERSIST it to
-- PostGIS, with free-form JSON properties and author attribution.
--
-- It is deliberately kept in its OWN table so digitizing never mutates the
-- imported cadastre / master-plan layers (vungu_parcels, vungu_farm_cadastre …).
--
-- Idempotent: safe to re-run (CREATE … IF NOT EXISTS).
-- Apply with: node scripts/migrate-render.js  (091 is in the MIGRATIONS array)

BEGIN;

CREATE SCHEMA IF NOT EXISTS spatial_planning;

CREATE TABLE IF NOT EXISTS spatial_planning.gis_feature (
  id          bigserial PRIMARY KEY,
  layer       text        NOT NULL DEFAULT 'digitized',
  props       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  geom        geometry(Geometry, 4326) NOT NULL,
  created_by  text,                                   -- users.id as text (no FK: avoids id-type coupling)
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- GiST index so /gis/within and tile queries over digitized features stay fast.
CREATE INDEX IF NOT EXISTS gis_feature_geom_gix  ON spatial_planning.gis_feature USING GIST (geom);
CREATE INDEX IF NOT EXISTS gis_feature_layer_idx ON spatial_planning.gis_feature (layer);

COMMIT;
