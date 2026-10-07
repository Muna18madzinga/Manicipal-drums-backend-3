/**
 * Loading a plan's decisions from a spreadsheet: one implementation shared by the command-line
 * loader (scripts/load-zoning-matrix.js) and the workbench API (routes/planWorkbench.js).
 *
 * Everything works inside ONE plan: its zone types, its land uses, its decisions. The format
 * and checks are in utils/zoningMatrixImport.js. Writing is one transaction: all rows or none.
 * An approved, gazetted or superseded plan is refused by the database (migration 150).
 */
const { parseCsv, planImport } = require('../utils/zoningMatrixImport')

/** Everything the importer needs to know about one plan. Returns null for an unknown plan. */
async function loadPlanContext(db, planId) {
  const { rows: plans } = await db.query(
    `SELECT i.id, i.title, i.status, i.is_template, a.authority_name
       FROM plan_instrument i LEFT JOIN local_authorities a ON a.id = i.authority_id WHERE i.id = $1`, [planId])
  if (!plans.length) return null
  const { rows: zoneTypes } = await db.query(
    'SELECT id, code, name AS label, display_no AS display_order FROM plan_zone_type WHERE plan_instrument_id = $1', [planId])
  const { rows: groups } = await db.query(
    'SELECT id, group_code, description, display_order, is_active FROM land_use_groups WHERE plan_instrument_id = $1', [planId])
  const { rows: zones } = await db.query(
    'SELECT id, zone FROM proposed_peri_urban_zones WHERE plan_instrument_id = $1 ORDER BY id', [planId])
  const { rows: existing } = await db.query(
    `SELECT zone_id, zone_type, plan_zone_type_id, land_use_group_id, control_type, conditions, notes, authority, deleted_at
       FROM zone_land_use_controls WHERE plan_instrument_id = $1`, [planId])
  return { plan: plans[0], zoneTypes, groups, zones, existing }
}

/** Dry-run analysis of a CSV against a loaded context. */
function analyse(ctx, csvText) {
  return planImport({ rows: parseCsv(csvText), zones: ctx.zones, zoneTypes: ctx.zoneTypes, groups: ctx.groups, existing: ctx.existing })
}

/** Write the cells that changed. Call inside a transaction on a single client. */
async function applyCells(client, cells) {
  for (const c of cells.filter((x) => x.action !== 'unchanged')) {
    // A cell targets a plan zone type, a legacy global zone-type code, or a zone polygon.
    const target = c.plan_zone_type_id
      ? { col: 'plan_zone_type_id', val: c.plan_zone_type_id, conflict: '(plan_zone_type_id, land_use_group_id) WHERE plan_zone_type_id IS NOT NULL' }
      : c.zone_type
        ? { col: 'zone_type', val: c.zone_type, conflict: '(zone_type, land_use_group_id) WHERE zone_type IS NOT NULL' }
        : { col: 'zone_id', val: c.zone_id, conflict: '(zone_id, land_use_group_id)' }
    await client.query(
      `INSERT INTO zone_land_use_controls (${target.col}, land_use_group_id, control_type, authority, conditions, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ${target.conflict} DO UPDATE SET
         control_type = EXCLUDED.control_type, authority = EXCLUDED.authority,
         conditions = EXCLUDED.conditions, notes = EXCLUDED.notes,
         updated_at = NOW(), deleted_at = NULL, deleted_by = NULL`,
      [target.val, c.land_use_group_id, c.control_type, c.authority, c.conditions, c.notes])
  }
}

/**
 * Validate a CSV against a plan and, if apply is true and there are no errors, write it in one
 * transaction. Returns { found, summary, errors, coverage, applied }.
 */
async function importCsv(pool, planId, csvText, { apply = false, actor = null } = {}) {
  const ctx = await loadPlanContext(pool, planId)
  if (!ctx) return { found: false }
  const result = analyse(ctx, csvText)
  const out = { found: true, plan: ctx.plan, summary: result.summary, errors: result.errors, coverage: result.coverage, applied: false }
  if (!apply || result.errors.length) return out

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await applyCells(client, result.cells)
    await client.query(
      'SELECT log_plan_event($1, $2, $3, $4, $5::jsonb)',
      [planId, 'matrix_imported', actor && actor.id, actor && actor.role,
        JSON.stringify({ inserts: result.summary.inserts, updates: result.summary.updates, unchanged: result.summary.unchanged, undecided: result.summary.undecided })])
    await client.query('COMMIT')
    out.applied = true
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

module.exports = { loadPlanContext, analyse, applyCells, importCsv }
