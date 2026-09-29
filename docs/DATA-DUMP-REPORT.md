# Data dump / rebuild report

**Verdict:** Operational schema is migration-managed. **Basemap geometry lives in raw PostGIS tables** (`public.buildings`, `public.roads`, …). Runtime never queries GeoPackage.

## Live vs repo

| Layer | Source | In migrate-render? |
|-------|--------|--------------------|
| App schema (users, permits, clerk, eho, council_ops, …) | Migrations 001–128 | Yes |
| `zones_master` / proposed peri-urban | 112, 113, 128 | Yes |
| Stands tile view | 080_stands_tile_view | Yes |
| 3NF + `zone_id_int` | 126, 127 | Yes |
| `vungu_clip_boundary` | 129 | Yes (boundary only) |
| OSM feature tables clipped to Vungu | `scripts/clip-osm-to-vungu.js` | Script (not SQL-only) |
| Original national OSM load | Historic import into Postgres | One-time |

## Runtime query path (SSOT)

`spatialLayers.js` → table name → `ST_AsMVT` on **Postgres**. Do not point tiles at `.gpkg`.

## Ops ladder

1. Run `migrate-render.js` allowlist (includes 129 boundary).
2. If OSM tables are national-scale, run `node scripts/clip-osm-to-vungu.js` (or buildings two-phase SQL).
3. Smoke: `GET /ready` + tile for `roads` / `buildings` / `zones_master`.
