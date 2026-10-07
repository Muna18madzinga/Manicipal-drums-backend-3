/**
 * Rule snapshots: which plan(s) and zone(s) govern a parcel and what they decide for a land
 * use, computed on the server (migration 145, rule_snapshot()). Input from the client is only
 * the parcel's name and the land-use code, validated here; the rules never come from the client.
 */

const PARCEL_LAYERS = ['stands', 'vungu_parcels', 'land.parcel']
const PARCEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/
const USE_CODE_RE = /^[A-Za-z0-9]{1,10}$/

/** Returns { layer, id } for a valid parcel reference, or null. */
function parseParcelRef(layer, id) {
  if (!PARCEL_LAYERS.includes(layer)) return null
  if (typeof id !== 'string' && typeof id !== 'number') return null
  const sid = String(id)
  return PARCEL_ID_RE.test(sid) ? { layer, id: sid } : null
}

/** Returns the land-use code, or null if it is not a plain short code. */
function parseUseCode(value) {
  return typeof value === 'string' && USE_CODE_RE.test(value) ? value : null
}

/** The plan to record on an application: the governing zone's plan, only if there is exactly one. */
function singlePlanId(snapshot) {
  const plans = new Set((snapshot.results || []).filter((r) => r.governing).map((r) => r.plan.id))
  return plans.size === 1 ? [...plans][0] : null
}

async function takeSnapshot(db, ref, useCode) {
  const { rows } = await db.query('SELECT rule_snapshot($1, $2, $3) AS snapshot', [ref.layer, ref.id, useCode])
  const snapshot = rows[0].snapshot
  return { snapshot, planId: singlePlanId(snapshot) }
}

module.exports = { PARCEL_LAYERS, parseParcelRef, parseUseCode, singlePlanId, takeSnapshot }
