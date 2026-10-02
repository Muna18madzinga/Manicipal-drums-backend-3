// scripts/seed-tsamba.js
// ─────────────────────────────────────────────────────────────────────────
// FICTIONAL SAMPLE DATA for the GIS Management System: "Tsamba Growth
// Point", a made-up township in a made-up part of the district. Every name,
// stand, account and plan reference below is invented. Codes are prefixed
// TSB / TSAMBA and sources say FICTIONAL SAMPLE so nobody mistakes them for
// council records.
//
//   node scripts/seed-tsamba.js           seed (refuses if already seeded)
//   node scripts/seed-tsamba.js --reset   remove the sample and seed again
//
// Phase 2 adds published features: 25 boreholes, 18 km of council roads,
// 4 schools, 2 clinics and 20 field-captured business premises.
//
// Phase 1 content: 3 wards, 12 villages, one approved layout of 60 stands
// (imported through the real survey importer, so 60 ParcelCreated events),
// 25 stands linked to ERP accounts (through the real inbound handler),
// 8 stands with structures and no account, 3 ERP accounts with no parcel,
// 2 duplicate stand numbers from a legacy plan, and 5 failed ERP events.
// Assets, social facilities, field captures and map requests come with the
// phases that build their registers (see TODO.md).
// ─────────────────────────────────────────────────────────────────────────

require('dotenv').config({ quiet: true })
const crypto = require('node:crypto')
const { Pool } = require('pg')
const { importGeneralPlan } = require('../src/services/gms/parcelImport')
const { handleInbound } = require('../src/services/gms/inbound')

const TOWNSHIP = 'TSAMBA-GP'
const LO29 = 922029
const CENTRE = { lon: 29.55, lat: -19.62 }
const FICTIONAL = 'FICTIONAL SAMPLE'

/**
 * Removes every row belonging to a township's sample or test data, including
 * its outbox events and reconciliation items. The only caller-visible use of
 * the gms.purge escape hatch in land.parcel_guard().
 */
async function purgeTownship(client, township, accountPrefix) {
  await client.query(`SET LOCAL gms.purge = 'on'`)
  const ids = (await client.query(
    'SELECT parcel_id FROM land.parcel WHERE township_code = $1', [township],
  )).rows.map((r) => r.parcel_id)
  await client.query(
    `DELETE FROM integration.outbox_event
      WHERE payload->>'parcel_id' = ANY($1) OR idempotency_key LIKE $2`,
    [ids, `${township}:%`])
  await client.query(
    `DELETE FROM integration.inbound_event
      WHERE payload->>'parcel_id' = ANY($1) OR idempotency_key LIKE $2`,
    [ids, `${township}:%`])
  await client.query(
    `DELETE FROM integration.reconciliation_item
      WHERE detail->>'township_code' = $1 OR detail->>'parcel_id' = ANY($2)
         OR ($3::text IS NOT NULL AND detail->>'erp_account_no' LIKE $3)`,
    [township, ids, accountPrefix ? `${accountPrefix}%` : null])
  await client.query('DELETE FROM land.building WHERE parcel_id = ANY($1)', [ids])
  await client.query('DELETE FROM revenue_link.account_link WHERE parcel_id = ANY($1)', [ids])
  if (accountPrefix) {
    await client.query('DELETE FROM revenue_link.billing_status WHERE erp_account_no LIKE $1', [`${accountPrefix}%`])
  }
  await client.query('DELETE FROM land.parcel_lineage WHERE parent_id = ANY($1) OR child_id = ANY($1)', [ids])
  await client.query('DELETE FROM land.parcel WHERE parcel_id = ANY($1)', [ids])
  await client.query('DELETE FROM land.general_plan WHERE township_code = $1', [township])
}

