// src/services/gms/roles.js
// ─────────────────────────────────────────────────────────────────────────
// The GIS Management System permission matrix, as role lists the routes pass
// to requireRole(). One row per capability, copied from the build brief's
// matrix so a reviewer can compare the two side by side.
//
// gis_officer is the pre-GMS single GIS role. Until the IT admin re-grades
// those accounts it carries gis_head's rights, so nobody is locked out.
// ─────────────────────────────────────────────────────────────────────────

const HEAD = ['gis_head', 'gis_officer']

const GMS = {
  viewInternal:    [...HEAD, 'gis_data', 'gis_dev', 'gis_analyst', 'gis_tech', 'gis_clerk', 'dept_editor', 'dept_viewer'],
  editLayers:      [...HEAD, 'gis_data', 'gis_analyst', 'gis_tech', 'dept_editor'],
  approveQa:       [...HEAD, 'gis_data'],
  importSurvey:    [...HEAD, 'gis_data'],
  publish:         [...HEAD],
  manageUsers:     [...HEAD, 'gis_dev'],
  integration:     [...HEAD, 'gis_data', 'gis_dev'],
  integrationView: [...HEAD, 'gis_data', 'gis_dev', 'gis_analyst'],
  analysis:        [...HEAD, 'gis_data', 'gis_dev', 'gis_analyst', 'gis_tech', 'dept_editor'],
  issueMaps:       [...HEAD, 'gis_data', 'gis_analyst', 'gis_clerk'],
  // dept_editor is "if needed" in the matrix: granted per request later, not
  // by role.
  personalData:    [...HEAD, 'gis_data', 'gis_analyst', 'gis_clerk'],
  approveSharing:  [...HEAD],
}

// Parcel attributes the GIS Branch stewards for the Survey Section. Other
// departments' attributes (zoning, permits) arrive with their own layers.
const SURVEY_ATTR_EDITORS = [...HEAD, 'gis_data']

const GMS_ROLES = [...new Set(Object.values(GMS).flat())]

module.exports = { GMS, GMS_ROLES, SURVEY_ATTR_EDITORS }
