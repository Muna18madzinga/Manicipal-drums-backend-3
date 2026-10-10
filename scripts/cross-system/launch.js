// Cross-system check: VunGIS issues a launch token for a real job; SurveyPro (shared-table tenancy, scratch database) accepts it, appoints, and refuses the rest.
// Run through scripts/cross-system/run.js (it builds the scratch SurveyPro database these expect); see docs/SURVEYPRO-INTEGRATION.md.
const path = require('path')
const ROOT = path.resolve(__dirname, '../..'); process.chdir(ROOT)
const NM = ROOT + '/node_modules/'
const fs = require('fs'); const crypto = require('crypto'); const { spawn } = require('child_process')
const axios = require(NM + 'axios'); const { Pool } = require(NM + 'pg')

const scratchUrl = process.env.XS_SCRATCH_URL
if (!/surveypro_scratch/.test(scratchUrl)) throw new Error('not the scratch database')
const keys = crypto.generateKeyPairSync('ed25519')
const PORT = 3055; const SP = `http://127.0.0.1:${PORT}`
let bad = 0
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++ }

// ---- VunGIS, in this process, with its signing key ----------------------------------------------------------------------------
process.env.SURVEYPRO_LAUNCH_PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
process.env.SURVEYPRO_URL = 'http://survey.example.test'
const { buildAppForTest } = require(ROOT + '/test/helpers/buildApp')
const { loginAs } = require(ROOT + '/test/helpers/auth')
const launchLib = require(ROOT + '/src/lib/launchToken')

