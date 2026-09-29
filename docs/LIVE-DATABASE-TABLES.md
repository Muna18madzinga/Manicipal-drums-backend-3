# Live database tables (PostGIS) — Vungu clip

Generated: 2026-09-24T17:46:58.292Z

Runtime map/tile queries use these **raw Postgres tables** only. GeoPackage is import-only — never queried at request time.

## Clip boundary

- `public.vungu_clip_boundary` — wards `pcode LIKE 'ZW1704%'` + 250 m buffer

## OSM feature tables (exact counts)

| Table | Rows |
|-------|-----:|
| `places` | 0 |
| `places_points` | 11 |
| `natural_points` | 2 |
| `traffic_points` | 102 |
| `transport_points` | 3 |
| `places_of_worship_points` | 1 |
| `pois_points` | 25 |
| `places_of_worship_areas` | 4 |
| `pois_areas` | 42 |
| `traffic_areas` | 3 |
| `transport_areas` | 1 |
| `protected_areas` | 2 |
| `natural_areas` | 0 |
| `admin_areas` | 11 |
| `places_areas` | 0 |
| `water_areas` | 66 |
| `waterways` | 80 |
| `railways` | 225 |
| `landuse` | 121 |
| `roads` | 2,876 |
| `buildings` | 139,619 |

## Clip results (this run)

| Table | Kept |
|-------|-----:|
| `places` | 0 |

## All public base tables

| Table | Est. rows | Size |
|-------|----------:|-----:|
| `buildings` | 139619 | 72 MB |
| `wards` | 0 | 30 MB |
| `spatial_ref_sys` | 0 | 7144 kB |
| `districts` | 0 | 6488 kB |
| `provinces` | 0 | 2712 kB |
| `roads` | 2876 | 2048 kB |
| `gweru_rural_farms` | 0 | 760 kB |
| `admin_areas` | 22 | 688 kB |
| `country` | 0 | 688 kB |
| `vungu_clip_boundary` | 1 | 584 kB |
| `vungu_parcels` | 0 | 552 kB |
| `vungu_farm_cadastre` | 0 | 512 kB |
| `gweru_rivers` | 0 | 376 kB |
| `notifications_outbox` | 0 | 344 kB |
| `stands` | 0 | 248 kB |
| `gis_style` | 0 | 216 kB |
| `vungu_proposed_peri_urban_zones` | 0 | 216 kB |
| `gweru_chiefdoms` | 0 | 192 kB |
| `user_session` | 255 | 192 kB |
| `waterways` | 80 | 184 kB |
| `gweru_beyond_periurban_zones` | 0 | 176 kB |
| `gis_style_audit` | 0 | 160 kB |
| `railways` | 225 | 160 kB |
| `vungu_beyond_peri_urban_zones` | 0 | 160 kB |
| `invites` | 0 | 112 kB |
| `payments` | 0 | 112 kB |
| `users` | 18 | 104 kB |
| `admin_users` | 0 | 96 kB |
| `gweru_rural_planning_boundary` | 0 | 96 kB |
| `landuse` | 121 | 96 kB |
| `stand_allocation` | 0 | 96 kB |
| `water_areas` | 66 | 96 kB |
| `gweru_peri_urban_zone` | 0 | 88 kB |
| `citizen_documents` | 0 | 80 kB |
| `lands_registry_deeds` | 0 | 80 kB |
| `proposed_peri_urban_zones` | 36 | 80 kB |
| `validation_rules` | 0 | 80 kB |
| `development_applications` | 0 | 72 kB |
| `planning_assistant_templates` | 0 | 72 kB |
| `gis_layer` | 0 | 64 kB |
| `inspection_bookings` | 0 | 64 kB |
| `layers` | 0 | 64 kB |
| `style_templates` | 0 | 64 kB |
| `development_matrix` | 0 | 48 kB |
| `ingestion_jobs` | 0 | 48 kB |
| `land_use_groups` | 0 | 48 kB |
| `local_authorities` | 0 | 48 kB |
| `pois_areas` | 84 | 48 kB |
| `spatial_layers` | 0 | 48 kB |
| `traffic_points` | 102 | 48 kB |
| `zone_land_use_controls` | 0 | 48 kB |
| `analytics` | 0 | 40 kB |
| `audit_logs` | 0 | 40 kB |
| `gweru_business_centres` | 0 | 40 kB |
| `lands_registry_checks` | 0 | 40 kB |
| `natural_points` | 4 | 40 kB |
| `places_of_worship_areas` | 8 | 40 kB |
| `places_of_worship_points` | 2 | 40 kB |
| `places_points` | 22 | 40 kB |
| `plan_reviews` | 0 | 40 kB |
| `pois_points` | 50 | 40 kB |
| `protected_areas` | 4 | 40 kB |
| `traffic_areas` | 6 | 40 kB |
| `transport_areas` | 2 | 40 kB |
| `transport_points` | 6 | 40 kB |
| `vungu_cemeteries` | 0 | 40 kB |
| `vungu_waste_management` | 0 | 40 kB |
| `application_comments` | 0 | 32 kB |
| `application_documents` | 0 | 32 kB |
| `application_drafts` | 0 | 32 kB |
| `application_status_history` | 0 | 32 kB |
| `application_timeline` | 0 | 32 kB |
| `exchange_rates` | 0 | 32 kB |
| `inspection_photos` | 0 | 32 kB |
| `layer_data` | 0 | 32 kB |
| `plan_review_findings` | 0 | 32 kB |
| `ref_stand_statuses` | 0 | 32 kB |
| `ref_zone_types` | 0 | 32 kB |
| `schema_migrations` | 7 | 32 kB |
| `user_profiles` | 8 | 32 kB |
| `inspection_status_events` | 0 | 24 kB |
| `natural_areas` | 0 | 24 kB |
| `places_areas` | 0 | 24 kB |
| `ref_application_statuses` | 0 | 24 kB |
| `ref_scale_categories` | 0 | 24 kB |
| `ref_use_scales` | 0 | 24 kB |
| `user_sessions` | 0 | 24 kB |
| `gweru_health_centres` | 0 | 16 kB |
| `places` | 0 | 16 kB |
| `site_content` | 0 | 16 kB |

## How tiles read data

1. `spatialLayers.js` maps layer id → PostGIS `table`
2. `GET /tiles/:layer/:z/:x/:y.pbf` → `ST_AsMVT` on that table
3. No `.gpkg` / ogr2ogr at request time
