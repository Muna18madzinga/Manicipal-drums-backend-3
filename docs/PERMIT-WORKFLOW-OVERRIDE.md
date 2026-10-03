# Permit status override: an open compliance question

**Status: open — needs a decision from the product owner. Not a bug report, a
finding.** Found 2026-10-03 while repairing `permit-workflow.test.js`.

## What was found

`PATCH /api/permit-applications/:id/status` has two guards. The first is the
determination gate; the second is the statutory state machine. They are meant to
be independent, but `override: true` disables **both**.

### Guard 1 — determinations must use the EO route

`src/routes/development-management.js:681-691`

```js
const DECIDED = ['approved', 'approved_with_conditions', 'refused']
if (DECIDED.includes(status)) {
  const adminOverride = role === 'admin' && request.body?.override === true
  if (!adminOverride) {
    return reply.code(403).send({ error: 'eo_decision_required', ... })
  }
}
```

This is deliberate and documented in place: *"Determinations must use
POST /eo-decision. Checked before transition so planners always see
eo_decision_required."* It forces a decision through the committee/delegation
path, where `hasCommitteeResolution()` checks for a quorate committee that
actually recorded a resolution.

### Guard 2 — the statutory state machine

`src/routes/development-management.js:60-63`

```js
function rejectUnlawfulTransition(reply, request, fromStatus, toStatus) {
  const isOverride = request.user.role === 'admin' && request.body?.override === true
  if (isOverride || canTransition(fromStatus, toStatus)) return null
  ...
}
```

The `isOverride ||` short-circuit means an admin override does not merely unlock
the *endpoint*; it voids the *workflow*. Any status may follow any status.

### Observed behaviour

Reproduced against a freshly migrated database (`scripts/seed-tsamba.js` data,
`demo.admin@vungu.test`), from a case sitting at `registered`:

| Caller | Request | Result |
|---|---|---|
| planner | `PATCH status=approved` | `403 eo_decision_required` |
| admin | `PATCH status=approved` | `403 eo_decision_required` |
| **admin** | **`PATCH status=approved override=true`** | **`200 OK` — case is now `approved`** |
| admin | `PATCH status=refused override=true` | `200 OK` — refused after approval |

The second row of the table is the problem in one line: a case moved straight
from `registered` to `approved`, skipping consultation, the objection period and
determination — the exact sequence `config/permitWorkflow.js` was written to
prevent:

> *"Before this module, any staff member could jump a case from any status to any
> other (e.g. pending_payment → approved), skipping consultation, objection
> period and determination entirely."*

Override re-opens that for admins. It is not open to `planner`, `eo`,
`planning_clerk`, or anyone else.

## What mitigates it

Three things are right about the current design, and they are why this is a
question rather than an emergency:

1. **Admin-only.** `role === 'admin'`, checked on both guards independently.
2. **Audited.** `development-management.js:727` records `override: true` in
   `permit_event` — but *only* when the transition was unlawful
   (`&& !canTransition(fromStatus, status)`). So the genuinely risky writes are
   the ones that get flagged, and routine overrides stay quiet.
3. **Optimistic locking still applies.** `expectedRevision` and a
   `status = $8` predicate remain in the UPDATE, so a stale client gets a 409.

## Why it needs a decision rather than a patch

The override almost certainly exists for a real need — an admin correcting a
mistake, or recording a decision that predates the deployment. The problem is
not its existence but that its blast radius is undocumented:

- The `eo_decision_required` message says *"admin may pass override:true"* in
  the context of choosing an endpoint. It does not say the same flag also skips
  the statutory chain. An admin reading that message has no way to know they are
  also disabling the workflow.
- `rejectUnlawfulTransition` names the override but not its consequence, so the
  function reads as if it enforces the chain.

### Options

**A. Keep as-is, document it.** Add a comment at `rejectUnlawfulTransition`
stating that override voids the chain, and put the blast radius in the
`eo_decision_required` message. Cheapest; leaves a known skip-the-objection-period
path open to any admin account.

**B. Narrow the override to the endpoint only.** Separate the two concerns: let
`override` satisfy guard 1, but still require `canTransition` in guard 2. An
admin could then record a determination, but only through a lawful transition —
so from `registered` they would still have to walk the chain first. Closes the
hole and keeps the intended capability. This is the option that matches what the
`eo_decision_required` message already implies.

**C. Restrict by transition distance.** Permit override only to moves that are
one step out of a near-decision state (`awaiting_eo_decision → approved`), which
is where a genuine correction is likeliest, and refuse it for long jumps.
Narrower still, but invents policy.

**D. Require a reason.** Keep the behaviour, demand `override_reason`, and
surface it in the event log and any register extract. Makes the escape hatch
legible to a reviewer without removing it.

**E. Route it through `/eo-decision`.** Have admin overrides resolve to the same
committee-resolution check the statutory path uses, so an override is recorded as
a delegated decision rather than a bare status write. Most faithful to the Act,
most work.

## How this was verified

`scripts/prepare-acceptance-db.js` builds a disposable database from the
migration chain; the behaviour above was reproduced there rather than against the
recovered supervisor database. The regression coverage added in
`permit-workflow.test.js` pins guard 1 and guard 2 **separately**, so the two
cannot be conflated again — and it deliberately does *not* pin the override's
current behaviour, because that behaviour is the open question above. If it is
resolved as option B, that suite is where the change should be asserted.

## Related

- `src/config/permitWorkflow.js` — the state machine and its rationale
- `src/routes/development-management.js:650-737` — the route
- `migrations/017_*`, `migrations/075_*` — compliance functions, still unverified
  against real data (see `docs/WORKPLAN.md`)
