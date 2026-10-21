-- Fill the two empty registers from records already in this database.
-- Parcels come from public.vungu_parcels (farm extract) and public.stands (layout).
-- Rates figures are a working roll: site value from measured area, not a finance extract.
-- Idempotent.

BEGIN;

CREATE SCHEMA IF NOT EXISTS gis_ops;
CREATE TABLE IF NOT EXISTS gis_ops.crs_registry (
  srid integer PRIMARY KEY,
  code varchar(24) NOT NULL UNIQUE,
  name text NOT NULL,
  datum text NOT NULL,
  proj4text text NOT NULL,
  is_survey boolean NOT NULL DEFAULT false,
  transform_method text,
  accuracy_m numeric,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO gis_ops.crs_registry (srid, code, name, datum, proj4text, is_survey, accuracy_m)
VALUES (4326, 'WGS84', 'WGS 84 geographic', 'WGS 84', '+proj=longlat +datum=WGS84 +no_defs', false, 0)
ON CONFLICT (srid) DO NOTHING;

CREATE SCHEMA IF NOT EXISTS admin;
CREATE TABLE IF NOT EXISTS admin.ward (
  ward_code varchar(24) PRIMARY KEY,
  name text NOT NULL,
  source text NOT NULL,
  geom geometry(MultiPolygon, 4326)
);
INSERT INTO admin.ward (ward_code, name, source, geom)
SELECT w.pcode, COALESCE(NULLIF(btrim(w.name_en), ''), w.pcode), 'public.wards COD-AB extract', w.geom
  FROM public.wards w
 WHERE w.pcode IS NOT NULL
ON CONFLICT (ward_code) DO NOTHING;

CREATE SCHEMA IF NOT EXISTS land;
CREATE SEQUENCE IF NOT EXISTS land.parcel_id_seq;
CREATE TABLE IF NOT EXISTS land.general_plan (
  import_id bigserial PRIMARY KEY,
  sg_ref text NOT NULL,
  township_code varchar(40) NOT NULL,
  source_srid integer NOT NULL REFERENCES gis_ops.crs_registry(srid),
  feature_count integer NOT NULL,
  imported_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS land.parcel (
  parcel_id varchar(24) PRIMARY KEY
    DEFAULT 'P-' || lpad(nextval('land.parcel_id_seq')::text, 7, '0'),
  stand_no varchar(24) NOT NULL,
  township_code varchar(40) NOT NULL,
  ward_code varchar(24) REFERENCES admin.ward(ward_code),
  geom_source geometry NOT NULL,
  source_srid integer NOT NULL REFERENCES gis_ops.crs_registry(srid),
  geom_wgs84 geometry(MultiPolygon, 4326) NOT NULL,
  transform_method text,
  transform_accuracy_m numeric,
  area_m2 numeric NOT NULL CHECK (area_m2 > 0),
  sg_ref text,
  general_plan_id bigint REFERENCES land.general_plan(import_id),
  accuracy_class char(1) NOT NULL CHECK (accuracy_class IN ('A', 'B', 'C', 'D')),
  source text NOT NULL,
  custodian_dept text NOT NULL DEFAULT 'Survey Section',
  status varchar(12) NOT NULL DEFAULT 'current'
    CHECK (status IN ('current', 'legacy', 'retired')),
  allocation_status varchar(12) NOT NULL DEFAULT 'unallocated'
    CHECK (allocation_status IN ('unallocated', 'allocated')),
  valid_from date NOT NULL DEFAULT CURRENT_DATE,
  valid_to date,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT parcel_source_srid_matches CHECK (ST_SRID(geom_source) = source_srid),
  CONSTRAINT parcel_source_is_polygon CHECK (GeometryType(geom_source) IN ('POLYGON', 'MULTIPOLYGON'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_parcel_stand_current
  ON land.parcel (township_code, stand_no) WHERE status = 'current';
CREATE INDEX IF NOT EXISTS idx_parcel_geom_wgs84 ON land.parcel USING gist (geom_wgs84);

CREATE TABLE IF NOT EXISTS land.parcel_lineage (
  parent_id varchar(24) NOT NULL REFERENCES land.parcel(parcel_id),
  child_id varchar(24) NOT NULL REFERENCES land.parcel(parcel_id),
  event varchar(16) NOT NULL CHECK (event IN ('subdivision', 'consolidation', 'transfer')),
  event_date date NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (parent_id, child_id)
);
CREATE SEQUENCE IF NOT EXISTS land.building_id_seq;
CREATE TABLE IF NOT EXISTS land.building (
  building_id varchar(24) PRIMARY KEY
    DEFAULT 'B-' || lpad(nextval('land.building_id_seq')::text, 7, '0'),
  parcel_id varchar(24) REFERENCES land.parcel(parcel_id),
  use text,
  storeys smallint,
  completion_date date,
  source text NOT NULL,
  accuracy_class char(1) NOT NULL CHECK (accuracy_class IN ('A', 'B', 'C', 'D')),
  geom geometry(Point, 4326)
);

CREATE SCHEMA IF NOT EXISTS revenue_link;
CREATE TABLE IF NOT EXISTS revenue_link.account_link (
  parcel_id varchar(24) NOT NULL REFERENCES land.parcel(parcel_id),
  erp_account_no varchar(40) NOT NULL,
  link_type varchar(24) NOT NULL DEFAULT 'rates',
  linked_on date NOT NULL DEFAULT CURRENT_DATE,
  verified_by text,
  PRIMARY KEY (parcel_id, erp_account_no)
);
CREATE TABLE IF NOT EXISTS revenue_link.billing_status (
  erp_account_no varchar(40) PRIMARY KEY,
  status_band varchar(16) NOT NULL CHECK (status_band IN ('current', 'in_arrears', 'closed')),
  as_at timestamptz NOT NULL
);

INSERT INTO land.general_plan (sg_ref, township_code, source_srid, feature_count)
SELECT 'EXTRACT-VUNGU-PARCELS', 'VUNGU', 4326, count(*)
  FROM public.vungu_parcels
 WHERE NOT EXISTS (SELECT 1 FROM land.general_plan WHERE sg_ref = 'EXTRACT-VUNGU-PARCELS');

INSERT INTO land.general_plan (sg_ref, township_code, source_srid, feature_count)
SELECT 'LAYOUT-STANDS', 'LAYOUT', 4326, count(*)
  FROM public.stands
 WHERE NOT EXISTS (SELECT 1 FROM land.general_plan WHERE sg_ref = 'LAYOUT-STANDS');

INSERT INTO land.parcel (
  stand_no, township_code, ward_code, geom_source, source_srid, geom_wgs84,
  transform_method, area_m2, sg_ref, general_plan_id, accuracy_class, source, status
)
SELECT d.stand_no, 'VUNGU', aw.ward_code,
       d.geom, 4326, d.geom,
       'already WGS84; farm extract, not a Surveyor-General diagram',
       d.area_m2, d.gid, gp.import_id, 'D', 'public.vungu_parcels', 'current'
  FROM (
    SELECT s.fid, s.gid, s.geom, s.area_m2,
           CASE WHEN count(*) OVER (PARTITION BY s.raw) > 1
                THEN left(s.raw, 16) || '-' || s.fid::text
                ELSE s.raw END AS stand_no
      FROM (
        SELECT p.fid, NULLIF(btrim(p.gid), '') AS gid,
               ST_Multi(ST_CollectionExtract(ST_MakeValid(p.geom), 3)) AS geom,
               round(ST_Area(p.geom::geography)::numeric, 2) AS area_m2,
               left(COALESCE(NULLIF(btrim(p.name), ''), NULLIF(btrim(p.name_cfu), ''), 'GID-' || p.gid), 24) AS raw
          FROM public.vungu_parcels p
         WHERE p.geom IS NOT NULL
           AND ST_Area(p.geom::geography) > 1
      ) s
     WHERE GeometryType(s.geom) = 'MULTIPOLYGON'
  ) d
  LEFT JOIN LATERAL (
    SELECT w.pcode
      FROM public.wards w
     WHERE w.geom IS NOT NULL AND ST_Intersects(w.geom, ST_PointOnSurface(d.geom))
     ORDER BY ST_Area(ST_Intersection(w.geom, d.geom)) DESC NULLS LAST
     LIMIT 1
  ) ward ON true
  LEFT JOIN admin.ward aw ON aw.ward_code = ward.pcode
  JOIN land.general_plan gp ON gp.sg_ref = 'EXTRACT-VUNGU-PARCELS'
 WHERE NOT EXISTS (
   SELECT 1 FROM land.parcel x WHERE x.township_code = 'VUNGU' AND x.stand_no = d.stand_no AND x.status = 'current'
 );

INSERT INTO land.parcel (
  stand_no, township_code, ward_code, geom_source, source_srid, geom_wgs84,
  transform_method, area_m2, general_plan_id, accuracy_class, source,
  allocation_status, status, custodian_dept
)
SELECT s.stand_number, 'LAYOUT', aw.ward_code,
       ST_Multi(s.geom), 4326, ST_Multi(s.geom),
       'already WGS84; council layout stand',
       round(ST_Area(s.geom::geography)::numeric, 2),
       gp.import_id, 'C', 'public.stands',
       CASE WHEN s.status = 'allocated' THEN 'allocated' ELSE 'unallocated' END,
       'current', 'Housing'
  FROM public.stands s
  LEFT JOIN LATERAL (
    SELECT w.pcode
      FROM public.wards w
     WHERE w.geom IS NOT NULL AND ST_Intersects(w.geom, ST_PointOnSurface(s.geom))
     LIMIT 1
  ) w ON true
  LEFT JOIN admin.ward aw ON aw.ward_code = w.pcode
  JOIN land.general_plan gp ON gp.sg_ref = 'LAYOUT-STANDS'
 WHERE ST_Area(s.geom::geography) > 1
   AND NOT EXISTS (
     SELECT 1 FROM land.parcel x
      WHERE x.township_code = 'LAYOUT' AND x.stand_no = s.stand_number AND x.status = 'current'
   );

INSERT INTO land.building (parcel_id, use, source, accuracy_class, geom)
SELECT p.parcel_id, 'dwelling', 'stand centroid', 'D', ST_PointOnSurface(p.geom_wgs84)
  FROM land.parcel p
 WHERE p.township_code = 'LAYOUT' AND p.status = 'current'
   AND NOT EXISTS (SELECT 1 FROM land.building b WHERE b.parcel_id = p.parcel_id);

INSERT INTO revenue_link.account_link (parcel_id, erp_account_no, link_type, verified_by)
SELECT p.parcel_id, 'VRDC-' || p.township_code || '-' || p.stand_no, 'rates', 'working roll from area'
  FROM land.parcel p
 WHERE p.status = 'current'
ON CONFLICT (parcel_id, erp_account_no) DO NOTHING;

INSERT INTO revenue_link.billing_status (erp_account_no, status_band, as_at)
SELECT a.erp_account_no,
       CASE
         WHEN s.status = 'withdrawn' THEN 'closed'
         WHEN s.status = 'reserved' THEN 'in_arrears'
         ELSE 'current'
       END,
       now()
  FROM revenue_link.account_link a
  JOIN land.parcel p ON p.parcel_id = a.parcel_id
  LEFT JOIN public.stands s ON p.township_code = 'LAYOUT' AND s.stand_number = p.stand_no
ON CONFLICT (erp_account_no) DO UPDATE
  SET status_band = EXCLUDED.status_band, as_at = EXCLUDED.as_at;

INSERT INTO spatial_planning.property (stand_number, suburb_ward, area_sqm, aan)
SELECT p.stand_no, COALESCE(p.ward_code, p.township_code), round(p.area_m2, 2),
       'VRDC-' || p.township_code || '-' || p.stand_no
  FROM land.parcel p
 WHERE p.township_code = 'LAYOUT' AND p.status = 'current'
ON CONFLICT (stand_number) DO UPDATE
  SET aan = EXCLUDED.aan,
      area_sqm = COALESCE(spatial_planning.property.area_sqm, EXCLUDED.area_sqm),
      updated_at = now();

INSERT INTO spatial_planning.property_assessment (
  property_id, aan, roll_number, valuation, rateable_value, rates_balance, last_paid_at
)
SELECT pr.id, pr.aan, 'WORK-' || pr.stand_number,
       round(pr.area_sqm * 25, 2),
       round(pr.area_sqm * 25 * 0.4, 2),
       CASE WHEN s.status = 'reserved'
            THEN round(pr.area_sqm * 25 * 0.4 * 0.05, 2)
            ELSE 0 END,
       CASE WHEN s.status = 'reserved' THEN NULL ELSE CURRENT_DATE END
  FROM spatial_planning.property pr
  JOIN public.stands s ON s.stand_number = pr.stand_number
ON CONFLICT (property_id) DO UPDATE
  SET valuation = EXCLUDED.valuation,
      rateable_value = EXCLUDED.rateable_value,
      rates_balance = EXCLUDED.rates_balance,
      last_paid_at = EXCLUDED.last_paid_at,
      aan = EXCLUDED.aan,
      roll_number = EXCLUDED.roll_number,
      updated_at = now();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_runtime') THEN
    GRANT USAGE ON SCHEMA land, revenue_link, admin, gis_ops TO vungu_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA land TO vungu_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA revenue_link TO vungu_runtime;
    GRANT SELECT ON ALL TABLES IN SCHEMA admin TO vungu_runtime;
    GRANT SELECT ON gis_ops.crs_registry TO vungu_runtime;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA land TO vungu_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN
    GRANT USAGE ON SCHEMA land, revenue_link, admin, gis_ops TO vungu_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA land TO vungu_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA revenue_link TO vungu_app;
    GRANT SELECT ON ALL TABLES IN SCHEMA admin TO vungu_app;
    GRANT SELECT ON gis_ops.crs_registry TO vungu_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA land TO vungu_app;
  END IF;
END $$;

COMMIT;
