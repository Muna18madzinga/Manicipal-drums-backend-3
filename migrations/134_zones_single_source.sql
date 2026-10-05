-- Migration 134: make the peri-urban zones table genuinely single-sourced
--
-- docs/SSOT-spatial.md has claimed since 2026-07-23 that
-- `vungu_proposed_peri_urban_zones` was dropped after all consumers were
-- repointed. The 2026-10-02 database recovery restored it from a dump --
-- together with the one foreign key that still pointed at it. Two live defects
-- followed, both invisible until GET /api/qgis/sync/coverage was asked to
-- explain a `shadowed` relation:
--
--   1. WRONG FK TARGET. zone_land_use_controls.zone_id was uuid, bound to the
--      superseded June shapefile copy. Every consumer passes
--      proposed_peri_urban_zones.id, which is integer, so both land-use-control
--      paths raised `invalid input syntax for type uuid` and returned 500:
--        - POST /planning-assistant/decide   (loadZoneByPoint returns int id)
--        - POST /zones/:id/controls          (:id path parameter is an int)
--      This is the same defect class as the missing spatial-notify triggers and
--      the mis-mapped base table: a stale second reference to a superseded copy.
--
--   2. SILENTLY DISCARDED EDITS. The duplicate carried a live
--      trg_notify_spatial_change. An edit to it announced the zones layer, the
--      backend invalidated the tile cache and pushed SSE, the browser re-rendered
--      tiles served from zones_master -- and the edit never appeared, because
--      nothing serves that table. The authoring tool reported success.
--
-- The two tables hold the same 36 zones and the same 34 distinct geometries, but
-- the copy is not equivalent: its zone_code is NULL on all 36 rows while the
-- canonical table is populated (Z31, Z32, ...). It is the weaker of the two.
--
-- This migration makes the schema match what the docs already described: the FK
-- targets the canonical table, and the superseded copy is gone.
--
-- Idempotent: safe to re-run.
-- Apply locally with: node scripts/apply-local-migration.js 134_zones_single_source.sql

BEGIN;

-- ── 1. Retype and retarget the land-use control FK ────────────────────────
--
-- Safe to retype because zone_land_use_controls is empty (and has no rows in
-- any recoverable dump either). The USING clause is deliberately strict: on a
-- table that did hold rows it fails loudly on any non-numeric id rather than
-- silently nulling them out.

ALTER TABLE public.zone_land_use_controls
  DROP CONSTRAINT IF EXISTS zone_land_use_controls_zone_id_fkey;

ALTER TABLE public.zone_land_use_controls
  ALTER COLUMN zone_id TYPE integer
  USING NULLIF(zone_id::text, '')::integer;

ALTER TABLE public.zone_land_use_controls
  ADD CONSTRAINT zone_land_use_controls_zone_id_fkey
  FOREIGN KEY (zone_id) REFERENCES public.proposed_peri_urban_zones(id)
  ON DELETE CASCADE;

COMMENT ON CONSTRAINT zone_land_use_controls_zone_id_fkey ON public.zone_land_use_controls IS
  'Targets the canonical zones table (SSOT-spatial.md). Was bound to the superseded copy vungu_proposed_peri_urban_zones, which made every land-use-control query raise an integer-vs-uuid type error.';

-- ── 2. Drop the superseded copy ───────────────────────────────────────────
--
-- No CASCADE on purpose. The only dependant was the constraint dropped above;
-- if anything else has since taken a dependency, this must abort and be looked
-- at rather than silently cascade the loss.

DROP TABLE IF EXISTS public.vungu_proposed_peri_urban_zones;

-- ── 3. Maintain updated_at on the canonical table ─────────────────────────
--
-- Everywhere else in this schema, application queries maintain updated_at by
-- hand (`SET updated_at = NOW()`) -- see src/routes/zones.js:171 and :214, which
-- then hand the value to clients as `updatedAt` (zones.js:72). That convention
-- cannot hold for the peri-urban zones table, because the whole point of the
-- QGIS <-> web live-sync pipeline is that a planner edits the PostGIS layer
-- directly from QGIS Desktop. QGIS issues plain UPDATEs and touches nothing, so
-- the column silently went stale on exactly the edits that matter most.
--
-- This is the one table where a trigger is the answer rather than a deviation
-- from the house convention. It is deliberately not generalised to every table
-- with an updated_at column.

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.touch_updated_at() IS
  'BEFORE UPDATE trigger: stamp NEW.updated_at = now(). Used for QGIS-authored tables, where no application statement maintains updated_at.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.proposed_peri_urban_zones'::regclass
       AND tgname = 'trg_touch_updated_at'
       AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_touch_updated_at
      BEFORE UPDATE ON public.proposed_peri_urban_zones
      FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
  END IF;
END;
$$;

COMMIT;
