require('dotenv').config()
const axios = require('axios')

const BASE = 'http://127.0.0.1:3000/api'
const PLANNER  = { email: 'demo.planner@vungu.test',  password: 'demo1234' }
const SURVEYOR = { email: 'demo.surveyor@vungu.test', password: 'demo1234' }
const CITIZEN  = { email: 'demo.viewer@vungu.test',   password: 'demo1234' }

async function login(creds) {
  const r = await axios.post(`${BASE}/auth/login`, creds)
  return r.data.data.token
}
const auth = (t) => ({ headers: { Authorization: `Bearer ${t}` } })

let plannerToken, surveyorToken, citizenToken
let permitId, taskId

beforeAll(async () => {
  plannerToken  = await login(PLANNER)
  surveyorToken = await login(SURVEYOR)
  citizenToken  = await login(CITIZEN)

  // A permit for the survey task to hang off.
  const p = await axios.post(`${BASE}/permit-applications`,
    { applicant_name: 'Survey Smoke', development_type: 'subdivision',
      stand_number: 'SRV-SMK-1', suburb_ward: 'Ward 4 — Lalapanzi' },
    auth(plannerToken))
  permitId = p.data.data.id
})

afterAll(async () => {
  if (permitId) {
    await axios.delete(`${BASE}/permit-applications/${permitId}`, auth(plannerToken)).catch(() => {})
  }
})

describe('Surveyor survey-task workflow', () => {
  test('planner assigns a survey task', async () => {
    const r = await axios.post(`${BASE}/surveyor/jobs`,
      { permit_app_id: permitId, task_type: 'verification',
        stand_number: 'SRV-SMK-1', suburb_ward: 'Ward 4 — Lalapanzi',
        instructions: 'Verify beacons and title-deed match', lng: 29.82, lat: -19.45 },
      auth(plannerToken))
    expect(r.status).toBe(201)
    taskId = r.data.data.id
    expect(taskId).toBeTruthy()
  })

  test('surveyor sees the unclaimed task in their queue', async () => {
    const r = await axios.get(`${BASE}/surveyor/jobs`, auth(surveyorToken))
    expect(r.status).toBe(200)
    const ids = r.data.data.map(t => t.id)
    expect(ids).toContain(taskId)
  })

  test('surveyor reads the linked citizen application context through the task', async () => {
    const r = await axios.get(`${BASE}/surveyor/jobs/${taskId}`, auth(surveyorToken))
    expect(r.status).toBe(200)
    expect(r.data.data.applicant_name).toBe('Survey Smoke')
    expect(r.data.data.lng).toBeCloseTo(29.82, 2)
  })

  test('surveyor claims and starts the task', async () => {
    const r = await axios.patch(`${BASE}/surveyor/jobs/${taskId}`,
      { claim: true, status: 'in_progress' }, auth(surveyorToken))
    expect(r.status).toBe(200)
    expect(r.data.data.status).toBe('in_progress')
  })

  test('surveyor records a coordinate and a beacon', async () => {
    const c = await axios.post(`${BASE}/surveyor/jobs/${taskId}/coordinates`,
      { label: 'NE corner', coord_system: 'WGS84', longitude: 29.82, latitude: -19.45 },
      auth(surveyorToken))
    expect(c.status).toBe(201)
    const b = await axios.post(`${BASE}/surveyor/jobs/${taskId}/beacons`,
      { corner_label: 'NE', beacon_type: 'iron_peg', status: 'intact' },
      auth(surveyorToken))
    expect(b.status).toBe(201)
  })

  test('surveyor submits findings; task moves to submitted', async () => {
    const r = await axios.post(`${BASE}/surveyor/jobs/${taskId}/findings`,
      { summary: 'Beacons intact, boundaries match diagram', recommendation: 'no_objection' },
      auth(surveyorToken))
    expect(r.status).toBe(201)
    const t = await axios.get(`${BASE}/surveyor/jobs/${taskId}`, auth(surveyorToken))
    expect(t.data.data.status).toBe('submitted')
    expect(t.data.data.findings.length).toBeGreaterThan(0)
  })

  test('planner sees the findings on the application', async () => {
    const r = await axios.get(`${BASE}/permit-applications/${permitId}/survey-tasks`, auth(plannerToken))
    expect(r.status).toBe(200)
    const mine = r.data.data.find(t => t.id === taskId)
    expect(mine).toBeTruthy()
    expect(mine.findings.length).toBeGreaterThan(0)
    expect(mine.findings[0].recommendation).toBe('no_objection')
  })

  test('citizen cannot list survey jobs (403)', async () => {
    const err = await axios.get(`${BASE}/surveyor/jobs`, auth(citizenToken)).catch(e => e.response)
    expect(err.status).toBe(403)
  })

  test('citizen cannot assign a survey task (403)', async () => {
    const err = await axios.post(`${BASE}/surveyor/jobs`,
      { permit_app_id: permitId, task_type: 'verification' },
      auth(citizenToken)).catch(e => e.response)
    expect(err.status).toBe(403)
  })
})
