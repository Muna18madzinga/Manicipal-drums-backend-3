-- Migration 126: stands.zone_id → canonical integer zone reference.
--
-- stands.zone_id is UUID (pk of the legacy vungu_proposed_peri_urban_zones
-- map copy, since removed) while the canonical proposed_peri_urban_zones.id
-- is integer — the 112 repoint. It was the only UUID zone reference in the
-- schema (development_matrix, gweru_rural_farms and zone_land_use_controls
-- already use integer zone_id). This ALTERS the stands.zone_id type to match,
-- adds a real FK, and restores the v_stands join (which 078 defined but had
-- to neuter because the type pair was unexpressable).
--
-- Safe on empty stands (the current live state). If stands ever held rows
-- with map-copy UUIDs, those would have no canonical integer counterpart and
-- become NULL — re-seed / re-assign zone_id after applying.
--
-- Idempotent. Apply: node scripts/apply-local-migration.js 126_stands_zone_id_integer.sql

BEGIN;

-- v_stands (from 078) selects stands.zone_id and blocks the re-type; drop it
-- and recreate with the restored zone join at the end of this migration.
DROP VIEW IF EXISTS v_stands;

-- Re-type. USING NULL: no valid cast exists from the legacy UUIDs; empty
-- table today so nothing is lost. (ALTER TYPE rewrites the column.)
ALTER TABLE stands
  ALTER COLUMN zone_id TYPE INTEGER USING NULL;

-- Real FK now that the types agree.
ALTER TABLE stands DROP CONSTRAINT IF EXISTS fk_stands_zone;
ALTER TABLE stands
  ADD CONSTRAINT fk_stands_zone
    FOREIGN KEY (zone_id) REFERENCES proposed_peri_urban_zones(id)
    ON DELETE SET NULL;

COMMENT ON COLUMN stands.zone_id IS
  'FK to proposed_peri_urban_zones(id) — canonical zoning (112 repoint). Formerly UUID into the removed vungu_* map-copy table.';

-- Restore the authoritative zone join in v_stands now the types match.
CREATE OR REPLACE VIEW v_stands AS
SELECT
  s.id, s.stand_number, s.ward,
  s.ward_fid,
  w.name_en              AS ward_name,
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
LEFT JOIN wards                     w ON w.fid = s.ward_fid
LEFT JOIN proposed_peri_urban_zones z ON z.id = s.zone_id;

COMMENT ON VIEW v_stands IS
  '3NF-normalised view of stands: zone_type resolved from canonical zones via fk_stands_zone, ward_name from PostGIS wards.';

COMMIT;