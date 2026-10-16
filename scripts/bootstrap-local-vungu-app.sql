-- Bootstrap application role for local DBs restored from dumps that pre-date
-- migration 154 (TENANCY_MODE=strict requires SET ROLE vungu_app).
-- Safe to re-run. Does not enable RLS policies — apply 154+ for full contract.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN
    CREATE ROLE vungu_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT vungu_app TO CURRENT_USER;

CREATE SCHEMA IF NOT EXISTS app;

CREATE OR REPLACE FUNCTION app.user_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app.authority_id() RETURNS integer LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.authority_id', true), '')::integer $$;
CREATE OR REPLACE FUNCTION app.is_platform() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(current_setting('app.platform', true), '') = 'on' $$;

DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['public', 'app', 'spatial_planning', 'gis_ops', 'land'] LOOP
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO vungu_app', s);
      IF s <> 'app' THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO vungu_app', s);
        EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO vungu_app', s);
      END IF;
    END IF;
  END LOOP;
  EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO vungu_app';
END $$;
