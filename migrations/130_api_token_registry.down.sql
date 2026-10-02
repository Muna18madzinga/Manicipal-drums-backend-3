-- Rollback for 130_api_token_registry.sql. Not in the migrate.js allowlist:
-- apply by hand only. After it runs, every API token is rejected (no registry
-- row can be found) until 130 is re-applied and tokens are reissued.
BEGIN;
DROP TABLE IF EXISTS public.api_token;
DELETE FROM schema_migrations WHERE filename = '130_api_token_registry.sql';
COMMIT;
