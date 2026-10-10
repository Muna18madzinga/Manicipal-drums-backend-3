// Stage: stand VunGIS and SurveyPro up TOGETHER, wired to each other, with people and data, and leave them running (until Ctrl-C) so someone can use them.
// For taking the manuals' screenshots (manuals/_tools/README.md), for a demonstration, or to try the whole chain by hand.
//
//   SURVEYPRO_REPO=... SURVEYPRO_SCHEMA_ENV=... node scripts/cross-system/run.js stage
//
// What it makes (all throw-away; Ctrl-C removes it):
//   - a COPY of the VunGIS development database (vungu_manual_shots), with the demo accounts, run as a VunGIS server and its web app
//   - a scratch SurveyPro database, run as a SurveyPro server (as the non-owner runtime login, on the shared store) and its web app
//   - the two joined: VunGIS signs launch links SurveyPro trusts; SurveyPro asks VunGIS about the register; VunGIS reads the council's accepted work
//   - in SurveyPro: Vungu RDC, with a head surveyor, a contracted surveyor (the same person as VunGIS's demo surveyor), and a reviewer
// It writes manuals/_tools/stage.json (addresses and the demo accounts), which shoot.cjs reads. Needs the SurveyPro frontend's node_modules
// (a link to the SurveyPro checkout's is made inside the worktree and removed again).
const path = require('path')
const ROOT = path.resolve(__dirname, '../..'); process.chdir(ROOT)
const NM = ROOT + '/node_modules/'
const fs = require('fs'); const os = require('os'); const crypto = require('crypto'); const { spawn, spawnSync } = require('child_process')
const axios = require(NM + 'axios'); const { Pool } = require(NM + 'pg')
require(NM + 'dotenv').config({ path: ROOT + '/.env', quiet: true })

