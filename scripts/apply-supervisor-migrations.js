const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres@localhost:5432/vungu_master_db_v1',
})

async function apply(client, filename) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', filename), 'utf8')
  try {
    await client.query(sql)
    await client.query(
      `INSERT INTO schema_migrations (filename, applied_at) VALUES ($1, NOW()) ON CONFLICT (filename) DO NOTHING`,
      [filename],
    )
    console.log('OK', filename)
  } catch (e) {
    try { await client.query('ROLLBACK') } catch { /* no open tx */ }
    console.log('FAIL', filename, e.message.split('\n')[0])
  }
}

async function main() {
  const client = await pool.connect()
  try {
    const tables = await client.query(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
         AND (tablename ILIKE '%peri%' OR tablename ILIKE '%zone%' OR tablename IN ('stands','wards','users'))
       ORDER BY 1`,
    )
    console.log('tables:', tables.rows.map((r) => r.tablename).join(', ') || '(none)')

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    const files = [
      '128_bootstrap_proposed_peri_urban.sql',
      // 079_filter_buildings deletes millions of OSM rows — skip on local laptop apply.
      // Still on migrate-render allowlist for production hosts that opt in.
      '080_stands_tile_view.sql',
      '112_zones_master_view.sql',
      '113_zones_master_columns.sql',
      '126_3nf_normalization.sql',
      '127_zone_id_int_contract.sql',
      '130_ref_lookup_schema.sql',
      '131_consolidate_and_shrink.sql',
      '132_data_dictionary_comments.sql',
    ]
    for (const f of files) {
      const already = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [f])
      if (already.rowCount) {
        console.log('skip', f)
        continue
      }
      await apply(client, f)
    }

    const refs = await client.query(
      `SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'ref') AS ref_tables,
              to_regclass('ref.stand_status') AS stand_status,
              to_regclass('public.v_stands') AS v_stands,
              to_regclass('public.zones_master') AS zones_master`,
    )
    console.log('artifacts', refs.rows[0])
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
