-- 113: complete the canonical zone table for the zone-editing API.
--
-- zones.js (mutable zone CRUD) and map-search were written against a planned
-- schema (migrations 079/081) that was never applied here and targeted the
-- wrong table (the map copy vungu_proposed_peri_urban_zones). We repoint them
-- at the real master, proposed_peri_urban_zones, which already has id (serial),
-- zone, zone_code, zone_type, scale_category, authority, zone_description,
-- is_active, map_color, display_order. It only lacked these three. Adding them
-- is additive and safe — existing rows get sensible defaults; FK dependents
-- (development_matrix, gweru_rural_farms, zone_land_use_controls) are untouched.
--
-- Idempotent. Apply: node scripts/apply-local-migration.js 113_zones_master_columns.sql

BEGIN;

ALTER TABLE proposed_peri_urban_zones
  ADD COLUMN IF NOT EXISTS ward       VARCHAR,
  ADD COLUMN IF NOT EXISTS created_at  TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ DEFAULT now();

COMMIT;
