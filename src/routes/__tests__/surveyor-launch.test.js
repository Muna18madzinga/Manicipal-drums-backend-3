// src/routes/__tests__/surveyor-launch.test.js
// Opening a survey job in SurveyPro (POST /api/surveyor/jobs/:id/launch), against the live database.
// What matters: only the surveyor the job is assigned to can launch it; the token is genuine and says what SurveyPro needs;
// a closed or unassigned job is refused; and without keys the endpoint says SurveyPro is not connected rather than failing oddly.

require('dotenv').config()
const crypto = require('node:crypto')
const { Pool } = require('pg')
const { buildAppForTest } = require('../../../test/helpers/buildApp')
const { loginAs } = require('../../../test/helpers/auth')
const { verify } = require('../../lib/launchToken')

describe('POST /surveyor/jobs/:id/launch', () => {
  let app, pool, planner, surveyor, admin, surveyorId
  const jobs = []
  const keys = crypto.generateKeyPairSync('ed25519')
  const saved = { key: process.env.SURVEYPRO_LAUNCH_PRIVATE_KEY, url: process.env.SURVEYPRO_URL }
  const as = (t) => ({ authorization: `Bearer ${t}` })

  beforeAll(async () => {
    process.env.SURVEYPRO_LAUNCH_PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
    process.env.SURVEYPRO_URL = 'https://survey.example.test'
    app = await buildAppForTest()
    planner = await loginAs(app, 'demo.planner@vungu.test', 'demo1234')
    surveyor = await loginAs(app, 'demo.surveyor@vungu.test', 'demo1234')
    admin = await loginAs(app, 'demo.admin@vungu.test', 'demo1234')
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
    surveyorId = (await pool.query("SELECT id FROM public.users WHERE email = 'demo.surveyor@vungu.test'")).rows[0].id
  })

  afterAll(async () => {
    if (jobs.length) await pool.query('DELETE FROM spatial_planning.survey_task WHERE id = ANY($1::uuid[])', [jobs])
    for (const [k, v] of [['SURVEYPRO_LAUNCH_PRIVATE_KEY', saved.key], ['SURVEYPRO_URL', saved.url]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    await pool.end()
    await app.close()
  })

  async function assign(over = {}) {
    const res = await app.inject({
      method: 'POST', url: '/api/surveyor/jobs', headers: as(planner),
      payload: { task_type: 'verification', stand_number: 'LAUNCH-1', suburb_ward: 'Ward 6', lng: 29.8, lat: -19.45, instructions: 'Check the beacons', due_date: '2026-12-01', assigned_to: surveyorId, ...over },
    })
    expect(res.statusCode).toBe(201)
    const job = res.json().data
    jobs.push(job.id)
    return job
  }
  const launch = (id, tok = surveyor) => app.inject({ method: 'POST', url: `/api/surveyor/jobs/${id}/launch`, headers: as(tok) })

  test('the assigned surveyor gets a URL carrying a token SurveyPro can verify', async () => {
    const job = await assign()
    const res = await launch(job.id)
    expect(res.statusCode).toBe(200)
    const { url, authority_code: code } = res.json().data
    expect(code).toBe('VUNGU')
    expect(url.startsWith('https://survey.example.test/launch?token=')).toBe(true)
    const token = decodeURIComponent(url.split('token=')[1])
    const c = verify(token, { publicKey: keys.publicKey })
    expect(c.sub).toBe('demo.surveyor@vungu.test')
    expect(c.authority).toMatchObject({ code: 'VUNGU' })
    expect(c.job).toMatchObject({ id: job.id, task_type: 'verification', stand_number: 'LAUNCH-1', suburb_ward: 'Ward 6', due_date: '2026-12-01', location: { lon: 29.8, lat: -19.45 } })
    expect([25, 27, 29, 31, 33]).toContain(c.job.gauss_lo)
  })

  test('launching starts the work: an assigned job becomes in progress', async () => {
    const job = await assign({ stand_number: 'LAUNCH-2' })
    expect(job.status).toBe('assigned')
    await launch(job.id)
    const { rows } = await pool.query('SELECT status FROM spatial_planning.survey_task WHERE id = $1', [job.id])
    expect(rows[0].status).toBe('in_progress')
  })

  test('the token reveals nothing about the applicant', async () => {
    const job = await assign({ stand_number: 'LAUNCH-3' })
    const token = decodeURIComponent((await launch(job.id)).json().data.url.split('token=')[1])
    const payload = Buffer.from(token.split('.')[1], 'base64url').toString()
    expect(payload).not.toMatch(/applicant|phone|@(?!vungu)/i)
  })

  test("a surveyor cannot launch somebody else's job, nor can an admin", async () => {
    const other = (await pool.query("SELECT id FROM public.users WHERE email = 'demo.admin@vungu.test'")).rows[0].id
    const job = await assign({ stand_number: 'LAUNCH-4', assigned_to: other })
    expect((await launch(job.id, surveyor)).statusCode).toBe(404)   // another's claimed job is invisible to a surveyor
    expect((await launch(job.id, planner)).statusCode).toBe(403)     // only surveyors launch
  })

  test('an admin who is not the assignee is refused', async () => {
    const job = await assign({ stand_number: 'LAUNCH-5' })           // assigned to the surveyor
    const res = await launch(job.id, admin)
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toBe('not_your_job')
  })

  test('an unassigned job must be claimed first', async () => {
    const job = await assign({ stand_number: 'LAUNCH-6', assigned_to: null })
    const res = await launch(job.id)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('not_assigned')
  })

  test('a cancelled job cannot be launched', async () => {
    const job = await assign({ stand_number: 'LAUNCH-7' })
    await pool.query("UPDATE spatial_planning.survey_task SET status = 'cancelled' WHERE id = $1", [job.id])
    const res = await launch(job.id)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('job_closed')
  })

  test('without a signing key the endpoint says SurveyPro is not connected', async () => {
    const job = await assign({ stand_number: 'LAUNCH-8' })
    const key = process.env.SURVEYPRO_LAUNCH_PRIVATE_KEY
    delete process.env.SURVEYPRO_LAUNCH_PRIVATE_KEY
    try {
      const res = await launch(job.id)
      expect(res.statusCode).toBe(503)
      expect(res.json().error).toBe('launch_not_configured')
    } finally { process.env.SURVEYPRO_LAUNCH_PRIVATE_KEY = key }
  })

  test('nobody signed in is refused', async () => {
    const job = await assign({ stand_number: 'LAUNCH-9' })
    const res = await app.inject({ method: 'POST', url: `/api/surveyor/jobs/${job.id}/launch` })
    expect(res.statusCode).toBe(401)
  })
})
