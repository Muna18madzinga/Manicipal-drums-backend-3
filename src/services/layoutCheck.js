/**
 * The rules that decide whether a surveyed layout may enter the register: one place, used twice.
 *
 *   - the SurveyPro importer (src/services/surveyproImport.js) applies them to a council's ACCEPTED work and refuses the whole layout on any
 *     error;
 *   - the layout check (POST /api/context/check-layout) applies the same rules to a layout still being worked on, so a surveyor or a reviewer
 *     learns of a problem before the work is delivered or accepted, not after. Advisory there; the importer stays the gate.
 *
 * Nothing here writes. Both callers pass a database client and the parcels as SurveyPro's share view presents them:
 *   { id, stand, designation, area_m2, lo_zone, srid, geojson }   (geojson in the survey CRS; Cape / Lo carries westing as X, southing as Y)
 * docs/SURVEYPRO-INTEGRATION.md, "The importer"; docs/HARMONIZATION-SCOPE.md, piece A1.
 */

const OVERLAP_TOLERANCE_M2 = 0.5       // two independent transforms of a shared edge differ by far less than this
const AREA_TOLERANCE = { absolute_m2: 0.5, relative: 0.001 }

/** Do two areas disagree by more than the tolerance? */
function areasDisagree(a, b) {
  if (a == null || b == null) return false
  const x = Number(a), y = Number(b)
  return Math.abs(x - y) > Math.max(AREA_TOLERANCE.absolute_m2, AREA_TOLERANCE.relative * Math.max(x, y))
}

/** The Lo zone's survey SRID in VunGIS's own registry, cached per client call site. */
function zoneSridResolver() {
  const cache = new Map()
  return async (client, zone) => {
    if (!cache.has(zone)) cache.set(zone, ((await client.query(`SELECT srid FROM gis_ops.crs_registry WHERE code = 'Lo' || $1::text AND is_survey`, [zone])).rows[0] || {}).srid || null)
    return cache.get(zone)
  }
}

/**
 * Each parcel on its own: a stand number, a polygon, valid, in a system the registry knows, no repeated number within the layout.
 *   parcels   the eligible parcels (the caller has already set aside drafts and inactive ones)
 *   keyOf     parcel -> its source key (authority:project:parcel), carried to the register
 *   existing  optional (parcel, srid, key, standNo) -> true when the caller has dealt with it already (the importer: already imported)
 * Returns { toInsert, errors, warnings }.
 */
async function prepareParcels(client, parcels, { keyOf, zoneSrid, existing }) {
  const q = async (sql, params = []) => (await client.query(sql, params)).rows
  const toInsert = []; const errors = []; const warnings = []
  const stands = new Map()
  for (const p of parcels) {
    const standNo = String(p.stand || p.designation || '').trim()
    const key = keyOf(p)
    if (!standNo) { errors.push({ code: 'missing_stand_no', parcel: p.id }); continue }
    if (stands.has(standNo)) { errors.push({ code: 'duplicate_stand_no_in_project', stand: standNo, parcels: [stands.get(standNo), p.id] }); continue }
    stands.set(standNo, p.id)
    if (!p.geojson) { errors.push({ code: 'no_geometry', parcel: p.id, stand: standNo }); continue }
    const srid = p.lo_zone != null ? await zoneSrid(client, p.lo_zone) : null
    if (!srid) { errors.push({ code: 'unsupported_crs', parcel: p.id, stand: standNo, srid: p.srid, lo_zone: p.lo_zone }); continue }

    const g = (await q(
      `WITH x AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), $2::int) AS g)
       SELECT GeometryType(g) AS type, ST_IsValid(g) AS valid, ST_IsValidReason(g) AS reason, round(ST_Area(g)::numeric, 2) AS area FROM x`, [p.geojson, srid]))[0]
    if (!['POLYGON', 'MULTIPOLYGON'].includes(g.type)) { errors.push({ code: 'not_a_polygon', parcel: p.id, stand: standNo, type: g.type }); continue }
    if (!g.valid) { errors.push({ code: 'invalid_geometry', parcel: p.id, stand: standNo, reason: g.reason }); continue }

    if (existing && await existing(p, srid, key, standNo)) continue
    if (areasDisagree(p.area_m2, g.area)) warnings.push({ code: 'area_disagrees', parcel: p.id, stand: standNo, surveypro_m2: Number(p.area_m2), computed_m2: Number(g.area) })
    toInsert.push({ p, standNo, key, srid, area: g.area })
  }
  return { toInsert, errors, warnings }
}

