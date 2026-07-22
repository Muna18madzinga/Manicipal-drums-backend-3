-- Migration 111: spatial_layers catalogue
--
-- src/routes/qgis.js (PyQGIS plugin push) and src/routes/dynamic-layers.js
-- both read/write this table to register layers pushed from QGIS Desktop
-- and to list them back to the portal, but no migration ever created it --
-- like local_authorities (110), it existed only as a hand-made table on the
-- original dev machine. Every fresh install 500'd on POST /api/qgis/sync/upload
-- with "relation \"spatial_layers\" does not exist".
--
-- Idempotent: safe to re-run. Auto-registers every existing PostGIS geometry
-- table so the catalogue isn't empty on a database that already has data
-- (mirrors scripts/setup-spatial-layers.js, which remains useful to re-run
-- standalone after bulk imports).
-- Apply locally with: node scripts/apply-local-migration.js 111_spatial_layers_catalogue.sql

BEGIN;

CREATE TABLE IF NOT EXISTS spatial_layers (
  id             SERIAL PRIMARY KEY,
  table_name     VARCHAR(255) UNIQUE NOT NULL,
  display_name   VARCHAR(255) NOT NULL,
  geometry_type  VARCHAR(50) DEFAULT 'point',
  description    TEXT,
  style_config   JSONB DEFAULT '{}',
  is_visible     BOOLEAN DEFAULT true,
  created_at     TIMESTAMP DEFAULT NOW(),
  updated_at     TIMESTAMP DEFAULT NOW()
);

DO $$
DECLARE
  r RECORD;
  geom_type TEXT;
  display TEXT;
BEGIN
  FOR r IN SELECT f_table_name, type FROM geometry_columns WHERE f_table_schema = 'public' LOOP
    geom_type := CASE
      WHEN lower(r.type) LIKE '%point%' THEN 'point'
      WHEN lower(r.type) LIKE '%line%' THEN 'line'
      WHEN lower(r.type) LIKE '%polygon%' THEN 'polygon'
      ELSE 'point'
    END;
    display := initcap(replace(r.f_table_name, '_', ' '));
    INSERT INTO spatial_layers (table_name, display_name, geometry_type, description, is_visible)
    VALUES (r.f_table_name, display, geom_type, 'Auto-registered ' || geom_type || ' layer', true)
    ON CONFLICT (table_name) DO NOTHING;
  END LOOP;
END $$;

COMMIT;
