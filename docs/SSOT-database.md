# SSOT — Database: canonical source of truth per concept

Status: generated audit · Applies to live DB `vungu_master_db_v2` · Backend `main`

## How to read this

- **Canonical** = the table the backend should read/write for that concept.
- **Created by** — `allowlisted` = created by a migration in `scripts/migrate-render.js`
  `MIGRATIONS` (applied on a fresh Render deploy). `dump/seed-only` = NOT created by
  any migration (bootstrapped from gpkg/psql dumps or seed SQL); a fresh deploy does
  **not** create it automatically.
- **Duplicates/Legacy** = tables that also cover the concept but should NOT be used.

Legend: ✅ allowlisted migration · ⚠️ dump/seed-only (missing on fresh deploy) ·
🟡 runtime-provisioned · ⚠️⚠️ phantom/legacy (dead reference risk)

---

## 1. Planning zones (peri-urban)

| | |
|---|---|
| **Canonical** | `public.proposed_peri_urban_zones` ⚠️ (id integer serial; no `CREATE TABLE` anywhere — bootstrapped from dump only) |
| **Served as** | `zones_master` view (✅ 112) — the map/tile + permits both read this |
| **Readers** | `development-control-refactored.js:48,85,192,…`, `land-use-management-enhanced.js:248,285,333`, `map-search.js:135,233,296`, `inspectorSpatial.js`, `tiles.js` |
| **Writers** | `land-use-management-enhanced.js:333` |
| **Duplicates/Legacy** | `gweru_peri_urban_zone` (Gweru legacy, seed only); removed `vungu_proposed_peri_urban_zones_` map-copy (dropped 2026-07-23, dead refs in `081_fix_schema_gaps.sql` = not allowlisted) |
| **Notes** | FK target for `development_matrix`, `gweru_rural_farms`, `zone_land_use_controls`, `stands.zone_id` (✅ 126) |

## 2. Stands

| | |
|---|---|
| **Canonical** | `public.stands` ✅ (062) — id UUID; `zone_id` integer FK→zones (✅ 126); topology trigger no-overlap (✅ 107) |
| **Served as** | `v_stands` view (✅ 078, re-created by 126); `stands_tile_view` view (✅ 080, registry `spatialLayers.js:70`) |
| **Readers/Writers** | `src/routes/stands.js` (INSERT 262/405/483, UPDATE 216/324/…), `map-search.js`, `tiles.js`; allocation via `stand_allocation` ✅ 105 |
| **Duplicates/Legacy** | none |

## 3. Users / roles

| | |
|---|---|
| **Canonical** | `public.users` ✅ (001 + 060/061/093); `public.user_profiles` 1:1 (✅ 078) |
| **Readers/Writers** | `src/middleware/jwtAuth.js`, `src/routes/auth.js`, invite routes, `development-applications.js`, `residency.js` |
| **Duplicates/Legacy** | `survey.users` (✅ 102) is a **separate** merge-app identity, auto-provisioned from vungu JWT (`src/survey/plugin.js:21-50`); not interchangeable with `public.users` |
| **Notes** | survey identity sync is one-way (vungu → survey) |

## 4. Development applications (citizen portal)

| | |
|---|---|
| **Canonical** | `public.development_applications` ✅ (042 + 078 status CHECK) |
| **Readers/Writers** | `src/routes/development-applications.js`; `public.application_documents` (104 family) |
| **Duplicates/Legacy** | none |

## 5. Permit applications (GIS / development control)

| | |
|---|---|
| **Canonical** | `spatial_planning.permit_application` ✅ (070 + 077/082/118/119) — the working development-control record |
| **Readers/Writers** | `development-management.js`, `appeals.js`, `inspectorSpatial.js`; surfaced via `v_application_summary` (✅ 070/075) |
| **Duplicates/Legacy** | ⚠️⚠️ `spatial_planning.permit_applications` (plural) — **no CREATE anywhere**, phantom legacy (refs in 076/075/notifications.js); risk of FK failure on fresh install |

## 6. Payments

| | |
|---|---|
| **Canonical** | ✅ 064: `payments`, `payment_webhooks`, `payment_audit`, `exchange_rates`, `citizen_documents` |
| **Readers/Writers** | `src/services/paymentDriver.js`, `src/routes/payments.js`, `src/routes/documents.js`, `src/services/exchangeRate.js` |
| **Duplicates/Legacy** | none (money in integer cents; multi-currency via `exchange_rates`) |

## 7. Inspections

| | |
|---|---|
| **Canonical** | ✅ 063 `inspection_bookings/photos/status_events`; `spatial_planning.stage_inspection` + scoring (✅ 070–073), photos/flags (✅ 071/116/117) |
| **Readers/Writers** | `development-management.js`, `inspector-gis.js`, `inspections.js`, `inspectorSpatial.js` |
| **Duplicates/Legacy** | none |

## 8. Documents / cases / generated documents

| | |
|---|---|
| **Canonical** | ✅ 085 `case_message`, `permit_document`, `document_request`, `document_review`, `statutory_clock_event`, `generated_document`, `spatial_analysis_result`, `eo_handoff_package`, `v_specialist_findings`; ✅ 087/088/090 |
| **Readers/Writers** | `development-management.js`, `src/routes/documents.js` |
| **Duplicates/Legacy** | `application_documents` (citizen-portal lineage); `citizen_documents` (✅ 064) — different lifecycle |

## 9. Spatial layers / tiles / GIS editing

