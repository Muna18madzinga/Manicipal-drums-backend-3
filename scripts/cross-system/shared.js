// Cross-system check: The application switch (SURVEY_STORE=shared): private practice, council projects, freezing, delivery in place, importer.
// Run through scripts/cross-system/run.js (it builds the scratch SurveyPro database these expect); see docs/SURVEYPRO-INTEGRATION.md.
const path = require('path')
const ROOT = path.resolve(__dirname, '../..'); process.chdir(ROOT)
const NM = ROOT + '/node_modules/'
const fs = require('fs'); const crypto = require('crypto'); const { spawn, spawnSync } = require('child_process')
const axios = require(NM + 'axios'); const { Pool } = require(NM + 'pg')
require(NM + 'dotenv').config({ path: ROOT + '/.env', quiet: true })
const vungisUrl = process.env.DATABASE_URL
const scratchUrl = process.env.XS_SCRATCH_URL
if (!/surveypro_scratch/.test(scratchUrl)) throw new Error('not scratch')
const WT = process.env.SURVEYPRO_BACKEND
const PORT = 3058; const SPURL = `http://127.0.0.1:${PORT}`
let bad = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++ }

;(async () => {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL: scratchUrl, DB_NAME: process.env.XS_SCRATCH_DB,
    JWT_SECRET: crypto.randomBytes(24).toString('hex'), SURVEY_STORE: 'shared' }
  const child = spawn('node', ['src/server.js'], { cwd: WT, env, stdio: 'ignore' }); const stop = () => { try { child.kill() } catch {} }; process.on('exit', stop)
  let up = false
  for (let i = 0; i < 70 && !up; i++) { await new Promise(r => setTimeout(r, 1500)); try { up = (await axios.get(SPURL + '/api/health', { timeout: 1500 })).status === 200 } catch {} }
  if (!up) { console.log('SurveyPro did not start'); stop(); process.exit(1) }
  const sp = axios.create({ baseURL: SPURL + '/api', validateStatus: () => true, timeout: 60000 }); const db = new Pool({ connectionString: scratchUrl, max: 2 })
  const vg = new Pool({ connectionString: vungisUrl, max: 1 })
  const reg = async (email, name, lic) => {
    const x = await sp.post('/auth/register', { email, password: 'e2e-pass-1', name, surveyorType: 'registered', licenseNumber: lic, firm: 'E2E' })
    if (x.status !== 201) throw new Error('register ' + x.status + ' ' + JSON.stringify(x.data))
    const t = (await sp.post('/auth/login', { email, password: 'e2e-pass-1' })).data.token
    const id = (await db.query('SELECT id FROM public.users WHERE email=$1', [email])).rows[0].id
    return { id, H: { headers: { Authorization: 'Bearer ' + t } } }
  }
  const S = await reg('s1@e2e.test', 'Surveyor One', 'S-1'); const S2 = await reg('s2@e2e.test', 'Surveyor Two', 'S-2')
  const R = await reg('rev@e2e.test', 'Reviewer', 'R-1'); const HS = await reg('head@e2e.test', 'Head Surveyor', 'H-1')
  const auth = (await db.query("INSERT INTO survey.authority (code,name,kind) VALUES ('VUNGU','Vungu Rural District Council','rural') RETURNING id")).rows[0].id
  const member = (u, role, eng) => db.query('INSERT INTO survey.authority_member (user_id,authority_id,role,engagement) VALUES ($1,$2,$3,$4)', [u.id, auth, role, eng])
  await member(HS, 'head_surveyor', 'employed'); await member(R, 'reviewer', null)
  const sq = (w, s, n = 30) => `POLYGON((${w} ${s}, ${w + n} ${s}, ${w + n} ${s + n}, ${w} ${s + n}, ${w} ${s}))`
  const W = -84035, SS = 2151377
  const mkProject = (who, body) => sp.post('/survey-projects', { name: 'P', clientName: 'C', district: 'Vungu', surveyType: 'Layout survey', surveyDate: '2026-06-01', workingDirectory: 'C:/e2e-shared', ...body }, who.H)

  console.log('private practice')
  let r = await mkProject(S, { name: 'Private job' }); ok(r.status === 201, `a private project is created (${r.status})`)
  const privId = r.data.project.id
  let row = (await db.query('SELECT surveyor_user_id, authority_id, engagement FROM survey.survey_projects WHERE id=$1', [privId])).rows[0]
  ok(row && row.surveyor_user_id === S.id && row.authority_id === null && row.engagement === null, 'it lives in the shared table, as the surveyor\'s own, with no authority')
  ok((await db.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_name='survey_projects'")).rows[0].n >= 2, '(the surveyor\'s private schema still exists beside it, untouched)')
  r = await sp.get('/survey-projects', S.H); ok(r.status === 200 && r.data.projects.some(p => p.id === privId), 'the surveyor sees it in their list')
  r = await sp.get('/survey-projects', S2.H); ok(r.status === 200 && !r.data.projects.some(p => p.id === privId), 'another surveyor does not')
  r = await sp.get(`/survey-projects/${privId}`, S2.H); ok(r.status === 404, 'nor can they open it by id')
  r = await sp.get('/survey-projects', HS.H); ok(!r.data.projects.some(p => p.id === privId), 'a council head surveyor cannot see private practice')
  r = await sp.post('/coordinate-points', { project_id: String(privId), name: 'A1', y: -84000.5, x: 2151300.25 }, S.H); ok(r.status === 200 && r.data.ok, `a point is saved through the API (${r.status})`)
  r = await sp.get(`/coordinate-points?project_id=${privId}`, S.H); ok(r.data.data.length === 1 && r.data.data[0].name === 'A1', 'and read back')
  r = await sp.get(`/coordinate-points?project_id=${privId}`, S2.H); ok(r.status === 200 && r.data.data.length === 0, 'another surveyor reads nothing from it')
  r = await sp.post('/coordinate-points', { project_id: String(privId), name: 'EVIL', y: 1, x: 1 }, S2.H); ok(r.status >= 400, `and cannot write into it (${r.status})`)
  ok((await db.query('SELECT count(*)::int n FROM survey.coordinate_points WHERE project_id=$1', [privId])).rows[0].n === 1, 'nothing was written')

  console.log('\nfor a council')
  r = await mkProject(S, { name: 'Council job', authorityCode: 'VUNGU' }); ok(r.status === 403, `not appointed: refused (${r.status})`)
  await member(S, 'surveyor', 'contracted')
  r = await mkProject(S, { name: 'Council job', authorityCode: 'VUNGU' }); ok(r.status === 201, `appointed: created (${r.status})`)
  const cid = r.data.project.id
  row = (await db.query('SELECT surveyor_user_id, authority_id, engagement FROM survey.survey_projects WHERE id=$1', [cid])).rows[0]
  ok(row.authority_id === auth && row.engagement === 'contracted' && row.surveyor_user_id === S.id, 'it belongs to the council, the engagement comes from the appointment')
  r = await mkProject(S, { name: 'x', authorityCode: 'NOPE' }); ok(r.status === 422, 'an unknown council is refused')
  r = await sp.get('/survey-projects', HS.H); ok(r.data.projects.some(p => p.id === cid), 'the council\'s head surveyor sees it')
  r = await sp.get('/survey-projects', R.H); ok(r.data.projects.some(p => p.id === cid), 'and so does its reviewer')
  r = await sp.get('/survey-projects', S2.H); ok(!r.data.projects.some(p => p.id === cid), 'a surveyor of no council does not')
  r = await sp.post('/coordinate-points', { project_id: String(cid), name: 'EVIL', y: 1, x: 1 }, R.H); ok(r.status >= 400, `a reviewer cannot change it (${r.status})`)
  r = await sp.post('/coordinate-points', { project_id: String(cid), name: 'H1', y: -84001, x: 2151301 }, HS.H); ok(r.status === 200, `the head surveyor can work on it (${r.status})`)

  console.log('\ndelivery on the shared store')
  await db.query('INSERT INTO survey.land_parcels (project_id, stand, designation, status, area_m2, geom) VALUES ($1,$2,$2,$3,900,ST_GeomFromText($4,22289)),($1,$5,$5,$3,900,ST_GeomFromText($6,22289))', [cid, '1', 'finalized', sq(W + 19000, SS), '2', sq(W + 19030, SS)])
  await db.query("UPDATE survey.survey_projects SET township='Shared Township' WHERE id=$1", [cid])
  r = await sp.post(`/survey-projects/${cid}/deliver`, {}, S.H); ok(r.status === 422 && r.data.error === 'no_survey_class', `no class: ${r.status} ${r.data.error}`)
  r = await sp.patch(`/survey-projects/${cid}/survey-class`, { survey_class: 'B' }, S.H); ok(r.status === 200 && r.data.data.survey_class === 'B', 'the class is declared (the column itself)')
  r = await sp.patch(`/survey-projects/${privId}/survey-class`, { survey_class: 'B' }, S2.H); ok(r.status === 404, 'another surveyor cannot declare a class on it')
  r = await sp.post(`/survey-projects/${cid}/deliver`, {}, S2.H); ok(r.status === 404, 'only the project\'s own surveyor can deliver it')
  r = await sp.post(`/survey-projects/${cid}/deliver`, {}, S.H); ok(r.status === 200 && r.data.data.parcels === 2 && r.data.data.shared_project_id === cid, `delivered in place: ${JSON.stringify(r.data)}`)
  ok((await db.query('SELECT count(*)::int n FROM survey.survey_projects WHERE legacy_schema IS NOT NULL')).rows[0].n === 0, 'nothing was copied: there is one dataset')
  r = await sp.post('/coordinate-points', { project_id: String(cid), name: 'LATE', y: 2, x: 2 }, S.H); ok(r.status >= 400, `frozen while with the council: the surveyor cannot change it (${r.status})`)
  r = await sp.post('/coordinate-points', { project_id: String(cid), name: 'LATE', y: 2, x: 2 }, HS.H); ok(r.status >= 400, 'nor the head surveyor')
  r = await sp.patch(`/survey-projects/${cid}/survey-class`, { survey_class: 'C' }, S.H); ok(r.status === 409 && r.data.error === 'frozen', 'nor the class')
  r = await sp.get('/reviews/queue', R.H); ok(r.data.data.length === 1 && r.data.data[0].id === cid, 'the reviewer has it in the queue')
  r = await sp.post(`/reviews/projects/${cid}/decision`, { decision: 'returned', note: 'Add the road beacon' }, R.H); ok(r.status === 201, 'returned with a note')
  r = await sp.post('/coordinate-points', { project_id: String(cid), name: 'ROAD1', y: -84010, x: 2151310 }, S.H); ok(r.status === 200, `a return unfreezes it: the surveyor corrects it (${r.status})`)
  r = await sp.post(`/survey-projects/${cid}/deliver`, {}, S.H); ok(r.status === 200, 'delivered again')
  r = await sp.post(`/survey-projects/${cid}/deliver`, {}, S.H); ok(r.status === 409 && r.data.error === 'awaiting_review', 'not twice while it is with the council')
  r = await sp.post(`/reviews/projects/${cid}/decision`, { decision: 'accepted', note: 'Good' }, S.H); ok(r.status === 403, 'the surveyor cannot accept their own work')
  r = await sp.post(`/reviews/projects/${cid}/decision`, { decision: 'accepted', note: 'Good' }, R.H); ok(r.status === 201, 'accepted')
  r = await sp.post('/coordinate-points', { project_id: String(cid), name: 'AFTER', y: 3, x: 3 }, S.H); ok(r.status >= 400, 'accepted work cannot be changed')
  r = await sp.get(`/survey-projects/${cid}/delivery`, S.H); ok(r.data.data.state === 'accepted', 'the surveyor sees accepted')
  ok((await db.query('SELECT count(*)::int n FROM survey.coordinate_points WHERE project_id=$1', [cid])).rows[0].n === 2, 'the points are the surveyor\'s (H1 and ROAD1 are the head surveyor\'s and the surveyor\'s; nothing late got in)')

  console.log('\nlaunch from a council job')
  // a launch token needs VunGIS's signing key: covered by e2e-launch; here the shared-store insert is exercised directly
  const raw = await db.connect()
  try {
    await raw.query('BEGIN'); await raw.query('SET LOCAL ROLE surveypro_request'); await raw.query("SELECT set_config('app.user_id',$1,true), set_config('search_path','survey, public',true)", [String(S.id)])
    const ins = await raw.query("INSERT INTO survey_projects (name, status, authority_id, engagement, external_job_id, metadata) VALUES ('job','active',$1,'contracted',gen_random_uuid(),'{}'::jsonb) RETURNING id, surveyor_user_id", [auth])
    ok(ins.rows[0].surveyor_user_id === S.id, 'a launched project is the launching surveyor\'s own')
  } finally { await raw.query('ROLLBACK'); raw.release() }

  console.log('\ninto VunGIS')
  spawnSync('node', ['scripts/create-authority-reader.js', '--authority', 'VUNGU', '--apply'], { cwd: WT, env: { ...process.env, DATABASE_URL: scratchUrl }, encoding: 'utf8' })
  const renv = Object.fromEntries(fs.readFileSync(WT + '/.reader-vungu.env', 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(/=(.*)/s).slice(0, 2)))
  const readerUrl = `postgresql://${renv.PGUSER}:${encodeURIComponent(renv.PGPASSWORD)}@${renv.PGHOST}:${renv.PGPORT}/${renv.PGDATABASE}`
  const cli = (...a) => spawnSync('node', ['scripts/import-surveypro.js', ...a], { cwd: ROOT, env: { ...process.env, DATABASE_URL: vungisUrl, SURVEYPRO_DATABASE_URL: readerUrl }, encoding: 'utf8' })
  r = cli('--apply'); ok(r.status === 0 && /2 parcel\(s\) imported/.test(r.stdout), 'the accepted work, read straight from the working dataset, imports as two parcels')
  const rd = new Pool({ connectionString: readerUrl, max: 1 })
  ok((await rd.query('SELECT count(*)::int n FROM survey_share.projects')).rows[0].n === 1, 'the council\'s reader login sees its one project and not the private one')
  await rd.end()
  const c = await vg.connect()
  try {
    await c.query('BEGIN'); await c.query("SET LOCAL gms.purge='on'")
    const ids = (await c.query("SELECT parcel_id FROM land.parcel WHERE source_relation='surveypro' AND source_key LIKE 'VUNGU:%'")).rows.map(x => x.parcel_id)
    if (ids.length) { await c.query('DELETE FROM integration.outbox_event WHERE idempotency_key = ANY($1::text[])', [ids.map(i => 'ParcelCreated:' + i)]); await c.query('DELETE FROM land.parcel WHERE parcel_id = ANY($1::text[])', [ids]) }
    await c.query('COMMIT')
  } finally { c.release() }
  try { fs.unlinkSync(WT + '/.reader-vungu.env') } catch {}
  await vg.end(); await db.end(); stop()
  console.log(bad ? `\n${bad} FAILED` : '\nALL OK'); process.exit(bad ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
