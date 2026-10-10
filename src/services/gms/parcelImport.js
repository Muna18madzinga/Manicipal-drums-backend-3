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
// the report has no errors, all in one transaction with the outbox events.
//
// RECONCILIATION (docs/HARMONIZATION-SCOPE.md, piece B). A township's stands may already be in the register as AUTHORITY-origin parcels, imported from
// the council's own survey (SurveyPro). The approved plan does not replace them: a matching stand is ADOPTED IN PLACE, so it keeps its parcel_id (ERP
// keys hang off it and parcel ids are never reused) and gains the approval. Per plan feature:
//   - no parcel with that stand number                           -> a NEW parcel
//   - an authority parcel with that stand number, boundary within ADOPT_TOLERANCE_M of the plan's -> ADOPT
//   - an authority parcel with that stand number, boundary further off -> an error (boundary_differs), both boundaries in the report
//   - a custodian parcel (already approved) with that stand number -> an error (stand_no_exists), as ever
//   - no stand-number match, but an authority PLOT (a council survey with no township) whose boundary agrees (IoU >= ADOPT_PLOT_IOU) -> ADOPT, and the
//     plot becomes a stand of this township; more than one candidate either way -> an error (ambiguous_match)
//   - no match, but overlapping an authority parcel of another number -> an error (overlaps_authority_parcel)
// Authority parcels the plan does not account for are listed as ORPHANS and left alone. Boundaries are compared in the survey CRS, so no datum shift
// enters the comparison. What an adopted parcel was is kept in land.parcel_event.
// ─────────────────────────────────────────────────────────────────────────

const { enqueue } = require('./outbox')

// Two parcels sharing an edge touch; anything overlapping by more than this is
// an overlap. Survey coordinates are to the centimetre.
const OVERLAP_TOLERANCE_M2 = 0.01

