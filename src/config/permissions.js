// src/config/permissions.js
// ─────────────────────────────────────────────────────────────────────────
// What each role may do, as one table.
//
// WHY THIS FILE EXISTS
// The IT Admin console used to draw its "Role Access Legend" from a list
// hand-written in AdminView.vue. That list was a description of the intent,
// maintained separately from the role arrays in the 40-odd route files that
// actually decide. Two copies of an access rule is one copy plus a lie, and
// the lie is the one the admin reads before granting somebody a role.
//
// This is the copy the console reads. It is still a description — Fastify
// enforces per route, and no registry can change that — but it is a SINGLE
// description, in the backend, next to the routes, and test-checked against
// the role constants the routes import. When a route's role list changes, the
// test fails here and the console stops being wrong.
//
// ROLE vs CAPABILITY
// A capability is a thing an officer does, in the council's words ("Determine
// applications"), not an endpoint. One capability usually covers several
// routes. The `routes` field names the prefixes it corresponds to so a
// reviewer can check the claim without grepping.
// ─────────────────────────────────────────────────────────────────────────

/** Every role the users table's CHECK constraint permits. */
const ALL_ROLES = [
  'admin', 'planner', 'eo', 'env_officer', 'building_inspector',
  'planning_clerk', 'surveyor', 'gis_officer', 'viewer',
  'registered', 'public',
]

/** Council employees. Mirrors STAFF_ROLES in src/routes/auth.js. */
const STAFF_ROLES = [
  'admin', 'planner', 'eo', 'env_officer', 'building_inspector',
  'planning_clerk', 'surveyor', 'gis_officer', 'viewer',
]

/** Roles the IT Admin may grant. The rest are issued by the system itself. */
const ASSIGNABLE_ROLES = STAFF_ROLES

const ROLE_LABELS = {
  admin:              { name: 'IT Administrator',            short: 'IT Admin',   summary: 'Staff accounts, security and system configuration. No planning record.' },
  planner:            { name: 'Town Planning Officer',       short: 'Planner',    summary: 'Development applications end to end, from lodgement to permit.' },
  eo:                 { name: 'Executive Officer',           short: 'EO',         summary: 'Planning oversight, committee, determination and public notice.' },
  env_officer:        { name: 'Environmental Health Officer', short: 'EHO',       summary: 'Public Health Act duties: premises, outbreaks, notices, certificates.' },
  building_inspector: { name: 'Building Inspector',          short: 'Inspector',  summary: 'Stage inspections, enforcement and occupation certificates.' },
  planning_clerk:     { name: 'Planning Clerk',              short: 'Clerk',      summary: 'Intake, fees, document registry and correspondence.' },
  surveyor:           { name: 'Surveyor',                    short: 'Surveyor',   summary: 'Survey tasks, control points, beacon and diagram work.' },
  gis_officer:        { name: 'GIS Officer',                 short: 'GIS',        summary: 'Spatial data, cartography and the published symbology.' },
  viewer:             { name: 'Viewer',                      short: 'Viewer',     summary: 'Read-only access to the registers. Changes nothing.' },
  registered:         { name: 'Registered citizen',          short: 'Citizen',    summary: 'Applies, pays and tracks their own case. Issued on self-registration.' },
  public:             { name: 'Public',                      short: 'Public',     summary: 'Anonymous visitor. The explorer and the public registers only.' },
}

/**
 * Capabilities, grouped the way the console presents them.
 *
 * `roles` is the list that may exercise the capability. It is deliberately
 * written out in full rather than derived, because several routes widen or
 * narrow their own list and a derived set would hide that.
 */
