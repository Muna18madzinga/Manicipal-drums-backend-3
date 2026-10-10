/**
 * Reading a council's survey work back from SurveyPro (docs/SURVEYPRO-INTEGRATION.md).
 *
 * SurveyPro hosts the survey work and shares it with the council through read-only views (survey_share.*) on a login that is tied to
 * that one council. This service reads those views and does two things in VunGIS:
 *
 *   1. STATUS. A job's progress follows its project: delivered -> the job is "submitted"; a reviewer's decision (accepted, returned,
 *      rejected) -> "accepted" or "returned". It only moves a job forward, never out of "accepted" or "cancelled".
 *   2. PARCELS. When a project has been ACCEPTED by the council's reviewer, its finalized parcels enter the register (land.parcel)
 *      as authority-origin parcels, awaiting the Surveyor-General: not as if the Surveyor-General had approved them (no sg_ref).
 *
 * Everything that matters about a boundary is decided here, not by SurveyPro:
 *   - COORDINATES. SurveyPro stores Cape / Lo with the westing as the X ordinate and the southing as the Y ordinate, tagged with the
 *     EPSG code (2228x). VunGIS transforms survey coordinates with its own registry (gis_ops.crs_registry, SRIDs 9220xx), whose
 *     Cape -> WGS 84 transformation is the one the Surveyor-General platform confirms. The geometry is therefore RE-TAGGED with the
 *     registry's SRID for the same Lo zone (the numbers do not change: same projection, same axes) before it is transformed, so
 *     every parcel in the register is transformed the same way and carries the method and accuracy that were used.
 *   - SURVEY CLASS. land.parcel.survey_class is the SI 727 class the survey was done to, as the surveyor declared it on the project in
 *     SurveyPro. It is carried, never guessed and never used to say how far the record has got: a project with no declared class, or one
 *     SI 727 has no limits for, is refused with a reason (SurveyPro's own warning: a wrong class silently changes every verdict).
 *   - AREA is computed from the geometry (ST_Area in the Lo belt); SurveyPro's figure is compared and a disagreement reported.
 *   - A parcel already imported is never updated. If SurveyPro's boundary has since changed it is reported as "diverged": a changed
 *     boundary needs a new acceptance, not a silent overwrite (land.parcel_guard enforces the same below the application).
 *   - New parcels are refused, and the whole project with them, if any is not a valid polygon, is in a Lo zone the registry does not
 *     know, repeats a stand number, takes a stand number already in the township, or overlaps an existing stand or plot. A farm does
 *     not count: a township is carved out of one.
 *
 * Dry run and apply share one code path: the same work inside a transaction that is rolled back instead of committed, so a dry run
 * can never promise something apply then does differently.
 */
const { enqueue } = require('./gms/outbox')
const { OVERLAP_TOLERANCE_M2, areasDisagree, prepareParcels, registerProblems } = require('./layoutCheck')

const IDENT = /^[a-z_][a-z0-9_]*$/i

// SI 727 (the Land Survey (General) Regulations, 1979, Second Schedule para 1) has three survey classes, by the KIND of survey: A determines the
// position of town survey-marks, B is surveys in townships, C is every other survey. There is no D. A class is a property of the SURVEY (it
// sets the limits of error it was held to), never of the record's state: whether the council has accepted it, or the Surveyor-General has
// approved it, is shown by origin, sg_ref and status. A parcel survey is class B or C; class A is work on town survey-marks, not on parcels.
const SURVEY_CLASSES = ['B', 'C']

// ── decisions that need no database ─────────────────────────────────────────────────────────────────────────────────────────────

/** What the job's status should become, from a SurveyPro project; null if the project says nothing new. */
function statusFromProject(project) {
  const delivered = project.delivered_at ? new Date(project.delivered_at).getTime() : null
  const decided = project.reviewed_at ? new Date(project.reviewed_at).getTime() : null
  // a decision counts unless the surveyor delivered again afterwards (a returned job comes back as a new delivery)
  if (decided != null && (delivered == null || decided >= delivered)) {
    return { accepted: 'accepted', returned: 'returned', rejected: 'returned' }[project.review_decision] || null
  }
  return delivered != null ? 'submitted' : null
}

/** May a job move from `from` to `to`? Forward only; never out of accepted or cancelled. */
function mayMove(from, to) {
  if (from === to || !to) return false
  if (from === 'accepted' || from === 'cancelled') return false
  return ['assigned', 'in_progress', 'submitted', 'returned'].includes(from)
}

/** Has the council accepted the project as it now stands? */
const isAccepted = (project) => statusFromProject(project) === 'accepted'

const sourceKey = (project, parcel) => `${project.authority_code}:${project.id}:${parcel.id}`

