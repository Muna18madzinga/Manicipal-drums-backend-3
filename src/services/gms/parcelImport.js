// src/services/gms/parcelImport.js
// ─────────────────────────────────────────────────────────────────────────
// Import of an approved general plan or diagram from the Survey Section: the
// only way a parcel boundary enters the register (business rule 1).
//
// Input is GeoJSON features whose coordinates are in the survey CRS as
// supplied (a Lo belt, POINT(Y X)). The geometry is stored untouched; a WGS84
// copy is derived and stamped with the transformation used.
//
// Always produces the validation report. Writes only when commit is true AND
// the report has no errors, all in one transaction with the ParcelCreated
// outbox events.
// ─────────────────────────────────────────────────────────────────────────

const { enqueue } = require('./outbox')

// Two parcels sharing an edge touch; anything overlapping by more than this is
// an overlap. Survey coordinates are to the centimetre.
const OVERLAP_TOLERANCE_M2 = 0.01

async function importGeneralPlan(pg, input, user) {
  const { sg_ref, township_code, source_srid, features, commit } = input
  const errors = []
  if (!sg_ref) errors.push({ code: 'missing_sg_ref' })
  if (!township_code) errors.push({ code: 'missing_township_code' })
  if (!Array.isArray(features) || features.length === 0) errors.push({ code: 'no_features' })
  if (errors.length) return { ok: false, committed: false, errors }

  const client = await pg.connect()
  try {
    await client.query('BEGIN')

    const crs = (await client.query(
      'SELECT * FROM gis_ops.crs_registry WHERE srid = $1', [source_srid],
    )).rows[0]
    if (!crs || !crs.is_survey) {
      await client.query('ROLLBACK')
      return { ok: false, committed: false, errors: [{ code: 'not_a_survey_crs', source_srid }] }
    }

    const rows = features.map((f, i) => ({
      idx: i,
      stand_no: f?.properties?.stand_no != null ? String(f.properties.stand_no).trim() : null,
      ward_code: f?.properties?.ward_code ?? null,
      geometry: f?.geometry ? JSON.stringify(f.geometry) : null,
    }))

    await client.query(`
      CREATE TEMP TABLE gp_in ON COMMIT DROP AS
      SELECT r.idx, r.stand_no, r.ward_code,
             CASE WHEN r.geometry IS NOT NULL
                  THEN ST_SetSRID(ST_GeomFromGeoJSON(r.geometry), $2) END AS g
        FROM jsonb_to_recordset($1::jsonb) AS r(idx int, stand_no text, ward_code text, geometry text)`,
    [JSON.stringify(rows), source_srid])

    const q = async (sql, params = []) => (await client.query(sql, params)).rows

    for (const r of await q(`SELECT idx FROM gp_in WHERE stand_no IS NULL OR stand_no = ''`)) {
      errors.push({ code: 'missing_stand_no', feature: r.idx })
    }
    for (const r of await q(`
      SELECT idx FROM gp_in
       WHERE g IS NULL OR GeometryType(g) NOT IN ('POLYGON', 'MULTIPOLYGON')`)) {
      errors.push({ code: 'not_a_polygon', feature: r.idx })
    }
    for (const r of await q(`
      SELECT idx, ST_IsValidReason(g) AS reason FROM gp_in
       WHERE g IS NOT NULL AND GeometryType(g) IN ('POLYGON', 'MULTIPOLYGON') AND NOT ST_IsValid(g)`)) {
      errors.push({ code: 'invalid_geometry', feature: r.idx, reason: r.reason })
    }
    for (const r of await q(`
      SELECT stand_no, array_agg(idx ORDER BY idx) AS features FROM gp_in
       WHERE stand_no IS NOT NULL GROUP BY stand_no HAVING count(*) > 1`)) {
      errors.push({ code: 'duplicate_stand_no_in_plan', stand_no: r.stand_no, features: r.features })
    }
    for (const r of await q(`
      SELECT i.idx, i.stand_no, p.parcel_id FROM gp_in i
        JOIN land.parcel p ON p.township_code = $1 AND p.stand_no = i.stand_no AND p.status = 'current'`,
    [township_code])) {
      errors.push({ code: 'stand_no_exists', feature: r.idx, stand_no: r.stand_no, parcel_id: r.parcel_id })
    }
    // Topology: parcels in a layout may not overlap. Only meaningful (and only
    // safe for GEOS) once every geometry is a valid polygon.
    const geometryOk = !errors.some((e) => e.code === 'invalid_geometry' || e.code === 'not_a_polygon')
    if (geometryOk) {
      for (const r of await q(`
        SELECT a.stand_no AS a, b.stand_no AS b, ST_Area(x) AS overlap_m2,
               ST_AsGeoJSON(ST_Transform(x, 4326), 7)::json AS geometry
          FROM gp_in a
          JOIN gp_in b ON a.idx < b.idx AND ST_Intersects(a.g, b.g)
          CROSS JOIN LATERAL ST_Intersection(a.g, b.g) AS x
         WHERE ST_Area(x) > $1`, [OVERLAP_TOLERANCE_M2])) {
        // geometry (WGS84) lets the UI highlight the overlap on the map.
        errors.push({ code: 'overlap', stand_nos: [r.a, r.b], overlap_m2: Number(r.overlap_m2), geometry: r.geometry })
      }
    }
    // ponytail: gap check (slivers between parcels) not done; the Survey
    // Section's approved plan is closed by construction. Add when importing
    // unapproved layouts.

    const report = {
      source_crs: crs.code,
      feature_count: rows.length,
      transform_method: crs.transform_method,
      transform_accuracy_m: Number(crs.accuracy_m),
      errors,
    }

    if (!commit || errors.length) {
      await client.query('ROLLBACK')
      return { ok: errors.length === 0, committed: false, report }
    }

    const gp = (await client.query(
      `INSERT INTO land.general_plan (sg_ref, township_code, source_srid, feature_count, imported_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING import_id`,
      [sg_ref, township_code, source_srid, rows.length, user?.id ?? null],
    )).rows[0]

    const created = await q(`
      INSERT INTO land.parcel
        (stand_no, township_code, ward_code, geom_source, source_srid, geom_wgs84,
         transform_method, transform_accuracy_m, area_m2, sg_ref, general_plan_id,
         accuracy_class, source, created_by)
      SELECT i.stand_no, $1,
             COALESCE(i.ward_code, (
               SELECT w.ward_code FROM admin.ward w
                WHERE ST_Intersects(w.geom, ST_PointOnSurface(ST_Transform(i.g, 4326))) LIMIT 1)),
             i.g, $2, ST_Multi(ST_Transform(i.g, 4326)),
             $3, $4, round(ST_Area(i.g)::numeric, 2), $5, $6,
             'A', 'Survey Section approved general plan ' || $5, $7
        FROM gp_in i ORDER BY i.idx
      RETURNING parcel_id, stand_no, area_m2, ward_code, sg_ref`,
    [township_code, source_srid, crs.transform_method, crs.accuracy_m, sg_ref, gp.import_id, user?.id ?? null])

    for (const p of created) {
      await enqueue(client, 'ParcelCreated', {
        parcel_id: p.parcel_id,
        stand_no: p.stand_no,
        area_m2: Number(p.area_m2),
        ward_code: p.ward_code,
        zoning: null, // arrives with the Planning zoning layer
        sg_ref: p.sg_ref,
      }, `ParcelCreated:${p.parcel_id}`)
    }

    await client.query('COMMIT')
    return {
      ok: true,
      committed: true,
      report,
      import_id: gp.import_id,
      parcel_ids: created.map((p) => p.parcel_id),
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

module.exports = { importGeneralPlan, OVERLAP_TOLERANCE_M2 }
