# Database Single Source of Truth (SSOT)

Canonical table map for VunguGIS / SpartialIQ. Prefer these tables for new code.
Full column-level reference: **`docs/DATABASE.md`** (generated — `npm run db:dictionary`).

After migrations **130–132** every fact is stored once, every closed vocabulary is a
table in the `ref` schema, and every table carries a description in the catalogue.

| Concept | Canonical (SSOT) | Gone / compatibility only | Notes |
|---------|------------------|---------------------------|-------|
| **Vocabularies** (status, type, category…) | `ref.<domain>` — 117 lookup tables | CHECK `IN (…)` lists, the `gis_style_status` / `application_status` ENUMs, `public.ref_*` | FK `ON UPDATE CASCADE`. Add a value with `INSERT INTO ref.<domain>`, not a migration (130). |
| **Zones (peri-urban)** | `proposed_peri_urban_zones` (INTEGER `id`) + view `zones_master` | `vungu_proposed_peri_urban_zones` (dropped), `gweru_peri_urban_zone` (now a view) | `area_ha` is GENERATED from `geom`. |
| **Beyond-peri-urban zones** | `beyond_peri_urban_zones` (`ward_pcode` → `wards.pcode`) | `gweru_beyond_periurban_zones` (dropped); `vungu_beyond_peri_urban_zones` is now a view | Admin names derived from the ward hierarchy. |
| **Stands** | `stands` + view `v_stands` | `status_code`, `use_scale_code`, `zone_type_cache`, `zone_id_int`, `ward_fid` (dropped) | `zone_id` is INTEGER FK → `proposed_peri_urban_zones.id`; `centroid` is GENERATED. |
| **Admin boundaries** | `country` → `provinces` → `districts` → `wards` | — | `pcode` UNIQUE; `parent_pcode` is a real FK chain. |
| **Users (app)** | `public.users` | `user_profiles`, `user_sessions` (dropped); `users.name`, `.active`, `.last_login` (dropped) | `full_name` is the only name; signed-in = `status = 'active'`. `survey.users` stays separate by design. |
| **Sessions** | `user_session` | `user_sessions` (dropped) | |
| **Applications** | `spatial_planning.permit_application` / `development_applications` | — | `status` → `ref.permit_status` / `ref.application_status`. |
| **Payments** | `payments` | — | Webhook signature-verified. |
| **Inspections** | DM handbook inspections + inspector queue (116–118) | — | |
| **Documents** | `citizen_documents`, `spatial_planning.permit_document`, `generated_document` | — | |
| **Layers (editable GIS)** | `spatial_planning.gis_feature` (+history) / `layers` | `survey.layers` | Writes require `admin`/`gis_officer`. |
| **Land-use / matrix** | `zone_land_use_controls` (`zone_id` INTEGER → zones, `land_use_group_id` → `land_use_groups.id`) | — | `control_type` → `ref.land_use_control`. |
| **Surveys** | `survey.*` + per-surveyor `surveyor_*` schemas | `survey.workflow_states`, `survey.migrations_history` (dropped) | Validated `search_path`. |
| **Committees** | committee meetings (083/104) | — | |
| **Council ops** | `council_ops.*` (123) | — | `data_quality` → `ref.data_quality`. |
| **Clerk registers** | `planning_clerk.*` (124) | browser localStorage | |
| **Service desk** | `council_ops.service_desk_ticket` (125) | — | |
| **OSM / basemap** | `buildings`, `roads`, `waterways`, … (clipped via `vungu_clip_boundary`) | per-row `code` column (dropped) | `fclass` → `ref.osm_feature_class`. Tiles query these directly, never `.gpkg`. |
| **Audit** | `permit_event`, `gis_style_audit`, `gis_feature_history` | `audit_logs`, `statutory_clock_event` (dropped, never written) | |

## Highest residual risks

1. **OSM/zone geometry dumps** — repo migrations alone cannot rebuild the map DB (~1.8 GB OSM).
   The allowlist also stops at `075_notifications_and_kyc.sql` on an empty database
   (it references `spatial_planning.permit_applications`, plural).
2. **Two user systems** — `public.users` vs `survey.users` remain separate by design.
3. **`development-control-refactored.js`** is written against a different land-use schema
   (`development_matrix.zone_id/group_id`, `parcel_id` …) and its endpoints return 500.
4. **Stand ward labels** — seeded stands say "Ward 5" but their geometry lies in ward 18
   (`v_stands.ward_name` shows the spatial ward).

See also: `DATABASE.md`, `DATA-DUMP-REPORT.md`, `SUPERVISOR-REVIEW-RECTIFICATION.md`.
