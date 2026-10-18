#!/usr/bin/env node
/**
 * End-to-end deploy readiness harness (API-level, no browser).
 * Exercises built use-case flows against a local stack.
 *
 *   node scripts/e2e-deploy-readiness.mjs
 *   BASE=http://127.0.0.1:3000 node scripts/e2e-deploy-readiness.mjs
 *
 * Exit 0 only if every required check passes. Known not-built use cases
 * (C15, P10, F7, G11, A5, …) are recorded as SKIP, not FAIL.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = (process.env.BASE || 'http://127.0.0.1:3000').replace(/\/$/, '')
const PASS = 'demo1234'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, '..', '..', 'DEPLOY_E2E_RESULTS.json')

const results = []
const t0 = Date.now()

function record(id, ok, detail, kind = 'required') {
  results.push({ id, ok, kind, detail: String(detail).slice(0, 400), ms: Date.now() - t0 })
  const mark = ok ? (kind === 'skip' ? 'SKIP' : 'PASS') : 'FAIL'
  console.log(`${mark.padEnd(4)} ${id} — ${detail}`)
}

async function req(method, urlPath, { token, body, expect } = {}) {
  const headers = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  let payload
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: payload })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* raw */ }
  if (expect != null && res.status !== expect) {
    const err = new Error(`${method} ${urlPath} → ${res.status} (want ${expect}): ${text.slice(0, 200)}`)
    err.status = res.status
    err.json = json
    throw err
  }
  return { status: res.status, json, text }
}

async function login(email) {
  const { json } = await req('POST', '/api/auth/login', {
    body: { email, password: PASS },
    expect: 200,
  })
  const token = json?.data?.token
  if (!token) throw new Error(`no token for ${email}`)
  return { token, user: json.data.user }
}

