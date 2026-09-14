// src/services/inspectorSpatial.js
// ─────────────────────────────────────────────────────────────────────────
// Spatial queries for the Building Inspector.
//
//   listInspectorSites(pg, {scope})      → map layers for every inspection site
//   getSiteReport(pg, permitId)          → the site checks for one permit
//   identifyAt(pg, lng, lat)             → "what is here", incl. linked cases
//   resolvePermitSite(pg, permitId)      → one site, with geometry for reuse
//   distanceToSite(pg, site, lng, lat)   → metres from a fix to the site
//   geofenceVerdict({precision, distanceM, accuracyM})
//   getGeoVerification(pg, inspectionId) → arrival + photo geotags vs the site
//
// SITE RESOLUTION. Permits rarely carry a position, and their stand numbers are
// typed by hand. A site is resolved in one SQL fragment, first hit wins:
//   1. permit point inside a Stands Register polygon
//   2. Stands Register polygon by stand number (unique, or unique in the ward)
//   3. cadastre parcel ≤ CADASTRE_SITE_MAX_SQM, by permit point or by name
//   4. the permit point alone
//   5. a larger cadastral area alone (display only — cannot bound a building)
// and the result states its precision (boundary | point | area | none) so the
// UI never presents a farm outline as a building site.
//
// CRS. Council tables (stands, vungu_*, permit_application) are EPSG:4326. The
// OSM-derived layers are stored as SRID 900914, a CRS84 alias with identical
// lng/lat coordinates. Same two rules as planningSpatial.js:
//   • bbox pre-filter on the BARE column (`t.geom && <4326 geom>`) — `&&` uses
//     the GiST index and does not reject the mixed SRID;
//   • exact tests relabel with ST_SetSRID(t.geom, 4326) (lossless) and measure
//     with ::geography so every figure is ground metres.
// ─────────────────────────────────────────────────────────────────────────

const { STREAM_BUFFER_M, ROUGH_TERRAIN_FCLASS } = require('./planningSpatial')

// A cadastre parcel larger than this is a farm or communal area, not a stand.
const CADASTRE_SITE_MAX_SQM = 50000
// A stand-number match is only trusted near the permit's own point, if it has one.
const STAND_NUMBER_NEAR_POINT_M = 100
// Geofence: tolerance around the site, plus up to MAX_ACCURACY_CREDIT_M of the
// fix's own reported accuracy. A fix worse than UNUSABLE_ACCURACY_M proves nothing.
const GEOFENCE_BOUNDARY_TOLERANCE_M = 30
const GEOFENCE_POINT_TOLERANCE_M = 75
const MAX_ACCURACY_CREDIT_M = 50
const UNUSABLE_ACCURACY_M = 100
// Radii for the "nearby" parts of the report and for identify.
const IDENTIFY_CASE_RADIUS_M = 60
const IDENTIFY_BUILDING_RADIUS_M = 5
const NEARBY_CASE_RADIUS_M = 250
const ROAD_SEARCH_M = 300
const ROAD_ABUTS_M = 15
// Two stand edges this close are treated as shared (digitising tolerance).
const SHARED_EDGE_DEG = 0.00002

const OPEN_ENFORCEMENT = ['draft', 'issued', 'served', 'non_complied']
const OPEN_ENFORCEMENT_SQL = OPEN_ENFORCEMENT.map(s => `'${s}'`).join(',')
const INSPECTABLE_STATUSES_SQL = `'approved','approved_with_conditions'`

const NATURAL_FEATURE_FCLASS = [...new Set([...ROUGH_TERRAIN_FCLASS, 'spring'])]
const MAJOR_ROAD_FCLASS = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link']

const sqlList = (tokens) => tokens.filter(t => /^[a-z_]+$/.test(t)).map(t => `'${t}'`).join(',')

/**
 * Site constraints. `basis: 'statutory'` only where the figure is already the
 * platform's statutory value (EMA 30 m stream-bank protection, as used by
 * planningSpatial.js). Every other distance is a council review distance: it
 * yields `review`, never a finding of breach. Intersecting a feature marked
 * `intersectConflict` yields `conflict`.
 */
const CONSTRAINTS = [
  { key: 'watercourse', label: 'Watercourse', table: 'waterways', nameCol: 'name', classCol: 'fclass',
    thresholdM: STREAM_BUFFER_M, basis: 'statutory', reference: 'EMA stream-bank protection (30 m)',
    intersectConflict: false },
  { key: 'water_body', label: 'Water body or wetland', table: 'water_areas', nameCol: 'name', classCol: 'fclass',
    thresholdM: STREAM_BUFFER_M, basis: 'statutory', reference: 'EMA stream-bank and wetland protection (30 m)',
    intersectConflict: true },
  { key: 'protected_area', label: 'Protected area', table: 'protected_areas', nameCol: null, classCol: 'fclass',
    thresholdM: 0, basis: 'statutory', reference: 'Protected area designation', intersectConflict: true },
  { key: 'natural_feature', label: 'Cliff, cave or spring', table: 'natural_areas', nameCol: 'name', classCol: 'fclass',
    where: `t.fclass IN (${sqlList(NATURAL_FEATURE_FCLASS)})`,
    thresholdM: 10, basis: 'council_review', reference: 'Council review distance', intersectConflict: true },
  { key: 'cemetery', label: 'Cemetery', table: 'vungu_cemeteries', nameCol: 'name', classCol: null,
    thresholdM: 100, basis: 'council_review', reference: 'Council review distance', intersectConflict: true },
  { key: 'waste_site', label: 'Waste management site', table: 'vungu_waste_management', nameCol: null, classCol: 'use',
    thresholdM: 200, basis: 'council_review', reference: 'Council review distance', intersectConflict: true },
  { key: 'railway', label: 'Railway line', table: 'railways', nameCol: 'name', classCol: 'fclass',
    thresholdM: 30, basis: 'council_review', reference: 'Council review distance (railway reserve)',
    intersectConflict: false },
  { key: 'major_road', label: 'Primary or trunk road', table: 'roads', nameCol: 'name', classCol: 'fclass',
    where: `t.fclass IN (${sqlList(MAJOR_ROAD_FCLASS)})`,
    thresholdM: 30, basis: 'council_review', reference: 'Council review distance (building line)',
    intersectConflict: false },
]

// ── helpers ───────────────────────────────────────────────────────────

/** Metres → a degree margin for a bbox pre-filter (generous at Zimbabwe's latitudes). */
function degFor(metres) {
  return (metres / 111320) * 1.15
}

