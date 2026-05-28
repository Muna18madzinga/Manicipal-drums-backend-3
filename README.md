# Vungu Spatial Data Portal — Backend

Fastify + PostgreSQL/PostGIS API for the Vungu Rural District Council.
The full system README (architecture, citizen flows, design rationale,
authoritative documents) lives in the **frontend repo**:
[`~/Manicipal-drums-frontend/README.md`](../Manicipal-drums-frontend/README.md).

This file is the operational manual: how to set the backend up, run
migrations, configure environment, run the email worker, and find
your way around the route surface.

---

## TL;DR

```bash
# 1. Postgres with PostGIS
createdb vungu_master_db_v1
psql vungu_master_db_v1 -c "CREATE EXTENSION IF NOT EXISTS postgis;"

# 2. Backend
npm install
cp .env.example .env
# Edit .env — at minimum set JWT_SECRET to a 48-byte random string:
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"

# 3. Migrations (in order — see below)
psql vungu_master_db_v1 -f migrations/001_initial_schema.sql
psql vungu_master_db_v1 -f migrations/042_development_applications.sql
psql vungu_master_db_v1 -f migrations/050_enhance_land_use_management_corrected.sql
psql vungu_master_db_v1 -f migrations/060_invite_system_and_roles.sql
psql vungu_master_db_v1 -f migrations/061_applicant_type_and_invite_roles.sql
psql vungu_master_db_v1 -f migrations/062_stands_and_planning_templates.sql
psql vungu_master_db_v1 -f migrations/063_notifications_and_inspections.sql
psql vungu_master_db_v1 -f migrations/064_payments_and_documents.sql
psql vungu_master_db_v1 -f migrations/065_plan_review.sql

# 4. Run
npm run dev                                                # API on :3000
node src/workers/emailWorker.js                            # email worker (separate proc)
```

---

## Spatial data (map layers)

All the map data is reproducible from a clone — you don't need the original
shapefiles. The two source GeoPackages are committed via **Git LFS** under
`data/`, and one script rebuilds every layer.

```bash
# 0. After cloning, pull the LFS-backed GeoPackages (they're ~1.4 GB):
git lfs install
git lfs pull

# 1. Make sure DATABASE_URL (or PGHOST/PGUSER/PGPASSWORD/PGDATABASE) points
#    at a Postgres with PostGIS, then:
npm run setup:spatial
```

`npm run setup:spatial` ([scripts/setup-spatial.mjs](scripts/setup-spatial.mjs)) is idempotent and does:

| Step | Source | Result |
| --- | --- | --- |
| OSM basemap | `data/zimbabwe.gpkg` | 24 tables: `country`, `provinces`, `districts`, `wards`, `roads`, `buildings`, `landuse`, … (native SRID 900914) |
| Master plan | `data/Vungu_RDC_Master_Plan.gpkg` | 6 `vungu_*` tables — cemeteries, waste, farm cadastre, parcels, proposed/beyond peri-urban zones (EPSG:4326) |
| Legacy | `data/seed/gweru_legacy.sql` | 8 `gweru_*` tables (their source shapefiles no longer exist, so they ship as a SQL dump) |
| Indexes | — | a GiST index on every `geom` column |

**Prerequisites:** `psql`, plus a GDAL `ogr2ogr` that has the PostgreSQL
driver — **QGIS** or **OSGeo4W** ship one (the EnterpriseDB PostgreSQL
bundle's `ogr2ogr` does *not*). The script auto-discovers QGIS/OSGeo4W and
points PROJ at that GDAL's own `proj.db`. Override discovery with the
`OGR2OGR` / `PSQL` env vars if needed.

> Note: `data/zimbabwe.gpkg` is 1.4 GB. GitHub's free Git LFS tier is 1 GB of
> storage / 1 GB bandwidth a month — pushing it will exceed that. For a
> private/self-hosted remote with adequate LFS quota this is fine; otherwise
> keep `zimbabwe.gpkg` out of the remote and copy it manually, then run
> `ZIMBABWE_GPKG=/path/to/zimbabwe.gpkg npm run setup:spatial`.

---

## Migrations added in this engagement

The bold rows below are the migrations introduced while building the
citizen flows (Turns A–D plus the auth hardening). They are **strictly
additive** — none drop existing data.

| # | File | Adds | Notes |
| --- | --- | --- | --- |
| 060 | `060_invite_system_and_roles.sql` | invites table, `full_name`, `last_login_at`, `job_title`, `department`, `phone`, `status` cols; expands role check | pre-existing |
| **061** | **`061_applicant_type_and_invite_roles.sql`** | **`users.applicant_type` col, broader role allow-list (admin/planner/eo/env_officer/building_inspector/planning_clerk/surveyor/gis_officer), broader invite roles** | new — auth hardening |
| **062** | **`062_stands_and_planning_templates.sql`** | **`stands` (PostGIS Polygon, generated centroid), `planning_assistant_templates` seeded with 8 layouts from Manual 2021** | new — Turn A |
| **063** | **`063_notifications_and_inspections.sql`** | **`notifications_outbox`, `application_status_history`, `inspection_bookings` (9 stages from Annexure 12), `inspection_status_events`, `inspection_photos`** | new — Turn B |
| **064** | **`064_payments_and_documents.sql`** | **`exchange_rates`, `payments` (USD+ZWG legs, monotonic receipts), `citizen_documents`** | new — Turn C |
| **065** | **`065_plan_review.sql`** | **`plan_reviews` (FSM), `plan_review_findings`** | new — Turn D |

A node-pg-migrate file
`1768743814302_update-admin-password.js` exists for legacy installs
but is unrelated to the new work.

---

## Environment variables

`.env` is now `.gitignore`'d (a previously committed copy was
untracked with `git rm --cached .env`). Copy `.env.example` and edit.

