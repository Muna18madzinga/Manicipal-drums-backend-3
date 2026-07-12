const fs = require('node:fs')
const path = require('node:path')
const { Pool } = require('pg')

const MIGRATIONS = [
  '001_initial_schema.sql',
  '042_development_applications.sql',
  // '050_enhance_land_use_management_corrected.sql' skipped: ALTER/INSERTs into
  // land_use_groups + land_zones tables that no migration creates. Re-enable
  // once a prerequisite migration that CREATEs those tables exists.
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
  '074_spatial_tile_indexes.sql',
  '075_v_application_summary_add_created_by.sql',
  '075_notifications_and_kyc.sql',
  '076_available_stands.sql',
  '076_production_hardening.sql',
  '077_permit_application_pending_payment.sql',
  '078_missing_gist_indexes.sql',
  '080_survey_tasks.sql',
  '081_v_application_summary_add_lnglat.sql',
  // 082–084 were applied to local/dev via psql but were never added to this
  // Render allowlist. They are idempotent and tracked in schema_migrations, so
  // listing them here is safe and ensures a fresh deploy has the planner case
  // columns (082) before 085 (which depends on them) runs.
  '082_planner_case_and_audit.sql',
  '083_committee_meetings.sql',
  '084_property_register.sql',
  '085_planner_case_backend.sql',
  '086_eo_decision_returns.sql',
  '087_generated_document_content.sql',
  '088_map_evidence_doc_type.sql',
  '089_public_notice.sql',
  '090_consultation_blocking_escalation.sql',
  '091_gis_editable_features.sql',
  '092_gis_feature_history.sql',
  '093_user_applicant_profile.sql',
  '094_site_content.sql',
  '095_planning_projects.sql',
  '096_planning_revisions.sql',
  '097_case_locking_mfa_sessions.sql',
  '098_control_points.sql',
  '099_survey_parcels.sql',
  '100_survey_task_zone_docs.sql',
  '101_statutory_plans.sql',
  '102_survey_task_manager.sql',
  '103_soft_delete.sql',
  '104_committee_quorum_attendance.sql',
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
