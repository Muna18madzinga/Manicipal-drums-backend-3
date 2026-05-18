const fs = require('node:fs')
const path = require('node:path')
const { Pool } = require('pg')

const MIGRATIONS = [
  '001_initial_schema.sql',
  '042_development_applications.sql',
  '050_enhance_land_use_management_corrected.sql',
  '060_invite_system_and_roles.sql',
  '061_applicant_type_and_invite_roles.sql',
  '062_stands_and_planning_templates.sql',
  '063_notifications_and_inspections.sql',
  '064_payments_and_documents.sql',
  '065_plan_review.sql',
  '070_development_management_handbook_v1_2.sql',
  '071_stage_inspection_photos_and_flags.sql',
  '072_per_item_inspection_scoring.sql',
  '073_score_includes_na_as_zero.sql',
]

function createPool(env = process.env) {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to run Render migrations.')
  }
  return new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  })
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `)
}

async function appliedMigrations(client) {
  const { rows } = await client.query('SELECT filename FROM schema_migrations')
  return new Set(rows.map(row => row.filename))
}

async function applyMigration(client, filename) {
  const migrationPath = path.join(__dirname, '..', 'migrations', filename)
  const sql = fs.readFileSync(migrationPath, 'utf8')
  console.log(`[render-migrate] applying ${filename}`)
  await client.query(sql)
  await client.query(
    `INSERT INTO schema_migrations (filename, applied_at)
     VALUES ($1, NOW())
     ON CONFLICT (filename) DO NOTHING`,
    [filename],
  )
}

async function runRenderMigrations(env = process.env) {
  const pool = createPool(env)
  const client = await pool.connect()
  try {
    await ensureMigrationTable(client)
    const applied = await appliedMigrations(client)
    for (const filename of MIGRATIONS) {
      if (applied.has(filename)) {
        console.log(`[render-migrate] skipping ${filename}`)
        continue
      }
      await applyMigration(client, filename)
    }
    console.log('[render-migrate] complete')
  } finally {
    client.release()
    await pool.end()
  }
}

if (require.main === module) {
  runRenderMigrations().catch((error) => {
    console.error('[render-migrate] failed:', error)
    process.exit(1)
  })
}

module.exports = {
  MIGRATIONS,
  createPool,
  runRenderMigrations,
}
