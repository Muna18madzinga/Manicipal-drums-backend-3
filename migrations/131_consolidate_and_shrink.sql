-- Migration 131: consolidate duplicates, remove redundancy, shrink
--
-- Every fact is stored once. This migration is the "subtractive" half of the
-- normalisation that 078/126/127 started additively (they added the canonical
-- column/table next to the old one and never removed the old one).
--
-- NOTE ON THE "ADDITIVE ONLY" RULE (migrations/README.md §3): this migration
-- deliberately drops objects. Everything dropped is either (a) never read or
-- written by application code, or (b) a copy whose data is first merged into
-- the canonical object below. Take a pg_dump before applying to a database
-- that holds real data (npm run backup).
--
-- 1. Dead tables (no code path reads or writes them)
--      audit_logs, style_templates, validation_rules, user_sessions,
--      spatial_planning.spatial_analysis_result, spatial_planning.statutory_clock_event,
--      survey.migrations_history, survey.workflow_states
--    and the 1:1 copy public.user_profiles (126 copied users.full_name/phone/
--    job_title/department into it; the app never used it).
-- 2. users — one column per fact:
--      name        -> dropped, full_name is canonical (NOT NULL)
--      last_login  -> dropped, last_login_at is canonical
--      active      -> dropped, derived as (status = 'active')
-- 3. Peri-urban zones — one table (proposed_peri_urban_zones, INTEGER id):
--      vungu_proposed_peri_urban_zones (UUID copy) and gweru_peri_urban_zone
--      (third copy) are merged in and dropped. gweru_peri_urban_zone survives
--      as a zero-storage compatibility VIEW for the QGIS project layer.
--      stands.zone_id and zone_land_use_controls.zone_id become INTEGER FKs.
--      Fixes GET /api/stands/:id (integer = uuid join error) and the zone
--      picker (integer ids written into a uuid column).
--      Adds the missing spatial_change trigger so zone edits reach the live map.
-- 4. stands — drop the duplicate columns 078/127 left behind:
--      status_code (= status), use_scale_code (= use_scale),
--      zone_type_cache (= zone_type, trigger-maintained), zone_id_int (= zone_id),
--      ward_fid (never populated; ward is derived spatially in v_stands).
--      centroid becomes GENERATED ALWAYS AS (ST_PointOnSurface(geom)) — it was
--      never maintained by code, so new stands had NULL centroids.
-- 5. Beyond-peri-urban zones — canonical table beyond_peri_urban_zones
--      (fid, ward_pcode -> wards.pcode, settlement, zone_code, geom).
--      The ward/district/province/country names and COD-AB dates were copies
--      of the admin hierarchy (transitive dependencies); layer/path held a
--      shapefile path from the digitiser's PC. vungu_beyond_peri_urban_zones is
--      now a VIEW deriving the old columns, so tiles and QGIS keep working.
--      The duplicate gweru_beyond_periurban_zones is dropped.
-- 6. Admin hierarchy — UNIQUE pcode on country/provinces/districts/wards and
--      parent_pcode FOREIGN KEYs wards -> districts -> provinces -> country.
-- 7. Imported cadastre layers — numbers stored as text become numbers; the
--      unit-conversion/ArcGIS-derived columns (area_km2, area_acre, area_km,
--      shape_leng, shape_area) are dropped — area_ha is kept as the recorded area.
-- 8. OSM basemap — the numeric Geofabrik `code` is dropped from every row; it
--      lives once in ref.osm_feature_class (migration 130).
-- 9. places gets a primary key; 12 duplicate indexes (a plain index on the
--      same column as a UNIQUE constraint) are dropped.
-- 10. Schema/code drift: created_by added to proposed_peri_urban_zones and
--      zone_land_use_controls, created_by/updated_at/updated_by to
--      land_use_groups (land-use-management-enhanced.js writes them),
--      users.updated_at (auth.js profile/admin edit/suspend wrote it and
--      always failed); identity defaults on surrogate keys that had none
--      (proposed_peri_urban_zones.id — zone creation always failed — and the
--      basemap fid columns, so features can be added from QGIS);
--      proposed_peri_urban_zones.area_ha added as a GENERATED column
--      (zones.js reads it; it only existed on the dropped UUID copy, so
--      GET /api/zones returned 500).
-- 11. spatial_layers catalogue rows pointing at dropped tables are removed.
--
-- Views rebuilt: v_stands, stands_tile_view, gweru_peri_urban_zone,
-- vungu_beyond_peri_urban_zones.
--
-- IDEMPOTENT: every step checks the catalogue first (column type, table
-- existence, constraint name). Dump-only tables (vungu_*, gweru_*, wards …)
-- are skipped when absent. Safe to run twice.
--
-- Depends on: 130 (ref schema), 127 (zone_id_int), 111 (spatial_layers).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Dead tables
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS public.audit_logs;
DROP TABLE IF EXISTS public.style_templates;
DROP TABLE IF EXISTS public.validation_rules;
DROP TABLE IF EXISTS public.user_sessions;
DROP TABLE IF EXISTS public.user_profiles;
DROP TABLE IF EXISTS spatial_planning.spatial_analysis_result;
DROP TABLE IF EXISTS spatial_planning.statutory_clock_event;
DROP TABLE IF EXISTS survey.migrations_history;
DROP TABLE IF EXISTS survey.workflow_states;
DROP FUNCTION IF EXISTS survey.update_workflow_states_updated_at();

