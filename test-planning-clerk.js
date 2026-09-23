/**
 * Smoke test for the Planning Clerk registers API
 * (src/routes/planning-clerk.js, migration 125).
 *
 *   node test-planning-clerk.js                    # against localhost:3000
 *   API=https://… CLERK_EMAIL=… CLERK_PASSWORD=… node test-planning-clerk.js
 *
 * WHAT IT IS ACTUALLY TESTING
 * Nine registers go through one handler, and the value of that handler is
 * entirely in its rules. So the checks here are mostly refusals: that a
 * blank required field is refused, that a field the register does not have
 * is refused rather than silently dropped, that a receipt number cannot be
 * changed after the fact, that the constraints migration 125 declares come
 * back as sentences a clerk can read, and that there is no DELETE.
 *
 * Every row it writes is voided before it exits, and a void is visible — so
 * running this against a populated database leaves nine struck-through test
 * entries behind rather than nothing. That is the point of a register with
 * no delete, and it is stated here so nobody files it as a bug.
 */

const API = process.env.API || 'http://localhost:3000/api'
const EMAIL = process.env.CLERK_EMAIL || 'demo.clerk@vungu.test'
const PASSWORD = process.env.CLERK_PASSWORD || process.env.DEMO_DEFAULT_PASSWORD || 'demo1234'

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
  try { json = JSON.parse(text) } catch { /* CSV is not JSON */ }
  return { status: res.status, json, text, headers: res.headers }
}

const stamp = Date.now().toString(36).toUpperCase()
const written = []   // [register, id] — voided in the teardown

