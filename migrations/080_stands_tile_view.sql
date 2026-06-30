-- Migration 080: stands_tile_view
--
-- Exposes the stands table as a vector-tile-compatible view so the PostGIS
-- tile endpoint (GET /api/tiles/stands/:z/:x/:y.pbf) can serve stand polygons
-- alongside the other master-plan layers.
--
-- The main challenge: the tile system expects an integer `fid` for feature-state
-- and click-to-detail. stands.id is a UUID. We solve this cleanly with
-- row_number() OVER (ORDER BY created_at, id) as the integer fid.
--
-- Tile-layer attributes (compact for efficient MVT encoding):
--   fid            INTEGER  — stable enough for hover; changes if rows deleted
--   stand_id       TEXT     — full UUID for API calls
--   stand_number   TEXT
--   ward           TEXT
--   zone_type_cache TEXT
--   use_scale      TEXT
--   status         TEXT
--   area_sqm_int   INTEGER  — rounded area for display
--   price_usd_cents INTEGER — price * 100 avoids float in MVT
--
-- geom column: reuses stands.geom (EPSG:4326) — no SRID transform needed in
-- the tile query; the tile endpoint handles ST_Transform to 3857.

BEGIN;

CREATE OR REPLACE VIEW stands_tile_view AS
SELECT
  ROW_NUMBER() OVER (ORDER BY created_at, id)::INTEGER  AS fid,
  id::TEXT                                               AS stand_id,
  stand_number,
  ward,
  zone_type_cache,
  use_scale,
  status,
  COALESCE(ROUND(area_sqm)::INTEGER, 0)                 AS area_sqm_int,
  COALESCE(ROUND(price_usd * 100)::INTEGER, 0)          AS price_usd_cents,
  geom
FROM stands
WHERE status != 'withdrawn';

COMMENT ON VIEW stands_tile_view IS
  'MVT-compatible view of stands: integer fid + compact attributes for MapLibre vector tiles.';

-- GiST index on stands.geom (idempotent — created by migration 062 but may
-- have been dropped during a rebuild). The tile query does a bbox && filter.
CREATE INDEX IF NOT EXISTS idx_stands_geom    ON stands USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_stands_created ON stands(created_at);

COMMIT;