-- ---------------------------------------------------------------------------
-- 2. users
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'name') THEN
    UPDATE public.users SET full_name = name
     WHERE (full_name IS NULL OR btrim(full_name) = '') AND name IS NOT NULL;
    ALTER TABLE public.users DROP COLUMN name;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'last_login') THEN
    UPDATE public.users SET last_login_at = GREATEST(last_login_at, last_login)
     WHERE last_login IS NOT NULL;
    ALTER TABLE public.users DROP COLUMN last_login;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'active') THEN
    UPDATE public.users SET status = 'suspended' WHERE active IS FALSE AND status = 'active';
    ALTER TABLE public.users DROP COLUMN active;
  END IF;
END $$;

UPDATE public.users SET full_name = split_part(email, '@', 1) WHERE full_name IS NULL OR btrim(full_name) = '';
UPDATE public.users SET status = 'active' WHERE status IS NULL;
ALTER TABLE public.users ALTER COLUMN full_name SET NOT NULL;
ALTER TABLE public.users ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE public.users ALTER COLUMN status SET NOT NULL;

COMMENT ON COLUMN public.users.full_name IS 'Display name (the only name column; migration 131 removed the duplicate users.name).';
COMMENT ON COLUMN public.users.status IS 'Account status -> ref.user_status. The account can sign in only when status = ''active'' (replaces the old boolean users.active).';

-- ---------------------------------------------------------------------------
-- 3. Peri-urban zones: one table
-- ---------------------------------------------------------------------------
ALTER TABLE public.proposed_peri_urban_zones
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

-- zones.js reads area_ha (it only existed on the UUID copy). Derived from geom,
-- so it is GENERATED: correct on every insert/reshape, never written by code.
ALTER TABLE public.proposed_peri_urban_zones
  ADD COLUMN IF NOT EXISTS area_ha numeric(14,4)
  GENERATED ALWAYS AS (round((ST_Area(geom::geography) / 10000)::numeric, 4)) STORED;
COMMENT ON COLUMN public.proposed_peri_urban_zones.area_ha IS 'Area in hectares, GENERATED from geom (geodesic).';

-- uuid (old copy) -> integer (canonical) mapping, by identical geometry.
CREATE TEMP TABLE zone_map (zone_uuid uuid PRIMARY KEY, zone_id integer NOT NULL) ON COMMIT DROP;

