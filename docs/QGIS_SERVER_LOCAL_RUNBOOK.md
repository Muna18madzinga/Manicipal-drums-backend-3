# Runbook — turn on pixel-perfect QGIS↔web fidelity (local Docker)

**Goal:** make the web map show *exactly* what QGIS Desktop shows — hatch
fills, gradients, rule-based renderers, SVG markers, everything — not the
client-side approximation. The only missing piece is a running **QGIS Server**
rendering `vungu-project.qgs`; everything else (OGC bridge, frontend WMS
consumption, auto-selection, live refresh) is already built.

When QGIS Server is up and healthy the web app switches to its rasters
automatically; when it's down the app falls back to client-side vector
styling with no breakage.

---

## What already works (no action needed)

- **Live updates.** Migration 109 attaches a NOTIFY trigger to every spatial
  table; `spatialChangeListener` → SSE `/api/map/events` → the browser
  refreshes the changed layer in <1s. A planner editing PostGIS from QGIS
  Desktop already shows up live. (Proven: an `UPDATE` delivers
  `{"layer":…,"action":"changed","source":"postgis"}` to the browser stream.)
- **Vector styling** from the council QML sidecars — the approximate but
  always-on path.

## What this runbook turns on

- **QGIS Server** renders the real project → pixel-perfect WMS rasters.

---

## Prerequisites

1. **Docker Desktop** installed and running (`docker --version` works).
2. The backend DB (`Vungu_spatial333`) reachable from Docker (steps below).

## Steps

### 1. Container DB config
```bash
cd vunguwebapp-backend
cp qgis-projects/pg_service.docker.conf.example qgis-projects/pg_service.docker.conf
# edit it: set the real password (host is already host.docker.internal)
```

### 2. Let host Postgres accept the container
The container reaches Postgres as `host.docker.internal`. Postgres must listen
and allow the Docker subnet:

- `postgresql.conf`: `listen_addresses = '*'`
- `pg_hba.conf`: add `host all all 172.16.0.0/12 scram-sha-256`
- Restart Postgres. (Windows: also allow Postgres through the firewall.)

### 3. Start QGIS Server
```bash
docker compose -f docker-compose.qgis.yml up -d
```

### 4. Point the backend at it (already the default)
Backend `.env` already has `QGIS_SERVER_URL=http://localhost:8080`. Restart the
backend so `/api/ogc/health` re-checks.

### 5. Verify — one command, self-diagnosing
```bash
node scripts/verify-qgis-server.js
```
Green across the board = QGIS pixels are live; the web app auto-switches. Any
red line prints the exact fix.

---

## How the pieces connect

```
QGIS Desktop  ─save .qgs/.qml─►  qgis-projects/  ◄─read─  QGIS Server (container)
                                      │                        │ renders WMS
        planners edit PostGIS         │ bind-mount :ro         ▼
   ┌──────────────────────────────────┴──────────┐   nginx :8080  ◄─ QGIS_SERVER_URL
   │            PostgreSQL + PostGIS              │        │
   │  migration 109 NOTIFY trigger on every table│        ▼
   └───────┬─────────────────────────────────────┘   Fastify backend
           │ LISTEN/NOTIFY                                │ /api/ogc/wms/*  (proxy)
           ▼                                              │ /api/ogc/health (drives auto-select)
   spatialChangeListener ─► SSE /api/map/events ─────►  Vue + MapLibre
                                                          · healthy → QGIS WMS rasters (pixel-perfect)
                                                          · down    → vector fallback
                                                          · SSE event → refresh changed layer live
```

## Troubleshooting (the verify script names which one)

| Symptom | Cause | Fix |
|---|---|---|
| Can't reach :8080 | container not up | `docker compose -f docker-compose.qgis.yml logs` |
| GetCapabilities empty | project didn't load | wrong `QGIS_PROJECT_FILE`, or datasources can't connect — check step 2 + `pg_service.docker.conf` password |
| GetMap returns XML exception | layer's PostGIS source unreachable from container | `host.docker.internal` / `pg_hba` / credentials |
| `/api/ogc/health` degraded | backend can't reach :8080 | `QGIS_SERVER_URL`, restart backend |

## Production (Render) note
Same design: run QGIS Server as a service, bind-mount/copy `qgis-projects/`,
set `QGIS_SERVER_URL` on the backend, give the container a `pg_service.conf`
pointing at the managed Postgres. The `image: qgis/qgis-server` + nginx pair
in `docker-compose.qgis.yml` is the template.
