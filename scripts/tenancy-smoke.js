#!/usr/bin/env node
/**
 * Run the same battery of GET requests as each kind of user, and compare two runs. It is how to find out what changing the
 * tenancy mode (TENANCY_MODE=off|warn|strict, src/lib/dbContext.js) would change, before changing it.
 *
 *   node scripts/tenancy-smoke.js --out run-off.json                 against the running server (default http://127.0.0.1:3000)
 *   node scripts/tenancy-smoke.js --compare run-off.json run-strict.json
 *
 * It signs in as the DEMO users (scripts/seed-demo-users.js: local development accounts only) and as the public, requests every
 * static GET route it can find in the route files, and records for each (who, path) the status and, where the answer is a list,
 * how many rows. A difference between two runs is a route whose behaviour the mode changed: a 500 or 403 is breakage; a smaller
 * count may be correct (an authority now sees only its own rows) and is for a person to judge. Reads only; it does not try to
 * change anything.
 */
const fs = require('node:fs')
const path = require('node:path')
const axios = require('axios')

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3000'
const USERS = ['planner', 'admin', 'eo', 'clerk', 'inspector', 'gis', 'envoffice', 'surveyor', 'viewer'].map((r) => ({ who: r, email: `demo.${r}@vungu.test` }))
const SKIP = /(stream|events|live|sse|export|pdf|download|file|photo|logout|refresh|mfa|reset|verify|callback|webhook|tiles|metrics|docs|swagger|screenshot|print|report-builder)/i

function staticGetPaths() {
  const found = new Set()
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (!/(__tests__|attic)/.test(e.name)) walk(p); continue }
      if (!/\.js$/.test(e.name) || /\.test\./.test(e.name)) continue
      const text = fs.readFileSync(p, 'utf8')
      for (const m of text.matchAll(/(?:fastify|server|scope)\.get\(\s*'(\/[^':*]*)'/g)) found.add(m[1])
    }
  }
  walk(path.join(__dirname, '..', 'src', 'routes'))
  return [...found].filter((p) => !SKIP.test(p)).map((p) => (p.startsWith('/api') ? p : '/api' + p)).sort()
}

const signature = (res) => {
  const d = res.data
  let n = null
  if (d && typeof d === 'object') {
    if (Array.isArray(d)) n = d.length
    else if (Array.isArray(d.data)) n = d.data.length
    else if (typeof d.count === 'number') n = d.count
    else if (d.data && typeof d.data === 'object') n = Object.keys(d.data).length
  }
  return `${res.status}${n === null ? '' : ':' + n}`
}

async function run(out) {
  const paths = staticGetPaths()
  console.log(`${paths.length} routes, ${USERS.length + 1} identities, against ${BASE}`)
  const identities = [{ who: 'public', headers: {} }]
  for (const u of USERS) {
    const r = await axios.post(`${BASE}/api/auth/login`, { email: u.email, password: 'demo1234' }, { validateStatus: () => true })
    const token = r.data && r.data.data && r.data.data.token
    if (token) identities.push({ who: u.who, headers: { Authorization: `Bearer ${token}` } })
    else console.log(`  (could not sign in as ${u.who}: ${r.status})`)
  }
  const result = {}
  for (const id of identities) {
    for (const p of paths) {
      try {
        const res = await axios.get(BASE + p, { headers: id.headers, validateStatus: () => true, timeout: 20000 })
        result[`${id.who} ${p}`] = signature(res)
      } catch (err) { result[`${id.who} ${p}`] = 'error:' + (err.code || err.message).slice(0, 20) }
      await new Promise((r) => setTimeout(r, 40))
    }
    console.log(`  ${id.who}: done`)
  }
  fs.writeFileSync(out, JSON.stringify(result, null, 1))
  const by = {}
  for (const v of Object.values(result)) { const s = String(v).split(':')[0]; by[s] = (by[s] || 0) + 1 }
  console.log('statuses:', JSON.stringify(by))
}

function compare(a, b) {
  const A = JSON.parse(fs.readFileSync(a, 'utf8')), B = JSON.parse(fs.readFileSync(b, 'utf8'))
  const worse = [], fewer = [], other = []
  for (const k of Object.keys(A)) {
    if (!(k in B) || A[k] === B[k]) continue
    const [sa, na] = String(A[k]).split(':'), [sb, nb] = String(B[k]).split(':')
    if (sa !== sb) (Number(sb) >= 500 || Number(sb) === 403 || sb.startsWith('error') ? worse : other).push(`${k}   ${A[k]} -> ${B[k]}`)
    else if (na !== undefined && nb !== undefined && Number(nb) < Number(na)) fewer.push(`${k}   ${A[k]} -> ${B[k]}`)
    else other.push(`${k}   ${A[k]} -> ${B[k]}`)
  }
  console.log(`${Object.keys(A).length} requests compared.`)
  console.log(`\nBREAKAGE (now an error or refused): ${worse.length}`); worse.forEach((l) => console.log('  ' + l))
  console.log(`\nFEWER ROWS (may be correct: scoped to the person): ${fewer.length}`); fewer.forEach((l) => console.log('  ' + l))
  console.log(`\nOTHER DIFFERENCES: ${other.length}`); other.forEach((l) => console.log('  ' + l))
}

const argv = process.argv.slice(2)
if (argv[0] === '--compare') compare(argv[1], argv[2])
else if (argv[0] === '--out' && argv[1]) run(argv[1]).catch((e) => { console.error(e.message); process.exit(1) })
else { console.error('Usage: --out <file> | --compare <a.json> <b.json>'); process.exit(2) }
