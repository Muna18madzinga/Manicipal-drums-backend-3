/**
 * seed-planner-demo.js
 *
 * Seeds the three planner surfaces that are currently empty, so the Town
 * Planning Officer workspace shows real rows during a local-authority demo
 * instead of empty states:
 *
 *   public.stands                          -> map StandsLayer + Register/Edit Stand
 *   spatial_planning.committee_meeting     -> Committee schedule (Step 3)
 *   spatial_planning.prohibition_order     -> Enforcement section
 *
 * These are real backend records written to the same database the portal
 * reads, following the precedent of scripts/seed-inspector-demo.js.
 *
 * Idempotent: every insert is guarded on its natural key, so re-running adds
 * nothing. Safe to run more than once.
 *
 * Run from the backend root:
 *     node scripts/seed-planner-demo.js
 *
 * To remove everything this script created:
 *     node scripts/seed-planner-demo.js --undo
 */

try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const { Pool } = require('pg');

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/vungu_master_db_v1';

// Everything this script writes is tagged with this marker so --undo can find
// it again without guessing.
const TAG = 'VUNGU-PLANNER-DEMO';

const PLANNER_EMAIL = process.env.DEMO_PLANNER_EMAIL || 'demo.planner@vungu.test';

// Stands laid out as a row of rectangles just west of Gweru, inside Vungu RDC
// (Midlands). SRID 4326, lon/lat order. ~40 m x 30 m each => ~1200 m2.
const STANDS = [
  { n: '4521', ward: 'Ward 12', zone: 'residential',   scale: 'small_scale', status: 'available', price: 3200,  lng: 29.7894, lat: -19.4612 },
  { n: '4522', ward: 'Ward 12', zone: 'residential',   scale: 'small_scale', status: 'available', price: 3200,  lng: 29.7899, lat: -19.4612 },
  { n: '4523', ward: 'Ward 12', zone: 'residential',   scale: 'small_scale', status: 'reserved',  price: 3400,  lng: 29.7904, lat: -19.4612 },
  { n: '4524', ward: 'Ward 12', zone: 'residential',   scale: 'small_scale', status: 'allocated', price: 3400,  lng: 29.7909, lat: -19.4612 },
  { n: '5010', ward: 'Ward 9',  zone: 'commercial',    scale: 'large_scale', status: 'available', price: 9800,  lng: 29.7894, lat: -19.4625 },
  { n: '5011', ward: 'Ward 9',  zone: 'commercial',    scale: 'large_scale', status: 'reserved',  price: 9800,  lng: 29.7901, lat: -19.4625 },
  { n: '6300', ward: 'Ward 15', zone: 'industrial',    scale: 'large_scale', status: 'available', price: 15000, lng: 29.7880, lat: -19.4640 },
  { n: '7100', ward: 'Ward 3',  zone: 'institutional', scale: 'mixed_scale', status: 'allocated', price: null,  lng: 29.7930, lat: -19.4590 },
];

const MEETINGS = [
  { ref: 'Ordinary Town Planning Committee — August 2026', date: '2026-08-05', loc: 'Council Chamber, Vungu RDC', status: 'scheduled', quorum: 5,
    notes: 'Ordinary sitting. Section 26 applications tabled for determination.' },
  { ref: 'Special Town Planning Committee — Subdivisions', date: '2026-08-19', loc: 'Council Chamber, Vungu RDC', status: 'scheduled', quorum: 5,
    notes: 'Special sitting called for subdivision and consolidation applications.' },
  { ref: 'Ordinary Town Planning Committee — July 2026', date: '2026-07-08', loc: 'Council Chamber, Vungu RDC', status: 'held', quorum: 5,
    notes: 'Minutes confirmed. Four permits approved with conditions, one refused.' },
];

const PROHIBITIONS = [
  { ref: 'PO/VUN/2026/001', name: 'Chikomo Hardware (Pvt) Ltd', addr: 'Stand 5010, Ward 9, Vungu RDC', stand: '5010',
    activity: 'Operation of a hardware retail outlet and open storage yard without a development permit.',
    reason: 'Development commenced without a permit issued under section 26 of the RTCP Act [Ch. 29:12].',
    issued: '2026-06-18', served: '2026-06-20', status: 'served' },
  { ref: 'PO/VUN/2026/002', name: 'T. Ncube', addr: 'Stand 4523, Ward 12, Vungu RDC', stand: '4523',
    activity: 'Erection of a boundary wall exceeding 2,1 m within the building line.',
    reason: 'Works contravene the approved building line and permitted wall height for the residential zone.',
    issued: '2026-07-02', served: '2026-07-03', status: 'confirmed' },
];

async function plannerId(db) {
  const r = await db.query('SELECT id FROM users WHERE email = $1', [PLANNER_EMAIL]);
  if (!r.rows.length) {
    throw new Error(
      `No user ${PLANNER_EMAIL}. Run: node scripts/seed-demo-users.js first.`
    );
  }
  return r.rows[0].id;
}

