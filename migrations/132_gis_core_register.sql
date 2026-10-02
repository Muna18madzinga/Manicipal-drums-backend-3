-- 132_gis_core_register.sql
-- ─────────────────────────────────────────────────────────────────────────
-- GIS Management System, phase 1: the core register and the ERP link.
--
--   * the nine GIS Branch roles on public.users
--   * the Lo belt CRS registry (Gauss Conform on Arc 1950) + spatial_ref_sys
--   * admin.ward / admin.village
--   * land.parcel (survey-CRS source geometry + derived WGS84), lineage,
--     buildings and the general-plan import log
--   * revenue_link: parcel <-> ERP account keys and status bands (no amounts)
--   * integration: transactional outbox, inbound log, reconciliation queue
--   * public.admin_audit_event made append-only for seven years
--
-- The audit trail is the existing public.admin_audit_event (migration 127),
-- not a new audit schema: one trail, one reader.
--
-- Idempotent. Apply individually:
--   node scripts/apply-local-migration.js 132_gis_core_register.sql
-- ─────────────────────────────────────────────────────────────────────────

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1. ROLES
-- ═══════════════════════════════════════════════════════════════════════
-- gis_officer stays: existing accounts keep working and are treated as
-- gis_head by src/services/gms/roles.js until the IT admin re-grades them.
DO $$
DECLARE n text;
BEGIN
  FOR n IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.users'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%gis_officer%'
  LOOP
    EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I', n);
  END LOOP;
END $$;

ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (role IN (
  'public', 'registered', 'viewer', 'admin', 'planner', 'eo', 'env_officer',
  'building_inspector', 'planning_clerk', 'surveyor', 'gis_officer',
  'gis_head', 'gis_data', 'gis_dev', 'gis_analyst', 'gis_tech', 'gis_clerk',
  'dept_editor', 'dept_viewer'
));

-- ═══════════════════════════════════════════════════════════════════════
-- 2. CRS REGISTRY
-- ═══════════════════════════════════════════════════════════════════════
-- Zimbabwe survey coordinates are Gauss Conform "Lo" belts on the Arc 1950
-- datum (Clarke 1880 Arc ellipsoid). Y is positive WEST of the central
-- meridian and X positive SOUTH of the equator (axis=wsu), no false origin.
-- PostGIS stores them as POINT(Y X).
--
-- The towgs84 shift is the published 3-parameter Arc 1950 (Zimbabwe) set,
-- good to about 5 m. When the council adopts a better local transformation,
-- change proj4text and accuracy_m here; every transformed parcel records the
-- method and accuracy it was transformed with.
--
-- Custom SRIDs live in spatial_ref_sys, which a data-only restore that skips
-- that table silently drops (see docs/db-rebuild-2026-09-21.md). Re-running
-- this migration puts them back.
CREATE SCHEMA IF NOT EXISTS gis_ops;

