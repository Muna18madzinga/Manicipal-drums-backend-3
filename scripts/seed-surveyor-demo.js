/**
 * seed-surveyor-demo.js
 *
 * The `survey` schema is almost entirely empty even though a real surveyor
 * profile and 14 spatial_planning.survey_task rows already exist. This gives
 * the surveyor workspace something to open: two projects on the existing
 * profile, a legacy-style surveyors row for the demo surveyor's login, a
 * closed two-parcel traverse, four national control points, workflow state
 * at two different stages, and two rows each of survey_parcel/survey_layout
 * hung off real, pre-existing survey_task rows.
 *
 * Coordinates are all real Vungu RDC / Midlands ground (around
 * lng 29.79, lat -19.46), transformed through PostGIS into whatever SRID the
 * target column actually declares (survey.coordinate_points is Cape/Lo31,
 * SRID 22291; the zim_control_points x/y columns are plain Lo29 numbers, so
 * they are computed via SRID 22289 and split west/south per the CRS's own
 * axis order, matching the y_gauss/x_gauss column names).
 *
 * Idempotent via seedkit's `ensure`; a re-run adds nothing.
 *
 *     node scripts/seed-surveyor-demo.js
 *     node scripts/seed-surveyor-demo.js --undo
 */

try { require('dotenv').config({ quiet: true }) } catch (_) { /* optional */ }
const { Pool } = require('pg')
const { forget, ensure } = require('./lib/seedkit')

const DATABASE_URL = process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/Vungu_spatial334'

const TAG = 'VUNGU-SURVEYOR-DEMO'

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)

async function publicUserId (db, email) {
  const { rows } = await db.query('SELECT id FROM public.users WHERE email = $1', [email])
  if (!rows.length) throw new Error(`No user ${email}. Run: node scripts/seed-demo-users.js`)
  return rows[0].id
}

/** WGS84 lng/lat -> EWKT text in `srid`, computed by PostGIS itself. */
async function ewkt (db, lng, lat, srid) {
  const { rows } = await db.query(
    'SELECT ST_AsEWKT(ST_Transform(ST_SetSRID(ST_MakePoint($1,$2),4326), $3::int)) AS wkt',
    [lng, lat, srid])
  return rows[0].wkt
}

/** A regular n-gon of [lng, lat] pairs around a centre, closed (first = last). */
function ring (lng, lat, radiusDeg, n) {
  const pts = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    pts.push([lng + radiusDeg * Math.cos(a), lat + radiusDeg * Math.sin(a) * 0.85])
  }
  pts.push(pts[0])
  return pts
}

/** Planar area (m²) and perimeter (m) of a closed lng/lat ring, equirectangular approx — fine at this scale. */
function ringMetrics (points) {
  const lat0 = points[0][1]
  const mLng = 111320 * Math.cos(lat0 * Math.PI / 180)
  const mLat = 111320
  const xy = points.map(([lng, lat]) => [lng * mLng, lat * mLat])
  let area = 0
  let perim = 0
  for (let i = 0; i < xy.length - 1; i++) {
    const [x1, y1] = xy[i]
    const [x2, y2] = xy[i + 1]
    area += x1 * y2 - x2 * y1
    perim += Math.hypot(x2 - x1, y2 - y1)
  }
  return { area: Math.abs(area) / 2, perimeter: perim }
}

