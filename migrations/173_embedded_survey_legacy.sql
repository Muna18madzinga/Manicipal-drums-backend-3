-- 173: the embedded Survey Task Manager becomes legacy; surveying belongs to SurveyPro.
--
-- Decision (2026-10-09): SurveyPro (a separate product with its own database and per-surveyor schemas) is the system of record for
-- survey working data. VunGIS keeps what the authority owns: the survey JOBS it assigns (spatial_planning.survey_task and its
-- records, tenant data since migration 169) and the deliverables handed back. docs/SURVEYPRO-INTEGRATION.md is the contract.
--
-- The copy of SurveyPro embedded in VunGIS (src/survey, mounted at /api/survey) is frozen. It never ran as the request plane: its own
-- connection pool is the system plane, so closing its tables to the application role (vungu_app) changes nothing it does today,
-- and says what is true. Cutover is switching the module off (EMBEDDED_SURVEY=off in server.js), not another migration.
--
--   survey.*        classified `system` (no access for vungu_app); the 20 relations that were `pending`.
--   surveyor_<x>.*  the per-surveyor schemas the embedded module creates at run time. The tenancy guard excludes them (they cannot be
--                   listed in advance), which left them outside the contract altogether. tenancy.surveyor_schema_access now lists
--                   any way the application role or a direct client could reach them; it must stay empty (scripts/verify-tenancy.js).

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT relation FROM tenancy.relation_class WHERE relation LIKE 'survey.%' AND class = 'pending' LOOP
    IF to_regclass(r.relation) IS NOT NULL THEN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN EXECUTE format('REVOKE ALL ON %s FROM vungu_app', r.relation); END IF;
    END IF;
    PERFORM tenancy.classify(r.relation, 'system', 'embedded Survey Task Manager, frozen: surveying moved to SurveyPro (migration 173)');
  END LOOP;
  IF to_regnamespace('survey') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vungu_app') THEN
    EXECUTE 'REVOKE USAGE ON SCHEMA survey FROM vungu_app';
  END IF;
END $$;

CREATE OR REPLACE VIEW tenancy.surveyor_schema_access AS
  SELECT n.nspname::text AS schema_name, 'schema'::text AS kind, NULL::text AS relation, r.rolname::text AS role_name
    FROM pg_namespace n
    CROSS JOIN (VALUES ('vungu_app'), ('tenancy_reader'), ('tenancy_author')) AS r(rolname)
   WHERE n.nspname LIKE 'surveyor\_%'
     AND EXISTS (SELECT 1 FROM pg_roles x WHERE x.rolname = r.rolname)
     AND has_schema_privilege(r.rolname, n.oid, 'USAGE')
  UNION ALL
  SELECT n.nspname::text, 'relation'::text, c.relname::text, r.rolname::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (VALUES ('vungu_app'), ('tenancy_reader'), ('tenancy_author')) AS r(rolname)
   WHERE n.nspname LIKE 'surveyor\_%'
     AND c.relkind IN ('r', 'p', 'v', 'm')
     AND EXISTS (SELECT 1 FROM pg_roles x WHERE x.rolname = r.rolname)
     AND (has_table_privilege(r.rolname, c.oid, 'SELECT') OR has_table_privilege(r.rolname, c.oid, 'INSERT')
          OR has_table_privilege(r.rolname, c.oid, 'UPDATE') OR has_table_privilege(r.rolname, c.oid, 'DELETE'));

COMMENT ON VIEW tenancy.surveyor_schema_access IS
  'Ways the application role or a direct client can reach a per-surveyor schema. Must be empty: those schemas belong to the embedded survey module (system plane) and, in time, to SurveyPro.';
