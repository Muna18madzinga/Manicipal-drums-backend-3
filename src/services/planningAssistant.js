/**
 * Planning Assistant — rules engine.
 *
 * Given a parcel (stand or arbitrary geometry) the engine returns a
 * deterministic, council-defensible suggestion of what can be developed
 * there. It is NOT an LLM; every value is sourced from:
 *
 *   - planning_assistant_templates (typical layout constants)
 *   - zone_land_use_controls       (matrix: permitted | prohibited | special_consent)
 *   - land_use_groups              (canonical land-use vocabulary)
 *   - proposed_peri_urban_zones    (zone_type, scale_category, ward authority)
 *
 * An optional LLM layer can sit on top later for natural-language
 * explanations, but the rules engine MUST run first so a planner can
 * always trace any suggestion back to a rule + citation.
 *
 * Outputs are JSON serialisable so the same shape is returned by the
 * /api/planning-assistant/* HTTP routes.
 */

const VALID_DECISIONS = new Set(['permitted', 'prohibited', 'special_consent'])

const DEFAULT_DECISION = {
  decision: 'unknown',
  reason: 'No matching zone control was found for this parcel.',
}

/**
 * Look up the zone for a parcel by stand id.
 */
async function loadZoneByStand(pg, standId) {
  const { rows } = await pg.query(
    `SELECT
       s.id            AS stand_id,
       s.stand_number,
       s.ward,
       s.zone_id,
       s.use_scale,
       s.area_sqm,
       z.zone          AS zone_name,
       z.zone_type,
       z.scale_category,
       z.authority,
       z.zone_description
     FROM stands s
     LEFT JOIN proposed_peri_urban_zones z ON z.id = s.zone_id
     WHERE s.id = $1`,
    [standId],
  )
  return rows[0] ?? null
}

/**
 * Look up the zone covering an arbitrary point (lng, lat in EPSG:4326).
 * Used when a planner clicks an unmapped piece of land.
 */
async function loadZoneByPoint(pg, lng, lat) {
  const { rows } = await pg.query(
    `SELECT id, zone, zone_type, scale_category, authority, zone_description
     FROM proposed_peri_urban_zones
     WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
     LIMIT 1`,
    [lng, lat],
  )
  return rows[0] ?? null
}

/**
 * Decision: is `landUseGroupCode` permitted in this zone?
 * Returns one of:
 *   { decision: 'permitted',       conditions: null,    citation }
 *   { decision: 'special_consent', conditions: '<text>',citation }
 *   { decision: 'prohibited',      conditions: null,    citation }
 *   { decision: 'unknown',         reason: '<text>' }
 */
async function decideUse(pg, { zoneId, landUseGroupCode }) {
  if (!zoneId) return { ...DEFAULT_DECISION }
  if (!landUseGroupCode) {
    return { decision: 'unknown', reason: 'No land-use group provided.' }
  }

  const { rows } = await pg.query(
    `SELECT zlc.control_type, zlc.conditions, zlc.authority,
            lug.group_code, lug.group_name, lug.development_category
     FROM zone_land_use_controls zlc
     JOIN land_use_groups lug ON lug.id = zlc.land_use_group_id
     WHERE zlc.zone_id = $1
       AND lug.group_code = $2
     LIMIT 1`,
    [zoneId, landUseGroupCode],
  )
  const row = rows[0]
  if (!row) return { ...DEFAULT_DECISION, reason: 'No rule for this land-use in this zone.' }

  const decision = row.control_type
  return {
    decision: VALID_DECISIONS.has(decision) ? decision : 'unknown',
    landUseGroupCode: row.group_code,
    landUseGroupName: row.group_name,
    conditions: row.conditions ?? null,
    authority:  row.authority  ?? null,
  }
}

/**
 * Pick the most specific template for a zone (ward-scoped first, then
 * zone-wide), and optionally for a particular `purpose` such as
 * `residential_low_density`. Returns null if nothing matches.
 */
async function loadTemplate(pg, { zoneType, scaleCategory, ward, purpose }) {
  if (!zoneType || !scaleCategory) return null

  // Ward-scoped match first.
  if (ward) {
    const { rows } = await pg.query(
      `SELECT * FROM planning_assistant_templates
       WHERE zone_type = $1 AND scale_category = $2 AND ward = $3
         ${purpose ? 'AND purpose = $4' : ''}
         AND is_active = true
       ORDER BY updated_at DESC
       LIMIT 1`,
      purpose ? [zoneType, scaleCategory, ward, purpose] : [zoneType, scaleCategory, ward],
    )
    if (rows[0]) return rows[0]
  }

  // Zone-wide fallback.
  const { rows } = await pg.query(
    `SELECT * FROM planning_assistant_templates
     WHERE zone_type = $1 AND scale_category = $2 AND ward IS NULL
       ${purpose ? 'AND purpose = $3' : ''}
       AND is_active = true
     ORDER BY updated_at DESC
     LIMIT 1`,
    purpose ? [zoneType, scaleCategory, purpose] : [zoneType, scaleCategory],
  )
  return rows[0] ?? null
}

/**
 * List every permitted use for a zone (for "what CAN I build here?").
 */