const vungisUrl = process.env.DATABASE_URL
const scratchUrl = process.env.XS_SCRATCH_URL
if (!/surveypro_scratch/.test(scratchUrl)) throw new Error('not scratch')
const SPB = process.env.SURVEYPRO_BACKEND                               // .../app-backend of the SurveyPro checkout
const SPF = path.resolve(SPB, '..', 'app-frontend')
const COPY = 'vungu_manual_shots'
const P = { vgApi: 3091, vgWeb: 5177, spApi: 3071, spWeb: 5181 }
const OUT = path.resolve(ROOT, '..', 'manuals', '_tools', 'stage.json')
const PASSWORD = 'demo1234'                                             // the demo accounts' password, as the project's own seed scripts set it
const children = []
const say = (m) => console.log(m)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withDb = (u, d) => { const x = new URL(u); x.pathname = '/' + d; return x.toString() }
const pgBin = (n) => { for (const v of ['18', '17', '16', '15']) { const p = `C:/Program Files/PostgreSQL/${v}/bin/${n}.exe`; if (fs.existsSync(p)) return p } return n }
const up = async (url, tries = 80) => { for (let i = 0; i < tries; i++) { try { if ((await fetch(url)).ok) return true } catch { /* not yet */ } await sleep(1500) } return false }
const run = (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts }); if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${String(r.stderr || r.stdout).split('\n').slice(0, 3).join(' ')}`); return r }

let linkMade = false
async function cleanup() {
  for (const c of children) { try { c.kill() } catch { /* gone */ } }
  await sleep(800)
  try {
    const admin = new Pool({ connectionString: withDb(vungisUrl, 'postgres'), max: 1 })
    await admin.query(`DROP DATABASE IF EXISTS ${COPY} WITH (FORCE)`); await admin.end()
  } catch { /* best effort */ }
  if (linkMade) { try { spawnSync('cmd', ['/c', 'rmdir', SPF.replace(/\//g, '\\') + '\\node_modules']) } catch { /* best effort */ } }
  try { fs.unlinkSync(OUT) } catch { /* none */ }
  try { fs.unlinkSync(SPB + '/.reader-vungu.env') } catch { /* none */ }
}
process.on('SIGINT', async () => { say('\nstopping and clearing up...'); await cleanup(); process.exit(0) })
process.on('SIGTERM', async () => { await cleanup(); process.exit(0) })

;(async () => {
  // ---- 1. a copy of the VunGIS database, with the demo accounts --------------------------------------------------------------------
  say('1. copying the VunGIS development database (read-only dump) into ' + COPY)
  const u = new URL(vungisUrl); const pw = { PGPASSWORD: decodeURIComponent(u.password) }
  const conn = ['-h', u.hostname, '-p', u.port || '5432', '-U', decodeURIComponent(u.username)]
  const dump = path.join(os.tmpdir(), 'vungis-manual-shots.dump')
  run(pgBin('pg_dump'), [...conn, '-d', u.pathname.slice(1), '-Fc', '-f', dump], { env: { ...process.env, ...pw } })
  const admin = new Pool({ connectionString: withDb(vungisUrl, 'postgres'), max: 1 })
  await admin.query(`DROP DATABASE IF EXISTS ${COPY} WITH (FORCE)`); await admin.query(`CREATE DATABASE ${COPY}`); await admin.end()
  spawnSync(pgBin('pg_restore'), [...conn, '-d', COPY, dump], { env: { ...process.env, ...pw }, encoding: 'utf8' })   // some noise about extensions is normal
  spawnSync(pgBin('psql'), [...conn, '-d', COPY, '-c', 'ANALYZE'], { env: { ...process.env, ...pw }, encoding: 'utf8' })   // a restore keeps no statistics: without them the register's queries are slow
  try { fs.unlinkSync(dump) } catch { /* none */ }
  const copyUrl = withDb(vungisUrl, COPY)
  const vg = new Pool({ connectionString: copyUrl, max: 2 })
  if (!(await vg.query("SELECT to_regclass('land.parcel') AS r")).rows[0].r) throw new Error('the copy of the VunGIS database did not restore')
  run('node', ['scripts/seed-demo-users.js'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: copyUrl } })
  // the copy is a stage, not a record: nothing on it matters, and nothing leaves it

  // ---- 2. keys: VunGIS signs launch links, SurveyPro signs its questions to VunGIS ------------------------------------------------------
  const launch = crypto.generateKeyPairSync('ed25519'); const service = crypto.generateKeyPairSync('ed25519')
  const pem = (k, type) => k.export({ type, format: 'pem' }).replace(/\n/g, '\\n')

  // ---- 3. SurveyPro: its server (as the runtime login, on the shared store) and its web app -------------------------------------------
  say('3. starting SurveyPro')
  const spEnv = (extra = {}) => ({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, ...extra })
  const vgBase = `http://127.0.0.1:${P.vgApi}`
  const sp = spawn('node', ['src/server.js'], { cwd: SPB, stdio: 'ignore', env: spEnv({
    PORT: String(P.spApi), HOST: '127.0.0.1', DATABASE_URL: scratchUrl, APP_DATABASE_URL: process.env.XS_APP_URL || scratchUrl, DB_NAME: process.env.XS_SCRATCH_DB, JWT_SECRET: crypto.randomBytes(24).toString('hex'),
    SURVEY_STORE: 'shared', VUNGIS_LAUNCH_PUBLIC_KEY: pem(launch.publicKey, 'spki'), SURVEYPRO_SERVICE_PRIVATE_KEY: pem(service.privateKey, 'pkcs8'), VUNGIS_API_URL: vgBase }) })
  children.push(sp)
  if (!(await up(`http://127.0.0.1:${P.spApi}/api/health`))) throw new Error('SurveyPro did not start')
  const spApi = axios.create({ baseURL: `http://127.0.0.1:${P.spApi}/api`, validateStatus: () => true, timeout: 60000 })
  const spDb = new Pool({ connectionString: scratchUrl, max: 2 })

  // people (the surveyor is the same person as VunGIS's demo surveyor: that is how the launch finds them)
  const people = [
    { key: 'head', email: 'head.surveyor@vungu.test', name: 'Hannah Moyo', lic: 'RS-1001' },
    { key: 'surveyor', email: 'demo.surveyor@vungu.test', name: 'Demo Surveyor', lic: 'RS-1002' },
    { key: 'reviewer', email: 'reviewer@vungu.test', name: 'Rita Ncube', lic: 'RV-2001' },
    { key: 'solo', email: 'solo.surveyor@example.test', name: 'Pat Dube', lic: 'RS-1003' },
  ]
  for (const p of people) {
    const r = await spApi.post('/auth/register', { email: p.email, password: PASSWORD, name: p.name, surveyorType: 'registered', licenseNumber: p.lic, firm: p.key === 'solo' ? 'Dube Surveys' : 'Vungu RDC' })
    if (r.status !== 201) throw new Error(`could not register ${p.email}: ${r.status} ${JSON.stringify(r.data).slice(0, 100)}`)
    p.id = (await spDb.query('SELECT id FROM public.users WHERE email = $1', [p.email])).rows[0].id
  }
  const auth = (await spDb.query("INSERT INTO survey.authority (code, name, kind) VALUES ('VUNGU', 'Vungu Rural District Council', 'rural') RETURNING id")).rows[0].id
  const by = Object.fromEntries(people.map((p) => [p.key, p]))
  await spDb.query("INSERT INTO survey.authority_member (user_id, authority_id, role, engagement) VALUES ($1,$2,'head_surveyor','employed'), ($3,$2,'surveyor','contracted'), ($4,$2,'reviewer',NULL)", [by.head.id, auth, by.surveyor.id, by.reviewer.id])
  // the council's own reader login on SurveyPro: what VunGIS reads accepted work through
  spawnSync('node', ['scripts/create-authority-reader.js', '--authority', 'VUNGU', '--apply'], { cwd: SPB, env: { ...process.env, DATABASE_URL: scratchUrl }, encoding: 'utf8' })
  const renv = Object.fromEntries(fs.readFileSync(SPB + '/.reader-vungu.env', 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(/=(.*)/s).slice(0, 2)))
  const readerUrl = `postgresql://${renv.PGUSER}:${encodeURIComponent(renv.PGPASSWORD)}@${renv.PGHOST}:${renv.PGPORT}/${renv.PGDATABASE}`
  fs.unlinkSync(SPB + '/.reader-vungu.env')

  // ---- 4. VunGIS: its server and its web app, wired to SurveyPro --------------------------------------------------------------------
  say('4. starting VunGIS')
  const vgs = spawn('node', ['server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT: String(P.vgApi), DATABASE_URL: copyUrl, APP_DATABASE_URL: '',
    SURVEYPRO_URL: `http://127.0.0.1:${P.spWeb}`, SURVEYPRO_LAUNCH_PRIVATE_KEY: pem(launch.privateKey, 'pkcs8'), SURVEYPRO_SERVICE_PUBLIC_KEY: pem(service.publicKey, 'spki'),
    SURVEYPRO_READERS: JSON.stringify({ VUNGU: readerUrl }), SURVEYPRO_IMPORT_MINUTES: '', GMS_WORKER: 'off' } })
  children.push(vgs)
  if (!(await up(`${vgBase}/api/health`))) throw new Error('VunGIS did not start')

  // ---- 5. the two web apps ----------------------------------------------------------------------------------------------------------------
  say('5. starting the web apps')
  if (!fs.existsSync(SPF + '/node_modules')) { run('cmd', ['/c', 'mklink', '/J', SPF.replace(/\//g, '\\') + '\\node_modules', 'C:\\surveypro-oct-beta\\surveypro\\app-frontend\\node_modules']); linkMade = true }
  const viteBin = (dir) => path.join(dir, 'node_modules', 'vite', 'bin', 'vite.js')
  children.push(spawn('node', [viteBin(SPF), '--port', String(P.spWeb), '--strictPort', '--host', '127.0.0.1'], { cwd: SPF, stdio: 'ignore', env: { ...process.env, VITE_DEV_PROXY_TARGET: `http://127.0.0.1:${P.spApi}` } }))
  children.push(spawn('node', [viteBin(path.resolve(ROOT, '..', 'app-frontend')), '--port', String(P.vgWeb), '--strictPort', '--host', '127.0.0.1'], { cwd: path.resolve(ROOT, '..', 'app-frontend'), stdio: 'ignore', env: { ...process.env, VITE_BACKEND_PROXY: vgBase } }))
  if (!(await up(`http://127.0.0.1:${P.spWeb}/`)) || !(await up(`http://127.0.0.1:${P.vgWeb}/`))) throw new Error('a web app did not start')

  fs.writeFileSync(OUT, JSON.stringify({
    vungis: { web: `http://127.0.0.1:${P.vgWeb}`, api: vgBase }, surveypro: { web: `http://127.0.0.1:${P.spWeb}`, api: `http://127.0.0.1:${P.spApi}` }, password: PASSWORD,
    vungisAccounts: { planner: 'demo.planner@vungu.test', surveyor: 'demo.surveyor@vungu.test', gisHead: 'demo.gis-head@vungu.test', gisData: 'demo.gis-data@vungu.test', gisOfficer: 'demo.gis@vungu.test', admin: 'demo.admin@vungu.test' },
    surveyproAccounts: Object.fromEntries(people.map((p) => [p.key, { email: p.email, name: p.name, id: p.id }])), readerUrl: '(not written)',
    scratchUrl: '(not written)',
  }, null, 2))
  say(`\nSTAGE READY\n  VunGIS     ${`http://127.0.0.1:${P.vgWeb}`}   (demo.planner@vungu.test / demo.surveyor@vungu.test / demo.gis-head@vungu.test, password ${PASSWORD})\n  SurveyPro  ${`http://127.0.0.1:${P.spWeb}`}   (demo.surveyor@vungu.test / head.surveyor@vungu.test / reviewer@vungu.test, password ${PASSWORD})\n  Ctrl-C to stop and clear up.`)
  // stop on request: create manuals/_tools/stage.stop (Ctrl-C does the same where the terminal passes it on)
  const stopFile = path.resolve(ROOT, '..', 'manuals', '_tools', 'stage.stop')
  try { fs.unlinkSync(stopFile) } catch { /* none */ }
  setInterval(async () => { if (fs.existsSync(stopFile)) { try { fs.unlinkSync(stopFile) } catch { /* gone */ } say('stop requested; clearing up...'); await cleanup(); process.exit(0) } }, 1000)
})().catch(async (e) => { console.error('STAGE FAILED:', e.message); await cleanup(); process.exit(1) })
