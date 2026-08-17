# GIS Symbology Single Source of Truth

**Rule:** every governed layer has exactly **one** approved production style, held as a
versioned document in the registry (`gis_style`, migration 114). QGIS Server, the web
map, QGIS Desktop and any future client all **compile** their renderer configuration
from that same document. No client carries its own copy of a colour.

Companion to [SSOT-spatial.md](./SSOT-spatial.md), which governs spatial **data**.
Data and style are separate enterprise assets with separate clocks: publishing a style
never touches geometry, and syncing data never changes symbology.

---

## Why this exists

An audit in August 2026 found **six** competing symbology authorities that could
disagree, and two of them provably did:

| # | Authority | Scope | Outcome |
|---|---|---|---|
| 1 | `frontend/src/map/masterplanSymbology.ts` | statutory colour schedule | seeded into the registry, then retired as an authority |
| 2 | `qgis-projects/vungu-project.qgs` renderers | **10 layers only** | now an *authoring source*, imported per layer |
| 3 | `spatial_layers.style_config` JSONB (migration 111) | QGIS-plugin pushes | legacy; superseded for governance |
| 4 | `frontend/src/map/vunguBasemapStyle.ts` `PALETTE` | **21 basemap layers**, hard-coded hex | **deleted** |
| 5 | `symbology-style.db` | stray SQLite in the repo root | unused; not an authority |
| 6 | five `src/services/admin/*QGIS*` services (5,271 lines) | ad-hoc unschematised JSON | left for the legacy plugin routes; not the registry path |

Two concrete defects this closed:

- QGIS painted **High Density Residential and Economic Corridor both `#ffff00`**,
  breaking the statutory "one symbol = one thing" rule. (Repaired at source by commit
  `c5c9575` before the import, so the registry inherited the corrected colours
  `#d8ab47` and `#4f83c2`.)
- The web carried the full six-class statutory road hierarchy over 25 OSM `fclass`
  values while QGIS had `roads` as a **single flat `#b7484b` line**.

---

## Architecture

```
   QGIS Desktop (.qgs / .qml)      ─┐
   statutory map-notation schedule  ┼──►  gis_style.definition       ──► compileMaplibre() ──► web map, mobile
   SLD / manual                    ─┘    (vungu.gis.style/1:
                                          versioned, approved,
                                          immutable)                 ──► compileQml()      ──► QGIS Server WMS,
                                                                                                QGIS Desktop
```

**One style, many renderers.** Both compilers live in one module,
`src/services/gis/compile.js`, server-side. A divergence between QGIS and the web would
require the same function to return two different answers — which is why the previous
split (a QML emitter in a frontend build script, MapLibre paint hand-written in
`vunguBasemapStyle.ts`) could drift and this cannot.

### Modules

| File | Role |
|---|---|
| `migrations/114_gis_style_registry.sql` | `gis_layer`, `gis_style`, `gis_style_audit`, `gis_published_style` view; all hard guarantees as constraints/triggers |
| `src/services/gis/styleDoc.js` | the `vungu.gis.style/1` schema, colour normalisation, checksum, validation, fidelity classification |
| `src/services/gis/qgisImport.js` | `.qgs` / `.qml` → normalised document; returns **all** candidate sources, never picks silently |
| `src/services/gis/compile.js` | document → MapLibre layers **and** → QML; plus `compareFidelity()` |
| `src/services/gis/styleRegistry.js` | lifecycle, publish, rollback, diff, audit, fidelity report |
| `src/routes/gisStyles.js` | the API (below) |
| `frontend/src/services/gisStyles.ts` | client with **versioned** cache keys (`roads:v3`) |
| `frontend/src/map/vunguBasemapStyle.ts` | resolves published styles; **contains no cartography** |
| `frontend/src/views/admin/GisSymbologyRegistryView.vue` | GIS-officer control surface |
| `frontend/scripts/seed-gis-style-registry.mjs` | one-time import (Phase 4) + provenance audit |

---

## Provenance is per layer, and deliberate

"QGIS is authoritative" holds for the layers QGIS actually styles. It is **not** a
blanket rule, for two structural reasons found in the audit:

1. the QGIS project styles **10** layers; the web renders **31**. For roads, landuse,
   buildings, water, admin boundaries and POIs there is no QGIS style to be
   authoritative over;
