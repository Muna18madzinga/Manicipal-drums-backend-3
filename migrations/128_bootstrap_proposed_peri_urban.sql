-- Migration 128: bootstrap proposed_peri_urban_zones from Vungu map copy when missing.
-- Fresh dumps often have vungu_proposed_peri_urban_zones (map) but not the permit master
-- table that 112/113 and development_matrix FKs expect.

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$
BEGIN
  IF to_regclass('public.proposed_peri_urban_zones') IS NULL
     AND to_regclass('public.vungu_proposed_peri_urban_zones') IS NOT NULL THEN
    EXECUTE $c$
      CREATE TABLE proposed_peri_urban_zones AS
      SELECT
        ROW_NUMBER() OVER ()::INT AS id,
        COALESCE(zone, zone_code, 'Zone '||fid::text) AS zone,
        COALESCE(zone_code, 'Z'||fid::text) AS zone_code,
        NULL::TEXT AS zone_type,
        NULL::TEXT AS scale_category,
        NULL::TEXT AS authority,
        NULL::TEXT AS zone_description,
        true AS is_active,
        NULL::TEXT AS map_color,
        fid::INT AS display_order,
        geom
      FROM vungu_proposed_peri_urban_zones
      WHERE geom IS NOT NULL
    $c$;
    EXECUTE 'ALTER TABLE proposed_peri_urban_zones ADD PRIMARY KEY (id)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS proposed_peri_urban_zones_geom_gix ON proposed_peri_urban_zones USING GIST (geom)';
    RAISE NOTICE 'Bootstrapped proposed_peri_urban_zones from vungu_proposed_peri_urban_zones';
  ELSIF to_regclass('public.proposed_peri_urban_zones') IS NULL THEN
    CREATE TABLE proposed_peri_urban_zones (
      id SERIAL PRIMARY KEY,
      zone TEXT,
      zone_code TEXT,
      zone_type TEXT,
      scale_category TEXT,
      authority TEXT,
      zone_description TEXT,
      is_active BOOLEAN DEFAULT true,
      map_color TEXT,
      display_order INT,
      geom geometry(MultiPolygon, 4326)
    );
    RAISE NOTICE 'Created empty proposed_peri_urban_zones shell';
  END IF;
END $$;

COMMIT;