DO $$
BEGIN
  IF to_regclass('public.vungu_proposed_peri_urban_zones') IS NOT NULL THEN
    INSERT INTO zone_map (zone_uuid, zone_id)
    SELECT v.id, min(p.id)
      FROM public.vungu_proposed_peri_urban_zones v
      JOIN public.proposed_peri_urban_zones p
        ON p.geom && v.geom AND ST_Equals(p.geom, v.geom)
     GROUP BY v.id;

    -- carry the attributes only the copy had
    UPDATE public.proposed_peri_urban_zones p SET
      scale_category   = COALESCE(p.scale_category,   v.scale_category),
      authority        = COALESCE(p.authority,        v.authority),
      zone_description = COALESCE(p.zone_description, v.zone_description),
      ward             = COALESCE(p.ward,             v.ward)
      FROM public.vungu_proposed_peri_urban_zones v
     WHERE p.geom && v.geom AND ST_Equals(p.geom, v.geom);
  END IF;
END $$;

-- stands.zone_id uuid -> integer FK
DROP VIEW IF EXISTS public.v_stands;
DROP VIEW IF EXISTS public.stands_tile_view;

DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'stands' AND column_name = 'zone_id') = 'uuid' THEN
    ALTER TABLE public.stands DISABLE TRIGGER USER;
    ALTER TABLE public.stands ADD COLUMN zone_ref integer;
    UPDATE public.stands s SET zone_ref = m.zone_id FROM zone_map m WHERE m.zone_uuid = s.zone_id;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'stands' AND column_name = 'zone_id_int') THEN
      UPDATE public.stands SET zone_ref = COALESCE(zone_id_int, zone_ref);
    END IF;
    ALTER TABLE public.stands ENABLE TRIGGER USER;
    ALTER TABLE public.stands DROP COLUMN zone_id;
    ALTER TABLE public.stands RENAME COLUMN zone_ref TO zone_id;
  END IF;
END $$;

ALTER TABLE public.stands DROP CONSTRAINT IF EXISTS fk_stands_zone_id_int;
DROP INDEX IF EXISTS public.idx_stands_zone_id_int;
ALTER TABLE public.stands DROP COLUMN IF EXISTS zone_id_int;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_stands_zone' AND conrelid = 'public.stands'::regclass) THEN
    ALTER TABLE public.stands ADD CONSTRAINT fk_stands_zone
      FOREIGN KEY (zone_id) REFERENCES public.proposed_peri_urban_zones(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_stands_zone_id ON public.stands (zone_id);
COMMENT ON COLUMN public.stands.zone_id IS 'Planning zone -> proposed_peri_urban_zones.id (INTEGER; was a UUID pointing at a duplicate zones table until 131).';

-- zone_land_use_controls.zone_id uuid -> integer FK
DO $$
DECLARE unmapped integer;
BEGIN
  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'zone_land_use_controls' AND column_name = 'zone_id') = 'uuid' THEN
    SELECT count(*) INTO unmapped
      FROM public.zone_land_use_controls c LEFT JOIN zone_map m ON m.zone_uuid = c.zone_id
     WHERE m.zone_id IS NULL;
    IF unmapped > 0 THEN
      RAISE EXCEPTION '131: % zone_land_use_controls rows reference zones with no canonical match — resolve before migrating', unmapped;
    END IF;
    ALTER TABLE public.zone_land_use_controls DROP CONSTRAINT IF EXISTS zone_land_use_controls_zone_id_fkey;
    ALTER TABLE public.zone_land_use_controls ADD COLUMN zone_ref integer;
    UPDATE public.zone_land_use_controls c SET zone_ref = m.zone_id FROM zone_map m WHERE m.zone_uuid = c.zone_id;
    ALTER TABLE public.zone_land_use_controls DROP COLUMN zone_id;   -- drops the (zone_id, land_use_group_id) UNIQUE too
    ALTER TABLE public.zone_land_use_controls RENAME COLUMN zone_ref TO zone_id;
    ALTER TABLE public.zone_land_use_controls ALTER COLUMN zone_id SET NOT NULL;
    ALTER TABLE public.zone_land_use_controls
      ADD CONSTRAINT zone_land_use_controls_zone_id_fkey
        FOREIGN KEY (zone_id) REFERENCES public.proposed_peri_urban_zones(id) ON DELETE CASCADE,
      ADD CONSTRAINT zone_land_use_controls_zone_id_land_use_group_id_key
        UNIQUE (zone_id, land_use_group_id);
  END IF;
