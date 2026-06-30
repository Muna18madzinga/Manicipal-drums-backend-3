-- migrations/079_filter_buildings_to_council_buffer.sql
--
-- Filters the country-wide OSM buildings dataset (5.7 M rows, 1.8 GB)
-- down to buildings within a 50 km buffer of the Vungu RDC council
-- district (Gweru, pcode ZW1704). Result: ~711 k rows, ~223 MB.
--
-- Why: this is a municipal planning portal for one council. Buildings
-- 500 km away in Harare or Bulawayo are noise, but a 50 km buffer keeps
-- useful context (Kwekwe, Shurugwi, Mvuma, neighbouring rural villages)
-- so the planner's "see what's near my stand" workflow still works.
--
-- The pcode is parameterised through the COUNCIL_DISTRICT_PCODE env var
-- used everywhere else in the backend, but SQL migrations can't read
-- env, so the value is hardcoded here. To change councils, edit the
-- WHERE clause and re-run.
--
-- Idempotent: re-running deletes nothing because every remaining row
-- already satisfies the buffer condition.
--
-- Runtime: ~5-15 minutes on a developer laptop. The table is locked for
-- writes during the DELETE; the GiST index on buildings.geom makes the
-- bbox-based first-pass fast, then ST_DWithin filters precisely.
--
-- Post-migration: run `VACUUM FULL public.buildings` from psql to
-- reclaim the dead-tuple space (VACUUM FULL cannot run inside a
-- transaction so it lives outside the migration runner).

BEGIN;

DELETE FROM public.buildings b
WHERE NOT EXISTS (
  SELECT 1
  FROM public.districts d
  WHERE d.pcode = 'ZW1704'
    AND ST_DWithin(
      ST_Transform(b.geom, 4326)::geography,
      ST_Transform(d.geom, 4326)::geography,
      50000  -- 50 km in metres
    )
);

-- Refresh planner stats so subsequent EXPLAIN plans see the new row
-- count. ANALYZE is transaction-safe; VACUUM FULL is not (run that
-- separately).
ANALYZE public.buildings;

COMMIT;
