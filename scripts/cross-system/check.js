// Cross-system check: the layout check. A surveyor and a reviewer in SurveyPro ask VunGIS whether the register would take a layout, through a signed
// service token; the check is advisory (delivery does not depend on it) and agrees with what VunGIS's importer then does.
// Run through scripts/cross-system/run.js (it builds the scratch SurveyPro database this expects); see docs/SURVEYPRO-INTEGRATION.md.
const path = require('path')
const ROOT = path.resolve(__dirname, '../..'); process.chdir(ROOT)
const NM = ROOT + '/node_modules/'
const fs = require('fs'); const crypto = require('crypto'); const { spawn, spawnSync } = require('child_process')
const axios = require(NM + 'axios'); const { Pool } = require(NM + 'pg'); const Fastify = require(NM + 'fastify'); const fastifyPostgres = require(NM + '@fastify/postgres')
require(NM + 'dotenv').config({ path: ROOT + '/.env', quiet: true })
const vungisUrl = process.env.DATABASE_URL
const scratchUrl = process.env.XS_SCRATCH_URL
if (!/surveypro_scratch/.test(scratchUrl)) throw new Error('not scratch')
const WT = process.env.SURVEYPRO_BACKEND
const SP_PORT = 3061; const VG_PORT = 3062
let bad = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++ }

