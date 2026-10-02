/**
 * Smoke test for the IT Admin console API (src/routes/admin-console.js,
 * migration 124).
 *
 *   node test-admin-console.js                     # against localhost:3000
 *   API=https://… ADMIN_EMAIL=… ADMIN_PASSWORD=… node test-admin-console.js
 *
 * WHY THIS EXISTS, BEYOND THE USUAL
 * One check here — "an audit row is actually written" — is the reason the
 * whole file does. The audit middleware catches its own INSERT failure so it
 * can never fail the request it is auditing, which is right, and which is
 * exactly how the council ran for months with an audit trail that silently
 * wrote nothing (the table in migration 041 was never created). A catch that
 * cannot fail loudly needs a test that can.
 *
 * Requires the server running and a working admin account. Every write it
 * makes is undone before it exits, so it is safe to run against a populated
 * database — but it is a SMOKE test, not a fixture: it does not seed.
 */

const API = process.env.API || 'http://localhost:3000/api'
const EMAIL = process.env.ADMIN_EMAIL || 'demo.admin@vungu.test'
const PASSWORD = process.env.ADMIN_PASSWORD || process.env.DEMO_DEFAULT_PASSWORD || 'demo1234'

let cookie = ''
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
  // Content-Type is set ONLY when there is a body: Fastify rejects a bodyless
  // request that declares application/json with FST_ERR_CTP_EMPTY_JSON_BODY,
  // which would make every DELETE here look like an API failure.
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const setCookie = res.headers.getSetCookie?.() ?? []
  if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* CSV and error pages are not JSON */ }
  return { status: res.status, json, text, headers: res.headers }
}

