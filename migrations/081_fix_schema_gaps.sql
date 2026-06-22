-- Migration 081: Fix schema gaps introduced by GPKG import
--
-- The vungu_proposed_peri_urban_zones table was imported from a GeoPackage.
-- The import used 'fid' as primary key, but application code (zones.js,
-- migrations 078-079) expects an 'id' column.
--
-- This migration:
-- 1. Adds 'id' as an alias column for 'fid' on the zones table
-- 2. Creates land_use_groups (prerequisite for zone_land_use_controls)
-- 3. Creates zone_land_use_controls with correct table reference
-- 4. Re-runs the 3NF normalisation bits that failed in migration 078
-- 5. Adds management columns to zones (migration 079 content)
-- 6. Creates stands_tile_view (migration 080)

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- 1. Add 'id' UUID column to vungu_proposed_peri_urban_zones
--    stands.zone_id is UUID; this column must match.
--    fid (integer) is kept for the tile layer feature-state system.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE vungu_proposed_peri_urban_zones
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();

-- Back-fill NULLs (new rows from here already get a UUID via default)
UPDATE vungu_proposed_peri_urban_zones
  SET id = gen_random_uuid()
  WHERE id IS NULL;

ALTER TABLE vungu_proposed_peri_urban_zones
  ALTER COLUMN id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_vpuz_id ON vungu_proposed_peri_urban_zones(id);

