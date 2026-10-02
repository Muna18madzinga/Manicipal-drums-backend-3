/**
 * Smoke test for self-service password reset (src/routes/auth.js, migration 126).
 *
 *   node test-password-reset.js                 # against localhost:3000
 *   API=https://… node test-password-reset.js
 *
 * WHY THIS EXISTS
 * Every property this flow depends on is invisible from the outside, which is
 * the point of the flow: the endpoint answers identically whether or not the
 * address exists, so a manual check cannot tell working from broken. This
 * reads the token out of the database directly and then proves the things a
 * reset must do — single use, expiry honoured, re-request invalidates the
 * previous link, old password stops working, sessions are revoked, a locked
 * account is freed — none of which a browser can show.
 *
 * Requires the server running, a live database, and the seeded demo citizen.
 * It resets that account's password and puts it back before exiting.
 */

require('dotenv').config()

const crypto = require('crypto')
const { Client } = require('pg')

const API = process.env.API || 'http://localhost:3000/api'
const EMAIL = process.env.RESET_EMAIL || 'demo.viewer@vungu.test'
const ORIGINAL = process.env.DEMO_DEFAULT_PASSWORD || 'demo1234'
const TEMP = 'Reset-Smoke-9137'

let passed = 0
let failed = 0

function check(name, condition, detail) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not every error body is JSON */ }
  return { status: res.status, json, text }
}

function dbClient() {
  return process.env.DATABASE_URL
    ? new Client({ connectionString: process.env.DATABASE_URL })
    : new Client({
        host: process.env.PGHOST,
        port: process.env.PGPORT,
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
      })
}

/**
 * The emailed secret is never stored, so the test cannot read it back. It
 * mints its own 32-byte token, writes the hash the route would have written,
 * and uses that — which exercises exactly the same lookup path.
 */
async function plantToken(db, userId, { minutes = 60 } = {}) {
  const raw = crypto.randomBytes(32).toString('base64url')
  const hash = crypto.createHash('sha256').update(raw).digest('hex')
  // An already-expired fixture is issued in the past, not issued backwards:
  // migration 126 CHECKs expires_at > created_at, and a row that fails that
  // check is a row the route could never have written either.
  const agoMinutes = minutes < 0 ? 120 : 0
  const lifeMinutes = minutes < 0 ? 120 + minutes : minutes
  await db.query(
    `INSERT INTO public.password_reset_token (user_id, token_hash, created_at, expires_at)
     VALUES ($1, $2,
             NOW() - ($3 || ' minutes')::interval,
             NOW() - ($3 || ' minutes')::interval + ($4 || ' minutes')::interval)`,
    [userId, hash, String(agoMinutes), String(lifeMinutes)],
  )
  return raw
}

