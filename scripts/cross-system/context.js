// Cross-system check: the register around a survey. A surveyor in SurveyPro is shown what VunGIS's register already holds near their work (farms, approved
// stands, the council's own surveyed stands), each with how far to trust it, through a signed service token; only for a council they are appointed to,
// in the belt they work in, within a cap, and when VunGIS cannot be reached it says so and nothing else is affected.
// Run through scripts/cross-system/run.js (it builds the scratch SurveyPro database this expects); see docs/SURVEYPRO-INTEGRATION.md.
const path = require('path')
const ROOT = path.resolve(__dirname, '../..'); process.chdir(ROOT)
const NM = ROOT + '/node_modules/'
const crypto = require('crypto'); const { spawn } = require('child_process')
const axios = require(NM + 'axios'); const { Pool } = require(NM + 'pg'); const Fastify = require(NM + 'fastify'); const fastifyPostgres = require(NM + '@fastify/postgres')
require(NM + 'dotenv').config({ path: ROOT + '/.env', quiet: true })
const vungisUrl = process.env.DATABASE_URL
const scratchUrl = process.env.XS_SCRATCH_URL
if (!/surveypro_scratch/.test(scratchUrl)) throw new Error('not scratch')
const WT = process.env.SURVEYPRO_BACKEND
const SP_PORT = 3063; const VG_PORT = 3064
const TAG = 'cross-system context'
let bad = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++ }

