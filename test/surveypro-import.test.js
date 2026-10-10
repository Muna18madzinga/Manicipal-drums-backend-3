// Bringing a council's survey work in from SurveyPro (src/services/surveyproImport.js), against the live database.
//
// SurveyPro is a separate database, so the test stands in for its share views with two tables of the same shape in a scratch schema of
// this database. What is real: the VunGIS tables, the survey CRS registry, the transformation, the register's guard and the outbox.

require('dotenv').config()
const crypto = require('node:crypto')
const { Pool } = require('pg')
const { runImport, statusFromProject, mayMove, areasDisagree } = require('../src/services/surveyproImport')

const SCHEMA = 'sp_import_test'
const BASE_ID = 990000                       // project ids this suite uses, so cleanup can find them

// A 30 m square in Cape / Lo29 near Gweru. SurveyPro stores the WESTING as the X ordinate and the SOUTHING as the Y ordinate.
const square = (westing, southing, size = 30) =>
  `POLYGON((${westing} ${southing}, ${westing + size} ${southing}, ${westing + size} ${southing + size}, ${westing} ${southing + size}, ${westing} ${southing}))`
const W0 = -84035, S0 = 2151377

describe('importing the council\'s survey work from SurveyPro', () => {
  let pool, vungu, other, nextId = BASE_ID
  const jobs = []

  const q = async (sql, params = []) => (await pool.query(sql, params)).rows

  async function job(status = 'in_progress', authority = vungu) {
    const id = crypto.randomUUID()
    await q(`INSERT INTO spatial_planning.survey_task (id, task_type, stand_number, status, authority_id) VALUES ($1, 'pegging', 'SPI-TEST', $2, $3)`, [id, status, authority])
    jobs.push(id)
    return id
  }
  async function project(over = {}, parcels = []) {
    const id = nextId++
    const row = { id, authority_code: 'VUNGU', name: `SPI test ${id}`, township: 'SPI Township', designation: 'Stand 1', survey_type: 'Pegging', survey_class: 'B', external_job_id: null,
      delivered_at: null, review_decision: null, reviewed_at: null, review_note: null, ...over }
    await q(`INSERT INTO ${SCHEMA}.projects (id, authority_code, name, township, designation, survey_type, survey_class, external_job_id, delivered_at, review_decision, reviewed_at, review_note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [row.id, row.authority_code, row.name, row.township, row.designation, row.survey_type, row.survey_class, row.external_job_id, row.delivered_at, row.review_decision, row.reviewed_at, row.review_note])
    let n = 0
    for (const p of parcels) {
      n++
      await q(`INSERT INTO ${SCHEMA}.parcels (id, project_id, stand, designation, area_m2, status, parcel_status, srid, lo_zone, axis_order, geom)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'westing_southing', ST_GeomFromText($10, $8))`,
        [id * 10 + n, id, p.stand ?? `S${n}`, p.stand ?? `S${n}`, p.area ?? 900, p.status ?? 'finalized', p.parcel_status ?? 'active', p.srid ?? 22289, p.lo_zone === undefined ? 29 : p.lo_zone, p.wkt])
    }
    return row
  }
  const accepted = { delivered_at: '2026-06-01T08:00:00Z', review_decision: 'accepted', reviewed_at: '2026-06-02T08:00:00Z' }
  const run = (apply = true) => runImport(pool, pool, { apply, schema: SCHEMA })
  const mine = (report, id) => report.projects.find((p) => p.project === id)

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL })
    vungu = (await q("SELECT id FROM public.local_authorities WHERE code = 'VUNGU'"))[0].id
    other = (await q("SELECT id FROM public.local_authorities WHERE code = 'TESTCO'"))[0]?.id
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
      await c.query('BEGIN')
      await c.query("SET LOCAL gms.purge = 'on'")                       // the register never deletes: this is the test-only purge
      const ids = (await c.query(`SELECT parcel_id FROM land.parcel WHERE source_relation = 'surveypro' AND source_key ~ '^VUNGU:99[0-9]{4}:'`)).rows.map((r) => r.parcel_id)
      if (ids.length) {
        await c.query('DELETE FROM integration.outbox_event WHERE idempotency_key = ANY($1::text[])', [ids.map((i) => `ParcelCreated:${i}`)])
        await c.query('DELETE FROM land.parcel WHERE parcel_id = ANY($1::text[])', [ids])
      }
      await c.query("DELETE FROM land.parcel WHERE source = 'spi import test (approved plan)'")
      if (jobs.length) await c.query('DELETE FROM spatial_planning.survey_task WHERE id = ANY($1::uuid[])', [jobs])
      await c.query('COMMIT')
    } finally { c.release() }
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
  })

  describe('the rules that need no database', () => {
    test('a job follows its project: delivered, then the reviewer\'s decision', () => {
      expect(statusFromProject({})).toBeNull()
      expect(statusFromProject({ delivered_at: '2026-06-01' })).toBe('submitted')
      expect(statusFromProject({ delivered_at: '2026-06-01', review_decision: 'accepted', reviewed_at: '2026-06-02' })).toBe('accepted')
      expect(statusFromProject({ delivered_at: '2026-06-01', review_decision: 'returned', reviewed_at: '2026-06-02' })).toBe('returned')
      expect(statusFromProject({ delivered_at: '2026-06-01', review_decision: 'rejected', reviewed_at: '2026-06-02' })).toBe('returned')
    })
    test('a surveyor who delivers again after being returned is submitted again, not still returned', () => {
      expect(statusFromProject({ delivered_at: '2026-06-05', review_decision: 'returned', reviewed_at: '2026-06-02' })).toBe('submitted')
    })
    test('a job only moves forward, and never out of accepted or cancelled', () => {
      expect(mayMove('in_progress', 'submitted')).toBe(true)
      expect(mayMove('submitted', 'accepted')).toBe(true)
      expect(mayMove('returned', 'submitted')).toBe(true)
      expect(mayMove('accepted', 'submitted')).toBe(false)
      expect(mayMove('cancelled', 'accepted')).toBe(false)
      expect(mayMove('submitted', 'submitted')).toBe(false)
      expect(mayMove('submitted', null)).toBe(false)
    })
    test('areas disagree only beyond half a square metre and a tenth of a percent', () => {
      expect(areasDisagree(900, 900.4)).toBe(false)
      expect(areasDisagree(900, 901)).toBe(true)
      expect(areasDisagree(100000, 100050)).toBe(false)
      expect(areasDisagree(100000, 100200)).toBe(true)
      expect(areasDisagree(null, 900)).toBe(false)
    })
  })

  describe('status', () => {
    test('a delivered project makes its job submitted', async () => {
      const id = await job('in_progress')
      const p = await project({ external_job_id: id, delivered_at: '2026-06-01T08:00:00Z' })
      const r = mine(await run(), p.id)
      expect(r.status).toMatchObject({ from: 'in_progress', to: 'submitted' })
      expect((await q('SELECT status FROM spatial_planning.survey_task WHERE id = $1', [id]))[0].status).toBe('submitted')
    })
    test('an accepted project makes its job accepted, and a second run changes nothing', async () => {
      const id = await job('submitted')
      const p = await project({ external_job_id: id, ...accepted })
      expect(mine(await run(), p.id).status.to).toBe('accepted')
      expect(mine(await run(), p.id).status.to).toBeNull()
    })
    test('a returned project returns the job to the surveyor', async () => {
      const id = await job('submitted')
      const p = await project({ external_job_id: id, delivered_at: '2026-06-01T08:00:00Z', review_decision: 'rejected', reviewed_at: '2026-06-02T08:00:00Z' })
      mine(await run(), p.id)
      expect((await q('SELECT status FROM spatial_planning.survey_task WHERE id = $1', [id]))[0].status).toBe('returned')
    })
    test('a cancelled job is left alone', async () => {
      const id = await job('cancelled')
      const p = await project({ external_job_id: id, ...accepted })
      expect(mine(await run(), p.id).status.to).toBeNull()
      expect((await q('SELECT status FROM spatial_planning.survey_task WHERE id = $1', [id]))[0].status).toBe('cancelled')
    })
    test('a job that was already accepted in VunGIS is not pulled back by a delivery', async () => {
      const id = await job('accepted')
      const p = await project({ external_job_id: id, delivered_at: '2026-06-01T08:00:00Z' })
      expect(mine(await run(), p.id).status.to).toBeNull()
    })
    test("a project that names another authority's job, or no job at all, is reported, not applied", async () => {
      if (other) {
        const id = await job('in_progress', other)
        const p = await project({ external_job_id: id, delivered_at: '2026-06-01T08:00:00Z' })
        expect(mine(await run(), p.id).status.error).toBe('job_belongs_to_another_authority')
        expect((await q('SELECT status FROM spatial_planning.survey_task WHERE id = $1', [id]))[0].status).toBe('in_progress')
      }
      const p2 = await project({ external_job_id: crypto.randomUUID(), delivered_at: '2026-06-01T08:00:00Z' })
      expect(mine(await run(), p2.id).status.error).toBe('no_such_job')
    })
    test('a dry run reports the change and makes none', async () => {
      const id = await job('in_progress')
      const p = await project({ external_job_id: id, delivered_at: '2026-06-01T08:00:00Z' })
      expect(mine(await run(false), p.id).status.to).toBe('submitted')
      expect((await q('SELECT status FROM spatial_planning.survey_task WHERE id = $1', [id]))[0].status).toBe('in_progress')
    })
  })

  describe('parcels', () => {
    test('an accepted project\'s parcels enter the register, on the ground where the Lo coordinates say, awaiting the Surveyor-General', async () => {
      const p = await project(accepted, [{ stand: 'A1', wkt: square(W0, S0) }, { stand: 'A2', wkt: square(W0 + 30, S0) }])
      const r = mine(await run(), p.id)
      expect(r.parcels.errors).toEqual([])
      expect(r.parcels.imported).toHaveLength(2)
      const row = (await q(`SELECT stand_no, township_code, parcel_kind, origin, source_relation, source_key, sg_ref, survey_class, accuracy_basis, accuracy_class, status, authority_id, area_m2,
                                   source_srid, ST_SRID(geom_source) AS src, ST_SRID(geom_wgs84) AS wgs, transform_method, transform_accuracy_m,
                                   ST_X(ST_Centroid(geom_wgs84)) AS lon, ST_Y(ST_Centroid(geom_wgs84)) AS lat
                              FROM land.parcel WHERE source_key = $1`, [`VUNGU:${p.id}:${p.id * 10 + 1}`]))[0]
      expect(row).toMatchObject({ stand_no: 'A1', township_code: 'SPI Township', parcel_kind: 'stand', origin: 'authority', source_relation: 'surveypro', sg_ref: null,
        survey_class: 'B', accuracy_basis: 'surveyed', accuracy_class: null, status: 'current', authority_id: vungu })   // 'B' is the SI 727 class the survey declared, not a state; the legacy A-D grade is left empty
      expect(Number(row.area_m2)).toBe(900)
      // VunGIS's own registry SRID for Lo29, not SurveyPro's EPSG code, so the register has one transformation
      expect(row.source_srid).toBe(922029); expect(row.src).toBe(922029); expect(row.wgs).toBe(4326)
      expect(row.transform_method).toMatch(/Cape -> WGS 84/); expect(Number(row.transform_accuracy_m)).toBeGreaterThan(0)
      // the westing is X and the southing is Y, and the transformation puts a Gweru point in Gweru
      expect(row.lon).toBeGreaterThan(29.79); expect(row.lon).toBeLessThan(29.81)
      expect(row.lat).toBeGreaterThan(-19.46); expect(row.lat).toBeLessThan(-19.44)
      expect((await q("SELECT count(*)::int n FROM integration.outbox_event WHERE type = 'ParcelCreated' AND idempotency_key LIKE 'ParcelCreated:%' AND payload ->> 'stand_no' IN ('A1','A2')"))[0].n).toBeGreaterThanOrEqual(2)
    })

    test('nothing is imported until the council has accepted the project', async () => {
      const delivered = await project({ delivered_at: '2026-06-01T08:00:00Z' }, [{ stand: 'D1', wkt: square(W0 + 500, S0) }])
      const returned = await project({ delivered_at: '2026-06-01T08:00:00Z', review_decision: 'returned', reviewed_at: '2026-06-02T08:00:00Z' }, [{ stand: 'D2', wkt: square(W0 + 600, S0) }])
      const report = await run()
      expect(mine(report, delivered.id).parcels.imported).toEqual([])
      expect(mine(report, returned.id).parcels.imported).toEqual([])
    })

    test('a second run imports nothing twice', async () => {
      const p = await project(accepted, [{ stand: 'R1', wkt: square(W0 + 1000, S0) }])
      expect(mine(await run(), p.id).parcels.imported).toHaveLength(1)
      const again = mine(await run(), p.id)
      expect(again.parcels.imported).toEqual([])
      expect(again.parcels.unchanged).toHaveLength(1)
    })

    test('a boundary that changes after import is reported, never overwritten', async () => {
      const p = await project(accepted, [{ stand: 'V1', wkt: square(W0 + 1500, S0) }])
      await run()
      await q(`UPDATE ${SCHEMA}.parcels SET geom = ST_GeomFromText($2, 22289) WHERE project_id = $1`, [p.id, square(W0 + 1500, S0, 31)])
      const r = mine(await run(), p.id)
      expect(r.parcels.diverged).toHaveLength(1)
      const row = (await q('SELECT area_m2 FROM land.parcel WHERE source_key = $1', [`VUNGU:${p.id}:${p.id * 10 + 1}`]))[0]
      expect(Number(row.area_m2)).toBe(900)               // still the accepted boundary
    })

    test('only finalized, active parcels are imported; the rest are listed as skipped', async () => {
      const p = await project(accepted, [
        { stand: 'F1', wkt: square(W0 + 2000, S0) }, { stand: 'F2', wkt: square(W0 + 2100, S0), status: 'draft' },
        { stand: 'F3', wkt: square(W0 + 2200, S0), parcel_status: 'superseded' },
      ])
      const r = mine(await run(), p.id)
      expect(r.parcels.imported.map((x) => x.stand)).toEqual(['F1'])
      expect(r.parcels.skipped.map((x) => x.stand).sort()).toEqual(['F2', 'F3'])
    })

    test('a stand number already in the township refuses the whole layout', async () => {
      const first = await project(accepted, [{ stand: 'X1', wkt: square(W0 + 3000, S0) }])
      await run()
      const second = await project({ ...accepted }, [{ stand: 'X1', wkt: square(W0 + 3100, S0) }, { stand: 'X2', wkt: square(W0 + 3200, S0) }])
      const r = mine(await run(), second.id)
      expect(r.parcels.errors.map((e) => e.code)).toContain('stand_no_exists')
      expect(r.parcels.imported).toEqual([])               // X2 is fine on its own, but the layout is refused whole
      expect(first.id).not.toBe(second.id)
    })

    test('a parcel overlapping one already in the register refuses the layout', async () => {
      await project(accepted, [{ stand: 'O1', wkt: square(W0 + 4000, S0) }]); await run()
      const p = await project({ ...accepted, township: 'Another Township' }, [{ stand: 'O9', wkt: square(W0 + 4010, S0) }])
      const r = mine(await run(), p.id)
      expect(r.parcels.errors.map((e) => e.code)).toEqual(['overlaps_existing'])
      expect(r.parcels.errors[0].overlap_m2).toBeGreaterThan(100)
    })

    test('a parcel from an approved general plan has no source at all, and the layout still clashes with its number and its ground', async () => {
      // regression: `NOT (source_relation = 'surveypro' AND ...)` is NULL for such a parcel, so the clash and overlap checks skipped it
      await q(`WITH x AS (SELECT ST_SetSRID(ST_GeomFromText($1), 922029) AS g)
              INSERT INTO land.parcel (stand_no, township_code, geom_source, source_srid, geom_wgs84, transform_method, transform_accuracy_m, area_m2, accuracy_basis, source, parcel_kind, origin, sg_ref)
              SELECT '77', 'SPI Township', x.g, 922029, ST_Multi(ST_Transform(x.g, 4326)), 'test', 20, 900, 'general_plan', 'spi import test (approved plan)', 'stand', 'custodian', 'SPI-GP' FROM x`,
        [square(W0 + 6000, S0)])
      const sameNumber = await project(accepted, [{ stand: '77', wkt: square(W0 + 6200, S0) }])
      expect(mine(await run(), sameNumber.id).parcels.errors.map((e) => e.code)).toEqual(['stand_no_exists'])
      const sameGround = await project({ ...accepted, township: 'Another Township' }, [{ stand: 'Q1', wkt: square(W0 + 6010, S0) }])
      expect(mine(await run(), sameGround.id).parcels.errors.map((e) => e.code)).toEqual(['overlaps_existing'])
    })

    test('parcels in the same project that overlap each other refuse the layout; ones that share an edge do not', async () => {
      const bad = await project(accepted, [{ stand: 'W1', wkt: square(W0 + 5000, S0) }, { stand: 'W2', wkt: square(W0 + 5010, S0) }])
      expect(mine(await run(), bad.id).parcels.errors.map((e) => e.code)).toContain('overlap_within_project')
      const good = await project(accepted, [{ stand: 'E1', wkt: square(W0 + 5100, S0) }, { stand: 'E2', wkt: square(W0 + 5130, S0) }])
      expect(mine(await run(), good.id).parcels.imported).toHaveLength(2)
    })

    test('a repeated stand number inside the project, a bad polygon and a Lo zone the registry lacks are each refused with a reason', async () => {
      const dup = await project(accepted, [{ stand: 'Y1', wkt: square(W0 + 6000, S0) }, { stand: 'Y1', wkt: square(W0 + 6100, S0) }])
      expect(mine(await run(), dup.id).parcels.errors.map((e) => e.code)).toContain('duplicate_stand_no_in_project')
      const bowtie = await project(accepted, [{ stand: 'B1', wkt: `POLYGON((${W0 + 7000} ${S0}, ${W0 + 7030} ${S0 + 30}, ${W0 + 7030} ${S0}, ${W0 + 7000} ${S0 + 30}, ${W0 + 7000} ${S0}))` }])
      expect(mine(await run(), bowtie.id).parcels.errors.map((e) => e.code)).toContain('invalid_geometry')
      const lo25 = await project(accepted, [{ stand: 'Z1', wkt: square(W0 + 8000, S0), srid: 22285, lo_zone: 25 }])
      expect(mine(await run(), lo25.id).parcels.errors.map((e) => e.code)).toEqual(['unsupported_crs'])
      const utm = await project(accepted, [{ stand: 'U1', wkt: square(300000, 7800000), srid: 32735, lo_zone: null }])
      expect(mine(await run(), utm.id).parcels.errors.map((e) => e.code)).toEqual(['unsupported_crs'])
    })

    test('the survey class is the one the surveyor declared: class C stays C, whatever has been accepted or approved', async () => {
      const p = await project({ ...accepted, survey_class: 'C' }, [{ stand: 'K1', wkt: square(W0 + 9100, S0) }])
      const r = mine(await run(), p.id)
      expect(r.survey_class).toBe('C')
      const row = (await q('SELECT survey_class, origin, sg_ref FROM land.parcel WHERE source_key = $1', [`VUNGU:${p.id}:${p.id * 10 + 1}`]))[0]
      expect(row).toEqual({ survey_class: 'C', origin: 'authority', sg_ref: null })   // state lives in origin and sg_ref, not in the class
    })

    test('a project with no declared survey class is refused, not given one', async () => {
      const p = await project({ ...accepted, survey_class: null }, [{ stand: 'NC1', wkt: square(W0 + 9200, S0) }])
      const r = mine(await run(), p.id)
      expect(r.parcels.errors.map((e) => e.code)).toEqual(['no_survey_class'])
      expect(r.parcels.imported).toEqual([])
    })

    test('a class SI 727 has no limits for is refused, whatever the letter', async () => {
      for (const [i, cls] of ['A', 'D', 'X'].entries()) {
        const p = await project({ ...accepted, survey_class: cls }, [{ stand: `UC${i}`, wkt: square(W0 + 9300 + i * 100, S0) }])
        expect(mine(await run(), p.id).parcels.errors.map((e) => e.code)).toEqual(['unknown_survey_class'])
      }
    })

    test('class A is refused for parcels with its real meaning, and a class that does not match the township is reported, not refused', async () => {
      const a = await project({ ...accepted, survey_class: 'A' }, [{ stand: 'CA1', wkt: square(W0 + 9800, S0) }])
      const ra = mine(await run(), a.id)
      expect(ra.parcels.errors[0].note).toMatch(/town survey-marks/)
      const c = await project({ ...accepted, survey_class: 'C' }, [{ stand: 'CT1', wkt: square(W0 + 9900, S0) }])   // the fixture names a township
      const rc = mine(await run(), c.id)
      expect(rc.parcels.errors).toEqual([])
      expect(rc.parcels.warnings.map((w) => [w.code, w.expected])).toEqual([['class_vs_township', 'B']])
      expect(rc.parcels.imported).toHaveLength(1)
    })

    test('a lower-case class is accepted as the same class', async () => {
      const p = await project({ ...accepted, survey_class: ' c ' }, [{ stand: 'LC1', wkt: square(W0 + 9700, S0) }])
      mine(await run(), p.id)
      expect((await q('SELECT survey_class FROM land.parcel WHERE source_key = $1', [`VUNGU:${p.id}:${p.id * 10 + 1}`]))[0].survey_class).toBe('C')
    })

    test('a project whose parcels are all in the register already needs no class to say so again', async () => {
      const p = await project(accepted, [{ stand: 'NR1', wkt: square(W0 + 9750, S0) }])
      await run()
      await q(`UPDATE ${SCHEMA}.projects SET survey_class = NULL WHERE id = $1`, [p.id])
      const r = mine(await run(), p.id)
      expect(r.parcels.errors).toEqual([])
      expect(r.parcels.unchanged).toHaveLength(1)
    })

    test('an area that disagrees with the geometry is reported, and the geometry\'s figure is the one kept', async () => {
      const p = await project(accepted, [{ stand: 'AR1', wkt: square(W0 + 9000, S0), area: 1000 }])
      const r = mine(await run(), p.id)
      expect(r.parcels.warnings).toEqual([expect.objectContaining({ code: 'area_disagrees', surveypro_m2: 1000, computed_m2: 900 })])
      expect(Number((await q('SELECT area_m2 FROM land.parcel WHERE source_key = $1', [`VUNGU:${p.id}:${p.id * 10 + 1}`]))[0].area_m2)).toBe(900)
    })

    test('a project with no township gives plots, not stands in a township called nothing', async () => {
      const p = await project({ ...accepted, township: null }, [{ stand: 'PL1', wkt: square(W0 + 9500, S0) }])
      mine(await run(), p.id)
      const row = (await q('SELECT parcel_kind, township_code FROM land.parcel WHERE source_key = $1', [`VUNGU:${p.id}:${p.id * 10 + 1}`]))[0]
      expect(row).toEqual({ parcel_kind: 'plot', township_code: null })
    })

    test('a dry run reports the parcels and imports none', async () => {
      const p = await project(accepted, [{ stand: 'DR1', wkt: square(W0 + 9800, S0) }])
      expect(mine(await run(false), p.id).parcels.imported).toHaveLength(1)
      expect((await q('SELECT count(*)::int n FROM land.parcel WHERE source_key = $1', [`VUNGU:${p.id}:${p.id * 10 + 1}`]))[0].n).toBe(0)
    })

    test('a project of an authority VunGIS does not know is reported, not applied', async () => {
      const p = await project({ ...accepted, authority_code: 'NOWHERE' }, [{ stand: 'N1', wkt: square(W0 + 9900, S0) }])
      expect(mine(await run(), p.id).parcels.errors.map((e) => e.code)).toEqual(['unknown_authority'])
    })
  })
})