```ini
# ── Database ─────────────────────────────────────────────────────
DATABASE_URL=postgresql://postgres:cairo2025@localhost:5432/vungu_master_db_v1

# ── Server ───────────────────────────────────────────────────────
PORT=3000
NODE_ENV=development

# ── JWT (REQUIRED, ≥32 chars). The server REFUSES to boot in
#    production with the example string.
#    Generate: node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
JWT_SECRET=replace-with-real-48-byte-base64

# ── CORS ─────────────────────────────────────────────────────────
ALLOWED_ORIGINS=http://localhost:5174

# ── Money / payments ─────────────────────────────────────────────
# 1 USD = N ZWG fallback when no row in exchange_rates is fresher than 72h.
EXCHANGE_FALLBACK_USD_ZWG=36.0000

# ── Mail ─────────────────────────────────────────────────────────
MAIL_TRANSPORT=console            # or smtp
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=no-reply@vungurdc.gov.zw
MAIL_WORKER_INPROC=               # 1 to run the worker inside server.js (dev)
MAIL_POLL_MS=30000
MAIL_BATCH=25
MAIL_MAX_ATTEMPTS=5

# ── Verifier ─────────────────────────────────────────────────────
ID_VERIFIER=manual                # manual | smile_id | onfido (latter two stubbed)

# ── Storage roots ────────────────────────────────────────────────
INSPECTION_PHOTO_ROOT=
CITIZEN_DOC_ROOT=
PLAN_REVIEW_ROOT=

# ── Frontend (used in email links) ───────────────────────────────
FRONTEND_URL=http://localhost:5174
```

---

## Running the email worker

Three modes:

1. **In-process** (single-instance dev):
   ```bash
   MAIL_WORKER_INPROC=1 npm run dev
   ```
2. **Separate process, same machine** (recommended for production
   single-node):
   ```bash
   node src/workers/emailWorker.js
   ```
3. **Multiple instances** (horizontal scale): the worker uses
   `SELECT FOR UPDATE SKIP LOCKED`, so multiple replicas are safe.

Until SMTP is configured, the worker uses a **console transport** that
logs each email to stdout and marks the outbox row as `sent`. To enable
real delivery:

```bash
npm i nodemailer
MAIL_TRANSPORT=smtp \
SMTP_HOST=smtp.example.com SMTP_PORT=587 \
SMTP_USER=apikey SMTP_PASS=… SMTP_FROM='no-reply@vungurdc.gov.zw' \
  node src/workers/emailWorker.js
```

The five built-in templates live in
[`src/services/notifier.js`](src/services/notifier.js):

- `application_status_change`
- `inspection_scheduled`
- `inspection_rescheduled`
- `inspection_waitlisted`
- `inspection_completed`

All render in **Africa/Harare** time so a 09:00 UTC inspection shows
as 11:00 to the citizen.

---

## Authentication

Real signed JWT (HS256) lives at
[`src/middleware/jwtAuth.js`](src/middleware/jwtAuth.js).
Tokens carry `sub`, `role`, `email`, `type ('access' | 'refresh')`,
`iss = 'vungu-portal'`, `exp` (12h access, 14d refresh).
The middleware re-validates the user against the DB on every request
so suspensions take effect immediately.

Roles:

- **citizen-facing** (issued by `/auth/register`): `registered`,
  `public`. The route **ignores** any `role` field in the body and
  derives the value from `applicant_type`.
- **employee-facing** (issued via `/auth/invite/accept`): `admin`,
  `planner`, `eo`, `env_officer`, `building_inspector`,
  `planning_clerk`, `surveyor`, `gis_officer`, `viewer`.

Defence-in-depth on registration: the frontend
([`src/views/RegisterView.vue`](../Manicipal-drums-frontend/src/views/RegisterView.vue))
maps `applicant_type` → safe role; the backend then ignores body
`role` entirely; the DB has a `users_role_check` constraint that
prevents writing any value outside the allow-list.

---

## Route surface

