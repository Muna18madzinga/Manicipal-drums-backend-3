/**
 * Committee management (H2) — the two statutory gates added in migration 104:
 *   1. A determination (eo-decision) requires a committee resolution, unless
 *      recorded as a delegated-authority decision (audited).
 *   2. A resolution cannot be recorded for a meeting that was not quorate.
 */
const { buildAppForTest } = require('../../../test/helpers/buildApp')
const { loginAs } = require('../../../test/helpers/auth')

describe('committee gates on eo-decision + resolution recording', () => {
  let app, eo, planner
  const permits = []
  const meetings = []
  const members = []

  beforeAll(async () => {
    app = await buildAppForTest()
    eo = await loginAs(app, 'demo.eo@vungu.test', 'demo1234')
    planner = await loginAs(app, 'demo.planner@vungu.test', 'demo1234')
  }, 30000)

  afterAll(async () => {
    const c = await app.pg.connect()
    try {
      for (const id of meetings) await c.query(`DELETE FROM spatial_planning.committee_meeting WHERE id = $1`, [id])
      for (const id of members) await c.query(`DELETE FROM spatial_planning.committee_member WHERE id = $1`, [id])
      for (const id of permits) {
        await c.query(`DELETE FROM spatial_planning.permit_event WHERE permit_app_id = $1`, [id])
        await c.query(`DELETE FROM spatial_planning.permit_application WHERE id = $1`, [id])
      }
    } finally { c.release() }
    await app.close()
  }, 30000)

  // Create a permit and drive it to under_review (a lawful from-status for a decision).
  async function permitUnderReview() {
    const created = await app.inject({
      method: 'POST', url: '/api/permit-applications',
      headers: { authorization: `Bearer ${planner}` },
      payload: { applicant_name: 'Committee Test', development_type: 'new_building' },
    })
    expect(created.statusCode).toBe(201)
    const id = created.json().data.id
    permits.push(id)
    let rev = created.json().data.revision
    for (const step of ['acknowledged', 'under_review']) {
      const r = await app.inject({
        method: 'PATCH', url: `/api/permit-applications/${id}/status`,
        headers: { authorization: `Bearer ${planner}` },
        payload: { status: step, expectedRevision: rev },
      })
      expect([200, 201]).toContain(r.statusCode)
      rev = r.json().data.revision
    }
    return id
  }

  test('eo-decision is blocked without a committee resolution', async () => {
    const id = await permitUnderReview()
    const res = await app.inject({
      method: 'POST', url: `/api/permit-applications/${id}/eo-decision`,
      headers: { authorization: `Bearer ${eo}` },
      payload: { decision: 'approve' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('committee_resolution_required')
  })

  test('a delegated-authority decision is allowed (and audited)', async () => {
    const id = await permitUnderReview()
    const res = await app.inject({
      method: 'POST', url: `/api/permit-applications/${id}/eo-decision`,
      headers: { authorization: `Bearer ${eo}` },
      payload: { decision: 'approve', delegated_authority: 'Minor works — decided under delegated authority.' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.permit.status).toBe('approved')
  }, 30000)

  test('quorum gate blocks a resolution until attendance meets quorum; then eo-decision passes', async () => {
    const id = await permitUnderReview()

    // Meeting requiring 2 present.
    const mtg = await app.inject({
      method: 'POST', url: '/api/committee-meetings',
      headers: { authorization: `Bearer ${planner}` },
      payload: { title: 'Jest TPC', meeting_date: '2026-08-01', quorum: 2 },
    })
    expect(mtg.statusCode).toBe(201)
    const meetingId = mtg.json().data.id
    meetings.push(meetingId)
    expect(mtg.json().data.quorum).toBe(2)

    // Table the application.
    const item = await app.inject({
      method: 'POST', url: `/api/committee-meetings/${meetingId}/agenda`,
      headers: { authorization: `Bearer ${planner}` },
      payload: { permit_app_id: id, purpose: 'determination' },
    })
    expect(item.statusCode).toBe(201)
    const agendaItemId = item.json().data.id

    // Recording a resolution with nobody present must fail (quorum not met).
    const early = await app.inject({
      method: 'PATCH', url: `/api/agenda-items/${agendaItemId}`,
      headers: { authorization: `Bearer ${eo}` },
      payload: { outcome: 'approved', resolution: 'Approved subject to conditions.' },
    })
    expect(early.statusCode).toBe(409)
    expect(early.json().error).toBe('quorum_not_met')

    // Add two members and mark them present.
    for (const name of ['Cllr A', 'Cllr B']) {
      const mem = await app.inject({
        method: 'POST', url: '/api/committee-members',
        headers: { authorization: `Bearer ${planner}` },
        payload: { full_name: name, title: 'Councillor' },
      })
      expect(mem.statusCode).toBe(201)
      const memberId = mem.json().data.id
      members.push(memberId)
      const att = await app.inject({
        method: 'POST', url: `/api/committee-meetings/${meetingId}/attendance`,
        headers: { authorization: `Bearer ${planner}` },
        payload: { member_id: memberId, status: 'present' },
      })
      expect(att.statusCode).toBe(201)
    }

    // Now the resolution records.
    const rec = await app.inject({
      method: 'PATCH', url: `/api/agenda-items/${agendaItemId}`,
      headers: { authorization: `Bearer ${eo}` },
      payload: { outcome: 'approved', resolution: 'Approved subject to conditions.' },
    })
    expect(rec.statusCode).toBe(200)
    expect(rec.json().data.outcome).toBe('approved')

    // And the eo-decision is now permitted (committee resolution exists).
    const dec = await app.inject({
      method: 'POST', url: `/api/permit-applications/${id}/eo-decision`,
      headers: { authorization: `Bearer ${eo}` },
      payload: { decision: 'approve' },
    })
    expect(dec.statusCode).toBe(200)
    expect(dec.json().data.permit.status).toBe('approved')
  }, 30000)
})
