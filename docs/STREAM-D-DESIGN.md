# Stream D design — tiered spatial-data transports

Goal: static reference layers (admin boundaries, country-wide roads/roads
network, land-use) served cheaply and decoded in the browser without hitting
PostGIS on every pan.

## Target formats

| Layer class | Current transport | Target static transport |
| --- | --- | --- |
| `districts`, `wards`, `places`, admin boundaries | MVT route (`/api/tiles/*`) | `.pmtiles` single file |
| `roads`, `buildings` (clipped) | MVT route | FlatGeobuf (`.fgb`) |
| edited parcels / hazard reports | GeoJSON / WFS | keep |
| desktop sync from QGIS | GeoPackage | TopoJSON bulk export (already at `/api/...` via dynamic-layers) |

## Backend generation seam

`src/services/staticTiles.js` (to be added):
- `buildPMTiles({ table, geomColumn, where, zMax })` → shells out to
  `tippecanoe -zg -o public/static/<table>.pmtiles --force ...` when on PATH;
  otherwise returns `{ ok: false, reason: 'tippecanoe_not_available' }`.
- `buildFlatGeobuf({ table, geomColumn })` → `ogr2ogr -f FlatGeobuf out.fgb ...`
  via the same QGIS/OSGeo4W binaries discovery logic `setup-spatial` uses.

Route (to be added, `src/routes/staticExports.js`):
`GET /api/static/:table/version` → short text: `static-<sha>` describing last
built version, so the frontend can cache-bust. `/api/static/:table/<size>`
would conflict with a SPA fallback catch-all, so files sit under `/static/…`.

## Frontend

- MapLibre consumes `pmtiles://` on the public map explorer for districts when
  the file's `version` matches its advertised version (cache-bust on
  republish), else falls back to `/api/tiles/*` MVT.
- The planning-officer editing workspace stays MapLibre + @mapbox draw for now;
  the OpenLayers evaluation in `app-frontend/docs/research/2026-06-02-spatial-libraries-comparison.md`
  remains the second step of Stream D.

## Out of scope for the first slice

- Automatic re-generation on data change (cron) — manual via
  `npm run build:static`.
- PMTiles from arbitrary user tables — only curated entries in
  `src/config/spatialLayers.js` are candidates.
