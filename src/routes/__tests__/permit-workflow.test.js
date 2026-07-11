/**
 * Statutory workflow transition matrix (config/permitWorkflow.js) and its
 * enforcement in PATCH /permit-applications/:id/status.
 *
 * Before this gate, any planning officer could jump a case from any status to
 * any other (registered → approved), skipping the statutory chain.
 */
const { canTransition, allowedTransitions, PERMIT_STATUSES } = require('../../config/permitWorkflow')
const { buildAppForTest } = require('../../../test/helpers/buildApp')
const { loginAs } = require('../../../test/helpers/auth')

describe('permitWorkflow matrix', () => {
  test('blocks stage-skips and decision reversals', () => {
    expect(canTransition('pending_payment', 'approved')).toBe(false)
    expect(canTransition('registered', 'approved')).toBe(false)
    expect(canTransition('registered', 'refused')).toBe(false)
    expect(canTransition('approved', 'refused')).toBe(false)
    expect(canTransition('refused', 'approved')).toBe(false)
    expect(canTransition('withdrawn', 'under_review')).toBe(false)
  })

  test('allows the statutory chain and lawful loops', () => {
    expect(canTransition('pending_payment', 'registered')).toBe(true)
    expect(canTransition('registered', 'acknowledged')).toBe(true)
    expect(canTransition('acknowledged', 'circulation')).toBe(true)
    expect(canTransition('circulation', 'objection_period')).toBe(true)
    expect(canTransition('objection_period', 'under_review')).toBe(true)
    expect(canTransition('under_review', 'circulation')).toBe(true)          // more consultation
    expect(canTransition('under_review', 'approved_with_conditions')).toBe(true)
    expect(canTransition('awaiting_eo_decision', 'refused')).toBe(true)
    expect(canTransition('approved', 'appealed')).toBe(true)
    expect(canTransition('appealed', 'under_review')).toBe(true)             // remittal
  })

  test('same-status is allowed; unknown statuses are not', () => {
    expect(canTransition('under_review', 'under_review')).toBe(true)
    expect(canTransition('nonsense', 'approved')).toBe(false)
    expect(canTransition('registered', 'nonsense')).toBe(false)
    expect(canTransition(null, 'approved')).toBe(false)
  })

  test('every status has a transition entry; only decided/withdrawn are near-terminal', () => {
    for (const s of PERMIT_STATUSES) {
      expect(Array.isArray(allowedTransitions(s))).toBe(true)
    }
    expect(allowedTransitions('withdrawn')).toHaveLength(0)
    expect(allowedTransitions('approved')).toEqual(['appealed'])
  })
})

describe('PATCH /permit-applications/:id/status enforcement', () => {
  let app, planner, id, revision

  beforeAll(async () => {
    app = await buildAppForTest()
    planner = await loginAs(app, 'demo.planner@vungu.test', 'demo1234')
    const res = await app.inject({
      method: 'POST', url: '/api/permit-applications',
      headers: { authorization: `Bearer ${planner}` },
      payload: { applicant_name: 'Workflow Matrix Test', development_type: 'new_building' },
    })
    expect(res.statusCode).toBe(201)
    id = res.json().data.id
    revision = res.json().data.revision
  }, 30000)

  afterAll(async () => {
    const client = await app.pg.connect()
    try {
      await client.query(`DELETE FROM spatial_planning.permit_event WHERE permit_app_id = $1`, [id])
      await client.query(`DELETE FROM spatial_planning.permit_application WHERE id = $1`, [id])
    } finally { client.release() }
    await app.close()
  }, 30000)

  const patch = (status) => app.inject({
    method: 'PATCH', url: `/api/permit-applications/${id}/status`,
    headers: { authorization: `Bearer ${planner}` },
    payload: { status, expectedRevision: revision },
  })

  test('registered → approved is rejected with the allowed list', async () => {
    const res = await patch('approved')
    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error).toBe('invalid_transition')
    expect(body.from).toBe('registered')
    expect(body.allowed).toContain('acknowledged')
    expect(body.allowed).not.toContain('approved')
  })

  test('the lawful chain advances and a decided case is locked', async () => {
    for (const step of ['acknowledged', 'under_review', 'approved']) {
      const res = await patch(step)
      expect([200, 201]).toContain(res.statusCode)
      revision = res.json().data.revision
    }
    // approved → refused must be rejected (decision stands; appeal is the exit)
    const reversal = await patch('refused')
    expect(reversal.statusCode).toBe(409)
    expect(reversal.json().error).toBe('invalid_transition')
    // approved → appealed is lawful
    const appeal = await patch('appealed')
    expect(appeal.statusCode).toBe(200)
  }, 30000)
})