2. where both exist they can differ in **richness**, not just colour (the `roads` case
   above).

So `gis_style.source` / `source_path` record the authoring source of every version, and
conflicts are **reported, never auto-resolved**:

- `GET /api/gis/styles/:layerId/qgis-candidates` lists every candidate
  (`qml_sidecar` → `qgs_project` → `generated`) with a `conflict` message when more than
  one authoring source exists. A human chooses; the choice lands in the audit log.
- `npm run gis:symbology:report` (frontend) prints the full provenance decision table,
  every rejected QGIS style **with its reason**, validation warnings, and the
  QGIS-vs-web fidelity comparison — writing nothing.

Layers where a QGIS style exists but is deliberately **not** used are declared in
`QGIS_REJECTED` in the seed script, each with its reason.

### QGIS layers with no vector-tile counterpart

`gweru_chiefdoms`, `gweru_health_centres`, `gweru_peri_urban_zone`, `gweru_rivers`,
`gweru_rural_farms`, `gweru_rural_planning_boundary`, `zimbabwe` are styled in QGIS but
have no MVT layer; they reach the web through the QGIS Server WMS overlay only.

---

## Lifecycle and immutability

```
draft ──► review ──► approved ──► published ──► deprecated ──► archived
                                      ▲              │
                                      └──────────────┘   rollback = re-publish
```

Only `published` may be served to production maps. The guarantees are enforced **in the
database**, not by application convention — `test-gis-style-registry.js` proves all 16:

- **at most one published version per layer** — partial unique index
  `gis_style_one_published_per_layer`;
- **published styles are immutable** — trigger `gis_style_published_immutable` rejects
  any change to `definition`, `checksum`, `renderer_type`, `classification_*`,
  `opacity`, `fidelity`, `style_version`, `layer_id`, and refuses a return to
  draft/review/approved;
- **published styles cannot be deleted** — trigger `gis_style_no_delete_published`;
- **publication requires recorded approval** — check `gis_style_approved_fields`;
- **`unsupported` fidelity can never be published** — check
  `gis_style_no_unsupported_publish`;
- **the audit log is append-only** — trigger `gis_style_audit_immutable` blocks UPDATE
  and DELETE;
- **the registry holds no geometry** — PostGIS remains the sole data authority.

Changing cartography **always** creates a new version. A rollback re-publishes an
earlier version (deprecating the incumbent in the same transaction), so history stays
linear and spatial data is untouched.

New versions are **content-addressed**: re-importing an unchanged QGIS project returns
`unchanged: "identical to vN"` and writes no row. Re-running the seed after correcting
four layers created exactly four v2 rows and left 27 alone.

---

## Fidelity: never invent an approximation

Every document is classified by how faithfully MapLibre can reproduce it. This is the
mechanism that stops the system showing planners unapproved cartography:

| Level | Meaning | Rendering |
|---|---|---|
| `direct` | MapLibre paint expresses it exactly | vector tiles |
| `converted` | expressible after a documented transformation (graduated → `step`, mm → px at 96 DPI, dash patterns, zoom ramps) | vector tiles |
| `server` | procedural hatch, SVG marker, blend mode, data-defined override, expression-driven rules | **QGIS Server WMS raster**; `compileMaplibre()` returns an empty layer list and `strategy: 'wms'` |
| `unsupported` | geometry generators — the derived geometry must be materialised as its own PostGIS layer | blocked from publication by DB constraint |

`compareFidelity()` compares the two compiled outputs property by property — colour,
stroke width (in pixels, with the authored mm recorded as a note), classification
attribute and every class value, class/range/rule counts, zoom range, opacity, labels.

**Current state:** 31/31 layers MATCH; `byFidelity {direct: 24, converted: 7}`;
`byStrategy {vector: 31}`.

---

## API

Reads of published symbology are **public** — the citizen map needs them and the tiles
they style are already public. Only writes are restricted.

