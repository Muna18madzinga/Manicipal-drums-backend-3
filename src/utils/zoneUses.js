/**
 * Reads the zoning permission matrix.
 *
 * The single source of truth is `zone_land_use_controls`: a decision
 * (permitted | special_consent | prohibited) for a land use in either
 *   - one of a PLAN'S zone types (e.g. the district development control matrix:
 *     eleven land-use zones against ~32 coded land uses), or
 *   - a zone polygon (a local plan's own table).
 * Each plan owns its land-use vocabulary (`land_use_groups`, A, A1, ... Z, in its
 * own order), so two plans can both have an "A". Plan-level readers take a plan id.
 * A blank cell in the council's matrix is simply no row: readers see "unknown".
 *
 * "What applies to this polygon" is the view `zone_effective_controls`: its own
 * rows plus those of its zone type, the polygon's own rule winning. The older
 * `development_matrix` table is not read: its columns do not exist in the live
 * schema, so every query against it failed.
 *
 * Bulk limits (max units, height, minimum lot size) are not modelled by the
 * canonical table; they are returned as null so existing clients keep working.
 */

/** Effective controls for one zone polygon, in matrix order. $1 = polygon id. */
const ZONE_USES_SQL = `
  SELECT g.group_code,
         g.description AS group_description,
         g.group_category,
         c.control_type,
         c.conditions,
         c.notes
    FROM zone_effective_controls c
    JOIN land_use_groups g ON g.id = c.land_use_group_id
   WHERE c.zone_id = $1
     AND c.deleted_at IS NULL
     AND g.is_active = TRUE
   ORDER BY g.display_order, g.group_code`

/** How many live rules a zone polygon has; used to prefer the best-described of overlapping zones. */
const RULES_COUNT_SQL = `(SELECT COUNT(*) FROM zone_effective_controls c
                          WHERE c.zone_id = z.id AND c.deleted_at IS NULL)`

/** The plan used when a request names none: the rural profile's default template (transitional). */
const DEFAULT_PLAN_SQL = `
  SELECT i.id
    FROM plan_instrument i JOIN plan_profile p ON p.id = i.profile_id
   WHERE i.is_default_template AND p.code = 'rural'
   LIMIT 1`

/** One zone type of one plan. $1 = plan id, $2 = zone type code. */
const PLAN_ZONE_TYPE_SQL = `
  SELECT code, name AS label FROM plan_zone_type WHERE plan_instrument_id = $1 AND code = $2`

/** Controls for one zone TYPE of one plan, in that plan's land-use order. $1 = plan id, $2 = zone type code. */
const ZONE_TYPE_USES_SQL = `
  SELECT g.group_code,
         g.description AS group_description,
         g.group_category,
         c.control_type,
         c.conditions,
         c.notes
    FROM zone_land_use_controls c
    JOIN plan_zone_type t ON t.id = c.plan_zone_type_id
    JOIN land_use_groups g ON g.id = c.land_use_group_id
   WHERE t.plan_instrument_id = $1
     AND t.code = $2
     AND c.deleted_at IS NULL
     AND g.is_active = TRUE
   ORDER BY g.display_order, g.group_code`

/** A plan's zone types with how many decisions each has. $1 = plan id. */
const ZONE_TYPES_SQL = `
  SELECT t.code, t.name AS label, t.category, t.display_no AS display_order,
         COUNT(*) FILTER (WHERE c.control_type = 'permitted')       ::int AS permitted,
         COUNT(*) FILTER (WHERE c.control_type = 'special_consent') ::int AS special_consent,
         COUNT(*) FILTER (WHERE c.control_type = 'prohibited')      ::int AS prohibited
    FROM plan_zone_type t
    LEFT JOIN zone_land_use_controls c
           ON c.plan_zone_type_id = t.id AND c.deleted_at IS NULL
   WHERE t.plan_instrument_id = $1
   GROUP BY t.id, t.code, t.name, t.category, t.display_no
   ORDER BY t.display_no NULLS LAST, t.name`

/** A plan's active land uses, in its own order. $1 = plan id. */
const LAND_USES_SQL = `
  SELECT group_code, description, group_category, display_order, notes
    FROM land_use_groups
   WHERE plan_instrument_id = $1 AND is_active = TRUE
   ORDER BY display_order, group_code`

/** Every live zone-type decision of a plan (its whole matrix). $1 = plan id. */
const ZONE_TYPE_CELLS_SQL = `
  SELECT t.code AS zone_type, g.group_code, c.control_type, c.conditions
    FROM zone_land_use_controls c
    JOIN plan_zone_type t ON t.id = c.plan_zone_type_id
    JOIN land_use_groups g ON g.id = c.land_use_group_id
   WHERE t.plan_instrument_id = $1 AND c.deleted_at IS NULL AND g.is_active = TRUE`

/** The short codes the legacy API, the planner screen and the council's matrix use. */
const PERMISSION_CODE = { permitted: 'P', special_consent: 'SC', prohibited: 'X' }
const CONTROL_TYPE = { P: 'permitted', SC: 'special_consent', X: 'prohibited' }

const useInfo = (row) => ({
  group_code: row.group_code,
  description: row.group_description,
  category: row.group_category,
  conditions: row.conditions,
  notes: row.notes ?? null,
  max_units: null,
  max_height_meters: null,
  min_lot_size_sqm: null,
})

/** Split zone-uses rows into the three lists the clients expect. */
function groupUses(rows) {
  const out = { permitted_uses: [], prohibited_uses: [], consent_required_uses: [] }
  for (const row of rows) {
    if (row.control_type === 'permitted') out.permitted_uses.push(useInfo(row))
    else if (row.control_type === 'prohibited') out.prohibited_uses.push(useInfo(row))
    else if (row.control_type === 'special_consent') out.consent_required_uses.push(useInfo(row))
  }
  return out
}

/**
 * The district matrix as the council prints it: land uses down, zone types
 * across, P / X / SC in each cell and null where nothing is decided.
 */
function buildGrid({ zoneTypes, landUses, cells }) {
  const decided = new Map(cells.map((c) => [`${c.zone_type}|${c.group_code}`, c]))
  return {
    zone_types: zoneTypes.map((z) => ({ code: z.code, label: z.label, order: z.display_order })),
    land_uses: landUses.map((u) => ({
      code: u.group_code,
      description: u.description,
      category: u.group_category,
      cells: zoneTypes.map((z) => {
        const c = decided.get(`${z.code}|${u.group_code}`)
        return c ? { permission_code: PERMISSION_CODE[c.control_type], control_type: c.control_type, conditions: c.conditions } : null
      }),
    })),
  }
}

module.exports = {
  DEFAULT_PLAN_SQL,
  PLAN_ZONE_TYPE_SQL,
  ZONE_USES_SQL,
  ZONE_TYPE_USES_SQL,
  ZONE_TYPES_SQL,
  LAND_USES_SQL,
  ZONE_TYPE_CELLS_SQL,
  RULES_COUNT_SQL,
  PERMISSION_CODE,
  CONTROL_TYPE,
  groupUses,
  buildGrid,
}
