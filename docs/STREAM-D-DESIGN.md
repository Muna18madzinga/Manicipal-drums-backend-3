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

`scripts/build-static-pmtiles.mjs` (prototype verified 2026-10-02 on the
post-GWERU-legacy PostGIS build):

1. Read layer extent via PostGIS (`ST_Extent`).
2. Walk Web-Mercator z/x/y in `--minzoom..--maxzoom`.
3. GET each `/api/tiles/:layer/:z/:x/:y.pbf` (exact same pipeline the live map
   uses) and store the gzip-wrapped MVT chunks in an MBTiles sqlite store.
4. `pmtiles convert` (Protomaps go-pmtiles; optional MDK binding — service
   calls `PMTILES_BIN || 'pmtiles'`).

`src/services/staticTiles.js` wraps this seam for the route layer and reports
`{ ok: false, reason }` for missing tooling.

Discovery: we originally tried tippecanoe (MSYS2 has no package) and GDAL's
PMTiles driver (read-only in 3.9.2). The node:sqlite + go-pmtiles pipeline is
the reproducible path on this supervisor stack.

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
