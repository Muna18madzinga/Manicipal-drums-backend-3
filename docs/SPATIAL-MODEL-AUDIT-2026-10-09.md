# Spatial data model audit, 9 October 2026

Question: are the spatial tables normalised, and are their names generic enough to serve every local authority?
Method: the development database (84 registered geometry columns), `src/config/spatialLayers.js`, the QGIS project,
the registries, and a search of the code for hard-coded names. Read only; nothing was changed.

**Short answer.** The spatial tables are not normalised, and their names are not generic. What exists is a good
*discipline* (one canonical table per concept, duplicates retired with evidence) laid over imported flat tables, beside a
designed, normalised model that nothing yet uses. The word "canonical" in `SSOT-spatial.md` means "which table masters this
concept", not "normalised", and it is easy to read the two as the same.

## 1. What is there

| Group | Tables | Rows | State |
|---|---|---|---|
| Country basemap (imported from a GeoPackage) | `country`, `provinces`, `districts`, `wards`, `roads`, `buildings` (139,619), `landuse`, `waterways`, 18 more | many | flat imports, generic names, `fid` keys |
| Vungu master plan | `proposed_peri_urban_zones`, `vungu_parcels`, `vungu_farm_cadastre`, `vungu_beyond_peri_urban_zones`, `vungu_cemeteries`, `vungu_waste_management`, `vungu_clip_boundary` | 36 to 733 | flat imports, authority in the name |
| Gweru legacy | `gweru_rural_farms`, `gweru_peri_urban_zone`, `gweru_rivers`, `gweru_chiefdoms`, `gweru_business_centres`, `gweru_health_centres`, `gweru_rural_planning_boundary` | 0 to 672 | legacy, still read by code |
| Designed model | `land.parcel`, `land.building`, `admin.ward`, `admin.village`, `council_ops.*`, `gis_ops.crs_registry` | **0** (a few rows in `council_ops.wash_asset`) | well designed, empty |
| Survey | `survey.*`, plus a schema per surveyor (`surveyor_surveyor_demo_surveyor`, `..._dev_surveyor`) | 0 | duplicate parcel and coordinate tables per surveyor |

## 2. Is it normalised? No. Evidence

1. **Four parcel models side by side.** `land.parcel` (the designed one: validity dates, CRS, accuracy class, custodian,
   ward foreign key; **0 rows**), `stands` (urban, 20 rows), `vungu_parcels` (733), `vungu_farm_cadastre` (687) and
   `gweru_rural_farms` (672), plus `survey.land_parcels` and one per surveyor. Three come from one extract. The
   engine's own functions accept only three of them, by hard-coded name (`parcel_geometry`, `resolve_stand_parcel`).
2. **Derived values stored as text, and wrong.** `vungu_parcels` keeps the area four times (`area_km2`, `area_ha`,
   `area_acre`, `area_km`), all as `text`, plus `shape_leng` and `shape_area`. Against the geometry they disagree: one parcel
   stores 179 ha and measures 305 ha; another stores 29 ha and has an empty geometry.
3. **One word, several meanings.** `vungu_parcels.status` holds a tenure or land class (Commercial 535, City 95, Purchase 59,
   State Land 29, Resettlement 6), not a status.
4. **A drawing table doing a record's job.** `gweru_rural_farms` mixes the shape, the cadastral attributes, the owner
   (`owner_id`), the title deed (`title_deed_info` JSON), compliance status and a `zone_id`. That `zone_id` points at a
   retired table (the known farm zone defect).
5. **Duplicated columns in `stands`.** `zone_type`, `zone_type_cache`, `zone_id` (uuid), `zone_id_int` and
   `statutory_plan_id` all describe the zone; `status` and `status_code`, `use_scale` and `use_scale_code`, `ward` and
   `ward_fid` are pairs.
6. **Zones store the plan's facts as text.** `proposed_peri_urban_zones` carries `zone`, `zone_type`, `authority` and `ward`
   as text, and also `plan_instrument_id` and `plan_zone_type_id` as keys. Twelve pairs of its 36 polygons overlap by more
   than 1,000 m²; the code settles overlaps by "prefer the zone with most rules".
7. **Two ward systems.** `wards` (1,961 rows; `pcode`, `parent_pcode`) and `admin.ward` (empty; `ward_code`). `stands`
   refers to the first, `land.parcel` to the second. Nothing relates a ward to an authority.
8. **No authority on any spatial table.** The only authority-like columns are free text (`proposed_peri_urban_zones.authority`,
   `road_asset.authority`). `local_authorities.jurisdiction` is a geometry column, empty for both authorities.