async function seed (db) {
  const surveyorUser = await publicUserId(db, 'demo.surveyor@vungu.test')
  const gisUser = await publicUserId(db, 'demo.gis@vungu.test')

  const surveyUsers = await db.query('SELECT id FROM survey.users WHERE email = $1', ['demo.surveyor@vungu.test'])
  if (!surveyUsers.rows.length) throw new Error('No survey.users row for demo.surveyor@vungu.test')
  const surveyUserId = surveyUsers.rows[0].id

  const profile = await db.query(
    'SELECT id FROM survey.surveyor_profiles WHERE user_id = $1 LIMIT 1', [surveyUserId])
  if (!profile.rows.length) throw new Error('No survey.surveyor_profiles row for the demo surveyor')
  const profileId = profile.rows[0].id

  // ── 1. Legacy surveyors row for the demo surveyor's login ──────────────
  await ensure(db, TAG, 'survey.surveyors', {
    name: 'Demo Surveyor',
    license_number: 'VUNGU-DEMO-01',
    firm: 'Vungu Rural District Council',
    address: '19 Lincoln Road, Light Industrial Site, Gweru',
    phone: '+263 77 000 0100',
    email: 'demo.surveyor@vungu.test',
    user_id: surveyUserId,
    is_active: true,
  }, 'license_number = $1', ['VUNGU-DEMO-01'])

  // ── 2. Two survey projects on the existing profile ──────────────────────
  const projA = await ensure(db, TAG, 'survey.survey_projects', {
    name: 'Ward 7 Communal Land Resurvey',
    client_name: 'Vungu Rural District Council',
    district: 'Vungu',
    survey_type: 'cadastral',
    survey_date: daysAgo(30),
    instruments: 'RTK GNSS, total station',
    designation: 'Cadastral resurvey',
    status: 'active',
    central_meridian: 31,
    working_directory: 'C:/Surveys/Vungu/Ward7Resurvey',
    surveyor_profile_id: profileId,
    stand_reference: 'Communal Land',
    parent_property: 'Vungu Communal Land',
  }, 'name = $1', ['Ward 7 Communal Land Resurvey'])

  const projB = await ensure(db, TAG, 'survey.survey_projects', {
    name: 'Lalapanzi Stand Layout — SRV-SMK-1',
    client_name: 'Vungu Rural District Council',
    district: 'Ward 4 — Lalapanzi',
    survey_type: 'layout',
    survey_date: daysAgo(10),
    instruments: 'RTK GNSS',
    designation: 'Residential layout design',
    status: 'active',
    central_meridian: 31,
    working_directory: 'C:/Surveys/Vungu/LalapanziLayout',
    surveyor_profile_id: profileId,
    stand_reference: 'SRV-SMK-1',
    township: 'Lalapanzi',
    parent_property: 'Remainder of Lalapanzi Farm',
  }, 'name = $1', ['Lalapanzi Stand Layout — SRV-SMK-1'])

  // ── 3. Twelve coordinate points: two closed hexagonal parcels ───────────
  const parcelA = ring(29.7894, -19.4612, 0.0007, 6)   // Ward 7, ~80m across
  const parcelB = ring(29.7975, -19.4550, 0.0005, 6)   // Lalapanzi, ~55m across

  for (const [proj, pts, label] of [[projA, parcelA, 'Ward7'], [projB, parcelB, 'Lalapanzi']]) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [lng, lat] = pts[i]
      const geom = await ewkt(db, lng, lat, 22291)
      await ensure(db, TAG, 'survey.coordinate_points', {
        project_id: proj,
        name: `BN${i + 1}`,
        geom,
        elevation: 1418 + i,
        description: `${label} beacon ${i + 1}`,
        survey_date: daysAgo(proj === projA ? 30 : 10),
        surveyor: 'Demo Surveyor',
      }, 'project_id = $1 AND name = $2', [proj, `BN${i + 1}`])
    }
  }

  // ── 4. Four Zimbabwe national control points ─────────────────────────
  const controls = [
    ['ZW/29/VUN/0001', 'Vungu Beacon 1', 'PRIM', '1929', 29.7810, -19.4520, 'Concrete pillar, good condition'],
    ['ZW/29/VUN/0002', 'Vungu Beacon 2', 'SEC', '1929', 29.8050, -19.4700, 'Concrete pillar, good condition'],
    ['ZW/29/VUN/0003', 'Somabula Beacon 1', 'TERT', '1930', 29.6600, -19.6600, 'Steel peg, capped'],
    ['ZW/29/VUN/0004', 'Lalapanzi Beacon 1', 'QUART', '1930', 29.7975, -19.4550, 'Steel peg, slightly disturbed'],
  ]
  for (const [monuNum, monuName, type, compSheet, lng, lat, remark] of controls) {
    const { rows } = await db.query(
      'SELECT ST_X(ST_Transform(ST_SetSRID(ST_MakePoint($1,$2),4326), 22289)) AS y, ' +
      '       ST_Y(ST_Transform(ST_SetSRID(ST_MakePoint($1,$2),4326), 22289)) AS x',
      [lng, lat])
    await ensure(db, TAG, 'survey.zim_control_points', {
      monu_num: monuNum,
      monu_name: monuName,
      type,
      comp_sheet: compSheet,
      gauss_lo: 29,
      y_gauss: rows[0].y,
      x_gauss: rows[0].x,
      msl_hgt: 1420,
      last_insp: daysAgo(200),
      remark,
      area_nm: 'Vungu',
      created_by: surveyUserId,
      lat_wgs84: lat,
      lng_wgs84: lng,
    }, 'monu_num = $1', [monuNum])
  }

  // ── 5. Workflow state per project, at different stages ──────────────────
  await ensure(db, TAG, 'survey.workflow_states', {
    project_id: projA,
    current_step: 'control-point-selection',
    step_data: JSON.stringify({ 'project-setup': { central_meridian: 31 } }),
    completed_steps: ['project-setup', 'csv-import'],
  }, 'project_id = $1', [projA])

  await ensure(db, TAG, 'survey.workflow_states', {
    project_id: projB,
    current_step: 'area-computation',
    step_data: JSON.stringify({ 'project-setup': { central_meridian: 31 } }),
    completed_steps: ['project-setup', 'csv-import', 'control-point-selection', 'calculations-part1', 'coordinate-list'],
  }, 'project_id = $1', [projB])

  // ── 6. survey_parcel / survey_layout on existing survey_task rows ───────
  const parcelTaskA = '13b2654b-f021-4d39-bf49-e32ae12012db' // pegging, stand 1234, Ward 7
  const parcelTaskB = '8e31efba-5230-4134-9787-c47388c7080c' // verification, Somabula, Ward 18
  const { rows: taskRows } = await db.query(
    'SELECT id FROM spatial_planning.survey_task WHERE id = ANY($1)', [[parcelTaskA, parcelTaskB]])
  const foundTaskIds = new Set(taskRows.map(r => r.id))

  if (foundTaskIds.has(parcelTaskA)) {
    const m = ringMetrics(parcelA)
    await ensure(db, TAG, 'spatial_planning.survey_parcel', {
      survey_task_id: parcelTaskA,
      points: JSON.stringify(parcelA.map(([lng, lat]) => ({ lng, lat }))),
      area_m2: Math.round(m.area * 100) / 100,
      perimeter_m: Math.round(m.perimeter * 100) / 100,
      closure_error_m: 0.012,
      closure_ratio: '1:15000',
      status: 'finalized',
      created_by: surveyorUser,
    }, 'survey_task_id = $1', [parcelTaskA])
  }

  if (foundTaskIds.has(parcelTaskB)) {
    const m = ringMetrics(parcelB)
    await ensure(db, TAG, 'spatial_planning.survey_parcel', {
      survey_task_id: parcelTaskB,
      points: JSON.stringify(parcelB.map(([lng, lat]) => ({ lng, lat }))),
      area_m2: Math.round(m.area * 100) / 100,
      perimeter_m: Math.round(m.perimeter * 100) / 100,
      closure_error_m: 0.028,
      closure_ratio: '1:6400',
      status: 'draft',
      created_by: surveyorUser,
    }, 'survey_task_id = $1', [parcelTaskB])
  }

  const layoutTaskA = '44b61775-8742-412f-bb87-cbfcc0d62d5e' // SRV-SMK-1, Lalapanzi
  const layoutTaskB = '7d634daa-2752-4c37-a264-71b4df6b0bcd' // SRV-SMK-1, Lalapanzi
  const { rows: layoutTaskRows } = await db.query(
    'SELECT id FROM spatial_planning.survey_task WHERE id = ANY($1)', [[layoutTaskA, layoutTaskB]])
  const foundLayoutIds = new Set(layoutTaskRows.map(r => r.id))

  if (foundLayoutIds.has(layoutTaskA)) {
    await ensure(db, TAG, 'spatial_planning.survey_layout', {
      survey_task_id: layoutTaskA,
      layout_name: 'Lalapanzi Extension Layout A',
      parent_property: 'Remainder of Lalapanzi Farm',
      ward: 'Ward 4 — Lalapanzi',
      parent_area_ha: 12.4,
      stands_planned: 42,
      status: 'designed',
      designer: 'Demo Surveyor',
      notes: 'Residential stands, average 800 sqm, road reserve along the eastern boundary.',
      created_by: gisUser,
    }, 'survey_task_id = $1', [layoutTaskA])
  }

  if (foundLayoutIds.has(layoutTaskB)) {
    await ensure(db, TAG, 'spatial_planning.survey_layout', {
      survey_task_id: layoutTaskB,
      layout_name: 'Lalapanzi Extension Layout B',
      parent_property: 'Remainder of Lalapanzi Farm',
      ward: 'Ward 4 — Lalapanzi',
      parent_area_ha: 8.7,
      stands_planned: 28,
      status: 'pre_survey',
      designer: 'Demo Surveyor',
      notes: 'Awaiting confirmation of the access road alignment before pegging.',
      created_by: gisUser,
    }, 'survey_task_id = $1', [layoutTaskB])
  }

  return { projA, projB }
}

;(async () => {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  })
  const db = await pool.connect()
  const undoing = process.argv.includes('--undo')
  try {
    await db.query('BEGIN')
    if (undoing) {
      const n = await forget(db, TAG)
      await db.query('COMMIT')
      console.log(`Removed ${n} row(s) created by ${TAG}.`)
    } else {
      await seed(db)
      await db.query('COMMIT')
      const { rows } = await db.query(
        'SELECT count(*)::int n FROM public.seed_demo_ledger WHERE tag = $1', [TAG])
      console.log(`Seeded the surveyor demo data (${rows[0].n} rows tracked).`)
    }
  } catch (e) {
    await db.query('ROLLBACK')
    console.error('FAILED (rolled back):', e.message)
    process.exitCode = 1
  } finally {
    db.release()
    await pool.end()
  }
})()