const CAPABILITIES = [
  // ── Planning record ───────────────────────────────────────────────
  { id: 'app.read',        group: 'Planning', label: 'Open development applications',
    roles: ['admin', 'planner', 'eo', 'planning_clerk', 'env_officer', 'building_inspector', 'gis_officer', 'surveyor', 'viewer'],
    routes: ['/api/development-applications'] },
  { id: 'app.lodge',       group: 'Planning', label: 'Lodge and register an application',
    roles: ['admin', 'planning_clerk', 'planner', 'registered'],
    routes: ['/api/development-applications'] },
  { id: 'app.determine',   group: 'Planning', label: 'Determine an application',
    roles: ['admin', 'planner', 'eo'],
    routes: ['/api/development-control', '/api/planner'] },
  { id: 'app.committee',   group: 'Planning', label: 'Run committee and record resolutions',
    roles: ['admin', 'eo', 'planner'],
    routes: ['/api/planner/committee'] },
  { id: 'app.notice',      group: 'Planning', label: 'Publish statutory public notices',
    roles: ['admin', 'eo', 'planner'],
    routes: ['/api/development-management'] },
  { id: 'app.appeal',      group: 'Planning', label: 'Record appeals',
    roles: ['admin', 'eo', 'planner', 'planning_clerk'],
    routes: ['/api/appeals'] },

  // ── Field ─────────────────────────────────────────────────────────
  { id: 'insp.stage',      group: 'Field', label: 'Carry out stage inspections',
    roles: ['admin', 'building_inspector'],
    routes: ['/api/inspector', '/api/inspections'] },
  { id: 'insp.enforce',    group: 'Field', label: 'Issue enforcement orders',
    roles: ['admin', 'building_inspector', 'planner', 'eo'],
    routes: ['/api/enforcement-orders'] },
  { id: 'eho.register',    group: 'Field', label: 'Keep the public-health registers',
    roles: ['admin', 'env_officer'],
    routes: ['/api/eho'] },
  { id: 'eho.notice',      group: 'Field', label: 'Serve Public Health Act notices',
    roles: ['admin', 'env_officer'],
    routes: ['/api/eho/notices'] },

  // ── Spatial ───────────────────────────────────────────────────────
  { id: 'gis.read',        group: 'Spatial', label: 'View the spatial data',
    roles: ALL_ROLES,
    routes: ['/api/tiles', '/api/spatial'] },
  { id: 'gis.edit',        group: 'Spatial', label: 'Edit spatial features',
    roles: ['admin', 'gis_officer', 'planner', 'surveyor'],
    routes: ['/api/gis'] },
  { id: 'gis.publish',     group: 'Spatial', label: 'Publish map symbology',
    roles: ['admin', 'gis_officer'],
    routes: ['/api/gis-styles'] },
  { id: 'survey.compute',  group: 'Spatial', label: 'Run survey computations',
    roles: ['admin', 'surveyor'],
    routes: ['/api/survey', '/api/control-points'] },

  // ── Money and documents ───────────────────────────────────────────
  { id: 'pay.record',      group: 'Revenue', label: 'Record payments and receipts',
    roles: ['admin', 'planning_clerk', 'eo'],
    routes: ['/api/payments'] },
  { id: 'doc.manage',      group: 'Revenue', label: 'Manage the document registry',
    roles: ['admin', 'planning_clerk', 'planner', 'eo'],
    routes: ['/api/documents'] },
  { id: 'kyc.decide',      group: 'Revenue', label: 'Decide identity and residency checks',
    roles: ['admin', 'planning_clerk', 'eo'],
    routes: ['/api/kyc', '/api/residency'] },

  // ── Administration ────────────────────────────────────────────────
  { id: 'admin.users',     group: 'Administration', label: 'Provision and suspend staff accounts',
    roles: ['admin'],
    routes: ['/api/admin/users', '/api/admin/invites'] },
  { id: 'admin.security',  group: 'Administration', label: 'Read the audit trail and revoke sessions',
    roles: ['admin'],
    routes: ['/api/admin/audit', '/api/admin/sessions'] },
  { id: 'admin.settings',  group: 'Administration', label: 'Change system settings',
    roles: ['admin'],
    routes: ['/api/admin/settings'] },
  { id: 'admin.content',   group: 'Administration', label: 'Edit the public website',
    roles: ['admin'],
    routes: ['/api/site-content'] },
  { id: 'admin.landuse',   group: 'Administration', label: 'Configure land-use zones and controls',
    roles: ['admin', 'planner'],
    routes: ['/api/land-use'] },
]

/**
 * The capability list as the console renders it: one row per capability, a
 * boolean per role. Computed here rather than in the browser so the shape the
 * UI draws is the shape the server vouches for.
 */
function matrix(roles = ASSIGNABLE_ROLES) {
  return CAPABILITIES.map((c) => ({
    id: c.id,
    group: c.group,
    label: c.label,
    routes: c.routes,
    granted: Object.fromEntries(roles.map((r) => [r, c.roles.includes(r)])),
  }))
}

/** Every capability one role holds — the answer to "what am I granting?". */
function capabilitiesFor(role) {
  return CAPABILITIES.filter((c) => c.roles.includes(role)).map((c) => c.id)
}

module.exports = {
  ALL_ROLES, STAFF_ROLES, ASSIGNABLE_ROLES, ROLE_LABELS,
  CAPABILITIES, matrix, capabilitiesFor,
}
