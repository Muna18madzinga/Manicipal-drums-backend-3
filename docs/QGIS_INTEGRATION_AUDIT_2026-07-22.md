# QGIS ↔ Web Integration — Audit & Fix Summary (2026-07-22)

## Context

Prompted by an academic paper (Paradzayi, Wekwete, Moyo, Namailinga & Madzinga —
*"An Architecture for Bridging Desktop and Web GIS for Municipal Master Plan
Information Management in Zimbabwe"*, Midlands State University, Gweru) and a
QGIS/OGC setup guide for a "Vungu Solution" pilot. The paper describes an
architecture — QGIS Desktop as system-of-authorship, an OGC bridge, a
style-extraction layer translating QGIS renderers into MapLibre paint
expressions, a bidirectional PyQGIS plugin, WMS `GetLegendGraphic` as a
pixel-perfect fallback — that turned out to **already exist** in this
codebase. The task was to verify it against a live database, fix whatever was
actually broken, and document the file-transfer mechanics end to end.

Nothing here is new architecture. It's an audit: run the real pipeline
against a real database, find what's silently broken, fix it, and prove each
fix with a live request or a browser render — not just reading the code and
trusting it.

## Bugs found and fixed

| # | Bug | Fix |
|---|---|---|
| 1 | `vungu-project.qgs` pointed 2 of 9 layers (`zimbabwe`, `proposed_peri_urban_zones`) at PostGIS tables that no longer existed — schema had drifted since the project was last saved | Repointed `zimbabwe` → `country` (the real national boundary already used by the tile pipeline); `proposed_peri_urban_zones` → `vungu_proposed_peri_urban_zones` (the table's actual current name), with matching primary-key fixes |
| 2 | The style/feature bridge (`refinedOGCBridge.js`) resolved a layer's table by assuming *table name == layer name* via a hardcoded map, not by reading the project file | `PerfectQGISStyleExtractor.getTableName()` now reads the layer's real `<datasource>` first; a rename in QGIS Desktop no longer silently breaks feature serving |
| 3 | Every layer's `<datasource>` hardcoded `dbname='Vungu_spatial333' host=... user=...` — a database that doesn't exist on this machine (and wouldn't match any other machine either) | Converted to `service='vungu'`, portable across every environment; added `qgis-projects/pg_service.conf.example` template (never commit the filled-in copy) |
| 4 | `spatial_layers` catalogue table (required by plugin push/pull and the dynamic-layers feature) had **no migration at all** — any fresh database 500'd on `POST /api/qgis/sync/upload` | Added `migrations/111_spatial_layers_catalogue.sql` (idempotent, auto-registers existing PostGIS tables) |
| 5 | `POST /auth/validate-api-token` rejected real signed tokens — `isString()`'s default 255-char cap is shorter than an actual JWT (279 chars). The PyQGIS plugin calls this before every sync | Raised the cap to 4096 for this endpoint |
| 6 | The plugin the portal actually served (`vungu-qgis-plugin.zip`) was a stale QGIS **Server**-side filter plugin (wrong plugin type entirely), capped at `qgisMaximumVersion=3.99` (QGIS is at 4.x now), with sync methods that were no-op stubs | Promoted a newer, unused, real dock-widget-UI build to canonical source (`backend/qgis-projects/vungu-integration/`); fixed remaining bugs (see below); rewired `scripts/create-plugin-zip.js`, which pointed at a source directory that no longer existed |
| 6a | ↳ plugin's auto-upload sent no `Authorization` header and the wrong payload shape | Fixed to match the real `POST /api/qgis/sync/upload` contract |
| 6b | ↳ plugin's "sync from portal" called a different, TopoJSON-shaped endpoint with a hardcoded/fictional layer list (`gweru_schools`, `gcc_boundary`, …) | Switched to the documented `GET /api/qgis/sync/download/:layer`; portal-layer list now populated live from `GET /api/ogc/layers` |
| 7 | `vite.config.ts`'s `/qgis` dev-proxy rule also matched the SPA routes `/qgis-map` and `/admin/qgis-plugin` (Vite proxy matching is prefix-based) — visiting either page 500'd trying to proxy the page navigation itself to QGIS Server | Anchored the rule on `/qgis/` (trailing slash) |
| 8 | One `gweru_rivers` row had a `NaN` vertex from the original shapefile import, which broke `ST_AsGeoJSON(...)::json` for the **entire layer**, not just that row | Nulled the one corrupt geometry |

## Verified, not just claimed

- All 9 project layers (`gweru_health_centres`, `gweru_rivers`,
  `gweru_beyond_periurban_zones`, `gweru_chiefdoms`, `gweru_peri_urban_zone`,
  `gweru_rural_farms`, `gweru_rural_planning_boundary`,
  `proposed_peri_urban_zones`, `zimbabwe`) serve correct QGIS-authored
  styling **and** real feature geometry via `/api/ogc/styled-layer/:layer`
  with zero errors.
- A full PyQGIS plugin round trip verified over real HTTP with a real signed
  API token: admin token mint → `validate-api-token` → `POST
  /api/qgis/sync/upload` (features land in a new PostGIS table, registered
  in `spatial_layers`, live-sync notification fires) → `GET
  /api/qgis/sync/download/:layer` (same features come back).
- `/qgis-map` renders QGIS-styled vector layers on the live MapLibre map in
  a real browser (headless Edge via CDP, since Playwright/Puppeteer aren't
  installed in this repo): `gweru_rural_farms` — 668 features,
  `fill-color:#91522d` from the QGIS categorised renderer, farm parcels
  correctly aligned over the Gweru basemap; `zimbabwe` — the repointed
  layer, 1 feature, correct green national-boundary outline.
- Backend jest suite: 20/22 suites, 80/80 tests pass. The 2 that don't are
  pre-existing integration tests hardcoded to `http://127.0.0.1:3000` and
  fail only because port 3000 was held by an unrelated project on this
  machine this session — not a regression from this work.

## Documented

`docs/QGIS_WEB_INTEGRATION.md` gained:
- **§2a — File transfer map**: every artifact in the integration (`.qgs`,
  QML sidecars, `pg_service.conf`, the plugin zip, pushed/pulled features,
  extracted styles, legend graphics, migration SQL), where it lives, who
  writes it, who reads it, and the exact transfer mechanism for each.
- Updates to §4 (style translation — datasource-driven table resolution),
  §5 (PyQGIS plugin — now describes the real dock-widget plugin and its
  build step), §8 (configuration — `pg_service.conf`).
- **§10 — Verified 2026-07-22**: this changelog, plus a copy-pasteable
  smoke-check loop over all project layers.

## Known gaps (not testable in this environment)

- **No Docker on this machine** (`docker` not on PATH) — QGIS Server's
  green-dot WMS-raster mode (`docker-compose.qgis.yml`) is unverified this
  session. Falls back to, and was verified through, the documented degraded
  path: catalog parsed from `.qgs`, features from PostGIS, style extracted
  the same way.
- **QGIS Desktop is not actually installed** — `C:\Program Files\QGIS 4.0.1`
  is only an OSGeo4W installer stub (`bin\setup.bat` calling
  `osgeo4w-setup.exe`), not a working install. The plugin's PyQGIS/Qt code
  (dock widget, layer combo, style extraction from `layer.renderer()`) is
  therefore verified by careful reading against the confirmed-working
  backend contract, not by running it inside real QGIS Desktop.

## Files changed

**`backend/`** (submodule, `main`):
`qgis-projects/vungu-project.qgs`, `scripts/create-plugin-zip.js`,
`scripts/migrate-render.js`, `scripts/migrate-render.test.js`,
`src/routes/auth.js`, `src/services/admin/perfectQGISStyleExtractor.js`,
`src/services/admin/refinedOGCBridge.js`, `vungu-qgis-plugin.zip` (rebuilt) —
plus new: `migrations/111_spatial_layers_catalogue.sql`,
`qgis-projects/pg_service.conf.example`, `qgis-projects/vungu-integration/`
(plugin source) — and removed the redundant `vungu-qgis-plugin-fixed.zip`.

**`frontend/`** (submodule, `main`): `vite.config.ts`.

**root** (`master`): `docs/QGIS_WEB_INTEGRATION.md`, this file, submodule
pointer bumps.
