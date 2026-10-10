// Cross-system check: The surveyor declares the SI 727 class in SurveyPro; it reaches the council's view and the VunGIS importer.
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
const PORT = 3056; const SPURL = `http://127.0.0.1:${PORT}`
let bad = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++ }

;(async () => {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL: scratchUrl, APP_DATABASE_URL: process.env.XS_APP_URL || scratchUrl, DB_NAME: process.env.XS_SCRATCH_DB,
    JWT_SECRET: crypto.randomBytes(24).toString('hex') }
  const child = spawn('node', ['src/server.js'], { cwd: WT, env, stdio: 'ignore' }); const stop = () => { try { child.kill() } catch {} }; process.on('exit', stop)
  let up = false
  for (let i = 0; i < 70 && !up; i++) { await new Promise(r => setTimeout(r, 1500)); try { up = (await axios.get(SPURL + '/api/health', { timeout: 1500 })).status === 200 } catch {} }
  if (!up) { console.log('SurveyPro did not start'); stop(); process.exit(1) }
  const sp = axios.create({ baseURL: SPURL + '/api', validateStatus: () => true, timeout: 60000 }); const db = new Pool({ connectionString: scratchUrl, max: 2 })
  const vg = new Pool({ connectionString: vungisUrl, max: 1 })

  console.log('the surveyor declares the class through the API')
  let r = await sp.post('/auth/register', { email: 'class@e2e.test', password: 'e2e-pass-1', name: 'Class Tester', surveyorType: 'registered', licenseNumber: 'CT-1', firm: 'E2E' })
  ok(r.status === 201, `registered (${r.status})`)
  const token = (await sp.post('/auth/login', { email: 'class@e2e.test', password: 'e2e-pass-1' })).data.token; const H = { headers: { Authorization: 'Bearer ' + token } }
  r = await sp.post('/survey-projects', { name: 'Class layout', clientName: 'Council', district: 'Vungu', surveyType: 'Layout survey', surveyDate: '2026-06-01', workingDirectory: 'C:/e2e-class' }, H)
  const pid = r.data && (r.data.data?.id ?? r.data.project?.id ?? r.data.id)
  ok(r.status < 300 && pid, `a project is created (${r.status}, id ${pid})`)
  r = await sp.patch(`/survey-projects/${pid}/survey-class`, { survey_class: 'A' }, H)
  ok(r.status === 400, `class A is refused: it is surveys of town survey-marks, not parcels (${r.status})`)
  r = await sp.patch(`/survey-projects/${pid}/survey-class`, { survey_class: 'C' }, H)
  ok(r.status === 200 && r.data.data.survey_class === 'C', `class C is declared (${r.status})`)
  r = await sp.get(`/survey-projects/${pid}`, H)
  const meta = (r.data.data || r.data.project || r.data).metadata
  ok(meta && meta.survey_class === 'C', 'and the project carries it')
  r = await sp.patch(`/survey-projects/${pid}/survey-class`, { survey_class: null }, H)
  ok(r.status === 200 && r.data.data.survey_class === null, 'it can be cleared')
  r = await sp.patch(`/survey-projects/${pid}/survey-class`, { survey_class: 'B' }, H)
  ok(r.status === 200 && r.data.data.survey_class === 'B', 'and set to B')
  r = await sp.patch('/survey-projects/999999/survey-class', { survey_class: 'B' }, H)
  ok(r.status === 404, 'a project that is not the surveyor\'s own is not found')
  r = await sp.patch(`/survey-projects/${pid}/survey-class`, { survey_class: 'B' })
  ok(r.status === 401, 'nobody signed in is refused')

  console.log('\nadopted into the shared tables, the council sees it')
  const uid = (await db.query("SELECT id FROM public.users WHERE email='class@e2e.test'")).rows[0].id
  const schema = (await db.query('SELECT schema_name FROM public.surveyor_profiles WHERE user_id=$1', [uid])).rows[0].schema_name
  const sq = (w, s, n = 30) => `POLYGON((${w} ${s}, ${w + n} ${s}, ${w + n} ${s + n}, ${w} ${s + n}, ${w} ${s}))`
  const W = -84035, S = 2151377
  await db.query(`UPDATE ${schema}.survey_projects SET metadata = metadata || '{"authority_code":"VUNGU","engagement":"contracted"}'::jsonb, township = 'Class Township' WHERE id = $1`, [pid])
  await db.query(`INSERT INTO ${schema}.land_parcels (project_id, stand, designation, status, area_m2, geom) VALUES ($1,'1','1','finalized',900,ST_GeomFromText($2,22289)),($1,'2','2','finalized',900,ST_GeomFromText($3,22289))`, [pid, sq(W + 15000, S), sq(W + 15030, S)])
  const auth = (await db.query("INSERT INTO survey.authority (code,name,kind) VALUES ('VUNGU','Vungu Rural District Council','rural') RETURNING id")).rows[0].id
  const reviewer = (await db.query("INSERT INTO public.users (email,password_hash,user_type) VALUES ('rev@e2e.test','x','registered_surveyor') RETURNING id")).rows[0].id
  await db.query("INSERT INTO survey.authority_member (user_id,authority_id,role,engagement) VALUES ($1,$2,'reviewer',NULL)", [reviewer, auth])
  const moved = (await db.query('SELECT * FROM survey.adopt_surveyor_schema($1,$2,$3,$4)', [schema, uid, auth, 'contracted'])).rows
  const row = (await db.query('SELECT id, survey_class, authority_id, engagement FROM survey.survey_projects WHERE legacy_schema=$1', [schema])).rows[0]
  ok(row.survey_class === 'B' && row.authority_id === auth && row.engagement === 'contracted', `the column holds the declared class (${row.survey_class}), promoted from the project's metadata, with the council and engagement named at adoption`)
  await db.query("UPDATE survey.survey_projects SET delivered_at = now() - interval '1 day' WHERE id=$1", [row.id])
  await db.query("INSERT INTO survey.project_review (project_id, decision, reviewer_user_id) VALUES ($1,'accepted',$2)", [row.id, reviewer])

  const mk = spawnSync('node', ['scripts/create-authority-reader.js', '--authority', 'VUNGU', '--apply'], { cwd: WT, env: { ...process.env, DATABASE_URL: scratchUrl }, encoding: 'utf8' })
  const renv = Object.fromEntries(fs.readFileSync(WT + '/.reader-vungu.env', 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(/=(.*)/s).slice(0, 2)))
  const readerUrl = `postgresql://${renv.PGUSER}:${encodeURIComponent(renv.PGPASSWORD)}@${renv.PGHOST}:${renv.PGPORT}/${renv.PGDATABASE}`
  const rd = new Pool({ connectionString: readerUrl, max: 1 })
  const shared = (await rd.query('SELECT survey_class FROM survey_share.projects')).rows
  ok(shared.length === 1 && shared[0].survey_class === 'B', `the council's share view carries it (${JSON.stringify(shared)})`)
  await rd.end()

  console.log('\nthe VunGIS importer')
  const cli = (...a) => spawnSync('node', ['scripts/import-surveypro.js', ...a], { cwd: ROOT, env: { ...process.env, DATABASE_URL: vungisUrl, SURVEYPRO_DATABASE_URL: readerUrl }, encoding: 'utf8' })
  r = cli('--apply')
  ok(r.status === 0 && /2 parcel\(s\) imported/.test(r.stdout), 'two parcels imported')
  const p = (await vg.query("SELECT survey_class, origin, sg_ref FROM land.parcel WHERE source_relation='surveypro' ORDER BY stand_no")).rows
  ok(p.length === 2 && p.every(x => x.survey_class === 'B' && x.origin === 'authority' && x.sg_ref === null), 'each carries the declared SI 727 class B; its state is in origin and sg_ref')

  // a second project that never declared a class
  r = await sp.post('/survey-projects', { name: 'No class', clientName: 'Council', district: 'Vungu', surveyType: 'Layout survey', surveyDate: '2026-06-01', workingDirectory: 'C:/e2e-class2' }, H)
  const pid2 = r.data && (r.data.data?.id ?? r.data.project?.id ?? r.data.id)
  await db.query(`UPDATE ${schema}.survey_projects SET metadata = COALESCE(metadata,'{}'::jsonb) || '{"authority_code":"VUNGU","engagement":"contracted"}'::jsonb, township='Class Township' WHERE id=$1`, [pid2])
  await db.query(`INSERT INTO ${schema}.land_parcels (project_id, stand, designation, status, area_m2, geom) VALUES ($1,'9','9','finalized',900,ST_GeomFromText($2,22289))`, [pid2, sq(W + 16000, S)])
  await db.query('SELECT * FROM survey.adopt_surveyor_schema($1,$2,$3,$4)', [schema, uid, auth, 'contracted'])
  const id2 = (await db.query('SELECT id FROM survey.survey_projects WHERE legacy_schema=$1 AND legacy_id=$2', [schema, pid2])).rows[0].id
  await db.query("UPDATE survey.survey_projects SET delivered_at = now() - interval '1 day' WHERE id=$1", [id2])
  await db.query("INSERT INTO survey.project_review (project_id, decision, reviewer_user_id) VALUES ($1,'accepted',$2)", [id2, reviewer])
  r = cli('--apply')
  ok(r.status === 1 && /no_survey_class/.test(r.stdout), 'a project that never declared a class is refused with that reason (exit 1)')
  ok((await vg.query("SELECT count(*)::int n FROM land.parcel WHERE source_relation='surveypro'")).rows[0].n === 2, '…and its parcel is not imported')

  // clean up VunGIS
  const c = await vg.connect()
  try { await c.query('BEGIN'); await c.query("SET LOCAL gms.purge='on'")
    const ids = (await c.query("SELECT parcel_id FROM land.parcel WHERE source_relation='surveypro' AND source_key LIKE 'VUNGU:%'")).rows.map(x => x.parcel_id)
    if (ids.length) { await c.query('DELETE FROM integration.outbox_event WHERE idempotency_key = ANY($1::text[])', [ids.map(i => 'ParcelCreated:' + i)]); await c.query('DELETE FROM land.parcel WHERE parcel_id = ANY($1::text[])', [ids]) }
    await c.query('COMMIT') } finally { c.release() }
  try { fs.unlinkSync(WT + '/.reader-vungu.env') } catch {}
  await vg.end(); await db.end(); stop()
  console.log(bad ? `\n${bad} FAILED` : '\nALL OK'); process.exit(bad ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