What is relational and sound: the administrative hierarchy (`provinces` > `districts` > `wards` by `pcode` and
`parent_pcode`), the link from a zone polygon to its plan and zone type, and the whole planning model (plans, zone types,
decisions, standards, activities).

## 3. Are the names generic? No

- **The authority is in the name.** `vungu_parcels`, `vungu_cemeteries`, `gweru_rivers`, `gweru_health_centres`. A second
  council would need its own set of names, and the code names them (`proposed_peri_urban_zones` appears in 25 backend
  files and 30 migrations; `stands` in 42 backend and 57 frontend files; `vungu_parcels` in 16 and 11).
- **Gweru residue.** Seven `gweru_*` tables for what is Vungu's data, and six of the nine layers in the QGIS project still
  carry `gweru_` in the layer name.
- **Three names for one thing.** The zone concept is the table `proposed_peri_urban_zones`, the view `zones_master`, the tile
  layer `vungu_proposed_peri_urban_zones` and the QGIS layer `proposed_peri_urban_zones` (plus the retired
  `gweru_peri_urban_zone`). The beyond-zone layer is `gweru_beyond_periurban_zones` in QGIS and
  `vungu_beyond_peri_urban_zones` in the database; the country layer is `zimbabwe` in QGIS and `country` in the database.
- **No convention.** Singular (`country`) and plural (`provinces`, `wards`); geometry suffixes from the source (`_areas`,
  `_points`) on some and not others; keys `id` (53 tables), `fid` (29), `parcel_id`, `ward_code`; the geometry column is `geom` in
  64 tables but `location` (10), `centroid`, `geometry`, `boundary` and others elsewhere; POLYGON in some tables and
  MULTIPOLYGON in others; SRID 4326, 22291 and 0 side by side.
- **Layer names and table names are tied.** The tile config keys a layer by a name that is also (usually) the table. There is
  no stable, generic layer id apart from the table.

## 4. Other findings the audit turned up

- **Six registries** answer "which layers exist": `spatial_layers` (42 rows), `gis_layer` (31), `layer_publication` (43),
  `gis_style` (33), `src/config/spatialLayers.js` (31) and the QGIS project (9). A table named `layers` also exists in two
  schemas. The catalogue (project declares, server approves) was built to reconcile them, and it does, but they are all still
  there.
- **Quality.** Invalid geometries in `gweru_rural_farms` (3) and `vungu_beyond_peri_urban_zones` (4); empty geometries in
  `vungu_parcels` (2), `gweru_rural_farms` (4) and `vungu_beyond_peri_urban_zones` (1). No spatial index on
  `gweru_health_centres`, `gweru_peri_urban_zone`, `admin.village` and `land.building`.
- **Reproducibility.** `SSOT-database.md` records that the country basemap tables and the canonical zones table are not
  created by any migration (they come from GeoPackage imports and a dump).
- **Per-person schemas.** One schema per surveyor does not scale to 92 authorities and their surveyors.

## 5. A direction (for decision, nothing built)

1. **Name by concept, never by authority.** Schemas by domain (`admin`, `cadastre`, `plan`, `infra`, `env`, `basemap`),
   singular nouns, one convention for keys (`id`) and geometry (`geom`, always multi-geometry, one SRID per table), and
   authority as a column (`authority_id`), never in the table name. For example `plan.zone`, `cadastre.parcel`,
   `admin.ward`, `infra.road`.
2. **Stable generic layer ids, separate from tables.** `planning_zone`, `cadastral_parcel`, `admin_ward`. The authority's own
   title ("Vungu proposed zones") lives in the registry, so QGIS layer names, tile layer ids and table names stop drifting.
3. **One parcel model.** Make `land.parcel` the canonical parcel and load the farm and stand extracts into it as sources
   (with a `source` and a validity range), keeping the imports as read-only staging. Compute area from the geometry; do not
   store it as text.
4. **One ward system and an authority-to-ward relation.** Versioned (`authority_ward`), so an authority's jurisdiction is the
   union of its wards, which is also what the Zimbabwe Electoral Commission update needs.
5. **Zones carry keys, not copies.** Drop the text copies of name, type and authority from the zone polygon table; resolve
   them through the plan. Settle overlaps with a rule the data states, not a count.
6. **One registry.** The QGIS project declares, `layer_publication` approves, and the others become views over them.
7. **Do it behind compatibility views**, so the code, QGIS and the tile config keep working while names move.

## 6. The 24 imported basemap tables, inspected column by column

