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
    ])

    for (const filename of MIGRATIONS) {
      const migrationPath = path.join(__dirname, '..', 'migrations', filename)
      expect(fs.existsSync(migrationPath)).toBe(true)
    }
  })
})
