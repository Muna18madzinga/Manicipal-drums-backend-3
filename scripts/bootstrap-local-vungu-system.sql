-- Local-only: create vungu_system privilege group when full migration 168
-- cannot run (tenancy schema missing on older local DBs). Safe / idempotent.
-- Then: node scripts/create-runtime-role.js --apply

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_system') THEN
    CREATE ROLE vungu_system NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

DO $$
DECLARE s record;
BEGIN
  EXECUTE format('GRANT CONNECT, TEMPORARY, CREATE ON DATABASE %I TO vungu_system', current_database());
  FOR s IN SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema' LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO vungu_system', s.nspname);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO vungu_system', s.nspname);
    EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO vungu_system', s.nspname);
    EXECUTE format('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA %I TO vungu_system', s.nspname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vungu_system', s.nspname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO vungu_system', s.nspname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO vungu_system', s.nspname);
  END LOOP;
END $$;

-- If tenancy exists, keep contract tables owner-only for writes.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'tenancy') THEN
    REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tenancy FROM vungu_system;
    ALTER DEFAULT PRIVILEGES IN SCHEMA tenancy REVOKE INSERT, UPDATE, DELETE ON TABLES FROM vungu_system;
  END IF;
END $$;