| | |
|---|---|
| **Canonical catalogue** | `public.spatial_layers` ✅ 111; runtime registry = `src/config/spatialLayers.js` (all tile layers); alignment doc `docs/SSOT-spatial.md` |
| **Styles** | ✅ 114 `gis_style` (+audit) — supersedes frontend `masterplanSymbology.ts` |
| **Editable features** | ✅ 091/092 `spatial_planning.gis_feature`(+history), with geometry validation gate ✅ 106 (`geom_from_geojson_checked`); writers `src/routes/gis.js` |
| **Duplicates/Legacy** | pre-111 hand-made `spatial_layers` (schema drift risk) |

## 10. Land use / development matrix ⚠️ HIGHEST RISK

| | |
|---|---|
| **Canonical** | `public.development_matrix` ✅ created by 017 (but with `zone_code/use_code` columns) |
| **Runtime reality** | code uses `zone_id/group_id/permission_code` — **schema mismatch**, needs dump/attic patches to align |
| **Supporting** | ⚠️ `land_use_groups` (created only by non-allowlisted 081 → dump-only on fresh deploy), `zone_land_use_controls` (✅ 050 + ⚠️ 081 — divergent FK targets!), `permission_types` — no CREATE anywhere, `gweru_rural_farms` — no CREATE anywhere |
| **Readers/Writers** | `development-control-refactored.js`, `land-use-management-enhanced.js`; live gateway = ✅ 075 compliance function |
| **Notes** | Highest-risk concept: fresh Render deploy has matrix schema ≠ code expectations and no reference rows |

## 11. Survey tasks (two families — keep separate)

| | |
|---|---|
| **Permit-tied** | `spatial_planning.survey_task` ✅ 080 (+ finding/coordinate/beacon/layout/comment); `survey_parcel` ✅ 099 |
| **Standalone merge app** | `survey.*` schema ✅ 102 (16 tables: `survey_projects`, `surveyors`, `land_parcels`, `coordinate_points`, `features`, `layers`, …) + per-surveyor schemas `surveyor_<user>` 🟡 created at runtime (`survey.create_surveyor_schema()`) |
| **Duplicates/Legacy** | the two families look overlapping but are intentionally separate; do not cross-join |

## 12. Committees

| | |
|---|---|
| **Canonical** | ✅ 083 `committee_meeting`, `agenda_item`; ✅ 104 `committee_member`, `meeting_attendance` |
| **Readers/Writers** | `development-management.js` (2607–2753); `isPermitResolved` |

## 13. Council ops registers

| | |
|---|---|
| **Canonical** | `council_ops.*` ✅ 123 (road/wash/livestock assets, data_quality CHECK), ✅ 125 tickets; `planning_clerk.*` ✅ 124 |
| **Readers/Writers** | `src/routes/council-ops.js` |
| **Notes** | import-ready, empty until seeded |

## 14. OSM basemap + admin boundaries

| | |
|---|---|
| **Canonical** | 24 public OSM tables (`wards`, `roads`, `buildings`, `waterways`, `landuse`, …) — ⚠️ **gpkg-only, no migration creates them** |
| **Sources** | `data/zimbabwe.gpkg` + `data/Vungu_RDC_Master_Plan.gpkg` via `scripts/setup-spatial.mjs`; legacy `data/seed/gweru_legacy.sql` (8 `gweru_*` tables) |
| **Served as** | `spatialLayers.js` registry groups: admin / landuse / hydro / transport / structures / poi / master_plan |
| **Duplicates/Legacy** | `zimbabwe`/`countries` dropped → canonical `country`; test files still reference old `gweru_rural_planning_boundary`/`zimbabwe` |

---

## Cross-cutting verdicts

**Safe on fresh deploy (migration-created):** users, development_applications, permit_application + v_application_summary, payments, inspections, case/documents, spatial_layers/gis_feature, survey_task/survey_parcel (✅), survey.* (✅102), committees, council_ops, stands (✅062+080+105+107+126), zones_master (✅112).

**Dump/seed-only — missing on fresh deploy unless bootstrapped:**
`proposed_peri_urban_zones` (**the canonical zones table**), `wards` (all 24 OSM tables), `gweru_rural_farms`, `permission_types`, `land_use_groups`, `zone_land_use_controls` + `_history`, `development_matrix` row content, all `vungu_*`/`gweru_*` tables.

**Phantom/legacy risk:** `spatial_planning.permit_applications` (plural — no CREATE), `vungu_proposed_peri_urban_zones` (dropped, dead refs in 081), `zwe_boundaries.*` (old backup schema).

**Divergent FK hazard:** `zone_land_use_controls` bound to both `proposed_peri_urban_zones(id)` (050) and `vungu_proposed_peri_urban_zones(id)` (081) — only one is real on a live DB.

**Grep-proven absences:** `CREATE TABLE public.proposed_peri_urban_zones` = 0 hits; `CREATE TABLE permission_types` = 0 hits; `CREATE TABLE gweru_rural_farms` = 0 hits; `ALTER TABLE development_matrix` = 0 hits.

---

## Backend ↔ frontend implications (short)

1. **Fresh environments differ**: Dump-only canonical tables (`proposed_peri_urban_zones`, `wards`, OSM layers) exist on the dev DB but **not** after migrations alone — frontend renders empty/undefined until a dump or seed is restored. See `docs/DATA-DUMP-REPORT.md`.
2. **Two identity systems** (`public.users` vs `survey.users`) — frontend must not assume a single user table.
3. **Zones now single-sourced via `zones_master`**; the remaining drift is the `development_matrix` schema vs code columns (concept #10).
4. Rule of thumb for new work: **canonical column = integer `zone_id` → `proposed_peri_urban_zones.id`; never re-introduce UUID zone references.**