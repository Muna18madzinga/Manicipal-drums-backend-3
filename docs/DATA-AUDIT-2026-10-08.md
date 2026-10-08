# Spatial data audit: the `gweru_*` and `vungu_*` tables (2026-10-08)

**Why.** Layers named for an authority (`gweru_*`, `vungu_*`) sit beside neutral ones, several look
like copies of each other, and the QGIS project reads some of them. The application is meant for 90+
authorities, so no dataset may be tied to one authority by its name, and each authority must see
only its own data. Before renaming or merging anything, this establishes what is actually a
duplicate, by comparing the geometry, and what depends on each table.

**Tools (both read-only unless stated):**
- `node scripts/audit-spatial-duplicates.js [--json]` — per table: rows, geometry soundness, what
  depends on it (views, foreign keys, triggers), where it is mentioned (code, config, **the QGIS
  project**); per pair of tables: how well their features overlap.
- `node scripts/retire-duplicate-table.js --table T --canonical C [--apply]` — retires a duplicate
  only if provably safe (same shapes, no QGIS layer reads it, no dependents, no unreviewed code
  reference), after a dump. Dry run by default. It refuses and says why otherwise.

## Findings

| Table | Rows | What it is | Disposition |
|---|---|---|---|
| `gweru_beyond_periurban_zones` | 16 (15 with geometry) | **Duplicate** of `vungu_beyond_peri_urban_zones`: 15 of 15 shapes identical. The 16th row has no geometry and repeats attributes (`FLSCF`, `lu014`) the canonical table already holds. | **Retired 2026-10-08** with the tool; dump `backups/gweru_beyond_periurban_zones-2026-10-08.sql`. The QGIS layer of the same *name* reads the Vungu table and is untouched. |
| `gweru_peri_urban_zone` | 43 (37 with geometry) | **Duplicate** of `proposed_peri_urban_zones`: 36 shapes identical; the 37th is the zone whose name was corrected on the map (`Cemetry` / `Cemetery`). The other 6 rows have **no geometry** (`Densification Zone [MDR]`, `Economic Corridor` x2, High, Low and Mixed Density Residential): junk. | **Blocked: needs you in QGIS.** The project still has a layer that reads it. Remove that layer from the project, then run the tool with `--ignore-null-geometry`. Nothing is lost. |
| `gweru_rural_farms` | 672 | **Not a duplicate.** The working farm register: carries `zone_id` (262 farms assigned to a zone), `current_land_use_group_id` and compliance columns (both empty). Used by the development-control routes, the planner's zoning card, the parcel selector and sync coverage. 24 names repeat. | **Keep; decision needed** (below). |
| `vungu_farm_cadastre` | 687 | Farm cadastre geometry (name, area; no planning attributes). | Keep; see farms. |
| `vungu_parcels` | 733 | The largest farm/parcel layer, used by tiles, parcel zoning and permits. | Keep; see farms. |
| `gweru_rivers` | 260 (10 without geometry) | District reference data. | Keep; tag by authority later. |
| `gweru_chiefdoms` | 5 | District reference data. Every polygon straddles the interim boundary. | Keep. |
| `gweru_business_centres` | 67 | District reference data; **referenced nowhere** in code or the project. | Keep; candidate to add to the project. |
| `gweru_health_centres` | **0** | Real schema (facilities, staffing, beds) with **no data**; a project layer reads it. | Keep; needs data from the council or the Ministry of Health. |
| `gweru_rural_planning_boundary` | 1 | The interim boundary (5,853 km²). | See boundary. |
| `vungu_clip_boundary` | 1 | `source = 'wards ZW1704% + 250m buffer'`, 6,021 km²; referenced nowhere. | See boundary. |

### The three farm datasets

All three come from one cadastre extract (`map_sheet = 'Gweru'`, shared `objectid` / `row_id`
numbering) in different vintages and cleanliness:

| Pair | Identical shape | Similar | Different | No counterpart |
|---|---|---|---|---|
| `gweru_rural_farms` → `vungu_farm_cadastre` | 514 | 56 | 54 | 44 |
| `vungu_farm_cadastre` → `vungu_parcels` | 481 | 77 | 104 | 25 |
| `gweru_rural_farms` → `vungu_parcels` | 530 | 89 | 41 | 8 |

Names agree for only about 300 of them, and `gweru_rural_farms` has 3 invalid and 4 null geometries.
They cannot be merged automatically without losing farms or the 262 zone assignments.

**Recommended consolidation (needs your decision):** one canonical farm table. `vungu_parcels` is the
largest and the one tiles, parcel zoning and permits already read. Build a reviewed match table from
each `gweru_rural_farms` row to a `vungu_parcels` row (shape overlap >= 0.99 and name), carry
`zone_id` across for the matches, and list the leftovers for a person to settle. Only then repoint
the development-control routes and retire the other two.

### The boundary

`gweru_rural_planning_boundary` (5,853 km²) and `vungu_clip_boundary` (6,021 km²) cover the same ground
(overlap 5,843 km², 99.8%). The clip boundary's own source note says how it was made: **the union of
the wards whose code begins `ZW1704`, plus 250 m**. That is the Gweru **district**'s wards. Vungu's
own planning zones cover only 761 km² of it. So neither is Vungu RDC's jurisdiction; both are the
district.

## Decisions recorded (2026-10-08)

1. **The boundary is interim.** It will be replaced by the Zimbabwe Electoral Commission's delimited
   boundaries.
2. **Straddling features:** keep the full dataset; **limit views and analytics to the area inside the
   authority's boundary.** The boundary clips what is shown and counted; it does not cut the data.
3. **Audit and consolidate first;** renaming follows once ownership is settled.

## Design this points to (not built yet)

- **Jurisdiction is derived, not drawn.** Delimited boundaries are ward boundaries. Record which wards
  belong to which authority (an `authority_ward` relation, versioned with the delimitation and its
  gazette reference), and derive the jurisdiction as the union of those wards. A combination
  authority's jurisdiction is the union of its members'. This is how the clip boundary was already
  made, and it means a new delimitation changes one relation, not a drawn polygon.
- **Neutral datasets with an owner column,** not one table per authority per dataset: `farms`,
  `rivers`, `chiefdoms` with an `authority_id` on each row (or derived by the jurisdiction), instead of
  90 copies of every table and QGIS layer.
- **Scoping by the signed-in user's authority** at the database (row-level security) and in the
  catalogue, so an authority sees only its own data and the clipped views and analytics follow.
- **Rename last,** and as a consequence of the above, not as a prefix strip: stripping `gweru_` would
  still leave one table per authority per dataset, and `gweru_rural_farms` alone is referenced from
  17 code and config files, the QGIS project and the frontend.

## Left for you

- Remove the `gweru_peri_urban_zone` layer from the QGIS project, then the table can be retired.
- Decide the farm consolidation above.
- `gweru_health_centres` is empty: where should its data come from?
- Documents still mention retired tables (`SSOT-spatial.md`, the fidelity reports, the seed
  `data/seed/gweru_legacy.sql`).
