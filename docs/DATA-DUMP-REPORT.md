# Can the database be rebuilt from the repo? — Dump availability report

Status: generated audit · Live DB `vungu_master_db_v2` (~1.94 GB) · Backend `main`

## TL;DR

**No.** A fresh clone + `npm run migrate` + `setup-spatial.mjs` cannot reproduce the
live database. Of the ~1.94 GB, **~1.82 GB (94%) of data — all OSM basemap tables —
has no restorable source in the repo**. The two GeoPackages everything pivots on are
external-only with **no configured download URL**. Only ~3 MB of tracked SQL matches
the live DB exactly.

---

## 1. What data lives in the DB (live, `vungu_master_db_v2`)

Total DB: **1,943,882,899 B ≈ 1.94 GB**.

| Group | Bytes | Rows | Source |
|---|---|---|---|
| OSM basemap (24 tables incl. `wards`) | **1,816.9 MB** | 6,028,968 | `data/zimbabwe.gpkg` ⚠️ external |
| Vungu master-plan (`vungu_*`) | 1.2 MB | 1,439 | `Vungu_RDC_Master_Plan.gpkg` ⚠️ external (but re-covered by tracked SQL) |
| Gweru legacy (`gweru_*`) | 1.7 MB | 1,064 | `data/seed/gweru_legacy.sql` ✅ tracked |
| Zone / land-use refs | 0.7 MB | 944 | partial tracks, see §4 |

### Bulk analysis — 88% is two tables

| Table | Rows | Table+indexes |
|---|---|---|
| `buildings` | 5,743,166 | **1,578.8 MB** |
| `roads` | 210,240 | **134.8 MB** |
| `wards` | 1,961 | 30.2 MB (small table, huge GiST index) |
| `waterways` | 14,905 | 25.0 MB |
| `water_areas` | 8,661 | 14.9 MB |
| `landuse` | 23,708 | 10.2 MB |
| `districts` / `provinces` / boundaries | ~200 | ~12 MB |
| all other OSM layers | — | < 3 MB each |

`buildings` + `roads` = **1,713.6 MB = 88% of the DB**.

### Canonical dump-only / legacy (small, but critical):

- `proposed_peri_urban_zones` — 37 rows (0.1 MB) — **the canonical zones table**
- `gweru_*` — 1,064 rows total (1.7 MB): rural_farms 672, rivers 260, peri_urban_zone 43, business_centres 67, beyond 16, chiefdoms 5, planning_boundary 1
- zones/land-use refs — 944 rows (0.7 MB): development_matrix 835, land_use_groups 65, zone_land_use_controls 4, permission_types 3
- `vungu_*` — 1,439 rows (1.2 MB): parcels 733, farm_cadastre 687, beyond 16, cemeteries 1, waste 2

---

## 2. What is tracked in git (restorable today)

| Path | Size | Restores |
|---|---|---|
| `backups/vungu_spatial-20260515-130603.sql` | **77.1 MB** ✅ tracked | `zwe_boundaries.adm0–3` (all ZW admin boundaries, ~73 MB of geometry), **stale** subsets: 5/37 zones, 12/65 land_use_groups, 60/835 matrix. No OSM data. |
| `data/seed/gweru_legacy.sql` | 1.3 MB ✅ | `gweru_*` — **exact live match** (full pg_dump, CREATE + COPY) |
| `scripts/import_vungu_*.sql` (6 files) | ~1.7 MB ✅ | `vungu_*` — **exact live match** (INSERTs with WKB geometry) |
| `scripts/import_vungu_proposed_peri_urban_zones.sql` | 36 KB ✅ | 36 rows legacy zones import (table since dropped) |
| `migrations/attic/050_*.sql`, `insert_sample_land_use_groups.sql` | small ✅ | partial zone/land-use reference content |

Tracked usable (non-backup) data ≈ **3.0 MB**; plus the stale 77 MB backup.