// A plan boundary "agrees" with the council's when no vertex is further than this (metres, Hausdorff distance in the survey CRS). To be confirmed with a
// surveyor / the Surveyor-General; the report always carries the measured deviation.
const ADOPT_TOLERANCE_M = 0.02
// A plot (no township, so no stand number to match on) is matched by boundary: area of intersection over area of union, at least this
const ADOPT_PLOT_IOU = 0.99
// an authority parcel and a plan stand of another number overlapping by more than this (m2) is a numbering conflict, not a shared edge
const AUTHORITY_OVERLAP_M2 = 0.05

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
    // --- parcels already in the register for these stands: refuse, adopt, or report a conflict --------------------------------------------
    const validPoly = `i.g IS NOT NULL AND GeometryType(i.g) IN ('POLYGON', 'MULTIPOLYGON') AND ST_IsValid(i.g)`
    const adopt = []                       // { idx, parcel_id, matched_by, deviation_m }
    const claimed = new Set()              // feature indexes decided below (adopted, refused or in conflict)
    for (const r of await q(`
      SELECT i.idx, i.stand_no, p.parcel_id, p.origin, p.sg_ref,
             CASE WHEN ${validPoly}
                  THEN ST_HausdorffDistance(ST_Boundary(ST_Transform(i.g, p.source_srid)), ST_Boundary(p.geom_source), 0.25) END AS deviation_m,
             CASE WHEN ${validPoly} THEN ST_AsGeoJSON(ST_Transform(i.g, 4326), 7)::json END AS plan_geometry,
             ST_AsGeoJSON(p.geom_wgs84, 7)::json AS register_geometry
        FROM gp_in i
        JOIN land.parcel p ON p.township_code = $1 AND p.stand_no = i.stand_no AND p.status = 'current'`,
    [township_code])) {
      claimed.add(r.idx)
      if (r.origin !== 'authority' || r.sg_ref) {
        errors.push({ code: 'stand_no_exists', feature: r.idx, stand_no: r.stand_no, parcel_id: r.parcel_id })
      } else if (r.deviation_m === null) {
        // the plan's own geometry is already reported as invalid; nothing to compare
      } else if (Number(r.deviation_m) <= ADOPT_TOLERANCE_M) {
        adopt.push({ idx: r.idx, parcel_id: r.parcel_id, matched_by: 'stand_no', deviation_m: Number(r.deviation_m) })
      } else {
        errors.push({ code: 'boundary_differs', feature: r.idx, stand_no: r.stand_no, parcel_id: r.parcel_id, deviation_m: Number(r.deviation_m),
          tolerance_m: ADOPT_TOLERANCE_M, plan_geometry: r.plan_geometry, register_geometry: r.register_geometry })
      }
    }
    // plots: no township, so matched by boundary alone
    const planGeometryOk = !errors.some((e) => e.code === 'invalid_geometry' || e.code === 'not_a_polygon')   // GEOS throws on invalid input
    const plotRows = !planGeometryOk ? [] : await q(`
      SELECT i.idx, i.stand_no, p.parcel_id, x.iou, x.deviation_m
        FROM gp_in i
        JOIN land.parcel p ON p.origin = 'authority' AND p.status = 'current' AND p.parcel_kind = 'plot' AND p.township_code IS NULL AND p.sg_ref IS NULL
                          AND p.geom_wgs84 && ST_Transform(i.g, 4326)
        CROSS JOIN LATERAL (
          SELECT ST_Area(ST_Intersection(ST_Transform(i.g, p.source_srid), p.geom_source))
                   / NULLIF(ST_Area(ST_Union(ST_Transform(i.g, p.source_srid), p.geom_source)), 0) AS iou,
                 ST_HausdorffDistance(ST_Boundary(ST_Transform(i.g, p.source_srid)), ST_Boundary(p.geom_source), 0.25) AS deviation_m) x
       WHERE ${validPoly} AND i.idx <> ALL($1::int[]) AND x.iou >= $2`, [[...claimed], ADOPT_PLOT_IOU])
    const byFeature = new Map(); const byPlot = new Map()
    for (const r of plotRows) {
      byFeature.set(r.idx, [...(byFeature.get(r.idx) || []), r]); byPlot.set(r.parcel_id, [...(byPlot.get(r.parcel_id) || []), r])
    }
    for (const [idx, list] of byFeature) {
      claimed.add(idx)
      const r = list[0]
      if (list.length > 1 || byPlot.get(r.parcel_id).length > 1) {
        errors.push({ code: 'ambiguous_match', feature: idx, stand_no: r.stand_no, parcel_ids: [...new Set(list.map((x) => x.parcel_id))],
          note: 'more than one plot matches this stand, or this plot matches more than one stand' })
      } else {
        adopt.push({ idx, parcel_id: r.parcel_id, matched_by: 'geometry', deviation_m: Number(r.deviation_m), iou: Number(r.iou) })
      }
    }
    // a stand that matched nothing but sits on an authority parcel of another number: a numbering conflict, never two parcels on one piece of ground
    const adoptedIds = adopt.map((a) => a.parcel_id)
    for (const r of !planGeometryOk ? [] : await q(`
      SELECT i.idx, i.stand_no, p.parcel_id, p.stand_no AS parcel_stand_no, x.overlap_m2
        FROM gp_in i
        JOIN land.parcel p ON p.origin = 'authority' AND p.status = 'current' AND p.parcel_kind IN ('stand', 'plot')
                          AND p.geom_wgs84 && ST_Transform(i.g, 4326) AND p.parcel_id <> ALL($2::text[])
        CROSS JOIN LATERAL (SELECT ST_Area(ST_Intersection(ST_Transform(i.g, p.source_srid), p.geom_source)) AS overlap_m2) x
       WHERE ${validPoly} AND i.idx <> ALL($1::int[]) AND x.overlap_m2 > $3`, [[...claimed], adoptedIds, AUTHORITY_OVERLAP_M2])) {
      claimed.add(r.idx)
      errors.push({ code: 'overlaps_authority_parcel', feature: r.idx, stand_no: r.stand_no, parcel_id: r.parcel_id, parcel_stand_no: r.parcel_stand_no, overlap_m2: Number(r.overlap_m2) })
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

    // authority parcels this plan does not account for: reported, never touched
    const conflicted = new Set(errors.filter((e) => e.parcel_id).map((e) => e.parcel_id))
    const orphans = (await q(`
      SELECT p.parcel_id, p.stand_no, p.parcel_kind, p.township_code
        FROM land.parcel p
       WHERE p.origin = 'authority' AND p.status = 'current' AND p.parcel_kind IN ('stand', 'plot') AND p.sg_ref IS NULL
         AND p.parcel_id <> ALL($2::text[])
         AND (p.township_code = $1
              OR (p.township_code IS NULL AND EXISTS (
                    SELECT 1 FROM gp_in i WHERE i.g IS NOT NULL AND p.geom_wgs84 && ST_Transform(i.g, 4326) AND ST_Intersects(p.geom_wgs84, ST_Transform(i.g, 4326)))))
       ORDER BY p.stand_no`, [township_code, [...adoptedIds, ...conflicted]]))

    const report = {
      source_crs: crs.code,
      feature_count: rows.length,
      transform_method: crs.transform_method,
      transform_accuracy_m: Number(crs.accuracy_m),
      summary: {
        new: rows.length - claimed.size,
        adopt: adopt.length,
        conflicts: errors.filter((e) => ['boundary_differs', 'ambiguous_match', 'overlaps_authority_parcel'].includes(e.code)).length,
        orphans: orphans.length,
      },
      adopt,
      orphans,
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

    // adopt in place: keep what the parcel was, then give it the approved plan (the guard lets a boundary change under a survey import)
    await client.query("SELECT set_config('gms.survey_import', 'on', true)")
    for (const a of adopt) {
      const before = (await q('SELECT origin, stand_no, township_code, parcel_kind, source_srid, area_m2, accuracy_basis, sg_ref, source, custodian_dept, geom_source FROM land.parcel WHERE parcel_id = $1', [a.parcel_id]))[0]
      const { geom_source: oldGeom, ...details } = before
      await q(`INSERT INTO land.parcel_event (parcel_id, event, general_plan_id, performed_by, details, previous_geom, previous_srid)
               VALUES ($1, 'adopted', $2, $3, $4::jsonb, $5, $6)`,
        [a.parcel_id, gp.import_id, user?.id ?? null, JSON.stringify({ ...details, matched_by: a.matched_by, deviation_m: a.deviation_m, iou: a.iou ?? null }), oldGeom, before.source_srid])
      await q(`
        UPDATE land.parcel p
           SET stand_no = i.stand_no, township_code = $2, parcel_kind = 'stand', source_srid = $3, geom_source = i.g,
               geom_wgs84 = ST_Multi(ST_Transform(i.g, 4326)), transform_method = $4, transform_accuracy_m = $5,
               area_m2 = round(ST_Area(i.g)::numeric, 2), sg_ref = $6, general_plan_id = $7, origin = 'custodian',
               accuracy_basis = 'general_plan', source = 'Survey Section approved general plan ' || $6, custodian_dept = 'Survey Section',
               ward_code = COALESCE(p.ward_code, i.ward_code)
          FROM gp_in i WHERE i.idx = $8 AND p.parcel_id = $1`,
        [a.parcel_id, township_code, source_srid, crs.transform_method, crs.accuracy_m, sg_ref, gp.import_id, a.idx])
    }

    const created = await q(`
      INSERT INTO land.parcel
        (stand_no, township_code, ward_code, geom_source, source_srid, geom_wgs84,
         transform_method, transform_accuracy_m, area_m2, sg_ref, general_plan_id,
         accuracy_class, accuracy_basis, source, created_by)
      SELECT i.stand_no, $1,
             COALESCE(i.ward_code, (
               SELECT w.ward_code FROM admin.ward w
                WHERE ST_Intersects(w.geom, ST_PointOnSurface(ST_Transform(i.g, 4326))) LIMIT 1)),
             i.g, $2, ST_Multi(ST_Transform(i.g, 4326)),
             $3, $4, round(ST_Area(i.g)::numeric, 2), $5, $6,
             'A', 'general_plan', 'Survey Section approved general plan ' || $5, $7
        FROM gp_in i WHERE i.idx <> ALL($8::int[]) ORDER BY i.idx
      RETURNING parcel_id, stand_no, area_m2, ward_code, sg_ref`,
    [township_code, source_srid, crs.transform_method, crs.accuracy_m, sg_ref, gp.import_id, user?.id ?? null, adopt.map((a) => a.idx)])

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

    // the parcels adopted were already in the register: tell the ERP link they are now approved (same parcel, same id)
    for (const a of adopt) {
      const p = (await q('SELECT parcel_id, stand_no, area_m2, ward_code, sg_ref FROM land.parcel WHERE parcel_id = $1', [a.parcel_id]))[0]
      await enqueue(client, 'ParcelApproved', {
        parcel_id: p.parcel_id, stand_no: p.stand_no, area_m2: Number(p.area_m2), ward_code: p.ward_code, sg_ref: p.sg_ref, matched_by: a.matched_by,
      }, `ParcelApproved:${p.parcel_id}:${p.sg_ref}`)
    }

    await client.query('COMMIT')
    return {
      ok: true,
      committed: true,
      report,
      import_id: gp.import_id,
      parcel_ids: created.map((p) => p.parcel_id),
      adopted_ids: adopt.map((a) => a.parcel_id),
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

module.exports = { importGeneralPlan, OVERLAP_TOLERANCE_M2, ADOPT_TOLERANCE_M, ADOPT_PLOT_IOU }
