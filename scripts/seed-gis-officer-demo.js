/**
 * seed-gis-officer-demo.js
 *
 * The GIS officer portal has nowhere to look: gis_feature, zoning_designation,
 * parcel_owner and spatial_analysis_result are all empty. zoning_designation
 * and parcel_owner hang off spatial_planning.property, which is itself empty
 * and has no geometry column of its own — so this creates four property
 * rows first (attribute-only; nothing to place on the map) and then the
 * zoning/ownership rows that reference them.
 *
 * gis_feature and spatial_analysis_result DO carry geometry (both SRID 4326,
 * same as public.vungu_parcels — no transform needed), so their geometry is
 * copied straight out of the existing 733-row cadastre rather than invented,
 * so every digitized feature lands where the basemap already has data.
 *
 * Idempotent via seedkit's `ensure`; a re-run adds nothing.
 *
 *     node scripts/seed-gis-officer-demo.js
 *     node scripts/seed-gis-officer-demo.js --undo
 */

try { require('dotenv').config({ quiet: true }) } catch (_) { /* optional */ }
const { Pool } = require('pg')
const { forget, ensure } = require('./lib/seedkit')

const DATABASE_URL = process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/Vungu_spatial334'

const TAG = 'VUNGU-GIS-DEMO'

const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)

async function userId (db, email) {
  const { rows } = await db.query('SELECT id FROM public.users WHERE email = $1', [email])
  if (!rows.length) throw new Error(`No user ${email}. Run: node scripts/seed-demo-users.js`)
  return rows[0].id
}

/** EWKT of an existing vungu_parcels geometry, by fid — same SRID (4326) as the target columns. */
async function parcelEwkt (db, fid) {
  const { rows } = await db.query('SELECT ST_AsEWKT(geom) AS wkt FROM public.vungu_parcels WHERE fid = $1', [fid])
  if (!rows.length) throw new Error(`No public.vungu_parcels row with fid ${fid}`)
  return rows[0].wkt
}

