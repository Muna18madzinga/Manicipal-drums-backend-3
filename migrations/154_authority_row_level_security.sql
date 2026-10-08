-- 154_authority_row_level_security.sql
-- ─────────────────────────────────────────────────────────────────────────
-- Phase 4, slice 1: who a signed-in person belongs to, and row-level security so that one authority
-- cannot read or write another's permits and plans.
--
-- HOW IT WORKS
--   * A user belongs to an authority (users.authority_id). A platform operator (is_platform) may cross
--     authorities; nobody is one by default.
--   * The API runs a request's queries inside a transaction that does  SET LOCAL ROLE vungu_app  and sets
--     three settings: app.user_id, app.authority_id, app.platform. The policies below read them.
--   * The API connects as the table owner / superuser today, which BYPASSES row-level security. That is
--     deliberate: only code that opts in (src/lib/tenancy.js withTenant) is enforced, so nothing that has
--     not been converted can break. Where it is enforced, the DATABASE refuses, not the route.
--   * Production should connect as vungu_app (or a role that is not the owner) so that nothing can bypass it.
--
-- WHAT IS ENFORCED NOW (and so what is not): permits, plan instruments and everything that hangs off a plan
-- (zone types, land uses, decisions, standards, crosswalks, events, sign-offs, parcel zoning, the zone
-- polygons). Every other table is untouched. See docs/TENANCY.md.
--
-- VISIBILITY RULES
--   * An authority's staff see their own rows. A combination authority's rows are also visible to the
--     staff of each of its (current) member authorities (authority_member); members never see each
--     other's own rows. Writing is for the owning authority only.
--   * Templates (no authority) and GAZETTED plans are published planning information: anyone may read them.
--   * A citizen sees their own permits only (created_by).
--   * A person with no authority and no platform flag sees only what is public.
--   * Nothing is writable across authorities except by a platform operator.

BEGIN;

-- 1. Who belongs to which authority -----------------------------------------------------------
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS authority_id integer REFERENCES public.local_authorities (id);
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_platform boolean NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_users_authority ON public.users (authority_id);

-- Staff belong to Vungu until they are assigned. TRANSITIONAL, like the other defaults to Vungu: it goes
-- when staff are provisioned into their own authority (the invite flow carries the inviter's authority).
UPDATE public.users
   SET authority_id = (SELECT id FROM public.local_authorities WHERE code = 'VUNGU')
 WHERE authority_id IS NULL
   AND role IN ('admin', 'planner', 'planning_clerk', 'building_inspector', 'eo', 'env_officer', 'surveyor', 'gis_officer');

CREATE OR REPLACE FUNCTION public.users_default_authority() RETURNS trigger AS $$
BEGIN
  IF NEW.authority_id IS NULL AND NEW.role IN ('admin', 'planner', 'planning_clerk', 'building_inspector', 'eo', 'env_officer', 'surveyor', 'gis_officer') THEN
    SELECT id INTO NEW.authority_id FROM public.local_authorities WHERE code = 'VUNGU';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_default_authority ON public.users;
CREATE TRIGGER trg_users_default_authority BEFORE INSERT OR UPDATE OF role ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_default_authority();

-- 2. The role the API steps into, and what the policies read ------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN
    CREATE ROLE vungu_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'could not create role vungu_app (needs CREATEROLE): create it by hand, then re-run this migration';
END $$;

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.user_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app.authority_id() RETURNS integer LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.authority_id', true), '')::integer $$;
CREATE OR REPLACE FUNCTION app.is_platform() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(current_setting('app.platform', true), '') = 'on' $$;

-- The authorities whose rows the caller may SEE: their own, and any combination they are a current member of.
CREATE OR REPLACE FUNCTION app.visible_authorities() RETURNS integer[] LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN app.authority_id() IS NULL THEN '{}'::integer[]
              ELSE ARRAY(SELECT app.authority_id()
                         UNION
                         SELECT m.combination_id FROM public.authority_member m
                          WHERE m.member_id = app.authority_id() AND (m.valid_to IS NULL OR m.valid_to >= CURRENT_DATE))
         END
$$;

-- 3. Grants: the role may touch the tables the API uses; row-level security narrows the protected ones.
DO $$
DECLARE s text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN RETURN; END IF;
  FOREACH s IN ARRAY ARRAY['public', 'app', 'spatial_planning', 'gis_ops', 'land'] LOOP
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO vungu_app', s);
      IF s <> 'app' THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO vungu_app', s);
        EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO vungu_app', s);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vungu_app', s);
        EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO vungu_app', s);
      END IF;
    END IF;
  END LOOP;
  EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO vungu_app';
