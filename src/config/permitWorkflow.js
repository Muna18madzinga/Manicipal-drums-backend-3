/**
 * Permit application workflow — the statutory state machine (RTCP Act / DM
 * Handbook v1.2). Single source of truth for which status transitions are
 * lawful; enforced in development-management.js on every status write
 * (PATCH /status, POST /eo-decision, POST /return-to-role).
 *
 * Before this module, any staff member could jump a case from any status to
 * any other (e.g. pending_payment → approved), skipping consultation,
 * objection period and determination entirely.
 *
 * Rules encoded:
 *  - Intake must move forward: payment → registration → acknowledgement →
 *    circulation/objection → review → determination.
 *  - Review stages may loop (review ↔ circulation, deferral) — statute allows
 *    further consultation before determination.
 *  - A determination (approved / approved_with_conditions / refused) is final;
 *    the only exit is an appeal. Appeal outcomes re-determine or remit.
 *  - withdrawn is terminal and reachable from any pre-decision stage.
 *  - Same-status writes are allowed (updating conditions without moving).
 *
 * ponytail: plain JS map, not a DB table — transitions change with legislation
 * (code review + migration), not per-council config. Move to a table if
 * multi-tenancy ever needs per-authority workflows.
 */

const PERMIT_STATUSES = [
  'pending_payment', 'registered', 'acknowledged', 'circulation',
  'objection_period', 'under_review', 'awaiting_eo_decision', 'deferred',
  'approved', 'approved_with_conditions', 'refused', 'withdrawn', 'appealed',
]

const DECIDED = ['approved', 'approved_with_conditions', 'refused']

const TRANSITIONS = {
  pending_payment:      ['registered', 'withdrawn'],
  registered:           ['acknowledged', 'circulation', 'under_review', 'withdrawn'],
  acknowledged:         ['circulation', 'objection_period', 'under_review', 'withdrawn'],
  circulation:          ['objection_period', 'under_review', 'withdrawn'],
  objection_period:     ['under_review', 'awaiting_eo_decision', 'withdrawn'],
  under_review:         ['circulation', 'objection_period', 'awaiting_eo_decision', 'deferred',
                         ...DECIDED, 'withdrawn'],
  awaiting_eo_decision: ['circulation', 'under_review', 'deferred', ...DECIDED, 'withdrawn'],
  deferred:             ['circulation', 'under_review', 'awaiting_eo_decision', 'withdrawn'],
  approved:                 ['appealed'],
  approved_with_conditions: ['appealed'],
  refused:                  ['appealed'],
  appealed:             ['under_review', ...DECIDED],
  withdrawn:            [],
}

/** Is from → to a lawful transition? Same-status is always allowed. */
function canTransition(from, to) {
  if (!from || !to) return false
  if (from === to) return true
  return (TRANSITIONS[from] || []).includes(to)
}

/** Lawful next statuses from `from` (for error messages / UI). */
function allowedTransitions(from) {
  return TRANSITIONS[from] || []
}

function isDecided(status) {
  return DECIDED.includes(status)
}

module.exports = { PERMIT_STATUSES, TRANSITIONS, canTransition, allowedTransitions, isDecided }