END $$;
ALTER TABLE public.zone_land_use_controls
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

-- land-use-management-enhanced.js writes these audit columns on create/update.
ALTER TABLE public.land_use_groups
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL;

-- auth.js (profile, admin edit/suspend/delete) sets users.updated_at.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Surrogate keys with no default: zones could not be created (zones.js INSERT
-- omits id) and basemap features could not be added from QGIS / the GIS editor.
DO $$
DECLARE
  t text;
  col text;
  nxt bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'proposed_peri_urban_zones:id', 'gweru_health_centres:id',
    'buildings:fid','roads:fid','railways:fid','waterways:fid','water_areas:fid','landuse:fid',
    'natural_areas:fid','natural_points:fid','places_areas:fid','places_points:fid',
    'places_of_worship_areas:fid','places_of_worship_points:fid','pois_areas:fid','pois_points:fid',
    'traffic_areas:fid','traffic_points:fid','transport_areas:fid','transport_points:fid',
    'protected_areas:fid','admin_areas:fid'] LOOP
    col := split_part(t, ':', 2);
    t   := split_part(t, ':', 1);
    CONTINUE WHEN to_regclass(format('public.%I', t)) IS NULL;
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = format('public.%I', t)::regclass AND a.attname = col
         AND (a.attidentity <> '' OR d.oid IS NOT NULL));
    EXECUTE format('SELECT COALESCE(max(%I), 0) + 1 FROM public.%I', col, t) INTO nxt;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I ADD GENERATED BY DEFAULT AS IDENTITY (START WITH %s)', t, col, nxt);
  END LOOP;
END $$;

-- the copies
DROP TABLE IF EXISTS public.vungu_proposed_peri_urban_zones;
DO $$
BEGIN
  -- a TABLE on first run; the compatibility VIEW below on re-runs
  IF (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.gweru_peri_urban_zone')) = 'r' THEN
    DROP TABLE public.gweru_peri_urban_zone;
  END IF;
END $$;

CREATE OR REPLACE VIEW public.gweru_peri_urban_zone AS
SELECT id, zone, zone_code, zone_type, map_color, display_order, is_active, geom
  FROM public.proposed_peri_urban_zones;
COMMENT ON VIEW public.gweru_peri_urban_zone IS
  'Compatibility view for the QGIS project layer of the same name. Storage is proposed_peri_urban_zones (131).';

DROP TRIGGER IF EXISTS trg_notify_spatial_change ON public.proposed_peri_urban_zones;
CREATE TRIGGER trg_notify_spatial_change
  AFTER INSERT OR DELETE OR UPDATE ON public.proposed_peri_urban_zones
  FOR EACH ROW EXECUTE FUNCTION notify_spatial_change();

-- ---------------------------------------------------------------------------
-- 4. stands: drop duplicate columns
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'stands' AND column_name = 'status_code') THEN
    UPDATE public.stands SET status = status_code WHERE status IS NULL;
    ALTER TABLE public.stands DROP COLUMN status_code;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'stands' AND column_name = 'use_scale_code') THEN
    UPDATE public.stands SET use_scale = use_scale_code WHERE use_scale IS NULL;
    ALTER TABLE public.stands DROP COLUMN use_scale_code;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'stands' AND column_name = 'zone_type_cache') THEN
    UPDATE public.stands SET zone_type = zone_type_cache WHERE zone_type IS NULL;
    ALTER TABLE public.stands DROP COLUMN zone_type_cache;
  END IF;
  -- centroid: stored but never maintained -> generated from geom
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'stands' AND column_name = 'centroid'
                AND is_generated = 'NEVER') THEN
    ALTER TABLE public.stands DROP COLUMN centroid;
    ALTER TABLE public.stands ADD COLUMN centroid geometry(Point, 4326)
      GENERATED ALWAYS AS (ST_PointOnSurface(geom)) STORED;
  END IF;