| Endpoint | Access |
|---|---|
| `GET /api/gis/layers` | public |
| `GET /api/gis/styles` | public — whole stylesheet, one ETag over all layer checksums |
| `GET /api/gis/styles/:layerId[?version=N][&target=qml]` | public |
| `GET /api/gis/layers/:layerId/config` | public — data ref + style ref, each versioned |
| `GET /api/gis/styles/:layerId/versions` \| `/audit` \| `/diff` \| `/qgis-candidates` \| `/version/:v` | `admin, gis_officer, planner, eo, surveyor` |
| `GET /api/gis/fidelity-report` | same |
| `POST /api/gis/styles/:layerId/import-from-qgis` \| `/draft` | **`admin, gis_officer`** |
| `POST /api/gis/styles/:layerId/version/:v/{submit,approve,publish,deprecate,archive}` | **`admin, gis_officer`** |
| `POST /api/gis/styles/:layerId/rollback` | **`admin, gis_officer`** |
| `POST /api/gis/layers/:layerId/data-synced` | **`admin, gis_officer`** — records a DATA sync, not a style change |

A planner **consumes** styling and cannot author it: `planner` is absent from
`STYLE_ADMINS` deliberately.

### Caching

Versioned cache keys throughout. `?version=N` is immutable by database guarantee, so it
is served `Cache-Control: public, max-age=31536000, immutable`. An unpinned request
carries the style checksum as its `ETag` and revalidates in one conditional request
(verified: 304). Publishing v4 populates the client cache key `layer:v4` and leaves
`layer:v3` intact, so a live session never switches symbology underneath a user.

---

## Two colour systems, kept apart

| System | Governs | Source |
|---|---|---|
| **UI design system** | buttons, panels, tables, navigation, status, text | `--ent-*` tokens (`src/styles/enterprise.css`) |
| **GIS symbology** | parcels, roads, zoning, landuse, water, boundaries, stands | the published style document, only |

`vunguBasemapStyle.ts` retains five constants — `MAP_BACKGROUND` and the label colours.
These are the **paper the map is drawn on**, not the symbology of anything in it; no
QGIS layer defines them. Everything per-layer is registry-resolved.

### Degraded mode is deliberately obvious

If the registry is unreachable, layers render in a neutral diagnostic grey
(`#d4d4d4` / `#a3a3a3` / `#8a8a8a`) and a console warning names the endpoint. Rendering
a plausible-looking guess would put unapproved symbology in front of planners making
statutory decisions, so an obviously-unstyled map is the safe failure.

---

## Operating it

```bash
# audit provenance + fidelity, write nothing
cd frontend && npm run gis:symbology:report

# one-time import / re-import after a QGIS restyle (Phase 4)
cd frontend && npm run gis:symbology:seed

# prove the database guarantees still hold
cd backend && node test-gis-style-registry.js      # 16 checks
```

Normal operation is through **`/admin/gis-symbology`** (admin-gated): a GIS officer
restyles a layer in QGIS Desktop, saves the project, clicks *Import from QGIS*, compares
the new version against the live one, submits, approves, publishes — and can roll back.
The seed script is for bulk migration, not day-to-day work.

---

## Known follow-ups

- **`test-tiles-endpoint.js:18` asserts "catalog lists 24 layers"** but
  `src/config/spatialLayers.js` has 31. Pre-existing stale assertion, unrelated to this
  work; left untouched.
- **`tiles.js:115,120` call `requireRole(['admin'])`** while the signature is
  `requireRole(fastify, allowed)`, so `allowed` is `undefined` and those two admin
  endpoints reject every caller. Pre-existing bug; not touched here.
- **The five legacy `*QGIS*` extractor services (5,271 lines)** remain wired to
  `qgisServer.js` / `dynamic-layers.js` for the QGIS Desktop plugin. They are no longer
  a governance path. Removing them needs a separate audit of the plugin's callers
  (migration Phase 8).
- **`masterplanSymbology.ts`** is still imported by `planning-layers.ts`, the Planning
  Studio and CAD export — surfaces outside the tile-layer registry. Its tile-layer
  colours are now seeded into the registry and no longer read by the map.
- **`symbology-style.db`** in the backend root appears unused; confirm and delete.
- **`spatial_layers.style_config`** (migration 111) still accepts plugin-pushed style
  blobs with no versioning. Either route the plugin through the registry or mark the
  column deprecated.
- **The two QGIS-sourced zone layers lost a web-only zoom-opacity ramp** (was
  0.45→0.60 across z8–z13, now the flat opacity QGIS itself renders). This is the
  correct outcome of QGIS being authoritative for those layers, but it is a visible
  change; if the council wants the ramp back, add it in QGIS or publish a new version
  carrying an `opacityCurve`.
