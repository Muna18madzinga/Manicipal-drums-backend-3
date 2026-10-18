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

-- Staff auth (jwtAuth) selects these tenancy columns; older dumps lack them.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS authority_id integer;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_platform boolean NOT NULL DEFAULT false;

-- Quiet email / GMS workers on thin restores (full schema comes from later migrations).
CREATE TABLE IF NOT EXISTS public.admin_setting (
  key text PRIMARY KEY,
  value text,
  value_type text NOT NULL DEFAULT 'string',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE SCHEMA IF NOT EXISTS integration;
CREATE TABLE IF NOT EXISTS integration.outbox_event (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text,
  version int NOT NULL DEFAULT 1,
  source text,
  idempotency_key text UNIQUE,
  payload jsonb,
  status text NOT NULL DEFAULT 'pending',
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  reply jsonb,
  acknowledged_at timestamptz
);
GRANT USAGE ON SCHEMA integration TO vungu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA integration TO vungu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.admin_setting TO vungu_app;