CREATE TABLE IF NOT EXISTS gis_ops.crs_registry (
  srid              integer PRIMARY KEY,
  code              varchar(24) NOT NULL UNIQUE,
  name              text        NOT NULL,
  datum             text        NOT NULL,
  proj4text         text        NOT NULL,
  is_survey         boolean     NOT NULL DEFAULT false,
  transform_method  text,
  accuracy_m        numeric,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO gis_ops.crs_registry (srid, code, name, datum, proj4text, is_survey, transform_method, accuracy_m) VALUES
  (922027, 'Lo27', 'Gauss Conform Lo27', 'Arc 1950',
   '+proj=tmerc +lat_0=0 +lon_0=27 +k=1 +x_0=0 +y_0=0 +axis=wsu +a=6378249.145 +rf=293.466307656 +towgs84=-142,-96,-293,0,0,0,0 +units=m +no_defs',
   true, 'Arc 1950 -> WGS 84, 3-parameter geocentric (-142,-96,-293)', 5),
  (922029, 'Lo29', 'Gauss Conform Lo29', 'Arc 1950',
   '+proj=tmerc +lat_0=0 +lon_0=29 +k=1 +x_0=0 +y_0=0 +axis=wsu +a=6378249.145 +rf=293.466307656 +towgs84=-142,-96,-293,0,0,0,0 +units=m +no_defs',
   true, 'Arc 1950 -> WGS 84, 3-parameter geocentric (-142,-96,-293)', 5),
  (922031, 'Lo31', 'Gauss Conform Lo31', 'Arc 1950',
   '+proj=tmerc +lat_0=0 +lon_0=31 +k=1 +x_0=0 +y_0=0 +axis=wsu +a=6378249.145 +rf=293.466307656 +towgs84=-142,-96,-293,0,0,0,0 +units=m +no_defs',
   true, 'Arc 1950 -> WGS 84, 3-parameter geocentric (-142,-96,-293)', 5),
  (922033, 'Lo33', 'Gauss Conform Lo33', 'Arc 1950',
   '+proj=tmerc +lat_0=0 +lon_0=33 +k=1 +x_0=0 +y_0=0 +axis=wsu +a=6378249.145 +rf=293.466307656 +towgs84=-142,-96,-293,0,0,0,0 +units=m +no_defs',
   true, 'Arc 1950 -> WGS 84, 3-parameter geocentric (-142,-96,-293)', 5),
  (4326,  'WGS84',   'WGS 84 geographic', 'WGS 84',
   '+proj=longlat +datum=WGS84 +no_defs', false, NULL, 0),
  (32735, 'UTM35S',  'WGS 84 / UTM zone 35S', 'WGS 84',
   '+proj=utm +zone=35 +south +datum=WGS84 +units=m +no_defs', false, NULL, 0),
  (32736, 'UTM36S',  'WGS 84 / UTM zone 36S', 'WGS 84',
   '+proj=utm +zone=36 +south +datum=WGS84 +units=m +no_defs', false, NULL, 0)
ON CONFLICT (srid) DO NOTHING;

INSERT INTO public.spatial_ref_sys (srid, auth_name, auth_srid, proj4text, srtext)
SELECT srid, 'VUNGU', srid, proj4text, ''
  FROM gis_ops.crs_registry WHERE is_survey
ON CONFLICT (srid) DO UPDATE SET proj4text = EXCLUDED.proj4text;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. ADMINISTRATIVE UNITS
-- ═══════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS admin;

CREATE TABLE IF NOT EXISTS admin.ward (
  ward_code  varchar(24) PRIMARY KEY,
  name       text        NOT NULL,
  source     text        NOT NULL,
  geom       geometry(MultiPolygon, 4326)
);
CREATE INDEX IF NOT EXISTS idx_admin_ward_geom ON admin.ward USING gist (geom);

CREATE TABLE IF NOT EXISTS admin.village (
  village_id varchar(24) PRIMARY KEY,
  name       text        NOT NULL,
  headman    text,
  ward_code  varchar(24) NOT NULL REFERENCES admin.ward(ward_code),
  geom       geometry(Point, 4326)
);

-- ═══════════════════════════════════════════════════════════════════════
-- 4. LAND
-- ═══════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS land;

CREATE SEQUENCE IF NOT EXISTS land.parcel_id_seq;

-- A general plan or diagram imported from the Survey Section. The only door
-- through which a parcel boundary enters or changes.
CREATE TABLE IF NOT EXISTS land.general_plan (
  import_id      bigserial   PRIMARY KEY,
  sg_ref         text        NOT NULL,
  township_code  varchar(40) NOT NULL,
  source_srid    integer     NOT NULL REFERENCES gis_ops.crs_registry(srid),
  feature_count  integer     NOT NULL,
  imported_by    uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  imported_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS land.parcel (
  -- Never reused: sequence-issued, never deleted (trigger below), retired
  -- parcels keep their row.
  parcel_id            varchar(24) PRIMARY KEY
                       DEFAULT 'P-' || lpad(nextval('land.parcel_id_seq')::text, 7, '0'),
  stand_no             varchar(24) NOT NULL,
  township_code        varchar(40) NOT NULL,
  ward_code            varchar(24) REFERENCES admin.ward(ward_code),

  -- Exactly as supplied, in the supplied CRS. Never overwritten.
  geom_source          geometry    NOT NULL,
  source_srid          integer     NOT NULL REFERENCES gis_ops.crs_registry(srid),
  geom_wgs84           geometry(MultiPolygon, 4326) NOT NULL,
  transform_method     text,
  transform_accuracy_m numeric,

  area_m2              numeric     NOT NULL CHECK (area_m2 > 0),
  sg_ref               text,
  general_plan_id      bigint      REFERENCES land.general_plan(import_id),

  accuracy_class       char(1)     NOT NULL CHECK (accuracy_class IN ('A', 'B', 'C', 'D')),
  source               text        NOT NULL,
  custodian_dept       text        NOT NULL DEFAULT 'Survey Section',

  -- current: the live register. legacy: carried over from older records,
  -- unverified, not covered by stand-number uniqueness (the reconciliation
  -- queue is where legacy duplicates surface). retired: superseded.
  status               varchar(12) NOT NULL DEFAULT 'current'
                       CHECK (status IN ('current', 'legacy', 'retired')),
  allocation_status    varchar(12) NOT NULL DEFAULT 'unallocated'
                       CHECK (allocation_status IN ('unallocated', 'allocated')),
  valid_from           date        NOT NULL DEFAULT CURRENT_DATE,
  valid_to             date,
  created_by           uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT parcel_source_srid_matches CHECK (ST_SRID(geom_source) = source_srid),
  CONSTRAINT parcel_source_is_polygon CHECK (GeometryType(geom_source) IN ('POLYGON', 'MULTIPOLYGON'))
);

-- Business rule 4: a stand number is unique within its township.
CREATE UNIQUE INDEX IF NOT EXISTS uq_parcel_stand_current
  ON land.parcel (township_code, stand_no) WHERE status = 'current';
CREATE INDEX IF NOT EXISTS idx_parcel_geom_wgs84 ON land.parcel USING gist (geom_wgs84);
CREATE INDEX IF NOT EXISTS idx_parcel_stand ON land.parcel (stand_no);
CREATE INDEX IF NOT EXISTS idx_parcel_ward ON land.parcel (ward_code);

-- Business rules 1 and 4, enforced below the API so no route can get them
-- wrong. The survey importer opens the door with SET LOCAL gms.survey_import;
-- gms.purge exists only to remove fictional sample and test townships.
CREATE OR REPLACE FUNCTION land.parcel_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('gms.purge', true), '') = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'parcel % cannot be deleted: parcel IDs are never reused; retire it instead', OLD.parcel_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.geom_source IS DISTINCT FROM OLD.geom_source
      OR NEW.geom_wgs84 IS DISTINCT FROM OLD.geom_wgs84
      OR NEW.parcel_id IS DISTINCT FROM OLD.parcel_id)
     AND coalesce(current_setting('gms.survey_import', true), '') <> 'on' THEN
    RAISE EXCEPTION 'parcel boundaries change only through an approved Survey Section import'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_parcel_guard ON land.parcel;
