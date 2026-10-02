/**
 * Release verification for the Planning Clerk registers API.
 *
 * test-planning-clerk.js proves the handler's rules. This proves the two
 * things a release needs on top of that:
 *
 *   1. EVERY register is reachable and writable through the shared handler —
 *      not just the two the smoke test happens to exercise. A register that
 *      404s or 500s in production is a register the clerk cannot keep.
 *
 *   2. Every refusal comes back as a SENTENCE. The handler maps its
 *      constraints to clerk-readable text, and the failure mode of that map
 *      is silent: add a constraint without adding its message and the clerk
 *      sees `rejected` or a Postgres constraint name on the screen. So each
 *      check here asserts the shape of the message, not merely the status.
 *
 * Every row it writes is voided before it exits. Voided rows STAY — that is
 * the point of a register with no delete — so running this leaves struck
 * through entries behind by design.
 *
 *   node test-planning-clerk-release.js
 *   API=… CLERK_EMAIL=… CLERK_PASSWORD=… node test-planning-clerk-release.js
 */

const API = process.env.API || 'http://localhost:3000/api'
const EMAIL = process.env.CLERK_EMAIL || 'demo.clerk@vungu.test'
const PASSWORD = process.env.CLERK_PASSWORD || process.env.DEMO_DEFAULT_PASSWORD || 'demo1234'

let cookie = ''
let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function call(method, path, body) {
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
  try { json = JSON.parse(text) } catch { /* CSV */ }
  return { status: res.status, json, text, headers: res.headers }
}

/**
 * Is this something a clerk can read and act on?
 *
 * A sentence, not a code: several words, ending in a full stop, and not the
 * snake_case name of a database constraint leaking through.
 */
function isClerkReadable(message) {
  if (typeof message !== 'string' || !message.trim()) return false
  const words = message.trim().split(/\s+/)
  if (words.length < 4) return false
  if (!/[.!]$/.test(message.trim())) return false
  // `clerk_dispatch_posted_is_tracked` must never reach a screen.
  if (/\b[a-z]+(_[a-z]+){2,}\b/.test(message)) return false
  return true
}

const stamp = Date.now().toString(36).toUpperCase()
const written = []   // [register, id]

function track(register, res) {
  if (res?.json?.data?.id) written.push([register, res.json.data.id])
  return res
}