END $$;

-- 4. Policies ---------------------------------------------------------------------------------------
-- Plan instruments: the root. Templates (no authority) and gazetted plans are public.
ALTER TABLE public.plan_instrument ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_select ON public.plan_instrument;
DROP POLICY IF EXISTS tenant_insert ON public.plan_instrument;
DROP POLICY IF EXISTS tenant_update ON public.plan_instrument;
DROP POLICY IF EXISTS tenant_delete ON public.plan_instrument;
CREATE POLICY tenant_select ON public.plan_instrument FOR SELECT
  USING (app.is_platform() OR authority_id IS NULL OR status = 'gazetted' OR authority_id = ANY (app.visible_authorities()));
CREATE POLICY tenant_insert ON public.plan_instrument FOR INSERT
  WITH CHECK (app.is_platform() OR (authority_id IS NOT NULL AND authority_id = app.authority_id()));
CREATE POLICY tenant_update ON public.plan_instrument FOR UPDATE
  USING (app.is_platform() OR (authority_id IS NOT NULL AND authority_id = app.authority_id()))
  WITH CHECK (app.is_platform() OR (authority_id IS NOT NULL AND authority_id = app.authority_id()));
CREATE POLICY tenant_delete ON public.plan_instrument FOR DELETE
  USING (app.is_platform() OR (authority_id IS NOT NULL AND authority_id = app.authority_id()));

-- Everything that hangs off a plan follows its plan: readable if the plan is, writable if the plan is the
-- caller's own. (The parent lookup is itself subject to plan_instrument's policy.)
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('plan_zone_type',          'plan_instrument_id', FALSE),
      ('land_use_groups',         'plan_instrument_id', TRUE),    -- legacy shared rows have no plan: readable by all, writable by platform
      ('zone_land_use_controls',  'plan_instrument_id', FALSE),
      ('plan_event',              'plan_instrument_id', FALSE),
      ('plan_signoff',            'plan_instrument_id', FALSE),
      ('parcel_zoning',           'plan_instrument_id', FALSE),
      ('proposed_peri_urban_zones','plan_instrument_id', FALSE)
    ) AS v(tbl, col, null_ok)
  LOOP
    IF to_regclass('public.' || t.tbl) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_select ON public.%I', t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_write ON public.%I', t.tbl);
    EXECUTE format($f$CREATE POLICY tenant_select ON public.%1$I FOR SELECT USING (
        %3$s EXISTS (SELECT 1 FROM public.plan_instrument i WHERE i.id = %1$I.%2$I))$f$,
      t.tbl, t.col, CASE WHEN t.null_ok THEN format('%I IS NULL OR', t.col) ELSE '' END);
    EXECUTE format($f$CREATE POLICY tenant_write ON public.%1$I FOR ALL
        USING (app.is_platform() OR EXISTS (SELECT 1 FROM public.plan_instrument i WHERE i.id = %1$I.%2$I AND i.authority_id = app.authority_id()))
        WITH CHECK (app.is_platform() OR EXISTS (SELECT 1 FROM public.plan_instrument i WHERE i.id = %1$I.%2$I AND i.authority_id = app.authority_id()))$f$,
      t.tbl, t.col);
  END LOOP;
END $$;

