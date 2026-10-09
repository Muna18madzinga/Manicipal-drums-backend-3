# VunGIS and SurveyPro: the hand-off contract

Status: v2, 2026-10-09. Decisions taken; SurveyPro's database layer built and verified; **the launch and the importer are built and verified end to end** (VunGIS issues the token and SurveyPro opens the project; VunGIS reads the council's accepted work back through its reader login). Still to come on the SurveyPro side: delivering a project and the reviewer's accept / return, so there is something to read.
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
| a SurveyPro reader (`SURVEYPRO_DATABASE_URL` as the authority's reader login) and an importer: delivered / reviewed status onto `survey_task`; accepted parcels into `land.parcel` | done (below) |
| the surveyor console's **Survey in SurveyPro** button | done |

## The importer (SurveyPro to VunGIS)

`node scripts/import-surveypro.js` is a dry run; `--apply` does it; `--json` gives the report as JSON. It needs `SURVEYPRO_DATABASE_URL` (the council's reader login on SurveyPro, made by SurveyPro's `scripts/create-authority-reader.js`) and `DATABASE_URL` (VunGIS, the system plane: `land.parcel` is national data, so the application role cannot write it). Run it from a scheduler (every fifteen minutes is plenty). The dry run and `--apply` share one code path, the second committing what the first rolls back, so a dry run cannot promise what apply does differently. Rules are in `src/services/surveyproImport.js`:

- **Status.** A job follows its project: delivered becomes *submitted*; the reviewer's decision becomes *accepted*, or *returned* (a rejection also returns it to the surveyor). A surveyor who delivers again after a return is *submitted* again. It only moves forward, never out of *accepted* or *cancelled*, and a job that belongs to another authority is reported, not touched.
- **Parcels.** Only after the project is *accepted*, and only finalized, active parcels. They enter `land.parcel` as **authority-origin** parcels with no `sg_ref` (they await the Surveyor-General, they are not approved by it), `survey_class` = **the SI 727 survey class the surveyor declared** (below), `accuracy_basis = 'surveyed'`, status *current*, custodian "Local authority survey (SurveyPro), awaiting the Surveyor-General", and `source_relation = 'surveypro'`, `source_key = <authority>:<project>:<parcel>` so a run can be repeated and checked. A project with a township gives stands; one without gives plots. A parcel's outbox event is raised like any other (the ERP link).
- **Survey class is not the record's state.** SI 727 (the Land Survey (General) Regulations, 1979), Second Schedule para 1, has three survey classes by the *kind* of survey: **A** determines the position of town survey-marks, **B** is surveys in townships, **C** is every other survey. There is no class D. The classes set the limits of error a survey is held to (Land Survey Act [Chapter 20:12] s9(1)(c), s13(1)(d)). Whether the council has accepted a survey, or the Surveyor-General has approved it, is shown by `origin`, `sg_ref` and `status`, never by the class. The surveyor declares the class on the project in SurveyPro (`PATCH /api/survey-projects/:id/survey-class`, migration 101); the share view carries it as `survey_class`; the importer writes it to `land.parcel.survey_class` (migration 174). It is **never guessed**: a project with no declared class is refused, and so is class A (town survey-marks, not parcels), with a reason that says so. A class that does not match the project (a township should be B, otherwise C) is reported as a warning, not refused, because whether a place is a township is a legal question the project's township field only approximates.
- **The datum, decided here.** SurveyPro tags its geometry with the EPSG code for the Lo zone (2228x); VunGIS transforms survey coordinates with its **own** registry (`gis_ops.crs_registry`, SRIDs 9220xx), whose Cape to WGS 84 transformation is the one the Surveyor-General platform confirms (today Merry & Rens, accuracy ±20 m *pending DSG confirmation*). The importer re-tags the geometry with the registry SRID for the same zone (the numbers do not change: same projection, same axes) before transforming, so every parcel in the register is transformed the same way and carries the method and accuracy used. A Lo zone the registry lacks (Lo25) or a non-Lo system (UTM) is refused with a reason, not guessed.
- **Area** is computed from the geometry; SurveyPro's figure is compared and a disagreement beyond half a square metre and a tenth of a percent is reported as a warning. The geometry's figure is the one kept.
- **Nothing already imported is ever changed.** If SurveyPro's boundary has since changed the parcel is reported as *diverged*: a changed boundary needs a new acceptance. (`land.parcel_guard` enforces the same below the application.)
- **A layout with any problem is refused whole**, with the reasons: an invalid or non-polygon geometry, an unsupported system, a repeated stand number, a stand number already in the township, or an overlap with an existing stand or plot (a farm does not count: a township is carved out of one) or between its own parcels. Parcels that merely share an edge do not overlap.

Check the township on a launched project before delivering it: the launch pre-fills it with the job's ward, and the township becomes the parcels' township code.

Tested on the live database (`test/surveypro-import.test.js`, 24 tests) and end to end against a real SurveyPro database built from its migrations, through a reader login its own script created: the council's project and parcels were read through the share views, the draft parcel was left out, two parcels were imported in the right place on the ground, a second run changed nothing, and the login could not read SurveyPro's base tables.

## Survey classes and the register

Decided 2026-10-09, after reading SI 727 (the scan) and the Land Survey Act [Chapter 20:12] (2012 update). The classes are the SI 727 classes and nothing else; the Act has no A to D grade.

- `land.parcel.survey_class` is `A`, `B`, `C` or NULL (migration 174). NULL means not declared, or not an SI 727 survey (a digitised extract, say). It is never defaulted.
- How a position was arrived at is `accuracy_basis` (`surveyed`, `general_plan`, `map_digitised`, `estimated`, `unknown`; migration 137). Approval by the Surveyor-General is `sg_ref` / `general_plan_id`; origin is `origin`. Migration 174 fills `accuracy_basis` where it was empty, from what the old class stood for.
- `land.parcel.accuracy_class` (the old A to D) is now nullable and **legacy**: existing values are kept as history, new writers leave it empty. The Surveyor-General plan importer still writes `A` (the register screens and tests read it) alongside `accuracy_basis = 'general_plan'`; retiring that is a later step with the screens.
- Features (`gis_ops.feature`) and buildings keep their own required A to D map-capture grade. That is a grade for points and lines drawn on the map, not an SI 727 survey, and is a separate decision.
- The importer refuses class A for parcels (it is surveys of town survey-marks) and warns when the class disagrees with the township (B in a township, otherwise C).

Still to check with a surveyor against the paper regulations: SurveyPro's tolerance kernel applies para 5 style distance factors (0.04 and 0.06) when comparing found beacons, and its comment cites a "para 7(5)" that the scan does not show. Section 15(1)(ii) ties acceptance of previous-survey coordinates to para 7, whose limits are 0.01 (class B) and 0.02 (class C) times the distance. The scan's OCR of paras 5 and 7 was not clean enough to settle it.

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