/** 6 rows x 10 stands, 20 m x 30 m, sharing edges, in Lo29 (POINT(Y X)). */
function layoutFeatures(originY, originX, firstStand = 101) {
  const features = []
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 10; col++) {
      const y = originY - col * 20 // Y is positive west: east is smaller
      const x = originX + row * 30 // X is positive south
      features.push({
        type: 'Feature',
        properties: { stand_no: String(firstStand + row * 10 + col) },
        geometry: {
          type: 'Polygon',
          coordinates: [[[y, x], [y - 20, x], [y - 20, x + 30], [y, x + 30], [y, x]]],
        },
      })
    }
  }
  return features
}

async function loOrigin(pool, lon, lat) {
  const { rows: [r] } = await pool.query(
    `SELECT round(ST_X(g)::numeric, 2) AS y, round(ST_Y(g)::numeric, 2) AS x
       FROM ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), 4326), $3::int) AS g`,
    [lon, lat, LO29])
  return { y: Number(r.y), x: Number(r.x) }
}

const ev = (type, key, payload) => ({
  event_id: crypto.randomUUID(),
  type,
  version: 1,
  occurred_at: new Date().toISOString(),
  source: 'erp-sample',
  idempotency_key: key,
  payload,
})

async function seed(pool) {
  // Wards: three strips of a box around the centre.
  const wards = [
    ['TSB-W01', 'Tsamba Ward 1 (fictional)', 29.50, 29.545],
    ['TSB-W02', 'Tsamba Ward 2 (fictional)', 29.545, 29.60],
    ['TSB-W03', 'Tsamba Ward 3 (fictional)', 29.60, 29.65],
  ]
  for (const [code, name, w, e] of wards) {
    await pool.query(
      `INSERT INTO admin.ward (ward_code, name, source, geom)
       VALUES ($1, $2, $3, ST_Multi(ST_MakeEnvelope($4, -19.68, $5, -19.56, 4326)))
       ON CONFLICT (ward_code) DO NOTHING`,
      [code, name, FICTIONAL, w, e])
  }
  const villageNames = ['Mhondoro', 'Chizvo', 'Rukanda', 'Dzimbe', 'Nyamuzi', 'Gotora',
    'Chiwara', 'Mapfuti', 'Zvinavo', 'Rufaro', 'Tsvimbo', 'Mukumbi']
  for (let i = 0; i < 12; i++) {
    const ward = wards[Math.floor(i / 4)]
    const lon = ward[2] + 0.008 + (i % 4) * 0.009
    const lat = -19.58 - (i % 2) * 0.05
    await pool.query(
      `INSERT INTO admin.village (village_id, name, headman, ward_code, geom)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326))
       ON CONFLICT (village_id) DO NOTHING`,
      [`TSB-V${String(i + 1).padStart(2, '0')}`, `${villageNames[i]} (fictional)`,
        `Headman ${villageNames[i]} (fictional)`, ward[0], lon, lat])
  }

  // The approved layout, through the same importer gis_data uses.
  const o = await loOrigin(pool, CENTRE.lon, CENTRE.lat)
  const imp = await importGeneralPlan(pool, {
    sg_ref: 'FICTIONAL GP 1/2026',
    township_code: TOWNSHIP,
    source_srid: LO29,
    features: layoutFeatures(o.y, o.x),
    commit: true,
  }, null)
  if (!imp.committed) throw new Error(`layout import failed: ${JSON.stringify(imp.report || imp.errors)}`)
  const byStand = new Map((await pool.query(
    'SELECT stand_no, parcel_id FROM land.parcel WHERE township_code = $1 AND status = $2',
    [TOWNSHIP, 'current'])).rows.map((r) => [r.stand_no, r.parcel_id]))

  // 25 allocated and billed stands (101-125), linked the way the ERP would.
  const account = (stand) => `TSB-ACC-${String(stand).padStart(4, '0')}`
  for (let s = 101; s <= 125; s++) {
    await handleInbound(pool, ev('AccountLinked', `${TOWNSHIP}:AccountLinked:${s}`, {
      parcel_id: byStand.get(String(s)), erp_account_no: account(s), allocation_date: '2026-03-01',
    }))
  }
  // Nightly band feed: 101-118 current, 119-125 in arrears, and three
  // accounts the ERP holds that match no parcel.
  const accounts = []
  for (let s = 101; s <= 125; s++) accounts.push({ erp_account_no: account(s), status_band: s <= 118 ? 'current' : 'in_arrears', as_at: new Date().toISOString() })
  for (const n of [9001, 9002, 9003]) accounts.push({ erp_account_no: account(n), status_band: 'current', as_at: new Date().toISOString() })
  await handleInbound(pool, ev('BillingStatusUpdated', `${TOWNSHIP}:BillingStatusUpdated:seed`, { accounts }))

  // Structures: on ten billed stands, and on eight (131-138) with no account.
  const built = [...Array.from({ length: 10 }, (_, i) => 101 + i), ...Array.from({ length: 8 }, (_, i) => 131 + i)]
  for (const s of built) {
    await pool.query(
      `INSERT INTO land.building (parcel_id, use, storeys, completion_date, source, accuracy_class, geom)
       SELECT parcel_id, 'residential', 1, DATE '2025-11-01', $2, 'C', ST_PointOnSurface(geom_wgs84)
         FROM land.parcel WHERE parcel_id = $1`,
      [byStand.get(String(s)), `field survey (${FICTIONAL})`])
  }

  // Two legacy parcels digitised from an old scanned plan, reusing stand
  // numbers 115 and 120: the duplicates reconciliation must catch.
  for (const s of ['115', '120']) {
    await pool.query(
      `INSERT INTO land.parcel (stand_no, township_code, ward_code, geom_source, source_srid, geom_wgs84,
                                area_m2, accuracy_class, source, custodian_dept, status)
       SELECT stand_no, township_code, ward_code, g, 4326, g, area_m2, 'D',
              'digitised from a 1998 scanned plan (${FICTIONAL})', 'Survey Section', 'legacy'
         FROM land.parcel, ST_Translate(geom_wgs84, 0.00003, 0.00002) AS g
        WHERE parcel_id = $1`,
      [byStand.get(s)])
  }

  // Five BuildingCompleted events the ERP never accepted.
  for (let s = 101; s <= 105; s++) {
    await pool.query(
      `INSERT INTO integration.outbox_event (type, payload, idempotency_key, status, attempts, last_error, occurred_at)
       SELECT 'BuildingCompleted',
              jsonb_build_object('parcel_id', b.parcel_id, 'building_id', b.building_id,
                                 'use', b.use, 'completion_date', b.completion_date),
              $2, 'failed', 5, 'ERP timeout after 10000 ms (seeded failure)', now() - interval '2 days'
         FROM land.building b WHERE b.parcel_id = $1`,
      [byStand.get(String(s)), `${TOWNSHIP}:BuildingCompleted:${s}`])
  }

  await seedFeatures(pool)

  return { parcels: byStand.size, import_id: imp.import_id }
}

