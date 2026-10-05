require("dotenv").config()
const fs = require('node:fs')
const path = require('node:path')
const { Pool } = require('pg')

const MIGRATIONS = [
  // Empty-but-shaped placeholders for legacy spatial tables that are only
  // populated from external sources (ogr2ogr imports / supervisor dump).
  // Fresh deployments need the shape so indexes, FKs and views parse.
  '000_legacy_spatial_stubs.sql',
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
  // 3NF normalisation pass (reference tables, stands/zone cache + v_stands
  // view, status CHECK, user_profiles). Only fix: v_stands joins the canonical
  // proposed_peri_urban_zones (112 repoint), not the obsolete vungu_* copy.
  '078_3nf_normalization.sql',
  '078_missing_gist_indexes.sql',
  // Clip OSM buildings/water-wise layers to the council buffer — spatial
  // filter the vector-tile registry depends on (previously local-only).
  '079_filter_buildings_to_council_buffer.sql',
  '080_survey_tasks.sql',
  // Exposes `stands` as a vector-tile-compatible view (integer fid over
  // stands.id UUID); the tile registry serves table `stands_tile_view`.
  '080_stands_tile_view.sql',
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
  '105_stand_allocation.sql',
  '106_geometry_validation.sql',
  '107_stands_topology.sql',
  // 075_fix arrived after 107 shipped; it only CREATE OR REPLACEs a function,
  // so running it out of numeric order is safe (the allowlist IS the order).
  '075_fix_check_development_permission.sql',
  '108_planning_project_case_link.sql',
  '109_spatial_change_notify.sql',
  '110_local_authorities.sql',
  '111_spatial_layers_catalogue.sql',
  // Canonical peri-urban zoning source of truth: the vector-tile registry
  // serves table `zones_master` (spatialLayers.js) which only these two
  // migrations create — previously applied ad-hoc on local, never deployed.
  '112_zones_master_view.sql',
  '113_zones_master_columns.sql',
  '114_gis_style_registry.sql',
  '115_residency_verification.sql',
  '116_inspector_work_queue.sql',
  '117_stage_inspection_field_events.sql',
  '118_inspector_site_geometry.sql',
  '119_permit_document_uploads.sql',
  '120_building_complaints.sql',
  '121_environmental_health_registers.sql',
  '122_environmental_health_operations.sql',
  '123_council_ops_asset_registers.sql',
  '124_planning_clerk_registers.sql',
  '125_service_desk_tickets.sql',
  '126_stands_zone_id_integer.sql',
  // The IT admin console. Depends on public.users only.
  '127_admin_console.sql',
  // The Planning Clerk's nine statutory registers (spatial_planning.clerk_*).
  // Its only dependencies are spatial_planning.permit_application and
  // spatial_planning.set_updated_at(), both from 070, and public.users from
  // 001 — all of them earlier in this list.
  //
  // Not to be confused with 124_planning_clerk_registers.sql, which creates a
  // separate seven-table planning_clerk schema. 128 is the one the Planning
  // Clerk console talks to.
  '128_planning_clerk_registers.sql',
  // Self-service password reset. Depends on public.users (001) and
  // public.user_session (097) only by FK on users; the session revoke in the
  // route is a plain UPDATE that is a no-op where that table is absent.
  '129_password_reset.sql',
  // Revocable QGIS/API tokens: /auth/generate-api-token records each jti and
  // the sync routes refuse any token without a live row. FK on users only.
  '130_api_token_registry.sql',
  // GIS Management System core register + ERP integration. Depends on
  // public.users (001) and public.admin_audit_event (127).
  '132_gis_core_register.sql',
  // GMS editing, QA queue and feature history. Depends on 132 (gis_ops).
  '133_gms_editing.sql',
  // Single-source the peri-urban zones table. Retargets the land-use-control
  // FK off the superseded copy the 2026-10-02 recovery restored, drops that
  // copy, and starts maintaining updated_at on a QGIS-authored table.
  '134_zones_single_source.sql',
  // area_ha as a STORED generated column: zones.js referenced a column that only
  // existed on the superseded copy, so every route in the file returned 500.
  '135_zones_area_ha.sql',
  // A value source for proposed_peri_urban_zones.id, without which drawing a new
  // zone in QGIS Desktop fails the NOT NULL constraint on insert.
  '136_zones_id_sequence.sql',
]

function createPool(env = process.env) {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required to run migrations.')
  }
  return new Pool({
    connectionString: env.DATABASE_URL,
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
