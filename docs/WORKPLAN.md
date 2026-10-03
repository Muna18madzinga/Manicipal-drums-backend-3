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

## Stream E — style-extraction fidelity — done 2026-10-03

The paper's central claim (QGIS renderer definitions survive into MapLibre paint
expressions) was not demonstrable: the extractor only looked in
`<projectDir>/styles/`, which does not exist, so every layer outside the 11-layer
pilot project silently returned the flat default symbol with `success: true`.

- Resolution order implemented and aligned with `qgisImport.findCandidates()`:
  explicit → `$QGIS_QML_DIR` → `styles/` → project `.qgs` → `canonical-qml/`,
  with a `vungu_`-prefix retry reported as `aliasOf`.
- No silent fallbacks: `styleSource` / `qmlPath` / `fallback` / `fallbackReason`
  are carried through the bridge and returned by
  `GET /api/ogc/maplibre-style/:layer`.
- Line-symbol fidelity defect fixed (casing was winning over core; all 27 road
  classes rendered one white colour). Casing is now a `placement: 'below'`
  layer with per-category colour and width; frontend honours the placement.
- Evidence: `npm run verify:styles` → `docs/STYLE-FIDELITY-REPORT.md`
  (**40/40 layers, 0 fallbacks, every classified renderer varies**) and
  `npx jest test/style-extractor.test.js` (13 tests).
- Known gap: hatch and gradient fill translation is implemented but **unexercised**
  — no QML in the corpus uses `LinePatternFill`/`GradientFill`.

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

## Stream F — done 2026-10-03 (proving the "too complex to translate" claim)

The paper claims QGIS is the authority and that symbology MapLibre cannot
express is rendered by QGIS Server instead of approximated. Making that
checkable found the claim was **structurally true but silently leaky**.

What already existed and works: `classifyFidelity()` in `src/services/gis/styleDoc.js`
implements the ladder `direct → converted → server → unsupported`; `compileMaplibre()`
turns `server` into `{ layers: [], strategy: 'wms' }`; `styleRegistry` stores that
strategy and `routes/gisStyles.js` serves it; the client skips any layer whose
strategy is not `vector`. So the mechanism is wired end to end.

The hole: `qgisImport.convertSymbol()` read the *first* symbol layer's properties
and nothing else. A QGIS `GradientFill` has `color1`/`color2` and **no `color`**,
so it became `fill: '#cccccc'` grey with `fillStyle: 'solid'` — not in
`PATTERN_FILL_STYLES`, so no fidelity rung fired, so it classified `direct` and
compiled to an ordinary vector layer. The portal showed flat grey where the GIS
officer had drawn a ramp, at the *highest* fidelity rating, saying nothing. Same
for shapeburst, pattern tiles, SVG fills, marker-line and font markers.

Fixed:
- `SERVER_ONLY_CLASSES` in `qgisImport.js` lists the 14 symbol-layer classes
  MapLibre has no equivalent for, each with the reason; any one of them in a
  symbol stack taints the whole symbol.
- `classifyFidelity()` raises `server` for them, naming the class, so a planner
  can see *why* a layer delegated.
- Fixtures: `test/fixtures/qgs/untranslatable-symbols.qgs` — 12 maplayers,
  9 of them the cases the real project does not contain. Its `*_control`
  layers assert the opposite failure mode (blanket "send everything to WMS")
  does not pass.
- `npm run verify:render` (`scripts/verify-render-fidelity.mjs`): asserts two
  invariants — nothing classified `server`/`unsupported` may compile a MapLibre
  layer, and none may publish as `vector` — then writes
  `docs/RENDER-FIDELITY-REPORT.md` and exits non-zero on violation.
- `test/render-fidelity.test.js`, 20 tests: one per class plus the controls.
- Frontend: `getWMSLegendGraphicUrl()` omitted `raw=true`, so it would have
  received a JSON wrapper instead of image bytes; fixed and layer-encoded.

Honest limits of what is now proven:
- `direct 31 / converted 14 / server 9`, and **all 9 `server` styles are
  fixtures**. The published registry holds 25 `direct` + 7 `converted` and
  **zero** delegated layers. The claim is proven against authored symbology, not
  against council data — the corpus contains no hatch, gradient, pattern tile,
  marker-line, data-defined or blend-mode symbology at all.
- `GetLegendGraphic` is proven as a working endpoint
  (`GET /api/ogc/wms/legend/:layer?raw=true`, plus 3 encoding regression tests),
  but **no UI consumes it**. `MapLegend.vue` renders from the `gis_style`
  registry, not from QGIS. So the legend leg is a backend capability, not a
  user-visible fallback, and the paper should not claim otherwise.
- The `server` leg itself (does QGIS Server actually rasterise these correctly?)
  still needs `npm run qgis:up` — see the network blocker in
  `docs/LEGEND-FIDELITY-REPORT.md`.

Pre-existing test debt, unrelated to this stream: 8 suites / 39 tests fail on a
clean checkout (`migrate`, `seed-demo-users`, and six acceptance suites that
need seeded users). Verified by re-running them with this stream's source
changes stashed — identical failures.
