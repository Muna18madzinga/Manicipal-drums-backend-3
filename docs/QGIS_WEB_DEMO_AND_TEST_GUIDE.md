# Vungu RDC Municipal GIS — Full Demonstration & Testing Guide

**How the QGIS ↔ Web integration works, and how to prove every claim in it.**

*Prepared by **Theophelos Madzinga**, Computer Science Intern*
*Vungu Rural District Council — SpartialIQ Municipal GIS Platform*
*Version 1.0 — 22 July 2026*

---

## Table of contents

1. [What the system does](#1-what-the-system-does)
2. [Architecture — how it all works](#2-architecture--how-it-all-works)
3. [Starting the system](#3-starting-the-system)
4. [One-command health check](#4-one-command-health-check)
5. [Demonstration A — Pixel-perfect QGIS symbology on the web](#5-demonstration-a--pixel-perfect-qgis-symbology-on-the-web)
6. [Demonstration B — A planner's edit appears instantly](#6-demonstration-b--a-planners-edit-appears-instantly)
7. [Demonstration C — The PyQGIS plugin round trip](#7-demonstration-c--the-pyqgis-plugin-round-trip)
8. [Demonstration D — Vector tiles and the transport tiers](#8-demonstration-d--vector-tiles-and-the-transport-tiers)
9. [Demonstration E — Statutory zoning compliance](#9-demonstration-e--statutory-zoning-compliance)
10. [Demonstration F — Graceful degradation](#10-demonstration-f--graceful-degradation)
11. [Deep dive — how each mechanism works](#11-deep-dive--how-each-mechanism-works)
12. [Honest scope and known limitations](#12-honest-scope-and-known-limitations)
13. [Troubleshooting](#13-troubleshooting)
14. [Appendix — cheat sheet](#14-appendix--cheat-sheet)

---

## 1. What the system does

Vungu Rural District Council's planning department authors its master plan in
**QGIS Desktop**. Historically that work was trapped on one officer's laptop:
to publish anything you exported images by hand, and the website drifted out
of date the moment somebody edited a boundary.

This platform closes that gap. It makes three promises, and this guide shows
how to prove each one:

| # | Promise | Proven by |
|---|---------|-----------|
| 1 | **What a planner sees in QGIS is what a citizen sees on the web** | [Demo A](#5-demonstration-a--pixel-perfect-qgis-symbology-on-the-web) |
| 2 | **An edit saved by a planner appears in every open browser within a second** | [Demo B](#6-demonstration-b--a-planners-edit-appears-instantly) |
| 3 | **Data moves both ways between QGIS Desktop and the portal without manual export** | [Demo C](#7-demonstration-c--the-pyqgis-plugin-round-trip) |

Nothing is redigitised and nothing is exported by hand. QGIS Desktop and the
web application read and write **one PostGIS database**.

---

## 2. Architecture — how it all works

```
┌────────────────┐    direct PostGIS connection    ┌───────────────────────────┐
│  QGIS Desktop  │ ──────── read / write ────────► │  PostgreSQL + PostGIS     │
│  (planners)    │                                 │  SINGLE SOURCE OF TRUTH   │
└───────┬────────┘                                 │  · 24 basemap layers      │
        │                                          │  · master-plan layers     │
        │  PyQGIS plugin (push / pull REST)        │  · permits, stands …      │
        │                                          └──────┬──────────────┬─────┘
        ▼                                                 │              │
┌────────────────┐    WMS / WFS / WMTS             ┌───────▼──────┐      │ LISTEN /
│  QGIS Server   │ ◄── renders vungu-project.qgs ─ │   Fastify    │ ◄────┘ NOTIFY
│  :8080         │ ─── proxied via /api/ogc/* ───► │   backend    │   (migration 109
└────────────────┘                                 │   :3000      │    row triggers)
                                                   └───────┬──────┘
                                       SSE /api/map/events │  MVT /api/tiles/*
                                                           ▼
                                                   ┌──────────────┐
                                                   │  Vue 3 +     │
                                                   │  MapLibre GL │  :5174
                                                   └──────────────┘
```

### The two rendering pipelines

Both feed the same MapLibre maps. This dual design is the heart of the system.

**Pipeline A — PostGIS vector tiles (always on).**
24 registry layers (`src/config/spatialLayers.js`) are rendered as Mapbox
Vector Tiles by `ST_AsMVT` and styled *in the browser* from the statutory
colour schedule (`frontend/src/map/masterplanSymbology.ts`). Fast, crisp at
any zoom, clickable — but client-side styling can only *approximate* complex
QGIS symbology.

**Pipeline B — QGIS Server (pixel-perfect).**
QGIS Server loads the actual `vungu-project.qgs` and renders it with the
**real QGIS rendering engine**, serving standard OGC WMS. The backend proxies
it at `/api/ogc/wms/*`. This is the only way to reproduce hatch fills,
gradients, rule-based renderers and SVG markers exactly.

**Automatic selection.** The frontend calls `/api/ogc/health`. If QGIS Server
is rendering, the map uses its pixel-perfect rasters; if it is down, the app
silently falls back to Pipeline A. No broken map, ever ([Demo F](#10-demonstration-f--graceful-degradation)).

### The real-time chain

```
Planner saves an edit in QGIS Desktop (or ANY PostGIS write: API, psql, import)
   ↓
Row trigger  trg_notify_spatial_change        migrations/109_spatial_change_notify.sql
   ↓
pg_notify('spatial_change', {schema, table, op, id})     ← tiny payload, no geometry
   ↓
Backend dedicated LISTEN connection            src/services/spatialChangeListener.js
   · coalesces bursts in a 300 ms window (a 500-row save = 1 event)
   · invalidates that layer in the tile cache
   ↓
SSE push                                       GET /api/map/events
   ↓
Browser refreshes ONLY the changed layer       InteractiveMap.vue connectMapEvents()
```

There is **no polling anywhere** in this chain.

---

## 3. Starting the system

### Prerequisites

| Requirement | Check |
|---|---|
| PostgreSQL + PostGIS with the `Vungu_spatial333` database | `psql -l` |
| Node.js 18+ | `node --version` |
| Docker Desktop (for Pipeline B) | `docker --version` |

### 3.1 Start QGIS Server (pixel-perfect rendering)

```bash
cd vunguwebapp-backend
docker compose -f docker-compose.qgis.yml up -d
docker compose -f docker-compose.qgis.yml ps      # both containers "Up"
```

Expected: `qgis-server` (FCGI) and `qgis-web` (nginx, `0.0.0.0:8080->8080`).

> **First-time setup only.** Copy `qgis-projects/pg_service.docker.conf.example`
> to `pg_service.docker.conf` and set the real database password, and allow the
> Docker subnet in `pg_hba.conf`. Both steps are detailed in
> `docs/QGIS_SERVER_LOCAL_RUNBOOK.md`.

### 3.2 Start the backend

```bash
cd vunguwebapp-backend
node server.js
```

Watch for this line — it confirms the real-time chain is armed:

```
[spatial-listener] LISTEN spatial_change active — QGIS/PostGIS edits now push live to browsers
```

### 3.3 Start the frontend

```bash
cd vunguwebapp-frontend
npm run dev
```

Open **http://localhost:5174**.

| Service | URL |
|---|---|
| Web application | http://localhost:5174 |
| Backend API | http://localhost:3000 |
| QGIS Server (OGC) | http://localhost:8080 |

---

## 4. One-command health check

Run this before any demonstration. It is self-diagnosing: every failure line
prints the exact fix.

```bash
cd vunguwebapp-backend
node scripts/verify-qgis-server.js
```

**Expected output (all green):**

```
QGIS Server verification — http://localhost:8080

  PASS nginx front is up (:8080)
  PASS GetCapabilities lists 20 layers (WMS, Vungu RDC Master Plan …)
  PASS GetMap rendered proposed_peri_urban_zones -> 55461-byte PNG (QGIS symbology, pixel-perfect)
  PASS backend /api/ogc/health = healthy -> web app will auto-use QGIS rasters

All checks passed — QGIS-rendered pixels are live.
```

Each check maps to a link in the chain: nginx reachable → project loaded and
database connected → QGIS actually renders → the backend can see it.

---

## 5. Demonstration A — Pixel-perfect QGIS symbology on the web

**Claim:** the browser displays pixels produced by the QGIS rendering engine
itself, not a web approximation.

### A1. QGIS Server renders the real project

```bash
curl -s "http://localhost:8080/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap\
&LAYERS=proposed_peri_urban_zones&CRS=EPSG:4326\
&BBOX=-20.2,29.5,-19.2,30.2&WIDTH=400&HEIGHT=400&FORMAT=image/png&STYLES=" \
 -o demo_qgis.png
file demo_qgis.png
```

**Expected:** `PNG image data, 400 x 400, 8-bit/color RGBA` (~55 KB).
Open `demo_qgis.png` — the zoning colours are the council's own schedule.

> **Note on axis order.** WMS 1.3.0 with EPSG:4326 uses **lat,lon** order, so the
> bbox is `miny,minx,maxy,maxx`. Passing lon,lat returns
> `BBOX … cannot be converted into a rectangle`.

### A2. The exact path the browser uses

MapLibre requests **EPSG:3857** tiles through the backend proxy:

```bash
curl -s "http://localhost:3000/api/ogc/wms/map/proposed_peri_urban_zones\
?bbox=3238300,-2269900,3360700,-2165900&width=512&height=512\
&crs=EPSG:3857&transparent=true&format=image/png" -o demo_proxy.png
file demo_proxy.png
```

**Expected:** `PNG image data, 512 x 512` (~74 KB). A near-empty file (~1 KB)
means reprojection is broken — see [Troubleshooting](#13-troubleshooting).

### A3. In the browser

1. Open **http://localhost:5174/qgis-map**.
2. The view checks `/api/ogc/health` on load; because QGIS Server is healthy it
   **automatically selects WMS mode**.
3. Toggle a layer such as `proposed_peri_urban_zones`.
4. Use the **Vector / WMS / WFS** buttons to switch modes live.

**What to point out to your audience:** switch between *WMS* and *Vector* on the
same layer. WMS is the QGIS engine's own output; Vector is the browser's
approximation. On layers with hatch or gradient fills the difference is
visible — that is precisely why Pipeline B exists.

### A4. Side-by-side proof against QGIS Desktop

1. Open `qgis-projects/vungu-project.qgs` in QGIS Desktop.
2. Zoom to the same extent as the browser.
3. Compare. The colours, outlines, category breaks and labels match, because
   **both are rendering the same file with the same engine.**

---

## 6. Demonstration B — A planner's edit appears instantly

**Claim:** any PostGIS write — including one saved from QGIS Desktop, which
never touches our API — pushes to every open browser in under a second.

### B1. Confirm the triggers are installed

```bash
cd vunguwebapp-backend
node -e "require('dotenv').config();const{Pool}=require('pg');\
const p=new Pool({connectionString:process.env.DATABASE_URL});\
p.query(\"SELECT count(*)::int n FROM pg_trigger WHERE tgname='trg_notify_spatial_change' AND NOT tgisinternal\")\
.then(r=>{console.log('tables with live-sync trigger:',r.rows[0].n);process.exit(0)})"
```

**Expected:** `tables with live-sync trigger: 54`

If it prints `0`, apply the migration:
```bash
node scripts/apply-local-migration.js 109_spatial_change_notify.sql
```
…then **restart the backend** so the listener connects.

### B2. Watch the live event stream

In a terminal, subscribe exactly as the browser does:

```bash
curl -N http://localhost:3000/api/map/events
```

Leave it running.

### B3. Make an edit

In a second terminal, perform a harmless edit (sets a geometry to itself):

```bash
cd vunguwebapp-backend
node -e "require('dotenv').config();const{Pool}=require('pg');\
const p=new Pool({connectionString:process.env.DATABASE_URL});\
p.query('UPDATE gweru_rural_farms SET geom = geom WHERE ctid = (SELECT ctid FROM gweru_rural_farms LIMIT 1)')\
.then(()=>{console.log('edit committed');process.exit(0)})"
```

**Expected — the first terminal immediately prints:**

```
data: {"layer":"gweru_rural_farms","table":"gweru_rural_farms","action":"changed","source":"postgis","ops":{"UPDATE":1},"ts":1784722600516}
```

### B4. The full visual demonstration

1. Open **http://localhost:5174** and leave the map visible.
2. In QGIS Desktop, open the same PostGIS layer, move a vertex, **Save Layer Edits**.
3. The browser refreshes that layer on its own — no reload, no button.

**What to point out:** `"source":"postgis"` proves the notification came from
the *database*, not from an API call. This is why an edit made entirely inside
QGIS Desktop still reaches the web.

---

## 7. Demonstration C — The PyQGIS plugin round trip

**Claim:** a planner can publish a QGIS layer to the portal and pull portal
layers back into QGIS, authenticated, with no file juggling.

### C1. Automated round-trip test

```bash
cd vunguwebapp-backend
node scripts/test-qgis-loop.js
```

**Expected:**

```
PUSH   200 {"layer_id":"qgis_plugin_loop_test","features_processed":2,…}
CATALOG registered: qgis_plugin_loop_test (polygon)
PULL   200 2 features, fields: id,name,area_ha,approved
ROUNDTRIP OK
FORGED 401 OK
```

What each line proves:

| Line | Proves |
|---|---|
| `PUSH` | Features land in a **real PostGIS table** (`qgis_*`), inside a transaction |
| `CATALOG` | The new layer auto-registers in `spatial_layers`, so the portal lists it |
| `PULL` | The same features come back as GeoJSON with their field types |
| `ROUNDTRIP OK` | Geometry and attributes survive the trip unchanged |
| `FORGED 401 OK` | A forged token is **rejected** — the endpoint verifies real signed tokens |

### C2. Installing the plugin in QGIS Desktop

1. Download: **http://localhost:3000/api/qgis-plugin/download/plugin**
   (or in the portal: *Admin → QGIS Plugin → Download*).
2. QGIS Desktop → *Plugins → Manage and Install Plugins → Install from ZIP*.
3. Open the **Vungu Integration** dock widget.
4. Use *Sync Layer to Portal* (push) and the portal-layer list (pull).

Pushed layers become `qgis_<layer>` tables and appear through the normal
tile/OGC pipeline — and because the push re-attaches the migration-109 trigger
in the same transaction, it rides the same live-refresh path as a desktop edit.

---

## 8. Demonstration D — Vector tiles and the transport tiers

**Claim:** country-wide spatial data is served efficiently in three formats.

### D1. Mapbox Vector Tiles (the always-on basemap)

```bash
curl -s -o tile.pbf -w "%{http_code} %{size_download} bytes\n" \
  http://localhost:3000/api/tiles/districts/6/37/35.pbf
```

**Expected:** HTTP `200` and a payload of roughly 25–50 KB — a protobuf tile
generated by `ST_AsMVT` straight from PostGIS, GiST-indexed and cached. (The
exact byte count varies with cache state and data, so judge it by "200 and
tens of KB", not by a fixed number.)

### D2. The layer registry

```bash
curl -s http://localhost:3000/api/tiles/layers
```

Returns the 24 registry layers with their `minzoom`, geometry type and
attribute allow-list.

### D3. GeoJSON + TopoJSON (compressed transport)

```bash
curl -s "http://localhost:3000/api/ogc/wfs/features/proposed_peri_urban_zones?limit=2"
```

Returns the standard API envelope wrapping a **TopoJSON** document:

```json
{"success":true,"data":{"type":"Topology","objects":{"collection":
 {"type":"FeatureCollection","features":[ … ]}},"arcs":[ … ]}}
```

The `arcs` array is the point: shared boundaries are stored once instead of
duplicated per polygon, which matters on Zimbabwean mobile connections.

---

## 9. Demonstration E — Statutory zoning compliance

**Claim:** the portal answers the planner's real question — *may this use go on
this parcel?* — from the council's own development matrix.

### E1. The zones and the matrix

```bash
curl -s http://localhost:3000/api/development-control/zones
curl -s "http://localhost:3000/api/development-control/matrix?zone_id=1"
```

### E2. A live compliance check

```bash
curl -s -X POST http://localhost:3000/api/development-control/compliance-check \
  -H "Content-Type: application/json" \
  -d "{\"parcelId\":\"471\",\"proposedUseCode\":\"A1\"}"
```

**Expected results for parcel 471 (zone: *High Density Residential*):**

| Proposed use | Permission | Compliance status |
|---|---|---|
| `A1` | `X` | `NON_COMPLIANT` — prohibited in this zone |
| `D`  | `SC` | `PENDING_REVIEW` — special consent required |
| `H`  | `SC` | `PENDING_REVIEW` — special consent required |

The zone is resolved from the parcel's `zone_id`, or by **spatial containment**
(largest overlap) when unassigned — so an unzoned parcel returns
`UNZONED / PENDING_REVIEW` rather than a misleading answer.

---

## 10. Demonstration F — Graceful degradation

**Claim:** if QGIS Server stops, the portal keeps working on Pipeline A.
This is the most reassuring demo for a council audience.

```bash
# 1. Take QGIS Server down
docker compose -f docker-compose.qgis.yml stop

# 2. The backend notices
curl -s http://localhost:3000/api/ogc/health      # → "status":"degraded"
```

3. Reload **http://localhost:5174/qgis-map** — the map still draws every layer,
   now using client-side vector styling from the statutory colour schedule.

```bash
# 4. Bring it back
docker compose -f docker-compose.qgis.yml start
curl -s http://localhost:3000/api/ogc/health      # → "status":"healthy"
```

5. Reload — pixel-perfect rasters return automatically.

**What to point out:** the citizen never sees a broken map. Fidelity degrades;
availability does not.

---

## 11. Deep dive — how each mechanism works

### 11.1 Symbology: two routes from QGIS to the browser

**Route 1 — style translation (Pipeline A).**
`perfectQGISStyleExtractor.js` parses the QGIS renderer XML and emits MapLibre
paint expressions:

| QGIS renderer | MapLibre output |
|---|---|
| `singleSymbol` | flat `fill-color` / `line-color` / `circle-color` |
| `categorizedSymbol` | `["match", ["get", attr], …]` — one colour per class |
| `graduatedSymbol` | `["step", ["to-number", …], …]` — numeric ranges |
| `RuleRenderer` | primary rule's symbol (filters do not translate) |

Per-layer **QML sidecars** in `qgis-projects/styles/<table>.qml` take priority
over the renderer embedded in the `.qgs`, so exporting a style from QGIS
Desktop (*right-click layer → Export → Save Style As → QML*) restyles the
portal without touching code.

**Route 2 — QGIS Server (Pipeline B).** No translation at all: QGIS renders,
the browser displays the bytes.

### 11.2 Why the project file's CRS block matters

Each layer's `<spatialrefsys>` must carry a **complete** CRS definition
(`proj4`, `srid`, `srsid`, acronyms, `geographicflag`) — not just `authid`.
With an incomplete definition QGIS cannot construct a transform: EPSG:4326
requests render correctly (no transform needed) while **EPSG:3857 — the CRS
MapLibre requests — silently draws the data near 0,0 instead of Zimbabwe.**

*Diagnostic:* request a 3857 map using degree values as the bbox
(`BBOX=29.0,-20.0,30.2,-19.0`). If content appears there, the CRS blocks are
incomplete.

### 11.3 Why `PGSERVICEFILE` must be a `fastcgi_param`

Layers connect via `service='vungu'`, resolved from a `pg_service.conf`.
QGIS Server's FCGI worker takes its environment from the **FastCGI request
parameters**, not the container's environment — so a Docker `environment:`
entry never reaches libpq, and every layer fails with
`definition of service "vungu" not found` → `Layer(s) not valid`.
It is therefore passed in `nginx-qgis.conf` as a `fastcgi_param`.

### 11.4 Why the NOTIFY payload carries no geometry

`pg_notify` has an 8000-byte payload limit. The trigger sends only
`{schema, table, op, id}`; the browser re-requests the affected tiles, which
are cached and GiST-indexed. This keeps a 500-row save to a single small event.

---

## 12. Honest scope and known limitations

State these plainly — they strengthen a demonstration rather than weaken it.

**Where fidelity is exact**
- Any layer served through QGIS Server WMS (Pipeline B) is pixel-identical,
  because it *is* QGIS output.

**Where fidelity is approximate**
- The client-side vector path (Pipeline A) flattens **hatch/pattern fills**,
  **gradient fills**, **rule-based renderers** (only the primary rule renders)
  and **custom SVG markers** (drawn as circles). Symbol draw-order levels,
  blend modes and draw effects are not translated.
- The main citizen/home map currently uses Pipeline A with the statutory
  colour schedule. The dedicated **QGIS map view** (`/qgis-map`) is the surface
  that auto-switches to pixel-perfect rasters.

**Environment notes**
- QGIS Server runs in Docker; if Docker is not running, the portal operates in
  degraded (vector) mode by design.
- The PyQGIS plugin's REST contract is verified end to end over real HTTP
  ([Demo C](#7-demonstration-c--the-pyqgis-plugin-round-trip)). Its in-QGIS UI
  requires a working QGIS Desktop installation to exercise interactively.

---

## 13. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ServerException: Layer(s) not valid` | QGIS Server cannot reach PostGIS | Check `pg_service.docker.conf` password; confirm `PGSERVICEFILE` is a `fastcgi_param`; check `pg_hba.conf` allows `172.16.0.0/12` |
| WMS returns a ~1 KB blank PNG at the correct extent | Project CRS blocks incomplete → no reprojection | Complete every `<spatialrefsys>` (§11.2), then `docker compose -f docker-compose.qgis.yml restart qgis-server` |
| `BBOX … cannot be converted into a rectangle` | WMS 1.3.0 axis order | With EPSG:4326 use `miny,minx,maxy,maxx` |
| `/api/ogc/health` = `degraded` | Backend cannot reach QGIS Server | Confirm containers are up and `QGIS_SERVER_URL=http://localhost:8080`; restart backend |
| No SSE events on edit | Migration 109 missing, or listener started before it | Apply the migration, then **restart the backend**; confirm the `[spatial-listener]` log line |
| Symbology changes in QGIS don't show | Style cache | Re-export the QML sidecar and restart the backend |

**Reading the container logs** — the single most useful command:

```bash
docker compose -f docker-compose.qgis.yml logs --tail=40 qgis-server
```

---

## 14. Appendix — cheat sheet

### Start everything

```bash
# 1. QGIS Server
cd vunguwebapp-backend && docker compose -f docker-compose.qgis.yml up -d

# 2. Backend
node server.js

# 3. Frontend
cd ../vunguwebapp-frontend && npm run dev
```

### Verify everything

```bash
node scripts/verify-qgis-server.js     # pixel-perfect rendering chain
node scripts/test-qgis-loop.js         # plugin push/pull round trip
node test-tiles-endpoint.js            # vector tile service
curl -s http://localhost:3000/api/ogc/health
```

### Key files

| File | Role |
|---|---|
| `qgis-projects/vungu-project.qgs` | The project QGIS Server renders |
| `qgis-projects/styles/<table>.qml` | Per-layer council symbology (takes priority) |
| `qgis-projects/nginx-qgis.conf` | OGC endpoint + FCGI params |
| `docker-compose.qgis.yml` | QGIS Server + nginx |
| `migrations/109_spatial_change_notify.sql` | Live-sync triggers |
| `src/services/spatialChangeListener.js` | LISTEN → SSE bridge |
| `src/services/admin/perfectQGISStyleExtractor.js` | QGIS renderer → MapLibre paint |
| `frontend/src/map/masterplanSymbology.ts` | Statutory colour schedule |

### Suggested 10-minute demonstration order

1. **Health check** (§4) — everything green. *30 s*
2. **Demo A** (§5) — QGIS Desktop beside the browser. *3 min*
3. **Demo B** (§6) — edit in QGIS, watch the browser update itself. *3 min*
4. **Demo C** (§7) — plugin round trip, including the rejected forged token. *2 min*
5. **Demo F** (§10) — stop QGIS Server, show the map still works. *1 min*
6. **Limitations** (§12) — state them plainly. *30 s*

---

*End of document — Theophelos Madzinga, Computer Science Intern, Vungu Rural District Council.*
