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
| `gweru_peri_urban_zone` | 43 (37 with geometry) | Mostly a copy of `proposed_peri_urban_zones` (36 shapes identical, one of them the zone renamed `Cemetry` / `Cemetery`; 6 junk rows with no geometry). **But it is not safe to retire** (update 2026-10-08, evening): (1) row **id 43**, an `Institutional` polygon of 25.8 km², lies outside every canonical zone (0.2% covered). It carries a copy of row 19's attributes (`area_ha` 489.57 ha) but a different 9-vertex shape that measures about 2,580 ha: probably a mis-drawn copy, but nothing proves it. (2) **Its ids are the key to `gweru_rural_farms.zone_id`** (see below). | **Keep for now.** The QGIS layer is gone (you removed it). Settle id 43, remap the farm zone ids, then retire. |
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

## Farm match table (built 2026-10-08)

`node scripts/build-farm-match.js --csv` fills `public.farm_match` and writes `docs/farm-match-review.csv`
(worst cases first). Nothing is merged. A refresh keeps any reviewer decision.

| Farms in `gweru_rural_farms` → `vungu_parcels` | Count |
|---|---|
| exact (same shape, same name, claimed once) | 527 |
| probable (same shape, name differs or missing; or similar shape and same name) | 49 |
| ambiguous (several parcels, or the parcel is also another farm's best match) | 3 |
| weak (best parcel overlaps only 0.5 to 0.99) | 59 |
| unmatched (no parcel overlaps it by half) | 30 |
| no geometry | 4 |

Of the 262 farms with a zone assignment: 213 exact, 10 probable, 38 weak, 1 unmatched. Of the 39
weak or unmatched ones, 38 are at least 95% covered by parcels: the land is in `vungu_parcels`,
cut into different parcels, so the match is one-to-many, not a loss.

### The farm zone assignments point at the wrong zones

`gweru_rural_farms.zone_id` was assigned against the ids of the **old `gweru_peri_urban_zone`
table** (ids up to 43). The canonical table has ids 1 to 36. Read as they stand, **only 2 of 262**
assignments point at the zone the farm lies in, and 36 point at an id that does not exist.
Remapped from the old ids (old id, old zone, the canonical zone with the same shape):

| Result | Farms |
|---|---|
| agrees with the zone the farm lies in (largest overlap) | 177 |
| differs from it (the assignment and the geometry disagree: for a person to settle) | 72 |
| cannot be remapped (the old id has no canonical shape: id 43 and the 6 junk rows) | 13 |

**Live defect:** `development-control-refactored.js` reads `f.zone_id = z.id` (the by-parcel permitted
uses, the farm list, the farm-by-zone queries), so those paths show the wrong zone for farms. The
planner's zoning card uses the point-in-zone lookup and is not affected when it has a centroid. And a
farm update (line 603) writes ids, so the column now mixes old and new ids.

**Recommended:** drop the stored assignment as the source of truth. Parcel zoning (migration 144)
already derives a parcel's zone from where it lies; the stored `zone_id` should be remapped once, the
72 disagreements reviewed, and the column then retired in favour of the derived zone.

### The farm zone remap (prepared, not applied)

`migrations/153_farm_zone_remap.sql` (with a `.down.sql`) is **prepared and deliberately not registered** in
`scripts/migrate.js`. Rehearse it on the real data, changing nothing, with
`node scripts/rehearse-farm-zone-remap.js [--csv]`: it applies the migration, checks it, applies it again,
runs the down script, and rolls everything back. Result on the dev data:

- 262 farms carry a zone; **177** are remapped and agree with where they lie, **72** are remapped but differ
  from where they lie (kept as the assignment meant; flagged), **13** cannot be remapped and get NULL.
- No farm is left pointing at a zone id that does not exist; every remapped zone has the same shape as the
  old zone; every original value is kept in `zone_id_legacy`; a second run changes nothing; the down
  script restores every original value exactly.
- The review sheet is `docs/farm-zone-remap-review.csv` (85 farms for a person to look at).

**All 13 unmappable farms were assigned to old id 43**, the `Institutional` polygon that matches nothing in the
canonical table, and all 13 touch that polygon (2 lie mostly inside it). So the farms were assigned against
it by intersection: id 43 was in use as a zone when the assignments were made. That weakens the "mis-drawn
copy" reading above. It may be a real zone that was later dropped from the canonical table. Settling id 43
(keep as a zone, or discard) settles those 13 farms.

**Decision (2026-10-08): discard id 43.** Row 43 was deleted from `gweru_peri_urban_zone` (a restore script is in
`backups/gweru_peri_urban_zone-id43-2026-10-08.sql`, outside version control). The 13 farms assigned to it stay
unmapped (NULL) in the prepared remap, and their zone follows from where they lie (parcel zoning). The rehearsal
still passes with 177 / 72 / 13.

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

- Settle `gweru_peri_urban_zone` id 43 (the 25.8 km² `Institutional` polygon): keep as a new zone, or discard.
- Review the 72 farms whose assignment and location disagree, then remap or retire `farms.zone_id`.
- Decide the farm consolidation above.
- `gweru_health_centres` is empty: where should its data come from?
- Documents still mention retired tables (`SSOT-spatial.md`, the fidelity reports, the seed
  `data/seed/gweru_legacy.sql`).