END $$;
DROP TRIGGER IF EXISTS trg_sync_zone_type_cache ON public.stands;
DROP FUNCTION IF EXISTS fn_sync_zone_type_cache();
ALTER TABLE public.stands DROP COLUMN IF EXISTS ward_fid;

COMMENT ON COLUMN public.stands.centroid IS 'Label point, GENERATED from geom (ST_PointOnSurface) — never written by the application.';

-- Read model: ward and zone resolved by relationship, not by copied columns.
-- The ward lookup needs the (dump-only) wards table; without it the columns are NULL.
DO $$
DECLARE
  ward_join text := CASE WHEN to_regclass('public.wards') IS NOT NULL THEN
    'LEFT JOIN LATERAL (
       SELECT wd.pcode, wd.name_en FROM public.wards wd
        WHERE wd.geom && s.centroid AND ST_Contains(wd.geom, s.centroid)
        LIMIT 1) w ON true'
  ELSE
    'LEFT JOIN (SELECT NULL::varchar AS pcode, NULL::varchar AS name_en) w ON true'
  END;
BEGIN
  EXECUTE format($v$
    CREATE VIEW public.v_stands AS
    SELECT s.id, s.stand_number, s.ward,
           w.pcode   AS ward_pcode,
           w.name_en AS ward_name,
           s.zone_id,
           z.zone    AS zone_name,
           z.zone_code,
           s.zone_type, s.use_scale, s.area_sqm, s.frontage_m, s.depth_m, s.price_usd,
           s.status, s.description, s.geom, s.centroid,
           s.reserved_by, s.reserved_at, s.reserved_until,
           s.allocated_to, s.allocated_at, s.statutory_plan_id,
           s.created_by, s.created_at, s.updated_at
      FROM public.stands s
      LEFT JOIN public.proposed_peri_urban_zones z ON z.id = s.zone_id
      %s$v$, ward_join);
END $$;
COMMENT ON VIEW public.v_stands IS
  'Stands with zone (FK) and ward (spatial containment of the label point) resolved.';

CREATE VIEW public.stands_tile_view AS
SELECT row_number() OVER (ORDER BY created_at, id)::integer AS fid,
       id::text AS stand_id,
       stand_number, ward, zone_type, use_scale, status,
       COALESCE(round(area_sqm)::integer, 0)           AS area_sqm_int,
       COALESCE(round(price_usd * 100)::integer, 0)    AS price_usd_cents,
       geom
  FROM public.stands
 WHERE status <> 'withdrawn';
COMMENT ON VIEW public.stands_tile_view IS 'Vector-tile source for the stands layer (integer fid for MVT feature ids).';