-- Tables that reach their plan through another table.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('plan_zone_type_class',  'plan_zone_type_id', 'plan_zone_type'),
      ('plan_zone_standard',    'plan_zone_type_id', 'plan_zone_type'),
      ('land_use_group_class',  'land_use_group_id', 'land_use_groups')
    ) AS v(tbl, col, parent)
  LOOP
    IF to_regclass('public.' || t.tbl) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_select ON public.%I', t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_write ON public.%I', t.tbl);
    EXECUTE format($f$CREATE POLICY tenant_select ON public.%1$I FOR SELECT USING (
        EXISTS (SELECT 1 FROM public.%3$I p WHERE p.id = %1$I.%2$I))$f$, t.tbl, t.col, t.parent);
    -- writable when the parent row is writable by the caller: it is visible AND its plan is the caller's own
    EXECUTE format($f$CREATE POLICY tenant_write ON public.%1$I FOR ALL
        USING (app.is_platform() OR EXISTS (SELECT 1 FROM public.%3$I p JOIN public.plan_instrument i ON i.id = p.plan_instrument_id
                                              WHERE p.id = %1$I.%2$I AND i.authority_id = app.authority_id()))
        WITH CHECK (app.is_platform() OR EXISTS (SELECT 1 FROM public.%3$I p JOIN public.plan_instrument i ON i.id = p.plan_instrument_id
                                              WHERE p.id = %1$I.%2$I AND i.authority_id = app.authority_id()))$f$, t.tbl, t.col, t.parent);
  END LOOP;
END $$;

-- Permits. Staff see their authority's (and a combination's); a citizen sees their own; creating one is
-- for the owning authority or for the citizen lodging it.
ALTER TABLE spatial_planning.permit_application ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_select ON spatial_planning.permit_application;
DROP POLICY IF EXISTS tenant_insert ON spatial_planning.permit_application;
DROP POLICY IF EXISTS tenant_update ON spatial_planning.permit_application;
DROP POLICY IF EXISTS tenant_delete ON spatial_planning.permit_application;
CREATE POLICY tenant_select ON spatial_planning.permit_application FOR SELECT
  USING (app.is_platform() OR authority_id = ANY (app.visible_authorities()) OR created_by = app.user_id());
CREATE POLICY tenant_insert ON spatial_planning.permit_application FOR INSERT
  WITH CHECK (app.is_platform() OR authority_id = app.authority_id() OR created_by = app.user_id());
CREATE POLICY tenant_update ON spatial_planning.permit_application FOR UPDATE
  USING (app.is_platform() OR authority_id = app.authority_id() OR created_by = app.user_id())
  WITH CHECK (app.is_platform() OR authority_id = app.authority_id() OR created_by = app.user_id());
CREATE POLICY tenant_delete ON spatial_planning.permit_application FOR DELETE
  USING (app.is_platform() OR authority_id = app.authority_id());

ALTER TABLE spatial_planning.permit_rule_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_select ON spatial_planning.permit_rule_snapshot;
DROP POLICY IF EXISTS tenant_write ON spatial_planning.permit_rule_snapshot;
CREATE POLICY tenant_select ON spatial_planning.permit_rule_snapshot FOR SELECT
  USING (EXISTS (SELECT 1 FROM spatial_planning.permit_application p WHERE p.id = permit_rule_snapshot.permit_id));
CREATE POLICY tenant_write ON spatial_planning.permit_rule_snapshot FOR ALL
  USING (app.is_platform() OR EXISTS (SELECT 1 FROM spatial_planning.permit_application p WHERE p.id = permit_rule_snapshot.permit_id
                                        AND (p.authority_id = app.authority_id() OR p.created_by = app.user_id())))
  WITH CHECK (app.is_platform() OR EXISTS (SELECT 1 FROM spatial_planning.permit_application p WHERE p.id = permit_rule_snapshot.permit_id
                                        AND (p.authority_id = app.authority_id() OR p.created_by = app.user_id())));

-- 5. Views must run with the CALLER's rights, or they would show rows the policies hide.
ALTER VIEW public.plan_instrument_summary SET (security_invoker = true);
ALTER VIEW public.zone_effective_controls SET (security_invoker = true);
DO $$ BEGIN
  IF to_regclass('spatial_planning.v_application_summary') IS NOT NULL THEN
    ALTER VIEW spatial_planning.v_application_summary SET (security_invoker = true);
  END IF;
END $$;

COMMIT;
