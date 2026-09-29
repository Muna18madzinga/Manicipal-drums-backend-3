# Supervisor review — rectification log

Date: 2026-09-23  
Repo: Manicipal-drums-backend-3 / finale backend

## HIGH — unauthenticated mutating endpoints

| Finding | Fix |
|---------|-----|
| WFS publisher POST/DELETE | `preHandler: requireRole(admin, gis_officer)` on all `/api/wfs/*` mutating routes |
| Dynamic-layers QML upload | Same role guard on `POST .../qml-style` |
| Spatial POST layers / features / qml-style / query | GIS write roles (query = staff roles) |
| GET status-history unguarded | `STAFF_ROLES` preHandler |

## MEDIUM / LOW

| Finding | Fix |
|---------|-----|
| OGC cache clear | `admin`/`gis_officer` |
| Planner notification stubs | `requireAuth` |
| land-use `zone_id` OpenAPI UUID | Changed to **integer** to match `proposed_peri_urban_zones.id` |

## Migration governance

| Finding | Fix |
|---------|-----|
| Allowlist missing 112/113/080_stands/079_filter | Added to `migrate-render.js` |
| 3NF documented but never applied | Shipped as **126_3nf_normalization.sql** + applied locally |
| zone_id UUID vs INTEGER | **127_zone_id_int_contract.sql** + `v_stands` refresh |
| Stale SRID JSDoc (900914) | Corrected to 4326 in `spatialLayers.js` |
| spatial POST /query SRID | Documented 4326 storage + bbox validation |

## Docs

- `docs/SSOT-database.md`
- `docs/DATA-DUMP-REPORT.md`
- Summary Word: `docs/Supervisor-Review-Rectification-Summary.docx`

## Verified non-findings (unchanged)

Public auth CAPTCHA, payment webhooks, public tiles/OGC GET, intentional suggest endpoints remain public by design.
