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
  let app, planner, admin, id, revision

  beforeAll(async () => {
    app = await buildAppForTest()
    planner = await loginAs(app, 'demo.planner@vungu.test', 'demo1234')
    admin = await loginAs(app, 'demo.admin@vungu.test', 'demo1234')
    const res = await app.inject({
      method: 'POST', url: '/api/permit-applications',
      headers: { authorization: `Bearer ${planner}` },
      payload: { applicant_name: 'Workflow Matrix Test', development_type: 'new_building' },
    })
    expect(res.statusCode).toBe(201)
    id = res.json().data.id
    revision = res.json().data.revision
    // No pay_intent in the payload, so intake lands the case at 'registered'
    // rather than 'pending_payment' (development-management.js initialStatus).
    expect(res.json().data.status).toBe('registered')
  }, 30000)

  afterAll(async () => {
    const client = await app.pg.connect()
    try {
      await client.query(`DELETE FROM spatial_planning.permit_event WHERE permit_app_id = $1`, [id])
      await client.query(`DELETE FROM spatial_planning.permit_application WHERE id = $1`, [id])
    } finally { client.release() }
    await app.close()
  }, 30000)

  // A refused write must not advance the case, so every attempt carries the
  // revision the case still holds and the caller refreshes it only on success.
  const patch = (status, { token = planner, override = false } = {}) => app.inject({
    method: 'PATCH', url: `/api/permit-applications/${id}/status`,
    headers: { authorization: `Bearer ${token}` },
    payload: { status, expectedRevision: revision, ...(override ? { override: true } : {}) },
  })

  // Two guards stand between a caller and a status write, and they answer
  // differently. Pinned separately because a single request cannot reach both:
  // guard 1 (eo_decision_required) fires first for every determination, so a
  // planner can never observe guard 2's 409 for an approve/refuse.
  test('a determination is refused at the generic endpoint and names the eo route', async () => {
    const res = await patch('approved')
    expect(res.statusCode).toBe(403)
    const body = res.json()
    expect(body.error).toBe('eo_decision_required')
    // The refusal must be actionable: it has to name the endpoint that can.
    expect(body.message).toContain('/eo-decision')
    // A refused write must not have moved the case.
    const current = await app.pg.query(
      'SELECT status, revision FROM spatial_planning.permit_application WHERE id = $1', [id],
    )
    expect(current.rows[0].status).toBe('registered')
    expect(current.rows[0].revision).toBe(revision)
  })

  test('the state machine refuses an unlawful jump and reports the allowed list', async () => {
    // awaiting_eo_decision is not a determination, so this exercises guard 2 on
    // its own: skipping circulation and the objection period to reach it is
    // unlawful from 'registered'.
    const res = await patch('awaiting_eo_decision')
    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error).toBe('invalid_transition')
    expect(body.from).toBe('registered')
    expect(body.allowed).toContain('acknowledged')
    expect(body.allowed).not.toContain('awaiting_eo_decision')
    const current = await app.pg.query(
      'SELECT status, revision FROM spatial_planning.permit_application WHERE id = $1', [id],
    )
    expect(current.rows[0].status).toBe('registered')
    expect(current.rows[0].revision).toBe(revision)
  })

  test('the lawful chain advances; a decision is final and only an appeal exits it', async () => {
    for (const step of ['acknowledged', 'under_review']) {
      const res = await patch(step)
      expect([200, 201]).toContain(res.statusCode)
      revision = res.json().data.revision
    }
    // Determinations cannot be written through this endpoint by a planner at
    // all, so the case is determined via the admin override. NOTE: override
    // voids the transition check as well as the eo gate -- see the open
    // compliance question in docs/PERMIT-WORKFLOW-OVERRIDE.md.
    const decided = await patch('approved', { token: admin, override: true })
    expect([200, 201]).toContain(decided.statusCode)
    revision = decided.json().data.revision
    expect(decided.json().data.status).toBe('approved')

    // A planner still cannot reverse a decision through this endpoint; the
    // appeal is the only statutory exit (allowedTransitions('approved')).
    const reversal = await patch('refused')
    expect(reversal.statusCode).toBe(403)
    expect(reversal.json().error).toBe('eo_decision_required')
    const appeal = await patch('appealed')
    expect(appeal.statusCode).toBe(200)
  }, 30000)
})
