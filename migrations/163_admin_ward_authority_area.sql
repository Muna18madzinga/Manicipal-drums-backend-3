-- 163: admin.ward becomes the canonical ward table; an authority's area is the union of its wards.
--
-- Concepts admin_ward and authority_area (migration 162, docs/SPATIAL-NAMING-CONVENTION.md).
--
--  1. admin.ward gets the columns a ward table needs and is filled from public.wards (the COD-AB set, 1,961 wards), keeping
--     every old integer id so tiles and the stands foreign key do not change.
--  2. public.wards stops being a table and becomes a VIEW over admin.ward with the same columns, so every reader of "wards"
--     (tiles, routes, QGIS) is unaffected. The application's role could write to the old table; it can only read the view.
--  3. admin.authority_ward is the versioned relation "this ward belongs to this authority from ... to ...", with the instrument
--     that fixed it. A ward belongs to one authority at a time.
--  4. admin.authority_area is a view: the union of an authority's current wards (a combination's: of its members'). Nobody
--     draws a jurisdiction; a new delimitation changes this one relation.
--
-- Idempotent. A ward delimitation other than the COD-AB (the Zimbabwe Electoral Commission's 2022 wards, 1,970) is loaded as
-- new rows with its own `delimitation`, and the old ones are ended with valid_to; how the new codes are chosen is decided when
-- that data arrives.

-- 1. admin.ward --------------------------------------------------------------------------------------------------------
ALTER TABLE admin.ward
  ADD COLUMN IF NOT EXISTS parent_pcode text,
  ADD COLUMN IF NOT EXISTS delimitation text NOT NULL DEFAULT 'COD-AB',
  ADD COLUMN IF NOT EXISTS valid_from   date,
  ADD COLUMN IF NOT EXISTS valid_to     date,
  ADD COLUMN IF NOT EXISTS legacy_fid   integer;

CREATE SEQUENCE IF NOT EXISTS admin.ward_legacy_fid_seq OWNED BY admin.ward.legacy_fid;
ALTER TABLE admin.ward ALTER COLUMN legacy_fid SET DEFAULT nextval('admin.ward_legacy_fid_seq');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ward_legacy_fid_key') THEN
    ALTER TABLE admin.ward ADD CONSTRAINT ward_legacy_fid_key UNIQUE (legacy_fid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ward_validity_order') THEN
    ALTER TABLE admin.ward ADD CONSTRAINT ward_validity_order CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ward_parent_pcode_idx ON admin.ward (parent_pcode);

-- 2. move public.wards into it, and put a view in its place ---------------------------------------------------------------
DO $$
DECLARE
  is_table boolean := EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                               WHERE n.nspname = 'public' AND c.relname = 'wards' AND c.relkind = 'r');
  stands_view text;
  readers text[];
  r text;
BEGIN
  IF is_table THEN
    INSERT INTO admin.ward (ward_code, name, source, parent_pcode, delimitation, legacy_fid, geom)
    SELECT pcode, name_en, 'COD-AB (OCHA/ZIMSTAT)', parent_pcode, 'COD-AB', fid, geom
      FROM public.wards
    ON CONFLICT (ward_code) DO NOTHING;
    PERFORM setval('admin.ward_legacy_fid_seq', GREATEST((SELECT COALESCE(max(legacy_fid), 0) FROM admin.ward), 1));

    -- who may read the old table, so the view is readable by the same people (never writable by them)
    SELECT array_agg(DISTINCT grantee) INTO readers FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'wards' AND privilege_type = 'SELECT' AND grantee <> 'postgres';

    -- the stands foreign key follows the ward to its new home; v_stands reads wards by name, so it is recreated
    FOR r IN SELECT conrelid::regclass::text || ' DROP CONSTRAINT ' || quote_ident(conname) FROM pg_constraint WHERE confrelid = 'public.wards'::regclass LOOP
      EXECUTE 'ALTER TABLE ' || r;
    END LOOP;
    IF to_regclass('public.v_stands') IS NOT NULL THEN
      stands_view := pg_get_viewdef('public.v_stands'::regclass, true);
      DROP VIEW public.v_stands;
    END IF;
    DROP TABLE public.wards;
  END IF;

  CREATE OR REPLACE VIEW public.wards AS
    SELECT legacy_fid AS fid, ward_code AS pcode, name AS name_en, parent_pcode, 3::bigint AS level, geom
      FROM admin.ward
     WHERE valid_to IS NULL OR valid_to >= CURRENT_DATE;
  COMMENT ON VIEW public.wards IS 'Compatibility view over admin.ward (migration 163): the current wards. Read-only; edit admin.ward.';

  IF stands_view IS NOT NULL THEN
    EXECUTE 'CREATE VIEW public.v_stands AS ' || stands_view;
  END IF;
  IF is_table AND to_regclass('public.stands') IS NOT NULL THEN
    ALTER TABLE public.stands ADD CONSTRAINT stands_ward_fid_fkey FOREIGN KEY (ward_fid) REFERENCES admin.ward (legacy_fid) ON DELETE SET NULL;
  END IF;
  -- migration 154's default privileges would make a new view writable by the application role: read only, for the old readers
  REVOKE ALL ON public.wards FROM vungu_app;
  IF stands_view IS NOT NULL THEN REVOKE ALL ON public.v_stands FROM vungu_app; END IF;
  FOREACH r IN ARRAY COALESCE(readers, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT SELECT ON public.wards TO %I', r);
    IF stands_view IS NOT NULL THEN EXECUTE format('GRANT SELECT ON public.v_stands TO %I', r); END IF;
  END LOOP;
END $$;

-- the application role reads the view, whether this is the first run or a repeat (a repeat does not know the old readers)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN
    GRANT SELECT ON public.wards TO vungu_app;
    IF to_regclass('public.v_stands') IS NOT NULL THEN GRANT SELECT ON public.v_stands TO vungu_app; END IF;
  END IF;
END $$;

-- 3. which ward belongs to which authority, and when -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin.authority_ward (
  authority_id   integer NOT NULL REFERENCES public.local_authorities (id) ON DELETE CASCADE,
  ward_code      varchar(24) NOT NULL REFERENCES admin.ward (ward_code) ON UPDATE CASCADE,
  valid_from     date NOT NULL,
  valid_to       date,
  -- proclamation: fixed by a presidential proclamation; delimitation: from a ZEC delimitation; interim: stand-in until one of
  -- those is loaded; proposed: not yet in force
  basis          text NOT NULL CHECK (basis IN ('proclamation', 'delimitation', 'interim', 'proposed')),
  instrument_ref text,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (authority_id, ward_code, valid_from),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX IF NOT EXISTS authority_ward_ward_idx ON admin.authority_ward (ward_code);

-- A ward belongs to one authority at a time, and a combination authority has no wards of its own (it is its members').
CREATE OR REPLACE FUNCTION admin.authority_ward_check() RETURNS trigger AS $$
BEGIN
  IF NEW.valid_to IS NOT NULL AND NEW.valid_to <= NEW.valid_from THEN
    RAISE EXCEPTION 'a membership must end after it begins' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT kind FROM public.local_authorities WHERE id = NEW.authority_id) = 'combination' THEN
    RAISE EXCEPTION 'a combination authority has no wards of its own: it covers the wards of its members' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM admin.authority_ward o
              WHERE o.ward_code = NEW.ward_code
                AND (o.authority_id, o.valid_from) IS DISTINCT FROM (NEW.authority_id, NEW.valid_from)
                AND daterange(o.valid_from, o.valid_to) && daterange(NEW.valid_from, NEW.valid_to)) THEN
    RAISE EXCEPTION 'ward % already belongs to an authority during that period', NEW.ward_code USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_authority_ward_check ON admin.authority_ward;
CREATE TRIGGER trg_authority_ward_check BEFORE INSERT OR UPDATE ON admin.authority_ward
  FOR EACH ROW EXECUTE FUNCTION admin.authority_ward_check();

-- 4. an authority's area: the union of its current wards ------------------------------------------------------------------
CREATE OR REPLACE VIEW admin.authority_area WITH (security_invoker = true) AS
WITH holders AS (
  SELECT a.id AS authority_id, a.id AS holder_id FROM public.local_authorities a WHERE a.kind <> 'combination'
  UNION ALL
  SELECT m.combination_id, m.member_id FROM public.authority_member m
   WHERE m.valid_from <= CURRENT_DATE AND (m.valid_to IS NULL OR m.valid_to > CURRENT_DATE)
)
SELECT h.authority_id, a.code AS authority_code,
       count(DISTINCT w.ward_code)::int                                  AS wards,
       string_agg(DISTINCT aw.basis, ', ' ORDER BY aw.basis)             AS basis,
       bool_or(aw.basis IN ('interim', 'proposed'))                      AS provisional,
       ST_Multi(ST_Union(w.geom))::geometry(MultiPolygon, 4326)          AS geom
  FROM holders h
  JOIN public.local_authorities a ON a.id = h.authority_id
  JOIN admin.authority_ward aw ON aw.authority_id = h.holder_id
       AND aw.valid_from <= CURRENT_DATE AND (aw.valid_to IS NULL OR aw.valid_to > CURRENT_DATE)
  JOIN admin.ward w ON w.ward_code = aw.ward_code
 GROUP BY h.authority_id, a.code;

-- 5. who may read, and the registry ---------------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA admin TO vungu_app;
GRANT SELECT ON admin.ward, admin.authority_ward, admin.authority_area, admin.village TO vungu_app;

UPDATE public.spatial_concept_source SET role = 'canonical', note = 'the canonical ward table (migration 163): COD-AB wards with their old integer ids; to be superseded by the ZEC delimitation'
 WHERE relation = 'admin.ward';
UPDATE public.spatial_concept_source SET role = 'derived', note = 'compatibility view over admin.ward (migration 163)'
 WHERE relation = 'public.wards';
INSERT INTO public.spatial_concept_source (relation, concept_code, role, note) VALUES
  ('admin.authority_area', 'authority_area', 'canonical', 'the union of an authority''s current wards (a combination''s: of its members''); provisional while any ward is on an interim basis')
ON CONFLICT (relation) DO NOTHING;
UPDATE public.spatial_concept_source SET role = 'legacy', note = 'the jurisdiction column, empty: superseded by admin.authority_area'
 WHERE relation = 'public.local_authorities';

-- 6. reference data is read only for the application role --------------------------------------------------------------------
-- Migration 154 gave the application role INSERT, UPDATE and DELETE on every table and view created afterwards in public, land,
-- spatial_planning and gis_ops. The reference and registry tables and the derived views added since (migrations 156 to 163) are
-- changed by migrations and administrators, never by a request, so the role keeps SELECT only. (Narrowing the role's grants on
-- the older tables is a separate piece of work: docs/TENANCY.md.)
DO $$
DECLARE rel text;
BEGIN
  FOREACH rel IN ARRAY ARRAY[
    'public.development_activity', 'public.activity_standard_kind', 'public.spatial_concept', 'public.spatial_concept_source',
    'public.activity_spatial_test', 'public.land_use_group_tree', 'public.plan_matrix_audit', 'public.plan_matrix_audit_summary',
    'public.zone_decision_status', 'public.spatial_concept_summary', 'public.activity_spatial_gaps',
    'admin.ward', 'admin.authority_ward', 'admin.authority_area'
  ] LOOP
    IF to_regclass(rel) IS NOT NULL THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %s FROM vungu_app', rel);
    END IF;
  END LOOP;
END $$;
