# Database rebuild, 2026-09-21

`Vungu_spatial333` had two corrupt relations: `pg_depend` (the system catalog,
relation 2608, block 121) and `public.inspection_bookings` (block 0). The
first broke `information_schema`, most DDL and `pg_dump`, so the damage could
not be worked around — it had to be left behind.

Rebuilt as **`Vungu_spatial334`**. `DATABASE_URL` now points at it.

## Why not replay the migrations

The original plan was to replay all 78 migration files onto an empty
database. That is not possible here:

- `scripts/migrate-render.js` drives an explicit ordered allowlist, and it
  lists only **54 of the 78** files.
- The 24 unlisted files include `000_multi_tenant_schema.sql`,
  `001_admin_schema.sql`, `002_phase2_schema.sql` and **116–122** — the
  inspector work queue, stage-inspection field events, inspector site
  geometry, permit document uploads, building complaints and both
  environmental-health migrations.
- Five migration numbers collide from parallel histories: two each of `078`,
  `079`, `080`, `081`, `082`.
- `050_enhance_land_use_management_corrected.sql` is documented in the runner
  as broken and deliberately skipped.

There is no canonical order to replay, and inventing one risks a schema that
silently disagrees with the application.

## What was done instead

`pg_dump` normally fails here because its table query LEFT JOINs `pg_depend`.
Under `zero_damaged_pages=on` it skips the damaged page and succeeds. That
setting only zeroes the page in the reading backend's memory; a dump writes
nothing to the source, and the source was confirmed still damaged afterwards
(see Fallbacks).

1. `pg_basebackup` of the whole cluster — online, no downtime, no elevation.
   The original plan said to stop the service and copy the data directory;
   this account is not an administrator, and a base backup is the better
   tool anyway.
2. Schema dumped under `zero_damaged_pages`: 163 tables, 16 views, 38
   functions, 323 indexes, 138 `OWNED BY` clauses.
3. Data dumped the same way, custom format, excluding extension-managed
   tables (`spatial_ref_sys`, `tiger.*`, `tiger_data.*`, `topology.*`) which
   the target's extensions recreate and which would otherwise collide.
4. New database created from `template0`; schema restored, then data with
   `--disable-triggers` (pg_dump warned of circular foreign keys on
   `case_message`, `generated_document` and `surveyor_profiles`).
5. All 89 owned sequences reset to `max(id)`.

## Two things the verification caught

**SRID 900914 was missing, and would have broken every map.** Excluding
`spatial_ref_sys` as extension-managed dropped the council's one custom SRID
— the one `src/config/spatialLayers.js` uses for all 24 tile layers. A fresh
PostGIS install has 8500 rows; the old database had 8501. It was copied
across by hand, and the row-count gate now matches. **Anyone repeating this
must re-check that table**: excluding it is correct for the extension's own
rows and wrong for a custom SRID.

**Four extensions did not install**, because their shared libraries fail to
load on this machine: `postgis_raster`, `postgis_sfcgal`, `ogr_fdw` and
`h3_postgis`. Tested against the *old* database rather than assumed:

| Extension | In `Vungu_spatial333` | In `Vungu_spatial334` |
| --- | --- | --- |
| `postgis_raster` | already broken | absent |
| `postgis_sfcgal` | already broken | absent |
| `ogr_fdw` | already broken | absent |
| `h3_postgis` | **works** | **absent** |

The first three were already non-functional, so nothing was lost.
`h3_postgis` is a real difference: it works in the old database but cannot be
created in a new one because it requires `postgis_raster`. It is unused —
no calls anywhere in the backend, no column of any h3 type — and the base
`h3` extension is installed, so this was accepted rather than fixed. If h3
support is ever needed, the fix is the missing DLL dependency behind
`postgis_raster-3.dll`, not the database.

## Verification

- `pg_depend` (13,696 rows) and `information_schema.columns` (4,859) both
  read cleanly. They error on the old database.
- A fresh `pg_dump --schema-only` of the new database, taken **without**
  `zero_damaged_pages`, diffs clean against the old one — no missing table,
  view, function or index. The only differences are the four extensions
  above and two index predicates PostgreSQL re-deparsed equivalently.
- Per-table row counts are identical across 161 tables, with one intended
  exception: `inspection_bookings` went from unreadable to 0 rows.
- All 89 owned sequences are at or above their column's maximum; the 15
  unowned sequences restored to their exact previous values.
- Backend boots; `/api/inspection-stages` returns data, and roads and
  provinces tiles return real MVT bytes — which also proves SRID 900914 is
  working.
- `test-tiles-endpoint.js` scores 7/8. The failure (`catalog lists 24 layers
  — got count=31`) is **pre-existing**: the identical failure occurs against
  the old database. It is a stale assertion in the test, not a defect.

## Nothing was lost

`inspection_bookings` restored empty. `pg_class` reported `relpages=0`,
`reltuples=-1` and a single 8 KB page, so it had never been populated. It is
live code, not legacy — `/api/inspections` is built on it and `payments.js`
flips its `fee_paid_at` — so the citizen inspection flow was *erroring*
before this rebuild, and now works against an empty table.

## Fallbacks

Keep both until the system has been tested end to end.

- `Vungu_spatial333` still exists and is untouched. Repoint `DATABASE_URL` to
  roll back; `.env.bak-pre-rebuild-2026-09-21` holds the previous value.
  It still raises `invalid page in block 121` on `pg_depend`, which is the
  confirmation that `zero_damaged_pages` never wrote the zeroed page back.
- `C:\Users\theop\vungu-db-backup-2026-09-21` — `pg_basebackup` of the whole
  cluster, 1.34 GB compressed, gzip integrity verified.
- Working files in `C:\Users\theop\vungu-rebuild`: both schema dumps, the
  data dump, both row-count snapshots and the restore logs.

## Still outstanding

`schema_migrations` was carried across as-is and still records only 23 of the
78 migration files. **This database is not reproducible from
`scripts/migrate-render.js`**, and a fresh Render deploy will not match it
until the allowlist is reconciled. That is the most important follow-up: it
blocks deployment, not local testing.
