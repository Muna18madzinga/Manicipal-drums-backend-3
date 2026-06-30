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
      '076_available_stands.sql',
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
    ])

    for (const filename of MIGRATIONS) {
      const migrationPath = path.join(__dirname, '..', 'migrations', filename)
      expect(fs.existsSync(migrationPath)).toBe(true)
    }
  })
})
