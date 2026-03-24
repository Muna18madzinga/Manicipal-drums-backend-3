/**
 * Run migration 060: invite system & role expansion
 * Usage: node scripts/run-migration-060.js
 */
const { Pool } = require('pg')
const fs = require('fs')
const path = require('path')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:cairo2025@localhost:5432/vungu_master_db_v1'
})

async function run() {
  const sqlPath = path.join(__dirname, '..', 'migrations', '060_invite_system_and_roles.sql')
  const sql = fs.readFileSync(sqlPath, 'utf8')

  console.log('Running migration 060: invite system & role expansion...')
  try {
    await pool.query(sql)
    console.log('✅ Migration 060 completed successfully')
  } catch (err) {
    console.error('❌ Migration failed:', err.message)
    console.error('Detail:', err.detail || '')
    process.exit(1)
  } finally {
    await pool.end()
  }
}

run()
