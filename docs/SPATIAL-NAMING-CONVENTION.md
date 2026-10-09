# Spatial naming convention and layer ids

Status: proposed on 9 October 2026, for the first step of the direction in
[SPATIAL-MODEL-AUDIT-2026-10-09.md](./SPATIAL-MODEL-AUDIT-2026-10-09.md). Nothing has been renamed. The registry that
records the mapping is in the database (migration 162): `spatial_concept`, `spatial_concept_source`,
`spatial_concept_summary`. Read it with `SELECT * FROM spatial_concept_summary`; check it with
`node scripts/verify-spatial-registry.js`.

## The idea

A **concept** is the thing in the world: a cadastral parcel, a watercourse, a planning zone. It has one generic, authority-free
code, and that code is the **stable layer id** used by the tile config, the QGIS project, the catalogue and the registry.
A **table** is only a *source* of a concept, and says what role it plays. So a table can be renamed, merged or retired without a
layer id changing, and a second council adds rows, not tables.

## Rules

1. **No authority in a name.** Never `vungu_`, `gweru_`, `harare_`. The authority is a column (`authority_id`) on a table that is
   scoped to authorities, or the jurisdiction it falls in. (`scripts/verify-plan-model.js` fails if a concept code names one.)
2. **No source, status or history in a name.** Never `proposed_`, `master`, `legacy`, `_v2`, `_tile_view`, or a source's own name
   (`pois_a_free_1`). A view says what it is for in the registry, not in its name.
3. **Concept codes** are lower-case snake_case, singular, domain first where it helps: `admin_ward`, `cadastral_parcel`,
   `planning_zone`, `watercourse`, `flood_zone`. A concept is named for what it is, not for how it is drawn.
4. **Table names** are singular snake_case. A geometry suffix (`_area`, `_point`) is used only when one concept is stored in more
   than one geometry kind (points of interest drawn as both). Tables live in a schema for their domain.
5. **Schemas by domain**, reusing what already exists: `admin`, `land`, `spatial_planning`, `council_ops`, `survey`, plus new
   `basemap` (imported reference data) and `constraint` (what limits development). The flat `public` schema stops being the home
   of spatial data.
6. **Keys:** `id` (never `fid`, never `<entity>_id` as the primary key). Imported identifiers are kept as `source_id`
   (`osm_id`) with a `source` column.
7. **Geometry:** the column is `geom`. Areas and lines are stored as the Multi type, so a table never mixes POLYGON and
   MULTIPOLYGON. One SRID per table: EPSG:4326 for everything the portal displays; survey tables keep their working CRS (22291,
   Cape datum, pending the DSG decision) and expose a 4326 column beside it.
8. **Types:** a number is a number (areas, lengths, populations), a yes/no is a boolean (not `'T'`/`'F'`), a missing value is NULL
   (not `0` or an empty string).
9. **Derived values are not stored.** Area, length and the other unit conversions are computed from the geometry in a view. A
   stored area that disagrees with its geometry is a bug that cannot happen if it is never stored.
