-- 166: direct database clients (QGIS Desktop, QGIS Server, the tile server) get least-privilege roles bound to an authority.
--
-- THE GAP. The application scopes a request by setting app.user_id / app.authority_id on its connection (migration 154). A
-- client that connects to the database itself does none of that: QGIS Desktop and QGIS Server open their own connections, and
-- so does anything else with a login. As the application's owner role they see everything; as an unscoped role they see nothing
-- useful; and any role can SET app.authority_id to whatever it likes.
--
-- THE FIX. A direct client logs in as its OWN role, and the role decides who it is:
--   * tenancy.role_authority maps a login role to one authority. app.authority_id() answers from that mapping FIRST and from the
--     session setting only when the role is not mapped, so a mapped role cannot impersonate another authority by setting a
--     variable (app.user_id() is empty and app.is_platform() false for it).
--   * tenancy_reader (group): SELECT on exactly the published layers whose rows are safe to reach directly (national and reference
--     data, and tenant data that row-level security scopes); never authority-owned data that has no policy yet. It is read only
--     by default (default_transaction_read_only on the login roles).
--   * tenancy_author (group, a reader that can also write): INSERT, UPDATE, DELETE on tenancy.author_write only: the zone
--     polygons an author draws in QGIS and what the zone triggers maintain. Row-level security still binds every write to the
--     authority's own plan.
--   * tenancy.sync_published_grants() makes the reader's grants match layer_publication: approve a layer and (if it is safe) it
--     is readable; withdraw it and it is not. Run it after any change to the approvals (scripts/create-authority-db-role.js does).
--
-- A login role for an authority is made with scripts/create-authority-db-role.js. Nothing here creates a login.

