/**
 * seed-inspector-demo.js
 *
 * Seeds the LOCAL database with real rows the Vungu Inspector mobile app can
 * pull: one `building_inspector` user (known credentials) and a few approved
 * `spatial_planning.permit_application` stands with map coordinates. These are
 * real backend records — not in-app synthetic data — so the inspector's queue
 * shows actual stands and the app's writes (stage inspections, geo-stamped
 * photos) land in the same database the web portal reads.
 *
 * Run from the backend root:
 *     node scripts/seed-inspector-demo.js
 *
 * Then sign in to the mobile app with:
 *     email:    inspector@vungurdc.gov.zw
 *     password: Inspector#2026
 */

try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const { Pool } = require('pg');

// bcrypt (native) or bcryptjs — whichever the backend has installed.
let bcrypt;
try { bcrypt = require('bcrypt'); } catch (_) { bcrypt = require('bcryptjs'); }

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/vungu_master_db_v1';

const INSPECTOR = {
  email: 'inspector@vungurdc.gov.zw',
  password: 'Inspector#2026',
  fullName: 'Field Inspector',
};

// Three stands around Gweru (Vungu RDC, Midlands). development_type values are
// from the permit_application CHECK constraint (migration 070).
const STANDS = [
  {
    tpd: 'TPD/VUN/2026/0001', stand: '4521', ward: 'Mkoba 6, Ward 12',
    name: 'Tendai Moyo', phone: '+263 77 412 8890', type: 'new_building',
    desc: 'Three-bedroomed house on a 300 m² stand.', lng: 29.7894, lat: -19.4612,
  },
  {
    tpd: 'TPD/VUN/2026/0002', stand: '1187', ward: 'Senga, Ward 8',
    name: 'Rudo Sibanda', phone: '+263 71 990 2245', type: 'extension',
    desc: 'Rear extension and garage.', lng: 29.8331, lat: -19.4709,
  },
  {
    tpd: 'TPD/VUN/2026/0003', stand: '8830', ward: 'Nashville, Ward 3',
    name: 'Blessing Ncube', phone: '+263 78 330 1170', type: 'new_building',
    desc: 'Ground-floor retail with a flat above.', lng: 29.8201, lat: -19.4385,
  },
];

async function ensureInspector(client, hash) {
  // Only insert columns that actually exist on this deployment's users table.
  const { rows: colRows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'`,
  );
  const cols = new Set(colRows.map((r) => r.column_name));

  const existing = await client.query('SELECT id FROM public.users WHERE email = $1', [INSPECTOR.email]);
  if (existing.rows[0]) {
    await client.query(
      `UPDATE public.users
          SET role = 'building_inspector', password_hash = $2,
              ${cols.has('active') ? 'active = TRUE,' : ''}
              ${cols.has('status') ? "status = 'active'," : ''}
              updated_at = NOW()
        WHERE email = $1`,
      [INSPECTOR.email, hash],
    );
    return existing.rows[0].id;
  }

  const candidate = {
    email: INSPECTOR.email,
    name: INSPECTOR.fullName,
    full_name: INSPECTOR.fullName,
    role: 'building_inspector',
    password_hash: hash,
    status: 'active',
    active: true,
    organization: 'Vungu RDC',
  };
  const keys = Object.keys(candidate).filter((k) => cols.has(k));
  const vals = keys.map((k) => candidate[k]);
  const placeholders = keys.map((_, i) => `$${i + 1}`);
  const { rows } = await client.query(
    `INSERT INTO public.users (${keys.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
    vals,
  );
  return rows[0].id;
}

async function ensureStand(client, s, createdBy) {
  const { rows } = await client.query(
    `INSERT INTO spatial_planning.permit_application
        (tpd_reference, stand_number, suburb_ward, applicant_name, applicant_phone,
         development_type, description, status, location, created_by, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'approved',
             ST_SetSRID(ST_MakePoint($8,$9), 4326), $10, CURRENT_DATE)
     ON CONFLICT (tpd_reference) DO UPDATE
        SET status = 'approved',
            location = ST_SetSRID(ST_MakePoint($8,$9), 4326),
            stand_number = EXCLUDED.stand_number
     RETURNING id`,
    [s.tpd, s.stand, s.ward, s.name, s.phone, s.type, s.desc, s.lng, s.lat, createdBy],
  );
  return rows[0].id;
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    console.log('→ Connecting to', DATABASE_URL.replace(/:[^:@/]*@/, ':****@'));
    const hash = await bcrypt.hash(INSPECTOR.password, 10);

    const inspectorId = await ensureInspector(client, hash);
    console.log('✓ Inspector user ready:', INSPECTOR.email, '(id', inspectorId + ')');

    for (const s of STANDS) {
      const id = await ensureStand(client, s, inspectorId);
      console.log(`✓ Stand ${s.stand} (${s.tpd}) → permit_application ${id}`);
    }

    console.log('\nDone. Sign in to the mobile app with:');
    console.log('   email:    ' + INSPECTOR.email);
    console.log('   password: ' + INSPECTOR.password);
    console.log('\nThe queue will show the three approved stands above.');
  } catch (err) {
    console.error('\n✗ Seed failed:', err.message);
    console.error(err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
