# Remaining 10% Implementation Notes

This documents what was added to close the gap between the implemented
system and the architecture described in the paper.

## 1. OpenLayers editing workspace (Phase 1)

- Installed `ol`, `@types/ol`, `ol-mapbox-style` in `app-frontend`.
- New component: `src/components/OpenLayersEditorMap.vue`.
  - Vector layers loaded from `GET /api/ogc/wfs/features/:layer`
    (GeoJSON, with TopoJSON support).
  - Editing: Select / Modify / Snap interactions, drawing tools.
  - WFS-T save path via `saveEdits()`.
- `VunguPlannerView.vue` now exposes an **Open OpenLayers editor** toggle
  in the planner map pane, visible to `planner`, `gis_officer`, and
  `admin` roles only. MapLibre remains the default/public renderer.

## 2. Transactional WFS / WFS-T (Phase 2)

- New route: `POST /api/ogc/wfs/transaction` in
  `src/routes/wfsTransaction.js`, registered in `server.js`.
- Accepts `{ typeName, features, insert, update, delete }` JSON.
- Role-restricted to `planner`, `gis_officer`, `admin`.
- Identifier-validated table names, reject private tables
  (`users`, `sessions`, …), reads a layer only when it is a published
  `spatial_layers` row or a `qgis_*` staging table.
- Wraps INSERT/UPDATE/DELETE in a transaction, returns counts.

## 3. FlatGeobuf transport (Phase 4)

- `npm i flatgeobuf` added to both apps.
- New endpoint: `GET /api/tiles/fgb/:layer` returns the layer as
  FlatGeobuf (50k feature cap), served with
  `Content-Type: application/flatgeobuf` and a 7-day cache header —
  the low-cost single-file option for desktop synchronisation and
  offline caching.

## 4. PMTiles static hosting (Phase 4)

- `npm i pmtiles` added to both apps.
- New endpoint: `GET /api/tiles/pmtiles/:archive` serves `.pmtiles`
  archives from `PMTILES_DIR` (default `app-backend/data/pmtiles`).
- Frontend glue: `src/services/pmtilesProtocol.ts` registers the
  `pmtiles://` protocol with MapLibre and builds
  `pmtiles:///api/tiles/pmtiles/<archive>` source URLs.

## 5. TopoJSON for bulk desktop sync (already mostly present)

- `GET /api/tiles/topo/:layer` already returns simplified TopoJSON for
  admin boundary layers; `GET /api/qgis/sync/download/:layerName` and
  the WFS bridge already emit TopoJSON for large desktop pulls.

## Verification

- `npx vue-tsc --noEmit` passes for the frontend.
- `node -e "require('./src/routes/tiles.js')"` and the wfsTransaction
  module load cleanly; `node -e "require('./server.js')"` boots past
  route registration.
- `npx jest test/style-extractor.test.js` (13/13) still passes.