;(async () => {
  const keys = crypto.generateKeyPairSync('ed25519')
  process.env.SURVEYPRO_SERVICE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' })
  const vgApp = Fastify({ logger: false })
  await vgApp.register(fastifyPostgres, { connectionString: vungisUrl })
  const dbContext = require(ROOT + '/src/lib/dbContext'); dbContext.install(vgApp); vgApp.addHook('onRequest', (_r, _p, d) => dbContext.runWithRequest(d))
  await vgApp.register(require(ROOT + '/src/routes/context').contextRoutes, { prefix: '/api' })
  await vgApp.listen({ port: VG_PORT, host: '127.0.0.1' })

  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, PORT: String(SP_PORT), HOST: '127.0.0.1', DATABASE_URL: scratchUrl, APP_DATABASE_URL: process.env.XS_APP_URL || scratchUrl, DB_NAME: process.env.XS_SCRATCH_DB,
    JWT_SECRET: crypto.randomBytes(24).toString('hex'), VUNGIS_API_URL: `http://127.0.0.1:${VG_PORT}`, SURVEYPRO_SERVICE_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n') }
  const child = spawn('node', ['src/server.js'], { cwd: WT, env, stdio: 'ignore' }); const stop = () => { try { child.kill() } catch {} }; process.on('exit', stop)
  let up = false
  for (let i = 0; i < 70 && !up; i++) { await new Promise(r => setTimeout(r, 1500)); try { up = (await axios.get(`http://127.0.0.1:${SP_PORT}/api/health`, { timeout: 1500 })).status === 200 } catch {} }
  if (!up) { console.log('SurveyPro did not start'); stop(); process.exit(1) }
  const sp = axios.create({ baseURL: `http://127.0.0.1:${SP_PORT}/api`, validateStatus: () => true, timeout: 60000 }); const db = new Pool({ connectionString: scratchUrl, max: 2 })
  const vg = new Pool({ connectionString: vungisUrl, max: 1 })

  const W0 = -90500, S0 = 2157000                       // its own patch of ground
  const wipe = async () => { const c = await vg.connect(); try { await c.query('BEGIN'); await c.query("SET LOCAL gms.purge='on'"); await c.query('DELETE FROM land.parcel WHERE source = $1', [TAG]); await c.query('COMMIT') } finally { c.release() } }
  await wipe()                                          // a run that broke off earlier left its parcels
  const gj = (w, s, n = 30) => JSON.stringify({ type: 'Polygon', coordinates: [[[w, s], [w + n, s], [w + n, s + n], [w, s + n], [w, s]]] })
  const seed = async (stand, w, s, { kind = 'stand', origin = 'custodian', sg_ref = null, basis = 'general_plan', est = null, status = 'current', n = 30, ref = null } = {}) =>
    (await vg.query(
      `WITH x AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 922029) AS g)
       INSERT INTO land.parcel (stand_no, township_code, geom_source, source_srid, geom_wgs84, transform_method, transform_accuracy_m, area_m2, accuracy_basis, source, parcel_kind, origin, sg_ref, status, estimated_accuracy_m, cadastre_ref)
       SELECT $2, $3, x.g, 922029, ST_Multi(ST_Transform(x.g, 4326)), 'test', 20, 900, $4, $5, $6, $7, $8, $9, $10, $11 FROM x RETURNING parcel_id`,
      [gj(w, s, n), stand, kind === 'farm' ? null : 'XS-CTX-TOWN', basis, TAG, kind, origin, sg_ref, status, est, ref])).rows[0].parcel_id
  const approved = await seed('1', W0 + 20, S0 + 20, { sg_ref: 'GP 9001' })
  const council = await seed('2', W0 + 70, S0 + 20, { origin: 'authority', basis: 'surveyed' })
  const farm = await seed('F1', W0 + 120, S0 + 10, { kind: 'farm', basis: 'map_digitised', est: 25, n: 80, ref: 'Farm 7' })
  await seed('9', W0 + 20, S0 + 20, { status: 'retired' })              // superseded: never shown
  await seed('10', W0 + 8000, S0 + 8000, { sg_ref: 'GP 9002' })         // far away

  const reg = async (email, name, lic) => {
    const x = await sp.post('/auth/register', { email, password: 'e2e-pass-1', name, surveyorType: 'registered', licenseNumber: lic, firm: 'E2E' }); if (x.status !== 201) throw new Error('register ' + x.status)
    const t = (await sp.post('/auth/login', { email, password: 'e2e-pass-1' })).data.token
    return { id: (await db.query('SELECT id FROM public.users WHERE email=$1', [email])).rows[0].id, H: { headers: { Authorization: 'Bearer ' + t } } }
  }
  const S = await reg('ctx-s@e2e.test', 'Context Surveyor', 'X-1'); const X = await reg('ctx-x@e2e.test', 'Someone Else', 'X-2')
  const auth = (await db.query("INSERT INTO survey.authority (code,name,kind) VALUES ('VUNGU','Vungu RDC','rural') RETURNING id")).rows[0].id
  const schema = (await db.query('SELECT schema_name FROM public.surveyor_profiles WHERE user_id=$1', [S.id])).rows[0].schema_name
  // a project's points are stored in its central meridian's belt (Lo31 unless told otherwise): this patch of ground is in Lo29
  const mk = async (name) => {
    const id = (await sp.post('/survey-projects', { name, clientName: 'Council', district: 'Vungu', surveyType: 'Layout survey', surveyDate: '2026-06-01', workingDirectory: 'C:/xs-ctx' }, S.H)).data.project.id
    await db.query(`UPDATE ${schema}.survey_projects SET central_meridian = '29' WHERE id = $1`, [id])
    return id
  }
  const ours = (r) => (r.data.data ? r.data.data.features : []).filter(f => [approved, council, farm].includes(f.properties.parcel_id))

  console.log('who may ask, and what there is to ask about')
  const pid = await mk('Context layout')
  let r = await sp.post(`/survey-projects/${pid}/context`, { authority_code: 'VUNGU' }, S.H)
  ok(r.status === 403 && r.data.error === 'not_appointed', `a surveyor not appointed to the council is refused before VunGIS is asked (${r.status} ${r.data.error})`)
  await db.query("INSERT INTO survey.authority_member (user_id,authority_id,role,engagement) VALUES ($1,$2,'surveyor','contracted')", [S.id, auth])
  r = await sp.post(`/survey-projects/${pid}/context`, {}, S.H); ok(r.status === 422 && r.data.error === 'authority_required', 'a project for no council says which is needed')
  r = await sp.post(`/survey-projects/${pid}/context`, { authority_code: 'VUNGU' }, S.H)
  ok(r.status === 422 && r.data.error === 'no_location' && /nothing to place yet/.test(r.data.message), `a project with no points and no job has nowhere to look: ${r.data.message}`)
  r = await sp.post(`/survey-projects/${pid}/context`, { authority_code: 'VUNGU' }, X.H); ok(r.status === 404, 'somebody else cannot ask about it (not found)')
  r = await sp.post(`/survey-projects/${pid}/context`, { authority_code: 'VUNGU' }); ok(r.status === 401, 'nobody signed in is refused')

  console.log('\nthe register around the surveyor\'s points')
  for (const [name, w, s] of [['A1', W0 + 10, S0 + 10], ['A2', W0 + 150, S0 + 60]]) {
    const p = await sp.post('/coordinate-points', { project_id: String(pid), name, y: w, x: s }, S.H); if (p.status !== 200) throw new Error('point ' + p.status)
  }
  r = await sp.post(`/survey-projects/${pid}/context`, { authority_code: 'VUNGU', buffer_m: 0 }, S.H)
  ok(r.status === 200 && r.data.data.lo_zone === 29 && r.data.data.srid === 922029, `the belt is the one the points are in (${r.status}, Lo${r.data.data && r.data.data.lo_zone})`)
  const by = Object.fromEntries(ours(r).map(f => [f.properties.parcel_id, f.properties]))
  ok(by[approved] && by[approved].quality === 'approved' && by[approved].sg_ref === 'GP 9001', 'an approved stand, with its plan')
  ok(by[council] && by[council].quality === 'council_survey' && by[council].origin === 'authority', 'the council\'s own survey, awaiting approval')
  ok(by[farm] && by[farm].quality === 'indicative' && by[farm].kind === 'farm' && by[farm].farm_ref === 'Farm 7' && by[farm].indicative_m === 25, 'a digitised farm, flagged indicative with how far out it may be')
  ok(!r.data.data.features.some(f => f.properties.stand_no === '10') && !r.data.data.features.some(f => f.properties.status === 'retired') && ours(r).filter(f => f.properties.stand_no === '9').length === 0, 'what is far away, and what has been superseded, is not shown')
  const g = ours(r).find(f => f.properties.parcel_id === approved).geometry.coordinates[0][0]
  ok(g[0] === W0 + 20 && g[1] === S0 + 20, 'the outline is in the surveyor\'s belt, westing then southing, exactly as stored')
  ok(JSON.stringify(r.data.data).indexOf('owner') < 0 && !JSON.stringify(r.data.data).match(/"band"|account/i), 'public facts only')

  console.log('\na job from the council, nothing surveyed yet')
  const jid = await mk('Job, not yet surveyed')
  const centre = (await vg.query("SELECT ST_X(ST_Centroid(geom_wgs84)) AS lon, ST_Y(ST_Centroid(geom_wgs84)) AS lat FROM land.parcel WHERE parcel_id = $1", [approved])).rows[0]
  await db.query(`UPDATE ${schema}.survey_projects SET central_meridian = '29', metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [jid, JSON.stringify({ authority_code: 'VUNGU', vungis: { location: { lon: centre.lon, lat: centre.lat } } })])
  r = await sp.post(`/survey-projects/${jid}/context`, {}, S.H)
  ok(r.status === 200 && ours(r).some(f => f.properties.parcel_id === approved), 'the job\'s own location is where it looks, in the job\'s belt')

  console.log('\nlimits')
  const wide = await mk('Too wide')
  for (const [name, w, s] of [['W1', W0, S0], ['W2', W0 + 9000, S0]]) await sp.post('/coordinate-points', { project_id: String(wide), name, y: w, x: s }, S.H)
  r = await sp.post(`/survey-projects/${wide}/context`, { authority_code: 'VUNGU' }, S.H)
  ok(r.status === 422 && r.data.error === 'area_too_large' && /6000 m/.test(r.data.message), `a survey wider than the cap is told so, in VunGIS's words (${r.status} ${r.data.error})`)

  console.log('\nwhen VunGIS cannot be reached')
  await vgApp.close()
  r = await sp.post(`/survey-projects/${pid}/context`, { authority_code: 'VUNGU' }, S.H)
  ok(r.status === 502 && r.data.error === 'register_unreachable', `it says so, and the browser keeps its own copy (${r.status} ${r.data.error})`)
  r = await sp.get(`/coordinate-points?project_id=${pid}`, S.H); ok(r.status === 200 && r.data.data.length === 2, 'the rest of SurveyPro carries on')

  await wipe()
  await vg.end(); await db.end(); stop()
  console.log(bad ? `\n${bad} FAILED` : '\nALL OK'); process.exit(bad ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
