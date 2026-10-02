# Workplan — Pilot → Production-Hardened Portal

## Stream A — Migration reproducibility (blocks deployment)
**Goal:** any fresh checkout builds the same schema as the supervisor DB.

1. Inventory: diff the 7 recorded `schema_migrations` rows against the
   `scripts/migrate.js` allowlist (54 of 78 files). Flag entries with real
   conflicts (uuid-vs-int FKs, missing `zone_land_use_controls`,
   `vungu_proposed_peri_urban_zones`, legacy `permit_applications`).
2. Repair conflicting entries:
   - Fix `050_enhance_land_use_management_corrected.sql` (or replace with a
     working equivalent) so `zone_land_use_controls`/`land_use_groups`/
     `land_zones` are created on a fresh DB.
   - Shim or guard tables only created by old lineage
     (`vungu_proposed_peri_urban_zones`, plural `permit_applications`).
   - Keep the UUID-FK patches already applied (`075_notifications_and_kyc.sql`,
     `076_production_hardening.sql`, `041_security_audit.sql`) under source control.
3. Add a CI test that runs `npm run migrate` against a fresh empty
   Postgres+PostGIS DB and asserts every allowlisted file applies.
4. Document the canonical rebuild procedure in `docs/DATABASE-REBUILD.md`.

## Stream B — Style-bridge consolidation (one canonical path)
1. Map the seven `*OGCBridge*/*QGISStyleExtractor*` variants: which are wired
   into `server.js`/routes today, which are dead code.
2. Keep the one used by `gis:symbology:seed` / admin-console routes; ensure it
   handles single/categorised/graduated/rule-based incl. hatch/gradient fills.
3. Move the rest to `src/services/admin/attic/` (or remove); note in `docs/`.
4. Verify: push a sample QGIS project via the bridge and compare MapLibre paint
   output vs `GetLegendGraphic` for a complex rule-based style.

## Stream C — Repo hygiene
1. Move ~25 root-level `test-*.js`, `debug_*.js`, `fix_*.sql` scripts to
   `scripts/attic/` (or delete with history retained).
2. Triage `TODO.md` into a checklist and resolve.
3. Decide the fate of `server-backups/` duplicates.
4. Standardise `.gitignore` so `.env`, logs and machine-local artifacts stay out.

## Stream D — started 2026-10-02
- Design locked at `app-backend/docs/STREAM-D-DESIGN.md`: PMTiles, FlatGeobuf,
  cache-busted version probe, MapLibre continues for editing for now,
  OpenLayers remains a documented second step.
- Backend seam in place:
  - `src/services/staticTiles.js` — detects tippecanoe, builds `.pmtiles`
    to `STATIC_TILE_ROOT` with an `{ok, reason}` contract; FlatGeobuf stub
    documented.
  - `src/routes/staticExports.js` — `GET /api/static/version/:table` (404
    with `no_static_build_for_table`) and `POST /api/static/build/:table`
    (501 `tippecanoe_not_available` when tooling missing), both registered
    and live-probed.
  - `scripts/build-static-pmtiles.mjs` — first-run-verified on `districts
    z0..z6` → valid `.pmtiles` verified with `pmtiles show` (go-pmtiles,
    Windows x86_64 tested). This is the reproducible PMTiles bake path on
    supervisor (tippecanoe unavailable, GDAL 3.9 PMTiles driver read-only).

### Still to do in D
- Bake `.pmtiles` for the admin-boundary set (wards, districts, zones_master)
  at production zooms.
- Serve `public/static/*.pmtiles` via the static file middleware and add the
  cache-busted `version` probe frontend will read.
- Wire the FlatGeobuf path via the same QGIS/OSGeo4W binary discovery used by
  `scripts/setup-spatial.mjs`.
- Frontend: consume `pmtiles://` on the public map explorer for districts with
  fallback to `/api/tiles`.
- Evaluate OpenLayers for the editing workspace (research doc is the
  starting point).

**Order:** A → B → C → D (A unblocks deploy, B unblocks maintenance, C lowers
friction, D is next paper chapter).

---

# Status

## Stream A — done 2026-10-02
- `npm run migrate` tested end-to-end on a scratch database (PostGIS +
  uuid-ossp); see DATABASE-RECOVERY-2026-10-02.md for the full account.
- Do **not** run the allowlist against the supervisor dump-built
  `vungu_master_db_v1`.

## Stream B — done 2026-10-02
- Removed three dead/duplicate bridges:
  `src/services/admin/unifiedOGCBridge.js`, `enhancedOGCBridge.js`,
  `advancedQGISStyleExtractor.js` (via `git rm`). `server.js` boots, all routes
  still register.
- `wfsPublisher.js` no longer requires the dead `../services/ogc/unifiedOGCBridge`
  module (the require path was already missing, and the call was
  dead code); styling extraction there is now handled by the canonical
  refined/perfect path used by `ogcServices.js` + `qgisServer.js` +
  `dynamic-layers.js`.
- Canonical set going forward: `refinedOGCBridge.js`, `perfectQGISStyleExtractor.js`,
  `smartQGISExtractor.js`, `ultimateQGISBridge.js` (all live, all in
  `src/services/admin/`), plus the QGIS-project side of the registry at
  `src/services/gis/{styleRegistry,qgisImport,qgisPublish}.js` used by
  `routes/gisStyles.js`.

## Stream C — done 2026-10-02
- ~30 scratch files (`test-*.js`, `debug_*`, `cleanup-*`, `generate-hash*`,
  legacy root `routes/`, `server-backups/`, one-off fix SQLs) moved to
  `scripts/attic/`.
- `test_phase2.md` → `docs/`; `symbology-style.db` → `backups/`.
- `healthcheck.js`, `jest.config.js`, `server.js` kept at root where the
  Dockerfile expects them.
- Boot verified post-move.
