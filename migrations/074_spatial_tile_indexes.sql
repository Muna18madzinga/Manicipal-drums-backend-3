-- 074_spatial_tile_indexes.sql
-- GiST indexes on every geometry column served as vector tiles, plus the
-- attribute index roads.fclass needs for the low-zoom road filter.
--
-- The zimbabwe.gpkg layers are imported separately (ogr2ogr), and may not
-- be present yet in a freshly-provisioned database (e.g. a new Render
-- Postgres). So every CREATE INDEX is guarded by a to_regclass() check:
-- the migration succeeds whether or not the spatial tables exist, and
-- creating the indexes simply becomes a no-op until the data is loaded.
-- Re-running after the import (this migration is re-run-safe via
-- IF NOT EXISTS) then creates the indexes for real.

DO $$
BEGIN
  IF to_regclass('public.country')                 IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_country_geom            ON country                 USING GIST (geom); END IF;
  IF to_regclass('public.provinces')               IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_provinces_geom          ON provinces               USING GIST (geom); END IF;
  IF to_regclass('public.districts')               IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_districts_geom          ON districts               USING GIST (geom); END IF;
  IF to_regclass('public.wards')                   IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_wards_geom              ON wards                   USING GIST (geom); END IF;
  IF to_regclass('public.landuse')                 IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_landuse_geom            ON landuse                 USING GIST (geom); END IF;
  IF to_regclass('public.admin_areas')             IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_admin_areas_geom        ON admin_areas             USING GIST (geom); END IF;
  IF to_regclass('public.places_areas')            IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_places_areas_geom       ON places_areas            USING GIST (geom); END IF;
  IF to_regclass('public.water_areas')             IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_water_areas_geom        ON water_areas             USING GIST (geom); END IF;
  IF to_regclass('public.waterways')               IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_waterways_geom          ON waterways               USING GIST (geom); END IF;
  IF to_regclass('public.protected_areas')         IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_protected_areas_geom    ON protected_areas         USING GIST (geom); END IF;
  IF to_regclass('public.natural_areas')           IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_natural_areas_geom      ON natural_areas           USING GIST (geom); END IF;
  IF to_regclass('public.roads')                   IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_roads_geom              ON roads                   USING GIST (geom); END IF;
  IF to_regclass('public.railways')                IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_railways_geom           ON railways                USING GIST (geom); END IF;
  IF to_regclass('public.buildings')               IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_buildings_geom          ON buildings               USING GIST (geom); END IF;
  IF to_regclass('public.traffic_areas')           IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_traffic_areas_geom      ON traffic_areas           USING GIST (geom); END IF;
  IF to_regclass('public.transport_areas')         IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_transport_areas_geom    ON transport_areas         USING GIST (geom); END IF;
  IF to_regclass('public.pois_areas')              IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_pois_areas_geom         ON pois_areas              USING GIST (geom); END IF;
  -- "pow" abbreviates "places_of_worship" to stay within PostgreSQL's 63-char identifier limit.
  IF to_regclass('public.places_of_worship_areas') IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_pow_areas_geom          ON places_of_worship_areas USING GIST (geom); END IF;
  IF to_regclass('public.places_points')           IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_places_points_geom      ON places_points           USING GIST (geom); END IF;
  IF to_regclass('public.pois_points')             IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_pois_points_geom        ON pois_points             USING GIST (geom); END IF;
  IF to_regclass('public.traffic_points')          IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_traffic_points_geom     ON traffic_points          USING GIST (geom); END IF;
  IF to_regclass('public.transport_points')        IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_transport_points_geom   ON transport_points        USING GIST (geom); END IF;
  IF to_regclass('public.natural_points')          IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_natural_points_geom     ON natural_points          USING GIST (geom); END IF;
  IF to_regclass('public.places_of_worship_points') IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_pow_points_geom        ON places_of_worship_points USING GIST (geom); END IF;

  IF to_regclass('public.roads')                   IS NOT NULL THEN CREATE INDEX IF NOT EXISTS idx_roads_fclass            ON roads (fclass); END IF;
END $$;
