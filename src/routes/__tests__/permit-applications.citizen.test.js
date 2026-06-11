require('dotenv').config()
const axios = require('axios')

const BASE = 'http://127.0.0.1:3000/api'
const CITIZEN = { email: 'demo.viewer@vungu.test', password: 'demo1234' }
const PLANNER = { email: 'demo.planner@vungu.test', password: 'demo1234' }

async function login(creds) {
  const r = await axios.post(`${BASE}/auth/login`, creds)
  return r.data.data.token
}

let citizenToken, plannerToken
let citizenPermitId, plannerPermitId

beforeAll(async () => {
  citizenToken = await login(CITIZEN)
  plannerToken = await login(PLANNER)
})

afterAll(async () => {
  for (const id of [citizenPermitId, plannerPermitId].filter(Boolean)) {
    await axios.delete(`${BASE}/permit-applications/${id}`,
      { headers: { Authorization: `Bearer ${plannerToken}` } }).catch(() => {})
  }
})

describe('/permit-applications role + own-row gating', () => {
  test('citizen can POST a permit', async () => {
    const r = await axios.post(`${BASE}/permit-applications`,
      { applicant_name: 'Citizen Smoke', development_type: 'new_building',
        stand_number: 'CIT-SMK-1', suburb_ward: '1' },
      { headers: { Authorization: `Bearer ${citizenToken}` } })
    expect(r.status).toBe(201)
    citizenPermitId = r.data.data.id
    expect(citizenPermitId).toBeTruthy()
  })

  test('planner can POST a permit', async () => {
    const r = await axios.post(`${BASE}/permit-applications`,
      { applicant_name: 'Planner Smoke', development_type: 'new_building',
        stand_number: 'PLN-SMK-1', suburb_ward: '2' },
      { headers: { Authorization: `Bearer ${plannerToken}` } })
    expect(r.status).toBe(201)
    plannerPermitId = r.data.data.id
  })

  test('citizen GET list returns only own rows', async () => {
    const r = await axios.get(`${BASE}/permit-applications?limit=200&offset=0`,
      { headers: { Authorization: `Bearer ${citizenToken}` } })
    expect(r.status).toBe(200)
    const ids = r.data.data.map(p => p.id)
    expect(ids).toContain(citizenPermitId)
    expect(ids).not.toContain(plannerPermitId)
  })

  test('planner GET list returns rows from all creators', async () => {
    const r = await axios.get(`${BASE}/permit-applications?limit=200&offset=0`,
      { headers: { Authorization: `Bearer ${plannerToken}` } })
    expect(r.status).toBe(200)
    const ids = r.data.data.map(p => p.id)
    expect(ids).toContain(citizenPermitId)
    expect(ids).toContain(plannerPermitId)
  })

  test("citizen GET someone else's permit by id returns 404", async () => {
    const err = await axios.get(`${BASE}/permit-applications/${plannerPermitId}`,
      { headers: { Authorization: `Bearer ${citizenToken}` } }).catch(e => e.response)
    expect(err.status).toBe(404)
  })
})
