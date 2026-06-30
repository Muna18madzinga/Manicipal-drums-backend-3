// scripts/apply-local-migration.js
// ─────────────────────────────────────────────────────────────────────────
// Apply ONE migration file to the LOCAL Postgres only.
//
// Safety: refuses to run unless DATABASE_URL points at localhost / 127.0.0.1,
// so it can never touch the Render-hosted production database. Migrations are
// idempotent (CREATE … IF NOT EXISTS), so re-running is safe.
//
// Usage (from the backend directory):
//   node scripts/apply-local-migration.js 091_gis_editable_features.sql
// ─────────────────────────────────────────────────────────────────────────

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

async function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('Usage: node scripts/apply-local-migration.js <migration-file.sql>')
    process.exit(1)
  }

  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set (.env not loaded?).')
    process.exit(1)
  }

  const host = new URL(url).hostname
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    console.error(`Refusing to run: DATABASE_URL host is "${host}", not localhost.`)
    console.error('This helper only applies migrations to the LOCAL database.')
    process.exit(1)
  }

  const sqlPath = path.join(__dirname, '..', 'migrations', file)
  if (!fs.existsSync(sqlPath)) {
    console.error(`Migration file not found: ${sqlPath}`)
    process.exit(1)
  }
  const sql = fs.readFileSync(sqlPath, 'utf8')

  const client = new Client({ connectionString: url })
  await client.connect()
  console.log(`Applying ${file} to ${new URL(url).pathname.slice(1)} @ ${host} …`)
  await client.query(sql)

  // Light verification specific to 091; harmless for other migrations.
  const reg = await client.query("SELECT to_regclass('spatial_planning.gis_feature') AS tbl")
  if (reg.rows[0].tbl) {
    const cols = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'spatial_planning' AND table_name = 'gis_feature'
        ORDER BY ordinal_position`,
    )
    console.log('spatial_planning.gis_feature columns:')
    for (const c of cols.rows) console.log('  -', c.column_name, c.data_type)
  }

  await client.end()
  console.log('Done.')
}

main().catch((err) => {
  console.error('Migration failed:', err.message)
  process.exit(1)
})
