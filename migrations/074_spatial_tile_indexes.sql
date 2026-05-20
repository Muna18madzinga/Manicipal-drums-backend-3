-- 074_spatial_tile_indexes.sql
-- GiST indexes on every geometry column served as vector tiles, plus the
-- attribute index roads.fclass needs for the low-zoom road filter.
-- IF NOT EXISTS keeps this safe to re-run.

CREATE INDEX IF NOT EXISTS idx_country_geom              ON country              USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_provinces_geom            ON provinces            USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_districts_geom            ON districts            USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_wards_geom                ON wards                USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_landuse_geom              ON landuse              USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_admin_areas_geom          ON admin_areas          USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_places_areas_geom         ON places_areas         USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_water_areas_geom          ON water_areas          USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_waterways_geom            ON waterways            USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_protected_areas_geom      ON protected_areas      USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_natural_areas_geom        ON natural_areas        USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_roads_geom                ON roads                USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_railways_geom             ON railways             USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_buildings_geom            ON buildings            USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_traffic_areas_geom        ON traffic_areas        USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_transport_areas_geom      ON transport_areas      USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_pois_areas_geom           ON pois_areas           USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_pow_areas_geom            ON places_of_worship_areas USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_places_points_geom        ON places_points        USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_pois_points_geom          ON pois_points          USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_traffic_points_geom       ON traffic_points       USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_transport_points_geom     ON transport_points     USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_natural_points_geom       ON natural_points       USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_pow_points_geom           ON places_of_worship_points USING GIST (geom);

CREATE INDEX IF NOT EXISTS idx_roads_fclass              ON roads (fclass);
