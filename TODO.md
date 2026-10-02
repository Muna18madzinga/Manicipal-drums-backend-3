# GIS Management System — what is not built yet

Phase 1 (migration 132) is the core register and the ERP link: roles, Lo-belt
CRS registry, parcel register with survey-CRS source geometry, general-plan
import, ERP outbox + signed inbound events, reconciliation, append-only audit,
the fictional Tsamba sample, and acceptance tests 1–6, 11 and 12
(`src/routes/__tests__/gms.acceptance.test.js`).

Run it:

    node scripts/apply-local-migration.js 132_gis_core_register.sql
    DEMO_SEED_ENABLED=true DEMO_DEFAULT_PASSWORD=... node scripts/seed-demo-users.js
    node scripts/seed-tsamba.js            # --reset to rebuild
    npx jest src/routes/__tests__/gms.acceptance.test.js

## Stubbed, behind an interface

- **ERP adapter** (`src/services/gms/erpAdapter.js`): `stub` and `http` only.
  CSV-over-SFTP fallback not built. The HTTP endpoint shape (`POST
  {ERP_BASE_URL}/gms-events`) is a placeholder until the ERP's API is known.
- **Inbound handlers** (`src/services/gms/inbound.js`): `AccountLinked` and
  `BillingStatusUpdated` only. `RequestFeePaid`, `WorkOrderRaised/Closed` and
  the `AssetCommissioned` reply are logged as `ignored` in
  `integration.inbound_event`, so they can be replayed once handlers exist.
- **Reconciliation**: `area_mismatch` (needs the ERP's area in the contract)
  and `asset_no_erp_number` (needs the asset register) are defined, not run.
- **Import**: GeoJSON only; no gap (sliver) check. Shapefile, GeoPackage,
  KML, DXF and CSV readers still to come.
- **Parcel attribute edits**: only `sg_ref` / `ward_code`. Department-owned
  attributes arrive with their layers.

## Later phases (build brief section)

1. Map workspace (5.2), editing + QA queue + feature history (5.4),
   triple coordinate readout and DXF in survey CRS (acceptance 3 in-editor, 13).
2. Layer catalogue + ISO 19115 metadata (5.3); custodian register.
3. Service desk with ERP fee gating (5.10), map production + issued-map
   register (5.12) — acceptance 7.
4. Asset register + `AssetCommissioned` (5.8) — acceptance 9. Seed boreholes,
   roads, schools, clinics, market, cemetery.
5. Field PWA with offline queue and conflict screen (5.6) — acceptance 8.
6. Analysis incl. change detection → Development Control leads (5.11) —
   acceptance 10; imagery catalogue and COG conversion (5.13).
7. Publishing, field masking and data-sharing register (5.14); reports (5.15);
   the rest of admin (5.16): CRS registry screen, turnaround standards, fee
   codes, backups status, restore-test log.
8. Personal-data view logging (rule 6): nothing in phase 1 stores personal
   data, so there is nothing to log yet. Add with owner/lease data.
9. GeoServer WMS/WFS: the council already runs QGIS Server; decide whether
   GeoServer is still wanted before adding a second map server.
