-- 168: the application stops connecting as the database owner.
--
-- Until now the server connected as `postgres`, a superuser, so row-level security applied only where code remembered to ask for it
-- (the tenant pool, or since 167 the contextual connection). With a superuser underneath, one forgotten path sees every authority.
--
-- This migration defines what a NON-superuser runtime login may do; the login itself (it needs a password) is created by
-- scripts/create-runtime-role.js and joins this group:
--
--   vungu_system   NOLOGIN privilege group: read and write the data tables, use sequences, run functions, create schemas
--                  (the survey tool makes a schema per surveyor). It owns nothing and cannot change table structure, create roles,
--                  load extensions or read pg_authid: that stays with the owner, who runs migrations.
--   vungu_runtime  the LOGIN (created by the script): member of vungu_system and of vungu_app, NOSUPERUSER, BYPASSRLS.
--                  Requests are scoped by SET ROLE vungu_app (no bypass); BYPASSRLS applies only to the system plane
--                  (systemOf(fastify.pg): sign-in, audit log, notifications, jobs), which is the short reviewed list.
--
-- The privileges are the broad set the application needs. What the tenant plane may do is still decided by vungu_app and the
-- contract (165); this group only replaces "superuser" with "exactly the data privileges".

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
    -- what the owner creates later is usable too, without another migration
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vungu_system', s.nspname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO vungu_system', s.nspname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT EXECUTE ON FUNCTIONS TO vungu_system', s.nspname);
  END LOOP;
END $$;

-- the contract's own tables are the owner's to change; the runtime may read them (the application reports on them) but not edit
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA tenancy FROM vungu_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA tenancy REVOKE INSERT, UPDATE, DELETE ON TABLES FROM vungu_system;
