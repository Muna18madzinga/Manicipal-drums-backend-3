# Tenancy: one authority cannot see or change another's data

Phase 4, slices 1 and 2 (migrations 154 and 155, `src/lib/tenancy.js`). The rule is enforced **by the database**, not by
each route, so a route that forgets a filter cannot leak another authority's rows.

## How it works

1. **A person belongs to an authority** (`users.authority_id`). A **platform operator** (`users.is_platform`)
   may cross authorities and add authorities. Nobody is one by default; grant it with
   `node scripts/set-platform-user.js --email <address>`. An authority's own IT administrator is **not** one.
2. **A request runs as that person.** `tenantPool(pool, request.user)` steps the connection into the
   `vungu_app` role (which cannot bypass row-level security) and carries `app.user_id`, `app.authority_id`
   and `app.platform` for the length of the call, then resets them. If it cannot reset a connection it
   destroys it; if it cannot step into the role it throws. It **never** falls back to the owner connection.
3. **Policies on the tables** read those settings.

## What a person sees

| | Own authority | A combination they belong to | Another authority's | Templates and gazetted plans |
|---|---|---|---|---|
| Staff read | yes | yes | no | yes |
| Staff write | yes | **no** (read only) | no | no (platform only) |

- A combination authority's rows are visible to the staff of each **current** member; members never see each
  other's own rows. When a membership ends (`valid_to`), the visibility ends with it.
- A **citizen** sees and lodges only their own permits (`created_by`), whatever the authority.
- **The public** (no session) sees templates and gazetted plans, and nothing else.
- With **no settings at all** the database shows only what is public: it fails closed.

## What is enforced today, and what is not

**Enforced by row-level security:** `plan_instrument` and everything that hangs off a plan
(`plan_zone_type`, `land_use_groups`, `zone_land_use_controls`, `plan_zone_standard`, the two crosswalk tables,
`plan_event`, `plan_signoff`, `parcel_zoning`, `proposed_peri_urban_zones`), `permit_application` and
everything that hangs off a permit (migration 155): `permit_rule_snapshot`, `permit_event`, consultations,
objections, appeals, building plans and their annotations, stage inspections with their checklist results,
photos, flags and field events, occupation certificates, public notices, case messages, documents, document
requests, generated documents, EO hand-off packages, statutory clock events and agenda items. A child is
readable when its permit is, and writable when the permit is the caller's own (or the caller lodged it).
The views `plan_instrument_summary`, `zone_effective_controls`, `v_application_summary`,
`v_inspector_queue`, `v_eo_decision_queue`, `v_specialist_findings`, `v_inspection_progress`,
`stage_inspection_scoring`, `stage_inspection_flag_summary` and `v_survey_task` run with the caller's rights.

**Routes that opt in (and so are enforced):** the plan model routes, the workbench, parcel zoning, and every
permit route in `development-management.js` (create, list, read, status, case, consultations, objections,
public notice, EO decision, return and request-for-information, messages, building plans, stage inspections,
occupation certificates, documents, work queues). The matrix read routes in `development-control-refactored.js` (zones, zone types, the matrix grid, permitted uses, zoning-at, compliance check) also run as the person asking, so the public map sees only a template or a gazetted plan, never another authority's draft. Anything addressed `/permit-applications/:id…`, or by a
child's own id (`/consultations/:cid`, `/objections/:oid`, `/building-plans/:bpid`,
`/stage-inspections/:sid`, `/generated-documents/:id`), answers 404 to a signed-in person whose authority
does not own the permit, before the route runs. Kept on the owner connection on purpose: the audit-trail
insert (`logEvent`) and the lodgement-time zoning snapshot, which are system actions on a row the request has
just been allowed to create.

**Not yet enforced (be clear about this):**
- **Enforcement and prohibition orders, committee meetings and members, survey tasks, planning projects, building
  complaints, health premises and spatial analysis results.** Their link to a permit is optional or absent,
  so there is no owner to follow; they need an `authority_id` of their own. Their routes still use the
  owner connection.
- **Other route files** (appeals, payments, planning clerk, inspector GIS, notifications, protected uploads) still
  use the plain pool and so bypass the policies. They are not yet converted.
- **A combination authority's member who tries to write** to a combination's permit is refused by the database,
  but most permit routes report that as a 500 rather than a readable 403. Nothing is written.
- **Spatial datasets** (farms, parcels, rivers, chiefdoms, stands, the national layers) have no owner yet.
  They need an authority column or a jurisdiction, which waits for the authority-ward relation and the
  Zimbabwe Electoral Commission wards (docs/ADMIN-DATA-CUSTODIANS-ZIMBABWE.md). Views and analytics are to be
  clipped to the authority's boundary; the data itself is kept whole.
- **`vungu_app` can read every table**, including `users` (password hashes), and **can write most of them**: migration 154's
  default privileges give it INSERT, UPDATE and DELETE on every table or view created afterwards in `public`, `land`,
  `spatial_planning` and `gis_ops`. Migration 163 takes the write grants away from the reference and registry tables added since
  (and from `public.wards`, which is now a view), but narrowing the role properly (read-only by default, write only where a route
  needs it) is still to do. `scripts/verify-plan-model.js` fails if those reference tables become writable again.
- **QGIS Desktop and the tile server** connect to the database directly and are not scoped.

## Transitional, and to be removed
- Staff with no authority are given **Vungu** (`users_default_authority`), and `permit_application.authority_id`
  defaults to 1. Both go when staff are provisioned into their own authority (the invite flow must carry the
  inviter's authority).
- The application connects as the owner. **In production connect as a non-owner role** (`vungu_app`, or a
  login role granted it) so nothing can bypass the policies, and keep the owner for migrations only.

## Extending it
- **A route:** replace `fastify.pg.query(...)` with `tenantPool(fastify.pg, request.user).query(...)`; on a
  public route add `optionalAuth(fastify)` so a signed-in person is recognised.
- **A table:** `ENABLE ROW LEVEL SECURITY` and policies on `app.visible_authorities()`, `app.authority_id()`,
  `app.user_id()`, `app.is_platform()`; add the cases to `scripts/verify-rls.js`.
- **Prove it:** `node scripts/verify-rls.js` (three authorities, a combination, a citizen, the public; changes
  nothing). It also runs in `scripts/verify-fresh-database.js`.

## Test accounts
The test authority `TESTCO` and a deactivated `rls-live@vungu.test` user remain in the development database.
The user cannot be deleted because the audit trail is append-only; it is suspended.