-- ---------------------------------------------------------------------------
-- 6 (before 5). Admin hierarchy keys
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['country', 'provinces', 'districts', 'wards'] LOOP
    CONTINUE WHEN to_regclass(format('public.%I', t)) IS NULL;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_pcode_key') THEN
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (pcode)', t, t || '_pcode_key');
    END IF;
  END LOOP;

  IF to_regclass('public.provinces') IS NOT NULL AND to_regclass('public.country') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_provinces_country') THEN
    ALTER TABLE public.provinces ADD CONSTRAINT fk_provinces_country
      FOREIGN KEY (parent_pcode) REFERENCES public.country(pcode);
  END IF;
  IF to_regclass('public.districts') IS NOT NULL AND to_regclass('public.provinces') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_districts_province') THEN
    ALTER TABLE public.districts ADD CONSTRAINT fk_districts_province
      FOREIGN KEY (parent_pcode) REFERENCES public.provinces(pcode);
  END IF;
  IF to_regclass('public.wards') IS NOT NULL AND to_regclass('public.districts') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_wards_district') THEN
    ALTER TABLE public.wards ADD CONSTRAINT fk_wards_district
      FOREIGN KEY (parent_pcode) REFERENCES public.districts(pcode);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Beyond-peri-urban zones
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.beyond_peri_urban_zones') IS NULL
     AND (SELECT relkind FROM pg_class WHERE oid = to_regclass('public.vungu_beyond_peri_urban_zones')) = 'r' THEN
    ALTER TABLE public.vungu_beyond_peri_urban_zones RENAME TO beyond_peri_urban_zones;
    ALTER TABLE public.beyond_peri_urban_zones RENAME COLUMN adm3_pcode TO ward_pcode;
    ALTER TABLE public.beyond_peri_urban_zones
      DROP COLUMN shape_leng, DROP COLUMN shape_area,
      DROP COLUMN adm3_en, DROP COLUMN adm3_ref, DROP COLUMN adm3alt1en, DROP COLUMN adm3alt2en,
      DROP COLUMN adm2_en, DROP COLUMN adm2_pcode, DROP COLUMN adm1_en, DROP COLUMN adm1_pcode,
      DROP COLUMN adm0_en, DROP COLUMN adm0_pcode,
      DROP COLUMN date, DROP COLUMN validon, DROP COLUMN validto, DROP COLUMN prov_id,
      DROP COLUMN layer, DROP COLUMN path;
    ALTER TABLE public.beyond_peri_urban_zones
      ALTER COLUMN ward_pcode TYPE varchar(20),
      ALTER COLUMN settlement TYPE varchar(60),
      ALTER COLUMN zone_code  TYPE varchar(20);
    IF to_regclass('public.wards') IS NOT NULL THEN
      ALTER TABLE public.beyond_peri_urban_zones ADD CONSTRAINT fk_beyond_zones_ward
        FOREIGN KEY (ward_pcode) REFERENCES public.wards(pcode);
    END IF;
  END IF;

  IF to_regclass('public.beyond_peri_urban_zones') IS NOT NULL THEN
    CREATE OR REPLACE VIEW public.vungu_beyond_peri_urban_zones AS
    SELECT b.fid, b.zone_code, b.settlement,
           w.name_en AS adm3_en, b.ward_pcode AS adm3_pcode,
           d.name_en AS adm2_en, d.pcode      AS adm2_pcode,
           p.name_en AS adm1_en, p.pcode      AS adm1_pcode,
           b.geom
      FROM public.beyond_peri_urban_zones b
      LEFT JOIN public.wards     w ON w.pcode = b.ward_pcode
      LEFT JOIN public.districts d ON d.pcode = w.parent_pcode
      LEFT JOIN public.provinces p ON p.pcode = d.parent_pcode;
    COMMENT ON VIEW public.vungu_beyond_peri_urban_zones IS
      'Tile/QGIS source for beyond-peri-urban zones: admin names derived from the ward hierarchy. Storage: beyond_peri_urban_zones.';
  END IF;
END $$;
DROP TABLE IF EXISTS public.gweru_beyond_periurban_zones;

