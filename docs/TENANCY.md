# Tenancy: one authority cannot see or change another's data

Phase 4, slice 1 (migration 154, `src/lib/tenancy.js`). The rule is enforced **by the database**, not by
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
`permit_rule_snapshot`. The views `plan_instrument_summary`, `zone_effective_controls` and
`v_application_summary` run with the caller's rights (`security_invoker`).

**Routes that opt in (and so are enforced):** the plan model routes, the workbench, parcel zoning, and the
permit routes for create, list, read, rule snapshots and parcel. In addition, **any** route addressed
`/permit-applications/:id…` answers 404 to a signed-in person whose authority does not own the permit.

**Not yet enforced (be clear about this):**
- Code that still uses the plain pool connects as the owner and bypasses the policies. The remaining
  permit routes (status, consultations, objections, building plans, inspections, certificates) are
  guarded only by the id hook, and routes addressed by a child id (`/consultations/:cid`, `/objections/:oid`,
  `/building-plans/:bpid`, `/stage-inspections/:sid`) are **not** covered by it.
- **Spatial datasets** (farms, parcels, rivers, chiefdoms, stands, the national layers) have no owner yet.
  They need an authority column or a jurisdiction, which waits for the authority-ward relation and the
  Zimbabwe Electoral Commission wards (docs/ADMIN-DATA-CUSTODIANS-ZIMBABWE.md). Views and analytics are to be
  clipped to the authority's boundary; the data itself is kept whole.
- **`vungu_app` can read every table**, including `users` (password hashes). Narrowing its grants is a
  separate step.
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
