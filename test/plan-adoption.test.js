// Reconciliation when the Surveyor-General's approved plan reaches stands a council has already surveyed
// (src/services/gms/parcelImport.js; docs/HARMONIZATION-SCOPE.md, piece B), against the live database.
//
// What is real: the VunGIS tables, the survey CRS registry, the transformation, the register's guard and the outbox. The council's earlier
// work is inserted as authority-origin parcels exactly as the SurveyPro importer writes them.

require('dotenv').config()
const { Pool } = require('pg')
const { importGeneralPlan, ADOPT_TOLERANCE_M } = require('../src/services/gms/parcelImport')

const SRID = 922029                       // Cape / Lo29 in the registry
const TOWN = 'ADOPT-TEST-TOWN'
const SG = 'ADOPT-TEST-SG'
// its own patch of ground, so suites running side by side cannot meet on it
const W0 = -87500, S0 = 2154500
// a 30 m square as GeoJSON in the survey CRS (x = westing, y = southing), optionally shifted
const sq = (w, s, dx = 0, size = 30) => ({ type: 'Polygon', coordinates: [[[w + dx, s], [w + size + dx, s], [w + size + dx, s + size], [w + dx, s + size], [w + dx, s]]] })

describe('adopting the council\'s stands when the approved plan arrives', () => {
  let pool
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows

  async function authorityParcel({ stand, geometry, kind = 'stand', township = TOWN, origin = 'authority', sg_ref = null, key }) {
    const k = key || `ADOPT:${stand}:${Math.random().toString(36).slice(2)}`
    const row = (await q(
      `WITH x AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), $2::int) AS g)
       INSERT INTO land.parcel (stand_no, township_code, geom_source, source_srid, geom_wgs84, transform_method, transform_accuracy_m, area_m2,
                                survey_class, accuracy_basis, source, custodian_dept, parcel_kind, origin, sg_ref, source_relation, source_key)
       SELECT $3, $4, x.g, $2::int, ST_Multi(ST_Transform(x.g, 4326)), 'test', 20, round(ST_Area(x.g)::numeric, 2),
              'B', 'surveyed', 'council survey (test)', 'Local authority survey (SurveyPro), awaiting the Surveyor-General', $5, $6, $7, 'surveypro', $8
         FROM x RETURNING parcel_id`,
      [JSON.stringify(geometry), SRID, stand, kind === 'plot' ? null : township, kind, origin, sg_ref, k]))[0]
    return row.parcel_id
  }
  const plan = (features, commit = true, ref = SG) => ({ sg_ref: ref, township_code: TOWN, source_srid: SRID, commit, features: features.map(([stand_no, geometry]) => ({ type: 'Feature', properties: { stand_no }, geometry })) })
  const imp = (features, commit = true) => importGeneralPlan(pool, plan(features, commit), { id: null })
  const parcel = async (id) => (await q(`SELECT parcel_id, stand_no, township_code, parcel_kind, origin, sg_ref, general_plan_id, accuracy_basis, survey_class, source_srid,
                                                ST_AsText(geom_source) AS wkt, round(area_m2, 2) AS area_m2, custodian_dept FROM land.parcel WHERE parcel_id = $1`, [id]))[0]

  async function wipe() {
    const c = await pool.connect()
    try {
      await c.query('BEGIN'); await c.query("SET LOCAL gms.purge = 'on'")
      const ids = (await c.query(`SELECT parcel_id FROM land.parcel WHERE township_code = $1 OR source_key LIKE 'ADOPT:%' OR sg_ref LIKE 'ADOPT-TEST%'`, [TOWN])).rows.map((r) => r.parcel_id)
      if (ids.length) {
        await c.query('DELETE FROM land.parcel_event WHERE parcel_id = ANY($1::text[])', [ids])
        await c.query(`DELETE FROM integration.outbox_event WHERE payload ->> 'parcel_id' = ANY($1::text[])`, [ids])
        await c.query('DELETE FROM land.parcel WHERE parcel_id = ANY($1::text[])', [ids])
      }
      await c.query(`DELETE FROM land.general_plan WHERE sg_ref LIKE 'ADOPT-TEST%'`)
      await c.query('COMMIT')
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  }

  beforeAll(async () => { pool = new Pool({ connectionString: process.env.DATABASE_URL }); await wipe() })
  afterEach(wipe)
  afterAll(async () => { await wipe(); await pool.end() })

  test('a stand the council surveyed is adopted in place: same parcel, now approved, nothing duplicated', async () => {
    const mine = await authorityParcel({ stand: 'A1', geometry: sq(W0, S0) })
    const r = await imp([['A1', sq(W0, S0)], ['A2', sq(W0 + 40, S0)]])
    expect(r.ok).toBe(true)
    expect(r.report.summary).toEqual({ new: 1, adopt: 1, conflicts: 0, orphans: 0 })
    expect(r.adopted_ids).toEqual([mine])
    expect(r.parcel_ids).toHaveLength(1)
    const after = await parcel(mine)
    expect(after).toMatchObject({ parcel_id: mine, stand_no: 'A1', township_code: TOWN, origin: 'custodian', sg_ref: SG, accuracy_basis: 'general_plan', survey_class: 'B', custodian_dept: 'Survey Section' })
    expect(after.general_plan_id).not.toBeNull()
    expect((await q('SELECT count(*)::int AS n FROM land.parcel WHERE township_code = $1 AND stand_no = $2', [TOWN, 'A1']))[0].n).toBe(1)
  })

  test('what the parcel was is kept, and the ERP link hears it is the same parcel, now approved', async () => {
    const mine = await authorityParcel({ stand: 'B1', geometry: sq(W0, S0 + 100) })
    const before = await parcel(mine)
    await imp([['B1', sq(W0, S0 + 100)]])
    const ev = (await q('SELECT event, general_plan_id, details, ST_AsText(previous_geom) AS wkt, previous_srid FROM land.parcel_event WHERE parcel_id = $1', [mine]))[0]
    expect(ev.event).toBe('adopted')
    expect(ev.wkt).toBe(before.wkt)
    expect(ev.previous_srid).toBe(SRID)
    expect(ev.details).toMatchObject({ origin: 'authority', stand_no: 'B1', matched_by: 'stand_no', accuracy_basis: 'surveyed' })
    const out = await q(`SELECT type, payload FROM integration.outbox_event WHERE idempotency_key = $1`, [`ParcelApproved:${mine}:${SG}`])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'ParcelApproved' })
    expect(out[0].payload).toMatchObject({ parcel_id: mine, sg_ref: SG, matched_by: 'stand_no' })
  })

  test('the event record cannot be changed afterwards', async () => {
    const mine = await authorityParcel({ stand: 'B2', geometry: sq(W0, S0 + 150) })
    await imp([['B2', sq(W0, S0 + 150)]])
    await expect(pool.query(`UPDATE land.parcel_event SET event = 'adopted' WHERE parcel_id = $1`, [mine])).rejects.toThrow(/append-only/)
    await expect(pool.query('DELETE FROM land.parcel_event WHERE parcel_id = $1', [mine])).rejects.toThrow(/append-only/)
  })

  test(`a boundary within ${ADOPT_TOLERANCE_M} m agrees, and the approved plan's geometry becomes the parcel's`, async () => {
    const mine = await authorityParcel({ stand: 'C1', geometry: sq(W0, S0 + 200) })
    const r = await imp([['C1', sq(W0, S0 + 200, 0.01)]])
    expect(r.ok).toBe(true)
    expect(r.report.adopt[0].deviation_m).toBeGreaterThan(0)
    expect(r.report.adopt[0].deviation_m).toBeLessThanOrEqual(ADOPT_TOLERANCE_M)
    expect((await parcel(mine)).wkt).toContain(`${W0 + 0.01} ${S0 + 200}`)
  })

  test('a boundary further off is a conflict: both boundaries are shown and nothing is written', async () => {
    const mine = await authorityParcel({ stand: 'D1', geometry: sq(W0, S0 + 250) })
    const before = await parcel(mine)
    const r = await imp([['D1', sq(W0, S0 + 250, 0.5)], ['D2', sq(W0 + 40, S0 + 250)]])
    expect(r.ok).toBe(false)
    expect(r.committed).toBe(false)
    const e = r.report.errors.find((x) => x.code === 'boundary_differs')
    expect(e).toMatchObject({ stand_no: 'D1', parcel_id: mine })
    expect(e.deviation_m).toBeGreaterThan(ADOPT_TOLERANCE_M)
    expect(e.plan_geometry.type).toMatch(/Polygon/)
    expect(e.register_geometry.type).toMatch(/Polygon/)
    expect(r.report.summary.conflicts).toBe(1)
    expect(await parcel(mine)).toEqual(before)
    expect((await q(`SELECT count(*)::int AS n FROM land.parcel WHERE township_code = $1 AND stand_no = 'D2'`, [TOWN]))[0].n).toBe(0)   // the whole plan waits
  })

  test('a stand already approved by the Surveyor-General is refused, as ever', async () => {
    await authorityParcel({ stand: 'E1', geometry: sq(W0, S0 + 300), origin: 'custodian', sg_ref: 'ADOPT-TEST-EARLIER' })
    const r = await imp([['E1', sq(W0, S0 + 300)]])
    expect(r.ok).toBe(false)
    expect(r.report.errors.map((x) => x.code)).toEqual(['stand_no_exists'])
  })

  test('a plot (no township) is matched by its boundary and becomes a stand of the township', async () => {
    const plot = await authorityParcel({ stand: 'plot-7', geometry: sq(W0 + 100, S0), kind: 'plot' })
    const r = await imp([['F5', sq(W0 + 100, S0)]])
    expect(r.ok).toBe(true)
    expect(r.report.adopt[0]).toMatchObject({ parcel_id: plot, matched_by: 'geometry' })
    expect(r.report.adopt[0].iou).toBeGreaterThanOrEqual(0.99)
    expect(await parcel(plot)).toMatchObject({ stand_no: 'F5', township_code: TOWN, parcel_kind: 'stand', origin: 'custodian', sg_ref: SG })
    expect((await q('SELECT details FROM land.parcel_event WHERE parcel_id = $1', [plot]))[0].details).toMatchObject({ stand_no: 'plot-7', parcel_kind: 'plot', matched_by: 'geometry' })
  })

  test('two plots that both fit one stand, or a plot that fits two, is ambiguous: nothing is guessed', async () => {
    await authorityParcel({ stand: 'plot-a', geometry: sq(W0 + 200, S0), kind: 'plot' })
    await authorityParcel({ stand: 'plot-b', geometry: sq(W0 + 200, S0), kind: 'plot' })
    const r = await imp([['G1', sq(W0 + 200, S0)]])
    expect(r.ok).toBe(false)
    expect(r.report.errors.map((x) => x.code)).toEqual(['ambiguous_match'])
  })

  test('a plan stand on top of the council\'s stand of ANOTHER number is a numbering conflict, not a second parcel', async () => {
    const mine = await authorityParcel({ stand: 'H9', geometry: sq(W0 + 300, S0) })
    const r = await imp([['H1', sq(W0 + 300, S0)]])
    expect(r.ok).toBe(false)
    expect(r.report.errors).toEqual([expect.objectContaining({ code: 'overlaps_authority_parcel', stand_no: 'H1', parcel_id: mine, parcel_stand_no: 'H9' })])
  })

  test('a neighbour that only shares an edge is not a conflict', async () => {
    await authorityParcel({ stand: 'J1', geometry: sq(W0 + 400, S0) })
    const r = await imp([['J2', sq(W0 + 430, S0)]])
    expect(r.ok).toBe(true)
    expect(r.report.summary).toMatchObject({ new: 1, adopt: 0, conflicts: 0, orphans: 1 })
  })

  test('the council\'s stands the plan does not mention are reported as orphans and left alone', async () => {
    const kept = await authorityParcel({ stand: 'K1', geometry: sq(W0 + 500, S0) })
    const before = await parcel(kept)
    const r = await imp([['K2', sq(W0 + 600, S0)]])
    expect(r.ok).toBe(true)
    expect(r.report.orphans).toEqual([expect.objectContaining({ parcel_id: kept, stand_no: 'K1' })])
    expect(await parcel(kept)).toEqual(before)
  })

  test('a dry run reports the adoption and writes nothing', async () => {
    const mine = await authorityParcel({ stand: 'L1', geometry: sq(W0 + 700, S0) })
    const before = await parcel(mine)
    const r = await imp([['L1', sq(W0 + 700, S0)]], false)
    expect(r.ok).toBe(true)
    expect(r.committed).toBe(false)
    expect(r.report.summary.adopt).toBe(1)
    expect(await parcel(mine)).toEqual(before)
    expect((await q('SELECT count(*)::int AS n FROM land.parcel_event WHERE parcel_id = $1', [mine]))[0].n).toBe(0)
  })

  test('a plan for a township with nothing of the council\'s behaves exactly as before', async () => {
    const r = await imp([['M1', sq(W0 + 800, S0)], ['M2', sq(W0 + 840, S0)]])
    expect(r.ok).toBe(true)
    expect(r.report.summary).toEqual({ new: 2, adopt: 0, conflicts: 0, orphans: 0 })
    expect(r.parcel_ids).toHaveLength(2)
    expect(r.adopted_ids).toEqual([])
  })

  test('importing the same plan again is refused (the stands are approved now)', async () => {
    await authorityParcel({ stand: 'N1', geometry: sq(W0 + 900, S0) })
    expect((await imp([['N1', sq(W0 + 900, S0)]])).ok).toBe(true)
    const again = await imp([['N1', sq(W0 + 900, S0)]])
    expect(again.ok).toBe(false)
    expect(again.report.errors.map((x) => x.code)).toEqual(['stand_no_exists'])
  })
})