Inspected: `country`, `provinces`, `districts`, `wards`, `landuse`, `admin_areas`, `places_areas`, `water_areas`, `waterways`,
`protected_areas`, `natural_areas`, `roads`, `railways`, `buildings`, `traffic_areas`, `transport_areas`, `pois_areas`,
`places_of_worship_areas`, `places_points`, `pois_points`, `traffic_points`, `transport_points`, `natural_points`,
`places_of_worship_points`.

**What is sound.** Every table has a primary key and a GiST index; every geometry is valid; every table is one SRID (4326) and one
geometry type. The administrative set is properly keyed (`pcode`, `parent_pcode`).

**Findings**

1. **They are an OpenStreetMap shapefile extract with its schema intact** (`fid`, `osm_id`, `code`, `fclass`, `name`, plus a few
   type-specific columns), not a model designed for planning. The names (`pois_areas`, `traffic_points`) are the source's.
2. **The detail layers are clipped to one area.** Roads, buildings, water and points lie in a box of about 29.0 to 30.2 °E,
   18.8 to 20.0 °S (Gweru, Kwekwe, Shurugwi, Vungu), while the administrative layers are national. A council outside that box has
   boundaries and nothing else. The comments in `planningSpatial.js` describe 711,000 buildings, 210,000 roads and SRID 900914;
   this database holds 139,619 buildings, 2,876 roads and SRID 4326, so the code and the data disagree about their own scale. I
   cannot tell which is intended.
3. **Two registered layers are empty** (`places_areas`, `natural_areas`); two more are nearly so (`transport_areas` 1,
   `places_of_worship_points` 1).
4. **Duplicates.** 605 buildings share their geometry with another; `protected_areas` holds the same OSM feature twice with two
   classes (a national park and a nature reserve).
5. **Unknown is written as a value.** All 80 waterways have `width` 0; 99% of roads have `maxspeed` 0; every place has
   `population` 0; `bridge`, `tunnel` and `oneway` are the strings `'T'`, `'F'` and `'B'`, not booleans.
6. **Mostly unnamed.** Roads: 99% without a name. Buildings: 100% without a name and 99.5% without a type (only 651 are
   anything but `building`), so the footprints carry no use.
7. **Redundant columns.** `code` and `fclass` say the same thing in every table. `level` is constant within each admin table.
   `wards` has 1,961 rows and 46 distinct names, so a ward's identity is its `pcode`, never its name.
8. **Classified by the source's habits, not by concept.** Dams appear under `traffic_areas` and `traffic_points`;
   `admin_areas` (OSM administrative boundaries) sits in the `landuse` group beside the COD `districts`; `protected_areas` and
   `natural_areas` sit under `hydro`. A school may be a point (3) or an area (16), so any question about schools must read both.
9. **A missing index.** Migration 074 was meant to index `roads.fclass`; the table here has only its key and its geometry index.

**What this means for the activities.** The data for a watercourse clearance test exists (30 rivers, 49 streams, 66 water bodies)
but not the width; a road-access test can use the road class; a protected-area test has two features; a building test has
footprints with no use. There is no elevation, flood, heritage or servitude data at all.

## 7. Development activities and space

The activities in `development_activity` (migration 157) ask spatial questions of a site, and `activity_spatial_test`
(migration 162) records them: 42 tests across seven activities (`other` is manual), each against a concept in the registry.

- **What is done:** only "find the parcel" and "find the zone" (nine tests, shared by the use-based activities). They are the
  parcel-zoning engine.
- **What has data but is not built:** adjacency (the parcels that touch a site, for neighbour notification and for
  consolidation), and a few concepts that exist in part (watercourse, waterbody, protected area, road, railway, cemetery, building).
- **What has no data:** the applicant's proposed footprint, the proposed subdivision lots and the proposed zone boundary (an
  application records a point, not a shape); flood, heritage and servitude layers; terrain.
- **Unused:** `spatial_analysis_result` was built to hold analyses and has never been written to. The only site analysis is the
  Planning Studio's (stream setback fixed at 30 m in code, protected areas and water as no-go, no elevation).
- No test carries a distance. A clearance or a minimum is statutory or the council's to state, as the matrix standards are.

`SELECT * FROM activity_spatial_gaps` lists each test with the state of its data and whether it is built.

## 8. What this audit did not check

The QGIS project has nine layers because layers were removed from it recently, so it does not show the whole picture. What the
developers said about normalisation was not seen: the documents in the repository say "canonical", not "normalised".
Production, if it differs from this development database, was not examined.
