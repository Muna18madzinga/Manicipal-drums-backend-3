-- 118_inspector_site_geometry.sql
-- Building Inspector GIS (docs: frontend docs/superpowers/specs/2026-09-13-inspector-gis-design.md)
--
-- 1. Provenance for permit_application.location. An inspector may record the
--    site position from a GPS fix at the pegs or a map pick; the record must say
--    which, how accurate, who and when. Without this a corrected position is
--    indistinguishable from the one captured at intake.
-- 2. Server-computed geofence on the arrival field event, frozen at write time so
--    a later site correction does not rewrite attendance history.
-- 3. Normalised name indexes for site resolution (stand number -> polygon).

BEGIN;

-- ── 1. Site position provenance ─────────────────────────────────────
ALTER TABLE spatial_planning.permit_application
  ADD COLUMN IF NOT EXISTS location_source     VARCHAR(20),
  ADD COLUMN IF NOT EXISTS location_accuracy_m NUMERIC(8, 2),
  ADD COLUMN IF NOT EXISTS location_set_by     UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_set_at     TIMESTAMP WITH TIME ZONE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'permit_application_location_source_check'
       AND conrelid = 'spatial_planning.permit_application'::regclass
  ) THEN
    ALTER TABLE spatial_planning.permit_application
      ADD CONSTRAINT permit_application_location_source_check
      CHECK (location_source IS NULL
             OR location_source IN ('intake', 'case_file', 'field_gps', 'map_pick'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'permit_application_location_accuracy_check'
       AND conrelid = 'spatial_planning.permit_application'::regclass
  ) THEN
    ALTER TABLE spatial_planning.permit_application
      ADD CONSTRAINT permit_application_location_accuracy_check
      CHECK (location_accuracy_m IS NULL OR location_accuracy_m >= 0);
  END IF;
END $$;

-- Positions that predate provenance came in with the application.
UPDATE spatial_planning.permit_application
   SET location_source = 'intake'
 WHERE location IS NOT NULL AND location_source IS NULL;

-- ── 2. Geofence on field events ─────────────────────────────────────
ALTER TABLE spatial_planning.stage_inspection_field_event
  ADD COLUMN IF NOT EXISTS site_distance_m NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS geofence_result VARCHAR(16),
  ADD COLUMN IF NOT EXISTS site_precision  VARCHAR(16);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'stage_inspection_field_event_geofence_check'
       AND conrelid = 'spatial_planning.stage_inspection_field_event'::regclass
  ) THEN
    ALTER TABLE spatial_planning.stage_inspection_field_event
      ADD CONSTRAINT stage_inspection_field_event_geofence_check
      CHECK (geofence_result IS NULL OR geofence_result IN ('on_site', 'off_site', 'unverifiable'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'stage_inspection_field_event_precision_check'
       AND conrelid = 'spatial_planning.stage_inspection_field_event'::regclass
  ) THEN
    ALTER TABLE spatial_planning.stage_inspection_field_event
      ADD CONSTRAINT stage_inspection_field_event_precision_check
      CHECK (site_precision IS NULL OR site_precision IN ('boundary', 'point', 'area', 'none'));
  END IF;
END $$;

-- ── 3. Site resolution indexes ──────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_stands_stand_number_norm
  ON public.stands (upper(btrim(stand_number)));

-- vungu_parcels is loaded from the council GeoPackage, not by a migration, so it
-- may be absent on a fresh database.
DO $$
BEGIN
  IF to_regclass('public.vungu_parcels') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_vungu_parcels_name_norm
               ON public.vungu_parcels (upper(btrim(COALESCE(NULLIF(name, ''''), name_cfu))))';
  END IF;
END $$;

COMMIT;