CREATE TRIGGER trg_parcel_guard BEFORE UPDATE OR DELETE ON land.parcel
  FOR EACH ROW EXECUTE FUNCTION land.parcel_guard();

CREATE TABLE IF NOT EXISTS land.parcel_lineage (
  parent_id   varchar(24) NOT NULL REFERENCES land.parcel(parcel_id),
  child_id    varchar(24) NOT NULL REFERENCES land.parcel(parcel_id),
  event       varchar(16) NOT NULL CHECK (event IN ('subdivision', 'consolidation')),
  event_date  date        NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (parent_id, child_id)
);

CREATE SEQUENCE IF NOT EXISTS land.building_id_seq;
CREATE TABLE IF NOT EXISTS land.building (
  building_id      varchar(24) PRIMARY KEY
                   DEFAULT 'B-' || lpad(nextval('land.building_id_seq')::text, 7, '0'),
  parcel_id        varchar(24) REFERENCES land.parcel(parcel_id),
  use              text,
  storeys          smallint,
  completion_date  date,
  source           text        NOT NULL,
  accuracy_class   char(1)     NOT NULL CHECK (accuracy_class IN ('A', 'B', 'C', 'D')),
  geom             geometry(Point, 4326)
);
CREATE INDEX IF NOT EXISTS idx_building_parcel ON land.building (parcel_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 5. REVENUE LINK (keys and status bands only; money stays in the ERP)
-- ═══════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS revenue_link;

CREATE TABLE IF NOT EXISTS revenue_link.account_link (
  parcel_id       varchar(24) NOT NULL REFERENCES land.parcel(parcel_id),
  erp_account_no  varchar(40) NOT NULL,
  link_type       varchar(24) NOT NULL DEFAULT 'rates',
  linked_on       date        NOT NULL DEFAULT CURRENT_DATE,
  verified_by     text,
  PRIMARY KEY (parcel_id, erp_account_no)
);
CREATE INDEX IF NOT EXISTS idx_account_link_account ON revenue_link.account_link (erp_account_no);

-- Every ERP account the GMS has heard of, with its band. No amounts, ever.
CREATE TABLE IF NOT EXISTS revenue_link.billing_status (
  erp_account_no  varchar(40) PRIMARY KEY,
  status_band     varchar(16) NOT NULL CHECK (status_band IN ('current', 'in_arrears', 'closed')),
  as_at           timestamptz NOT NULL
);

-- ═══════════════════════════════════════════════════════════════════════
-- 6. INTEGRATION
-- ═══════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS integration;

CREATE TABLE IF NOT EXISTS integration.outbox_event (
  event_id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  type             varchar(48) NOT NULL,
  version          smallint    NOT NULL DEFAULT 1,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  source           varchar(40) NOT NULL DEFAULT 'vungu-gms',
  idempotency_key  text        NOT NULL UNIQUE,
  payload          jsonb       NOT NULL,
  -- sent = handed to an asynchronous channel (file exchange) and awaiting an
  -- acknowledgement; the HTTP adapter goes straight to acknowledged.
  status           varchar(16) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'sent', 'acknowledged', 'failed', 'cancelled')),
  attempts         smallint    NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  reply            jsonb,
  acknowledged_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON integration.outbox_event (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_status ON integration.outbox_event (status, occurred_at DESC);

CREATE TABLE IF NOT EXISTS integration.inbound_event (
  event_id         uuid        PRIMARY KEY,
  type             varchar(48) NOT NULL,
  version          smallint    NOT NULL,
  occurred_at      timestamptz NOT NULL,
  source           varchar(40) NOT NULL,
  idempotency_key  text        NOT NULL UNIQUE,
  payload          jsonb       NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  outcome          varchar(16) NOT NULL CHECK (outcome IN ('applied', 'ignored', 'rejected')),
  note             text
);

CREATE TABLE IF NOT EXISTS integration.reconciliation_item (
  id               bigserial   PRIMARY KEY,
  kind             varchar(40) NOT NULL CHECK (kind IN (
                     'structure_no_account', 'account_no_parcel', 'account_on_retired_parcel',
                     'duplicate_stand_no', 'area_mismatch', 'asset_no_erp_number')),
  ref_key          text        NOT NULL,
  detail           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status           varchar(12) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  assigned_to      text,
  resolution_note  text,
  resolved_by      uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  resolved_at      timestamptz,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recon_resolved_has_note CHECK (status = 'open' OR resolution_note IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_recon_open ON integration.reconciliation_item (kind, ref_key) WHERE status = 'open';

-- Parcel <-> account. Assets and permits join here in later phases.
CREATE OR REPLACE VIEW integration.key_registry AS
SELECT p.parcel_id, p.stand_no, p.township_code, p.ward_code, p.status AS parcel_status,
       a.erp_account_no, a.link_type, a.linked_on, b.status_band, b.as_at
  FROM land.parcel p
  JOIN revenue_link.account_link a ON a.parcel_id = p.parcel_id
  LEFT JOIN revenue_link.billing_status b ON b.erp_account_no = a.erp_account_no;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. AUDIT: append-only, seven-year floor
-- ═══════════════════════════════════════════════════════════════════════
-- The admin console's retention prune (admin-console.js pruneAudit) still
-- runs; this makes anything younger than seven years untouchable whatever the
-- retention setting says.
CREATE OR REPLACE FUNCTION public.admin_audit_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit trail is append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.occurred_at > now() - interval '7 years' THEN
    RETURN NULL;  -- silently keep: the prune is best-effort housekeeping
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_admin_audit_event_guard ON public.admin_audit_event;
CREATE TRIGGER trg_admin_audit_event_guard BEFORE UPDATE OR DELETE ON public.admin_audit_event
  FOR EACH ROW EXECUTE FUNCTION public.admin_audit_event_guard();

COMMIT;
