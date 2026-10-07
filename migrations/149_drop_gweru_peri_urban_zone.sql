-- 149_drop_gweru_peri_urban_zone.sql
-- ─────────────────────────────────────────────────────────────────────────
-- public.gweru_peri_urban_zone: a legacy copy of another council's peri-urban zones. No
-- migration creates it; no view, foreign key, function or application code uses it. Dropped
-- at the project lead's instruction (2026-10-07) after a dump of its 43 rows was taken
-- (backups/gweru_peri_urban_zone-2026-10-07.sql, outside version control).
-- A database that never had the table is unaffected.

BEGIN;
DROP TABLE IF EXISTS public.gweru_peri_urban_zone;
COMMIT;
