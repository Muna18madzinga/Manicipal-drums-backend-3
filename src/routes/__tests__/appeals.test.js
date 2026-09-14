// src/routes/__tests__/appeals.test.js
// Statutory appeals (RTCP Act s.38) against the live database.
//
// The rules worth a test are the ones that are not obvious from the table:
// only a determined application can be appealed, lodging puts the case before
// the Court in every register, a decided appeal must say what was decided, and
// a remitted appeal sends the application back for re-determination.
//
// Every row written here is removed in afterAll; the permits created are
// scratch rows, not fixtures anyone else relies on.

require('dotenv').config()
const { Pool } = require('pg')
const { buildAppForTest } = require('../../../test/helpers/buildApp')
const { loginAs } = require('../../../test/helpers/auth')

describe('appeals', () => {
  let app
  let pool
  let eo
  let viewer
  const permits = []
  const as = (tok) => ({ authorization: `Bearer ${tok}` })

  beforeAll(async () => {
    app = await buildAppForTest()
    eo = await loginAs(app, 'demo.eo@vungu.test', 'demo1234')
    viewer = await loginAs(app, 'demo.viewer@vungu.test', 'demo1234')
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
  })

  afterAll(async () => {
    if (permits.length) {
      // application_appeal cascades on the permit.
      await pool.query(
        'DELETE FROM spatial_planning.permit_application WHERE id = ANY($1::uuid[])',
        [permits],
      )
    }
    await pool.end()
    await app.close()
  })

  /** A scratch permit in `status`, with a decision date `daysAgo` days back. */
  async function permit(status, daysAgo = 3) {
    const { rows } = await pool.query(
      `INSERT INTO spatial_planning.permit_application
         (applicant_name, applicant_email, development_type, stand_number, status, decision_at)
       VALUES ('Appeal Test', 'appeal.test@vungu.test', 'new_building', 'APPEAL-TEST',
               $1, CURRENT_DATE - $2::int)
       RETURNING id`,
      [status, daysAgo],
    )
    permits.push(rows[0].id)
    return rows[0].id
  }

  const lodge = (id, payload, tok = eo) =>
    app.inject({ method: 'POST', url: `/api/permit-applications/${id}/appeals`, headers: as(tok), payload })

  test('only a determined application can be appealed', async () => {
    const open = await permit('under_review')
    const res = await lodge(open, { appellant_name: 'N Moyo', grounds: 'Too slow' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('not_determined')
  })

  test('lodging records the appeal and puts the case before the Court', async () => {
    const refused = await permit('refused', 10)
    const res = await lodge(refused, {
      appellant_name: 'N Moyo', appellant_type: 'applicant',
      grounds: 'The refusal disregards the approved layout.',
    })
    expect(res.statusCode).toBe(201)
    const a = res.json().data
    expect(a.status).toBe('lodged')
    expect(a.grounds).toMatch(/approved layout/)
    // Lodged 10 days after the decision — inside the 28-day window.
    expect(a.days_after_decision).toBe(10)
    expect(a.within_window).toBe(true)
    // The denormalised columns a register row needs.
    expect(a.stand_number).toBe('APPEAL-TEST')

    const { rows } = await pool.query(
      'SELECT status FROM spatial_planning.permit_application WHERE id = $1', [refused],
    )
    expect(rows[0].status).toBe('appealed')
  })

  test('a late appeal is recorded, and marked late rather than refused', async () => {
    const refused = await permit('refused', 60)
    const a = (await lodge(refused, { appellant_name: 'L Ncube', grounds: 'Late but lodged' })).json().data
    expect(a.days_after_decision).toBe(60)
    expect(a.within_window).toBe(false)
  })

  test('a case that is not the caller\'s own cannot be appealed by them', async () => {
    const refused = await permit('refused')
    const res = await lodge(refused, { appellant_name: 'Somebody', grounds: 'Not mine' }, viewer)
    expect(res.statusCode).toBe(403)
  })

  test('grounds are required', async () => {
    const refused = await permit('refused')
    const res = await lodge(refused, { appellant_name: 'N Moyo' })
    expect(res.statusCode).toBe(400)
    expect(res.json().field).toBe('grounds')
  })

  test('a hearing needs a date and a decision needs an outcome', async () => {
    const refused = await permit('refused')
    const a = (await lodge(refused, { appellant_name: 'N Moyo', grounds: 'Grounds' })).json().data

    const patch = (payload) =>
      app.inject({ method: 'PATCH', url: `/api/appeals/${a.id}/status`, headers: as(eo), payload })

    expect((await patch({ status: 'hearing_scheduled' })).json().field).toBe('hearing_date')
    expect((await patch({ status: 'decided' })).json().field).toBe('decision')
    expect((await patch({ status: 'nonsense' })).json().error).toBe('bad_status')

    const scheduled = await patch({ status: 'hearing_scheduled', hearing_date: '2026-11-02' })
    expect(scheduled.json().data.hearing_date).toBeTruthy()
    expect(scheduled.json().data.status).toBe('hearing_scheduled')
  })

  test('a remitted appeal sends the application back for re-determination', async () => {
    const refused = await permit('refused')
    const a = (await lodge(refused, { appellant_name: 'N Moyo', grounds: 'Grounds' })).json().data

    const decided = await app.inject({
      method: 'PATCH', url: `/api/appeals/${a.id}/status`, headers: as(eo),
      payload: { status: 'decided', decision: 'remitted', notes: 'Remitted for reconsideration' },
    })
    expect(decided.statusCode).toBe(200)
    expect(decided.json().data.decision).toBe('remitted')
    expect(decided.json().data.decided_at).toBeTruthy()

    const { rows } = await pool.query(
      'SELECT status FROM spatial_planning.permit_application WHERE id = $1', [refused],
    )
    expect(rows[0].status).toBe('under_review')
  })

  test('the register is staff-only and filters by permit', async () => {
    const refused = await permit('refused')
    await lodge(refused, { appellant_name: 'N Moyo', grounds: 'Register test' })

    expect((await app.inject({ method: 'GET', url: '/api/appeals' })).statusCode).toBe(401)

    const mine = await app.inject({
      method: 'GET', url: `/api/appeals?permit_application_id=${refused}`, headers: as(eo),
    })
    expect(mine.statusCode).toBe(200)
    expect(mine.json().data).toHaveLength(1)
    expect(mine.json().data[0].grounds).toBe('Register test')

    // A viewer is not staff: the register is scoped to their own cases, and
    // this one is not theirs.
    const asViewer = await app.inject({
      method: 'GET', url: `/api/appeals?permit_application_id=${refused}`, headers: as(viewer),
    })
    expect(asViewer.statusCode).toBe(200)
    expect(asViewer.json().data).toHaveLength(0)
  })
})
