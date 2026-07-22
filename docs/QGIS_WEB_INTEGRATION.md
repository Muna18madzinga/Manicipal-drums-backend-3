# QGIS ↔ Web Portal Integration — How It Is Achieved

**SpartialIQ / Vungu RDC Municipal GIS Platform**
*Companion implementation notes to: Paradzayi, Wekwete, Moyo, Namailinga & Madzinga —
"An Architecture for Bridging Desktop and Web GIS for Municipal Master Plan
Information Management in Zimbabwe" (Midlands State University, Gweru).*

QGIS Desktop is the **system of authorship**; the web application is its
**live portal**. Nothing is redigitised, nothing is exported by hand: both
sides read and write one PostGIS database, QGIS symbology is translated (or
proxied) into the browser, and a database-level notification chain pushes
every edit — from either side — to every open browser tab in under a second.

---

## 1. The standardised colour schedule (single source of truth)

All cartography on every map — basemap, planning overlay, Planning Studio
hatches, legends, QGIS fallback styling — derives from **one module**:
`frontend/src/map/masterplanSymbology.ts`. It encodes the Zimbabwe
town-planning map-notation schedule as 36 named colours mapped to hex exactly
once, then applied per feature class. The legend and the paint expressions
read the *same records*, so the key can never disagree with the map.

### 1.1 Named colours (statutory schedule → hex)

| Named colour | Hex | Statutory use |
|---|---|---|
| Black | `#202020` | National roads, boundaries, facility letters |
| Dark Brown | `#59381d` | Primary distributor roads |
| Red Brown 1 | `#9e4a2a` | District distributor roads |
| Brown 2.2 | `#c19a6b` | Local distributor roads, high-density edging |
| Red Brown 1.2 | `#cf9077` | Access roads |
| Red 1 | `#d93a2b` | Proposed new streets & widenings |
| Blue 2 | `#1f5fa8` | Scheme-area boundary (inner edge) |
| Blue 2.2 | `#8fb4dd` | Railways |
| Yellow 2 | `#f1dd7c` | Dwelling houses (residential) |
| Blue 1 | `#4f83c2` | Shops / business |
| Blue-Grey 1.2 | `#b9c6d3` | Offices, banks |
| Red-Purple 1 | `#9d4676` | General industry |
| Red-Purple 1.2 | `#cf9cba` | Light / service industry |
| Blue-Purple 1 | `#5b4ea0` | Special (noxious) industry |
| Blue-Purple 1.2 | `#aca4d6` | Warehouses, mineral workings |
| Red 2.2 | `#e5a49e` | Public buildings & places of assembly (Zone 5) |
| Red 2 | `#c04846` | Public-buildings edge, petrol stations |
| Green 1 | `#7fb26a` | Public open space |
| Yellow-Green 1 | `#c3d284` | Private open space, sports grounds |
| Green 2.2 | `#a8cc96` | National parks, woodlands & plantations |
| Yellow-Brown 3 | `#d9b96b` | Cultivated farm land |
| Yellow-Green 1.2 | `#dde6ad` | Pasture |
| Green-Brown 2 | `#979a5f` | Agricultural buildings, market gardens |
| Green-Brown 2.1 | `#aeb178` | Zone 11 rural |
| Grey 1.2 | `#c6c6c6` | Cemeteries, public car parks (edged Grey 1 `#8a8a8a`) |
| Orange 1 | `#e0913d` | Hotels, permanently restricted land |
| *(unused land)* | `#efeadf` | Uncoloured — plain paper base |

(Full 36-colour table plus zone table 1A–11 in `masterplanSymbology.ts`.)

### 1.2 Who consumes it

```
masterplanSymbology.ts
 ├── vunguBasemapStyle.ts   → paints all 24 PostGIS vector-tile basemap layers
 ├── planning-layers.ts     → paints the subdivision-planning overlay (pl-*)
 ├── PlanningStudio.vue     → CAD hatch presets (land-use fills)
 ├── MapLegend.vue          → legend chips (same records as the paint)
 └── VunguPlannerView.vue   → degraded-mode QGIS overlay styling
```

