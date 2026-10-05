-- Migration 135: restore area_ha on the canonical zones table
--
-- src/routes/zones.js has referenced `area_ha` on `proposed_peri_urban_zones`
-- since migration 113 repointed it at the canonical table, but that column
-- never existed there -- it lived only on the superseded
-- `vungu_proposed_peri_urban_zones` copy, as shapefile-derived text. Four
-- separate sites in zones.js referenced it, so every route in the file returned
-- 500:
--
--   line  50  GET  /zones                SELECT z.area_ha
--   line  89  GET  /zones/:id            SELECT z.area_ha
--   line 141  POST /zones                INSERT ... area_ha ...
--   line 187  PUT  /zones/:id            SET area_ha = ...
--
-- The two reads were masked by the fact that nobody had called them since 113;
-- the two writes mean zone creation and editing through the API have been dead
-- too. That also made the migration-134 FK fix unobservable, because a client
-- cannot pick a zone id from an endpoint that 500s.
--
-- The column is GENERATED rather than written by hand, deliberately. The
-- existing hand-written site (line 187) computed it from the submitted geometry
-- in application SQL, which is precisely the pattern that goes stale the moment
-- the geometry is edited anywhere else -- and for this table "anywhere else" is a
-- planner dragging a vertex in QGIS Desktop. A STORED generated column is
-- recomputed by Postgres on every insert and on every update that touches geom,
-- whoever issued it, so the two paths cannot disagree.
--
-- double precision rather than numeric on purpose: node-postgres returns
-- `numeric` as a JS string, and the frontend expects a number
-- (views/__tests__/EOPlannerView.identify.spec.ts asserts `areaHa: 41.1`).
--
-- Idempotent: safe to re-run.
-- Apply locally with: node scripts/apply-local-migration.js 135_zones_area_ha.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'public.proposed_peri_urban_zones'::regclass
       AND attname = 'area_ha'
       AND NOT attisdropped
  ) THEN
    ALTER TABLE public.proposed_peri_urban_zones
      ADD COLUMN area_ha double precision
        GENERATED ALWAYS AS (
          round((ST_Area(geom::geography) / 10000.0)::numeric, 4)::double precision
        ) STORED;

    COMMENT ON COLUMN public.proposed_peri_urban_zones.area_ha IS
      'Zone area in hectares, generated from geom. Self-maintaining: recomputed by Postgres on any geometry change, including edits made directly in QGIS Desktop.';
  END IF;
END;
$$;

-- zones_master is what the map and QGIS read; exposing area_ha there keeps the
-- single source of truth single. CREATE OR REPLACE VIEW rather than DROP/CREATE,
-- so the view's grants and dependents survive.
--
-- area_ha goes LAST, not next to its siblings: CREATE OR REPLACE VIEW can only
-- append columns, never insert one partway down the list. Adding it before geom
-- fails with `cannot change name of view column "geom" to "area_ha"` -- Postgres
-- reads the extra expression as a rename of the existing column.
CREATE OR REPLACE VIEW public.zones_master AS
  SELECT id,
         zone,
         zone_code,
         is_active,
         display_order,
         geom,
         area_ha
    FROM proposed_peri_urban_zones;

COMMIT;