---

## 3. What blocks a fresh deploy

### ⚠️ The two GeoPackages are external-only

- `data/zimbabwe.gpkg` (~1.47 GB) — **absent** from working tree, git, and Git LFS.
  - `.gitignore` `data/*.gpkg` (lines 47–49); `.gitattributes` says "gpkg no longer tracked — fetch with `download-spatial-source.mjs`".
  - **`ZIMBABWE_GPKG_URL` / `VUNGU_GPKG_URL` are not set anywhere** — not in `.env`, `.env.example`, README, or docs. The download helper has no working URL.
  - README's `git lfs pull` instruction is stale: **no LFS objects exist** (no `.git/lfs/`, `git lfs ls-files` empty).
- `data/Vungu_RDC_Master_Plan.gpkg` — also external, but its output is re-covered by the tracked `import_vungu_*.sql` files, so not blocking.

**Effect:** `setup-spatial.mjs` fails at step 2/5 ("Missing or not LFS-pulled: data/zimbabwe.gpkg"). Fresh environments get **no `wards`, no OSM tiles** — the map is empty.

### ⚠️ Live zone/land-use reference content not reconstructible

The live `proposed_peri_urban_zones` (37 rows), `development_matrix` (835), `land_use_groups` (65) are **not captured by any complete tracked dump**: the 77 MB backup holds only stale subsets. These must be preserved (new `pg_dump` or CONFIRMED seed SQL) or a fresh `development-control`/zone UI breaks (see `docs/SSOT-database.md` concept #10).

### Repo-hygiene contradictions (FYI)

- `node_modules/` and `backups/` are `.gitignore`d **yet tracked** (the 77 MB backup is the largest file in the repo; `node_modules/@esbuild/win32-x64/esbuild.exe` 11.4 MB is second). Gitignore only affects untracked files.
- README claims Git LFS for gpkg — no LFS exists in this checkout.

---

## 4. Verdict: what is committable now, what is missing

| Data | Restorable from repo? | Action needed |
|---|---|---|
| `gweru_*` legacy | ✅ exact (1.7 MB tracked) | none |
| `vungu_*` master-plan | ✅ exact (1.2 MB tracked) | none |
| ZW admin boundaries | 🟡 only as stale `zwe_boundaries.*` (73 MB backup), wrong target schema vs live `public.wards` | regenerate `public.*` dump |
| zones + land-use refs (37/65/4/835) | ❌ partial only | **new `pg_dump`** of these tables |
| **OSM basemap (1.82 GB, 6.03M rows)** | ❌ **none** | **get `zimbabwe.gpkg`**; publish a URL or commit an LFS/cloud object, document it in `.env.example` + README |

---

## 5. Recommended minimal fix ladder

1. **Preserve today's truth** (cheap, immediate):
   ```bash
   pg_dump -h localhost -U postgres -d vungu_master_db_v2 \
     -t 'public.proposed_peri_urban_zones' -t 'public.development_matrix' \
     -t 'public.land_use_groups' -t 'public.zone_land_use_controls' \
     -t 'public.permission_types' -t 'public.wards' \
     > backups/reference-dump-2026-09-22.sql
   ```
   (add `-t 'public.*'` for the OSM tables once the gpkg is lost-proofed; buildings-only dump ≈ 1.6 GB.)
2. **Publish the gpkg URL** and set `ZIMBABWE_GPKG_URL`/`VUNGU_GPKG_URL` in `.env.example`; or store `zimbabwe.gpkg` on a private host / S3 and document the fetch + verify (sha256) in README.
3. **Reconcile `development_matrix` schema** to the runtime code (`zone_id/group_id/permission_code`) — concept #10 in `docs/SSOT-database.md`.
4. Optionally remove tracked-but-ignored noise (`node_modules/`, stale 77 MB backup) to shrink the repo (separate concern from data availability; see SSOT report §Phantom/legacy).