// Axis-aligned rectangle ~40 m x 30 m around (lng, lat). At -19.46 deg lat,
// 1 deg lon ~ 105 km and 1 deg lat ~ 110.6 km.
function rectWkt(lng, lat) {
  const dx = 20 / 105000;
  const dy = 15 / 110600;
  const p = [
    [lng - dx, lat - dy], [lng + dx, lat - dy],
    [lng + dx, lat + dy], [lng - dx, lat + dy],
    [lng - dx, lat - dy],
  ];
  return `POLYGON((${p.map(([a, b]) => `${a.toFixed(8)} ${b.toFixed(8)}`).join(',')}))`;
}

async function seed(db) {
  const uid = await plannerId(db);
  let stands = 0, meetings = 0, orders = 0;

  for (const s of STANDS) {
    const r = await db.query(
      `INSERT INTO public.stands
         (stand_number, ward, zone_type, use_scale, area_sqm, frontage_m, depth_m,
          price_usd, status, description, geom, created_by)
       SELECT $1::varchar,$2::varchar,$3::varchar,$4::varchar,
              $5::numeric,$6::numeric,$7::numeric,$8::numeric,
              $9::varchar,$10::text,
              ST_GeomFromText($11::text,4326),
              $12::uuid
       WHERE NOT EXISTS (SELECT 1 FROM public.stands WHERE stand_number = $1::varchar)
       RETURNING id`,
      [s.n, s.ward, s.zone, s.scale, 1200, 40, 30, s.price, s.status,
       `${TAG} — demo stand for planner workspace testing.`, rectWkt(s.lng, s.lat), uid]
    );
    stands += r.rowCount;
  }

  for (const m of MEETINGS) {
    const r = await db.query(
      `INSERT INTO spatial_planning.committee_meeting
         (title, meeting_date, location, status, quorum, notes, created_by,
          created_at, updated_at)
       SELECT $1::varchar,$2::date,$3::varchar,$4::varchar,$5::int,$6::text,$7::uuid,
              now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM spatial_planning.committee_meeting WHERE title = $1::varchar)
       RETURNING id`,
      [m.ref, m.date, m.loc, m.status, m.quorum, `${m.notes} [${TAG}]`, uid]
    );
    meetings += r.rowCount;
  }

  for (const p of PROHIBITIONS) {
    const r = await db.query(
      `INSERT INTO spatial_planning.prohibition_order
         (order_reference, subject_name, subject_address, stand_number,
          prohibited_activity, reason, issued_at, served_at, status, issued_by,
          created_at, updated_at)
       SELECT $1::varchar,$2::varchar,$3::text,$4::varchar,$5::text,$6::text,
              $7::date,$8::date,$9::varchar,$10::uuid, now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM spatial_planning.prohibition_order WHERE order_reference = $1::varchar)
       RETURNING id`,
      [p.ref, p.name, p.addr, p.stand, p.activity, `${p.reason} [${TAG}]`,
       p.issued, p.served, p.status, uid]
    );
    orders += r.rowCount;
  }

  return { stands, meetings, orders };
}

/**
 * Fill in missing statutory references. Every permit_application currently has
 * tpd_reference IS NULL, so the register and dashboard fall back to showing a
 * raw UUID fragment, which reads as broken. This only populates NULLs — it
 * never overwrites an existing reference — and numbers them by receipt order
 * so the register reads like a real council register.
 */
async function fillRefs(db) {
  const { rows } = await db.query(`
    WITH numbered AS (
      SELECT id,
             'TPD/VUN/' ||
             to_char(COALESCE(received_at, created_at::date), 'YYYY') || '/' ||
             lpad((row_number() OVER (
               PARTITION BY to_char(COALESCE(received_at, created_at::date), 'YYYY')
               ORDER BY COALESCE(received_at, created_at::date), id
             ))::text, 4, '0') AS ref
      FROM spatial_planning.permit_application
      WHERE tpd_reference IS NULL
    )
    UPDATE spatial_planning.permit_application p
       SET tpd_reference = n.ref, updated_at = now()
      FROM numbered n
     WHERE p.id = n.id
    RETURNING p.tpd_reference`);
  return rows.length;
}

async function undo(db) {
  const a = await db.query(
    `DELETE FROM public.stands WHERE description LIKE '%' || $1 || '%'`, [TAG]);
  const b = await db.query(
    `DELETE FROM spatial_planning.committee_meeting WHERE notes LIKE '%' || $1 || '%'`, [TAG]);
  const c = await db.query(
    `DELETE FROM spatial_planning.prohibition_order WHERE reason LIKE '%' || $1 || '%'`, [TAG]);
  return { stands: a.rowCount, meetings: b.rowCount, orders: c.rowCount };
}

(async () => {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  });
  const db = await pool.connect();
  const undoing = process.argv.includes('--undo');
  try {
    await db.query('BEGIN');
    const n = undoing ? await undo(db) : await seed(db);
    const refs = undoing ? 0 : await fillRefs(db);
    await db.query('COMMIT');
    console.log(
      `${undoing ? 'Removed' : 'Seeded'}: ${n.stands} stands, ` +
      `${n.meetings} committee meetings, ${n.orders} prohibition orders.`
    );
    if (!undoing) console.log(`Assigned TPD references to ${refs} permit(s) that had none.`);
  } catch (e) {
    await db.query('ROLLBACK');
    console.error('FAILED (rolled back):', e.message);
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
})();
