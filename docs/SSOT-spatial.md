# Spatial Single Source of Truth (SSOT)

**Rule:** every real-world spatial concept is mastered in **one** canonical PostGIS
table (or a view over it). All consumers — vector tiles, QGIS Server WMS, and the
permit-system APIs — read that canonical source. No divergent copies.

Symbology is a separate SSOT with its own document: see
**[SSOT-symbology.md](./SSOT-symbology.md)**. Geometry + classification live in the
canonical table; **colour** comes from the versioned style registry (`gis_style`,
migration 114), which QGIS Server, the web map and QGIS Desktop all compile from.
One zone name → one published style version → one colour → one geometry.

> Superseded (Aug 2026): colour previously came from
> `frontend/src/map/masterplanSymbology.ts`, generated into QGIS by
> `frontend/scripts/generate-qgis-symbology.mjs`. That arrow governed only 3 of 31
> layers and left the other 28 with hard-coded frontend colours. Both are now
> *inputs* to the registry rather than authorities.

**Data and style are independent.** `gis_layer.data_synced_at` and
`gis_style.published_at` are separate clocks: publishing a style never touches
geometry, and a data sync never changes symbology.

---

## Canonical map (concept → table → consumers)

| Concept | Canonical | Consumers | Notes |
|---|---|---|---|
| **Peri-urban zoning** | `proposed_peri_urban_zones` (aliased `zones_master` view for the map) | tiles (`spatialLayers.js`), QGIS (`vungu-project.qgs`), permits (`development-control-refactored.js`, fn `075`), zone-editing CRUD (`zones.js`), search (`map-search.js`, `tiles.js`) | Single master. `id` is the FK target for `development_matrix`, `gweru_rural_farms.zone_id`, `zone_land_use_controls`. **`vungu_proposed_peri_urban_zones` was dropped 2026-07-23** after all consumers were repointed. |
| Beyond peri-urban zones | `vungu_beyond_peri_urban_zones` | tiles + QGIS | consolidated 2026-07-23; `gweru_beyond_periurban_zones` dropped |
| Country boundary | `country` | tiles + QGIS (`zimbabwe` layer) | orphans `Countries`, `zimbabwe` table dropped |
| Basemap (buildings, roads, landuse, water, admin, POIs) | the 900914→4326 OSM tables | tiles only | country-wide reference; SRID historically 900914 (CRS84 alias), now 4326 |

**SRID:** master-plan tables are EPSG:4326. Any spatial join to a basemap table
must `ST_Transform` explicitly — do not assume a shared SRID across concepts.

---

## Why the permit table is canonical for zones (not the map copy)

`proposed_peri_urban_zones` (37 rows) carries the identity and integrity:
`id` PK, `zone`, `zone_code`, `is_active`, plus **three FK dependents** and
835 `development_matrix` rows + 262 farm assignments. `vungu_proposed_*` (42
rows, of which 6 had NULL geometry) is display-only. Making the permit table
canonical means **the ids never move → zero FK migration**; only the map moves.

Reconciliation turned out to be a **no-op**: the copy's polygons covered
**0.00%** of ground outside the master, and its only extra "zone" class
(`Densification Zone [MDR]`) was a null-geometry junk row. So the copy held
nothing authoritative — it was dropped rather than merged.

---

## Migration phases

| Phase | What | Status |
|---|---|---|
| 0 | `pg_dump` backup of zone + FK tables → `qgis-projects/_db-backups/`; add `ZONES_CANONICAL_SOURCE` flag | **done** |
| 1 | `migrations/112_zones_master_view.sql`: `ST_MakeValid` the master, `CREATE VIEW zones_master` | **done** |
| 2 | Repoint map: `spatialLayers.js` (flag) + `vungu-project.qgs` datasource → `zones_master` | **done** |
| 3 | Geometry reconciliation — **investigated: no-op** (copy 0.00% outside master; only extra class was null-geom) | **done (nothing to reconcile)** |
| 3b | Repair the zone-editing consumers that pointed at the copy: `migrations/113` added `ward`/`created_at`/`updated_at` to the master; repointed `zones.js`, `map-search.js`, `tiles.js` zone-search → `proposed_peri_urban_zones`; fixed a pre-existing `zlc.notes`→`conditions` bug in `zones.js` | **done** |
| 4 | `DROP TABLE vungu_proposed_peri_urban_zones CASCADE`; `spatialLayers.js` entry now backs onto `zones_master`; `ZONES_CANONICAL_SOURCE` flag retired | **done** |

### Rollback
The copy is dropped. To restore it: `psql -f qgis-projects/_db-backups/zones_ssot_20260723.sql`, then `git revert` the repoint commit. All zone consumers now read the single master, so there is nothing to toggle.

---

## Adding data to empty tables (no route breakage)

`gweru_health_centres`, `stands`, `development_applications` are empty. **Load
into the existing canonical table** — matching SRID 4326 and `geom` column —
never a parallel table; then tiles/QGIS/routes pick it up with no code change.

```bash
ogr2ogr -f PostgreSQL "PG:service=vungu" health_centres.shp \
  -nln gweru_health_centres -append -nlt PROMOTE_TO_MULTI \
  -t_srs EPSG:4326 -lco GEOMETRY_NAME=geom
psql ... -c "UPDATE gweru_health_centres SET geom=ST_MakeValid(geom) WHERE NOT ST_IsValid(geom);"
```

Edge cases:
- **`stands`** is registered twice in `geometry_columns` (POINT + POLYGON) — resolve to one type before loading; mind `stands_tile_view`.
- **`development_applications`** — leave to the app (permit creation writes it); a bulk load risks ID collisions.
- **`gweru_health_centres`** — leave empty until the council supplies official data; do not seed from OSM `pois_points` (keeps provenance clean).

---

## Known remaining smells (call-outs)

- ~~Zone geometry divergence~~ — **resolved**: single master, copy dropped.
- `stands` dual geometry-type registration (POINT + POLYGON) — resolve before loading data into it.
- Mixed SRIDs across concepts (4326 master-plan vs historically-900914 basemap).
- Migrations `079`/`081` (a never-applied UUID zone design) are dead relative to the current schema — `zones.js` was repaired against the applied integer-`id` master instead. Consider removing 079/081 to avoid confusing the next engineer.