-- ---------------------------------------------------------------------------
-- 7. Imported cadastre layers: typed columns, no derived columns
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['vungu_farm_cadastre', 'vungu_parcels'] LOOP
    CONTINUE WHEN to_regclass(format('public.%I', t)) IS NULL;
    IF (SELECT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = t AND column_name = 'area_ha') = 'text' THEN
      EXECUTE format($f$
        ALTER TABLE public.%I
          ALTER COLUMN objectid TYPE integer       USING NULLIF(btrim(objectid), '')::integer,
          ALTER COLUMN area_ha  TYPE numeric(14,3) USING NULLIF(btrim(area_ha), '')::numeric,
          DROP COLUMN IF EXISTS area_km2, DROP COLUMN IF EXISTS area_acre,
          DROP COLUMN IF EXISTS area_km,  DROP COLUMN IF EXISTS shape_leng,
          DROP COLUMN IF EXISTS shape_area$f$, t);
    END IF;
  END LOOP;

  IF (SELECT data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'vungu_parcels' AND column_name = 'gid') = 'text' THEN
    ALTER TABLE public.vungu_parcels ALTER COLUMN gid TYPE integer USING NULLIF(btrim(gid), '')::integer;
  END IF;

  IF to_regclass('public.gweru_rural_farms') IS NOT NULL THEN
    ALTER TABLE public.gweru_rural_farms
      DROP COLUMN IF EXISTS area_km2, DROP COLUMN IF EXISTS area_acre,
      DROP COLUMN IF EXISTS area_km,  DROP COLUMN IF EXISTS shape_leng,
      DROP COLUMN IF EXISTS shape_area, DROP COLUMN IF EXISTS area_hectares;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 8. OSM basemap: numeric code lives in ref.osm_feature_class
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'buildings','roads','railways','waterways','water_areas','landuse','natural_areas',
    'natural_points','places_areas','places_points','places_of_worship_areas',
    'places_of_worship_points','pois_areas','pois_points','traffic_areas','traffic_points',
    'transport_areas','transport_points','protected_areas','admin_areas'] LOOP
    CONTINUE WHEN to_regclass(format('public.%I', t)) IS NULL;
    IF to_regclass('ref.osm_feature_class') IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS code', t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 9. places primary key; duplicate indexes
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.places') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.places'::regclass AND contype = 'p') THEN
    UPDATE public.places SET id = gen_random_uuid() WHERE id IS NULL;
    ALTER TABLE public.places ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE public.places ALTER COLUMN id SET NOT NULL;
    ALTER TABLE public.places ADD CONSTRAINT places_pkey PRIMARY KEY (id);
  END IF;
END $$;

-- Each duplicates the index behind a UNIQUE constraint on the same column(s).
DROP INDEX IF EXISTS public.idx_admin_users_email;
DROP INDEX IF EXISTS public.idx_users_email;
DROP INDEX IF EXISTS public.idx_invites_token;
DROP INDEX IF EXISTS spatial_planning.idx_permit_app_tpd;
DROP INDEX IF EXISTS spatial_planning.idx_property_stand;
DROP INDEX IF EXISTS spatial_planning.idx_public_notice_permit;
DROP INDEX IF EXISTS spatial_planning.planning_revision_project_idx;
DROP INDEX IF EXISTS survey.idx_surveyor_profiles_user_id;
DROP INDEX IF EXISTS survey.idx_surveyor_profiles_license;
DROP INDEX IF EXISTS survey.idx_users_email;
DROP INDEX IF EXISTS survey.idx_control_points_monu_num;
DROP INDEX IF EXISTS survey.idx_surveyors_license;

-- ---------------------------------------------------------------------------
-- 11. spatial_layers catalogue
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.spatial_layers') IS NOT NULL THEN
    DELETE FROM public.spatial_layers
     WHERE table_name IN ('gweru_beyond_periurban_zones', 'v_stands', 'stands_tile_view');
    UPDATE public.spatial_layers
       SET table_name = 'proposed_peri_urban_zones', display_name = 'Proposed Peri-Urban Zones'
     WHERE table_name = 'vungu_proposed_peri_urban_zones'
       AND NOT EXISTS (SELECT 1 FROM public.spatial_layers WHERE table_name = 'proposed_peri_urban_zones');
    DELETE FROM public.spatial_layers WHERE table_name = 'vungu_proposed_peri_urban_zones';
  END IF;
END $$;

COMMIT;