// ── reading SurveyPro ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The council's projects and, for those, their parcels, as the share views present them. */
async function readSurveyPro(source, { schema = 'survey_share' } = {}) {
  if (!IDENT.test(schema)) throw new Error('bad schema name')
  const projects = (await source.query(
    `SELECT id, authority_code, name, township, designation, survey_type, survey_class, external_job_id, delivered_at, review_decision, reviewed_at, review_note
       FROM ${schema}.projects ORDER BY id`)).rows
  const ids = projects.map((p) => p.id)
  const parcels = ids.length ? (await source.query(
    `SELECT id, project_id, stand, designation, owner, title_deed, survey_date, area_m2, status, parcel_status, srid, lo_zone, axis_order,
            ST_AsGeoJSON(geom, 9) AS geojson
       FROM ${schema}.parcels WHERE project_id = ANY($1::int[]) ORDER BY project_id, id`, [ids])).rows : []
  return { projects, parcels }
}

// ── one project, in one transaction ──────────────────────────────────────────────────────────────────────────────────────────────

async function importProject(client, project, parcels, { zoneSrid }) {
  const out = { project: project.id, name: project.name, authority: project.authority_code, job: project.external_job_id, status: null, parcels: { imported: [], unchanged: [], diverged: [], skipped: [], errors: [], warnings: [] } }
  const q = async (sql, params = []) => (await client.query(sql, params)).rows

  const authority = (await q('SELECT id FROM public.local_authorities WHERE code = $1', [project.authority_code]))[0]
  if (!authority) { out.parcels.errors.push({ code: 'unknown_authority', authority: project.authority_code }); return out }

  // ---- the job's status ------------------------------------------------------------------------------------------------------
  let task = null
  if (project.external_job_id) {
    task = (await q('SELECT id, status, authority_id FROM spatial_planning.survey_task WHERE id = $1 FOR UPDATE', [project.external_job_id]))[0] || null
    if (task && task.authority_id !== authority.id) { out.status = { job: task.id, error: 'job_belongs_to_another_authority' }; task = null }
  }
  if (task) {
    const to = statusFromProject(project)
    out.status = { job: task.id, from: task.status, to: mayMove(task.status, to) ? to : null }
    if (out.status.to) await q('UPDATE spatial_planning.survey_task SET status = $2, updated_at = NOW() WHERE id = $1', [task.id, out.status.to])
  } else if (project.external_job_id && !out.status) {
    out.status = { job: project.external_job_id, error: 'no_such_job' }
  }

  // ---- the parcels, only once the council has accepted the project --------------------------------------------------------------
  if (!isAccepted(project)) return out
  const candidates = parcels.filter((p) => p.project_id === project.id)
  const eligible = candidates.filter((p) => ['finalized', 'approved'].includes(p.status) && p.parcel_status === 'active')
  for (const p of candidates) if (!eligible.includes(p)) out.parcels.skipped.push({ parcel: p.id, stand: p.stand, reason: p.parcel_status !== 'active' ? 'not_active' : 'not_finalized', status: p.status })

  const township = project.township ? String(project.township).trim() : ''
  // each parcel on its own (shared with the layout check, src/services/layoutCheck.js); what is already in the register is decided here
  const prepared = await prepareParcels(client, eligible, {
    keyOf: (p) => sourceKey(project, p), zoneSrid,
    existing: async (p, srid, key, standNo) => {
      const existing = (await q('SELECT parcel_id, sg_ref, ST_OrderingEquals(geom_source, ST_SetSRID(ST_GeomFromGeoJSON($2), $3::int)) AS same FROM land.parcel WHERE source_relation = $4 AND source_key = $1',
        [key, p.geojson, srid, 'surveypro']))[0]
      if (!existing) return false
      // once the Surveyor-General has approved the parcel (adopted in place by the plan import) its boundary is the approved one: that the council's
      // survey differs from it is no longer news about SurveyPro, so it is not reported as diverged
      if (existing.sg_ref) out.parcels.unchanged.push({ parcel: p.id, stand: standNo, parcel_id: existing.parcel_id, approved: existing.sg_ref })
      else if (existing.same) out.parcels.unchanged.push({ parcel: p.id, stand: standNo, parcel_id: existing.parcel_id })
      else out.parcels.diverged.push({ parcel: p.id, stand: standNo, parcel_id: existing.parcel_id, note: 'the boundary in SurveyPro differs from the one already in the register; a changed boundary needs a new acceptance, so nothing was changed' })
      return true
    },
  })
  const toInsert = prepared.toInsert
  out.parcels.errors.push(...prepared.errors)
  out.parcels.warnings.push(...prepared.warnings)

  // the survey class the parcels were surveyed to: declared by the surveyor, never guessed
  const surveyClass = project.survey_class ? String(project.survey_class).trim().toUpperCase() : null
  out.survey_class = surveyClass
  if (toInsert.length && !SURVEY_CLASSES.includes(surveyClass)) {
    out.parcels.errors.push(surveyClass
      ? { code: 'unknown_survey_class', survey_class: project.survey_class, note: surveyClass === 'A'
          ? 'SI 727 class A is surveys to determine the position of town survey-marks; a parcel survey is class B (township) or C (other)'
          : 'SI 727 has survey classes A, B and C only; a parcel survey is class B (township) or C (other)' }
      : { code: 'no_survey_class', note: 'the surveyor must declare the SI 727 survey class (B or C) on the project in SurveyPro' })
  }
  // class B is "surveys in townships", C "not included in class A or B": a mismatch is reported, not refused (whether a place is a township
  // is a legal question the project's township field only approximates)
  if (toInsert.length && SURVEY_CLASSES.includes(surveyClass)) {
    const expected = township ? 'B' : 'C'
    if (surveyClass !== expected) out.parcels.warnings.push({ code: 'class_vs_township', survey_class: surveyClass, expected, note: township ? 'the project names a township, which SI 727 treats as class B' : 'the project names no township, which SI 727 treats as class C' })
  }

  // ---- problems that make a layout unsafe to enter (shared with the layout check) ----------------------------------------------------
  out.parcels.errors.push(...await registerProblems(client, toInsert, township))
  if (out.parcels.errors.length) return out          // all or nothing for the layout

  // ---- enter them -----------------------------------------------------------------------------------------------------------------
  for (const t of toInsert) {
    const crs = (await q('SELECT transform_method, accuracy_m FROM gis_ops.crs_registry WHERE srid = $1', [t.srid]))[0]
    const row = (await q(
      `WITH x AS (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), $2::int) AS g)
       INSERT INTO land.parcel
         (stand_no, township_code, ward_code, geom_source, source_srid, geom_wgs84, transform_method, transform_accuracy_m, area_m2,
          survey_class, accuracy_basis, source, custodian_dept, parcel_kind, cadastre_ref, authority_id, origin, source_relation, source_key)
       SELECT $3, $4,
              (SELECT w.ward_code FROM admin.ward w WHERE (w.valid_to IS NULL OR w.valid_to >= CURRENT_DATE)
                  AND ST_Intersects(w.geom, ST_PointOnSurface(ST_Transform(x.g, 4326))) ORDER BY w.ward_code LIMIT 1),
              x.g, $2::int, ST_Multi(ST_Transform(x.g, 4326)), $5, $6, round(ST_Area(x.g)::numeric, 2),
              $13, 'surveyed', $7, $8, $9, $10, $11, 'authority', 'surveypro', $12
         FROM x
       RETURNING parcel_id, stand_no, area_m2, ward_code`,
      [t.p.geojson, t.srid, t.standNo, township || null, crs.transform_method, crs.accuracy_m,
       `SurveyPro: ${project.authority_code} project ${project.id} "${project.name}", accepted by the council's reviewer`,
       'Local authority survey (SurveyPro), awaiting the Surveyor-General', township ? 'stand' : 'plot',
       String(project.designation || t.standNo), authority.id, t.key, surveyClass]))[0]
    await enqueue(client, 'ParcelCreated', { parcel_id: row.parcel_id, stand_no: row.stand_no, area_m2: Number(row.area_m2), ward_code: row.ward_code, zoning: null, sg_ref: null }, `ParcelCreated:${row.parcel_id}`)
    out.parcels.imported.push({ parcel: t.p.id, stand: t.standNo, parcel_id: row.parcel_id, area_m2: Number(row.area_m2) })
  }
  return out
}