async function main() {
  console.log(`\nVungu Planning Clerk registers smoke test → ${API}\n`)

  // ── Sign in ───────────────────────────────────────────────────────────
  const login = await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD })
  check('clerk signs in', login.status === 200, `status ${login.status}`)
  if (login.status !== 200) {
    console.log('\n  Cannot continue without a session. Seed the demo accounts:')
    console.log('    node scripts/seed-all-demo.js\n')
    process.exit(1)
  }

  // ── The register catalogue ────────────────────────────────────────────
  const catalogue = await call('GET', '/planning-clerk/registers')
  check('register catalogue lists nine registers',
    catalogue.json?.data?.length === 9, `got ${catalogue.json?.data?.length}`)
  check('catalogue marks receipt_no as fixed',
    catalogue.json?.data?.find((r) => r.key === 'receipts')?.fields?.receipt_no?.fixed === true)

  // ── Overview, in one round trip ───────────────────────────────────────
  const overview = await call('GET', '/planning-clerk/overview')
  check('overview responds', overview.status === 200, `status ${overview.status}`)
  const o = overview.json?.data
  check('overview counts permits', o && typeof o.permits?.total !== 'undefined')
  check('overview counts outstanding acknowledgements',
    o && typeof o.acknowledgements?.outstanding !== 'undefined')
  check('overview separates the two currencies',
    o && 'today_usd' in (o.fees || {}) && 'today_zwg' in (o.fees || {}))
  check('overview carries today’s receipts as a list', Array.isArray(o?.received_today_list))

  // ── Deadlines ─────────────────────────────────────────────────────────
  const deadlines = await call('GET', '/planning-clerk/deadlines?days=60')
  check('deadlines responds', deadlines.status === 200, `status ${deadlines.status}`)
  check('deadlines are sorted soonest first', (() => {
    const ds = deadlines.json?.data || []
    return ds.every((d, i) => i === 0 || new Date(ds[i - 1].due_at) <= new Date(d.due_at))
  })())
  check('every deadline carries days_left and overdue',
    (deadlines.json?.data || []).every((d) => 'days_left' in d && 'overdue' in d))
  check('the horizon is clamped', (await call('GET', '/planning-clerk/deadlines?days=99999'))
    .json?.meta?.horizon_days === 180)

  // ── Counter search ────────────────────────────────────────────────────
  const short = await call('GET', '/planning-clerk/search?q=a')
  check('a one-character search is refused rather than run',
    short.json?.meta?.reason === 'too_short')
  const search = await call('GET', '/planning-clerk/search?q=TPD')
  check('search responds', search.status === 200, `status ${search.status}`)
  check('search results say where the physical file is',
    (search.json?.data || []).every((r) => 'file_held_by' in r))

  // A real permit to hang the register entries on.
  const permitId = (search.json?.data || [])[0]?.id || null
  check('a permit is available to file against', !!permitId,
    'seed with node scripts/seed-all-demo.js')

  // ── Validation: the refusals are the point ────────────────────────────
  const unknown = await call('GET', '/planning-clerk/registers/not_a_register')
  check('an unknown register is a 404 that names the real ones',
    unknown.status === 404 && /correspondence/.test(unknown.json?.message || ''))

  const blank = await call('POST', '/planning-clerk/registers/correspondence', {
    direction: 'in', ref_no: '   ', party: 'A', subject: 'B', channel: 'letter',
  })
  check('a blank required field is refused',
    blank.status === 400 && !!blank.json?.fields?.ref_no, `status ${blank.status}`)

  const badEnum = await call('POST', '/planning-clerk/registers/correspondence', {
    direction: 'sideways', ref_no: 'R', party: 'A', subject: 'B', channel: 'letter',
  })
  check('a value outside the enum is refused',
    badEnum.status === 400 && !!badEnum.json?.fields?.direction)

  const strayField = await call('POST', '/planning-clerk/registers/correspondence', {
    direction: 'in', ref_no: 'R', party: 'A', subject: 'B', channel: 'letter',
    amount_zwl: 40,
  })
  check('a field the register does not have is refused, not dropped',
    strayField.status === 400 && !!strayField.json?.fields?.amount_zwl)

  const missing = await call('POST', '/planning-clerk/registers/correspondence', {
    direction: 'in',
  })
  check('every missing required field is named at once',
    missing.status === 400 && Object.keys(missing.json?.fields || {}).length >= 4)

  // ── Constraint messages come back as sentences ────────────────────────
  const untrackedEft = await call('POST', '/planning-clerk/registers/receipts', {
    receipt_no: `TEST-EFT-${stamp}`, fee_kind: 'application', payer_name: 'Smoke Test',
    amount: 10, currency: 'USD', payment_method: 'eft',
  })
  check('an EFT receipt with no reference is refused as a sentence',
    untrackedEft.status === 409 && /reconcil/i.test(untrackedEft.json?.message || ''),
    `status ${untrackedEft.status} ${untrackedEft.json?.message || ''}`)

  if (permitId) {
    const untrackedPost = await call('POST', '/planning-clerk/registers/dispatches', {
      permit_application_id: permitId, delivery_method: 'registered_post',
      recipient: 'Smoke Test',
    })
    check('a posted permit with no tracking number is refused as a sentence',
      untrackedPost.status === 409 && /tracking number/i.test(untrackedPost.json?.message || ''),
      `status ${untrackedPost.status} ${untrackedPost.json?.message || ''}`)
  }

  const ghostPermit = await call('POST', '/planning-clerk/registers/dispatches', {
    permit_application_id: '00000000-0000-4000-8000-000000000000',
    delivery_method: 'collected', recipient: 'Smoke Test',
  })
  check('filing against a permit that is not on file is refused',
    ghostPermit.status === 409, `status ${ghostPermit.status}`)

  // ── A good write, and what may be done to it afterwards ───────────────
  const receipt = await call('POST', '/planning-clerk/registers/receipts', {
    receipt_no: `TEST-${stamp}`, fee_kind: 'search', payer_name: 'Smoke Test',
    amount: 5.555, currency: 'USD', payment_method: 'cash',
    ...(permitId ? { permit_application_id: permitId } : {}),
  })
  check('a valid receipt is written', receipt.status === 201, `status ${receipt.status}`)
  if (receipt.json?.data?.id) written.push(['receipts', receipt.json.data.id])

  check('money is rounded to the cent, not stored as given',
    Number(receipt.json?.data?.amount) === 5.56, `got ${receipt.json?.data?.amount}`)
  check('the register stamps who wrote the entry',
    !!receipt.json?.data?.issued_by_name && !!receipt.json?.data?.issued_by)

  const duplicate = await call('POST', '/planning-clerk/registers/receipts', {
    receipt_no: `TEST-${stamp}`, fee_kind: 'search', payer_name: 'Smoke Test',
    amount: 5, currency: 'USD', payment_method: 'cash',
  })
  check('a duplicate receipt number is refused as a sentence',
    duplicate.status === 409 && /already in the cashbook/i.test(duplicate.json?.message || ''),
    `status ${duplicate.status}`)

  const renumber = await call('PATCH',
    `/planning-clerk/registers/receipts/${receipt.json?.data?.id}`,
    { receipt_no: `TEST-RENUMBERED-${stamp}` })
  check('a receipt cannot be renumbered after the fact',
    renumber.status === 400 && !!renumber.json?.fields?.receipt_no,
    `status ${renumber.status}`)

  const correct = await call('PATCH',
    `/planning-clerk/registers/receipts/${receipt.json?.data?.id}`,
    { payer_name: 'Smoke Test (corrected)' })
  check('a correctable field is corrected',
    correct.status === 200 && correct.json?.data?.payer_name === 'Smoke Test (corrected)')

  const empty = await call('PATCH',
    `/planning-clerk/registers/receipts/${receipt.json?.data?.id}`, {})
  check('a patch that changes nothing is refused', empty.status === 400)

  // ── There is no DELETE ────────────────────────────────────────────────
  const del = await call('DELETE', `/planning-clerk/registers/receipts/${receipt.json?.data?.id}`)
  check('DELETE is not a route on a register', del.status === 404 || del.status === 405,
    `status ${del.status}`)

  const unreasoned = await call('POST',
    `/planning-clerk/registers/receipts/${receipt.json?.data?.id}/void`, { reason: '  ' })
  check('a void with no reason is refused',
    unreasoned.status === 400 && !!unreasoned.json?.fields?.reason)

  // ── Listing, filtering and export ─────────────────────────────────────
  const list = await call('GET', '/planning-clerk/registers/receipts?limit=5')
  check('a register lists', list.status === 200 && Array.isArray(list.json?.data))
  check('a listed row carries the file it belongs to',
    (list.json?.data || []).every((r) => 'tpd_reference' in r))
  check('the list reports a total for paging', typeof list.json?.meta?.total === 'number')

  const searched = await call('GET',
    `/planning-clerk/registers/receipts?q=${encodeURIComponent(`TEST-${stamp}`)}`)
  check('a register search finds the entry just written',
    (searched.json?.data || []).some((r) => r.receipt_no === `TEST-${stamp}`))

  const injected = await call('GET',
    "/planning-clerk/registers/receipts?q=%27%3B+DROP+TABLE+spatial_planning.clerk_fee_receipt%3B--")
  check('a search term that is SQL is treated as a search term',
    injected.status === 200, `status ${injected.status}`)
  check('the table it tried to drop is still there',
    (await call('GET', '/planning-clerk/registers/receipts?limit=1')).status === 200)

  const capped = await call('GET', '/planning-clerk/registers/receipts?limit=99999')
  check('the page size is capped by the server', capped.json?.meta?.limit === 500,
    `got ${capped.json?.meta?.limit}`)

  const csv = await call('GET', '/planning-clerk/registers/receipts/export')
  check('a register exports as CSV',
    csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type') || ''))
  check('the CSV is named for the register and the day',
    /filename="receipts-\d{4}-\d{2}-\d{2}\.csv"/.test(csv.headers.get('content-disposition') || ''))

  // ── One file, all nine registers ──────────────────────────────────────
  if (permitId) {
    const file = await call('GET', `/planning-clerk/file/${permitId}`)
    check('a file opens with every register on it',
      file.status === 200 && Object.keys(file.json?.data?.registers || {}).length === 9,
      `got ${Object.keys(file.json?.data?.registers || {}).length}`)
    check('the file carries the permit itself', !!file.json?.data?.permit?.id)
    check('the receipt just written is on the file',
      (file.json?.data?.registers?.receipts || []).some((r) => r.receipt_no === `TEST-${stamp}`))
  }
  const badFile = await call('GET', '/planning-clerk/file/not-a-uuid')
  check('a malformed file id is a 400, not a database error', badFile.status === 400)

  // ── Teardown: void, because there is nothing else ─────────────────────
  for (const [register, id] of written) {
    const voided = await call('POST', `/planning-clerk/registers/${register}/${id}/void`,
      { reason: 'Smoke test entry' })
    check(`teardown voids the ${register} entry`, voided.status === 200,
      `status ${voided.status}`)
    check('a voided entry names who voided it and why',
      /Smoke test entry — voided by /.test(voided.json?.data?.voided_reason || ''))
    const gone = await call('GET', `/planning-clerk/registers/${register}?limit=500`)
    check('a voided entry leaves the default listing',
      !(gone.json?.data || []).some((r) => r.id === id))
    const still = await call('GET', `/planning-clerk/registers/${register}?include_voided=true&limit=500`)
    check('a voided entry is still in the register when asked for',
      (still.json?.data || []).some((r) => r.id === id))
    const recorrect = await call('PATCH', `/planning-clerk/registers/${register}/${id}`,
      { payer_name: 'after the void' })
    check('a voided entry cannot be corrected back into life', recorrect.status === 404)
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err.message, '\n')
  process.exit(1)
})
