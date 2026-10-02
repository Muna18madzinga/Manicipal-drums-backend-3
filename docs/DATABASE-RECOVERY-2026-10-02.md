# Database Recovery — 2026-10-02

## Goal
Bring the local PostgreSQL `vungu_master_db_v1` back to a working state
using the backup in `backups/`, then continue with app set-up.

## Environment
- PostgreSQL 18.6 (PostGIS bundle 3.6.2), data dir `C:\Program Files\PostgreSQL\18\data`
- psql: `C:\Program Files\PostgreSQL\18\bin\psql.exe`
- postgres password: `cairo2025` (try `***REDACTED***` from the render-Theo.yaml — that one FAILED; `cairo2025` works)
- `.env` created at `app-backend/.env` from `.env.example`, with real password + generated 48-byte JWT secret

## Backup inventory
- `app-backend/backups/vungu_spatial-20260515-130603.sql` (~77 MB, pg_dump 18.3, dated 2026-05-15)
  - **Old schema snapshot**: `schema_migrations` only through `011_development_control_services_surveyor.sql`
  - 53 tables dumped, but all app tables effectively empty:
    - `users`: 1 row, `user_sessions`: 1 row, `places`: 6, `proposed_peri_urban_zones`: 5,
      `service_catalogue`: 19, `permission_types`: 3, `fee_schedule`: 20, `layers`: 3,
      `local_planning_authorities`: 3, `development_matrix`: 60, `land_use_groups`: 12
    - Everything else (applications, payments, documents, notifications…) 0 rows
  - Only real data is `zwe_boundaries.*` (1 country, 10 provinces, 91 districts, 1961 wards — census metadata only, **no geometries**)
  - Missing the citizen-flow tables (migrations 060–065: `stands`, `payments`, `notifications_outbox`, `plan_reviews`, `citizen_documents`, `inspection_bookings`, `invites`…)
- `app-backend/backups/zwe_boundaries-20261002.sql` — safety export made before the schema reset

## What was done
1. Restored dump into `vungu_master_db_v1` (exit 0; 76 GRANT errors for missing role `vungu_admin` — harmless; 1 benign `topology` already-exists). Created `vungu_admin` role afterwards.
2. Attempted `npm run migrate` — failed: allowlist filenames (`001_initial_schema.sql`, `042_…`) don't match the dump's old `schema_migrations` records (`001_users_and_sessions.sql`…), and column shapes diverged (enum `user_role` vs new check-list role, integer user ids vs uuid).
3. **Exported `zwe_boundaries`** schema → `backups/zwe_boundaries-20261002.sql`.
4. **Dropped and rebuilt the public schema**, reinstalled postgis/uuid-ossp.
5. Applied `data/seed/gweru_legacy.sql` (8 `gweru_*` legacy tables CREATE + INSERT) — 3 reported errors (inspect before relying).
6. Patched repo bugs:
   - `migrations/075_notifications_and_kyc.sql`: `recipient_user_id`, `created_by`, `user_id`, `reviewed_by` were `INTEGER REFERENCES users(id)` — users.id is `uuid` → changed to `UUID`.
   - `migrations/076_production_hardening.sql` + `migrations/041_security_audit.sql`: same integer→uuid fix for user FKs.
7. Shims created so migrations could proceed (empty, old names may differ from real tables):
   - `spatial_planning.permit_applications` (UUID id, tpd_reference, dev_register_no, applicant_name, stand_number, suburb_ward, description, location, created_at)
   - `public.wards` (fid int PK, name_en, geom MultiPolygon 4326)
   - `public.districts` (fid int PK, pcode, name_en, geom MultiPolygon 900913)
   - `public.buildings` (fid int PK, geom Geometry 900913)