/**
 * The layout against the register: a stand number already taken in the township, an overlap with an existing stand or plot (a farm does not
 * count: a township is carved out of one), and overlaps between the layout's own parcels. Parcels the layout itself put in the register earlier
 * (same source key) are not its own obstacles.
 */
async function registerProblems(client, toInsert, township) {
  const q = async (sql, params = []) => (await client.query(sql, params)).rows
  const errors = []
  if (township) {
    for (const t of toInsert) {
      const clash = (await q(`SELECT parcel_id FROM land.parcel WHERE township_code = $1 AND stand_no = $2 AND status = 'current' AND (source_relation IS DISTINCT FROM 'surveypro' OR source_key IS DISTINCT FROM $3)`, [township, t.standNo, t.key]))[0]
      if (clash) errors.push({ code: 'stand_no_exists', parcel: t.p.id, stand: t.standNo, parcel_id: clash.parcel_id })
    }
  }
  for (const t of toInsert) {
    const rows = await q(
      `WITH x AS (SELECT ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($1), $2::int), 4326) AS g)
       SELECT p.parcel_id, p.stand_no, ST_Area(ST_Intersection(p.geom_wgs84, x.g)::geography) AS overlap_m2
         FROM land.parcel p, x
        WHERE p.status = 'current' AND p.parcel_kind IN ('stand', 'plot') AND (p.source_relation IS DISTINCT FROM 'surveypro' OR p.source_key IS DISTINCT FROM $3)
          AND ST_Intersects(p.geom_wgs84, x.g) AND ST_Area(ST_Intersection(p.geom_wgs84, x.g)::geography) > $4`,
      [t.p.geojson, t.srid, t.key, OVERLAP_TOLERANCE_M2])
    for (const r of rows) errors.push({ code: 'overlaps_existing', parcel: t.p.id, stand: t.standNo, parcel_id: r.parcel_id, stand_no: r.stand_no, overlap_m2: Number(Number(r.overlap_m2).toFixed(2)) })
  }
  for (let i = 0; i < toInsert.length; i++) {
    for (let j = i + 1; j < toInsert.length; j++) {
      const r = (await q(
        `SELECT ST_Area(ST_Intersection(ST_SetSRID(ST_GeomFromGeoJSON($1), $3::int), ST_SetSRID(ST_GeomFromGeoJSON($2), $4::int))) AS m2
           WHERE ST_Intersects(ST_SetSRID(ST_GeomFromGeoJSON($1), $3::int), ST_SetSRID(ST_GeomFromGeoJSON($2), $4::int))`,
        [toInsert[i].p.geojson, toInsert[j].p.geojson, toInsert[i].srid, toInsert[j].srid]))[0]
      if (r && Number(r.m2) > OVERLAP_TOLERANCE_M2) errors.push({ code: 'overlap_within_project', stands: [toInsert[i].standNo, toInsert[j].standNo], overlap_m2: Number(Number(r.m2).toFixed(2)) })
    }
  }
  return errors
}

/**
 * The whole check for a layout that is not yet in the register: the eligible parcels, the problems with each, the problems with the layout as a
 * whole. Read-only. Returns { ok, errors, warnings, checked }.
 */
async function checkLayout(client, { township, parcels, keyOf }) {
  const zoneSrid = zoneSridResolver()
  const prepared = await prepareParcels(client, parcels, { keyOf, zoneSrid })
  const problems = await registerProblems(client, prepared.toInsert, township)
  const errors = [...prepared.errors, ...problems]
  return { ok: errors.length === 0, errors, warnings: prepared.warnings, checked: parcels.length }
}

module.exports = { OVERLAP_TOLERANCE_M2, AREA_TOLERANCE, areasDisagree, zoneSridResolver, prepareParcels, registerProblems, checkLayout }
