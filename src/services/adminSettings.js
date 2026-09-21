// src/services/adminSettings.js
// ─────────────────────────────────────────────────────────────────────────
// Reading side of public.admin_setting (migration 124).
//
// This module is the ONLY reason the console's `enforced` flag is honest. A
// setting marked enforced=true is one some code path calls getSetting() for;
// everything else is recorded and labelled "record only" in the UI. If you add
// an enforced setting, add its call site at the same time or mark it false.
//
// CACHING
// Settings are read on nearly every request (the lockout rule, maintenance
// mode), change perhaps monthly, and live one network hop away in Postgres.
// A 30-second in-process cache turns that into one query per half-minute per
// instance. The cost of the staleness is that a change takes up to 30s to take
// hold everywhere; writeSetting() clears the local cache immediately, so the
// admin who made the change sees it at once on the instance they are talking
// to. That is the right trade for a council with one backend instance, and it
// degrades gracefully to "eventually" if that ever becomes several.
//
// FAILURE POSTURE
// A settings read that throws must never take down the request that needed it.
// Every getter falls back to the seeded default, which is the safe value in
// each case: lockout still applies, maintenance stays off, email stays on.
// ─────────────────────────────────────────────────────────────────────────

const TTL_MS = 30_000

// The seeded defaults, repeated here as the fallback when the table cannot be
// read (a fresh database, a failed migration, a dropped connection). Keep in
// step with the INSERT in migration 124.
const DEFAULTS = Object.freeze({
  'security.password_min_length': 8,
  'security.max_failed_attempts': 5,
  'security.lockout_minutes': 15,
  'security.session_max_hours': 12,
  'security.mfa_required_roles': [],
  'audit.retention_days': 365,
  'system.maintenance_mode': false,
  'system.maintenance_message': 'Vungu RDC planning portal is under maintenance. Please try again shortly.',
  'notifications.email_enabled': true,
  'notifications.sms_enabled': false,
  'notifications.outbox_max_attempts': 5,
})

let cache = null
let cachedAt = 0

/** Text out of the table → the type the column declares. Never throws. */
function coerce(raw, type, fallback) {
  if (raw === null || raw === undefined) return fallback
  switch (type) {
    case 'number': {
      const n = Number(raw)
      return Number.isFinite(n) ? n : fallback
    }
    case 'boolean':
      return raw === 'true' || raw === 't' || raw === '1'
    case 'json':
      try { return JSON.parse(raw) } catch { return fallback }
    default:
      return String(raw)
  }
}

async function load(fastify) {
  const now = Date.now()
  if (cache && now - cachedAt < TTL_MS) return cache
  try {
    const { rows } = await fastify.pg.query(
      'SELECT key, value, value_type FROM public.admin_setting',
    )
    const map = new Map()
    for (const r of rows) map.set(r.key, coerce(r.value, r.value_type, DEFAULTS[r.key]))
    cache = map
    cachedAt = now
    return cache
  } catch (err) {
    fastify.log?.warn({ err }, 'admin settings read failed; using defaults')
    // Do not cache a failure — the next request should try again rather than
    // run on defaults for the full TTL.
    return new Map(Object.entries(DEFAULTS))
  }
}

/** One setting, coerced, with the seeded default as the floor. */
async function getSetting(fastify, key) {
  const map = await load(fastify)
  return map.has(key) ? map.get(key) : DEFAULTS[key]
}

/** Several at once, so a request that needs three does not await three times. */
async function getSettings(fastify, keys) {
  const map = await load(fastify)
  const out = {}
  for (const k of keys) out[k] = map.has(k) ? map.get(k) : DEFAULTS[k]
  return out
}

/** Drop the cache so the next read sees a write that just landed. */
function invalidate() {
  cache = null
  cachedAt = 0
}

module.exports = { getSetting, getSettings, invalidate, DEFAULTS, coerce }
