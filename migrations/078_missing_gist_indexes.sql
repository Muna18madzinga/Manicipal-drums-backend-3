-- migrations/078_missing_gist_indexes.sql
--
-- Two legacy tables (gweru_health_centres, gweru_peri_urban_zone) were not
-- covered by migration 074. They are small (≤ 50 rows each) so the planner
-- usually picks a Seq Scan, but the && tile-envelope filter is still better
-- served by GiST. Adding the indexes makes the spatial-tile pipeline uniform
-- across every PostGIS table.
--
-- Idempotent: IF NOT EXISTS guards survive re-runs.

CREATE INDEX IF NOT EXISTS idx_gweru_health_centres_geom_gist
  ON public.gweru_health_centres USING GIST (geom);

CREATE INDEX IF NOT EXISTS idx_gweru_peri_urban_zone_geom_gist
  ON public.gweru_peri_urban_zone USING GIST (geom);
