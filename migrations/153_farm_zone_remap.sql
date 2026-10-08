-- 153_farm_zone_remap.sql
-- ─────────────────────────────────────────────────────────────────────────
-- STATUS: PREPARED, NOT REGISTERED in scripts/migrate.js. It runs nowhere until someone reviews
-- docs/farm-zone-remap-review.csv and adds it to the migration list. Rehearse it first, changing
-- nothing, with:   node scripts/rehearse-farm-zone-remap.js
--
-- THE PROBLEM. gweru_rural_farms.zone_id was assigned against the ids of the OLD gweru_peri_urban_zone
-- table (ids up to 43). The canonical table, proposed_peri_urban_zones, has different ids (1 to 36).
-- Read as they stand, 2 of the 262 assignments point at the zone the farm lies in and 36 point at an
-- id that does not exist. The by-parcel permitted-uses and the farm list show the wrong zone.
--
-- WHAT THIS DOES. For every farm that has a zone_id, it restores what the assignment MEANT:
--   old id -> the old zone row -> the canonical zone with the SAME SHAPE (overlap >= 0.99).
-- It does not re-decide anything. A farm whose assigned zone differs from the zone it lies in is
-- remapped faithfully and FLAGGED for a person (agrees = false); the intent is kept, the
-- disagreement is reported. A farm whose old id has no canonical counterpart (the old table's six rows
-- with no geometry, and id 43, an Institutional polygon that matches nothing) gets zone_id = NULL and
-- is flagged, rather than keeping an id that now means a different zone.
--
-- SAFETY.
--   * Every original value is kept in gweru_rural_farms.zone_id_legacy, and every decision is recorded
--     in farm_zone_remap, so it is fully reversible (153_farm_zone_remap.down.sql).
--   * It runs ONCE: if farm_zone_remap already holds rows it does nothing, so a farm assigned a
--     canonical id after this ran is never "remapped" again. Re-applying is a no-op.
--   * On a database with no old table or no assigned farms it does nothing.
--   * Nothing is deleted. gweru_peri_urban_zone is left in place (its ids are the key to the legacy values).
--
-- AFTER IT RUNS the stored zone_id is the intended canonical zone for 249 of 262 farms (on the dev
-- data) and NULL for 13. The longer-term answer is to stop storing the assignment and derive a
-- farm's zone from where it lies (parcel zoning, migration 144); see docs/DATA-AUDIT-2026-10-08.md.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.gweru_rural_farms') IS NULL OR to_regclass('public.gweru_peri_urban_zone') IS NULL
     OR to_regclass('public.proposed_peri_urban_zones') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE public.gweru_rural_farms ADD COLUMN IF NOT EXISTS zone_id_legacy integer;
  ALTER TABLE public.gweru_rural_farms ADD COLUMN IF NOT EXISTS zone_remap_status text;

  CREATE TABLE IF NOT EXISTS public.farm_zone_remap (
    farm_id          integer PRIMARY KEY,
    old_zone_id      integer NOT NULL,
    old_zone_name    text,
    new_zone_id      integer,
    new_zone_name    text,
    basis            text NOT NULL,           -- 'identical shape' or 'no canonical counterpart'
    lies_in_zone_id  integer,                 -- the zone the farm actually lies in (largest overlap)
    lies_in_zone_name text,
    agrees           boolean,                 -- the remapped zone is the zone the farm lies in
    applied_at       timestamptz NOT NULL DEFAULT now()
  );

  -- Already run: do nothing, so a later canonical assignment is never remapped.
  IF EXISTS (SELECT 1 FROM public.farm_zone_remap) THEN RETURN; END IF;

  INSERT INTO public.farm_zone_remap
    (farm_id, old_zone_id, old_zone_name, new_zone_id, new_zone_name, basis, lies_in_zone_id, lies_in_zone_name, agrees)
  SELECT f.id, f.zone_id, o.zone, m.canonical_id, c.zone,
         CASE WHEN m.canonical_id IS NULL THEN 'no canonical counterpart' ELSE 'identical shape' END,
         d.id, d.zone,
         CASE WHEN m.canonical_id IS NULL OR d.id IS NULL THEN NULL ELSE (m.canonical_id = d.id) END
    FROM public.gweru_rural_farms f
    LEFT JOIN public.gweru_peri_urban_zone o ON o.id = f.zone_id
    LEFT JOIN LATERAL (
      SELECT z.id AS canonical_id
        FROM public.proposed_peri_urban_zones z
       WHERE o.geom IS NOT NULL AND z.geom && o.geom AND ST_Intersects(ST_MakeValid(o.geom), ST_MakeValid(z.geom))
         AND ST_Area(ST_Intersection(ST_MakeValid(o.geom), ST_MakeValid(z.geom))) /
             NULLIF(ST_Area(ST_Union(ST_MakeValid(o.geom), ST_MakeValid(z.geom))), 0) >= 0.99
       ORDER BY z.id LIMIT 1) m ON TRUE
    LEFT JOIN public.proposed_peri_urban_zones c ON c.id = m.canonical_id
    LEFT JOIN LATERAL (
      SELECT z.id, z.zone
        FROM public.proposed_peri_urban_zones z
       WHERE f.geom IS NOT NULL AND z.geom && f.geom AND ST_Intersects(ST_MakeValid(z.geom), ST_MakeValid(f.geom))
       ORDER BY ST_Area(ST_Intersection(ST_MakeValid(z.geom), ST_MakeValid(f.geom))) DESC LIMIT 1) d ON TRUE
   WHERE f.zone_id IS NOT NULL
  ON CONFLICT (farm_id) DO NOTHING;

  UPDATE public.gweru_rural_farms f
     SET zone_id_legacy   = f.zone_id,
         zone_id          = r.new_zone_id,
         zone_remap_status = CASE WHEN r.new_zone_id IS NULL THEN 'unmapped'
                                  WHEN r.agrees IS FALSE THEN 'remapped_differs_from_location'
                                  ELSE 'remapped' END
    FROM public.farm_zone_remap r
   WHERE r.farm_id = f.id AND f.zone_remap_status IS NULL;

  -- What a person has to look at: the assignments that disagree with where the farm lies, and the unmapped.
  CREATE OR REPLACE VIEW public.farm_zone_remap_review AS
  SELECT r.*, f.name AS farm_name
    FROM public.farm_zone_remap r
    JOIN public.gweru_rural_farms f ON f.id = r.farm_id
   WHERE r.new_zone_id IS NULL OR r.agrees IS NOT TRUE;
END $$;

COMMIT;