;(async () => {
  // ---- VunGIS: the real route and the real register, listening, with SurveyPro's public key -----------------------------------------
  const keys = crypto.generateKeyPairSync('ed25519')
  process.env.SURVEYPRO_SERVICE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' })
  const vgApp = Fastify({ logger: false })
  await vgApp.register(fastifyPostgres, { connectionString: vungisUrl })
  const dbContext = require(ROOT + '/src/lib/dbContext'); dbContext.install(vgApp); vgApp.addHook('onRequest', (_r, _p, d) => dbContext.runWithRequest(d))
  await vgApp.register(require(ROOT + '/src/routes/context').contextRoutes, { prefix: '/api' })
  await vgApp.listen({ port: VG_PORT, host: '127.0.0.1' })
  let vgUp = true

  // ---- SurveyPro, a separate process on the scratch database, told where VunGIS is and how to sign ---------------------------------------
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, PORT: String(SP_PORT), HOST: '127.0.0.1', DATABASE_URL: scratchUrl, APP_DATABASE_URL: process.env.XS_APP_URL || scratchUrl, DB_NAME: process.env.XS_SCRATCH_DB,
    JWT_SECRET: crypto.randomBytes(24).toString('hex'), VUNGIS_API_URL: `http://127.0.0.1:${VG_PORT}`,
    SURVEYPRO_SERVICE_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n') }
  const child = spawn('node', ['src/server.js'], { cwd: WT, env, stdio: 'ignore' }); const stop = () => { try { child.kill() } catch {} }; process.on('exit', stop)
  let up = false
  for (let i = 0; i < 70 && !up; i++) { await new Promise(r => setTimeout(r, 1500)); try { up = (await axios.get(`http://127.0.0.1:${SP_PORT}/api/health`, { timeout: 1500 })).status === 200 } catch {} }
  if (!up) { console.log('SurveyPro did not start'); stop(); process.exit(1) }
  const sp = axios.create({ baseURL: `http://127.0.0.1:${SP_PORT}/api`, validateStatus: () => true, timeout: 60000 }); const db = new Pool({ connectionString: scratchUrl, max: 2 })
  const vg = new Pool({ connectionString: vungisUrl, max: 1 })

  const TOWN = 'XS-CHECK-TOWN'
  const W0 = -88000, S0 = 2155000
  const poly = (w, s, n = 30) => `POLYGON((${w} ${s}, ${w + n} ${s}, ${w + n} ${s + n}, ${w} ${s + n}, ${w} ${s}))`
  const gj = (w, s, n = 30) => JSON.stringify({ type: 'Polygon', coordinates: [[[w, s], [w + n, s], [w + n, s + n], [w, s + n], [w, s]]] })

  // what is already in VunGIS's register: stand 1 and stand 9 of the township, approved
  const seed = (stand, w, s) => vg.query(
    `WITH x AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 922029) AS g)
     INSERT INTO land.parcel (stand_no, township_code, geom_source, source_srid, geom_wgs84, transform_method, transform_accuracy_m, area_m2, accuracy_basis, source, parcel_kind, origin)
     SELECT $2, $3, x.g, 922029, ST_Multi(ST_Transform(x.g, 4326)), 'test', 20, 900, 'general_plan', 'cross-system check', 'stand', 'custodian' FROM x RETURNING parcel_id`, [gj(w, s), stand, TOWN])
  const held1 = (await seed('1', W0 + 1000, S0)).rows[0].parcel_id
  const held9 = (await seed('9', W0 + 2000, S0)).rows[0].parcel_id

  const reg = async (email, name, lic) => {
    const x = await sp.post('/auth/register', { email, password: 'e2e-pass-1', name, surveyorType: 'registered', licenseNumber: lic, firm: 'E2E' }); if (x.status !== 201) throw new Error('register ' + x.status)
    const t = (await sp.post('/auth/login', { email, password: 'e2e-pass-1' })).data.token
    return { id: (await db.query('SELECT id FROM public.users WHERE email=$1', [email])).rows[0].id, H: { headers: { Authorization: 'Bearer ' + t } } }
  }
  const S = await reg('chk-s@e2e.test', 'Check Surveyor', 'C-1'); const R = await reg('chk-r@e2e.test', 'Check Reviewer', 'C-2'); const X = await reg('chk-x@e2e.test', 'Not Appointed', 'C-3')
  const auth = (await db.query("INSERT INTO survey.authority (code,name,kind) VALUES ('VUNGU','Vungu RDC','rural') RETURNING id")).rows[0].id
  const schema = (await db.query('SELECT schema_name FROM public.surveyor_profiles WHERE user_id=$1', [S.id])).rows[0].schema_name

  let r = await sp.post('/survey-projects', { name: 'Check layout', clientName: 'Council', district: 'Vungu', surveyType: 'Layout survey', surveyDate: '2026-06-01', workingDirectory: 'C:/xs-check' }, S.H)
  const pid = r.data.project.id
  await db.query(`UPDATE ${schema}.survey_projects SET township = $2 WHERE id = $1`, [pid, TOWN])
  await sp.patch(`/survey-projects/${pid}/survey-class`, { survey_class: 'B' }, S.H)
  const add = (stand, w, s) => db.query(`INSERT INTO ${schema}.land_parcels (project_id, stand, designation, status, area_m2, geom) VALUES ($1,$2,$2,'finalized',900,ST_GeomFromText($3,22289))`, [pid, stand, poly(w, s)])
  await add('1', W0, S0)             // the number is taken in the township
  await add('2', W0 + 100, S0)       // fine
  await add('3', W0 + 2010, S0)      // on top of registered stand 9
  await add('4', W0 + 3000, S0)      // a draft is not checked, below
  await db.query(`UPDATE ${schema}.land_parcels SET status = 'draft' WHERE project_id = $1 AND stand = '4'`, [pid])

  console.log('before the surveyor is appointed')
  r = await sp.post(`/survey-projects/${pid}/check-layout`, { authority_code: 'VUNGU' }, S.H)
  ok(r.status === 403 && r.data.error === 'not_appointed', `a surveyor not appointed to the council is refused before VunGIS is asked (${r.status} ${r.data.error})`)
  r = await sp.post(`/survey-projects/${pid}/check-layout`, {}, S.H); ok(r.status === 422 && r.data.error === 'authority_required', 'a project with no council says which is needed')
  await db.query("INSERT INTO survey.authority_member (user_id,authority_id,role,engagement) VALUES ($1,$2,'surveyor','contracted'),($3,$2,'reviewer',NULL)", [S.id, auth, R.id])

  console.log('\nthe surveyor checks the layout')
  r = await sp.post(`/survey-projects/${pid}/check-layout`, { authority_code: 'VUNGU' }, X.H); ok(r.status === 404, 'somebody else cannot check it (not found)')
  r = await sp.post(`/survey-projects/${pid}/check-layout`, { authority_code: 'VUNGU' })
  ok(r.status === 401, 'nobody signed in is refused')
  r = await sp.post(`/survey-projects/${pid}/check-layout`, { authority_code: 'VUNGU' }, S.H)
  const codes = r.status === 200 ? r.data.data.errors.map(e => e.code).sort() : []
  ok(r.status === 200 && r.data.data.ok === false && r.data.data.checked === 3, `three finalized parcels are checked, the draft is not (${r.status} checked ${r.data.data && r.data.data.checked})`)
  ok(JSON.stringify(codes) === JSON.stringify(['overlaps_existing', 'stand_no_exists']), `VunGIS finds the taken number and the overlap: ${codes.join(', ')}`)
  const e1 = r.data.data.errors.find(e => e.code === 'stand_no_exists'); const e9 = r.data.data.errors.find(e => e.code === 'overlaps_existing')
  ok(e1 && e1.stand === '1' && e1.parcel_id === held1 && e9 && e9.stand === '3' && e9.parcel_id === held9 && e9.overlap_m2 > 100, 'naming the stand, the registered parcel it meets and the size of the overlap')
  ok((await vg.query("SELECT count(*)::int n FROM land.parcel WHERE source = 'cross-system check'")).rows[0].n === 2, 'and the check wrote nothing to the register')

  console.log('\nadvisory: it does not stop delivery, and the reviewer sees the same problems')
  r = await sp.post(`/survey-projects/${pid}/deliver`, { authority_code: 'VUNGU' }, S.H)
  ok(r.status === 200, `the layout is delivered all the same (${r.status})`)
  const sid = r.data.data.shared_project_id
  r = await sp.post(`/reviews/projects/${sid}/check-layout`, {}, R.H)
  ok(r.status === 200 && r.data.data.ok === false && r.data.data.errors.length === 2, `the reviewer's check finds the same two problems (${r.status})`)
  r = await sp.post(`/reviews/projects/${sid}/check-layout`, {}, S.H); ok(r.status === 403, 'the surveyor cannot use the reviewer\'s check on their own work')
  r = await sp.post(`/reviews/projects/${sid}/check-layout`, {}, X.H); ok(r.status === 404 || r.status === 403, 'nor can a stranger')
  r = await sp.post(`/reviews/projects/${sid}/decision`, { decision: 'returned', note: 'Stand 1 is taken and stand 3 overlaps stand 9' }, R.H); ok(r.status === 201, 'the reviewer returns it with the reasons')

  console.log('\nthe surveyor corrects it; the check passes; the importer takes it')
  await db.query(`UPDATE ${schema}.land_parcels SET stand = '11', designation = '11' WHERE project_id = $1 AND stand = '1'`, [pid])
  await db.query(`DELETE FROM ${schema}.land_parcels WHERE project_id = $1 AND stand = '3'`, [pid])
  r = await sp.post(`/survey-projects/${pid}/check-layout`, { authority_code: 'VUNGU' }, S.H)
  ok(r.status === 200 && r.data.data.ok === true && r.data.data.errors.length === 0 && r.data.data.checked === 2, 'the corrected layout passes')
  r = await sp.post(`/survey-projects/${pid}/deliver`, { authority_code: 'VUNGU' }, S.H); ok(r.status === 200, 're-delivered')
  r = await sp.post(`/reviews/projects/${sid}/check-layout`, {}, R.H); ok(r.status === 200 && r.data.data.ok === true, 'the reviewer\'s check passes too')
  r = await sp.post(`/reviews/projects/${sid}/decision`, { decision: 'accepted', note: 'Corrected' }, R.H); ok(r.status === 201, 'accepted')
  spawnSync('node', ['scripts/create-authority-reader.js', '--authority', 'VUNGU', '--apply'], { cwd: WT, env: { ...process.env, DATABASE_URL: scratchUrl }, encoding: 'utf8' })
  const renv = Object.fromEntries(fs.readFileSync(WT + '/.reader-vungu.env', 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(/=(.*)/s).slice(0, 2)))
  const readerUrl = `postgresql://${renv.PGUSER}:${encodeURIComponent(renv.PGPASSWORD)}@${renv.PGHOST}:${renv.PGPORT}/${renv.PGDATABASE}`
  const imp = spawnSync('node', ['scripts/import-surveypro.js', '--apply'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: vungisUrl, SURVEYPRO_DATABASE_URL: readerUrl }, encoding: 'utf8' })
  ok(imp.status === 0 && /2 parcel\(s\) imported/.test(imp.stdout), 'VunGIS\'s importer takes exactly what the check said it would: ' + (imp.stdout || imp.stderr || '').split('\n').slice(-3).join(' | '))

  console.log('\nwhen VunGIS cannot be reached')
  await vgApp.close(); vgUp = false
  r = await sp.post(`/survey-projects/${pid}/check-layout`, { authority_code: 'VUNGU' }, S.H)
  ok(r.status === 502 && r.data.error === 'register_unreachable' && /delivering does not depend/.test(r.data.message), `the surveyor is told, in words, and nothing else breaks (${r.status} ${r.data.error})`)
  r = await sp.get(`/survey-projects/${pid}/delivery`, S.H); ok(r.status === 200 && r.data.data.state === 'accepted', 'the rest of SurveyPro carries on')

  // ---- clean up VunGIS ---------------------------------------------------------------------------------------------------------------------
  const vgc = new Pool({ connectionString: vungisUrl, max: 1 })
  const c = await vgc.connect()
  try {
    await c.query('BEGIN'); await c.query("SET LOCAL gms.purge='on'")
    const ids = (await c.query("SELECT parcel_id FROM land.parcel WHERE source = 'cross-system check' OR (source_relation='surveypro' AND source_key LIKE 'VUNGU:%')")).rows.map(x => x.parcel_id)
    if (ids.length) { await c.query('DELETE FROM integration.outbox_event WHERE idempotency_key = ANY($1::text[])', [ids.map(i => 'ParcelCreated:' + i)]); await c.query('DELETE FROM land.parcel WHERE parcel_id = ANY($1::text[])', [ids]) }
    await c.query('COMMIT')
  } finally { c.release(); await vgc.end() }
  try { fs.unlinkSync(WT + '/.reader-vungu.env') } catch {}
  await vg.end(); await db.end(); stop()
  console.log(bad ? `\n${bad} FAILED` : '\nALL OK'); process.exit(bad ? 1 : 0)
})().catch(e => { console.error('ERR', e); process.exit(1) })
