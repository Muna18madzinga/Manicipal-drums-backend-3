-- 112: zones_master — the canonical peri-urban zoning source of truth.
--
-- proposed_peri_urban_zones is already the referential master: development_matrix,
-- gweru_rural_farms and zone_land_use_controls all FK to its `id`, and the
-- compliance function (075) reads it. The map, however, drew a divergent copy
-- (vungu_proposed_peri_urban_zones). This view makes the permit master the ONE
-- source both permits and the map read — with zero FK migration, because the
-- ids never move. The map (tile registry + QGIS project) is repointed at this
-- view; the legacy vungu_* table is left intact as the rollback until the
-- council signs off on geometry reconciliation (Phase 3) and it is dropped
-- (Phase 4). See docs/SSOT-spatial.md.
--
-- Idempotent. Apply: node scripts/apply-local-migration.js 112_zones_master_view.sql

BEGIN;

-- Master carried 1 invalid polygon; repair it so tiles/QGIS never choke.
-- ST_MakeValid can yield a collection — keep only polygonal parts.
UPDATE proposed_peri_urban_zones
   SET geom = ST_CollectionExtract(ST_MakeValid(geom), 3)
 WHERE NOT ST_IsValid(geom);

CREATE OR REPLACE VIEW zones_master AS
  SELECT id, zone, zone_code, is_active, display_order, geom
    FROM proposed_peri_urban_zones;

COMMENT ON VIEW zones_master IS
  'Canonical peri-urban zoning (SSOT). Mirrors proposed_peri_urban_zones (permit master, FK target). Map + permits both read this. See docs/SSOT-spatial.md.';

COMMIT;