// ── the whole run ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Read the council's work from SurveyPro and bring it into VunGIS.
 *   pg       the VunGIS pool (the system plane: land.parcel is national data and the application role may not write it)
 *   source   a pool on SurveyPro, connected as the council's reader login
 *   apply    false (the default) does everything and rolls back
 * Returns a report; never throws for a problem with one project, only for a problem reaching a database.
 */
async function runImport(pg, source, { apply = false, schema = 'survey_share' } = {}) {
  const { projects, parcels } = await readSurveyPro(source, { schema })
  const cache = new Map()
  const zoneSrid = async (client, zone) => {
    if (!cache.has(zone)) cache.set(zone, ((await client.query(`SELECT srid FROM gis_ops.crs_registry WHERE code = 'Lo' || $1::text AND is_survey`, [zone])).rows[0] || {}).srid || null)
    return cache.get(zone)
  }
  const report = { applied: !!apply, read: { projects: projects.length, parcels: parcels.length }, projects: [], totals: { statuses: 0, imported: 0, unchanged: 0, diverged: 0, errors: 0, warnings: 0 } }
  for (const project of projects) {
    const client = await pg.connect()
    try {
      await client.query('BEGIN')
      const r = await importProject(client, project, parcels, { zoneSrid })
      await client.query(apply ? 'COMMIT' : 'ROLLBACK')
      report.projects.push(r)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      report.projects.push({ project: project.id, name: project.name, authority: project.authority_code, failed: err.message })
      report.totals.errors++
    } finally { client.release() }
  }
  for (const r of report.projects) {
    if (r.status && r.status.to) report.totals.statuses++
    if (r.parcels) {
      report.totals.imported += r.parcels.imported.length; report.totals.unchanged += r.parcels.unchanged.length
      report.totals.diverged += r.parcels.diverged.length; report.totals.errors += r.parcels.errors.length; report.totals.warnings += r.parcels.warnings.length
    }
  }
  return report
}

module.exports = { runImport, readSurveyPro, SURVEY_CLASSES, statusFromProject, mayMove, isAccepted, areasDisagree, sourceKey, OVERLAP_TOLERANCE_M2 }