10. **Classes are data, not columns of codes.** A class column (`class`, from the source's `fclass`) with a lookup, and no
    second `code` column that says the same thing.
11. **One registry.** The QGIS project declares which concepts are shown; `layer_publication` approves them; the tile config says
    how a source becomes tiles. A layer is identified by its concept code in all three.

## Mapping from today's names

The full list, with each table's role, is in `spatial_concept_source`. The principal moves:

| Concept (layer id) | Target | Canonical today | To retire |
|---|---|---|---|
| `admin_country`, `admin_province`, `admin_district` | `admin.country`, `admin.province`, `admin.district` | `country`, `provinces`, `districts` | `admin_areas` (OSM duplicate) |
| `admin_ward` | `admin.ward` (key: `pcode`) | `wards` (1,961) | the empty `admin.ward` is filled, not replaced |
| `authority_area` | `admin.authority_area` (union of an authority's wards, versioned) | none: interim boundaries only | `gweru_rural_planning_boundary`, `vungu_clip_boundary` |
| `cadastral_parcel` | `land.parcel` (validity dates, CRS, accuracy, `authority_id`) | `vungu_parcels` | `vungu_farm_cadastre`, `gweru_rural_farms`; `stands` becomes a source |
| `planning_zone` | `spatial_planning.zone` (name, type and authority resolved through the plan) | `proposed_peri_urban_zones` | `gweru_peri_urban_zone`; `vungu_beyond_peri_urban_zones` becomes zones of a plan |
| `building` | `basemap.building` | `buildings` | |
| `road`, `railway` | `basemap.road`, `basemap.railway` | `roads`, `railways` | |
| `watercourse`, `waterbody` | `basemap.watercourse`, `basemap.waterbody` | `waterways`, `water_areas` | `gweru_rivers` (merge as a source) |
| `protected_area`, `natural_feature`, `landuse` | `basemap.*` | `protected_areas`, `natural_*`, `landuse` | |
| `place`, `point_of_interest`, `transport_feature` | `basemap.place`, `basemap.poi`, `basemap.transport_feature` | `places_*`, `pois_*` and `places_of_worship_*`, `traffic_*` and `transport_*` | `gweru_business_centres`, `gweru_health_centres`, `places` |
| `cemetery`, `waste_facility` | `council_ops.cemetery`, `council_ops.waste_facility` | `vungu_cemeteries`, `vungu_waste_management` | |

The basemap's own columns follow rules 6, 8 and 10: `fid` becomes `id`, `osm_id` becomes `source_id`, `fclass` becomes `class`,
the redundant `code` is dropped, `bridge`/`tunnel`/`oneway` become booleans, and the constant `level` column on the admin tables
goes.

## How a move is made (so nothing breaks)

1. **Registry** (done, migration 162): every spatial table is classified, with its role. A check keeps it complete.
2. **Compatibility views:** for one concept at a time, create the target relation as a *view* over the canonical source, under the
   new name, with the new column names. Nothing moves; the old table still serves everything that names it.
3. **Switch consumers** to the view or the layer id: the tile config, the QGIS project, the SQL functions (`parcel_geometry`,
   `resolve_stand_parcel`, `check_development_permission`), the routes and the frontend. Each is a small change with a test.
4. **Move the data:** make the target a real table, load the source into it, and turn the old name into a view, concept by
   concept, using `scripts/retire-duplicate-table.js` (it refuses unless features match, nothing reads the old name and a dump
   exists).
5. **Drop the old names** when nothing reads them.

Order: the concepts with the most damage and least reach first (`cadastral_parcel`, `admin_ward` with `authority_area`), then
`planning_zone` (25 backend files and 30 migrations name it), then the basemap.

## Adding a second authority

No new tables and no new names. The authority gets: a row in `local_authorities` and its wards in the authority-to-ward
relation (which defines `authority_area`); its parcels, zones and assets as rows with its `authority_id`; layer rows in the
registry that point at the same concepts. What it cannot do, and never needed to, is create `<authority>_parcels`.

## Decisions (9 October 2026)

1. **Each authority has its own QGIS project.** The project is the authority's declaration of what its map shows. A layer in
   any project is identified by its data source, which the registry maps to a concept (`spatial_concept_source`), so a layer's
   name inside a project is the authority's own title and never has to match anything. The catalogue service still reads one
   project; reading the project of the authority a request belongs to is the next change there.
2. **The basemap is extracted per authority when it joins**, not held nationally. The extract is cut to the authority's area
   (`admin.authority_area`), loaded as rows of the same `basemap.*` concepts, and the authority is recorded on what it brought.
   The clip that exists today is the Gweru and Vungu one, made by hand.
3. **First concepts: `cadastral_parcel`, `admin_ward` and `authority_area`.** Status below.
4. Still open: whether `survey` keeps its own working CRS or converts on load, once the Surveyor-General confirms the datum.

## Progress on the first three concepts

| Concept | Done | Not yet done |
|---|---|---|
| `admin_ward` | `admin.ward` is canonical (1,961 wards with their old ids, a parent code, a delimitation and validity dates). `public.wards` is now a read-only view over it, so tiles, routes and QGIS are unaffected; the stands foreign key moved too. | Replace the COD-AB wards with the ZEC delimitation (1,970) when the data arrives. |
| `authority_area` | `admin.authority_ward` (versioned: a ward belongs to one authority at a time, with the instrument that fixed it) and the view `admin.authority_area` (the union of an authority's current wards, a combination's from its members', provisional while any ward is interim). `scripts/set-authority-wards.js` records memberships. Vungu has the 19 Gweru-district wards, marked **interim**. | The council's real ward list and the proclamation reference. The interim set is the Gweru district, which is not Vungu RDC. |
| `cadastral_parcel` | `land.parcel` can hold farms (kind, cadastre reference, tenure class, authority, origin, source and key). 731 of the 733 `vungu_parcels` are loaded by `scripts/load-parcels-into-land.js`, with the area computed from the geometry, a ward and an authority. `--verify` shows every parcel falls in the same zone through either table. | Switch the readers (tiles, search, the engine's functions, the frontend) to `land.parcel`, then make `vungu_parcels` a view and retire `vungu_farm_cadastre` and `gweru_rural_farms`. `stands` follows later. |

## Can an authority's data update the national dataset?

Not directly, by design. Who may change a dataset is decided by who is its custodian, and the application records where every
change came from and offers it back; it never lets one authority's edit overwrite the copy every other authority reads.

| Kind of data | Who changes it | How |
|---|---|---|
| **The authority's own** (zones and plans, council assets, the locations of its cases, the allocation status of its stands) | The authority | Edited directly, through an edit session and a QA step inside the authority (`gis_ops.edit_session`, migration 133: an edit is invisible until approved, and a stale edit stops with a conflict). |
| **National data with a custodian** (wards and the council-to-ward list; parcels and boundary surveys; the national boundary) | The custodian only: ZEC for wards, the Surveyor-General for surveyed parcels, the Ministry for a council's area | An authority may hold a **local correction** (`land.parcel.origin = 'authority'`; never overwritten by a reload) and may **submit it** to the custodian with its evidence. The custodian publishes a new version (`valid_from` and `valid_to`, `land.parcel_lineage`), which flows to every authority. A submission the custodian accepts becomes a custodian row; one it rejects stays local and is flagged as such. |
| **Open basemap data** (roads, buildings, water from OpenStreetMap) | Anyone, upstream | Corrections are contributed to OpenStreetMap itself and arrive in the next extract. Not edited in our copy. |

What is in place: the `origin`, `source_relation`, `custodian_dept` and validity columns, the lineage table, edit sessions with
conflict detection, and the Surveyor-General platform as the intended custodian (per-dataset API keys and an audit log). What
is missing is the **submission and reconciliation path**: a record of a proposed change to custodian data, its evidence and its
outcome. It should be built with the Surveyor-General platform, because that is where a submission would be received.
