// src/services/loginSecurity.js
// ─────────────────────────────────────────────────────────────────────────
// Sign-in security: the lockout rule, the IP blocklist, and the record of
// every attempt that feeds both (tables in migration 124).
//
// WHY A MODULE AND NOT INLINE IN THE LOGIN ROUTE
// The login handler has six distinct failure exits — unknown address, bad
// password, suspended, legacy hash, MFA, blocked IP — and a lockout that only
// counted some of them is not a lockout. One `record()` call per exit, all
// routed through this file, is what makes the count complete and what lets the
// console show an admin *why* each attempt failed.
//
// WHAT IS AND IS NOT ENFORCED
// The lockout counts CONSECUTIVE failures for one email address since that
// address last signed in successfully. It is deliberately per-address, not
// per-IP: a council office behind one NAT address would otherwise lock out the
// whole planning department when a single officer mistypes. The IP blocklist
// is the per-address tool, and it is manual, because automatic IP banning in
// front of a shared municipal connection locks out the council, not the
// attacker.
//
// FAILING OPEN
// Every function here fails OPEN — a database error means the officer can
// still sign in. A council that cannot log in because the lockout table is
// unreadable is a worse outcome than one extra password guess, and the audit
// trail records the sign-in either way.
// ─────────────────────────────────────────────────────────────────────────

const { getSettings } = require('./adminSettings')

/** The reasons admin_login_attempt.reason permits. */
const REASONS = Object.freeze({
  NO_SUCH_USER: 'no_such_user',
  BAD_PASSWORD: 'bad_password',
  SUSPENDED: 'suspended',
  DELETED: 'deleted',
  LOCKED_OUT: 'locked_out',
  MFA_FAILED: 'mfa_failed',
  IP_BLOCKED: 'ip_blocked',
})

/** The caller's address, honouring one proxy hop (Render sits in front). */
function clientIp(request) {
  const forwarded = request.headers?.['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim()
  return request.ip || null
}

/**
 * Record one attempt. Never throws and never blocks the response: the caller
 * awaits it only so a test can observe the row, and a failure is logged.
 */
async function record(fastify, request, { email, userId = null, succeeded, reason = null }) {
  try {
    await fastify.pg.query(
      `INSERT INTO public.admin_login_attempt (email, user_id, ip, user_agent, succeeded, reason)
       VALUES ($1, $2, $3::inet, $4, $5, $6)`,
      [
        String(email || '').slice(0, 255),
        userId,
        clientIp(request),
        request.headers?.['user-agent'] || null,
        Boolean(succeeded),
        succeeded ? null : reason,
      ],
    )
  } catch (err) {
    fastify.log.warn({ err }, 'login attempt record failed')
  }
}

/**
 * Whether this address is locked out, and until when.
 *
 * Counts failures since the LAST SUCCESS for the address, so a correct sign-in
 * clears the count without a separate reset step — there is no counter to
 * forget to reset, which is the usual way a lockout ends up permanent.
 */
async function lockoutState(fastify, email) {
  try {
    const { 'security.max_failed_attempts': max, 'security.lockout_minutes': minutes } =
      await getSettings(fastify, ['security.max_failed_attempts', 'security.lockout_minutes'])

    if (!max || max <= 0) return { locked: false, failures: 0, until: null, max: 0 }

    const { rows } = await fastify.pg.query(
      `WITH last_ok AS (
         SELECT max(attempted_at) AS at
           FROM public.admin_login_attempt
          WHERE lower(email) = lower($1) AND succeeded
       )
       SELECT count(*)::int AS failures, max(attempted_at) AS last_failure
         FROM public.admin_login_attempt, last_ok
        WHERE lower(email) = lower($1)
          AND NOT succeeded
          AND reason <> 'locked_out'
          AND (last_ok.at IS NULL OR attempted_at > last_ok.at)`,
      [email],
    )

    const failures = rows[0]?.failures ?? 0
    const lastFailure = rows[0]?.last_failure ?? null
    if (failures < max || !lastFailure) return { locked: false, failures, until: null, max }

    const until = new Date(new Date(lastFailure).getTime() + minutes * 60_000)
    // The window has passed: the failures are stale, so the address is free
    // again without anyone having to clear anything.
    if (until <= new Date()) return { locked: false, failures, until: null, max }

    return { locked: true, failures, until, max }
  } catch (err) {
    fastify.log.warn({ err }, 'lockout check failed; allowing sign-in')
    return { locked: false, failures: 0, until: null, max: 0 }
  }
}

/**
 * Whether the caller's address sits inside a live block.
 *
 * `>>=` is containment, so one /24 row covers 256 addresses and a single
 * address stored as /32 still matches itself.
 */
async function ipBlock(fastify, request) {
  const ip = clientIp(request)
  if (!ip) return null
  try {
    const { rows } = await fastify.pg.query(
      `SELECT id, cidr::text AS cidr, reason, expires_at
         FROM public.admin_ip_block
        WHERE released_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
          AND cidr >>= $1::inet
        LIMIT 1`,
      [ip],
    )
    return rows[0] || null
  } catch (err) {
    fastify.log.warn({ err }, 'ip block check failed; allowing request')
    return null
  }
}

module.exports = { REASONS, record, lockoutState, ipBlock, clientIp }
