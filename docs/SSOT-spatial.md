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
| **Peri-urban zoning** | `proposed_peri_urban_zones` (aliased `zones_master` view for the map) | tiles (`spatialLayers.js`), QGIS (`vungu-project.qgs`), permits (`development-control-refactored.js`, fn `075`), zone-editing CRUD (`zones.js`), search (`map-search.js`, `tiles.js`) | Single master. `id` is the FK target for `development_matrix`, `gweru_rural_farms.zone_id`, `zone_land_use_controls`. `updated_at` is maintained by `trg_touch_updated_at`, not by hand — this is the one table a planner edits straight from QGIS Desktop, so no application statement runs on an edit. **`vungu_proposed_peri_urban_zones` is gone**, finally: see the correction below. |
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
| 5 | Re-do phase 4 for real — the 2026-10-02 recovery restored the copy from a dump, along with the FK still bound to it. `migrations/134_zones_single_source.sql` retargeted `zone_land_use_controls.zone_id` to `proposed_peri_urban_zones(id)` (uuid → integer), dropped the copy without CASCADE, and added `trg_touch_updated_at` | **done** |
| 6 | `migrations/135_zones_area_ha.sql` — `area_ha` as a STORED generated column. `zones.js` referenced a column that only ever existed on the dropped copy, so every route in the file returned 500 | **done** |
| 7 | `migrations/136_zones_id_sequence.sql` — a sequence + DEFAULT for `id`, without which drawing a new zone in QGIS fails the NOT NULL constraint | **done** |

### Phase 4 was not actually done (corrected 2026-10-05)

Every row above was marked **done**, and phases 1–3 genuinely were — but phase 4 was
recorded without being executed, or executed and then undone. The 2026-10-02
database recovery restored `vungu_proposed_peri_urban_zones` from a dump, and with
it the one foreign key still pointing at it. `SSOT-database.md` had already
predicted this ("divergent FK hazard", line 150); the prediction was right and
nothing acted on it.

Two live defects ran for the whole interval, both invisible to a schema review that
trusted this table:

1. **Every land-use-control request returned 500.** `zone_land_use_controls.zone_id`
   was `uuid`, bound to the copy. All consumers pass `proposed_peri_urban_zones.id`,
   which is `integer`, so `POST /planning-assistant/decide` and
   `POST /zones/:id/controls` both raised `invalid input syntax for type uuid`.
2. **Edits to the copy were silently discarded.** It carried a live
   `trg_notify_spatial_change`, so a write announced the zones layer, the backend
   invalidated the tile cache, pushed SSE and the browser re-rendered — all from
   `zones_master`, which does not read that table. The authoring tool reported
   success and nothing appeared on the map.

Only the second one was visible, and only because `GET /api/qgis/sync/coverage`
reports it as `shadowed`. The lesson is in the coverage screen, not in this table:
a relation that resolves to a valid layer id but is not the table behind it is a
write that reports success and does nothing.

### The zones feature had four independent breakages, not one (found 2026-10-05)

Phase 3b repointed `zones.js` at the canonical table and marked itself done. The
*table* references were correct; the *column* and *type* references were not, and
nobody called the endpoints, so nothing failed until the routes were exercised:

| Where | Reference | Reality | Effect |
|---|---|---|---|
| `zones.js:50,89` | `SELECT z.area_ha` | column only existed on the dropped copy | 500 on every route |
| `zones.js:141` | `INSERT ... area_ha` | same | zone creation dead |
| `zones.js:187` | `SET area_ha = ...` | same, and hand-computed | zone editing dead |
| `zones.js:104,237` | `JOIN ... ON lug.group_id` | PK is `land_use_groups.id` | 500 on both control reads |
| `planningAssistant.js:84,147` | `lug.group_name` | column is `description` | `/planning-assistant/decide` 500 |
| `land-use-management-enhanced.js:55,61,63,553` | `lug.group_id` | PK is `id` | land-use group list 500 |
| `proposed_peri_urban_zones.id` | `NOT NULL`, no default | no sequence anywhere | **drawing a zone in QGIS fails** |

The last one is the serious one. `vungu-project.qgs` binds the zones layer to
`zones_master` with `key='id'`, and QGIS does not invent values for an integer
primary key on a PostGIS layer. Adding a feature failed on the NOT NULL
constraint. Editing worked, which is why the live-sync tests never caught it —
they only ever edit.

Fixed by 135 (`area_ha` generated, so Postgres maintains it on QGIS geometry
edits instead of application SQL that goes stale) and 136 (a value source for
`id`). The `lug.*` corrections are code-only.

Still broken, deliberately not touched: `development-control-refactored.ts:496`
joins `dm.group_id` (absent — `development_matrix` uses `use_code`),
`permission_types` (table does not exist) and `lug.group_id` (absent). Three
independent breakages in one query against a redesigned matrix. Fixing it means
deciding what `use_code` is supposed to join to, which is a design question, not
a repair.

### Rollback
The copy is dropped. To restore it: `migrations/134_zones_single_source.down.sql`
(recreates the copy from the canonical table, including geometry), or
`backups/vungu_proposed_peri_urban_zones-pre-drop-2026-10-05.sql` for the exact
pre-drop contents. The `.down.sql` deliberately reinstates the uuid FK — that is the
pre-134 state, and it reinstates the 500 with it.

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
