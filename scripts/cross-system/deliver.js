// Cross-system check: Delivery and review in schema mode: deliver, return, redeliver, accept, then the VunGIS importer.
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
const PORT = 3057; const SPURL = `http://127.0.0.1:${PORT}`
let bad = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++ }

;(async () => {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL: scratchUrl, DB_NAME: process.env.XS_SCRATCH_DB,
    JWT_SECRET: crypto.randomBytes(24).toString('hex') }
  const child = spawn('node', ['src/server.js'], { cwd: WT, env, stdio: 'ignore' }); const stop = () => { try { child.kill() } catch {} }; process.on('exit', stop)
  let up = false
  for (let i = 0; i < 70 && !up; i++) { await new Promise(r => setTimeout(r, 1500)); try { up = (await axios.get(SPURL + '/api/health', { timeout: 1500 })).status === 200 } catch {} }
  if (!up) { console.log('SurveyPro did not start'); stop(); process.exit(1) }
  const sp = axios.create({ baseURL: SPURL + '/api', validateStatus: () => true, timeout: 60000 }); const db = new Pool({ connectionString: scratchUrl, max: 2 })
  const vg = new Pool({ connectionString: vungisUrl, max: 1 })

  const reg = async (email, name, lic) => {
    const x = await sp.post('/auth/register', { email, password: 'e2e-pass-1', name, surveyorType: 'registered', licenseNumber: lic, firm: 'E2E' })
    if (x.status !== 201) throw new Error('register ' + x.status)
    const t = (await sp.post('/auth/login', { email, password: 'e2e-pass-1' })).data.token
    const id = (await db.query('SELECT id FROM public.users WHERE email=$1', [email])).rows[0].id
    return { id, H: { headers: { Authorization: 'Bearer ' + t } } }
  }
  const S = await reg('deliv@e2e.test', 'Deliverer', 'D-1'); const R = await reg('review@e2e.test', 'Reviewer', 'R-1'); const X = await reg('other@e2e.test', 'Other', 'X-1')
  const schema = (await db.query('SELECT schema_name FROM public.surveyor_profiles WHERE user_id=$1', [S.id])).rows[0].schema_name
  const sq = (w, s, n = 30) => `POLYGON((${w} ${s}, ${w + n} ${s}, ${w + n} ${s + n}, ${w} ${s + n}, ${w} ${s}))`
  const W = -84035, SS = 2151377
  const auth = (await db.query("INSERT INTO survey.authority (code,name,kind) VALUES ('VUNGU','Vungu Rural District Council','rural') RETURNING id")).rows[0].id

  console.log('a project is made ready')
  let r = await sp.post('/survey-projects', { name: 'Delivery layout', clientName: 'Council', district: 'Vungu', surveyType: 'Layout survey', surveyDate: '2026-06-01', workingDirectory: 'C:/e2e-deliv' }, S.H)
  const pid = r.data.data?.id ?? r.data.project?.id ?? r.data.id
  await db.query(`UPDATE ${schema}.survey_projects SET township = 'Delivery Township' WHERE id = $1`, [pid])
  const addParcel = (stand, off, status = 'finalized') => db.query(`INSERT INTO ${schema}.land_parcels (project_id, stand, designation, status, area_m2, geom) VALUES ($1,$2,$2,$3,900,ST_GeomFromText($4,22289))`, [pid, stand, status, sq(W + 18000 + off, SS)])
  await addParcel('1', 0); await addParcel('2', 30); await addParcel('3', 60, 'draft')
  r = await sp.get(`/survey-projects/${pid}/delivery`, S.H); ok(r.status === 200 && r.data.data.state === 'not_delivered', 'before delivery its state is not_delivered')

  console.log('\nwhat delivery refuses')
  r = await sp.post(`/survey-projects/${pid}/deliver`, {}, S.H); ok(r.status === 422 && r.data.error === 'authority_required', `no council named (${r.status} ${r.data.error})`)
  r = await sp.post(`/survey-projects/${pid}/deliver`, { authority_code: 'NOPE' }, S.H); ok(r.status === 422 && r.data.error === 'unknown_authority', 'an unknown council')
  r = await sp.post(`/survey-projects/${pid}/deliver`, { authority_code: 'VUNGU' }, S.H); ok(r.status === 403 && r.data.error === 'not_appointed', `not appointed (${r.status} ${r.data.error})`)
  await db.query("INSERT INTO survey.authority_member (user_id,authority_id,role,engagement) VALUES ($1,$2,'surveyor','contracted')", [S.id, auth])
  await db.query("INSERT INTO survey.authority_member (user_id,authority_id,role,engagement) VALUES ($1,$2,'reviewer',NULL)", [R.id, auth])
  r = await sp.post(`/survey-projects/${pid}/deliver`, { authority_code: 'VUNGU' }, S.H); ok(r.status === 422 && r.data.error === 'no_survey_class', `no class declared (${r.status} ${r.data.error})`)
  await sp.patch(`/survey-projects/${pid}/survey-class`, { survey_class: 'B' }, S.H)
  r = await sp.post('/survey-projects/999999/deliver', { authority_code: 'VUNGU' }, S.H); ok(r.status === 404, "a project that is not the surveyor's own is not found")
  r = await sp.post(`/survey-projects/${pid}/deliver`, { authority_code: 'VUNGU' }); ok(r.status === 401, 'nobody signed in is refused')
  r = await sp.post(`/survey-projects/${pid}/deliver`, { authority_code: 'VUNGU' }, X.H); ok(r.status >= 400 && r.status !== 500, `somebody else cannot deliver it (${r.status})`)

  console.log('\ndelivery')
  r = await sp.post(`/survey-projects/${pid}/deliver`, { authority_code: 'VUNGU' }, S.H)
  ok(r.status === 200 && r.data.data.parcels === 2 && r.data.data.state === 'awaiting_review', `delivered: ${JSON.stringify(r.data)}`)
  const sid = r.data.data.shared_project_id
  const shp = (await db.query('SELECT authority_id, engagement, survey_class, delivered_at FROM survey.survey_projects WHERE id=$1', [sid])).rows[0]
  ok(shp.authority_id === auth && shp.engagement === 'contracted' && shp.survey_class === 'B' && shp.delivered_at, 'the shared project has the council, the engagement from the appointment, the class and the time')
  ok((await db.query('SELECT count(*)::int n FROM survey.land_parcels WHERE project_id=$1', [sid])).rows[0].n === 3, "the snapshot holds the surveyor's parcels")
  ok((await db.query('SELECT count(*)::int n FROM survey.survey_projects WHERE legacy_schema=$1', [schema])).rows[0].n === 1, 'only this project was copied')
  r = await sp.post(`/survey-projects/${pid}/deliver`, { authority_code: 'VUNGU' }, S.H); ok(r.status === 409 && r.data.error === 'awaiting_review', 'delivering again while it awaits review is refused')
  r = await sp.get(`/survey-projects/${pid}/delivery`, S.H); ok(r.data.data.state === 'awaiting_review', 'its state is awaiting_review')

  console.log('\nreview')
  r = await sp.get('/reviews/queue', R.H); ok(r.status === 200 && r.data.data.length === 1 && r.data.data[0].id === sid && r.data.data[0].parcels === 2, `the reviewer's queue has it (${JSON.stringify(r.data.data && r.data.data.map(x => [x.id, x.parcels]))})`)
  r = await sp.get('/reviews/queue', S.H); ok(r.status === 200 && r.data.data.length === 0, "the surveyor's own queue does not (never their own work)")
  r = await sp.get('/reviews/queue', X.H); ok(r.status === 200 && r.data.data.length === 0, "a stranger's queue is empty")
  r = await sp.get(`/reviews/projects/${sid}`, R.H); ok(r.status === 200 && r.data.data.can_decide === true && r.data.data.parcels.length === 3 && r.data.data.reviews.length === 0, 'the reviewer sees the project, its parcels and no decisions yet')
  r = await sp.get(`/reviews/projects/${sid}`, X.H); ok(r.status === 404, 'a stranger cannot see it')
  r = await sp.post(`/reviews/projects/${sid}/decision`, { decision: 'accepted' }, S.H); ok(r.status === 403, `the surveyor cannot accept their own work (${r.status})`)
  r = await sp.post(`/reviews/projects/${sid}/decision`, { decision: 'accepted' }, X.H); ok(r.status === 403, 'a stranger cannot decide')
  r = await sp.post(`/reviews/projects/${sid}/decision`, { decision: 'returned' }, R.H); ok(r.status === 422 && r.data.error === 'note_required', 'a return needs a note')
  r = await sp.post(`/reviews/projects/${sid}/decision`, { decision: 'maybe' }, R.H); ok(r.status === 400, 'an unknown decision is refused')
  r = await sp.post(`/reviews/projects/${sid}/decision`, { decision: 'returned', note: 'Stand 2 overlaps the road reserve' }, R.H); ok(r.status === 201, 'returned with a note')
  r = await sp.post(`/reviews/projects/${sid}/decision`, { decision: 'accepted' }, R.H); ok(r.status === 409 && r.data.error === 'already_decided', 'a delivery is decided once')
  r = await sp.get(`/survey-projects/${pid}/delivery`, S.H); ok(r.data.data.state === 'returned' && /road reserve/.test(r.data.data.note), 'the surveyor sees it returned, and why')
  r = await sp.get('/reviews/queue', R.H); ok(r.data.data.length === 0, 'it has left the queue')

  console.log('\nre-delivery after a return')
  await db.query(`UPDATE ${schema}.land_parcels SET status='finalized' WHERE project_id=$1 AND stand='3'`, [pid])
  await db.query(`DELETE FROM ${schema}.land_parcels WHERE project_id=$1 AND stand='2'`, [pid])
  r = await sp.post(`/survey-projects/${pid}/deliver`, { authority_code: 'VUNGU' }, S.H); ok(r.status === 200 && r.data.data.parcels === 2 && r.data.data.shared_project_id === sid, `delivered again, same shared project (${r.status})`)
  ok((await db.query("SELECT string_agg(stand, ',' ORDER BY stand) s FROM survey.land_parcels WHERE project_id=$1", [sid])).rows[0].s === '1,3', 'the snapshot was replaced by the corrected work')
  ok((await db.query('SELECT count(*)::int n FROM survey.project_review WHERE project_id=$1', [sid])).rows[0].n === 1, 'and the earlier decision is still on record')
  r = await sp.get('/reviews/queue', R.H); ok(r.data.data.length === 1, 'it is in the queue again')
  r = await sp.post(`/reviews/projects/${sid}/decision`, { decision: 'accepted', note: 'Corrected' }, R.H); ok(r.status === 201, 'accepted')
  r = await sp.get(`/survey-projects/${pid}/delivery`, S.H); ok(r.data.data.state === 'accepted', 'the surveyor sees it accepted')
  r = await sp.post(`/survey-projects/${pid}/deliver`, { authority_code: 'VUNGU' }, S.H); ok(r.status === 409 && r.data.error === 'already_accepted', 'an accepted project cannot be delivered again')
  r = await sp.get(`/reviews/projects/${sid}`, R.H); ok(r.data.data.reviews.length === 2 && r.data.data.can_decide === false, 'two decisions on record; nothing left to decide')

  console.log('\nthe guard below the API')
  const raw = await db.connect()
  try {
    await raw.query('BEGIN'); await raw.query('SET LOCAL ROLE surveypro_request'); await raw.query("SELECT set_config('app.user_id',$1,true)", [String(R.id)])
    let e; try { await raw.query("INSERT INTO survey.project_review (project_id,decision) VALUES ($1,'accepted')", [sid]) } catch (x) { e = x }
    ok(e && /already_decided/.test(e.message), 'a second decision on the same delivery is refused by the database itself')
  } finally { await raw.query('ROLLBACK'); raw.release() }

  console.log('\ninto VunGIS')
  spawnSync('node', ['scripts/create-authority-reader.js', '--authority', 'VUNGU', '--apply'], { cwd: WT, env: { ...process.env, DATABASE_URL: scratchUrl }, encoding: 'utf8' })
  const renv = Object.fromEntries(fs.readFileSync(WT + '/.reader-vungu.env', 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(/=(.*)/s).slice(0, 2)))
  const readerUrl = `postgresql://${renv.PGUSER}:${encodeURIComponent(renv.PGPASSWORD)}@${renv.PGHOST}:${renv.PGPORT}/${renv.PGDATABASE}`
  const cli = (...a) => spawnSync('node', ['scripts/import-surveypro.js', ...a], { cwd: ROOT, env: { ...process.env, DATABASE_URL: vungisUrl, SURVEYPRO_DATABASE_URL: readerUrl }, encoding: 'utf8' })
  r = cli('--apply'); ok(r.status === 0 && /2 parcel\(s\) imported/.test(r.stdout), 'the accepted delivery imports as two parcels: ' + (r.stdout || r.stderr || '').split('\n').slice(-4).join(' | '))
  const p = (await vg.query("SELECT survey_class, accuracy_basis, origin FROM land.parcel WHERE source_relation='surveypro' ORDER BY stand_no")).rows
  ok(p.length === 2 && p.every(x => x.survey_class === 'B' && x.accuracy_basis === 'surveyed' && x.origin === 'authority'), 'carrying the declared class B')

  console.log('\nthe Surveyor-General approves the plan')
  // the approved plan arrives for the same township with the same boundaries: the council's stands are adopted in place, not duplicated or refused
  const { importGeneralPlan } = require(ROOT + '/src/services/gms/parcelImport')
  const before = (await vg.query("SELECT parcel_id, stand_no, township_code, source_srid, ST_AsGeoJSON(geom_source)::json AS g FROM land.parcel WHERE source_relation='surveypro' ORDER BY stand_no")).rows
  const plan = await importGeneralPlan(vg, { sg_ref: 'XS-ADOPT', township_code: before[0].township_code, source_srid: before[0].source_srid, commit: true,
    features: before.map(b => ({ type: 'Feature', properties: { stand_no: b.stand_no }, geometry: b.g })) }, { id: null })
  ok(plan.ok && plan.adopted_ids.length === 2 && plan.parcel_ids.length === 0, `both stands are adopted in place (${JSON.stringify(plan.report && plan.report.summary)})`)
  const after = (await vg.query("SELECT parcel_id, origin, sg_ref FROM land.parcel WHERE source_relation='surveypro' ORDER BY stand_no")).rows
  ok(after.length === 2 && after.every((a, i) => a.parcel_id === before[i].parcel_id && a.origin === 'custodian' && a.sg_ref === 'XS-ADOPT'), 'same parcel ids, now approved')
  r = cli('--apply')
  ok(r.status === 0 && /0 diverged/.test(r.stdout) && /2 already in the register/.test(r.stdout), 'SurveyPro\'s importer then sees them as approved, not diverged: ' + (r.stdout || '').split('\n').slice(-3).join(' | '))

  const c = await vg.connect()
  try {
    await c.query('BEGIN'); await c.query("SET LOCAL gms.purge='on'")
    const ids = (await c.query("SELECT parcel_id FROM land.parcel WHERE source_relation='surveypro' AND source_key LIKE 'VUNGU:%'")).rows.map(x => x.parcel_id)
    if (ids.length) {
      await c.query('DELETE FROM land.parcel_event WHERE parcel_id = ANY($1::text[])', [ids])
      await c.query('DELETE FROM integration.outbox_event WHERE idempotency_key = ANY($1::text[]) OR idempotency_key LIKE $2', [ids.map(i => 'ParcelCreated:' + i), 'ParcelApproved:%:XS-ADOPT'])
      await c.query('DELETE FROM land.parcel WHERE parcel_id = ANY($1::text[])', [ids])
      await c.query("DELETE FROM land.general_plan WHERE sg_ref = 'XS-ADOPT'")
    }
    await c.query('COMMIT')
  } finally { c.release() }
  try { fs.unlinkSync(WT + '/.reader-vungu.env') } catch {}
  await vg.end(); await db.end(); stop()
  console.log(bad ? `\n${bad} FAILED` : '\nALL OK'); process.exit(bad ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
