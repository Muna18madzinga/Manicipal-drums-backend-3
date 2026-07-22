const fs = require('node:fs')
const path = require('node:path')
const { MIGRATIONS } = require('./migrate-render')

describe('Render migration plan', () => {
  test('references SQL migration files that exist in order', () => {
    expect(MIGRATIONS).toEqual([
      '001_initial_schema.sql',
      '042_development_applications.sql',
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
      '075_fix_check_development_permission.sql',
      '108_planning_project_case_link.sql',
      '109_spatial_change_notify.sql',
      '110_local_authorities.sql',
      '111_spatial_layers_catalogue.sql',
    ])

    for (const filename of MIGRATIONS) {
      const migrationPath = path.join(__dirname, '..', 'migrations', filename)
      expect(fs.existsSync(migrationPath)).toBe(true)
    }
  })
})
