# VunGIS and SurveyPro: the hand-off contract

Status: v2, 2026-10-09. Decisions taken; SurveyPro's database layer built and verified; **the launch is built and verified end to end** (VunGIS issues the token, SurveyPro accepts it and opens the project); reading accepted work back into VunGIS is next.
The SurveyPro side is described in its own repository: `docs/AUTHORITY_TENANCY.md`.

## Decisions (from the owner)

1. **Tokens are signed asymmetrically.** VunGIS holds the private key; SurveyPro holds only the public key.
2. **Plan documents are stored as files with a checksum.** The formats beyond PDF, and how they are stored, are to be revisited and redesigned later.
3. **Coordinates are carried as westing and southing plus the Lo zone** (SurveyPro stores Cape / Lo south-orientated, X ordinate = westing, Y ordinate = southing). Other projections, UTM first, must fit without a redesign. This is SurveyPro's concern (see below): VunGIS holds geometry with its SRID and lets PostGIS transform it.
4. **SurveyPro hosts the database and shares views with local authorities the way VunGIS gives them access:** a login of the authority's own that reads only its views.
5. **Both employed and contracted surveyors**, designed for both: councils often contract surveyors for cadastral surveys.

Ownership, restated: surveyors work for the local authority (employed or contracted), so **survey datasets are owned by the authority and administered by the surveyor.**

## What decision 4 changes

The first draft had SurveyPro push a bundle of coordinates, beacons and parcels into VunGIS's `survey_*` tables. That is dropped. If SurveyPro hosts the data and shares views, VunGIS should **read** what it needs rather than hold a second copy that can drift:

| | System of record |
|---|---|
| Survey work (projects, points, parcels, beacons, plan files, reviews) | **SurveyPro**, in tables keyed to an authority and a surveyor, isolated by row-level security |
| The job the authority assigns, and its status | **VunGIS** `spatial_planning.survey_task` (tenant data) |
| Accepted parcels, once a plan is accepted | **VunGIS** `land.parcel` (`origin = 'authority'`, `source_relation = 'surveypro'`); lodging with the Surveyor-General comes later |

An authority reaches its survey data three ways, all returning the same rows:
- **the SurveyPro web application**, signed in as an appointed surveyor, head surveyor or reviewer;
- **a database login of its own** (`sp_reader_<code>`) over `survey_share.projects / points / parcels / beacons / reviews`, for QGIS and the like;
- **VunGIS**, which uses that same login to read accepted work and to show a job's progress.

## The flow

