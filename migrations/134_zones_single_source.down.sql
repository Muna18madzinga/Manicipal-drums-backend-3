-- Rollback for migration 134 (zones_single_source). Manual: nothing in this
-- repository executes .down.sql files, it exists so the reversal is written down
-- rather than reconstructed under pressure.
--
-- Reverses, in order:
--   3. drops trg_touch_updated_at
--   2. re-creates vungu_proposed_peri_urban_zones from the 2026-06-22 shapefile
--      import that the 2026-10-02 recovery restored it from, and re-copies the
--      36 zones into it
--   1. re-binds zone_land_use_controls.zone_id to that copy, as uuid
--
-- Reverting step 1 reinstates the integer-vs-uuid defect on purpose: it is the
-- pre-134 state. Only do this to reach a known-broken schema while diagnosing.

BEGIN;

-- ── 3. ────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_touch_updated_at ON public.proposed_peri_urban_zones;

-- ── 2. ────────────────────────────────────────────────────────────────────
-- Geometry is copied across rather than re-derived, so the rollback restores the
-- same 34 distinct geometries rather than an approximation of them. zone_code
-- comes out NULL, which is exactly what the copy held.
CREATE TABLE IF NOT EXISTS public.vungu_proposed_peri_urban_zones (
  fid              integer      NOT NULL DEFAULT nextval('vungu_proposed_peri_urban_zones_fid_seq'::regclass),
  fid_1            text,
  area_ha          text,
  zone             text,
  area             text,
  lb               text,
  shape_leng       text,
  shape_area       text,
  geom             geometry(MultiPolygon,4326),
  id               uuid         NOT NULL DEFAULT gen_random_uuid(),
  zone_type        character varying(64),
  zone_code        character varying(32),
  scale_category   character varying(20),
  authority        character varying(100) DEFAULT 'Vungu RDC'::character varying,
  zone_description text,
  ward             character varying(64),
  is_active        boolean      NOT NULL DEFAULT true,
  created_at       timestamp with time zone DEFAULT now(),
  updated_at       timestamp with time zone DEFAULT now()
);

INSERT INTO public.vungu_proposed_peri_urban_zones
  (zone, geom, created_at, updated_at)
SELECT zone, geom, created_at, created_at
  FROM public.proposed_peri_urban_zones
 WHERE NOT EXISTS (SELECT 1 FROM public.vungu_proposed_peri_urban_zones);

-- The recovery dump kept the legacy shapefile columns; carry the values across
-- so the copy is not silently hollow on rollback.
UPDATE public.vungu_proposed_peri_urban_zones v
   SET zone_type = p.zone_type,
       zone_code = p.zone_code,
       scale_category = p.scale_category,
       authority = p.authority,
       zone_description = p.zone_description,
       ward = p.ward,
       is_active = p.is_active,
       area_ha = round(ST_Area(p.geom::geography) / 10000.0::numeric, 8)::text,
       shape_leng = round(ST_Length(p.geom::geography)::numeric, 7)::text,
       shape_area = round(ST_Area(p.geom::geography)::numeric, 4)::text
  FROM public.proposed_peri_urban_zones p
 WHERE v.zone = p.zone
   AND v.geom IS NOT DISTINCT FROM p.geom;

-- ── 1. ────────────────────────────────────────────────────────────────────
ALTER TABLE public.zone_land_use_controls
  DROP CONSTRAINT IF EXISTS zone_land_use_controls_zone_id_fkey;

ALTER TABLE public.zone_land_use_controls
  ALTER COLUMN zone_id TYPE uuid
  USING NULLIF(zone_id::text, '')::uuid;

ALTER TABLE public.zone_land_use_controls
  ADD CONSTRAINT zone_land_use_controls_zone_id_fkey
  FOREIGN KEY (zone_id) REFERENCES public.vungu_proposed_peri_urban_zones(id)
  ON DELETE CASCADE;

COMMIT;