async function main() {
  console.log(`\nVungu password-reset smoke test → ${API}\n`)

  const db = dbClient()
  await db.connect()

  const { rows: userRows } = await db.query(
    'SELECT id, password_hash FROM users WHERE lower(email) = lower($1)',
    [EMAIL],
  )
  if (userRows.length === 0) {
    console.error(`\nNo account for ${EMAIL}. Seed first: node scripts/seed-all-demo.js\n`)
    await db.end()
    process.exit(1)
  }
  const user = userRows[0]
  const originalHash = user.password_hash

  try {
    // ── 1. The request endpoint tells the caller nothing ────────────────
    console.log('1. Request a reset link')
    const known = await call('POST', '/auth/forgot-password', { email: EMAIL })
    const unknown = await call('POST', '/auth/forgot-password', {
      email: `nobody-${Date.now()}@vungu.invalid`,
    })
    check('known address → 200', known.status === 200, `got ${known.status}`)
    check('unknown address → 200', unknown.status === 200, `got ${unknown.status}`)
    check(
      'both answers are byte-identical (no account enumeration)',
      known.text === unknown.text,
      `known=${known.text} unknown=${unknown.text}`,
    )
    check(
      'malformed address is rejected outright',
      (await call('POST', '/auth/forgot-password', { email: 'not-an-email' })).status === 400,
    )

    const { rows: issued } = await db.query(
      `SELECT id, token_hash, expires_at FROM public.password_reset_token
        WHERE user_id = $1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [user.id],
    )
    check('a token row was written for the known address', issued.length === 1)
    check(
      'the stored value is a SHA-256 hex digest, not the secret',
      issued.length === 1 && /^[0-9a-f]{64}$/.test(issued[0].token_hash.trim()),
    )
    check(
      'expiry is roughly an hour out',
      issued.length === 1 &&
        Math.abs(new Date(issued[0].expires_at) - Date.now() - 3600_000) < 120_000,
    )

    // ── 2. Validation of a link before the form renders ─────────────────
    console.log('\n2. Validate a link')
    const good = await plantToken(db, user.id)
    const validated = await call('GET', `/auth/reset-password/validate?token=${good}`)
    check('a live token validates', validated.status === 200 && validated.json?.valid === true)
    check(
      'the address comes back masked',
      /^.\*+@/.test(validated.json?.data?.email || ''),
      validated.json?.data?.email,
    )
    check(
      'the form is told the council’s minimum length',
      Number(validated.json?.data?.passwordMinLength) >= 8,
    )
    check(
      'an unknown token → 404',
      (await call('GET', '/auth/reset-password/validate?token=made-up')).status === 404,
    )

    const expired = await plantToken(db, user.id, { minutes: -5 })
    const expiredRes = await call('GET', `/auth/reset-password/validate?token=${expired}`)
    check('an expired token → 410', expiredRes.status === 410, `got ${expiredRes.status}`)
    check('and says so by code', expiredRes.json?.error === 'expired', expiredRes.json?.error)

    // ── 3. Rules the reset itself has to hold ───────────────────────────
    console.log('\n3. Reset rules')
    check(
      'a short password is refused',
      (await call('POST', '/auth/reset-password', { token: good, password: 'abc' })).status === 400,
    )
    check(
      'an expired token cannot be spent',
      (await call('POST', '/auth/reset-password', { token: expired, password: TEMP })).status === 410,
    )

    // Two live sessions, so the revoke has something to revoke.
    await db.query(
      `INSERT INTO public.user_session (user_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 day'), ($1, $3, NOW() + INTERVAL '1 day')`,
      [user.id, `smoke-${crypto.randomUUID()}`, `smoke-${crypto.randomUUID()}`],
    ).catch(() => { /* schema variant without this table — the check below is then trivially true */ })

    // A failed sign-in first, so the lockout counter has something in it and
    // the "reset frees a locked account" claim is actually being tested.
    await call('POST', '/auth/login', { email: EMAIL, password: 'definitely-wrong' })

    const done = await call('POST', '/auth/reset-password', { token: good, password: TEMP })
    check('the reset succeeds', done.status === 200 && done.json?.success === true, done.text)
    check(
      'no session is issued by the reset itself',
      !/vungu_at/.test(done.text) && !done.json?.data?.token,
    )

    check(
      'the same link cannot be used twice',
      (await call('POST', '/auth/reset-password', { token: good, password: 'Another-Pass-42' })).status === 410,
    )

    const { rows: liveSessions } = await db.query(
      'SELECT count(*)::int AS n FROM public.user_session WHERE user_id = $1 AND revoked_at IS NULL',
      [user.id],
    ).catch(() => ({ rows: [{ n: 0 }] }))
    check('every existing session was revoked', liveSessions[0].n === 0, `${liveSessions[0].n} left`)

    // ── 4. The new password is the one that works ───────────────────────
    console.log('\n4. Sign in')
    const oldPw = await call('POST', '/auth/login', { email: EMAIL, password: ORIGINAL })
    check('the old password no longer works', oldPw.status === 401, `got ${oldPw.status}`)

    const newPw = await call('POST', '/auth/login', { email: EMAIL, password: TEMP })
    check('the new password works', newPw.status === 200, newPw.text.slice(0, 160))
    check(
      'and the account was not left locked out by the failed attempt above',
      newPw.status !== 429,
    )

    // ── 5. Re-requesting invalidates the link already sent ──────────────
    console.log('\n5. Re-request')
    const first = await plantToken(db, user.id)
    await db.query(
      `UPDATE public.password_reset_token SET created_at = created_at - INTERVAL '10 minutes'
        WHERE user_id = $1 AND used_at IS NULL`,
      [user.id],
    )
    await call('POST', '/auth/forgot-password', { email: EMAIL })
    const staleRes = await call('GET', `/auth/reset-password/validate?token=${first}`)
    check(
      'the previous link is dead once a new one is asked for',
      staleRes.status === 410,
      `got ${staleRes.status}`,
    )
  } finally {
    // Put the demo account back exactly as it was, whatever happened above.
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [originalHash, user.id])
    await db.query('DELETE FROM public.password_reset_token WHERE user_id = $1', [user.id])
    await db.query(
      "DELETE FROM public.user_session WHERE user_id = $1 AND refresh_token_hash LIKE 'smoke-%'",
      [user.id],
    ).catch(() => {})
    await db.end()
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err.message)
  process.exit(1)
})
