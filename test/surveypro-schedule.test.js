// Running the SurveyPro importer on a schedule (src/services/surveyproSchedule.js), against the live database.
//
// SurveyPro is a separate database, so each "council" reads a scratch schema of this database that has the same share-view shape (the rules of the
// import itself are tested in surveypro-import.test.js). What is real: the VunGIS tables, the register, the advisory lock and the run record.

require('dotenv').config()
const { Pool } = require('pg')
const { loadReaders, scheduleMinutes, runScheduled, recentRuns, LOCK_KEY } = require('../src/services/surveyproSchedule')

const SCHEMA = 'sp_sched_test'
const BASE_ID = 991000
const W0 = -86100, S0 = 2153900       // its own patch of ground, so suites running side by side cannot meet on it
const square = (w, s, size = 30) => `POLYGON((${w} ${s}, ${w + size} ${s}, ${w + size} ${s + size}, ${w} ${s + size}, ${w} ${s}))`

describe('configuration', () => {
  const URL_A = 'postgresql://reader_a:secret-a@host-a:5432/surveypro', URL_B = 'postgresql://reader_b:secret-b@host-b:5432/surveypro'
  test('the councils come from JSON in the environment, from a file, or from the single URL', () => {
    expect(loadReaders({ SURVEYPRO_READERS: JSON.stringify({ VUNGU: URL_A, GWERU: URL_B }) })).toEqual([{ name: 'VUNGU', url: URL_A }, { name: 'GWERU', url: URL_B }])
    expect(loadReaders({ SURVEYPRO_DATABASE_URL: URL_A })).toEqual([{ name: 'default', url: URL_A }])
    expect(loadReaders({})).toEqual([])
  })
  test('the same login named twice is read once', () => {
    expect(loadReaders({ SURVEYPRO_READERS: JSON.stringify({ VUNGU: URL_A }), SURVEYPRO_DATABASE_URL: URL_A })).toHaveLength(1)
  })
  test('a broken configuration says so, without echoing it', () => {
    expect(() => loadReaders({ SURVEYPRO_READERS: '{not json' })).toThrow(/not valid JSON/)
    try { loadReaders({ SURVEYPRO_READERS: `{${URL_A}` }) } catch (e) { expect(e.message).not.toContain('secret-a') }
  })
  test('it is not scheduled unless asked, and never more often than once a minute', () => {
    expect(scheduleMinutes({})).toBe(0)
    expect(scheduleMinutes({ SURVEYPRO_IMPORT_MINUTES: '15' })).toBe(15)
    expect(scheduleMinutes({ SURVEYPRO_IMPORT_MINUTES: '0.2' })).toBe(0)
    expect(scheduleMinutes({ SURVEYPRO_IMPORT_MINUTES: 'often' })).toBe(0)
    expect(scheduleMinutes({ SURVEYPRO_IMPORT_MINUTES: '99999' })).toBe(1440)
  })
})

