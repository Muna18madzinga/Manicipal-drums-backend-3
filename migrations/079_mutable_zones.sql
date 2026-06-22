-- Migration 079: Make planning zones mutable
--
-- The vungu_proposed_peri_urban_zones table is gpkg-imported (read-only by
-- convention) but needs to be writeable for the EO Planner and Planner to:
--   - Add new special-permit zones at ward level
--   - Edit zone type, scale category, authority
--   - Deactivate superseded zones
--
-- Also ensures zone_land_use_controls has a unique constraint on
-- (zone_id, land_use_group_id) so the ON CONFLICT upsert in zones.js works.

BEGIN;

-- 1. Add management columns if not present
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

-- 2. Seed zone_type from existing 'zone' column where missing
UPDATE vungu_proposed_peri_urban_zones
  SET zone_type = zone
  WHERE zone_type IS NULL AND zone IS NOT NULL;

-- 3. Set scale_category default
UPDATE vungu_proposed_peri_urban_zones
  SET scale_category = 'mixed_scale'
  WHERE scale_category IS NULL;

-- 4. Unique constraint for zone_land_use_controls upsert
ALTER TABLE zone_land_use_controls
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

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

-- 5. Spatial index on vungu_proposed_peri_urban_zones if missing
CREATE INDEX IF NOT EXISTS idx_vpuz_geom   ON vungu_proposed_peri_urban_zones USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_vpuz_active ON vungu_proposed_peri_urban_zones(is_active);
CREATE INDEX IF NOT EXISTS idx_vpuz_ward   ON vungu_proposed_peri_urban_zones(ward);
CREATE INDEX IF NOT EXISTS idx_vpuz_type   ON vungu_proposed_peri_urban_zones(zone_type);

COMMIT;
