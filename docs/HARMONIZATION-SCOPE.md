# Harmonizing VunGIS's spatial data with SurveyPro: scope of the first two pieces

Status: scoped 2026-10-10. **Piece B is built** (see "Built" under B). **A1 (the layout check) and A2 (the context layer) are built** (see "Built" under A1 and A2). Context: `docs/SURVEYPRO-INTEGRATION.md` (the hand-off that exists today).

What exists today is a one-way seam: a council's accepted SurveyPro work is imported into `land.parcel`. Two things are missing at the edges of it:

- **A. The reverse feed.** What VunGIS already knows about the ground (farms, stands, plots) never reaches the surveyor while they work.
- **B. Reconciliation when the Surveyor-General approves a plan.** An approved general plan for a township has nowhere to go if the council's own survey of the same stands is already in the register.

## What the code does today (verified)

| Fact | Where |
|---|---|
| The register holds 731 farm parcels (`origin=custodian`, `accuracy_basis=map_digitised`) and, on this machine, no township stands. Council surveys and Surveyor-General plans would be the first stands. | `land.parcel` |
| The only way an approved plan enters is a **manual upload** by a role holder (`POST /api/gms/imports/general-plan`). The Surveyor-General platform feeds both apps **control monuments only** (read-only, `SG_API_KEY`); there is no plan feed. | `src/routes/gms.js`; `sg-control-api/clients/INTEGRATION.md` |
| That import **refuses** any stand whose number already has a `current` parcel in the township (`stand_no_exists`). A council-surveyed stand therefore **blocks** the approved plan for the same township, stand by stand. | `src/services/gms/parcelImport.js`; unique index `uq_parcel_stand_current` |
| There is no tool to retire or replace a parcel. The guard blocks deletes ("retire it instead") but nothing performs the retiring, and `land.parcel_lineage` only knows `subdivision` and `consolidation`. | `land.parcel_guard`, `land.parcel_lineage` |
| Parcel ids are never reused, and ERP account keys hang off them (the key registry). Replacing a parcel by a new row would orphan its links. | migration 132, `/gms/key-registry` |
| Parcels, wards and stand numbers are already treated as public by nature (`/gms/public/parcels/:id` returns stand, ward, area, geometry). Owners, accounts and bands are not. | `src/routes/gms.js` |
| VunGIS has vector tiles and a parcel search, but only for VunGIS users by role. Nothing lets another system ask. VunGIS to SurveyPro today is the signed launch token only. | `src/routes/gms-map.js`, `src/lib/launchToken.js` |

---

## B. Reconciliation when the Surveyor-General approves a plan (do this first)

**Why first:** it is a hard failure waiting to happen, not an improvement. It is also self-contained (VunGIS only) and small.

### Design: adopt in place, never replace

When an approved plan is imported for a township that already holds authority-origin parcels, a stand that matches is **promoted**, not duplicated: the existing parcel keeps its `parcel_id` (so ERP links survive) and gains the approval.

Per feature in the plan, within the township:

| Case | Outcome |
|---|---|
| No parcel with that stand number | **New**: created as today |
| An **authority-origin** parcel with that stand number, and the boundary agrees within tolerance | **Adopt**: `sg_ref`, `general_plan_id` set; `origin` becomes `custodian`; `accuracy_basis` becomes `general_plan`; geometry set to the approved plan's; `survey_class` kept; an append-only record is written (who, when, which plan, what it was before) |
| An authority-origin parcel with that stand number, boundary **differs** beyond tolerance | **Conflict**: nothing is written; the report shows both boundaries and the officer decides (accept the approved boundary, with the previous one kept in the record, or hold the plan) |
| A **custodian** parcel (already approved) with that stand number | **Refused**, as today (`stand_no_exists`) |
| An authority-origin parcel the plan does not mention | **Orphan**: reported, left authority-origin; it may be a numbering difference or an omission |

Both boundaries are compared in the survey CRS (`geom_source`, untouched), so no datum shift enters the comparison.

### Pieces