-- 1. The role decides who it is -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenancy.role_authority (
  role_name    name PRIMARY KEY,
  authority_id integer NOT NULL REFERENCES public.local_authorities (id) ON DELETE CASCADE,
  access       text NOT NULL CHECK (access IN ('read', 'author')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Which authority a login role belongs to. SECURITY DEFINER with a pinned path so the mapping table itself is never exposed.
CREATE OR REPLACE FUNCTION tenancy.role_authority_of(p_role name) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, tenancy AS $$
  SELECT authority_id FROM tenancy.role_authority WHERE role_name = p_role
$$;
REVOKE ALL ON FUNCTION tenancy.role_authority_of(name) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN tenancy.role_authority_of(current_user) IS NOT NULL THEN NULL
              ELSE NULLIF(current_setting('app.user_id', true), '')::uuid END
$$;
CREATE OR REPLACE FUNCTION app.authority_id() RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT COALESCE(tenancy.role_authority_of(current_user), NULLIF(current_setting('app.authority_id', true), '')::integer)
$$;
CREATE OR REPLACE FUNCTION app.is_platform() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT tenancy.role_authority_of(current_user) IS NULL AND COALESCE(current_setting('app.platform', true), '') = 'on'
$$;

-- 2. The roles ------------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenancy_reader') THEN
    CREATE ROLE tenancy_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenancy_author') THEN
    CREATE ROLE tenancy_author NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE IN ROLE tenancy_reader;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'could not create the direct-client roles (needs CREATEROLE): create tenancy_reader and tenancy_author by hand, then re-run this migration';
END $$;

-- The relations an author may write. Only tenant data bounded by row-level security belongs here (the guard checks it).
CREATE TABLE IF NOT EXISTS tenancy.author_write (
  relation text PRIMARY KEY,
  note     text
);
INSERT INTO tenancy.author_write (relation, note) VALUES
  ('public.proposed_peri_urban_zones', 'the zone polygons an author draws in QGIS'),
  ('public.plan_zone_type',            'maintained by the zone trigger (a drawn zone gets its zone type)'),
  ('public.zone_land_use_controls',    'maintained by the zone trigger (a renamed zone keeps its decisions)')
ON CONFLICT (relation) DO NOTHING;

-- Support relations the row-level-security policies read: without them a policy cannot evaluate for these roles.
-- (Both are themselves protected: plan_instrument by row-level security, authority_member by being reference data.)

-- 3. Keep the reader's grants equal to the safe published layers ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION tenancy.sync_published_grants() RETURNS TABLE (relation text, action text) AS $$
DECLARE
  r record;
  wanted text[] := ARRAY[]::text[];
  support text[] := ARRAY['public.plan_instrument', 'public.authority_member'];
  rel text;
  seq regclass;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenancy_reader') THEN RETURN; END IF;

  -- schema access and the policy functions
  FOR rel IN SELECT nspname FROM pg_namespace WHERE nspname IN ('public', 'admin', 'land', 'spatial_planning', 'gis_ops') LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO tenancy_reader', rel);
  END LOOP;
  GRANT USAGE ON SCHEMA app, tenancy TO tenancy_reader;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO tenancy_reader;
  GRANT EXECUTE ON FUNCTION tenancy.role_authority_of(name) TO tenancy_reader;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN
    GRANT EXECUTE ON FUNCTION tenancy.role_authority_of(name) TO vungu_app;
    GRANT USAGE ON SCHEMA tenancy TO vungu_app;
  END IF;

  -- what the approvals say, in the safe classes
  FOR r IN SELECT lp.table_name, k.class, to_regclass('public.' || quote_ident(lp.table_name)) AS oid
             FROM public.layer_publication lp
             LEFT JOIN tenancy.relation_class k ON k.relation = 'public.' || lp.table_name LOOP
    IF r.oid IS NULL THEN CONTINUE; END IF;
    IF r.class IN ('national', 'reference', 'tenant_view', 'tenant', 'tenant_child') THEN
      wanted := wanted || ('public.' || r.table_name);
    ELSE
      relation := 'public.' || r.table_name; action := 'withheld: ' || COALESCE(r.class, 'unclassified') || ' data is not scoped to an authority'; RETURN NEXT;
    END IF;
  END LOOP;
  wanted := wanted || support;

  -- revoke what is no longer wanted, grant what is
  FOR r IN SELECT n.nspname || '.' || c.relname AS rel
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p', 'v', 'm') AND n.nspname IN ('public', 'admin', 'land', 'spatial_planning', 'gis_ops')
              AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) x WHERE x.grantee = 'tenancy_reader'::regrole AND x.privilege_type = 'SELECT')
              AND NOT EXISTS (SELECT 1 FROM tenancy.author_write w WHERE w.relation = n.nspname || '.' || c.relname) LOOP
    IF NOT (r.rel = ANY (wanted)) THEN
      EXECUTE format('REVOKE ALL ON %s FROM tenancy_reader', r.rel::regclass);
      relation := r.rel; action := 'revoked'; RETURN NEXT;
    END IF;
  END LOOP;
  FOREACH rel IN ARRAY wanted LOOP
    IF to_regclass(rel) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON %s TO tenancy_reader', rel::regclass);
    END IF;
  END LOOP;

  -- the author: read what the reader reads, write only what is listed
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tenancy_author') THEN
    FOR r IN SELECT w.relation AS rel FROM tenancy.author_write w LOOP
      IF to_regclass(r.rel) IS NULL THEN CONTINUE; END IF;
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO tenancy_author', r.rel::regclass);
      FOR seq IN SELECT d.objid::regclass FROM pg_depend d
                  WHERE d.refobjid = r.rel::regclass AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
                    AND (SELECT relkind FROM pg_class WHERE oid = d.objid) = 'S' LOOP
        EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO tenancy_author', seq);
      END LOOP;
    END LOOP;
  END IF;
END $$ LANGUAGE plpgsql;

-- 4. Views over tenant or authority-owned data run as the person asking (the guard checks it) -------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT k.relation FROM tenancy.relation_class k
            WHERE k.class IN ('tenant_view', 'pending') AND to_regclass(k.relation) IS NOT NULL
              AND (SELECT relkind FROM pg_class WHERE oid = to_regclass(k.relation)) = 'v' LOOP
    EXECUTE format('ALTER VIEW %s SET (security_invoker = true)', r.relation::regclass);
  END LOOP;
END $$;

SELECT count(*) FROM tenancy.sync_published_grants();
