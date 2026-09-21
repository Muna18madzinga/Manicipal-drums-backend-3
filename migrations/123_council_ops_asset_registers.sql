-- 123_council_ops_asset_registers.sql
-- Phase 2 operational schemas for Roads, WASH, livestock and council assets.
-- Empty, import-ready tables — NEVER seed fake geometries.
-- GIS themes catalogue marks these schema_ready until data is loaded.

BEGIN;

CREATE SCHEMA IF NOT EXISTS council_ops;

CREATE TABLE IF NOT EXISTS council_ops.road_asset (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_code      VARCHAR(64) UNIQUE,
  name            TEXT,
  hierarchy       VARCHAR(40),
  authority       VARCHAR(120),
  surface         VARCHAR(40),
  condition       VARCHAR(40),
  length_m        NUMERIC(12, 2),
  ward            VARCHAR(120),
  status          VARCHAR(24) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'proposed', 'decommissioned')),
  data_quality    VARCHAR(24) NOT NULL DEFAULT 'unverified'
                    CHECK (data_quality IN ('authoritative', 'verified', 'unverified', 'reference')),
  source          TEXT,
  responsible_dept TEXT DEFAULT 'Roads & Works',
  geom            geometry(MultiLineString, 4326),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS road_asset_geom_gix ON council_ops.road_asset USING GIST (geom);

CREATE TABLE IF NOT EXISTS council_ops.road_structure (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  structure_type  VARCHAR(40) NOT NULL
                    CHECK (structure_type IN ('bridge', 'culvert', 'causeway', 'footbridge', 'other')),
  name            TEXT,
  road_asset_id   UUID REFERENCES council_ops.road_asset(id) ON DELETE SET NULL,
  condition       VARCHAR(40),
  ward            VARCHAR(120),
  data_quality    VARCHAR(24) NOT NULL DEFAULT 'unverified',
  source          TEXT,
  geom            geometry(Point, 4326),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS road_structure_geom_gix ON council_ops.road_structure USING GIST (geom);

CREATE TABLE IF NOT EXISTS council_ops.wash_asset (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_code      VARCHAR(64) UNIQUE,
  asset_type      VARCHAR(40) NOT NULL
                    CHECK (asset_type IN (
                      'borehole', 'well', 'water_point', 'tank', 'reservoir',
                      'pipeline', 'scheme', 'treatment', 'pump', 'toilet',
                      'septic', 'waste_site', 'other')),
  name            TEXT,
  ward            VARCHAR(120),
  capacity        TEXT,
  operational     VARCHAR(24) DEFAULT 'unknown'
                    CHECK (operational IN ('working', 'broken', 'seasonal', 'unknown', 'decommissioned')),
  responsible_party TEXT,
  data_quality    VARCHAR(24) NOT NULL DEFAULT 'unverified',
  source          TEXT,
  responsible_dept TEXT DEFAULT 'DSSWC',
  geom            geometry(Point, 4326),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS wash_asset_geom_gix ON council_ops.wash_asset USING GIST (geom);

CREATE TABLE IF NOT EXISTS council_ops.livestock_facility (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_type   VARCHAR(40) NOT NULL
                    CHECK (facility_type IN ('dip_tank', 'stock_pen', 'watering_point', 'other')),
  name            TEXT,
  ward            VARCHAR(120),
  data_quality    VARCHAR(24) NOT NULL DEFAULT 'unverified',
  source          TEXT,
  geom            geometry(Point, 4326),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS livestock_facility_geom_gix ON council_ops.livestock_facility USING GIST (geom);

CREATE TABLE IF NOT EXISTS council_ops.council_asset (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_code      VARCHAR(64) UNIQUE,
  name            TEXT NOT NULL,
  asset_class     VARCHAR(40) NOT NULL
                    CHECK (asset_class IN (
                      'office', 'building', 'land', 'market', 'recreation',
                      'cemetery', 'school', 'clinic', 'other')),
  department      VARCHAR(120),
  condition       VARCHAR(40),
  ward            VARCHAR(120),
  data_quality    VARCHAR(24) NOT NULL DEFAULT 'unverified',
  source          TEXT,
  geom            geometry(Geometry, 4326),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS council_asset_geom_gix ON council_ops.council_asset USING GIST (geom);

COMMENT ON SCHEMA council_ops IS
  'Vungu RDC operational asset registers (Roads, WASH, livestock, council). Empty until authoritative imports.';

COMMIT;