-- ════════════════════════════════════════════════════════════════════════
-- 2. land_use_groups (needed by zone_land_use_controls)
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS land_use_groups (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_code          VARCHAR(32) NOT NULL UNIQUE,
  description         TEXT,
  group_category      VARCHAR(32),
  development_category VARCHAR(32),
  use_scale           VARCHAR(32),
  notes               TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

INSERT INTO land_use_groups (group_code, description, group_category, development_category, use_scale, is_active, created_at)
VALUES
  ('R1',  'Low Density Residential',          'residential',  'permitted',       'small_scale', true, NOW()),
  ('R2',  'Medium Density Residential',        'residential',  'permitted',       'mixed_scale', true, NOW()),
  ('C1',  'Local Commercial',                  'commercial',   'permitted',       'small_scale', true, NOW()),
  ('C2',  'General Commercial',                'commercial',   'permitted',       'mixed_scale', true, NOW()),
  ('I1',  'Light Industrial',                  'industrial',   'special_consent', 'small_scale', true, NOW()),
  ('I2',  'Heavy Industrial',                  'industrial',   'special_consent', 'large_scale', true, NOW()),
  ('AG',  'Agricultural',                      'agricultural', 'permitted',       'large_scale', true, NOW()),
  ('OS',  'Open Space / Recreation',           'open_space',   'permitted',       'all_scales',  true, NOW()),
  ('P',   'Prohibited Uses',                   'prohibited',   'prohibited',      'all_scales',  true, NOW()),
  ('SC',  'Special Consent',                   'special_consent','special_consent','all_scales', true, NOW())
ON CONFLICT (group_code) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════
-- 3. zone_land_use_controls
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS zone_land_use_controls (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id           UUID NOT NULL
                      REFERENCES vungu_proposed_peri_urban_zones(id) ON DELETE CASCADE,
  land_use_group_id UUID NOT NULL
                      REFERENCES land_use_groups(id) ON DELETE CASCADE,
  control_type      VARCHAR(20) NOT NULL
                      CHECK (control_type IN ('permitted', 'prohibited', 'special_consent')),
  authority         VARCHAR(100) DEFAULT 'Vungu RDC',
  notes             TEXT,
  conditions        TEXT,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_zlc_zone_id   ON zone_land_use_controls(zone_id);
CREATE INDEX IF NOT EXISTS idx_zlc_group_id  ON zone_land_use_controls(land_use_group_id);
CREATE INDEX IF NOT EXISTS idx_zlc_type      ON zone_land_use_controls(control_type);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'zone_land_use_controls'
      AND constraint_name = 'uq_zlc_zone_group'
  ) THEN
    ALTER TABLE zone_land_use_controls
      ADD CONSTRAINT uq_zlc_zone_group UNIQUE (zone_id, land_use_group_id);
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- 4. 3NF normalisation (from migration 078, fixed joins)
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ref_stand_statuses (
  code        VARCHAR(20) PRIMARY KEY,
  label       VARCHAR(64) NOT NULL,
  description TEXT,
  sort_order  INT NOT NULL DEFAULT 0
);
INSERT INTO ref_stand_statuses (code, label, description, sort_order) VALUES
  ('available', 'Available',  'Stand is open for citizen applications.',      1),
  ('reserved',  'Reserved',   'Soft-reserved for 30 min during application.', 2),
  ('allocated', 'Allocated',  'Stand has been formally allocated.',            3),
  ('withdrawn', 'Withdrawn',  'Stand has been removed from the register.',     4)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS ref_scale_categories (
  code  VARCHAR(20) PRIMARY KEY,
  label VARCHAR(64) NOT NULL
);
INSERT INTO ref_scale_categories (code, label) VALUES
  ('small_scale', 'Small Scale'),
  ('large_scale', 'Large Scale'),
  ('mixed_scale', 'Mixed Scale')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS ref_use_scales (
  code  VARCHAR(20) PRIMARY KEY,
  label VARCHAR(64) NOT NULL
);
INSERT INTO ref_use_scales (code, label) VALUES
  ('small_scale', 'Small Scale'),
  ('large_scale', 'Large Scale'),
  ('mixed_scale', 'Mixed Scale')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS ref_zone_types (
  code        VARCHAR(64) PRIMARY KEY,
  label       VARCHAR(128) NOT NULL,
  category    VARCHAR(32),
  description TEXT
);
INSERT INTO ref_zone_types (code, label, category) VALUES
  ('Communal Farming Zone',                  'Communal Farming Zone',                   'agricultural'),
  ('High Intensive Commercial Farming Zone', 'High Intensive Commercial Farming Zone',  'agricultural'),
  ('Estates Zone (Large Farms)',             'Estates Zone (Large Farms)',              'agricultural'),
  ('Irrigation Scheme Zone',                 'Irrigation Scheme Zone',                  'agricultural'),
  ('Proposed Peri-Urban Zone',               'Proposed Peri-Urban Zone',               'mixed'),
  ('Mixed Zone',                             'Mixed Zone',                              'mixed'),
  ('Beyond Peri-Urban Zone',                 'Beyond Peri-Urban Zone',                 'agricultural'),
  ('Industrial Zone',                        'Industrial Zone',                         'industrial'),
  ('Commercial Zone',                        'Commercial Zone',                         'commercial'),
  ('Residential Zone',                       'Residential Zone',                        'residential')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS ref_application_statuses (
  code        VARCHAR(50) PRIMARY KEY,
  label       VARCHAR(64) NOT NULL,
  is_terminal BOOLEAN NOT NULL DEFAULT false,
  sort_order  INT NOT NULL DEFAULT 0
);
INSERT INTO ref_application_statuses (code, label, is_terminal, sort_order) VALUES
  ('submitted',              'Submitted',              false, 1),
  ('under_review',           'Under Review',           false, 2),
  ('pending_payment',        'Pending Payment',        false, 3),
  ('approved',               'Approved',               true,  4),
  ('conditionally_approved', 'Conditionally Approved', true,  5),
  ('rejected',               'Rejected',               true,  6),
  ('withdrawn',              'Withdrawn',              true,  7),
  ('expired',                'Expired',                true,  8)
ON CONFLICT (code) DO NOTHING;

-- stands: add 3NF columns
ALTER TABLE stands
  ADD COLUMN IF NOT EXISTS ward_fid INT REFERENCES wards(fid) ON DELETE SET NULL;

UPDATE stands s
SET    ward_fid = w.fid
FROM   wards w
WHERE  LOWER(TRIM(s.ward)) = LOWER(TRIM(w.name_en))
  AND  s.ward_fid IS NULL;

ALTER TABLE stands
  ADD COLUMN IF NOT EXISTS use_scale_code VARCHAR(20) REFERENCES ref_use_scales(code);
UPDATE stands SET use_scale_code = use_scale
  WHERE use_scale IN (SELECT code FROM ref_use_scales) AND use_scale_code IS NULL;

ALTER TABLE stands
  ADD COLUMN IF NOT EXISTS status_code VARCHAR(20) REFERENCES ref_stand_statuses(code);
UPDATE stands SET status_code = status
  WHERE status IN (SELECT code FROM ref_stand_statuses) AND status_code IS NULL;

ALTER TABLE stands ADD COLUMN IF NOT EXISTS zone_type_cache VARCHAR(64);
UPDATE stands SET zone_type_cache = zone_type WHERE zone_type_cache IS NULL;

CREATE OR REPLACE FUNCTION fn_sync_zone_type_cache()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.zone_type_cache = NEW.zone_type;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_zone_type_cache ON stands;
CREATE TRIGGER trg_sync_zone_type_cache
  BEFORE INSERT OR UPDATE OF zone_type ON stands
  FOR EACH ROW EXECUTE FUNCTION fn_sync_zone_type_cache();

-- v_stands view — fixed JOIN using z.id (which now exists after step 1)
CREATE OR REPLACE VIEW v_stands AS
SELECT
  s.id, s.stand_number, s.ward,
  s.ward_fid,
  w.name_en                  AS ward_name,
  s.zone_id,
  COALESCE(z.zone, s.zone_type_cache) AS zone_type,
  s.use_scale,
  s.area_sqm,
  s.frontage_m,
  s.depth_m,
  s.price_usd,
  s.status,
  s.description,
  s.geom,
  s.centroid,
  s.reserved_by,
  s.reserved_at,
  s.reserved_until,
  s.allocated_to,
  s.allocated_at,
  s.created_by,
  s.created_at,
  s.updated_at
FROM stands s
LEFT JOIN wards                          w ON w.fid = s.ward_fid
LEFT JOIN vungu_proposed_peri_urban_zones z ON z.id  = s.zone_id;

CREATE INDEX IF NOT EXISTS idx_stands_ward_fid       ON stands(ward_fid);
CREATE INDEX IF NOT EXISTS idx_stands_status_code    ON stands(status_code);
CREATE INDEX IF NOT EXISTS idx_stands_use_scale_code ON stands(use_scale_code);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name  VARCHAR(255),
  phone      VARCHAR(32),
  job_title  VARCHAR(128),
  department VARCHAR(128),
  avatar_url TEXT,
  bio        TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Backfill user_profiles (fully defensive — only uses columns that definitely exist)
INSERT INTO user_profiles (user_id, updated_at)
SELECT id, NOW()
FROM users
ON CONFLICT (user_id) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════
-- 5. Make zones mutable (from migration 079)
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE vungu_proposed_peri_urban_zones
  ADD COLUMN IF NOT EXISTS zone_type       VARCHAR(64),
  ADD COLUMN IF NOT EXISTS zone_code       VARCHAR(32),
  ADD COLUMN IF NOT EXISTS scale_category  VARCHAR(20),
  ADD COLUMN IF NOT EXISTS authority       VARCHAR(100) DEFAULT 'Vungu RDC',
  ADD COLUMN IF NOT EXISTS zone_description TEXT,
  ADD COLUMN IF NOT EXISTS ward            VARCHAR(64),
  ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW();

UPDATE vungu_proposed_peri_urban_zones
  SET zone_type = zone
  WHERE zone_type IS NULL AND zone IS NOT NULL;

UPDATE vungu_proposed_peri_urban_zones
  SET scale_category = 'mixed_scale'
  WHERE scale_category IS NULL;

CREATE INDEX IF NOT EXISTS idx_vpuz_geom   ON vungu_proposed_peri_urban_zones USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_vpuz_active ON vungu_proposed_peri_urban_zones(is_active);
CREATE INDEX IF NOT EXISTS idx_vpuz_ward   ON vungu_proposed_peri_urban_zones(ward);
CREATE INDEX IF NOT EXISTS idx_vpuz_type   ON vungu_proposed_peri_urban_zones(zone_type);

-- ════════════════════════════════════════════════════════════════════════
-- 6. stands_tile_view (from migration 080)
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW stands_tile_view AS
SELECT
  ROW_NUMBER() OVER (ORDER BY created_at, id)::INTEGER AS fid,
  id::TEXT                                             AS stand_id,
  stand_number,
  ward,
  zone_type_cache,
  use_scale,
  status,
  COALESCE(ROUND(area_sqm)::INTEGER, 0)                AS area_sqm_int,
  COALESCE(ROUND(price_usd * 100)::INTEGER, 0)         AS price_usd_cents,
  geom
FROM stands
WHERE status != 'withdrawn';

CREATE INDEX IF NOT EXISTS idx_stands_geom    ON stands USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_stands_created ON stands(created_at);

COMMIT;
