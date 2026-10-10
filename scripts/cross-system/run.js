/**
 * Cross-system checks: VunGIS and SurveyPro, running together, on a scratch database.
 *
 *   SURVEYPRO_REPO=C:/surveypro-oct-beta/_beta-vungis-wt \
 *   SURVEYPRO_SCHEMA_ENV=C:/surveypro-oct-beta/surveypro/app-backend/.env \
 *   node scripts/cross-system/run.js [launch] [class] [deliver] [shared] [cutover] [check]      (no names = all)
 *
 * What it does, for each scenario: builds a throw-away SurveyPro database (surveypro_scratch_xs) on the same Postgres server as VunGIS, starts
 * a real SurveyPro server on it, drives both systems through their APIs, and tears everything down, including the cluster-wide roles
 * the migrations create. Every scenario starts from a fresh database, so they cannot depend on each other.
 *
 *   launch    VunGIS issues a launch token for a real job; SurveyPro accepts it, appoints, and refuses every forged or stale variant
 *   class     the surveyor declares the SI 727 survey class; it reaches the council's view and the VunGIS importer
 *   deliver   delivery and review in per-surveyor-schema mode: deliver, return, redeliver, accept, import
 *   shared    the application switch (SURVEY_STORE=shared): private practice, council projects, freezing, delivery in place, import
 *   cutover   the cut-over of per-surveyor schemas onto the shared tables, then served through the shared store
 *   check     the layout check: a surveyor and a reviewer ask VunGIS (signed service token) whether the register would take a layout
 *
 * Needs
 *   SURVEYPRO_REPO         a SurveyPro checkout or worktree (the folder that contains app-backend), on the branch under test
 *   SURVEYPRO_SCHEMA_ENV   a file holding DATABASE_URL of a SurveyPro development database, used READ-ONLY (pg_dump --schema-only) for the
 *                          base tables its migration chain cannot build from nothing; or SURVEYPRO_SCHEMA_DUMP, a schema-only .sql you made
 *   VunGIS DATABASE_URL    in app-backend/.env; must be local. The importer scenarios write parcels into it and remove them again, and
 *                          the launch scenario adds and removes one survey job. Nothing else of VunGIS is touched.
 *   Postgres client tools  psql and pg_dump on PATH, or PG_BIN pointing at their folder
 *
 * Exit code 0 only if every scenario passed. Credentials are never printed.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const ROOT = path.resolve(__dirname, '../..')
require(path.join(ROOT, 'node_modules/dotenv')).config({ path: path.join(ROOT, '.env'), quiet: true })
const { Pool } = require(path.join(ROOT, 'node_modules/pg'))

const SCENARIOS = ['launch', 'class', 'deliver', 'shared', 'cutover', 'check']
const SCRATCH = 'surveypro_scratch_xs'
const die = (m) => { console.error(m); process.exit(2) }

const wanted = process.argv.slice(2)
for (const w of wanted) if (!SCENARIOS.includes(w)) die(`unknown scenario "${w}" (${SCENARIOS.join(', ')})`)
const todo = wanted.length ? wanted : SCENARIOS

const repo = process.env.SURVEYPRO_REPO
if (!repo || !fs.existsSync(path.join(repo, 'app-backend', 'migrations'))) die('Set SURVEYPRO_REPO to a SurveyPro checkout (the folder that contains app-backend).')
const spBackend = path.join(repo, 'app-backend').replace(/\\/g, '/')
const vungisUrl = process.env.DATABASE_URL
if (!vungisUrl) die('VunGIS DATABASE_URL is not set (app-backend/.env).')
const base = new URL(vungisUrl)
if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(base.hostname)) die('VunGIS DATABASE_URL is not local; these checks write to it. Refusing.')
const withDb = (d) => { const u = new URL(base); u.pathname = '/' + d; return u.toString() }

function pgTool(name) {
  const exe = process.platform === 'win32' ? name + '.exe' : name
  if (process.env.PG_BIN) return path.join(process.env.PG_BIN, exe)
  if (spawnSync(name, ['--version'], { encoding: 'utf8' }).status === 0) return name
  if (process.platform === 'win32') {
    const root = 'C:/Program Files/PostgreSQL'
    const vs = fs.existsSync(root) ? fs.readdirSync(root).sort((a, b) => Number(b) - Number(a)) : []
    for (const v of vs) { const p = path.join(root, v, 'bin', exe); if (fs.existsSync(p)) return p }
  }
  die(`Cannot find ${name}. Put the PostgreSQL bin folder on PATH or set PG_BIN.`)
}
const pgEnv = (u) => ({ ...process.env, PGPASSWORD: decodeURIComponent(u.password) })
const pgArgs = (u, db) => ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username), '-d', db]

function schemaDump() {
  if (process.env.SURVEYPRO_SCHEMA_DUMP) { if (!fs.existsSync(process.env.SURVEYPRO_SCHEMA_DUMP)) die('SURVEYPRO_SCHEMA_DUMP does not exist.'); return process.env.SURVEYPRO_SCHEMA_DUMP }
  const envFile = process.env.SURVEYPRO_SCHEMA_ENV
  if (!envFile || !fs.existsSync(envFile)) die('Set SURVEYPRO_SCHEMA_ENV (an env file with the DATABASE_URL of a SurveyPro development database) or SURVEYPRO_SCHEMA_DUMP.')
  const m = fs.readFileSync(envFile, 'utf8').match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m)
  if (!m) die('No DATABASE_URL in SURVEYPRO_SCHEMA_ENV.')
  const u = new URL(m[1].replace(/^["']|["']$/g, ''))
  const file = path.join(os.tmpdir(), 'surveypro-schema-xs.sql')
  const r = spawnSync(pgTool('pg_dump'), [...pgArgs(u, u.pathname.slice(1)), '-s', '--no-owner', '--no-privileges', '-f', file], { env: pgEnv(u), encoding: 'utf8' })
  if (r.status !== 0) die('pg_dump of the SurveyPro development schema failed: ' + String(r.stderr).split('\n')[0])
  return file
}

async function teardown() {
  const admin = new Pool({ connectionString: withDb('postgres'), max: 1 })
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`)
    // cluster-wide roles the migrations created; a role something else still depends on simply stays
    const roles = (await admin.query("SELECT rolname FROM pg_roles WHERE rolname ~ '^(sp_reader_|survey_reader$|surveypro_request$)'")).rows
    for (const { rolname } of roles) await admin.query(`DROP ROLE IF EXISTS ${rolname}`).catch(() => {})
  } finally { await admin.end() }
}

async function build(dump) {
  await teardown()
  const admin = new Pool({ connectionString: withDb('postgres'), max: 1 })
  await admin.query(`CREATE DATABASE ${SCRATCH}`); await admin.end()
  const url = withDb(SCRATCH)
  const db = new Pool({ connectionString: url, max: 1 })
  await db.query('CREATE EXTENSION IF NOT EXISTS postgis')
  const r = spawnSync(pgTool('psql'), [...pgArgs(base, SCRATCH), '-q', '-f', dump], { env: pgEnv(base), encoding: 'utf8' })
  if (r.status !== 0) { await db.end(); die('loading the SurveyPro base schema failed: ' + String(r.stderr).split('\n')[0]) }
  const dir = path.join(spBackend, 'migrations')
  const files = fs.readdirSync(dir).map((f) => ({ f, m: /^(\d{3})_.*\.do\.sql$/.exec(f) })).filter((x) => x.m && Number(x.m[1]) >= 96).sort((a, b) => a.f.localeCompare(b.f)).map((x) => x.f)
  const c = await db.connect()
  try {
    for (const f of files) {
      try { await c.query(fs.readFileSync(path.join(dir, f), 'utf8')) }
      catch (e) { throw new Error(`migration ${f} failed: ${e.message}`) }
    }
    const v = (await c.query('SELECT relation, rule FROM tenancy.violations')).rows
    if (v.length) throw new Error('tenancy.violations is not empty after the migrations: ' + v.map((x) => `${x.rule} ${x.relation}`).join(', '))
  } finally { c.release(); await db.end() }
  return { url, files }
}

;(async () => {
  const dump = schemaDump()
  const results = []
  for (const name of todo) {
    console.log(`\n${'='.repeat(78)}\n${name}\n${'='.repeat(78)}`)
    let built
    try { built = await build(dump) } catch (e) { console.log('BUILD FAILED: ' + e.message); results.push([name, false]); continue }
    console.log(`(scratch SurveyPro database built: migrations ${built.files[0].slice(0, 3)}-${built.files[built.files.length - 1].slice(0, 3)}, no tenancy violations)`)
    const r = spawnSync('node', [path.join(__dirname, name + '.js')], {
      cwd: ROOT, stdio: 'inherit', timeout: 10 * 60 * 1000,
      env: { ...process.env, XS_SCRATCH_URL: built.url, XS_SCRATCH_DB: SCRATCH, SURVEYPRO_BACKEND: spBackend },
    })
    results.push([name, r.status === 0])
  }
  await teardown()
  console.log(`\n${'='.repeat(78)}`)
  for (const [n, pass] of results) console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}`)
  process.exit(results.every(([, p]) => p) ? 0 : 1)
})().catch(async (e) => { console.error('ERR', e.message); await teardown().catch(() => {}); process.exit(1) })