async function listPermittedUses(pg, zoneId) {
  if (!zoneId) return []
  const { rows } = await pg.query(
    `SELECT lug.group_code, lug.group_name, zlc.control_type, zlc.conditions
     FROM zone_land_use_controls zlc
     JOIN land_use_groups lug ON lug.id = zlc.land_use_group_id
     WHERE zlc.zone_id = $1
     ORDER BY
       CASE zlc.control_type
         WHEN 'permitted'       THEN 1
         WHEN 'special_consent' THEN 2
         WHEN 'prohibited'      THEN 3
         ELSE 4
       END,
       lug.group_code`,
    [zoneId],
  )
  return rows.map(r => ({
    groupCode:  r.group_code,
    groupName:  r.group_name,
    decision:   r.control_type,
    conditions: r.conditions,
  }))
}

/**
 * Compute simple plot-fit warnings: does this stand satisfy the template
 * minimums? Returns an array of plain-English flags for the planner.
 */
function checkPlotFit(stand, template) {
  if (!stand || !template) return []
  const flags = []

  if (template.min_area_sqm != null && stand.area_sqm < Number(template.min_area_sqm)) {
    flags.push({
      severity: 'warning',
      code:     'area_below_minimum',
      message:  `Stand area ${stand.area_sqm} m² is below the typical minimum of ${template.min_area_sqm} m² for this template.`,
    })
  }
  if (template.max_area_sqm != null && stand.area_sqm > Number(template.max_area_sqm)) {
    flags.push({
      severity: 'info',
      code:     'area_above_maximum',
      message:  `Stand area ${stand.area_sqm} m² exceeds the typical maximum of ${template.max_area_sqm} m². Consider a larger-scale template.`,
    })
  }
  if (template.min_frontage_m != null && stand.frontage_m != null
      && stand.frontage_m < Number(template.min_frontage_m)) {
    flags.push({
      severity: 'warning',
      code:     'frontage_below_minimum',
      message:  `Stand frontage ${stand.frontage_m} m is below the recommended minimum of ${template.min_frontage_m} m.`,
    })
  }

  return flags
}

/**
 * Headline suggestion. Combines:
 *   - the template envelope
 *   - the matrix's permitted uses
 *   - plot-fit flags
 *   - the maximum buildable footprint = stand_area * (max_plot_coverage_pct / 100)
 */
async function suggestPlan(pg, { standId, lng, lat, purpose }) {
  let stand = null
  let zone  = null

  if (standId) {
    stand = await loadZoneByStand(pg, standId)
    if (!stand) return { found: false, reason: 'Stand not found.' }
    if (stand.zone_id) {
      zone = {
        id:               stand.zone_id,
        zone_name:        stand.zone_name,
        zone_type:        stand.zone_type,
        scale_category:   stand.scale_category,
        authority:        stand.authority,
        zone_description: stand.zone_description,
      }
    }
  } else if (lng != null && lat != null) {
    zone = await loadZoneByPoint(pg, lng, lat)
  } else {
    return { found: false, reason: 'Provide a standId or lng/lat.' }
  }

  if (!zone) {
    return {
      found: false,
      reason: 'No zone covers this location.',
      stand,
    }
  }

  const ward = stand?.ward ?? null
  const template = await loadTemplate(pg, {
    zoneType:      zone.zone_type,
    scaleCategory: zone.scale_category,
    ward,
    purpose,
  })
  const permittedUses = await listPermittedUses(pg, zone.id)
  const flags = stand ? checkPlotFit(stand, template) : []

  const maxFootprintSqm = (stand && template?.max_plot_coverage_pct != null)
    ? Number((stand.area_sqm * Number(template.max_plot_coverage_pct) / 100).toFixed(2))
    : null

  return {
    found: true,
    stand: stand && {
      id:           stand.stand_id,
      standNumber:  stand.stand_number,
      ward:         stand.ward,
      areaSqm:      Number(stand.area_sqm),
      frontageM:    stand.frontage_m != null ? Number(stand.frontage_m) : null,
    },
    zone: {
      id:             zone.id,
      name:           zone.zone_name ?? zone.zone,
      zoneType:       zone.zone_type,
      scaleCategory:  zone.scale_category,
      authority:      zone.authority,
      description:    zone.zone_description,
    },
    template: template && {
      id:                  template.id,
      purpose:             template.purpose,
      displayName:         template.display_name,
      description:         template.description,
      envelope: {
        minAreaSqm:          numOrNull(template.min_area_sqm),
        maxAreaSqm:          numOrNull(template.max_area_sqm),
        minFrontageM:        numOrNull(template.min_frontage_m),
        maxPlotCoveragePct:  numOrNull(template.max_plot_coverage_pct),
        maxFloorAreaRatio:   numOrNull(template.max_floor_area_ratio),
        maxHeightM:          numOrNull(template.max_height_m),
        maxStoreys:          template.max_storeys,
        setbackFrontM:       numOrNull(template.setback_front_m),
        setbackRearM:        numOrNull(template.setback_rear_m),
        setbackSideM:        numOrNull(template.setback_side_m),
      },
      maxBuildableFootprintSqm: maxFootprintSqm,
      extras:                template.extras ?? {},
      sourceCitation:        template.source_citation,
    },
    permittedUses,
    flags,
  }
}

function numOrNull(v) {
  return v == null ? null : Number(v)
}

module.exports = {
  loadZoneByStand,
  loadZoneByPoint,
  decideUse,
  loadTemplate,
  listPermittedUses,
  suggestPlan,
}
