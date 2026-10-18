-- 183: Acua ~300 m² stand sub-units — an extra allocation layer inside larger
-- parent stands (and as a named estate typology). Served as MVT layer `acua_stands`.

BEGIN;

CREATE TABLE IF NOT EXISTS public.stand_subunit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_stand_id uuid REFERENCES public.stands(id) ON DELETE CASCADE,
  subunit_number text NOT NULL,
  estate text NOT NULL DEFAULT 'Acua',
  typology text NOT NULL DEFAULT 'acua_300'
    CHECK (typology IN ('acua_300', 'other')),
  target_area_sqm numeric(12,2) NOT NULL DEFAULT 300,
  area_sqm numeric(12,2),
  status text NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'reserved', 'allocated', 'withdrawn')),
  price_usd numeric(12,2),
  ward text,
  description text,
  geom geometry(Polygon, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subunit_number)
);

CREATE INDEX IF NOT EXISTS idx_stand_subunit_geom ON public.stand_subunit USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_stand_subunit_parent ON public.stand_subunit (parent_stand_id);
CREATE INDEX IF NOT EXISTS idx_stand_subunit_status ON public.stand_subunit (status);
CREATE INDEX IF NOT EXISTS idx_stand_subunit_typology ON public.stand_subunit (typology);

COMMENT ON TABLE public.stand_subunit IS
  'Smaller residential plots (e.g. Acua 300 m²) carved from or nested under parent stands.';

-- Seed Acua 300 m² cells inside parent stands whose measured area > 900 m²
-- (enough for at least two ~300 m² plots). Grid in UTM 35S (EPSG:32735).
WITH parents AS (
  SELECT id, stand_number, ward, geom,
         ST_Transform(geom, 32735) AS g_m
    FROM public.stands
   WHERE status <> 'withdrawn'
     AND ST_Area(geom::geography) > 900
),
cells AS (
  SELECT
    p.id AS parent_stand_id,
    p.stand_number,
    p.ward,
    ST_Transform(
      ST_MakeValid(ST_Intersection(p.g_m, g.geom)),
      4326
    ) AS cell_geom
  FROM parents p
  CROSS JOIN LATERAL ST_SquareGrid(17.32, p.g_m) AS g
),
valid AS (
  SELECT *
    FROM cells
   WHERE cell_geom IS NOT NULL
     AND NOT ST_IsEmpty(cell_geom)
     AND ST_GeometryType(cell_geom) IN ('ST_Polygon', 'ST_MultiPolygon')
     AND ST_Area(cell_geom::geography) BETWEEN 180 AND 450
),
numbered AS (
  SELECT
    parent_stand_id,
    stand_number,
    ward,
    CASE
      WHEN ST_GeometryType(cell_geom) = 'ST_MultiPolygon'
        THEN ST_GeometryN(cell_geom, 1)
      ELSE cell_geom
    END AS geom,
    ROW_NUMBER() OVER (ORDER BY stand_number, ST_XMin(cell_geom), ST_YMin(cell_geom)) AS n
  FROM valid
)
INSERT INTO public.stand_subunit (
  parent_stand_id, subunit_number, estate, typology, target_area_sqm,
  area_sqm, status, ward, description, geom
)
SELECT
  parent_stand_id,
  'ACUA-' || LPAD(n::text, 3, '0'),
  'Acua',
  'acua_300',
  300,
  ROUND(ST_Area(geom::geography)::numeric, 2),
  'available',
  ward,
  'Acua residential sub-unit (~300 m²) within ' || stand_number,
  geom
FROM numbered
WHERE n <= 120
ON CONFLICT (subunit_number) DO NOTHING;

CREATE OR REPLACE VIEW public.acua_stands_tile_view AS
SELECT
  ROW_NUMBER() OVER (ORDER BY created_at, id)::INTEGER AS fid,
  id::TEXT AS subunit_id,
  subunit_number,
  parent_stand_id::TEXT AS parent_stand_id,
  estate,
  typology,
  status,
  COALESCE(ROUND(area_sqm)::INTEGER, ROUND(target_area_sqm)::INTEGER, 0) AS area_sqm_int,
  COALESCE(ROUND(price_usd * 100)::INTEGER, 0) AS price_usd_cents,
  geom
FROM public.stand_subunit
WHERE status <> 'withdrawn'
  AND typology = 'acua_300';

COMMENT ON VIEW public.acua_stands_tile_view IS
  'MVT view of Acua ~300 m² stand sub-units for MapLibre.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.stand_subunit TO vungu_app';
    EXECUTE 'GRANT SELECT ON public.acua_stands_tile_view TO vungu_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_system') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.stand_subunit TO vungu_system';
    EXECUTE 'GRANT SELECT ON public.acua_stands_tile_view TO vungu_system';
  END IF;
END $$;

COMMIT;
