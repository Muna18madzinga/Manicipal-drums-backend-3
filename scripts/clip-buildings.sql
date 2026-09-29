-- Two-phase clip of public.buildings to Vungu (vungu_clip_boundary)
\timing on
SET statement_timeout = 0;
SET maintenance_work_mem = '1GB';
SET work_mem = '256MB';

DROP TABLE IF EXISTS public.buildings__vungu_clip;

-- Phase 1: GiST bbox
CREATE TABLE public.buildings__vungu_clip AS
SELECT t.*
FROM public.buildings t
WHERE t.geom && (SELECT geom FROM public.vungu_clip_boundary WHERE id = 1);

SELECT COUNT(*) AS after_bbox FROM public.buildings__vungu_clip;

-- Phase 2: precise intersect
DELETE FROM public.buildings__vungu_clip
WHERE NOT ST_Intersects(geom, (SELECT geom FROM public.vungu_clip_boundary WHERE id = 1));

SELECT COUNT(*) AS after_precise FROM public.buildings__vungu_clip;

ALTER TABLE public.buildings__vungu_clip ADD PRIMARY KEY (fid);
CREATE INDEX buildings__vungu_clip_geom_idx ON public.buildings__vungu_clip USING GIST (geom);

BEGIN;
DROP TABLE public.buildings;
ALTER TABLE public.buildings__vungu_clip RENAME TO buildings;
COMMIT;

-- Rename indexes best-effort
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'buildings__vungu_clip_pkey') THEN
    ALTER INDEX buildings__vungu_clip_pkey RENAME TO buildings_pk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'buildings__vungu_clip_geom_idx') THEN
    ALTER INDEX buildings__vungu_clip_geom_idx RENAME TO buildings_geom_geom_idx;
  END IF;
END $$;

ANALYZE public.buildings;
SELECT COUNT(*) AS buildings_final FROM public.buildings;
SELECT pg_size_pretty(pg_total_relation_size('public.buildings')) AS buildings_size;