/** Published GMS features (migration 133), each with its version-1 history row. */
async function seedFeatures(pool) {
  const add = async (layer, attrs, geometry, cls, source) => {
    const { rows: [f] } = await pool.query(
      `INSERT INTO gis_ops.feature (layer_id, attrs, geom, accuracy_class, source, custodian_dept)
       SELECT $1::varchar, $2::jsonb, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), $4, $5, custodian_dept
         FROM gis_ops.layer WHERE layer_id = $1::varchar RETURNING feature_id`,
      [layer, JSON.stringify(attrs), JSON.stringify(geometry), cls, `${source} (${FICTIONAL})`])
    await pool.query(
      `INSERT INTO gis_ops.feature_version (feature_id, version, action, attrs, geom, accuracy_class, source)
       SELECT feature_id, 1, 'create', attrs, geom, accuracy_class, source FROM gis_ops.feature WHERE feature_id = $1`,
      [f.feature_id])
  }
  const pt = (lon, lat) => ({ type: 'Point', coordinates: [lon, lat] })
  const statuses = ['functional', 'functional', 'functional', 'needs repair', 'broken']
  for (let i = 0; i < 25; i++) {
    await add('boreholes', { name: `Tsamba BH ${String(i + 1).padStart(2, '0')}`, status: statuses[i % 5], depth_m: 40 + (i % 7) * 5 },
      pt(29.505 + (i % 5) * 0.03, -19.57 - Math.floor(i / 5) * 0.02), 'C', 'handheld GPS survey')
  }
  // Six east-west feeder roads of 3 km each: 18 km.
  const kmLon = 1 / (111.32 * Math.cos((19.6 * Math.PI) / 180))
  for (let k = 0; k < 6; k++) {
    const lat = -19.575 - k * 0.01
    await add('council_roads', { name: `Tsamba Road ${k + 1}`, surface: k < 2 ? 'tar' : 'gravel', road_class: k < 2 ? 'district' : 'feeder' },
      { type: 'LineString', coordinates: [[29.51, lat], [29.51 + 1.5 * kmLon, lat], [29.51 + 3 * kmLon, lat]] }, 'D', 'digitised from imagery')
  }
  const schools = [['Tsamba Primary', 'primary'], ['Chizvo Primary', 'primary'], ['Tsamba Secondary', 'secondary'], ['Rufaro ECD Centre', 'ECD']]
  for (const [i, [name, level]] of schools.entries()) {
    await add('schools', { name: `${name} (fictional)`, level, enrolment: 300 + i * 120 }, pt(29.52 + i * 0.03, -19.63), 'B', 'GNSS survey')
  }
  await add('clinics', { name: 'Tsamba Clinic (fictional)', type: 'clinic' }, pt(29.556, -19.625), 'B', 'GNSS survey')
  await add('clinics', { name: 'Mapfuti Rural Health Centre (fictional)', type: 'rural health centre' }, pt(29.63, -19.60), 'B', 'GNSS survey')
  const cats = ['retail', 'bottle store', 'hair salon', 'grinding mill', 'workshop', 'eatery', 'other']
  for (let i = 0; i < 20; i++) {
    await add('business_premises', {
      trading_name: `Sample Trader ${i + 1}`, category: cats[i % cats.length],
      owner_name: `Sample Owner ${i + 1} (fictional)`, owner_phone: `+263 77 000 ${String(1000 + i)}`,
    }, pt(29.5505 + (i % 5) * 0.0012, -19.6215 - Math.floor(i / 5) * 0.0009), 'B', 'field capture')
  }
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const exists = (await pool.query('SELECT 1 FROM land.parcel WHERE township_code = $1 LIMIT 1', [TOWNSHIP])).rowCount
    if (exists && !process.argv.includes('--reset')) {
      console.log(`[tsamba] already seeded; run with --reset to replace it`)
      return
    }
    if (exists) {
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        await purgeTownship(c, TOWNSHIP, 'TSB-')
        await c.query(`DELETE FROM gis_ops.feature_version WHERE feature_id IN
                         (SELECT feature_id FROM gis_ops.feature WHERE source LIKE '%${FICTIONAL}%')`)
        await c.query(`DELETE FROM gis_ops.feature WHERE source LIKE '%${FICTIONAL}%'`)
        await c.query(`DELETE FROM admin.village WHERE village_id LIKE 'TSB-%'`)
        await c.query(`DELETE FROM admin.ward WHERE ward_code LIKE 'TSB-%'`)
        await c.query('COMMIT')
      } catch (e) {
        await c.query('ROLLBACK'); throw e
      } finally { c.release() }
      console.log('[tsamba] previous sample removed')
    }
    const r = await seed(pool)
    console.log(`[tsamba] seeded ${r.parcels} current parcels (import ${r.import_id}) — ${FICTIONAL} data`)
  } finally {
    await pool.end()
  }
}

if (require.main === module) {
  main().catch((err) => { console.error('[tsamba] failed:', err); process.exit(1) })
}

module.exports = { purgeTownship, layoutFeatures, loOrigin, TOWNSHIP, LO29 }