describe('a scheduled run', () => {
  let pool, nextId = BASE_ID, startedAt
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows
  const dbUrl = () => process.env.DATABASE_URL
  const readers = () => [{ name: 'TESTCOUNCIL', url: dbUrl() }]
  const run = (over = {}) => runScheduled(pool, { readers: readers(), schema: SCHEMA, ...over })
  const accepted = { delivered_at: '2026-06-01T08:00:00Z', review_decision: 'accepted', reviewed_at: '2026-06-02T08:00:00Z' }

  async function project(parcels, over = {}) {
    const id = nextId++
    const row = { id, authority_code: 'VUNGU', name: `SCH test ${id}`, township: 'SCH Township', designation: 'Stand 1', survey_type: 'Pegging', survey_class: 'B', external_job_id: null, ...accepted, ...over }
    await q(`INSERT INTO ${SCHEMA}.projects (id, authority_code, name, township, designation, survey_type, survey_class, external_job_id, delivered_at, review_decision, reviewed_at, review_note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL)`, [row.id, row.authority_code, row.name, row.township, row.designation, row.survey_type, row.survey_class, row.external_job_id, row.delivered_at, row.review_decision, row.reviewed_at])
    let n = 0
    for (const p of parcels) {
      n++
      await q(`INSERT INTO ${SCHEMA}.parcels (id, project_id, stand, designation, area_m2, status, parcel_status, srid, lo_zone, axis_order, geom)
               VALUES ($1,$2,$3,$3,900,'finalized','active',22289,29,'westing_southing', ST_GeomFromText($4, 22289))`, [id * 10 + n, id, p.stand, p.wkt])
    }
    return row
  }
  const inRegister = async (id) => (await q(`SELECT count(*)::int AS n FROM land.parcel WHERE source_relation = 'surveypro' AND source_key LIKE $1`, [`VUNGU:${id}:%`]))[0].n

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl() })
    startedAt = (await q('SELECT now() AS t'))[0].t
    await q(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await q(`CREATE SCHEMA ${SCHEMA}`)
    await q(`CREATE TABLE ${SCHEMA}.projects (id int, authority_code text, name text, township text, designation text, survey_type text, survey_class text, external_job_id uuid,
               delivered_at timestamptz, review_decision text, reviewed_at timestamptz, review_note text)`)
    await q(`CREATE TABLE ${SCHEMA}.parcels (id int, project_id int, stand text, designation text, owner text, title_deed text, survey_date date, area_m2 numeric,
               status text, parcel_status text, srid int, lo_zone int, axis_order text, geom geometry)`)
  })

  afterAll(async () => {
    const c = await pool.connect()
    try {
      await c.query('BEGIN'); await c.query("SET LOCAL gms.purge = 'on'")
      const ids = (await c.query(`SELECT parcel_id FROM land.parcel WHERE source_relation = 'surveypro' AND source_key ~ '^VUNGU:991[0-9]{3}:'`)).rows.map((r) => r.parcel_id)
      if (ids.length) {
        await c.query('DELETE FROM integration.outbox_event WHERE idempotency_key = ANY($1::text[])', [ids.map((i) => `ParcelCreated:${i}`)])
        await c.query('DELETE FROM land.parcel WHERE parcel_id = ANY($1::text[])', [ids])
      }
      await c.query('DELETE FROM integration.surveypro_import_run WHERE started_at >= $1 OR error LIKE $2', [startedAt, '%SCHTEST%'])
      await c.query('COMMIT')
    } finally { c.release() }
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
  })

  test('it reads each council, enters what was accepted, and records the run without a secret in it', async () => {
    const p = await project([{ stand: 'A1', wkt: square(W0, S0) }, { stand: 'A2', wkt: square(W0 + 40, S0) }])
    const r = await run()
    expect(r.skipped).toBeUndefined()
    expect(r).toMatchObject({ status: 'ok', applied: true })
    expect(r.totals.imported).toBeGreaterThanOrEqual(2)
    expect(await inRegister(p.id)).toBe(2)
    const row = (await q('SELECT * FROM integration.surveypro_import_run WHERE id = $1', [r.id]))[0]
    expect(row).toMatchObject({ trigger: 'schedule', applied: true, status: 'ok', councils: 1 })
    expect(row.finished_at).not.toBeNull()
    const text = JSON.stringify(row)
    expect(text).not.toMatch(/postgres(ql)?:\/\//)
    expect(text).not.toContain(new URL(dbUrl()).password || 'no-password')
    expect(row.report[0]).toMatchObject({ council: 'TESTCOUNCIL' })
    expect(row.report[0].projects.find((x) => x.project === p.id).imported.map((x) => x.stand).sort()).toEqual(['A1', 'A2'])
  })

  test('a quiet run is recorded as quiet and changes nothing', async () => {
    const mineNow = async () => (await q("SELECT count(*)::int AS n FROM land.parcel WHERE source_relation = 'surveypro' AND source_key ~ '^VUNGU:991[0-9]{3}:'"))[0].n
    const before = await mineNow()
    const r = await run()
    expect(r.status).toBe('ok')
    expect(r.totals.imported).toBe(0)
    expect((await q('SELECT totals FROM integration.surveypro_import_run WHERE id = $1', [r.id]))[0].totals).toEqual({})
    expect(await mineNow()).toBe(before)
  })

  test('a dry run reads and reports, writes nothing to the register, and says it did not apply', async () => {
    const p = await project([{ stand: 'D1', wkt: square(W0 + 200, S0) }])
    const r = await run({ apply: false, trigger: 'manual' })
    expect(r.applied).toBe(false)
    expect(r.totals.imported).toBe(1)                                  // what it WOULD have entered
    expect(await inRegister(p.id)).toBe(0)
    expect((await q('SELECT trigger, applied FROM integration.surveypro_import_run WHERE id = $1', [r.id]))[0]).toEqual({ trigger: 'manual', applied: false })
    expect((await run()).totals.imported).toBeGreaterThanOrEqual(1)    // and the real run then does enter it
    expect(await inRegister(p.id)).toBe(1)
  })

  test('a layout the register refuses makes the run need attention, and it is not retried into the register', async () => {
    await project([{ stand: 'T1', wkt: square(W0 + 400, S0) }])
    await run()
    const clash = await project([{ stand: 'T1', wkt: square(W0 + 500, S0) }])         // same number, same township
    const r = await run()
    expect(r.status).toBe('attention')
    expect(r.totals.errors).toBeGreaterThanOrEqual(1)
    expect(await inRegister(clash.id)).toBe(0)
    const report = (await q('SELECT report FROM integration.surveypro_import_run WHERE id = $1', [r.id]))[0].report
    expect(report[0].projects.find((x) => x.project === clash.id).errors.map((e) => e.code)).toContain('stand_no_exists')
    expect((await run()).status).toBe('attention')                                     // still waiting for a person; nothing forced
  })

  test('a council that cannot be read fails alone: the others are still read, and its URL is not recorded', async () => {
    const p = await project([{ stand: 'F1', wkt: square(W0 + 600, S0) }])
    const down = { name: 'DOWNCOUNCIL', url: 'postgresql://nobody:SCHTEST-secret@127.0.0.1:1/none' }
    const r = await run({ readers: [down, ...readers()] })
    expect(r.status).toBe('failed')
    expect(r.councils[0].council).toBe('DOWNCOUNCIL')
    expect(r.councils[0].failed).toBeTruthy()
    expect(JSON.stringify(r.councils)).not.toContain('SCHTEST-secret')
    expect(await inRegister(p.id)).toBe(1)                                             // the other council was read all the same
    const row = (await q('SELECT report FROM integration.surveypro_import_run WHERE id = $1', [r.id]))[0]
    expect(JSON.stringify(row)).not.toContain('SCHTEST-secret')
  })

  test('two runs never overlap: one that finds the lock held does nothing and records nothing', async () => {
    const holder = await pool.connect()
    try {
      expect((await holder.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK_KEY])).rows[0].ok).toBe(true)
      const before = (await q('SELECT count(*)::int AS n FROM integration.surveypro_import_run'))[0].n
      const r = await run()
      expect(r).toEqual({ skipped: true, reason: 'another run is in progress' })
      expect((await q('SELECT count(*)::int AS n FROM integration.surveypro_import_run'))[0].n).toBe(before)
    } finally {
      await holder.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]); holder.release()
    }
    expect((await run()).skipped).toBeUndefined()                                      // and it is free again afterwards
  })

  test('with no council configured the run says so, as a failure a person will see', async () => {
    const r = await run({ readers: [] })
    expect(r.status).toBe('failed')
    expect(r.error).toMatch(/no council is configured/)
    expect((await q('SELECT status, error FROM integration.surveypro_import_run WHERE id = $1', [r.id]))[0].status).toBe('failed')
  })

  test('quiet runs are forgotten after a week, the ones that mattered are kept', async () => {
    const quiet = (await q(`INSERT INTO integration.surveypro_import_run (trigger, applied, status, finished_at, started_at, totals, error) VALUES ('schedule', true, 'ok', now(), now() - interval '30 days', '{}', 'SCHTEST quiet') RETURNING id`))[0].id
    const noisy = (await q(`INSERT INTO integration.surveypro_import_run (trigger, applied, status, finished_at, started_at, totals, error) VALUES ('schedule', true, 'attention', now(), now() - interval '30 days', '{"errors":1}', 'SCHTEST noisy') RETURNING id`))[0].id
    await run()
    const left = (await q('SELECT id FROM integration.surveypro_import_run WHERE id = ANY($1::bigint[])', [[quiet, noisy]])).map((r) => Number(r.id))
    expect(left).toEqual([Number(noisy)])
  })

  test('the recent runs come newest first, and the limit is kept sane', async () => {
    const runs = await recentRuns(pool, 3)
    expect(runs.length).toBeLessThanOrEqual(3)
    expect(new Date(runs[0].started_at) >= new Date(runs[runs.length - 1].started_at)).toBe(true)
    expect((await recentRuns(pool, -5)).length).toBeGreaterThanOrEqual(1)
    expect((await recentRuns(pool, 99999)).length).toBeLessThanOrEqual(200)
  })
})