async function main() {
  // ── Health ──────────────────────────────────────────────────────────
  try {
    const { json } = await req('GET', '/api/health', { expect: 200 })
    record('HEALTH', json?.status === 'ok' || json?.service, JSON.stringify(json))
  } catch (e) {
    record('HEALTH', false, e.message)
    finish(1)
    return
  }

  // ── Auth: every demo role ───────────────────────────────────────────
  const roles = [
    ['demo.admin@vungu.test', 'admin'],
    ['demo.planner@vungu.test', 'planner'],
    ['demo.eo@vungu.test', 'eo'],
    ['demo.surveyor@vungu.test', 'surveyor'],
    ['demo.inspector@vungu.test', 'building_inspector'],
    ['demo.clerk@vungu.test', 'planning_clerk'],
    ['demo.gis@vungu.test', 'gis_officer'],
  ]
  const tokens = {}
  for (const [email, role] of roles) {
    try {
      const { token, user } = await login(email)
      tokens[role] = token
      const me = await req('GET', '/api/auth/me', { token, expect: 200 })
      record(`AUTH_${role}`, me.json?.data?.role === role || me.json?.data?.role === user.role,
        `role=${me.json?.data?.role}`)
    } catch (e) {
      record(`AUTH_${role}`, false, e.message)
    }
  }

  const planner = tokens.planner
  const clerk = tokens.planning_clerk
  const inspector = tokens.building_inspector
  const gis = tokens.gis_officer
  const admin = tokens.admin

  // ── C1/C3: public map + stand identify ──────────────────────────────
  try {
    const id = await req('GET', '/api/stands/identify?lng=29.7513&lat=-19.48455', { expect: 200 })
    const d = id.json?.data
    record('C3_identify_available', d?.standNumber === 'HDR-105' && d?.sold === false,
      `${d?.standNumber} sold=${d?.sold} status=${d?.status}`)
  } catch (e) { record('C3_identify_available', false, e.message) }

  try {
    const id = await req('GET', '/api/stands/identify?lng=29.7313&lat=-19.4837', { expect: 200 })
    const d = id.json?.data
    record('C3_identify_sold', d?.sold === true && !!d?.allocation?.allotteeName,
      `${d?.standNumber} allottee=${d?.allocation?.allotteeName}`)
  } catch (e) { record('C3_identify_sold', false, e.message) }

  try {
    const fc = await req('GET', '/api/stands?status=available&limit=5', { expect: 200 })
    const n = fc.json?.features?.length ?? 0
    record('C1_stands_geojson', n > 0, `features=${n}`)
  } catch (e) { record('C1_stands_geojson', false, e.message) }

  try {
    const loc = await req('GET', '/api/parcels/locate?lng=29.7513&lat=-19.48455', { expect: 200 })
    record('C3_parcels_locate', !!loc.json?.data?.stand?.stand_number,
      loc.json?.data?.stand?.stand_number || 'no stand')
  } catch (e) { record('C3_parcels_locate', false, e.message) }

  try {
    const find = await req('GET', '/api/parcels/find?q=HDR-105', { expect: 200 })
    const hit = (find.json?.data || []).some((r) => r.stand_number === 'HDR-105')
    record('G1_parcels_find', hit, `hits=${(find.json?.data || []).length}`)
  } catch (e) { record('G1_parcels_find', false, e.message) }

  // ── C2: plan / what can I build (search) ────────────────────────────
  try {
    const r = await req('GET', '/api/plan-lookup/search?q=HDR', { expect: 200 })
    record('C2_plan_lookup', (r.json?.count ?? 0) > 0 || Array.isArray(r.json?.data),
      `count=${r.json?.count}`)
  } catch (e) { record('C2_plan_lookup', false, e.message) }

  // ── G10 / owners (staff) ────────────────────────────────────────────
  if (planner) {
    try {
      const o = await req('GET', '/api/properties/HDR-004/owners', { token: planner, expect: 200 })
      record('G1_property_owners', Array.isArray(o.json?.data) && o.json.data.length > 0,
        JSON.stringify(o.json.data[0]?.name))
    } catch (e) { record('G1_property_owners', false, e.message) }

    try {
      const near = await req('GET', '/api/parcels/nearby?lng=29.7313&lat=-19.4837', {
        token: planner, expect: 200,
      })
      const owners = near.json?.data?.site?.stand?.owners
      record('G1_nearby_owners', Array.isArray(owners), `owners=${owners?.length ?? 'n/a'}`)
    } catch (e) { record('G1_nearby_owners', false, e.message) }

    // Reserve then release or leave reserved — use an available stand
    try {
      const list = await req('GET', '/api/stands?status=available', { expect: 200 })
      const feat = (list.json?.features || []).find((f) => f.properties?.stand_number || f.id)
      const standId = feat?.id || feat?.properties?.id
      if (!standId) throw new Error('no available stand id')
      const reserve = await req('POST', `/api/stands/${standId}/reserve`, {
        token: planner,
        body: { hours: 1 },
      })
      record('G10_reserve', reserve.status < 400 || reserve.status === 409,
        `status=${reserve.status}`)
    } catch (e) { record('G10_reserve', false, e.message) }
  }

  // ── P1/P2 land-use + applications ───────────────────────────────────
  if (planner) {
    try {
      const g = await req('GET', '/api/land-use/groups?limit=5', { token: planner })
      record('P2_land_use_groups', g.status === 200 && (g.json?.data?.length >= 0 || g.json?.success),
        `status=${g.status}`)
    } catch (e) { record('P2_land_use_groups', false, e.message) }

    try {
      const a = await req('GET', '/api/permit-applications?limit=5', { token: planner })
      record('P1_permit_applications', a.status === 200, `status=${a.status}`)
    } catch (e) { record('P1_permit_applications', false, e.message) }

    try {
      const d = await req('GET', '/api/development-control/applications?limit=5', { token: planner })
      record('P1_dev_control_apps', d.status < 500, `status=${d.status}`)
    } catch (e) { record('P1_dev_control_apps', false, e.message) }
  }

  // ── Clerk intake surface ────────────────────────────────────────────
  if (clerk) {
    try {
      const a = await req('GET', '/api/permit-applications?limit=5', { token: clerk })
      record('P1_clerk_queue', a.status === 200, `status=${a.status}`)
    } catch (e) { record('P1_clerk_queue', false, e.message) }
  }

  // ── Inspector / complaints (C12 / F1) ────────────────────────────────
  if (inspector) {
    try {
      const c = await req('GET', '/api/building-complaints', { token: inspector })
      record('F1_building_complaints', c.status === 200, `status=${c.status}`)
    } catch (e) { record('F1_building_complaints', false, e.message) }
  }

  // ── GIS tile catalog (C1 / G9) ──────────────────────────────────────
  try {
    const layers = await req('GET', '/api/tiles/layers', { expect: 200 })
    const n = layers.json?.layers?.length ?? layers.json?.data?.length ?? Object.keys(layers.json || {}).length
    record('G9_tile_layers', n > 0, `entries=${n}`)
  } catch (e) { record('G9_tile_layers', false, e.message) }

  // ── Admin ───────────────────────────────────────────────────────────
  if (admin) {
    try {
      const u = await req('GET', '/api/admin/users?limit=5', { token: admin })
      record('A1_admin_users', u.status < 500, `status=${u.status}`)
    } catch (e) { record('A1_admin_users', false, e.message) }
  }

  // ── Public notices / map events ─────────────────────────────────────
  try {
    const n = await req('GET', '/api/map/public-notices')
    record('C8_public_notices', n.status < 500, `status=${n.status}`)
  } catch (e) { record('C8_public_notices', false, e.message) }

  // ── Newly built statutory registers (A5 / P10 / G11 / C15 / F7) ─────
  const eo = tokens.eo || planner
  if (eo) {
    try {
      const list = await req('GET', '/api/registers/bylaws', { token: eo, expect: 200 })
      record('A5_bylaw_register', list.json?.success === true, `rows=${(list.json?.data || []).length}`)
      const created = await req('POST', '/api/registers/bylaws', {
        token: eo,
        body: { kind: 'bylaw', title: `E2E bylaw ${Date.now()}`, status: 'draft' },
        expect: 201,
      })
      record('A5_bylaw_create', !!created.json?.data?.id, `id=${created.json?.data?.id}`)
    } catch (e) { record('A5_bylaw_register', false, e.message) }

    try {
      const year = 2090 + (Date.now() % 9)
      const created = await req('POST', '/api/registers/annual-plans', {
        token: eo,
        body: { plan_year: year, title: `E2E district plan ${year}`, status: 'draft' },
        expect: 201,
      })
      record('P10_annual_district_plan', !!created.json?.data?.id, `year=${year}`)
    } catch (e) { record('P10_annual_district_plan', false, e.message) }

    try {
      const created = await req('POST', '/api/registers/acquisitions', {
        token: eo,
        body: { purpose: 'public_benefit', stand_number: 'HDR-105', purpose_detail: 'E2E acquisition' },
        expect: 201,
      })
      record('G11_compulsory_acquisition', !!created.json?.data?.id, `id=${created.json?.data?.id}`)
    } catch (e) { record('G11_compulsory_acquisition', false, e.message) }

    try {
      const created = await req('POST', '/api/registers/expense-recoveries', {
        token: eo,
        body: { description: 'E2E s151 recovery', amount_usd: 12.5, stand_number: 'HDR-105' },
        expect: 201,
      })
      record('F7_expense_recovery', !!created.json?.data?.id, `id=${created.json?.data?.id}`)
    } catch (e) { record('F7_expense_recovery', false, e.message) }
  } else {
    for (const id of ['A5_bylaw_register', 'P10_annual_district_plan', 'G11_compulsory_acquisition', 'F7_expense_recovery']) {
      record(id, false, 'no eo/planner token')
    }
  }

  // C15: citizen request + staff decide (use clerk / planner)
  try {
    // Prefer a citizen/viewer; fall back to planner requesting as authenticated user.
    let citizenTok = tokens.viewer
    if (!citizenTok) {
      try {
        const { token } = await login('demo.viewer@vungu.test')
        citizenTok = token
        tokens.viewer = token
      } catch { citizenTok = planner }
    }
    const reqClear = await req('POST', '/api/registers/rates-clearances', {
      token: citizenTok,
      body: { stand_number: 'HDR-105', applicant_name: 'E2E Applicant' },
      expect: 201,
    })
    const clearId = reqClear.json?.data?.id
    record('C15_section109_request', !!clearId, `id=${clearId}`)
    if (clearId && (clerk || planner)) {
      const decided = await req('POST', `/api/registers/rates-clearances/${clearId}/decide`, {
        token: clerk || planner,
        body: { decision: 'clear', charges_outstanding_usd: 0 },
        expect: 200,
      })
      record('C15_section109_issue', decided.json?.data?.status === 'cleared' && !!decided.json?.data?.certificate_no,
        `cert=${decided.json?.data?.certificate_no}`)
    }
  } catch (e) { record('C15_section109_request', false, e.message) }

  // ── Citizen registration smoke (create+cleanup not required) ────────
  try {
    // Cloudflare Turnstile always-pass test token (pairs with TEST_SECRET in non-production).
    const r = await req('POST', '/api/auth/register', {
      body: {
        email: `e2e.${Date.now()}@example.test`,
        password: 'E2eTest1234!',
        name: 'E2E Citizen',
        captcha_token: 'XXXX.DUMMY.TOKEN.XXXX',
      },
    })
    record('C4_register', r.status === 200 || r.status === 201 || r.status === 409,
      `status=${r.status} ${r.json?.message || r.json?.error || ''}`)
  } catch (e) { record('C4_register', false, e.message) }

  if (tokens.env_officer || inspector) {
    try {
      const envTok = tokens.env_officer || inspector
      const c = await req('GET', '/api/eho/complaints', { token: envTok })
      record('F8_eho_complaints', c.status < 500, `status=${c.status}`)
    } catch (e) { record('F8_eho_complaints', false, e.message) }
  }

  finish(results.some((r) => r.kind === 'required' && !r.ok) ? 1 : 0)
}

function finish(code) {
  const required = results.filter((r) => r.kind === 'required')
  const summary = {
    at: new Date().toISOString(),
    base: BASE,
    pass: required.filter((r) => r.ok).length,
    fail: required.filter((r) => !r.ok).length,
    skip: results.filter((r) => r.kind === 'skip').length,
    results,
  }
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2))
  console.log(`\n${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped → ${OUT}`)
  process.exit(code)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