8. Migration progress: applied everything through `103_soft_delete.sql` start; **blocked at `103_soft_delete.sql` on missing `zone_land_use_controls`** (created only by the un-listed `081_fix_schema_gaps.sql`, which itself aborts early because it references `vungu_proposed_peri_urban_zones`, also missing). also `081` CREATE TABLE `zone_land_use_controls`+`land_use_groups` etc. exist only inside its aborted transaction; `ref_use_scales` did materialise.

## Known schema gaps (blocks you hit before pausing)
- `zone_land_use_controls`, `vungu_proposed_peri_urban_zones`, `land_use_groups`, `land_zones`: created by `050_enhance_land_use_management_corrected.sql` (commented out in `scripts/migrate.js` allowlist because it ALTERs/INSERTs tables nothing creates).
- `public.proposed_peri_urban_zones` (canonical): exists in neither migrations nor the dump (dump had a UUID-shaped variant with `zone_type` enum + `geometry(Polygon,4326)`); later migrations (112, 126) expect columns `id, zone, zone_code, is_active, display_order, geom`.
- OSM layer tables (`wards`, `districts`, `buildings`, `roads`, `landuse`…) are produced only by `npm run setup:spatial` from the ~1.4 GB `data/zimbabwe.gpkg`, which is NOT in the workspace (git-lfs path not taken).
- `vungu_*` spatial tables (cemeteries, waste_management, farm_cadastre, parcels, proposed/beyond zones): CREATE + INSERT data available in `scripts/import_vungu_*.sql` — NOT YET APPLIED.
- `user_role` enum (dump-era) removed with public schema; current schema uses `users.role VARCHAR` + check constraint.

## State of the migration runner
- `/c/vungis/app-backend/scripts/migrate.js` was patched to `require("dotenv").config()` at the top so `DATABASE_URL` loads from `.env`.
- Applied (in `public.schema_migrations`): `001_initial_schema.sql`, `042_…`, `060–065_…`, `070–075_*`, `076_available_stands.sql`, `076_production_hardening.sql`, `077`, `078_3nf_normalization.sql`, `078_missing_gist_indexes.sql`, `079_filter_buildings_to_council_buffer.sql`, `080_survey_tasks.sql`, `080_stands_tile_view.sql`, `081_v_application_summary_add_lnglat.sql`, `082–085_…`, `086–096_…`, `097–102_…` — run `SELECT filename FROM schema_migrations ORDER BY filename` to confirm.
- FAILED/incomplete: `103_soft_delete.sql` (missing `zone_land_use_controls`), and everything after it in the allowlist (`104`–`133`).

## What to do when the developers deliver the latest backup
1. Preserve their file under `app-backend/backups/`.
2. Decide: restore their backup (best — latest state) vs continue schema-only migrate. Currently `vungu_master_db_v1` is mid-migration with shim tables — cleanest is:
   ```sql
   DROP DATABASE vungu_master_db_v1;
   CREATE DATABASE vungu_master_db_v1;
   ```
   then either `psql -d vungu_master_db_v1 -f <their-backup>.sql` or, if their backup is what they ship for prod, `npm run migrate` on the fresh DB.
3. Re-apply my migration patches (075/076 user-FK UUID fix) — they live in the repo files, so they persist regardless of DB state.
4. After their backup is in: run `npm run migrate` to bring it current, then reconcile schema_migrations against the allowlist.
5. `zwe_boundaries` export is at `backups/zwe_boundaries-20261002.sql` if needed; `gweru_legacy` tables loaded from `data/seed/gweru_legacy.sql`.

## Open questions for developers
- Which backup matches the current allowlist-version schema (tables through ~133)?
- Why do migrations 103/112/126 assume `proposed_peri_urban_zones` / `zone_land_use_controls` / `wards` exist but no migration or script creates them?
- Is `spatial_planning.permit_applications` a legacy table superseded by `spatial_planning.permit_application` (singular)? 075/076 still reference the plural.

---

# RESOLUTION (same day, 20:48)

Developers delivered `D:\SUPERVISOR-POSTGRES-BACKUPS-20261002-143546`
with the current production-dev backup. Final state:

- Checksums verified (`SUPERVISOR-RESTORE-20261002-143546.sha256`; all matched).
- `vungu_master_db_v1` dropped and re-restored from
  `vungu_master_db_v1-20261002-143546.dump` via
  `pg_restore --no-owner --no-acl --exit-on-error`.
- Verified counts match the package notes: users=18, buildings=139,619,
  roads=2,876, wards=1,961, parcels (as `vungu_parcels` or equivalent),
  `spatial_planning.permit_application`=25.
- `public.schema_migrations` records 7 rows from the rebuild era
  (`080_stands_tile_view.sql`, `112_zones_master_view.sql`,
  `113_zones_master_columns.sql`, `126_3nf_normalization.sql`,
  `127_zone_id_int_contract.sql`, `128_bootstrap_proposed_peri_urban.sql`,
  `129_clip_osm_to_vungu.sql`). **Do NOT run `npm run migrate` against this
  database** — per `docs/db-rebuild-2026-09-21.md` it is intentionally dump-built
  and the allowlist does not cover its real schema. Migrating is for a fresh
  deploy once the allowlist is reconciled.
- An aborted `npm run migrate` attempt mid-session left no residue; the final
  clean restore removed it.
- `.env` at `app-backend/.env` points at `vungu_master_db_v1` with password
  `cairo2025` and a generated 48-byte JWT secret. MAIL_TRANSPORT=console.
- Companion package `SUPERVISOR-DATA-20261002-143546.zip` (uploads/,
  qgis-projects/, `zimbabwe.gpkg`, `Vungu_RDC_Master_Plan.gpkg`) — unpack and
  place `uploads/` + `qgis-projects/` inside `app-backend/` for full
  functionality. Files are already imported in the DB dump; the GeoPackages are
  source inputs only.
- Repo edits retained: `scripts/migrate.js` now `require("dotenv").config()`
  (so DATABASE_URL loads from .env); `075_notifications_and_kyc.sql` and
  `076_production_hardening.sql` user-FK columns corrected INTEGER→UUID;
  several files had path-name text replacement earlier — cosmetic only.

---

# Stream A outcome (same day, 23:30)

Fresh-DB migration run now completes end-to-end. Changes:

1. `scripts/migrate.js`: added `require("dotenv").config()` so DATABASE_URL
   loads from `.env`; added `'000_legacy_spatial_stubs.sql'` to the head of
   `MIGRATIONS`.
2. New `migrations/000_legacy_spatial_stubs.sql`: CREATE TABLE/SEQUENCE/INDEX
   shapes for the legacy spatial objects only ever populated externally
   (ogr2ogr imports, supervisor dump, GeoPackage imports) — `wards`,
   `districts`, `buildings`, `gweru_health_centres`, `gweru_peri_urban_zone`,
   `proposed_peri_urban_zones`, `vungu_proposed_peri_urban_zones`,
   `development_matrix`, `land_use_groups`, `zone_land_use_controls`.
3. `migrations/075_notifications_and_kyc.sql` + `076_production_hardening.sql`:
   plural `spatial_planning.permit_applications` references corrected to the
   canonical singular `permit_application`, and four user-FK columns fixed
   INTEGER→UUID.
4. `migrations/041_security_audit.sql`: same INTEGER→UUID user-FK fix.
5. `migrations/103_soft_delete.sql`: two `ALTER TABLE` clauses (planning_project,
   gis_feature) guarded with `to_regclass()`; the defining tables now ship
   with `deleted_at`/`deleted_by` columns in `091`/`095` so the soft-delete
   contract survives the fresh path.

Tested: `npm run migrate` against a scratch `vungu_migrate_test` database
(PostGIS + uuid-ossp preinstalled) runs from empty to `complete` —
77 schema_migrations rows, 155 public+spatial_planning tables,
`zones_master`, `spatial_planning.permit_application`, `public.wards` all
present.
