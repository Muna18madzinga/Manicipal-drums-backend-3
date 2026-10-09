# VunGIS and SurveyPro: the hand-off contract

Status: DRAFT for sign-off, 2026-10-09. Nothing below is built yet except the tenancy side (migration 173) and the cutover switch.

## Decision

SurveyPro is a separate product (own repository, own database, offered as a SaaS to local authorities). VunGIS does not embed it: it integrates with it.

Ownership: **surveyors are employed by the local authority, so survey datasets are owned by the authority and administered by the surveyor.**

| | System of record |
|---|---|
| Survey working data (projects, field points, computations, drafts, plan sheets) | SurveyPro, in the surveyor's schema (`surveyor_<x>`) |
| The job the authority assigns, who it is assigned to, its status | VunGIS: `spatial_planning.survey_task` (tenant data) |
| What the surveyor hands back and the authority accepts (coordinates, beacons, parcels, plan documents, findings) | VunGIS: `survey_coordinate`, `survey_beacon`, `survey_parcel`, `survey_document`, `survey_finding` (tenant data) |
| The cadastre once a plan is accepted | VunGIS `land.parcel` (custody rules in `SPATIAL-NAMING-CONVENTION.md`); lodging with the Surveyor-General is a later step |

For a SaaS serving several authorities, the simplest strong boundary is **one SurveyPro database per authority**, with the per-surveyor schemas as the working partition inside it. SurveyPro then needs no organisation column. (Today it has none, and its shared `public` tables are visible across surveyors; that is its own known gap, not VunGIS's.)

## The flow

1. A planner or EO assigns a job in VunGIS (`POST /api/surveyor/jobs`). It is tenant data of the authority.
2. The surveyor opens the job and chooses **Survey in SurveyPro**. VunGIS issues a *launch token* and opens SurveyPro with it.
3. SurveyPro verifies the token, finds or creates the surveyor's profile and schema, and creates (or reopens) a project linked to the job (`vungis_job_id`).
4. The surveyor works in SurveyPro.
5. The surveyor chooses **Deliver to council**. SurveyPro posts a *deliverable bundle* to VunGIS with the scoped delivery token it received at launch.
6. VunGIS records the bundle against the job as the surveyor's submission (job status `submitted`). A planner or the head surveyor reviews it.
7. On acceptance the parcels enter the authority's cadastre (`land.parcel`, `origin = 'authority'`). Lodging with the Surveyor-General is out of scope here.

## Launch token (VunGIS to SurveyPro)

`POST /api/surveyor/jobs/:id/launch` (surveyor assigned to the job, or admin) returns `{ url, expires_at }`.

A signed JWT, valid 10 minutes, single use (`jti`):

```
iss: "vungis"            aud: "surveypro"          sub: <surveyor email>        name, role
authority: { code, name }                       // SurveyPro checks it matches its own deployment
job: { id, task_type, stand_number, suburb_ward, gauss_lo, instructions, due_date, location: { lon, lat }, permit_ref }
deliver: { url, token }                         // scoped delivery token, below
```

Recommended signing: **Ed25519 (asymmetric)**. VunGIS signs; SurveyPro holds only the public key, so a compromise of SurveyPro cannot mint tokens. (A shared HS256 secret works but puts a minting key in a second system.)

## Delivery token (SurveyPro to VunGIS)

Separate JWT, `aud: "vungis-handoff"`, claims `{ sub (user id), job (task id), scope: "deliver" }`, valid 8 hours. It authorises exactly one thing: `POST /api/handoff/jobs/:id/deliverables` for that job. It is not a login session. VunGIS looks the user up, confirms the job is assigned to them and belongs to their authority, and runs the insert as that user (so row-level security applies).

## Deliverable bundle

`POST /api/handoff/jobs/:id/deliverables`, JSON, idempotent on `bundle_id` (resending the same bundle changes nothing).

```
bundle_id        uuid, chosen by SurveyPro
project          { id, name, survey_type, survey_date, lo_zone: 25|27|29|31|33 }
coordinates[]    { label, y_westing, x_southing, elevation?, description? }
beacons[]        { corner_label, beacon_type, y_westing, x_southing, status, notes? }
parcels[]        { stand?, designation?, points: [{ label, y_westing, x_southing }], area_m2?, perimeter_m?, closure_error_m?, closure_ratio? }
documents[]      { doc_type, title, file (multipart), sha256 }
findings         { summary, recommendation?, conditions?, notes? }
```

### Coordinates: the axes are not easting and northing

SurveyPro stores Cape / Lo coordinates south-orientated: **Y is Westing, X is Southing** (EPSG:22291 family, `+axis=wsu`; SurveyPro's `FIX_CAPE_LO_AXIS.md`). VunGIS's survey tables use `easting` and `northing`. The bundle therefore carries `y_westing` / `x_southing` and a `lo_zone`, and **VunGIS converts explicitly**; no field called easting or northing may carry a Y or X. The check script that pins the two conventions lives in the Surveyor-General platform repository.

### Parcels

VunGIS recomputes area, perimeter and closure from the points (`computeAreaConsistency`) and records any disagreement with SurveyPro's figures. The server's figures are the ones kept.

### Documents

SurveyPro produces binary plans (SI 727 PDFs, schedules). `survey_document` today holds rendered **text** and allows only `dsg_certificate` and `report_on_survey`. Plans need to be stored as files with a checksum; see decision 2.

## Gaps this exposes on the VunGIS side

- `survey_coordinate.coord_system` allows `WGS84`, `Lo31`, `Lo29`, `UTM35S`, `other`, but jobs may be in zones 25, 27, 29, 31 and 33 (`survey_task.gauss_lo`). Lo25, Lo27 and Lo33 jobs cannot store coordinates in their own system.
- `survey_document` cannot hold a file.
- Nothing yet issues launch tokens or accepts a bundle.

## What changes where

| | Build |
|---|---|
| VunGIS (this repository) | launch endpoint, delivery endpoint, token library, migration for zones and document files, tests; the surveyor console links to SurveyPro |
| SurveyPro (its repository) | accept a launch token (`/auth/launch`), store `vungis_job_id` on projects, "Deliver to council" action producing the bundle, deployment config naming its authority |
| Cutover | deploy SurveyPro for the authority; ship the above; set `EMBEDDED_SURVEY=off`; repoint the surveyor console |

Already done: the embedded copy is frozen and its `survey.*` tables are closed to the request plane (migration 173); `tenancy.surveyor_schema_access` proves the per-surveyor schemas are unreachable by the application role; `EMBEDDED_SURVEY=off` switches the module off. Existing data in the embedded per-surveyor schemas is exported to SurveyPro once, at cutover (the dev database holds none).

## Decisions needed

1. **Token signing**: Ed25519 (recommended) or a shared secret?
2. **Plan documents**: store PDFs as files in VunGIS with a checksum (recommended), or keep only a reference to SurveyPro?
3. **Coordinate carriage**: accept `y_westing` / `x_southing` plus `lo_zone` as above, converting on arrival?
4. **Where SurveyPro runs**: hosted by you for several authorities (database per authority), or deployed inside each authority?
5. **Who the surveyors are**: employees only, or also contracted private surveyors who work for the authority from their own SurveyPro accounts? That decides whether a surveyor's SurveyPro identity is created from the launch token or already exists.