async function main() {
  console.log(`\nPlanning Clerk — RELEASE verification → ${API}\n`)

  const login = await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD })
  check('clerk signs in', login.status === 200, `status ${login.status}`)
  if (login.status !== 200) {
    console.log('\n  Cannot continue. Seed: node scripts/seed-all-demo.js\n')
    process.exit(1)
  }

  // ═══════════════════════════════════════════════════════════════════
  // A. The four cross-register endpoints
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n-- cross-register endpoints --')

  const overview = await call('GET', '/planning-clerk/overview')
  check('overview responds', overview.status === 200, `status ${overview.status}`)
  const o = overview.json?.data
  check('overview reports all eight groups',
    o && ['permits', 'acknowledgements', 'refusals', 'movements', 'fees',
      'correspondence', 'inspections', 'certificates'].every((k) => k in o),
    Object.keys(o || {}).join(','))
  check('overview keeps the two currencies apart',
    o && 'today_usd' in o.fees && 'today_zwg' in o.fees
      && !('today_total' in o.fees))

  const deadlines = await call('GET', '/planning-clerk/deadlines?days=90')
  check('deadlines responds', deadlines.status === 200, `status ${deadlines.status}`)
  check('deadlines computes days_left server-side',
    (deadlines.json?.data || []).every((d) => typeof d.days_left === 'number'))

  const search = await call('GET', '/planning-clerk/search?q=TPD')
  check('search responds', search.status === 200, `status ${search.status}`)

  // A file that has NO live acknowledgement and NO open file movement.
  // Those two registers allow one live entry per file, so reusing a file
  // another run (or a clerk) already acknowledged would fail this suite for
  // the right reason and look like a defect. The test finds a clean file
  // rather than voiding somebody's live entry to make room for its own —
  // a verification run must never destroy a register entry it did not write.
  let permitId = null
  for (const hit of (search.json?.data || []).slice(0, 12)) {
    const f = await call('GET', `/planning-clerk/file/${hit.id}`)
    const regs = f.json?.data?.registers
    if (!regs) continue
    const liveAck = (regs.acknowledgements || []).some((r) => !r.voided_at)
    const openMove = (regs.movements || []).some((r) => !r.returned_at && !r.voided_at)
    if (!liveAck && !openMove) { permitId = hit.id; break }
  }
  check('a file with no live acknowledgement is available to test against',
    !!permitId,
    'every candidate file already has one — void it, or seed a fresh application')
  check('search answers "where is the paper file" without a second call',
    (search.json?.data || []).every((r) => 'file_held_by' in r))
  check('search does not leak the applicant’s identity number or phone',
    (search.json?.data || []).every(
      (r) => !('applicant_id_number' in r) && !('applicant_phone' in r)),
    'a public-facing counter lookup must not carry these')

  if (permitId) {
    const file = await call('GET', `/planning-clerk/file/${permitId}`)
    check('file lookup returns all nine registers',
      Object.keys(file.json?.data?.registers || {}).length === 9,
      `${Object.keys(file.json?.data?.registers || {}).length}`)
  }

  // ═══════════════════════════════════════════════════════════════════
  // B. Every register accepts a valid entry
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n-- all nine registers accept a valid entry --')

  const iso = new Date().toISOString()
  const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString()
  const day = (n) => plusDays(n).slice(0, 10)

  const valid = {
    correspondence: {
      direction: 'in', ref_no: `REL-${stamp}`, party: 'Release Check',
      subject: 'Release verification entry', channel: 'letter',
      permit_application_id: permitId,
    },
    receipts: {
      receipt_no: `REL-RCT-${stamp}`, fee_kind: 'search', payer_name: 'Release Check',
      amount: 12.5, currency: 'USD', payment_method: 'cash',
      permit_application_id: permitId,
    },
    acknowledgements: {
      letter_no: `REL-ACK-${stamp}`, permit_application_id: permitId,
      received_at: iso, due_by: plusDays(5), determination_due_by: plusDays(90),
      recipient: 'Release Check',
    },
    dispatches: {
      permit_application_id: permitId, delivery_method: 'collected',
      recipient: 'Release Check', proof_of_delivery_ref: `REL-POD-${stamp}`,
    },
    refusals: {
      letter_no: `REL-REF-${stamp}`, permit_application_id: permitId,
      council_resolution_date: iso, due_by: plusDays(7),
      recipient: 'Release Check', reasons: 'Release verification entry.',
    },
    certificates: {
      permit_application_id: permitId, newspaper_name: 'Release Gazette',
      advert_date: day(0), objection_closes_on: day(30),
      filed_under_ref: `REL-CERT-${stamp}`,
    },
    abutters: {
      permit_application_id: permitId, abutter_name: 'Release Neighbour',
      abutter_address: '1 Release Road', method: 'hand_delivered',
    },
    movements: {
      permit_application_id: permitId, holder_name: 'Release Officer',
      destination: 'planner', purpose: 'Release verification',
      due_back_on: day(14),
    },
    inspections: {
      subject_description: 'Release verification', requester_name: 'Release Check',
      requester_capacity: 'conveyancer', request_kind: 'inspection',
      permit_application_id: permitId,
    },
  }

  for (const [register, body] of Object.entries(valid)) {
    const res = track(register, await call('POST', `/planning-clerk/registers/${register}`, body))
    check(`${register}: accepts a valid entry`, res.status === 201,
      `status ${res.status} ${res.json?.message || JSON.stringify(res.json?.fields || {})}`)
    check(`${register}: stamps the officer who wrote it`,
      !!Object.entries(res.json?.data || {}).find(
        ([k, v]) => k.endsWith('_by_name') && !!v))
    const list = await call('GET', `/planning-clerk/registers/${register}?limit=5`)
    check(`${register}: lists`, list.status === 200 && Array.isArray(list.json?.data))
    const csv = await call('GET', `/planning-clerk/registers/${register}/export`)
    check(`${register}: exports CSV`,
      csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type') || ''))
  }

  // ═══════════════════════════════════════════════════════════════════
  // C. Refusals, and whether a clerk could act on what they are told
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n-- refusals are sentences, not codes --')

  async function refusal(label, register, body, matcher) {
    const res = await call('POST', `/planning-clerk/registers/${register}`, body)
    const msg = res.json?.message
      || Object.entries(res.json?.fields || {}).map(([k, v]) => `${k} ${v}`).join('; ')
    check(`${label}: refused`, res.status === 400 || res.status === 409,
      `status ${res.status}`)
    if (matcher) {
      check(`${label}: names the actual problem`, matcher.test(msg || ''),
        `got "${msg}"`)
    }
    return { res, msg }
  }

  // duplicate receipt number
  {
    const { msg } = await refusal('duplicate receipt number', 'receipts',
      valid.receipts, /already in the cashbook/i)
    check('duplicate receipt number: message is clerk-readable',
      isClerkReadable(msg), `got "${msg}"`)
  }

  // duplicate letter number
  {
    const { msg } = await refusal('duplicate letter number', 'refusals',
      { ...valid.refusals, permit_application_id: permitId },
      /already in the register/i)
    check('duplicate letter number: message is clerk-readable',
      isClerkReadable(msg), `got "${msg}"`)
  }

  // duplicate submission — one live acknowledgement per file
  {
    const { msg } = await refusal('duplicate acknowledgement for one file',
      'acknowledgements',
      { ...valid.acknowledgements, letter_no: `REL-ACK2-${stamp}` },
      /already has an acknowledgement|Void the existing/i)
    check('duplicate submission: message says what to do instead',
      /void/i.test(msg || ''), `got "${msg}"`)
  }

  // duplicate submission — one open file movement
  {
    const { msg } = await refusal('file signed out twice', 'movements',
      { ...valid.movements, holder_name: 'Second Officer' },
      /already signed out|has not come back/i)
    check('file signed out twice: message is clerk-readable',
      isClerkReadable(msg), `got "${msg}"`)
  }

  // missing tracking number
  {
    const { msg } = await refusal('permit posted with no tracking number', 'dispatches',
      { permit_application_id: permitId, delivery_method: 'registered_post',
        recipient: 'Release Check' },
      /tracking number/i)
    check('missing tracking number: message is clerk-readable',
      isClerkReadable(msg), `got "${msg}"`)
  }
  await refusal('neighbour notice posted with no receipt reference', 'abutters',
    { ...valid.abutters, method: 'registered_post', abutter_name: 'B' },
    /delivery receipt/i)

  // missing reconciliation reference
  await refusal('EFT receipt with no reference', 'receipts',
    { ...valid.receipts, receipt_no: `REL-EFT-${stamp}`, payment_method: 'eft' },
    /reconcil/i)

  // invalid currency
  {
    const { msg } = await refusal('currency outside USD/ZWG', 'receipts',
      { ...valid.receipts, receipt_no: `REL-CCY-${stamp}`, currency: 'ZWL' },
      /currency|USD|ZWG/i)
    check('invalid currency: names the currencies that are allowed',
      /USD/.test(msg || '') && /ZWG/.test(msg || ''), `got "${msg}"`)
  }

  // invalid file location (destination enum)
  {
    const { msg } = await refusal('file sent to a place that is not on the list',
      'movements',
      { ...valid.movements, destination: 'the_pub', holder_name: 'C' },
      /destination|one of/i)
    check('invalid destination: lists the places a file may go',
      /planner/.test(msg || '') && /registry/.test(msg || ''), `got "${msg}"`)
  }

  // missing rejection/correction reason — the void path
  if (written.length) {
    const [reg, id] = written[0]
    const noReason = await call('POST',
      `/planning-clerk/registers/${reg}/${id}/void`, { reason: '   ' })
    check('void with no reason: refused', noReason.status === 400)
    const msg = noReason.json?.fields?.reason
    check('void with no reason: explains why a reason is required',
      /reason/i.test(msg || '') && /register/i.test(msg || ''), `got "${msg}"`)
  }

  // a field the register does not have
  {
    const res = await call('POST', '/planning-clerk/registers/correspondence',
      { ...valid.correspondence, ref_no: `REL-X-${stamp}`, amount_zwl: 40 })
    check('a field the register does not have: refused, not silently dropped',
      res.status === 400 && !!res.json?.fields?.amount_zwl)
  }

  // an unknown register
  {
    const res = await call('GET', '/planning-clerk/registers/cashbook')
    check('unknown register: 404 that names the real registers',
      res.status === 404 && /correspondence/.test(res.json?.message || ''))
  }

  // ═══════════════════════════════════════════════════════════════════
  // D. There is still no DELETE
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n-- no delete --')
  for (const [register, id] of written.slice(0, 3)) {
    const res = await call('DELETE', `/planning-clerk/registers/${register}/${id}`)
    check(`DELETE /${register}/:id is not a route`,
      res.status === 404 || res.status === 405, `status ${res.status}`)
  }

  // ═══════════════════════════════════════════════════════════════════
  // E. Teardown — void, because there is nothing else
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n-- teardown --')
  let voided = 0
  for (const [register, id] of written) {
    const res = await call('POST', `/planning-clerk/registers/${register}/${id}/void`,
      { reason: 'Release verification entry' })
    if (res.status === 200) voided++
    else console.log(`  note: ${register}/${id} not voided (status ${res.status})`)
  }
  check(`every written entry voided (${voided}/${written.length})`,
    voided === written.length)

  console.log(`\n  ${passed} passed, ${failed} failed`)
  if (failures.length) console.log(`  failing: ${failures.join(' | ')}`)
  console.log()
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nRelease verification crashed:', err.message, '\n')
  process.exit(1)
})
