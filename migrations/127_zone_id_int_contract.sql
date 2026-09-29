-- Migration 127: zone_id type contract — INTEGER FK to zones_master / proposed_peri_urban_zones
--
-- Historical bug: stands.zone_id was UUID while proposed_peri_urban_zones.id is SERIAL.
-- land-use-management-enhanced.js schema said UUID; development-control used INTEGER.
-- This migration adds zone_id_int as the canonical FK without breaking old UUID column.

BEGIN;

ALTER TABLE stands
  ADD COLUMN IF NOT EXISTS zone_id_int INTEGER;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'stands' AND constraint_name = 'fk_stands_zone_id_int'
  ) THEN
    ALTER TABLE stands
      ADD CONSTRAINT fk_stands_zone_id_int
        FOREIGN KEY (zone_id_int) REFERENCES proposed_peri_urban_zones(id)
        ON DELETE SET NULL;
  END IF;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'proposed_peri_urban_zones missing — FK skipped (dump-only table)';
END $$;

CREATE INDEX IF NOT EXISTS idx_stands_zone_id_int ON stands(zone_id_int);

COMMENT ON COLUMN stands.zone_id IS
  'LEGACY UUID column — do not use for new joins. Prefer zone_id_int → proposed_peri_urban_zones.id / zones_master.';
COMMENT ON COLUMN stands.zone_id_int IS
  'Canonical zone FK (INTEGER) to proposed_peri_urban_zones.id (zones_master SSOT).';

-- Refresh v_stands to expose zone label from master when zone_id_int is set
DROP VIEW IF EXISTS v_stands CASCADE;

CREATE OR REPLACE VIEW v_stands AS
SELECT
  s.id, s.stand_number, s.ward,
  s.ward_fid,
  w.name_en AS ward_name,
  s.zone_id,
  s.zone_id_int,
  COALESCE(z.zone, s.zone_type_cache, s.zone_type)::TEXT AS zone_type,
  s.use_scale,
  s.use_scale_code,
  s.status_code,
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
LEFT JOIN wards w ON w.fid = s.ward_fid
LEFT JOIN proposed_peri_urban_zones z ON z.id = s.zone_id_int;

COMMENT ON VIEW v_stands IS
  '3NF stands view: ward from PostGIS; zone_type from zones_master via zone_id_int when set.';

COMMIT;