1. `land.parcel_event` (append-only): parcel, event (`adopted`), at, by, plan, the previous origin and the previous geometry. The change is auditable and reversible by hand.
2. The importer's validation report gains `adopt`, `new`, `conflicts`, `orphans` counts and, per conflict, the two geometries; `commit` writes only when there are no conflicts and no errors (all-or-nothing, as now).
3. `ParcelApproved` outbox event (instead of `ParcelCreated`) for adopted parcels, so the ERP link is told the same parcel is now approved. **Check first** what consumes the outbox before choosing the event name.
4. The import officer's screen shows the four counts and lets the officer open a conflict.
5. Tests on the live database: adopt keeps `parcel_id`; conflict writes nothing; orphan reported; refusal unchanged for custodian parcels; second import idempotent.

### Built (2026-10-10)

Migration 175 (`land.parcel_event`, append-only), `importGeneralPlan` reconciliation (`src/services/gms/parcelImport.js`), the SurveyPro importer no longer calls an approved parcel "diverged", the import officer's screen shows the new counts, conflicts and orphans, 14 tests (`test/plan-adoption.test.js`) and a step in the `deliver` cross-system scenario (adopt, then the importer sees the stands as approved). **Decided:** tolerance 0.02 m (to be confirmed by a surveyor or the Surveyor-General), plots matched by boundary (intersection over union of at least 0.99; more than one candidate is `ambiguous_match`, never guessed), orphans reported and left alone. **One thing to check before it is used in anger:** the new `ParcelApproved` outbox event is additive, but the ERP adapter's consumer is outside this repository; confirm it ignores or handles an unknown type. Until then an adopted parcel's event simply waits in the queue.

### Decisions that were needed

1. **Tolerance for "the boundary agrees."** In the same CRS the approved diagram should equal the submitted survey, so I propose **0.02 m** per vertex (adjustable). A surveyor or the Surveyor-General should confirm what they treat as the same boundary.
2. **Plots with no township** (a council survey with no township gets `parcel_kind = plot`, no township code): they cannot be matched by stand number. Match by geometry only (overlap of at least 99%), or leave them for manual reconciliation?
3. **Orphans:** reported only, or may the officer retire them in the same step? (I would report only.)

---

## A. The reverse feed

Two parts, in this order because the first is cheap and removes a whole class of importer refusals.

### A1. "Check my layout against the register" (before delivering)

The importer already has the rules that refuse a layout (stand number already in the township, overlap with an existing stand or plot, repeated stand number, bad geometry, unsupported system). Today the surveyor learns of them only when the importer refuses the work, after the council has accepted it.

- Extract those checks from `surveyproImport.js` into one function that returns the same refusal codes without writing.
- `POST /api/context/check-layout` in VunGIS: takes the layout (parcels in Lo coordinates, township), returns the report. SurveyPro calls it from the delivery screen ("Check against the register"); the reviewer sees the result on the review screen. **Advisory for the surveyor, hard gate stays the importer.**
- Needs a way for SurveyPro to call VunGIS (below).