On the QGIS side, the same schedule is captured as **council QML sidecars**
in `backend/qgis-projects/styles/*.qml` (one per layer, e.g.
`gweru_rural_farms.qml`, `proposed_peri_urban_zones.qml`). The style
extractor gives these sidecars precedence, so QGIS Desktop, QGIS Server WMS
rendering and the web's client-side styling all express the same statutory
schedule.

---

## 2. Architecture (end to end)

```
┌───────────────┐   direct PostGIS conn    ┌──────────────────────────┐
│ QGIS Desktop  │ ───── read/write ──────► │ PostgreSQL + PostGIS     │
│ (planners)    │                          │ single source of truth   │
└──────┬────────┘                          │ 24 basemap + master-plan │
       │  PyQGIS plugin (push/pull API)    │ + stands + permits …     │
       │                                   └──────┬────────────┬──────┘
       ▼                                          │            │
┌───────────────┐    WMS / WFS / WMTS      ┌──────▼─────┐      │ LISTEN/NOTIFY
│ QGIS Server   │ ◄── renders .qgs ──────  │  Fastify   │ ◄────┘ (triggers,
│ :8080         │ ──── proxied via ──────► │  backend   │        migration 109)
└───────────────┘    /api/ogc/* bridge     │  :3000     │
                                           └──────┬─────┘
                                                  │  SSE /api/map/events
                                                  ▼  MVT /api/tiles/*
                                           ┌────────────┐
                                           │ Vue 3 +    │
                                           │ MapLibre   │
                                           │ GL JS      │
                                           └────────────┘
```

Two layer pipelines feed the same MapLibre maps:

- **Pipeline A — PostGIS vector tiles (always on):** 24 registry layers
  (`backend/src/config/spatialLayers.js`) rendered as Mapbox Vector Tiles by
  `ST_AsMVT` (`GET /api/tiles/:layer/:z/:x/:y.pbf`), GiST-indexed, two-tier
  cached (in-process LRU + optional Redis), styled client-side from the
  statutory schedule.
- **Pipeline B — QGIS Server (per layer, on demand):** the backend OGC
  bridge (`/api/ogc/*`) proxies WMS `GetMap` / WFS `GetFeature` /
  `GetLegendGraphic`. When QGIS Server is healthy, the browser shows WMS
  rasters rendered **with the .qgs project symbology**; when it is down,
  the layer catalog comes from parsing the local `.qgs` file and features
  come straight from PostGIS, styled on the statutory palette.

---

## 2a. File transfer map — every file, where it lives, how it moves

Most of the integration is **not** file transfer at all — QGIS Desktop and
the backend both talk directly to the same PostgreSQL database, so feature
data never leaves the database as a file. The table below is exhaustive:
every artifact that genuinely moves between components, the mechanism, and
which component authored it.