54 method-level entries across 8 plugins. Full list with auth scopes
in the frontend README under
[“API surface”](../Manicipal-drums-frontend/README.md#api-surface-54-endpoints).

Plugins (load order in `server.js`):

1. `publicRoutes`
2. `authRoutes` (rate-limited at 10/min on its own scope)
3. `standsRoutes`
4. `planningAssistantRoutes`
5. `inspectionRoutes`
6. `applicationStatusRoutes`
7. `paymentRoutes`
8. `documentRoutes`
9. `planReviewRoutes`
10. spatial / OGC / land-use / dynamic-layers (pre-existing)

---

## Service interfaces (where to plug providers)

Each external integration sits behind a 4-method interface in
`src/services/*`. Implementing the methods is the entire integration:

### Payment driver
File: `src/services/paymentDriver.js`

```js
{
  name: '<provider>',
  async initPayment({ payment, returnUrl, ipAddress }) {
    // → { providerRef, redirectUrl, providerStatus }
  },
  async pollPayment({ payment }) {
    // → { providerStatus, paid, paidAt? }
  },
  async verifyWebhook({ headers, body, rawBody }) {
    // → { ok, providerRef, providerStatus, paid }
  },
  async refund({ payment, amountUsd }) {
    // → { ok }
  },
}
```

Built in: `manual` (working). Stubs: `paynow`, `stripe`, `ecocash`,
`onemoney` — each throws `driver_not_implemented` until implemented.

### ID verifier
File: `src/services/idVerifier.js`

```js
{
  name: '<provider>',
  async verify({ doc, fileBuffer }) {
    // → {
    //     status: 'verified' | 'rejected' | 'under_review',
    //     confidence: number in [0,1] | null,
    //     provider: string,
    //     payload: object,        // raw provider response
    //     extracted: { name?, idNumber?, dob?, expiry? }
    //   }
  },
}
```

Built in: `manual` (leaves docs in `under_review` for staff). Stubs:
`smile_id`, `onfido`.

### Mail transport
File: `src/workers/emailWorker.js`

```js
{
  name: '<transport>',
  async send({ to, subject, text, html? }) {
    // → { ok: true, providerMessageId? } | { ok: false, error, permanent? }
  },
}
```

Built in: `console`, `smtp` (requires nodemailer).

---

## Smoke tests

```bash
# Boot a stub Fastify with all 8 new plugins and dump the route tree.
JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("base64"))')" \
node -e "
const fastify = require('fastify')({ logger: false });
const { authRoutes } = require('./src/routes/auth');
const { standsRoutes } = require('./src/routes/stands');
const { planningAssistantRoutes } = require('./src/routes/planning-assistant');
const { inspectionRoutes } = require('./src/routes/inspections');
const { applicationStatusRoutes } = require('./src/routes/application-status');
const { paymentRoutes } = require('./src/routes/payments');
const { documentRoutes } = require('./src/routes/documents');
const { planReviewRoutes } = require('./src/routes/plan-review');
(async () => {
  fastify.decorate('pg', {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
  });
  await fastify.register(require('@fastify/multipart'));
  for (const r of [authRoutes, standsRoutes, planningAssistantRoutes,
                   inspectionRoutes, applicationStatusRoutes,
                   paymentRoutes, documentRoutes, planReviewRoutes]) {
    await fastify.register(r, { prefix: '/api' });
  }
  await fastify.ready();
  console.log(fastify.printRoutes({ commonPrefix: false }));
  await fastify.close();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1) });
"
```

Expected output: a tree containing 54 method-level entries.

---

## Where to start in the code

| Concern | File |
| --- | --- |
| Auth (sign / verify / preHandlers) | `src/middleware/jwtAuth.js` |
| Stands list / detail / reserve | `src/routes/stands.js` |
| Rules engine (zone × land-use → permitted/special_consent/prohibited) | `src/services/planningAssistant.js` |
| Inspection lifecycle | `src/routes/inspections.js`, `src/services/notifier.js` |
| Application status transitions | `src/routes/application-status.js` |
| Money math (USD↔ZWG) | `src/services/exchangeRate.js` |
| Payment lifecycle + driver abstraction | `src/routes/payments.js`, `src/services/paymentDriver.js` |
| Document upload + verification | `src/routes/documents.js`, `src/services/idVerifier.js` |
| Plan auto-review (deterministic checks) | `src/routes/plan-review.js`, `src/services/planReview.js` |
| Email outbox + worker | `src/services/notifier.js`, `src/workers/emailWorker.js` |

---

## What is not yet wired

In addition to the items in the frontend README:

- **Real RBZ rate fetcher.** A nightly cron should hit RBZ's daily rate
  page and `INSERT INTO exchange_rates ON CONFLICT`. Until then,
  `EXCHANGE_FALLBACK_USD_ZWG` keeps the system functional and the
  citizen UI shows a stale-rate warning.
- **Webhook signature secrets** for each real payment provider.
  `verifyWebhook()` currently returns `ok: false` for the manual
  driver and throws `driver_not_implemented` for the others.
- **Stand cadastral import** from the council's GIS (the
  `stands` table is empty after migration 062).
- **CAD geometric checks** in `runDeepChecks()` — the seam exists but
  no parser is wired in. `dxf-parser` (Node) or a Python sidecar with
  `ezdxf` are both reasonable choices.
- **Password reset (self-service)** endpoint. The frontend's "Forgot?"
  link currently `mailto:`s council support.

---

## Licence

Council-internal. The Development Management / Control Manual 2021 is
© Government of Zimbabwe / Ministry of Local Government & Public Works.