**Built (2026-10-10).** The importer's rules now live in one place, `src/services/layoutCheck.js`, used by the importer and by the check. `POST /api/context/check-layout` (`src/routes/context.js`) is authenticated by a service token (`src/lib/serviceToken.js`: Ed25519, five minutes, names the person, the council and the purpose; VunGIS holds only the public key), runs in a read-only transaction, and returns `{ ok, errors, warnings, checked }`. In SurveyPro: `services/vungisClient.js` signs and calls; `POST /api/survey-projects/:id/check-layout` (the project's surveyor, appointed to the council) and `POST /api/reviews/projects/:id/check-layout` (the council's reviewer or head surveyor); a "Check against the register" button on the delivery and review screens. Advisory: it never stops a delivery, and when VunGIS cannot be reached it says so and nothing else is affected. Tests: `test/layout-check.test.js` (18), the client's tests in SurveyPro (11), and the `check` cross-system scenario, which shows the check, the reviewer's check and the importer agreeing. **Decisions taken:** advisory, not blocking; the reviewer sees the same check. **Bug found and fixed on the way:** the importer's stand-number and overlap checks used `NOT (source_relation = 'surveypro' AND ...)`, which is NULL for a parcel with no source (every parcel from an approved general plan), so those parcels were skipped; the number clash would have hit the unique index and failed the project, the overlap would have gone through. Now `IS DISTINCT FROM`, with a regression test.

### A2. Context layer: what is already on the ground

A read-only layer on the surveyor's map: farm boundaries, existing stands and plots around the job.

- `GET /api/context/jobs/:jobId/parcels?buffer_m=500`: scoped **by job**, not browse-all. The job (`survey_task`) already carries the location, ward and stand; the feed returns parcels within a buffer of it. Least privilege, and it matches how the work is opened.
- **Public fields only**: parcel id, stand number, township, kind, origin, status, `sg_ref`, `survey_class`, `accuracy_basis`, area, geometry. Never owners, accounts or bands.
- **Geometry in the job's Lo zone** (from `geom_source`, reprojected with the registry) as well as WGS 84, so the surveyor sees it in the system they work in.
- **Honest about quality.** Each feature carries its basis. A digitised farm (`map_digitised`, datum floor of ±20 m until the Surveyor-General confirms) must look different on the map from an approved stand, so nobody sets out a beacon from a farm outline.

**Built (2026-10-10), A2.** `POST /api/context/parcels` (`src/routes/context.js`, `src/services/contextParcels.js`), authenticated by a service token for the purpose `context-parcels` (a token for the layout check does not open it, nor the reverse). SurveyPro: `POST /api/survey-projects/:id/context` works out where the project is (the extent of its points and parcels in the belt most of them are in; or, for a job not yet surveyed, the job's location) and asks; a "Register around this survey" control and layer on the cadastral map (`useRegisterContext`, `RegisterContextControl`), off by default and remembered per project. Each outline is **approved** (solid green), **the council's survey awaiting approval** (dashed blue) or **indicative** (dotted orange, with how far out it may be and "do not set out from it"); the outlines come in the surveyor's belt and are placed with the survey's own transformation. **Decisions taken** (the three questions were open): (1) offline: a copy is kept on the device (IndexedDB), used without asking for twelve hours, refreshed on request, and shown as "offline copy" when the register cannot be reached; (2) neighbouring councils: other councils' stands in the window are shown (they are public), tagged with their council; (3) quality: the three outlines above, never a single style. **One change from the scope:** "scoped by job" became "scoped by the surveyor's own project area", because not every project comes from a job; it is bounded instead by the appointment (SurveyPro checks it), a window of at most 6,000 m a side (3,000 m radius), at most 1,500 features, and public fields only. Tests: `test/context-parcels.test.js` (12), the client's (3 more) and the frontend's (service, layer and control: 22), and the `context` cross-system scenario.

### Authentication SurveyPro to VunGIS

Neither system can call the other today except by the launch token (VunGIS to SurveyPro). Mirror it, asymmetric as you decided: SurveyPro holds an Ed25519 key and signs a short-lived (five-minute) service token naming the user, the council and the job; VunGIS holds only the public key, checks the signature, and then **checks the job itself** (it exists, belongs to that council, is assigned to that surveyor's email). VunGIS never has to know SurveyPro's appointments: SurveyPro vouches for the person, VunGIS vouches for the job. A key per environment; nothing secret leaves SurveyPro's server (the browser calls SurveyPro, which calls VunGIS).

### SurveyPro side

A service client (signs the token, calls VunGIS, caches per job), a read-only map layer styled by basis, and the check button on the delivery and review screens.

### Decisions I need

1. **Advisory or blocking?** Should the check ever stop a surveyor delivering? I recommend advisory (the importer is the gate), with the result shown to the reviewer.
2. **Field use.** Surveyors work offline. Cache the context when the job is opened and keep it with the project, or fetch only when online?
3. **Neighbouring councils.** A job near a council boundary: show other councils' stands in the buffer (they are public data) or only the job's own council?
4. **Plan documents / SI 727 limits** are not part of this; they stay on the list.

---

## Order and size

| Step | Where | Size |
|---|---|---|
| 1. B: adopt-in-place, event table, report, tests | VunGIS only | small to medium |
| 2. A1: extract the layout checks, check endpoint, service token verification | VunGIS | small |
| 3. A1: SurveyPro service client, signing key, check button on delivery and review screens | SurveyPro | small to medium |
| 4. A2: context endpoint, SurveyPro map layer | both | medium |

Each step is independently useful and can be shipped and checked with the cross-system scenarios (a new scenario for each).
