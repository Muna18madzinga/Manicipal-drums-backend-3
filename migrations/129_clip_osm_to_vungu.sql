-- Migration 129: Clip OSM / basemap feature tables to Vungu RDC only.
--
-- Boundary = union of wards WHERE pcode LIKE 'ZW1704%' (admin code for Vungu /
-- historic Gweru Rural), buffered 250 m so edge features are not lost.
--
-- Runtime queries already hit raw PostGIS tables (public.buildings, public.roads, …)
-- via spatialLayers.js + /tiles — never GeoPackage. This migration shrinks those
-- tables so only Vungu geography remains.
--
-- Method: CREATE TABLE … AS SELECT (intersect) → drop old → rename → reindex.
-- Faster and cleaner than DELETE of ~5.7M national buildings.
--
-- Run: node scripts/clip-osm-to-vungu.js
-- Or:  node scripts/apply-local-migration.js 129_clip_osm_to_vungu.sql  (may time out)

BEGIN;

CREATE TABLE IF NOT EXISTS public.vungu_clip_boundary (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  geom geometry(MultiPolygon, 4326) NOT NULL,
  source text NOT NULL DEFAULT 'wards ZW1704% + 250m buffer',
  created_at timestamptz NOT NULL DEFAULT now()
);

DELETE FROM public.vungu_clip_boundary;

WITH validated AS (
  SELECT ST_MakeValid(ST_SetSRID(geom::geometry, 4326)) AS g
  FROM public.wards
  WHERE pcode LIKE 'ZW1704%' AND geom IS NOT NULL
),
unioned AS (
  SELECT ST_MakeValid(ST_UnaryUnion(ST_Collect(g))) AS g FROM validated
),
buffered AS (
  SELECT ST_Multi(
           ST_MakeValid(
             ST_Buffer(g::geography, 250)::geometry
           )
         ) AS g
  FROM unioned
)
INSERT INTO public.vungu_clip_boundary (id, geom)
SELECT 1, g FROM buffered WHERE g IS NOT NULL;

CREATE INDEX IF NOT EXISTS vungu_clip_boundary_geom_idx
  ON public.vungu_clip_boundary USING GIST (geom);

COMMENT ON TABLE public.vungu_clip_boundary IS
  'Single MultiPolygon SSOT for clipping OSM basemap tables to Vungu RDC (ZW1704 wards + 250m).';

COMMIT;