;(async () => {
  // ---- SurveyPro, as a separate process on the scratch database ----------------------------------------------------------------
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL: scratchUrl, APP_DATABASE_URL: process.env.XS_APP_URL || scratchUrl, DB_NAME: process.env.XS_SCRATCH_DB, DB_HOST: 'localhost',
    JWT_SECRET: crypto.randomBytes(24).toString('hex'), NODE_ENV: 'development',
    VUNGIS_LAUNCH_PUBLIC_KEY: keys.publicKey.export({ type: 'spki', format: 'pem' }),
  }
  const child = spawn('node', ['src/server.js'], { cwd: process.env.SURVEYPRO_BACKEND, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.on('data', d => log += d); child.stderr.on('data', d => log += d)
  const stop = () => { try { child.kill() } catch {} }
  process.on('exit', stop)
  let up = false
  for (let i = 0; i < 70 && !up; i++) { await new Promise(r => setTimeout(r, 1500)); try { up = (await axios.get(SP + '/api/health', { timeout: 1500 })).status === 200 } catch {} }
  if (!up) { console.log('SurveyPro did not start:\n' + log.slice(-1500)); stop(); process.exit(1) }
  console.log('SurveyPro up on', PORT, '(scratch database)')

  const db = new Pool({ connectionString: scratchUrl, max: 2 })
  const sp = axios.create({ baseURL: SP + '/api', validateStatus: () => true, timeout: 60000 })
  const register = async (email, name, lic) => (await sp.post('/auth/register', { email, password: 'e2e-password-1', name, surveyorType: 'registered', licenseNumber: lic, firm: 'E2E' }))
  const login = async (email) => (await sp.post('/auth/login', { email, password: 'e2e-password-1' })).data.token

  // people: a head surveyor, the demo surveyor VunGIS knows, and a surveyor nobody appointed
  for (const [e, n, l] of [['head@vungu.test', 'Head Surveyor', 'E2E-H1'], ['demo.surveyor@vungu.test', 'Demo Surveyor', 'E2E-S1'], ['stranger@vungu.test', 'Not Appointed', 'E2E-S2']]) {
    const r = await register(e, n, l); if (r.status !== 201) { console.log('register failed', e, r.status, JSON.stringify(r.data)); process.exit(1) }
  }
  await db.query("INSERT INTO survey.authority (code, name, kind) VALUES ('VUNGU', 'Vungu Rural District Council', 'rural')")
  // the platform operator bootstraps the first head surveyor (everything after is done through the API)
  await db.query(`INSERT INTO survey.authority_member (user_id, authority_id, role, engagement)
                  SELECT u.id, a.id, 'head_surveyor', 'employed' FROM public.users u, survey.authority a WHERE u.email = 'head@vungu.test' AND a.code = 'VUNGU'`)

  console.log('\nappointments, by the head surveyor, through the API')
  const head = await login('head@vungu.test'); const stranger = await login('stranger@vungu.test'); const authH = (t) => ({ headers: { Authorization: 'Bearer ' + t } })
  let r = await sp.post('/authorities/VUNGU/members', { email: 'demo.surveyor@vungu.test', role: 'surveyor', engagement: 'contracted' }, authH(stranger))
  ok(r.status === 403, `a surveyor who is not a head surveyor cannot appoint (${r.status})`)
  r = await sp.post('/authorities/VUNGU/members', { email: 'nobody@nowhere.test', role: 'surveyor', engagement: 'employed' }, authH(head))
  ok(r.status === 404 && r.data.error === 'no_surveypro_account', `appointing someone with no SurveyPro account says so (${r.status})`)
  r = await sp.post('/authorities/VUNGU/members', { email: 'demo.surveyor@vungu.test', role: 'surveyor' }, authH(head))
  ok(r.status === 400 && r.data.error === 'engagement_required', 'employed or contracted must be stated')
  r = await sp.post('/authorities/VUNGU/members', { email: 'demo.surveyor@vungu.test', role: 'surveyor', engagement: 'contracted', note: 'cadastral survey contract' }, authH(head))
  ok(r.status === 201 && r.data.data.engagement === 'contracted', `the head surveyor appoints a contracted surveyor (${r.status})`)
  r = await sp.post('/authorities/VUNGU/members', { email: 'demo.surveyor@vungu.test', role: 'surveyor', engagement: 'contracted' }, authH(head))
  ok(r.status === 409, 'appointing the same person twice is refused')
  r = await sp.post('/authorities/VUNGU/members', { email: 'stranger@vungu.test', role: 'head_surveyor', engagement: 'employed' }, authH(head))
  ok(r.status === 403, 'a head surveyor cannot make another head surveyor')
  r = await sp.get('/authorities/VUNGU/members', authH(head))
  ok(r.status === 200 && r.data.data.length === 2, `the head surveyor sees the panel (${r.data.data && r.data.data.length} people)`)
  r = await sp.get('/authorities/VUNGU/members', authH(stranger))
  ok(r.status === 200 && r.data.data.length === 0, 'someone not appointed sees nobody')

  console.log('\nVunGIS issues a token for a real job')
  const app = await buildAppForTest()
  const planner = await loginAs(app, 'demo.planner@vungu.test', 'demo1234'); const surveyor = await loginAs(app, 'demo.surveyor@vungu.test', 'demo1234')
  const vg = new Pool({ connectionString: process.env.DATABASE_URL })
  const sid = (await vg.query("SELECT id FROM public.users WHERE email = 'demo.surveyor@vungu.test'")).rows[0].id
  const H = (t) => ({ authorization: 'Bearer ' + t })
  const job = (await app.inject({ method: 'POST', url: '/api/surveyor/jobs', headers: H(planner), payload: { task_type: 'pegging', stand_number: 'E2E-4521', suburb_ward: 'Ward 6', lng: 29.8, lat: -19.45, instructions: 'Peg the corners', due_date: '2026-12-01', assigned_to: sid } })).json().data
  const launch = async () => (await app.inject({ method: 'POST', url: `/api/surveyor/jobs/${job.id}/launch`, headers: H(surveyor) })).json().data
  const tokenOf = (d) => decodeURIComponent(d.url.split('token=')[1])
  const t1 = tokenOf(await launch())
  ok(t1.split('.').length === 3, 'VunGIS returns a launch URL carrying a signed token')

  console.log('\nSurveyPro accepts it')
  r = await sp.post('/auth/launch', { token: t1 })
  ok(r.status === 200, `the launch is accepted (${r.status}${r.status !== 200 ? ' ' + JSON.stringify(r.data) : ''})`)
  const launched = r.data
  ok(launched.project && launched.project.created === true && /Pegging/.test(launched.project.name), `a project was opened for the job: "${launched.project && launched.project.name}"`)
  ok(launched.authority && launched.authority.code === 'VUNGU' && launched.engagement === 'contracted', 'for the right council, as a contracted surveyor')
  const profile = (await db.query("SELECT sp.schema_name FROM public.surveyor_profiles sp JOIN public.users u ON u.id = sp.user_id WHERE u.email = 'demo.surveyor@vungu.test'")).rows[0]
  const row = (await db.query(`SELECT id, name, client_name, township, designation, central_meridian, metadata FROM ${profile.schema_name}.survey_projects WHERE id = $1`, [launched.project.id])).rows[0]
  ok(row && row.metadata.external_job_id === job.id && row.metadata.authority_code === 'VUNGU', 'the project in the surveyor\'s schema records the job id and council')
  ok(row.township === 'Ward 6' && row.designation === 'E2E-4521' && row.central_meridian === String(job.gauss_lo) && row.client_name === 'Vungu Rural District Council', 'and carries the stand, ward, Lo zone and the council as client')
  r = await sp.get(`/survey-projects/${launched.project.id}`, authH(launched.token))
  ok(r.status === 200, `the new session reads the project through SurveyPro's own API (${r.status})`)
  r = await sp.get('/authorities/mine', authH(launched.token))
  ok(r.status === 200 && r.data.data.some(a => a.code === 'VUNGU' && a.active), 'and sees its appointment')

  console.log('\nand refuses everything else')
  r = await sp.post('/auth/launch', { token: t1 })
  ok(r.status === 409 && r.data.error === 'launch_token_used', `the same link cannot be used twice (${r.status})`)
  const t2 = tokenOf(await launch())
  r = await sp.post('/auth/launch', { token: t2 })
  ok(r.status === 200 && r.data.project.created === false && r.data.project.id === launched.project.id, 'a second launch of the same job reopens the same project, not a new one')
  const [h, p, s] = tokenOf(await launch()).split('.'); const forged = JSON.parse(Buffer.from(p, 'base64url').toString()); forged.sub = 'stranger@vungu.test'
  r = await sp.post('/auth/launch', { token: `${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}` })
  ok(r.status === 401, `a token with a changed email is refused (${r.status})`)
  const old = launchLib.sign(launchLib.claimsForJob({ ...job, lon: 29.8, lat: -19.45, authority_code: 'VUNGU', authority_name: 'V' }, { email: 'demo.surveyor@vungu.test', name: 'D' }), { privateKey: keys.privateKey, now: Math.floor(Date.now() / 1000) - 3600 })
  r = await sp.post('/auth/launch', { token: old.token })
  ok(r.status === 401 && /expired/.test(r.data.message), 'an hour-old token has expired')
  const other = crypto.generateKeyPairSync('ed25519')
  r = await sp.post('/auth/launch', { token: launchLib.sign(launchLib.claimsForJob({ ...job, lon: 1, lat: 1, authority_code: 'VUNGU', authority_name: 'V' }, { email: 'demo.surveyor@vungu.test', name: 'D' }), { privateKey: other.privateKey }).token })
  ok(r.status === 401, 'a token signed with some other key is refused')
  const strangerTok = launchLib.sign(launchLib.claimsForJob({ ...job, lon: 1, lat: 1, authority_code: 'VUNGU', authority_name: 'V' }, { email: 'stranger@vungu.test', name: 'S' }), { privateKey: keys.privateKey }).token
  r = await sp.post('/auth/launch', { token: strangerTok })
  ok(r.status === 403 && r.data.error === 'not_appointed', `a surveyor VunGIS vouches for but the council has not appointed is refused (${r.status}): "${r.data.message}"`)
  const noAcct = launchLib.sign(launchLib.claimsForJob({ ...job, lon: 1, lat: 1, authority_code: 'VUNGU', authority_name: 'V' }, { email: 'ghost@vungu.test', name: 'G' }), { privateKey: keys.privateKey }).token
  r = await sp.post('/auth/launch', { token: noAcct })
  ok(r.status === 404 && r.data.error === 'no_surveypro_account', 'someone with no SurveyPro account is told to register first')
  const wrongCouncil = launchLib.sign(launchLib.claimsForJob({ ...job, lon: 1, lat: 1, authority_code: 'NOWHERE', authority_name: 'Nowhere RDC' }, { email: 'demo.surveyor@vungu.test', name: 'D' }), { privateKey: keys.privateKey }).token
  r = await sp.post('/auth/launch', { token: wrongCouncil })
  ok(r.status === 409 && r.data.error === 'unknown_authority', 'a council SurveyPro does not know is refused')
  await db.query("UPDATE survey.authority_member SET valid_to = CURRENT_DATE - 1, valid_from = CURRENT_DATE - 30 WHERE user_id = (SELECT id FROM public.users WHERE email='demo.surveyor@vungu.test')")
  r = await sp.post('/auth/launch', { token: tokenOf(await launch()) })
  ok(r.status === 403 && r.data.error === 'not_appointed', 'once the appointment has ended, the same surveyor is refused')
  await db.query("UPDATE survey.authority_member SET valid_to = NULL WHERE user_id = (SELECT id FROM public.users WHERE email='demo.surveyor@vungu.test')")
  r = await sp.post('/authorities/VUNGU/members/' + (await sp.get('/authorities/VUNGU/members', authH(head))).data.data.find(m => m.email === 'demo.surveyor@vungu.test').id + '/end', {}, authH(head))
  ok(r.status === 200, 'the head surveyor ends the appointment through the API')
  r = await sp.post('/auth/launch', { token: tokenOf(await launch()) })
  ok(r.status === 403, 'and the surveyor can no longer launch')

  console.log('\nwhen the schema is moved, the job link becomes real columns')
  await db.query(`DELETE FROM survey.authority_member WHERE user_id = (SELECT id FROM public.users WHERE email='demo.surveyor@vungu.test')`)
  const uid = (await db.query("SELECT id FROM public.users WHERE email = 'demo.surveyor@vungu.test'")).rows[0].id
  const aid = (await db.query("SELECT id FROM survey.authority WHERE code = 'VUNGU'")).rows[0].id
  const moved = (await db.query('SELECT * FROM survey.adopt_surveyor_schema($1, $2, $3, $4)', [profile.schema_name, uid, null, null])).rows
  const pr = (await db.query('SELECT authority_id, engagement, external_job_id FROM survey.survey_projects WHERE legacy_schema = $1', [profile.schema_name])).rows[0]
  ok(pr && pr.authority_id === aid && pr.engagement === 'contracted' && pr.external_job_id === job.id, `the moved project belongs to the council (authority ${pr && pr.authority_id}), as contracted, linked to job ${pr && String(pr.external_job_id).slice(0, 8)}…`)

  await vg.query('DELETE FROM spatial_planning.survey_task WHERE id = $1', [job.id])
  await vg.end(); await app.close(); await db.end(); stop()
  console.log(bad ? `\n${bad} FAILED` : '\nALL OK'); process.exit(bad ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