async function seed (db) {
  const gis = await userId(db, 'demo.gis@vungu.test')

  const permits = await db.query(
    'SELECT id FROM spatial_planning.permit_application ORDER BY created_at LIMIT 2')
  if (permits.rows.length < 2) throw new Error('Expected at least 2 spatial_planning.permit_application rows')
  const [permitA, permitB] = permits.rows.map(r => r.id)

  // ── 1. Six digitized GIS features, geometry copied from vungu_parcels ──
  const features = [
    [1, 'site_boundary', { demo_ref: 'GIS-DEMO-001', label: 'South Beldans site boundary' }],
    [3, 'site_boundary', { demo_ref: 'GIS-DEMO-002', label: 'Shangani Farm North site boundary' }],
    [4, 'floodline_reference', { demo_ref: 'GIS-DEMO-003', label: 'Lower Gweru communal land — floodline reference area' }],
    [5, 'digitized', { demo_ref: 'GIS-DEMO-004', label: 'Ruby Block — digitized annotation' }],
    [6, 'digitized', { demo_ref: 'GIS-DEMO-005', label: 'The Torva Block — digitized annotation' }],
    [7, 'point_of_interest', { demo_ref: 'GIS-DEMO-006', label: 'Buda State Land — point of interest', centroid: true }],
  ]
  for (const [fid, layer, props] of features) {
    const wkt = props.centroid
      ? (await db.query('SELECT ST_AsEWKT(ST_Centroid(geom)) AS wkt FROM public.vungu_parcels WHERE fid = $1', [fid])).rows[0].wkt
      : await parcelEwkt(db, fid)
    const { centroid, ...cleanProps } = props
    await ensure(db, TAG, 'spatial_planning.gis_feature', {
      layer,
      props: JSON.stringify(cleanProps),
      geom: wkt,
      created_by: String(gis),
    }, "props->>'demo_ref' = $1", [cleanProps.demo_ref])
  }

  // ── 2. Four properties (attribute-only; property has no geom column) ────
  const properties = [
    ['2201', 'Vungu Growth Point', 'Stand 2201, Vungu Growth Point', 850],
    ['2202', 'Vungu Growth Point', 'Stand 2202, Vungu Growth Point', 1200],
    ['14', 'Somabula', 'Stand 14, Somabula', 2000],
    ['30', 'Far Estate', 'Stand 30, Far Estate', 650],
  ]
  const propertyIds = []
  for (const [standNumber, suburbWard, streetAddress, areaSqm] of properties) {
    propertyIds.push(await ensure(db, TAG, 'spatial_planning.property', {
      stand_number: standNumber,
      suburb_ward: suburbWard,
      street_address: streetAddress,
      area_sqm: areaSqm,
      created_by: gis,
    }, 'stand_number = $1', [standNumber]))
  }

  // ── 3. Four zoning designations, one per property ────────────────────────
  const zoning = [
    ['Residential (R1)', 'ZD/2026/0001', 400, 'Low-density residential.'],
    ['Residential (R2)', 'ZD/2026/0002', 400, 'Medium-density residential.'],
    ['Commercial (C2)', 'ZD/2026/0003', 300, 'General commercial.'],
    ['Institutional', 'ZD/2026/0004', 250, 'Council and community-facility use.'],
  ]
  for (let i = 0; i < propertyIds.length; i++) {
    const [designation, reference, ageDays, notes] = zoning[i]
    await ensure(db, TAG, 'spatial_planning.zoning_designation', {
      property_id: propertyIds[i],
      designation,
      effective_date: daysAgo(ageDays),
      reference,
      notes,
    }, 'property_id = $1 AND designation = $2', [propertyIds[i], designation])
  }

  // ── 4. Eight parcel owners, two per property ─────────────────────────────
  const owners = [
    [propertyIds[0], 'T. Moyo', 'owner', '+263 77 200 1101'],
    [propertyIds[0], 'S. Ncube', 'occupier', '+263 77 200 1102'],
    [propertyIds[1], 'R. Sibanda', 'owner', '+263 77 200 1103'],
    [propertyIds[1], 'Midlands Property Agents', 'agent', '+263 54 220 0110'],
    [propertyIds[2], 'Somabula Traders Pvt Ltd', 'owner', '+263 78 990 1145'],
    [propertyIds[2], 'D. Zhou', 'occupier', '+263 77 118 2231'],
    [propertyIds[3], 'Vungu Rural District Council', 'owner', '+263 54 226515'],
    [propertyIds[3], 'N. Chirwa', 'occupier', '+263 77 118 2232'],
  ]
  for (const [propertyId, name, role, phone] of owners) {
    await ensure(db, TAG, 'spatial_planning.parcel_owner', {
      property_id: propertyId,
      name,
      role,
      phone,
      since: daysAgo(400),
    }, 'property_id = $1 AND name = $2', [propertyId, name])
  }

  // ── 5. Two spatial analysis results, against real permit applications ───
  await ensure(db, TAG, 'spatial_planning.spatial_analysis_result', {
    permit_app_id: permitA,
    requested_by: gis,
    analysis_type: 'overlay',
    input_geom: await parcelEwkt(db, 1),
    result: JSON.stringify({
      summary: 'Site overlays the South Beldans parcel. No conflicting zoning designation found.',
      overlap_pct: 100,
      checked_layers: ['zoning_designation', 'gis_feature'],
    }),
  }, 'permit_app_id = $1 AND analysis_type = $2', [permitA, 'overlay'])

  await ensure(db, TAG, 'spatial_planning.spatial_analysis_result', {
    permit_app_id: permitB,
    requested_by: gis,
    analysis_type: 'setback',
    input_geom: await parcelEwkt(db, 3),
    result: JSON.stringify({
      summary: 'Proposed structure is 6.2 m from the nearest boundary; minimum setback is 5 m. Compliant.',
      required_setback_m: 5,
      measured_setback_m: 6.2,
      verdict: 'compliant',
    }),
  }, 'permit_app_id = $1 AND analysis_type = $2', [permitB, 'setback'])
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
      console.log(`Seeded the GIS officer demo data (${rows[0].n} rows tracked).`)
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
