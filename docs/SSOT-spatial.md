# Spatial Single Source of Truth (SSOT)

**Rule:** every real-world spatial concept is mastered in **one** canonical PostGIS
table (or a view over it). All consumers — vector tiles, QGIS Server WMS, and the
permit-system APIs — read that canonical source. No divergent copies.

Symbology is a separate SSOT: geometry + classification live in the canonical
table; **colour** comes from `frontend/src/map/masterplanSymbology.ts` and is
generated into QGIS by `frontend/scripts/generate-qgis-symbology.mjs`. One zone
name → one colour → one geometry.

---

## Canonical map (concept → table → consumers)

| Concept | Canonical | Consumers | Notes |
|---|---|---|---|
| **Peri-urban zoning** | `zones_master` (view over `proposed_peri_urban_zones`) | tiles (`spatialLayers.js`), QGIS (`vungu-project.qgs`), permits (`development-control-refactored.js`, fn `075`) | `proposed_peri_urban_zones.id` is the FK target for `development_matrix`, `gweru_rural_farms.zone_id`, `zone_land_use_controls`. **`vungu_proposed_peri_urban_zones` is legacy** — kept only as rollback until Phase 3/4. |
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

The two tables are *not* clean supersets (18 shared `fid`, 11 vs 12 zone names),
so their geometries need council reconciliation before the copy is dropped —
that is Phase 3, deferred.

---

## Migration phases

| Phase | What | Status |
|---|---|---|
| 0 | `pg_dump` backup of zone + FK tables → `qgis-projects/_db-backups/`; add `ZONES_CANONICAL_SOURCE` flag | **done** |
| 1 | `migrations/112_zones_master_view.sql`: `ST_MakeValid` the master, `CREATE VIEW zones_master` | **done** |
| 2 | Repoint map: `spatialLayers.js` (flag) + `vungu-project.qgs` datasource → `zones_master` | **done** |
| 3 | **Council review (staging):** reconcile geometry — where `vungu_*` polygons are authoritative, `UPDATE proposed_peri_urban_zones … FROM vungu_* … ON z.zone_code = v.zone_code` (business key, never `fid`) | **deferred — needs council sign-off** |
| 4 | `DROP TABLE vungu_proposed_peri_urban_zones CASCADE`; remove its `spatialLayers.js` entry + frontend tile-id refs | **deferred — after Phase 3** |

### Toggle / rollback
`ZONES_CANONICAL_SOURCE=master` (default) → tiles read `zones_master`.
Set `=vungu` and revert the one `vungu-project.qgs` datasource line to fall back
to the legacy copy. The legacy table is intact until Phase 4, so rollback is
lossless.

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

- Zone **geometry** still diverges between master (37) and legacy copy (36 valid) — resolved only in Phase 3.
- `stands` dual geometry-type registration.
- Mixed SRIDs across concepts (4326 master-plan vs historically-900914 basemap).