1. A planner or EO assigns a job in VunGIS (`POST /api/surveyor/jobs`).
2. The surveyor chooses **Survey in SurveyPro**. VunGIS signs a *launch token* and opens SurveyPro with it.
3. SurveyPro verifies the token with VunGIS's public key and finds the surveyor. The surveyor must hold an **appointment** with that authority (surveyor, employed or contracted). SurveyPro creates, or reopens, a project for that authority linked to the job (`external_job_id`).
4. The surveyor works in SurveyPro and **delivers** the project (`delivered_at`).
5. An authority **reviewer** (or head surveyor, never the project's own surveyor) records *accepted*, *rejected* or *returned*. Append-only.
6. VunGIS reads the status through the shared views: the job shows as submitted, then accepted. On acceptance VunGIS imports the parcels into `land.parcel`, in their own system and with their axes labelled.

## Launch token (VunGIS to SurveyPro)

`POST /api/surveyor/jobs/:id/launch` (the assigned surveyor, or an admin) returns `{ url, expires_at }`. The token is a JWT signed **Ed25519**, valid 10 minutes, single use (`jti`):

```
iss "vungis"   aud "surveypro"   sub <surveyor email>   name
authority { code, name }         SurveyPro checks the code against survey.authority and the surveyor's appointments
job { id, task_type, stand_number, suburb_ward, gauss_lo, instructions, due_date, location { lon, lat }, permit_ref }
```

There is no delivery token: a delivery is a status change inside SurveyPro, not a push to VunGIS. (An optional notification from SurveyPro to VunGIS on delivery and on a review decision can follow; VunGIS can also simply read the views.)

## What VunGIS reads

Through the authority's reader login (`survey_share`, SurveyPro migration 099):

| view | carries |
|---|---|
| `projects` | authority, name, type, district, surveyor name / licence / firm, engagement, `external_job_id`, `delivered_at`, latest review decision and note |
| `points`, `parcels` | the geometry in its own system with `srid`, `lo_zone`, `axis_order`; `y_westing` / `x_southing` for Cape / Lo, `easting` / `northing` for anything else |
| `beacons` | adopted beacons, westing and southing |
| `reviews` | every decision, who and when |

**Coordinates.** VunGIS reads the geometry (`geom`, with its `srid`) and never handles raw westing / southing numbers, so it has no axis convention of its own to get wrong: the Lo systems declare `axis=wsu` in `spatial_ref_sys` and `ST_Transform` honours it (checked: a point sent to Cape / Lo29 and back returns exactly). The `y_westing` / `x_southing` / `easting` / `northing` / `axis_order` columns exist for people and tools that read the views (QGIS, a spreadsheet), not for VunGIS. What *does* need care is the **datum**: Cape or Arc 1950, and the rotation signs used between them. That is what the Surveyor-General platform's `check-datum-conventions.js` pins, and the importer must use the transformation that script confirms.

**Parcels.** VunGIS recomputes area, perimeter and closure from the geometry (`computeAreaConsistency`) and records any disagreement with SurveyPro's figures; its own are kept.

**Files.** Plan documents are stored as files in SurveyPro with a checksum and offered to the authority as a list with a download link; SurveyPro's tables for them are not built yet (`survey.project_file`). Redesign for more formats comes later.

## What VunGIS builds

| | |
|---|---|
| launch endpoint, Ed25519 token library, key configuration | small |
| a SurveyPro reader (`SURVEYPRO_DATABASE_URL` as the authority's reader login) and an importer: delivered / reviewed status onto `survey_task`; accepted parcels into `land.parcel` | medium |
| the surveyor console's **Survey in SurveyPro** button | done |

## The embedded copy is gone

The copy of SurveyPro that was embedded in VunGIS (the Survey Task Manager at `/api/survey` and the `/surveyor-workspace` screens) has been removed, so surveying has one source of truth. What stays is VunGIS's own job module: `survey_task` and the `/surveyor` console with its job queue (`/surveyor/jobs`). Old `/surveyor-workspace` bookmarks go to the console.

The `survey.*` tables and the `surveyor_*` schemas it used are still in the database, closed to the application role (migration 173; `tenancy.surveyor_schema_access` proves it), until the owner confirms there is no production data to keep. Then one migration drops them. The uncommitted `TransformView.vue` work from the old tree is saved as a patch in the SurveyPro repository (`docs/vungis-TransformView-wip.patch`, branch `beta-vungis`).

## Setting up the launch

1. In VunGIS: `node scripts/generate-launch-keys.js` writes `.launch-key.pem` (private, git-ignored) and prints the public key. Set `SURVEYPRO_URL` (where SurveyPro's web application is served) and `SURVEYPRO_LAUNCH_KEY_FILE=.launch-key.pem`.
2. In SurveyPro: set `VUNGIS_LAUNCH_PUBLIC_KEY` to that public key; run its migrations (096-100); an administrator creates the two group roles once (its `docs/AUTHORITY_TENANCY.md`).
3. In SurveyPro, add the council (`survey.authority`, code = VunGIS `local_authorities.code`) and its first head surveyor (the platform operator does this once, in SQL). From then on the head surveyor appoints people through `POST /api/authorities/:code/members`.
4. A surveyor registers in SurveyPro with the same email address they use in VunGIS, and is appointed. Then **Survey in SurveyPro** on a job works.

Check the keys any time with `node scripts/generate-launch-keys.js --check`.

## Decided

1. **Appointments are made by the council's head surveyor in SurveyPro** (the council manages its own panel, employed and contracted alike). VunGIS never creates one. A surveyor the council has not appointed is told so, by name, when they try to launch.
2. **VunGIS reads SurveyPro through the authority's reader login** over the network: exactly the access councils already get (`scripts/create-authority-reader.js` in SurveyPro).

## Open points
1. **Authority codes** must match between the two systems (`local_authorities.code` and `survey.authority.code`). One of them should be the register; the Surveyor-General platform's list is the natural source.
2. **Private practice.** SurveyPro still serves independent surveyors, whose projects belong to no authority and are visible to them alone. A job from an authority always belongs to that authority.
3. **Existing data** in the embedded per-surveyor schemas is moved once, at cutover (`survey.adopt_surveyor_schema`). The dev database holds none.

## What the launch refuses, and says

| | answer |
|---|---|
| not the assigned surveyor, or the job is unclaimed / closed | VunGIS 403 / 409; nothing is signed |
| VunGIS has no key or no `SURVEYPRO_URL` | 503 "SurveyPro is not connected" |
| token forged, changed, expired, for another audience, or signed by another key | SurveyPro 401, with the reason |
| the same link used twice | SurveyPro 409; open the job again |
| no SurveyPro account for that email | 404; register with the same email, then open again |
| council not in SurveyPro | 409 |
| surveyor not appointed to that council today (never, or ended) | 403, naming the council and the head surveyor to ask |

A second launch of the same job reopens the same project (found by the job's id), so a surveyor can come back to it from VunGIS any number of times.