const round = (v, dp = 1) => {
  if (v == null) return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const f = 10 ** dp
  return Math.round(n * f) / f
}

const parseJson = (s) => {
  if (!s) return null
  if (typeof s === 'object') return s
  try { return JSON.parse(s) } catch { return null }
}

const _tableCache = new Map()
/** True when a public table exists. Cached: tables do not appear mid-process. */
async function hasTable(pg, name) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) return false
  if (!_tableCache.has(name)) {
    const r = await pg.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${name}`])
    _tableCache.set(name, Boolean(r.rows[0]?.ok))
  }
  return _tableCache.get(name)
}

function wardDigits(s) {
  const d = String(s ?? '').replace(/\D/g, '')
  return d ? String(Number(d)) : null
}

// ── site resolution ───────────────────────────────────────────────────

const NO_GEOM = 'SELECT NULL::geometry AS geom, NULL::float8 AS area_sqm, NULL::text AS label'
const WARD_EQ = `(NULLIF(regexp_replace(COALESCE(s.ward, ''), '\\D', '', 'g'), '')::numeric
                 = NULLIF(regexp_replace(COALESCE(pa.suburb_ward, ''), '\\D', '', 'g'), '')::numeric)`

/**
 * SQL selecting one resolved site per permit matching `whereSql` (which may use
 * the `pa` alias). Callers append ORDER BY / LIMIT.
 */
async function siteSelectSql(pg, whereSql) {
  const [stands, parcels] = await Promise.all([hasTable(pg, 'stands'), hasTable(pg, 'vungu_parcels')])

  const standAt = stands ? `
    SELECT s.geom, NULL::float8 AS area_sqm, s.stand_number::text AS label
      FROM public.stands s
     WHERE pa.location IS NOT NULL AND s.geom && pa.location AND ST_Intersects(s.geom, pa.location)
     LIMIT 1` : NO_GEOM

  // Unique by number, or unique within the recorded ward; never a guess.
  const standNo = stands ? `
    SELECT CASE
             WHEN count(*) = 1 THEN (array_agg(s.geom))[1]
             WHEN count(*) FILTER (WHERE ${WARD_EQ}) = 1
               THEN (array_agg(s.geom) FILTER (WHERE ${WARD_EQ}))[1]
           END AS geom,
           NULL::float8 AS area_sqm,
           max(s.stand_number)::text AS label
      FROM public.stands s
     WHERE st_at.geom IS NULL
       AND btrim(COALESCE(pa.stand_number, '')) <> ''
       AND upper(btrim(s.stand_number)) = upper(btrim(pa.stand_number))
       AND (pa.location IS NULL
            OR ST_DWithin(s.geom::geography, pa.location::geography, ${STAND_NUMBER_NEAR_POINT_M}))` : NO_GEOM

  const parcelLabel = `COALESCE(NULLIF(p.name, ''), p.name_cfu, 'Parcel ' || p.fid)::text`
  const parcelAt = parcels ? `
    SELECT p.geom, ST_Area(p.geom::geography) AS area_sqm, ${parcelLabel} AS label
      FROM public.vungu_parcels p
     WHERE st_at.geom IS NULL AND st_no.geom IS NULL
       AND pa.location IS NOT NULL AND p.geom IS NOT NULL
       AND p.geom && pa.location AND ST_Intersects(p.geom, pa.location)
     ORDER BY ST_Area(p.geom::geography)
     LIMIT 1` : NO_GEOM

  const parcelNo = parcels ? `
    SELECT p.geom, ST_Area(p.geom::geography) AS area_sqm, ${parcelLabel} AS label
      FROM public.vungu_parcels p
     WHERE st_at.geom IS NULL AND st_no.geom IS NULL
       AND pa.location IS NULL AND p.geom IS NOT NULL
       AND btrim(COALESCE(pa.stand_number, '')) <> ''
       AND upper(btrim(COALESCE(NULLIF(p.name, ''), p.name_cfu))) = upper(btrim(pa.stand_number))
     ORDER BY ST_Area(p.geom::geography)
     LIMIT 1` : NO_GEOM

  return `
    SELECT pa.id AS permit_id,
           pa.dev_register_no, pa.tpd_reference, pa.stand_number, pa.suburb_ward,
           pa.street_address, pa.applicant_name, pa.development_type, pa.description,
           pa.status, pa.plinth_area, pa.floors, pa.stand_area_sqm, pa.updated_at,
           pa.location_source, pa.location_accuracy_m, pa.location_set_at,
           r.source, s.precision, r.label AS site_label,
           ST_X(s.center) AS lng, ST_Y(s.center) AS lat,
           CASE WHEN r.poly IS NOT NULL THEN encode(ST_AsEWKB(r.poly), 'hex') END AS poly_hex,
           CASE WHEN s.center IS NOT NULL THEN encode(ST_AsEWKB(s.center), 'hex') END AS center_hex,
           CASE WHEN r.poly IS NOT NULL THEN ST_AsGeoJSON(r.poly, 7) END AS poly_geojson,
           CASE WHEN r.poly IS NOT NULL THEN ST_Area(r.poly::geography) END AS poly_area_sqm,
           CASE WHEN r.poly IS NULL AND r.area_geom IS NOT NULL THEN r.area_label END AS area_label,
           CASE WHEN r.poly IS NULL AND r.area_geom IS NOT NULL THEN r.area_sqm END AS area_sqm
      FROM spatial_planning.permit_application pa
      LEFT JOIN LATERAL (${standAt}) st_at ON TRUE
      LEFT JOIN LATERAL (${standNo}) st_no ON TRUE
      LEFT JOIN LATERAL (${parcelAt}) pc_at ON TRUE
      LEFT JOIN LATERAL (${parcelNo}) pc_no ON TRUE
     CROSS JOIN LATERAL (
       SELECT COALESCE(st_at.geom, st_no.geom,
                       CASE WHEN pc_at.area_sqm <= ${CADASTRE_SITE_MAX_SQM} THEN pc_at.geom END,
                       CASE WHEN pc_no.area_sqm <= ${CADASTRE_SITE_MAX_SQM} THEN pc_no.geom END) AS poly,
              COALESCE(st_at.label, st_no.label,
                       CASE WHEN pc_at.area_sqm <= ${CADASTRE_SITE_MAX_SQM} THEN pc_at.label END,
                       CASE WHEN pc_no.area_sqm <= ${CADASTRE_SITE_MAX_SQM} THEN pc_no.label END) AS label,
              COALESCE(pc_at.geom, pc_no.geom) AS area_geom,
              COALESCE(pc_at.label, pc_no.label) AS area_label,
              COALESCE(pc_at.area_sqm, pc_no.area_sqm) AS area_sqm,
              CASE
                WHEN st_at.geom IS NOT NULL OR st_no.geom IS NOT NULL THEN 'stands_register'
                WHEN pc_at.area_sqm <= ${CADASTRE_SITE_MAX_SQM}
                  OR pc_no.area_sqm <= ${CADASTRE_SITE_MAX_SQM} THEN 'cadastre'
                WHEN pa.location IS NOT NULL THEN 'permit_location'
                WHEN pc_at.geom IS NOT NULL OR pc_no.geom IS NOT NULL THEN 'cadastre_area'
                ELSE 'none'
              END AS source
     ) r
     CROSS JOIN LATERAL (
       SELECT CASE
                WHEN r.poly IS NOT NULL THEN 'boundary'
                WHEN pa.location IS NOT NULL THEN 'point'
                WHEN r.area_geom IS NOT NULL THEN 'area'
                ELSE 'none'
              END AS precision,
              COALESCE(pa.location, ST_PointOnSurface(r.poly), ST_PointOnSurface(r.area_geom)) AS center
     ) s
     WHERE ${whereSql}`
}

function permitRef(row) {
  return row.dev_register_no || row.tpd_reference || String(row.permit_id).slice(0, 8).toUpperCase()
}

function permitTitle(row) {
  if (row.description) return row.description
  const type = String(row.development_type || 'development').replace(/_/g, ' ')
  return `${type} — Stand ${row.stand_number || '—'}`
}

/** Public, JSON-safe view of a resolved site row. */
function siteDto(row) {
  const geometry = parseJson(row.poly_geojson)
  return {
    permitId: row.permit_id,
    ref: permitRef(row),
    standNumber: row.stand_number || null,
    recordedWard: row.suburb_ward || null,
    source: row.source,
    precision: row.precision,
    label: row.site_label || null,
    center: row.lng == null ? null : [Number(row.lng), Number(row.lat)],
    geometry,
    areaSqm: round(row.poly_area_sqm, 0),
    coarseArea: row.area_label
      ? { label: row.area_label, areaHa: round(Number(row.area_sqm) / 10000, 1) }
      : null,
    position: {
      source: row.location_source || null,
      accuracyM: round(row.location_accuracy_m, 1),
      setAt: row.location_set_at || null,
    },
  }
}

async function resolvePermitSite(pg, permitId) {
  const sql = await siteSelectSql(pg, 'pa.id = $1')
  const r = await pg.query(sql, [permitId])
  return r.rows[0] || null
}

// ── sites for the map ─────────────────────────────────────────────────

/**
 * Every inspection site as map layers. `inspectable` = decided permits that
 * can be under construction, occupied buildings, and any permit with open
 * enforcement. `all` adds the rest of the register.
 */
async function listInspectorSites(pg, { scope = 'inspectable', limit = 1000 } = {}) {
  const where = scope === 'all'
    ? 'TRUE'
    : `(pa.status IN (${INSPECTABLE_STATUSES_SQL})
        OR EXISTS (SELECT 1 FROM spatial_planning.occupation_certificate oc WHERE oc.permit_app_id = pa.id)
        OR EXISTS (SELECT 1 FROM spatial_planning.enforcement_order eo
                    WHERE eo.permit_app_id = pa.id AND eo.status IN (${OPEN_ENFORCEMENT_SQL})))`
  const siteSql = await siteSelectSql(pg, where)

  const [sitesR, enfR] = await Promise.all([
    pg.query(
      `WITH sites AS (${siteSql} ORDER BY pa.updated_at DESC LIMIT $1)
       SELECT sites.*,
              q.stage_number, q.result, q.scheduled_at, q.inspected_at, q.booking_scheduled_for,
              COALESCE(q.has_occupation_certificate, false) AS has_occupation_certificate,
              (SELECT count(*)::int FROM spatial_planning.enforcement_order eo
                WHERE eo.permit_app_id = sites.permit_id
                  AND eo.status IN (${OPEN_ENFORCEMENT_SQL})) AS open_enforcement
         FROM sites
         LEFT JOIN spatial_planning.v_inspector_queue q ON q.permit_app_id = sites.permit_id`,
      [limit],
    ),
    pg.query(
      `SELECT eo.id, eo.order_reference, eo.order_type, eo.status, eo.stand_number,
              eo.permit_app_id, eo.compliance_due_at, eo.issued_at,
              ST_X(eo.location) AS lng, ST_Y(eo.location) AS lat
         FROM spatial_planning.enforcement_order eo
        WHERE eo.status IN (${OPEN_ENFORCEMENT_SQL})
        ORDER BY eo.issued_at DESC
        LIMIT 500`,
    ),
  ])

  const points = []
  const boundaries = []
  const centerByPermit = new Map()
  let unlocated = 0

  for (const row of sitesR.rows) {
    const site = siteDto(row)
    const properties = {
      permitId: row.permit_id,
      ref: site.ref,
      title: permitTitle(row),
      stand: row.stand_number || '—',
      ward: row.suburb_ward || '—',
      applicant: row.applicant_name || '—',
      developmentType: row.development_type || '',
      permitStatus: row.status,
      hasOccupationCertificate: row.has_occupation_certificate === true,
      precision: site.precision,
      source: site.source,
      siteLabel: site.label,
      coarseArea: site.coarseArea,
      lastStage: row.stage_number == null ? null : Number(row.stage_number),
      lastResult: row.result || null,
      scheduledAt: row.scheduled_at || row.booking_scheduled_for || null,
      inspectedAt: row.inspected_at || null,
      openEnforcement: row.open_enforcement || 0,
    }
    // Only boundary and point precision are positions an inspector can go to.
    if (site.center && (site.precision === 'boundary' || site.precision === 'point')) {
      centerByPermit.set(row.permit_id, site.center)
      points.push({ type: 'Feature', id: row.permit_id, geometry: { type: 'Point', coordinates: site.center }, properties })
    } else {
      unlocated++
      points.push({ type: 'Feature', id: row.permit_id, geometry: null, properties })
    }
    if (site.geometry) {
      boundaries.push({
        type: 'Feature',
        id: row.permit_id,
        geometry: site.geometry,
        properties: { permitId: row.permit_id, ref: site.ref, source: site.source },
      })
    }
  }

  const enforcement = enfR.rows.map((o) => {
    const own = o.lng == null ? null : [Number(o.lng), Number(o.lat)]
    const coordinates = own || (o.permit_app_id ? centerByPermit.get(o.permit_app_id) : null) || null
    return {
      type: 'Feature',
      id: o.id,
      geometry: coordinates ? { type: 'Point', coordinates } : null,
      properties: {
        orderId: o.id,
        reference: o.order_reference,
        orderType: o.order_type,
        status: o.status,
        stand: o.stand_number,
        permitId: o.permit_app_id,
        complianceDueAt: o.compliance_due_at,
        positionFrom: own ? 'order' : coordinates ? 'permit_site' : 'none',
      },
    }
  })

  return {
    points: { type: 'FeatureCollection', features: points },
    boundaries: { type: 'FeatureCollection', features: boundaries },
    enforcement: { type: 'FeatureCollection', features: enforcement },
    unlocated,
  }
}

// ── site report ───────────────────────────────────────────────────────

async function jurisdictionAt(pg, centerHex) {
  const [boundary, admin] = await Promise.all([hasTable(pg, 'gweru_rural_planning_boundary'), hasTable(pg, 'wards')])
  const r = await pg.query(
    `WITH c AS (SELECT $1::geometry AS g)
     SELECT ${boundary
       ? `(SELECT bool_or(ST_Intersects(ST_SetSRID(b.geom, 4326), c.g))
             FROM gweru_rural_planning_boundary b WHERE b.geom && c.g)`
       : 'NULL::boolean'} AS in_jurisdiction,
            ${admin
       ? `(SELECT d.name_en FROM districts d
            WHERE d.level = 2 AND d.geom && c.g AND ST_Intersects(ST_SetSRID(d.geom, 4326), c.g) LIMIT 1)`
       : 'NULL::text'} AS district,
            ${admin
       ? `(SELECT w.name_en FROM wards w
            WHERE w.level = 3 AND w.geom && c.g AND ST_Intersects(ST_SetSRID(w.geom, 4326), c.g) LIMIT 1)`
       : 'NULL::text'} AS ward
       FROM c`,
    [centerHex],
  )
  const row = r.rows[0] || {}
  return {
    inJurisdiction: row.in_jurisdiction === true,
    district: row.district || null,
    ward: row.ward || null,
  }
}

async function zoningFor(pg, siteHex, isArea) {
  if (!(await hasTable(pg, 'zones_master'))) return { zones: [], controls: [], available: false }
  const zonesR = await pg.query(
    `WITH s AS (SELECT $1::geometry AS g)
     SELECT z.id, z.zone, z.zone_code,
            ${isArea
      ? `ST_Area(ST_Intersection(ST_MakeValid(z.geom), s.g)::geography)
                 / NULLIF(ST_Area(s.g::geography), 0) * 100`
      : '100::float8'} AS coverage_pct
       FROM zones_master z, s
      WHERE z.geom && s.g AND ST_Intersects(z.geom, s.g)
        AND COALESCE(z.is_active, true)
      ORDER BY coverage_pct DESC NULLS LAST
      LIMIT 5`,
    [siteHex],
  )
  const zones = zonesR.rows.map(z => ({
    id: z.id, zone: z.zone, zoneCode: z.zone_code, coveragePct: round(z.coverage_pct, 1),
  }))
  let controls = []
  if (zones[0] && (await hasTable(pg, 'zone_land_use_controls'))) {
    const c = await pg.query(
      `SELECT c.control_type, c.authority, c.conditions,
              g.group_code, g.description AS land_use, g.group_category
         FROM zone_land_use_controls c
         LEFT JOIN land_use_groups g ON g.group_id = c.land_use_group_id
        WHERE c.zone_id = $1 AND c.deleted_at IS NULL
        ORDER BY c.control_type, g.group_code
        LIMIT 100`,
      [zones[0].id],
    )
    controls = c.rows.map(x => ({
      controlType: x.control_type,
      landUse: x.land_use || x.group_code || null,
      category: x.group_category || null,
      authority: x.authority || null,
      conditions: x.conditions || null,
    }))
  }
  return { zones, controls, available: true }
}

function constraintStatus(def, distanceM) {
  if (distanceM == null) return 'clear'
  if (def.intersectConflict && distanceM <= 0.01) return 'conflict'
  if (distanceM <= def.thresholdM) return 'review'
  return 'clear'
}

async function constraintsFor(pg, siteHex) {
  const present = await Promise.all(CONSTRAINTS.map(d => hasTable(pg, d.table)))
  const active = CONSTRAINTS.filter((_, i) => present[i])
  const out = new Map()
  if (active.length) {
    const parts = active.map((d) => {
      const searchM = Math.max(200, d.thresholdM * 3)
      return `
        SELECT '${d.key}'::text AS key, x.name, x.fclass, x.d
          FROM site LEFT JOIN LATERAL (
            SELECT ${d.nameCol ? `t.${d.nameCol}::text` : 'NULL::text'} AS name,
                   ${d.classCol ? `t.${d.classCol}::text` : 'NULL::text'} AS fclass,
                   ST_Distance(ST_SetSRID(t.geom, 4326)::geography, site.g::geography) AS d
              FROM ${d.table} t
             WHERE t.geom && ST_Expand(site.g, ${degFor(searchM)})
               ${d.where ? `AND ${d.where}` : ''}
             ORDER BY d
             LIMIT 1
          ) x ON TRUE
         WHERE x.d IS NULL OR x.d <= ${searchM}`
    })
    const r = await pg.query(`WITH site AS (SELECT $1::geometry AS g) ${parts.join(' UNION ALL ')}`, [siteHex])
    for (const row of r.rows) out.set(row.key, row)
  }
  return CONSTRAINTS.map((d) => {
    if (!active.includes(d)) {
      return { key: d.key, label: d.label, basis: d.basis, reference: d.reference,
        thresholdM: d.thresholdM, status: 'no_data', distanceM: null, feature: null }
    }
    const row = out.get(d.key)
    const distanceM = row && row.d != null ? round(row.d, 1) : null
    return {
      key: d.key,
      label: d.label,
      basis: d.basis,
      reference: d.reference,
      thresholdM: d.thresholdM,
      status: constraintStatus(d, distanceM),
      distanceM,
      feature: distanceM == null ? null : { name: row.name || null, fclass: row.fclass || null },
    }
  })
}

async function accessFor(pg, siteHex) {
  if (!(await hasTable(pg, 'roads'))) return { available: false, nearestRoad: null, abutsRoad: null }
  const r = await pg.query(
    `WITH s AS (SELECT $1::geometry AS g)
     SELECT t.name, t.fclass, t.ref,
            ST_Distance(ST_SetSRID(t.geom, 4326)::geography, s.g::geography) AS d
       FROM roads t, s
      WHERE t.geom && ST_Expand(s.g, ${degFor(ROAD_SEARCH_M)})
      ORDER BY d
      LIMIT 1`,
    [siteHex],
  )
  const row = r.rows[0]
  if (!row || Number(row.d) > ROAD_SEARCH_M) {
    return { available: true, nearestRoad: null, abutsRoad: false, searchedM: ROAD_SEARCH_M }
  }
  return {
    available: true,
    nearestRoad: { name: row.name || null, fclass: row.fclass || null, ref: row.ref || null, distanceM: round(row.d, 1) },
    abutsRoad: Number(row.d) <= ROAD_ABUTS_M,
    searchedM: ROAD_SEARCH_M,
  }
}

async function structuresFor(pg, polyHex, siteAreaSqm, approvedPlinthSqm) {
  if (!(await hasTable(pg, 'buildings'))) return { available: false }
  const r = await pg.query(
    `WITH s AS (SELECT ST_CollectionExtract(ST_MakeValid($1::geometry), 3) AS g)
     SELECT b.fid, b.fclass, b.type,
            ST_Area(ST_SetSRID(b.geom, 4326)::geography) AS area_sqm,
            ST_Area(ST_Intersection(ST_MakeValid(ST_SetSRID(b.geom, 4326)), s.g)::geography) AS inside_sqm,
            ST_CoveredBy(ST_SetSRID(b.geom, 4326), s.g) AS within,
            ST_Distance(ST_SetSRID(b.geom, 4326)::geography, ST_Boundary(s.g)::geography) AS clearance_m,
            ST_AsGeoJSON(ST_SetSRID(b.geom, 4326), 7) AS geojson
       FROM buildings b, s
      WHERE b.geom && s.g AND ST_Intersects(ST_SetSRID(b.geom, 4326), s.g)
      ORDER BY area_sqm DESC
      LIMIT 200`,
    [polyHex],
  )
  const rows = r.rows
  const footprintSqm = rows.reduce((sum, b) => sum + Number(b.inside_sqm || 0), 0)
  const crossing = rows.filter(b => !b.within)
  const withinRows = rows.filter(b => b.within)
  const minClearance = withinRows.length
    ? Math.min(...withinRows.map(b => Number(b.clearance_m)))
    : null
  return {
    available: true,
    source: 'OpenStreetMap building footprints',
    count: rows.length,
    footprintSqm: round(footprintSqm, 0),
    coveragePct: siteAreaSqm ? round((footprintSqm / siteAreaSqm) * 100, 1) : null,
    largestSqm: rows[0] ? round(rows[0].area_sqm, 0) : null,
    crossingBoundary: crossing.length,
    minBoundaryClearanceM: round(minClearance, 1),
    approvedPlinthSqm: approvedPlinthSqm == null ? null : round(approvedPlinthSqm, 0),
    // Only a comparison, never a finding: mapped footprints may be out of date.
    exceedsApprovedPlinth: approvedPlinthSqm == null || !rows.length
      ? null
      : footprintSqm > Number(approvedPlinthSqm) * 1.1,
    footprints: {
      type: 'FeatureCollection',
      features: rows.map(b => ({
        type: 'Feature',
        id: b.fid,
        geometry: parseJson(b.geojson),
        properties: {
          fid: b.fid,
          type: b.type || b.fclass || null,
          areaSqm: round(b.area_sqm, 0),
          withinSite: b.within === true,
          boundaryClearanceM: b.within ? round(b.clearance_m, 1) : null,
        },
      })),
    },
  }
}

async function neighboursFor(pg, polyHex, source) {
  const useStands = source === 'stands_register'
  const table = useStands ? 'stands' : 'vungu_parcels'
  if (!(await hasTable(pg, table))) return []
  const label = useStands
    ? 'n.stand_number::text'
    : `COALESCE(NULLIF(n.name, ''), n.name_cfu, 'Parcel ' || n.fid)::text`
  const r = await pg.query(
    `WITH s AS (SELECT ST_CollectionExtract(ST_MakeValid($1::geometry), 3) AS g)
     SELECT ${label} AS label,
            ${useStands ? 'n.ward::text' : 'NULL::text'} AS ward,
            n.status::text AS status,
            ST_Area(n.geom::geography) AS area_sqm,
            ST_Length(ST_Intersection(ST_Boundary(s.g), ST_Buffer(n.geom, ${SHARED_EDGE_DEG}))::geography) AS shared_m
       FROM ${table} n, s
      WHERE n.geom IS NOT NULL
        AND n.geom && ST_Expand(s.g, ${SHARED_EDGE_DEG * 2})
        AND ST_DWithin(n.geom, s.g, ${SHARED_EDGE_DEG})
        AND NOT ST_Equals(n.geom, $1::geometry)
      ORDER BY shared_m DESC
      LIMIT 20`,
    [polyHex],
  )
  return r.rows.map(n => ({
    kind: useStands ? 'stand' : 'parcel',
    label: n.label,
    ward: n.ward || null,
    status: n.status || null,
    areaSqm: round(n.area_sqm, 0),
    sharedBoundaryM: round(n.shared_m, 1),
  }))
}

async function nearbyCasesFor(pg, siteHex, permitId) {
  const [permits, orders] = await Promise.all([
    pg.query(
      `WITH s AS (SELECT $1::geometry AS g)
       SELECT pa.id, pa.dev_register_no, pa.tpd_reference, pa.stand_number, pa.status, pa.development_type,
              ST_Distance(pa.location::geography, s.g::geography) AS d
         FROM spatial_planning.permit_application pa, s
        WHERE pa.id <> $2 AND pa.location IS NOT NULL
          AND pa.location && ST_Expand(s.g, ${degFor(NEARBY_CASE_RADIUS_M)})
          AND ST_DWithin(pa.location::geography, s.g::geography, ${NEARBY_CASE_RADIUS_M})
        ORDER BY d
        LIMIT 20`,
      [siteHex, permitId],
    ),
    pg.query(
      `WITH s AS (SELECT $1::geometry AS g)
       SELECT eo.id, eo.order_reference, eo.order_type, eo.status, eo.stand_number, eo.permit_app_id,
              CASE WHEN eo.permit_app_id = $2 THEN 0
                   ELSE ST_Distance(eo.location::geography, s.g::geography) END AS d
         FROM spatial_planning.enforcement_order eo, s
        WHERE eo.permit_app_id = $2
           OR (eo.location IS NOT NULL
               AND eo.location && ST_Expand(s.g, ${degFor(NEARBY_CASE_RADIUS_M)})
               AND ST_DWithin(eo.location::geography, s.g::geography, ${NEARBY_CASE_RADIUS_M}))
        ORDER BY d
        LIMIT 20`,
      [siteHex, permitId],
    ),
  ])
  return {
    radiusM: NEARBY_CASE_RADIUS_M,
    permits: permits.rows.map(p => ({
      permitId: p.id,
      ref: p.dev_register_no || p.tpd_reference || String(p.id).slice(0, 8).toUpperCase(),
      stand: p.stand_number || null,
      status: p.status,
      developmentType: p.development_type,
      distanceM: round(p.d, 0),
    })),
    enforcement: orders.rows.map(o => ({
      orderId: o.id,
      reference: o.order_reference,
      orderType: o.order_type,
      status: o.status,
      stand: o.stand_number,
      onThisPermit: o.permit_app_id === permitId,
      open: OPEN_ENFORCEMENT.includes(o.status),
      distanceM: round(o.d, 0),
    })),
  }
}

/**
 * The inspector's site checks for one permit. Returns null when the permit does
 * not exist. A site that cannot be positioned returns the site block and a
 * limitation instead of running checks against a farm-sized outline.
 */
async function getSiteReport(pg, permitId) {
  const row = await resolvePermitSite(pg, permitId)
  if (!row) return null
  const site = siteDto(row)
  const limitations = []
  const report = {
    generatedAt: new Date().toISOString(),
    site,
    permit: {
      status: row.status,
      developmentType: row.development_type,
      approvedPlinthSqm: row.plinth_area == null ? null : Number(row.plinth_area),
      floors: row.floors == null ? null : Number(row.floors),
      recordedStandAreaSqm: row.stand_area_sqm == null ? null : Number(row.stand_area_sqm),
    },
    jurisdiction: null,
    zoning: null,
    constraints: [],
    access: null,
    structures: null,
    neighbours: [],
    nearbyCases: null,
    limitations,
  }

  if (site.precision === 'none' || site.precision === 'area') {
    limitations.push(site.precision === 'area'
      ? `The site is only known to lie within ${site.coarseArea.label} (${site.coarseArea.areaHa} ha). `
        + 'Record the site position to run site checks.'
      : 'The site cannot be located from the permit or the registers. Record the site position to run site checks.')
    return report
  }

  const isBoundary = site.precision === 'boundary'
  const siteHex = isBoundary ? row.poly_hex : row.center_hex
  if (!isBoundary) {
    limitations.push('Only a position is known for this site, not a stand boundary. '
      + 'Coverage, boundary clearance and adjoining stands are not available.')
  }

  const [jurisdiction, zoning, constraints, access, structures, neighbours, nearbyCases] = await Promise.all([
    jurisdictionAt(pg, row.center_hex),
    zoningFor(pg, siteHex, isBoundary),
    constraintsFor(pg, siteHex),
    accessFor(pg, siteHex),
    isBoundary
      ? structuresFor(pg, row.poly_hex, Number(row.poly_area_sqm) || null, row.plinth_area)
      : Promise.resolve(null),
    isBoundary ? neighboursFor(pg, row.poly_hex, row.source) : Promise.resolve([]),
    nearbyCasesFor(pg, row.center_hex, permitId),
  ])

  const recorded = wardDigits(row.suburb_ward)
  const spatial = wardDigits(jurisdiction.ward)
  report.jurisdiction = {
    ...jurisdiction,
    recordedWard: row.suburb_ward || null,
    wardMatchesRecord: recorded && spatial ? recorded === spatial : null,
  }
  report.zoning = zoning
  report.constraints = constraints
  report.access = access
  report.structures = structures
  report.neighbours = neighbours
  report.nearbyCases = nearbyCases

  if (!jurisdiction.inJurisdiction) {
    limitations.push('The site position falls outside the council planning boundary. Confirm the position before relying on these checks.')
  }
  if (!zoning.available) limitations.push('The zoning layer is not available on this server.')
  if (zoning.available && !zoning.zones.length) limitations.push('No master-plan zone covers this site.')
  if (constraints.some(c => c.status === 'no_data')) {
    limitations.push('Some constraint layers are not loaded; those checks show "no data", not "clear".')
  }
  if (structures?.available) {
    limitations.push('Building footprints come from OpenStreetMap and may not show recent construction.')
  }
  limitations.push('Nearby permits are listed only where the permit has a recorded position.')
  return report
}

// ── identify ──────────────────────────────────────────────────────────

/** Everything the registers hold at one point, and the building-control cases on it. */
async function identifyAt(pg, lng, lat) {
  const [stands, parcels, zones, buildings, boundary, wards] = await Promise.all([
    hasTable(pg, 'stands'), hasTable(pg, 'vungu_parcels'), hasTable(pg, 'zones_master'),
    hasTable(pg, 'buildings'), hasTable(pg, 'gweru_rural_planning_boundary'), hasTable(pg, 'wards'),
  ])
  const base = await pg.query(
    `WITH pt AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS g)
     SELECT
       ${boundary ? `(SELECT bool_or(ST_Intersects(ST_SetSRID(b.geom, 4326), pt.g))
                        FROM gweru_rural_planning_boundary b WHERE b.geom && pt.g)` : 'NULL::boolean'} AS in_jurisdiction,
       ${wards ? `(SELECT d.name_en FROM districts d WHERE d.level = 2 AND d.geom && pt.g
                    AND ST_Intersects(ST_SetSRID(d.geom, 4326), pt.g) LIMIT 1)` : 'NULL::text'} AS district,
       ${wards ? `(SELECT w.name_en FROM wards w WHERE w.level = 3 AND w.geom && pt.g
                    AND ST_Intersects(ST_SetSRID(w.geom, 4326), pt.g) LIMIT 1)` : 'NULL::text'} AS ward,
       ${stands ? `(SELECT json_build_object('id', s.id, 'standNumber', s.stand_number, 'ward', s.ward,
                            'zoneType', s.zone_type, 'status', s.status, 'areaSqm', s.area_sqm)
                      FROM stands s WHERE s.geom && pt.g AND ST_Intersects(s.geom, pt.g) LIMIT 1)` : 'NULL::json'} AS stand,
       ${parcels ? `(SELECT json_build_object('fid', p.fid,
                            'name', COALESCE(NULLIF(p.name, ''), p.name_cfu, 'Parcel ' || p.fid),
                            'status', p.status, 'areaSqm', round(ST_Area(p.geom::geography)::numeric, 0))
                       FROM vungu_parcels p
                      WHERE p.geom IS NOT NULL AND p.geom && pt.g AND ST_Intersects(p.geom, pt.g)
                      ORDER BY ST_Area(p.geom::geography) LIMIT 1)` : 'NULL::json'} AS parcel,
       ${zones ? `(SELECT json_build_object('id', z.id, 'zone', z.zone, 'zoneCode', z.zone_code)
                     FROM zones_master z WHERE z.geom && pt.g AND ST_Intersects(z.geom, pt.g)
                      AND COALESCE(z.is_active, true) LIMIT 1)` : 'NULL::json'} AS zone,
       ${buildings ? `(SELECT json_build_object('fid', b.fid, 'type', COALESCE(b.type, b.fclass),
                              'areaSqm', round(ST_Area(ST_SetSRID(b.geom, 4326)::geography)::numeric, 0),
                              'geometry', ST_AsGeoJSON(ST_SetSRID(b.geom, 4326), 7)::json)
                         FROM buildings b
                        WHERE b.geom && ST_Expand(pt.g, ${degFor(IDENTIFY_BUILDING_RADIUS_M)})
                          AND ST_DWithin(ST_SetSRID(b.geom, 4326)::geography, pt.g::geography, ${IDENTIFY_BUILDING_RADIUS_M})
                        ORDER BY ST_Distance(ST_SetSRID(b.geom, 4326)::geography, pt.g::geography)
                        LIMIT 1)` : 'NULL::json'} AS building
     FROM pt`,
    [lng, lat],
  )
  const b = base.rows[0] || {}
  const stand = parseJson(b.stand)
  const parcel = parseJson(b.parcel)

  // Candidate permits: positioned near the point, or named after the stand /
  // stand-sized parcel under it. Resolved with the same rules as the site map.
  const names = []
  if (stand?.standNumber) names.push(String(stand.standNumber).trim().toUpperCase())
  if (parcel?.name && Number(parcel.areaSqm) <= CADASTRE_SITE_MAX_SQM) names.push(String(parcel.name).trim().toUpperCase())
  const siteSql = await siteSelectSql(pg,
    `((pa.location IS NOT NULL
        AND pa.location && ST_Expand(ST_SetSRID(ST_MakePoint($1, $2), 4326), ${degFor(IDENTIFY_CASE_RADIUS_M * 2)}))
      OR upper(btrim(COALESCE(pa.stand_number, ''))) = ANY($3::text[]))`)
  const casesR = await pg.query(
    `WITH sites AS (${siteSql} LIMIT 50)
     SELECT sites.*,
            ST_Distance(COALESCE(sites.poly_hex::geometry, sites.center_hex::geometry)::geography,
                        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS d,
            EXISTS (SELECT 1 FROM spatial_planning.occupation_certificate oc
                     WHERE oc.permit_app_id = sites.permit_id) AS has_oc
       FROM sites
      WHERE sites.precision IN ('boundary', 'point')`,
    [lng, lat, names],
  )
  const cases = casesR.rows
    .filter(c => Number(c.d) <= IDENTIFY_CASE_RADIUS_M)
    .sort((x, y) => Number(x.d) - Number(y.d))
    .map(c => ({
      permitId: c.permit_id,
      ref: permitRef(c),
      title: permitTitle(c),
      stand: c.stand_number || null,
      status: c.status,
      developmentType: c.development_type,
      hasOccupationCertificate: c.has_oc === true,
      precision: c.precision,
      distanceM: round(c.d, 0),
      match: Number(c.d) <= 0.5 ? 'on_site' : 'nearby',
    }))

  const caseIds = cases.map(c => c.permitId)
  const enfR = await pg.query(
    `SELECT eo.id, eo.order_reference, eo.order_type, eo.status, eo.stand_number, eo.permit_app_id
       FROM spatial_planning.enforcement_order eo
      WHERE eo.status IN (${OPEN_ENFORCEMENT_SQL})
        AND (eo.permit_app_id = ANY($3::uuid[])
             OR (eo.location IS NOT NULL
                 AND eo.location && ST_Expand(ST_SetSRID(ST_MakePoint($1, $2), 4326), ${degFor(IDENTIFY_CASE_RADIUS_M)})
                 AND ST_DWithin(eo.location::geography,
                                ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, ${IDENTIFY_CASE_RADIUS_M})))
      LIMIT 20`,
    [lng, lat, caseIds],
  )

  const building = parseJson(b.building)
  const approved = cases.some(c => c.hasOccupationCertificate
    || c.status === 'approved' || c.status === 'approved_with_conditions')
  let assessment
  if (b.in_jurisdiction !== true) assessment = 'outside_jurisdiction'
  else if (approved) assessment = 'permitted_case'
  else if (cases.length) assessment = 'case_not_approved'
  else if (building) assessment = 'structure_without_case'
  else assessment = 'no_case'

  return {
    point: [lng, lat],
    jurisdiction: { inJurisdiction: b.in_jurisdiction === true, district: b.district || null, ward: b.ward || null },
    stand: stand ? { ...stand, areaSqm: round(stand.areaSqm, 0) } : null,
    parcel,
    zone: parseJson(b.zone),
    building,
    cases,
    enforcement: enfR.rows.map(o => ({
      orderId: o.id, reference: o.order_reference, orderType: o.order_type,
      status: o.status, stand: o.stand_number, permitId: o.permit_app_id,
    })),
    assessment,
    radiusM: IDENTIFY_CASE_RADIUS_M,
  }
}

// ── geofence ──────────────────────────────────────────────────────────

/**
 * Attendance verdict for one fix. Pure — the numbers come from the database.
 *   on_site      within tolerance (+ capped accuracy credit)
 *   off_site     outside it
 *   unverifiable the site has no usable position, or the fix is too coarse
 */
function geofenceVerdict({ precision, distanceM, accuracyM }) {
  if (precision !== 'boundary' && precision !== 'point') return 'unverifiable'
  const d = Number(distanceM)
  if (distanceM == null || !Number.isFinite(d)) return 'unverifiable'
  const acc = accuracyM == null ? null : Number(accuracyM)
  if (acc != null && Number.isFinite(acc) && acc > UNUSABLE_ACCURACY_M) return 'unverifiable'
  const tolerance = precision === 'boundary' ? GEOFENCE_BOUNDARY_TOLERANCE_M : GEOFENCE_POINT_TOLERANCE_M
  const credit = acc != null && Number.isFinite(acc) && acc > 0 ? Math.min(acc, MAX_ACCURACY_CREDIT_M) : 0
  return d <= tolerance + credit ? 'on_site' : 'off_site'
}

/** Ground metres from a fix to the resolved site; null when the site has no usable geometry. */
async function distanceToSite(pg, site, lng, lat) {
  const hex = site?.precision === 'boundary' ? site.poly_hex
    : site?.precision === 'point' ? site.center_hex
      : null
  if (!hex) return null
  const r = await pg.query(
    `SELECT ST_Distance($1::geometry::geography, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography) AS d`,
    [hex, lng, lat],
  )
  return round(r.rows[0]?.d, 1)
}

/**
 * Arrival fixes and photo geotags for one stage inspection, measured against the
 * site. Arrival verdicts are the ones frozen at write time; photo distances are
 * measured now, against the current site record, and say so.
 */
async function getGeoVerification(pg, inspectionId) {
  const insp = await pg.query(
    'SELECT id, permit_app_id, stage_number FROM spatial_planning.stage_inspection WHERE id = $1',
    [inspectionId],
  )
  if (!insp.rows[0]) return null
  const siteRow = await resolvePermitSite(pg, insp.rows[0].permit_app_id)
  const site = siteRow ? siteDto(siteRow) : null
  const precision = site?.precision || 'none'
  const hex = precision === 'boundary' ? siteRow.poly_hex : precision === 'point' ? siteRow.center_hex : null

  const [events, photos] = await Promise.all([
    pg.query(
      `SELECT id, recorded_at, observed_lat, observed_lng, accuracy_m,
              site_distance_m, geofence_result, site_precision
         FROM spatial_planning.stage_inspection_field_event
        WHERE stage_inspection_id = $1 AND event_type = 'arrived'
        ORDER BY recorded_at`,
      [inspectionId],
    ),
    pg.query(
      `SELECT p.id, p.caption, p.taken_at, p.taken_lat, p.taken_lng,
              CASE WHEN $2::text IS NOT NULL AND p.taken_lat IS NOT NULL AND p.taken_lng IS NOT NULL
                   THEN ST_Distance($2::text::geometry::geography,
                                    ST_SetSRID(ST_MakePoint(p.taken_lng, p.taken_lat), 4326)::geography)
              END AS d
         FROM spatial_planning.stage_inspection_photo p
        WHERE p.stage_inspection_id = $1
        ORDER BY p.taken_at NULLS LAST, p.created_at`,
      [inspectionId, hex],
    ),
  ])

  const arrivals = events.rows.map(e => ({
    eventId: e.id,
    recordedAt: e.recorded_at,
    hasFix: e.observed_lat != null,
    accuracyM: round(e.accuracy_m, 1),
    distanceM: round(e.site_distance_m, 1),
    result: e.geofence_result || (e.observed_lat == null ? null : 'unverifiable'),
    sitePrecisionAtTime: e.site_precision || null,
  }))
  const photoChecks = photos.rows.map(p => {
    const hasFix = p.taken_lat != null && p.taken_lng != null
    const distanceM = round(p.d, 1)
    return {
      photoId: p.id,
      caption: p.caption,
      takenAt: p.taken_at,
      hasFix,
      distanceM,
      result: hasFix ? geofenceVerdict({ precision, distanceM, accuracyM: null }) : null,
    }
  })

  const results = [...arrivals, ...photoChecks].map(x => x.result).filter(Boolean)
  let verdict
  if (precision !== 'boundary' && precision !== 'point') verdict = 'unverifiable'
  else if (results.includes('off_site')) verdict = 'discrepancy'
  else if (results.includes('on_site')) verdict = 'consistent'
  else verdict = 'insufficient'

  return {
    inspectionId,
    stageNumber: insp.rows[0].stage_number,
    site: site && {
      precision: site.precision, source: site.source, center: site.center, label: site.label,
    },
    tolerance: {
      boundaryM: GEOFENCE_BOUNDARY_TOLERANCE_M,
      pointM: GEOFENCE_POINT_TOLERANCE_M,
      maxAccuracyCreditM: MAX_ACCURACY_CREDIT_M,
    },
    arrivals,
    photos: photoChecks,
    summary: {
      arrivalsWithFix: arrivals.filter(a => a.hasFix).length,
      photos: photoChecks.length,
      geotaggedPhotos: photoChecks.filter(p => p.hasFix).length,
      onSite: results.filter(r => r === 'on_site').length,
      offSite: results.filter(r => r === 'off_site').length,
      verdict,
    },
  }
}

/** Is a point inside the council planning boundary? Null when the boundary layer is absent. */
async function insideCouncilBoundary(pg, lng, lat) {
  if (!(await hasTable(pg, 'gweru_rural_planning_boundary'))) return null
  const r = await pg.query(
    `SELECT bool_or(ST_Intersects(ST_SetSRID(b.geom, 4326), ST_SetSRID(ST_MakePoint($1, $2), 4326))) AS inside
       FROM gweru_rural_planning_boundary b
      WHERE b.geom && ST_SetSRID(ST_MakePoint($1, $2), 4326)`,
    [lng, lat],
  )
  return r.rows[0]?.inside === true
}

module.exports = {
  listInspectorSites,
  getSiteReport,
  identifyAt,
  resolvePermitSite,
  distanceToSite,
  geofenceVerdict,
  getGeoVerification,
  insideCouncilBoundary,
  siteDto,
  OPEN_ENFORCEMENT,
  _internals: {
    constraintStatus, wardDigits, degFor, CONSTRAINTS,
    CADASTRE_SITE_MAX_SQM, GEOFENCE_BOUNDARY_TOLERANCE_M, GEOFENCE_POINT_TOLERANCE_M,
    MAX_ACCURACY_CREDIT_M, UNUSABLE_ACCURACY_M,
  },
}