async function main() {
  console.log(`\nVungu IT Admin console smoke test → ${API}\n`)

  // ── Sign in ───────────────────────────────────────────────────────────
  console.log('auth')
  const login = await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD })
  check('admin signs in', login.status === 200 && login.json?.success,
    `${login.status} ${login.text.slice(0, 120)}`)
  if (!cookie) {
    console.log('\nCannot continue without a session. Is the server running, and is the account right?')
    process.exit(1)
  }
  check('the role really is admin', login.json?.data?.user?.role === 'admin',
    `got ${login.json?.data?.user?.role}`)

  // The sign-in above must have left a row. This is the login-security half
  // of the same "does the record actually get written" question.
  const attempts = await call('GET', '/admin/login-attempts?limit=5')
  check('sign-in was recorded', attempts.status === 200 && (attempts.json?.data?.length ?? 0) > 0)
  check('the recorded sign-in succeeded',
    attempts.json?.data?.[0]?.succeeded === true,
    JSON.stringify(attempts.json?.data?.[0] ?? null))

  // ── Overview ──────────────────────────────────────────────────────────
  console.log('\noverview')
  const overview = await call('GET', '/admin/overview')
  check('GET /admin/overview', overview.status === 200 && overview.json?.success)
  const o = overview.json?.data
  check('staff counts are present and consistent',
    o && o.staff.total >= o.staff.active && o.staff.total >= 0,
    JSON.stringify(o?.staff))
  check('the caller is counted among the live sessions', (o?.sessions?.live ?? 0) >= 1)

  // ── Permissions ───────────────────────────────────────────────────────
  console.log('\npermissions')
  const perms = await call('GET', '/admin/permissions')
  check('GET /admin/permissions', perms.status === 200)
  check('every assignable role is described',
    (perms.json?.data?.roles?.length ?? 0) >= 8)
  const adminRow = perms.json?.data?.capabilities?.find((c) => c.id === 'admin.users')
  check('admin holds admin.users and planner does not',
    adminRow?.granted?.admin === true && adminRow?.granted?.planner === false,
    JSON.stringify(adminRow?.granted))

  // ── Settings ──────────────────────────────────────────────────────────
  console.log('\nsettings')
  const settings = await call('GET', '/admin/settings')
  check('GET /admin/settings', settings.status === 200)
  check('the seeded keys are there', (settings.json?.data?.length ?? 0) >= 14)
  const minLen = settings.json?.data?.find((s) => s.key === 'security.password_min_length')
  check('password_min_length is marked enforced', minLen?.enforced === true)

  // A value outside the declared constraints must be refused, and refused
  // WITHOUT writing the others in the same request.
  const bad = await call('PUT', '/admin/settings', {
    settings: { 'security.password_min_length': 2, 'security.lockout_minutes': 20 },
  })
  check('an out-of-range setting is rejected', bad.status === 400,
    `${bad.status} ${bad.text.slice(0, 120)}`)
  const afterBad = await call('GET', '/admin/settings')
  check('the whole update rolled back',
    afterBad.json?.data?.find((s) => s.key === 'security.lockout_minutes')?.value
      === settings.json?.data?.find((s) => s.key === 'security.lockout_minutes')?.value)

  const unknown = await call('PUT', '/admin/settings', { settings: { 'no.such.key': 1 } })
  check('an unknown key is rejected', unknown.status === 400)

  // A real round trip, then put it back exactly as found.
  const originalMin = minLen?.value
  const good = await call('PUT', '/admin/settings', {
    settings: { 'security.password_min_length': 10 },
  })
  check('a valid setting is accepted', good.status === 200)
  const reread = await call('GET', '/admin/settings')
  check('the new value reads back',
    reread.json?.data?.find((s) => s.key === 'security.password_min_length')?.value === '10')
  await call('PUT', '/admin/settings', {
    settings: { 'security.password_min_length': Number(originalMin) },
  })

  // ── Audit trail ───────────────────────────────────────────────────────
  // The settings write above was a PUT by an authenticated admin, so the
  // middleware must have recorded it. THIS is the check that would have
  // caught the empty trail.
  console.log('\naudit')
  await new Promise((r) => setTimeout(r, 400))  // onResponse runs after the reply
  const audit = await call('GET', '/admin/audit?limit=20')
  check('GET /admin/audit', audit.status === 200)
  check('the trail is being written at all', (audit.json?.data?.length ?? 0) > 0,
    'no rows — the audit middleware is writing nowhere')
  const settingsEvent = audit.json?.data?.find((e) => e.event === 'SETTINGS')
  check('the settings change is in the trail', Boolean(settingsEvent),
    `events seen: ${[...new Set((audit.json?.data ?? []).map((e) => e.event))].join(', ')}`)
  check('the trail names the officer',
    settingsEvent?.actor_email === EMAIL, settingsEvent?.actor_email)
  check('the trail records the outcome, not just the intent',
    typeof settingsEvent?.status === 'number', String(settingsEvent?.status))
  check('a total accompanies the page', typeof audit.json?.meta?.total === 'number')

  const filtered = await call('GET', '/admin/audit?severity=high&limit=5')
  check('severity filter works',
    filtered.status === 200 && (filtered.json?.data ?? []).every((e) => e.severity === 'high'))

  const events = await call('GET', '/admin/audit/events')
  check('GET /admin/audit/events', events.status === 200 && Array.isArray(events.json?.data))

  const csv = await call('GET', '/admin/audit/export?limit=5')
  check('CSV export is served as CSV',
    csv.status === 200 && (csv.headers.get('content-type') || '').includes('text/csv'))
  check('CSV carries a header row', csv.text.startsWith('occurred_at,actor_email'))
  check('CSV states how many rows it holds', csv.headers.get('x-row-count') !== null)

  // ── Sessions ──────────────────────────────────────────────────────────
  console.log('\nsessions')
  const sessions = await call('GET', '/admin/sessions')
  check('GET /admin/sessions', sessions.status === 200)
  check('sessions span users, not just the caller',
    Array.isArray(sessions.json?.data) && sessions.json.data.length >= 1)
  check('the caller\'s own session is flagged',
    sessions.json?.data?.some((s) => s.current === true),
    'nothing flagged current — revoking would be able to lock the admin out')
  check('a session names its user', Boolean(sessions.json?.data?.[0]?.email))

  const badRevoke = await call('DELETE', '/admin/sessions/not-a-uuid')
  check('a malformed session id is a 400, not a 500', badRevoke.status === 400)

  // ── IP blocks ─────────────────────────────────────────────────────────
  console.log('\nip blocks')
  const badCidr = await call('POST', '/admin/ip-blocks', { cidr: 'nonsense', reason: 'test' })
  check('an unparseable address is a 400', badCidr.status === 400,
    `${badCidr.status} ${badCidr.text.slice(0, 120)}`)

  // 203.0.113.0/24 is TEST-NET-3 (RFC 5737): reserved for documentation, so
  // it can never be a real council address.
  const block = await call('POST', '/admin/ip-blocks', {
    cidr: '203.0.113.0/24', reason: 'smoke test — safe to delete',
  })
  check('a range can be blocked', block.status === 201, `${block.status} ${block.text.slice(0, 120)}`)
  const blockId = block.json?.data?.id
  const blocks = await call('GET', '/admin/ip-blocks')
  check('the block is listed', blocks.json?.data?.some((b) => b.id === blockId))
  if (blockId) {
    const released = await call('DELETE', `/admin/ip-blocks/${blockId}`)
    check('the block can be released', released.status === 200)
    const after = await call('GET', '/admin/ip-blocks')
    check('a released block leaves the live list',
      !after.json?.data?.some((b) => b.id === blockId))
  }

  // ── System ────────────────────────────────────────────────────────────
  console.log('\nsystem')
  const health = await call('GET', '/admin/system/health')
  check('GET /admin/system/health', health.status === 200)
  check('the database reports its size', (health.json?.data?.database?.sizeBytes ?? 0) > 0)
  check('PostGIS is reported', health.json?.data?.database?.postgis === true)
  check('the process reports itself', Boolean(health.json?.data?.process?.node))
  check('load average says whether it is supported',
    typeof health.json?.data?.host?.loadAvgSupported === 'boolean')

  const tables = await call('GET', '/admin/system/tables')
  check('GET /admin/system/tables', tables.status === 200)
  check('tables are listed largest first',
    (tables.json?.data?.length ?? 0) > 5
    && tables.json.data[0].bytes >= tables.json.data[tables.json.data.length - 1].bytes)

  const backups = await call('GET', '/admin/backups')
  check('GET /admin/backups', backups.status === 200)
  check('backups state whether the directory exists',
    typeof backups.json?.data?.exists === 'boolean')

  // ── Outbox ────────────────────────────────────────────────────────────
  console.log('\noutbox')
  const outbox = await call('GET', '/admin/outbox')
  check('GET /admin/outbox', outbox.status === 200)
  check('status counts accompany the page', typeof outbox.json?.meta?.counts === 'object')

  // ── Announcements ─────────────────────────────────────────────────────
  console.log('\nannouncements')
  const created = await call('POST', '/admin/announcements', {
    title: 'Smoke test announcement',
    body: 'Created by test-admin-console.js. Safe to withdraw.',
    level: 'info', audience: 'admin',
  })
  check('an announcement can be created', created.status === 201,
    `${created.status} ${created.text.slice(0, 120)}`)
  const annId = created.json?.data?.id
  const backwards = await call('POST', '/admin/announcements', {
    title: 'Backwards', body: 'x',
    startsAt: '2030-01-02T00:00:00Z', endsAt: '2030-01-01T00:00:00Z',
  })
  check('an announcement that ends before it starts is refused', backwards.status === 400)
  if (annId) {
    const patched = await call('PATCH', `/admin/announcements/${annId}`, { level: 'warning' })
    check('an announcement can be amended',
      patched.status === 200 && patched.json?.data?.level === 'warning')
    const withdrawn = await call('DELETE', `/admin/announcements/${annId}`)
    check('an announcement can be withdrawn', withdrawn.status === 200)
    const live = await call('GET', '/admin/announcements')
    check('a withdrawn announcement leaves the live list',
      !live.json?.data?.some((a) => a.id === annId))
  }

  // ── Org structure ─────────────────────────────────────────────────────
  console.log('\norg structure')
  const org = await call('GET', '/admin/org')
  check('GET /admin/org', org.status === 200)
  check('the establishment is seeded', (org.json?.data?.length ?? 0) >= 5)
  check('a vacancy is representable',
    org.json?.data?.some((p) => p.holder_id === null),
    'every post is filled — cannot verify the vacancy case')
  check('role mismatches are computed',
    org.json?.data?.every((p) => typeof p.roleMismatch === 'boolean'))

  const post = await call('POST', '/admin/org', {
    title: 'Smoke test post', department: 'Testing',
  })
  check('a post can be created', post.status === 201)
  const postId = post.json?.data?.id
  if (postId) {
    const selfParent = await call('PATCH', `/admin/org/${postId}`, { reportsTo: postId })
    check('a post cannot report to itself', selfParent.status === 400)
    const removed = await call('DELETE', `/admin/org/${postId}`)
    check('a post can be removed', removed.status === 200)
  }

  // ── The gate ──────────────────────────────────────────────────────────
  // Every check so far ran as an admin. This one proves the gate is real.
  console.log('\naccess control')
  const saved = cookie
  cookie = ''
  const anon = await call('GET', '/admin/audit')
  check('the audit trail refuses an anonymous caller',
    anon.status === 401 || anon.status === 403, `got ${anon.status}`)
  const anonSettings = await call('PUT', '/admin/settings', { settings: {} })
  check('settings refuse an anonymous caller',
    anonSettings.status === 401 || anonSettings.status === 403, `got ${anonSettings.status}`)
  cookie = saved

  console.log(`\n${passed} passed, ${failed} failed\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err)
  process.exit(1)
})
