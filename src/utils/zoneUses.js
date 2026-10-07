/**
 * Reads the zoning permission matrix.
 *
 * The single source of truth is `zone_land_use_controls` (zone polygon x
 * land-use group -> permitted | special_consent | prohibited), with the group
 * vocabulary in `land_use_groups`. The older `development_matrix` table is no
 * longer read: its columns (zone_id, group_id, is_active, permission_types)
 * do not exist in the live schema, so every query against it failed.
 *
 * Bulk limits (max units, height, minimum lot size) are not modelled by the
 * canonical table; they are returned as null so existing clients keep working.
 */

/** Controls for one zone polygon, joined to the group vocabulary. $1 = zone id. */
const ZONE_USES_SQL = `
  SELECT g.group_code,
         g.description AS group_description,
         g.group_category,
         c.control_type,
         c.conditions,
         c.notes
    FROM zone_land_use_controls c
    JOIN land_use_groups g ON g.id = c.land_use_group_id
   WHERE c.zone_id = $1
     AND c.deleted_at IS NULL
     AND g.is_active = TRUE
   ORDER BY g.group_category, g.group_code`

/** How many live rules a zone polygon has; used to prefer the best-described of overlapping zones. */
const RULES_COUNT_SQL = `(SELECT COUNT(*) FROM zone_land_use_controls c
                          WHERE c.zone_id = z.id AND c.deleted_at IS NULL)`

/** The short codes the legacy API and the planner screen use. */
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

/** Split ZONE_USES_SQL rows into the three lists the clients expect. */
function groupUses(rows) {
  const out = { permitted_uses: [], prohibited_uses: [], consent_required_uses: [] }
  for (const row of rows) {
    if (row.control_type === 'permitted') out.permitted_uses.push(useInfo(row))
    else if (row.control_type === 'prohibited') out.prohibited_uses.push(useInfo(row))
    else if (row.control_type === 'special_consent') out.consent_required_uses.push(useInfo(row))
  }
  return out
}

module.exports = { ZONE_USES_SQL, RULES_COUNT_SQL, PERMISSION_CODE, CONTROL_TYPE, groupUses }
