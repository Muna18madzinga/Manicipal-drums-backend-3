// Cross-system check: The cut-over: work done in per-surveyor schemas is moved, then served through the shared store.
// Run through scripts/cross-system/run.js (it builds the scratch SurveyPro database these expect); see docs/SURVEYPRO-INTEGRATION.md.
const path = require('path')
const ROOT = path.resolve(__dirname, '../..'); process.chdir(ROOT)
const NM = ROOT + '/node_modules/'
const fs = require('fs'); const crypto = require('crypto'); const { spawn, spawnSync } = require('child_process')
const axios = require(NM + 'axios'); const { Pool } = require(NM + 'pg')
const scratchUrl = process.env.XS_SCRATCH_URL
if (!/surveypro_scratch/.test(scratchUrl)) throw new Error('not scratch')
const WT = process.env.SURVEYPRO_BACKEND
let bad = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++ }
const boot = async (port, store) => {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, PORT: String(port), HOST: '127.0.0.1', DATABASE_URL: scratchUrl, DB_NAME: process.env.XS_SCRATCH_DB, JWT_SECRET: 'fixed-e2e-secret-fixed-e2e-secret', SURVEY_STORE: store }
  const child = spawn('node', ['src/server.js'], { cwd: WT, env, stdio: 'ignore' })
  for (let i = 0; i < 70; i++) { await new Promise(r => setTimeout(r, 1500)); try { if ((await axios.get(`http://127.0.0.1:${port}/api/health`, { timeout: 1500 })).status === 200) break } catch {} }
  return { child, sp: axios.create({ baseURL: `http://127.0.0.1:${port}/api`, validateStatus: () => true, timeout: 60000 }) }
}
;(async () => {
  const db = new Pool({ connectionString: scratchUrl, max: 2 })
  const old = await boot(3059, 'schema')
  const reg = async (email, name, lic) => {
    const x = await old.sp.post('/auth/register', { email, password: 'e2e-pass-1', name, surveyorType: 'registered', licenseNumber: lic, firm: 'E2E' }); if (x.status !== 201) throw new Error('register')
    const t = (await old.sp.post('/auth/login', { email, password: 'e2e-pass-1' })).data.token
    return { email, H: { headers: { Authorization: 'Bearer ' + t } }, id: (await db.query('SELECT id FROM public.users WHERE email=$1', [email])).rows[0].id }
  }
  const A = await reg('a@cut.test', 'Alpha', 'A-1'); const B = await reg('b@cut.test', 'Bravo', 'B-1')
  const mk = async (u, name) => (await old.sp.post('/survey-projects', { name, clientName: 'C', district: 'D', surveyType: 'Layout survey', surveyDate: '2026-06-01', workingDirectory: 'C:/cut' }, u.H)).data.project.id
  const pa = await mk(A, 'Alpha job'); const pb = await mk(B, 'Bravo job')
  await old.sp.post('/coordinate-points', { project_id: String(pa), name: 'A1', y: -84000, x: 2151300 }, A.H)
  await old.sp.post('/coordinate-points', { project_id: String(pa), name: 'A2', y: -84010, x: 2151310 }, A.H)
  await old.sp.post('/coordinate-points', { project_id: String(pb), name: 'B1', y: -83000, x: 2150300 }, B.H)
  const schemaA = (await db.query('SELECT schema_name FROM public.surveyor_profiles WHERE user_id=$1', [A.id])).rows[0].schema_name
  const schemaB = (await db.query('SELECT schema_name FROM public.surveyor_profiles WHERE user_id=$1', [B.id])).rows[0].schema_name
  await db.query(`INSERT INTO ${schemaA}.land_parcels (project_id, stand, designation, status, area_m2, geom) VALUES ($1,'1','1','finalized',900,ST_GeomFromText('POLYGON((-84000 2151300,-83970 2151300,-83970 2151330,-84000 2151330,-84000 2151300))',22289))`, [pa])
  const auth = (await db.query("INSERT INTO survey.authority (code,name,kind) VALUES ('VUNGU','Vungu RDC','rural') RETURNING id")).rows[0].id
  old.child.kill()

  const run = (...a) => spawnSync('node', ['scripts/cutover-to-shared.js', ...a], { cwd: WT, env: { ...process.env, DATABASE_URL: scratchUrl }, encoding: 'utf8' })
  console.log('dry run')
  let r = run(); ok(r.status === 0 && /2 per-surveyor schema/.test(r.stdout) && /dry run/.test(r.stdout), 'lists both schemas and changes nothing')
  ok((await db.query('SELECT count(*)::int n FROM survey.survey_projects')).rows[0].n === 0, 'nothing was moved')
  r = run('--apply', '--map', `${schemaA}=NOPE:employed`); ok(r.status === 1 && /UNKNOWN AUTHORITY/.test(r.stdout), 'an unknown authority in --map is a problem, not a guess')
  r = run('--apply', '--map', 'bad'); ok(r.status === 2, 'a malformed --map is refused')
  console.log('\napply')
  r = run('--apply', '--map', `${schemaA}=VUNGU:employed`); ok(r.status === 0 && /counts match/.test(r.stdout) && /Done/.test(r.stdout), 'moved and verified: ' + r.stdout.split('\n').filter(l => /verified|COUNTS/.test(l)).join(' | '))
  const pr = (await db.query('SELECT p.name, p.authority_id, p.engagement, p.surveyor_user_id FROM survey.survey_projects p ORDER BY p.name')).rows
  ok(pr.length === 2 && pr[0].authority_id === auth && pr[0].engagement === 'employed' && pr[0].surveyor_user_id === A.id, 'Alpha\'s project is the council\'s (employed)')
  ok(pr[1].authority_id === null && pr[1].surveyor_user_id === B.id, 'Bravo\'s stays private practice')
  r = run(); ok(/Nothing to move/.test(r.stdout), 'a second run has nothing to move')
  r = run('--apply', '--again'); ok(r.status === 0, 're-running with --again copies nothing twice')
  ok((await db.query('SELECT count(*)::int n FROM survey.coordinate_points')).rows[0].n === 3, 'three points, once each')

  console.log('\nthrough the shared store')
  const now = await boot(3060, 'shared')
  const login = async (u) => ({ headers: { Authorization: 'Bearer ' + (await now.sp.post('/auth/login', { email: u.email, password: 'e2e-pass-1' })).data.token } })
  const AH = await login(A); const BH = await login(B)
  r = await now.sp.get('/survey-projects', AH); ok(r.data.projects.length === 1 && r.data.projects[0].name === 'Alpha job', 'Alpha sees Alpha\'s project')
  const sidA = r.data.projects[0].id
  r = await now.sp.get(`/coordinate-points?project_id=${sidA}`, AH); ok(r.data.data.length === 2, 'with its two points')
  r = await now.sp.get('/survey-projects', BH); ok(r.data.projects.length === 1 && r.data.projects[0].name === 'Bravo job', 'Bravo sees only Bravo\'s')
  r = await now.sp.get(`/coordinate-points?project_id=${sidA}`, BH); ok(r.data.data.length === 0, 'and none of Alpha\'s points')
  now.child.kill(); await db.end()
  console.log(bad ? `\n${bad} FAILED` : '\nALL OK'); process.exit(bad ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