| File / artifact | Lives at | Written by | Read by | Transfer mechanism |
|---|---|---|---|---|
| `vungu-project.qgs` | `backend/qgis-projects/vungu-project.qgs` (git-tracked) | QGIS Desktop (Project → Save) | QGIS Server; `perfectQGISStyleExtractor.js` (backend, local filesystem read); `qgisProjectWatcher.js` | Saved straight onto the same path the backend and QGIS Server read — no upload step in dev. In production this path is whatever the ops deploy places on disk / bind-mounts into the container. |
| `qgis-projects/styles/*.qml` | Same directory, one per layer | QGIS Desktop (right-click layer → Export → Save Style As → QML) | `perfectQGISStyleExtractor.js` — takes precedence over the renderer embedded in the `.qgs` itself | Plain file save to the shared directory; picked up on next style request (cached, invalidated by `qgisProjectWatcher.js`). |
| `pg_service.conf` | Per-machine: `~/.pg_service.conf` (Linux/macOS), `%APPDATA%\postgresql\.pg_service.conf` (Windows), or wherever `PGSERVICEFILE` points. Template tracked at `backend/qgis-projects/pg_service.conf.example` | Whoever sets up that machine (copy the template, fill in real host/port/credentials) | QGIS Desktop and QGIS Server (every layer's `<datasource>` in the `.qgs` now reads `service='vungu'` instead of a hardcoded dbname/host/user) | Never transferred over the network — it's local machine config, one copy per environment. The backend does **not** read this file; it connects via `DATABASE_URL`. This is what makes one `.qgs` file work unedited on every planner's laptop and every deployment. |
| `docker-compose.qgis.yml` → QGIS Server container | `backend/docker-compose.qgis.yml` | Checked in | QGIS Server container | Read-only bind mount `./qgis-projects:/etc/qgisserver:ro` — the container sees the exact same `.qgs`/`.qml` files the backend does, live, with no copy step. Saving in QGIS Desktop is instantly visible to the container; `qgisProjectWatcher.js` force-restarts the container (matched by name `vungu-qgis-server`) so QGIS Server's own internal project cache doesn't serve stale symbology. |
| Feature geometry/attributes | PostgreSQL/PostGIS tables | QGIS Desktop (direct edit + save), the backend API, `ogr2ogr` imports, `psql` | Both QGIS Desktop and the backend, from the same database | **Not a file transfer.** Both sides hold a live connection to one database. Migration `109_spatial_change_notify.sql`'s trigger + `LISTEN/NOTIFY` is what makes a QGIS Desktop edit visible in a browser tab without either side exporting anything. |
| PyQGIS plugin package | Built to `backend/vungu-qgis-plugin.zip` from source at `backend/qgis-projects/vungu-integration/` via `node backend/scripts/create-plugin-zip.js` | Backend build step (checked-in output, rebuilt when the plugin source changes) | Planner's QGIS Desktop, via QGIS's own Plugin Manager → "Install from ZIP" | HTTP download: `GET /api/qgis-plugin/download/plugin` streams the zip. The planner downloads it once through the portal itself and installs it locally — this is the one artifact that genuinely leaves the server as a file. |
| Pushed layer (Desktop → portal) | New PostGIS table `qgis_<layer>` | Plugin's "📤 Sync Layer to Portal" button | Backend; then everyone, via the normal tile/OGC pipeline | `POST /api/qgis/sync/upload` — JSON body (GeoJSON features + field types + QGIS style, extracted in-memory by the plugin, never written to a local file) over HTTPS, Bearer API-token authenticated. Lands directly in a new table inside the same transaction that re-attaches the migration-109 trigger, so the push rides the same NOTIFY → SSE path as a direct desktop edit. |
| Pulled layer (portal → Desktop) | Transient `%TEMP%\vungu_<layer>.geojson` | Backend response, written by the plugin | QGIS Desktop (`QgsVectorLayer(path, name, "ogr")`), then deleted | `GET /api/qgis/sync/download/:layerName` returns GeoJSON-shaped features (reprojected to EPSG:4326) in the JSON response body; the plugin writes it to a throwaway temp file only because that's how QGIS's OGR provider ingests local vector data, then removes the file once the in-memory layer is loaded. |
| Extracted style (project → browser) | Never written to disk | `perfectQGISStyleExtractor.js`, parsed fresh from the `.qgs`/`.qml` XML each request (cached in-process) | Browser (`QGISMapView.vue`, `InteractiveMap.vue`) | JSON API response — `GET /api/ogc/styled-layer/:layer` / `GET /api/ogc/maplibre-style/:layer` — applied directly as a MapLibre GL paint expression via `map.addLayer()`. No intermediate file on either end. |
| Legend / raster fallback | Never written to disk | QGIS Server (`GetLegendGraphic`, `GetMap`) | Browser `<img>` / raster tile layer | Proxied bytes: browser → `/api/ogc/wms/legend/:layer` or `/api/ogc/wms/map/:layer` → backend → QGIS Server → back. Used when a renderer is too complex to translate to a paint expression (the backend reports this in `hasComplexPatterns`/`hasHatchPatterns`). |
| Migration SQL (`109_spatial_change_notify.sql`, `111_spatial_layers_catalogue.sql`, …) | `backend/migrations/*.sql` | Checked in | Applied once per database via `node scripts/migrate-render.js` (fresh deploys) or `node scripts/apply-local-migration.js <file>` (existing local DB) | Not part of the runtime data flow — this is what provisions the schema (notify triggers, the `spatial_layers` catalogue) that everything above depends on. |

---

## 3. Real-time synchronization (no polling, no manual export)

The critical property: **an edit saved in QGIS Desktop appears in every open
browser tab automatically.** Achieved with a database-level notification
chain — the web app does not poll, and QGIS needs no plugin for this path:

```
Planner saves edits in QGIS Desktop (or any PostGIS write: API, import, psql)
  ↓
Row trigger on every geometry table            migrations/109_spatial_change_notify.sql
  trg_notify_spatial_change (AFTER INSERT/UPDATE/DELETE)
  ↓
pg_notify('spatial_change', {schema, table, op, id})   -- tiny payload, no geometry
  ↓
Backend dedicated LISTEN connection            src/services/spatialChangeListener.js
  · coalesces bursts (300 ms window — a QGIS save committing 500 rows = 1 event)
  · maps table → tile-layer id (stands base table → stands layer, etc.)
  · invalidates that layer in the tile cache (LRU + Redis)
  ↓
SSE push on the existing bus                   GET /api/map/events (tiles.js)
  data: {"layer":"stands","op":{"UPDATE":1},"source":"postgis"}
  ↓
Frontend refreshes ONLY the changed layer      InteractiveMap.vue connectMapEvents()
  · vector source URL cache-busted → MapLibre re-requests just those tiles
  · exponential-backoff reconnect, so a backend restart never leaves a stale map
```

Verified end-to-end on 2026-07-17: a raw SQL `UPDATE` against `stands`
produced the SSE event above in an open browser session with no page reload
and no polling. Liveness is observable at `GET /api/qgis/health` →
`data.realtimeSync.listening: true`.

Notes:

- Triggers are attached idempotently to **every table with a geometry
  column** (public + spatial_planning schemas). New `qgis_*` staging tables
  created by a plugin push get the trigger re-attached inside the same
  transaction, before the features are inserted — so a push broadcasts
  exactly like a desktop edit.
- Symbology changes (not data) ride a second watcher: saving
  `qgis-projects/vungu-project.qgs` from QGIS Desktop clears the style
  caches (`qgisProjectWatcher.js`, chokidar) and broadcasts a cache-clear
  to clients; the next WMS tiles render with the new symbology.

---

## 4. Style translation (QGIS renderer → MapLibre paint)

`perfectQGISStyleExtractor.js` parses the QGIS project file (and per-layer
QML sidecars, which take precedence) and converts renderer definitions —
single symbol, categorised, graduated and rule-based, including hatch and
gradient fills — into MapLibre GL paint expressions, served via
`GET /api/ogc/styled-layer/:layer` and `GET /api/ogc/maplibre-style/:layer`.
Symbology too complex to translate falls back to **WMS `GetLegendGraphic`**
and raster `GetMap` tiles, which are pixel-perfect by construction because
QGIS Server renders them itself.

Feature data for the same request is resolved to a PostGIS table by reading
the layer's own `<datasource>` in the `.qgs` (`PerfectQGISStyleExtractor.
getTableName()`), not by assuming the table is named identically to the
layer — a layer can be renamed or repointed to a different table in QGIS
Desktop, re-saved, and the web app picks it up with no code change. A
legacy static name map (`refinedOGCBridge.js`) remains as a fallback for the
rare non-PostGIS layer where a datasource table name can't be parsed.

---

## 5. The PyQGIS plugin loop (bidirectional, token-authenticated)

For planners who prefer explicit push/pull over a live DB connection, a real
installable QGIS Desktop plugin (dock widget: connection settings, layer
picker, "Sync Layer to Portal" / "Sync from Portal" buttons, optional
auto-upload on style change). Source lives at
`backend/qgis-projects/vungu-integration/`, built to the zip the portal
serves with `node backend/scripts/create-plugin-zip.js`.

| Endpoint | Purpose |
|---|---|
| `POST /api/qgis/sync/upload` | Push a layer from Desktop → portal. Lands in a `qgis_*` staging PostGIS table (never clobbers a core table), registers in the `spatial_layers` catalogue, broadcasts live. |
| `GET /api/qgis/sync/download/:layer` | Pull any portal layer into Desktop as GeoJSON + field types. |
| `POST /api/auth/validate-api-token` | Plugin's pre-flight check before every sync — confirms the token is a live, unexpired, `type:'api'` token. |
| `GET/POST /api/qgis-plugin/style-sync/*` | Style-sync status / force. |
| `GET /api/qgis-plugin/download/plugin` | Planners download the plugin from the portal itself. |

Authentication is a signed **API token** (JWT, `type:'api'`, minted by an
admin via `POST /api/auth/generate-api-token`) — never browser cookies, and
the planner never holds database credentials. All identifiers are sanitised
before touching SQL; field types are mapped to safe PostgreSQL types. The
portal-layers picker in the plugin is populated live from
`GET /api/ogc/layers` (the same catalogue `QGISMapView.vue` uses) rather
than a hardcoded list, so it can never drift out of sync with the actual
project.

---

## 6. Development-control compliance (spatial rules engine)

The zoning permission matrix links parcel geometry to permitted uses:
`check_development_permission(parcel_id, proposed_use)` (repaired in
migration `075_fix_check_development_permission.sql`) resolves the parcel's
zone by explicit assignment or largest spatial overlap, then reads
`development_matrix × land_use_groups × permission_types` to return
**P / SC / X** (permitted / special consent / prohibited) with the statutory
colour for the verdict. Geometry writes are further gated server-side:
validity (`ST_IsValid`), no self-intersection, and a topology rule rejecting
overlapping stands (migrations 106–107).

---

## 7. Failure modes

| Situation | Behaviour |
|---|---|
| QGIS Server up | Green dot; toggled layers are WMS rasters with .qgs symbology |
| QGIS Server down, backend up | Amber dot; catalog parsed from `.qgs`; features from PostGIS; statutory-palette vector styling — nothing breaks |
| Backend down | Red dot; SSE auto-reconnects with backoff when it returns |
| LISTEN connection drops | Listener reconnects (2 s → 30 s backoff); API-write SSE events continue meanwhile |
| Bad WMS bbox / malformed layer name | 400 (validated); never a silently wrong extent, no SQL sees unvalidated identifiers |

---

## 8. Configuration (env-driven; no credentials in code)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | The one PostGIS database (backend, listener, QGIS Server, Desktop all point here) |
| `QGIS_SERVER_URL` | Internal QGIS Server address (never exposed; browsers use `/api/ogc/*`) |
| `QGIS_PROJECT` | Project path as QGIS Server sees it |
| `QGIS_PROJECT_LOCAL` | Optional local `.qgs` override for fallback parsing/watching |
| `OGC_TIMEOUT`, `OGC_MAX_RETRIES` | Bridge behaviour |
| `REDIS_URL` | Optional L2 tile cache |
| `pg_service.conf` (`service='vungu'`) | Not a backend env var — this is what QGIS Desktop and QGIS Server use to reach Postgres, per machine. Template at `backend/qgis-projects/pg_service.conf.example`; see §2a. |

### Running QGIS Server (green-dot WMS mode)

One command, from `backend/`:

```bash
docker compose -f docker-compose.qgis.yml up -d
```

The container is deliberately named `vungu-qgis-server` — the backend's
project watcher restarts that exact name when new layers appear in the
project file. Without Docker the stack runs in the fully-functional amber
(degraded) mode: catalog from the `.qgs`, features from PostGIS, statutory
palette styling.

## 9. Smoke checks

```bash
curl http://localhost:3000/api/tiles/layers     # 24-layer catalog
curl http://localhost:3000/api/ogc/health       # healthy | degraded
curl http://localhost:3000/api/qgis/health      # realtimeSync.listening: true
curl -N http://localhost:3000/api/map/events &  # then edit any layer in QGIS →
                                                # watch the SSE event arrive

# Style + features for every layer in the project — should return no "error" key
for layer in $(curl -s http://localhost:3000/api/ogc/layers | node -pe "JSON.parse(require('fs').readFileSync(0)).data.layers.map(l=>l.name).join(' ')"); do
  curl -s "http://localhost:3000/api/ogc/styled-layer/$layer" | grep -o '"error":"[^"]*"' && echo "  ^ $layer"
done
```

## 10. Verified 2026-07-22

Ran the full pipeline end-to-end against a real local database (not a mock)
and fixed everything it found broken:

- **Layer/table drift**: `vungu-project.qgs` still pointed two of its nine
  layers at a table name (`zimbabwe`, `proposed_peri_urban_zones`) that no
  longer existed in the working database — repointed `zimbabwe` → `country`
  (the real national boundary already used by the tile pipeline) and
  `proposed_peri_urban_zones` → `vungu_proposed_peri_urban_zones` (the
  table's actual current name), with matching primary-key fixes.
- **Hardcoded layer→table mapping**: `refinedOGCBridge.js` assumed table
  name == layer name (or a hand-maintained static list). It now reads the
  real table from the layer's own `<datasource>` first (§4), so a rename in
  QGIS Desktop no longer silently breaks feature serving.
- **Corrupt geometry**: one `gweru_rivers` row had a `NaN` vertex from the
  original shapefile import, which made `ST_AsGeoJSON(...)::json` fail for
  the *entire* layer, not just that row. Nulled the one corrupt geometry.
- **Portable connections**: every layer's `<datasource>` now uses
  `service='vungu'` instead of a hardcoded `dbname=/host=/user=` (which
  pointed at a database — `Vungu_spatial333` — that doesn't exist on this
  machine). See `pg_service.conf.example` and §2a.
- **`spatial_layers` catalogue table didn't exist** — nothing had ever
  migrated it, so `POST /api/qgis/sync/upload` 500'd on every fresh
  database. Added migration `111_spatial_layers_catalogue.sql`.
- **`/auth/validate-api-token` rejected real tokens** — `isString()`'s
  default 255-char cap is shorter than a real signed JWT; raised to 4096 for
  this endpoint. The plugin calls this before every sync, so this silently
  broke the entire push/pull loop through the plugin UI.
- **PyQGIS plugin**: the zip the portal served (`vungu-qgis-plugin.zip`) was
  a stale QGIS *Server*-side filter plugin, not the Desktop push/pull plugin
  the docs describe, capped at `qgisMaximumVersion=3.99` (rejected by QGIS
  4.x), and its sync methods were stubs that didn't call the real API. A
  newer but never-wired-up build (`vungu-qgis-plugin-fixed.zip`) had a real
  dock-widget UI; promoted it to the canonical source
  (`backend/qgis-projects/vungu-integration/`), fixed its remaining bugs
  (auto-upload sent no auth header and the wrong payload shape;
  "sync from portal" called a different, TopoJSON-shaped endpoint with a
  hardcoded/fictional layer list instead of the documented
  `/api/qgis/sync/download/:layer`; version cap), wired a real build script
  (`create-plugin-zip.js`, was pointed at a source directory that no longer
  existed), and deleted the redundant zip.
- **Dev proxy bug**: `vite.config.ts`'s `/qgis` proxy rule (for direct QGIS
  Server passthrough) also matched the SPA routes `/qgis-map` and
  `/admin/qgis-plugin` — Vite proxy matching is prefix-based — sending page
  navigations into the proxy instead of the Vue app (500, `ECONNREFUSED`).
  Anchored the rule on `/qgis/` (trailing slash) instead.

**Confirmed working end-to-end**: all 9 project layers now serve correct
QGIS-authored styling + real features with zero errors; a full plugin
push → live-sync-broadcast → pull round trip verified over HTTP with a real
signed API token; `/qgis-map` renders QGIS-styled vector layers on the
MapLibre map in the browser (screenshotted: `gweru_rural_farms` — 668
features, `fill-color:#91522d` from the QGIS categorised renderer;
`zimbabwe` — repointed layer, 1 feature, correct green outline). Not
independently re-verified this session: WMS/WFS raster mode against a
*running* QGIS Server (no Docker on this machine) and the plugin inside a
real QGIS Desktop process (the QGIS install found on this machine is an
incomplete OSGeo4W stub) — both fall back to, and were verified through,
the code paths documented in §7.
