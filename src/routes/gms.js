// src/routes/gms.js
// ─────────────────────────────────────────────────────────────────────────
// GIS Management System — parcel register (phase 1).
//
//   GET   /parcels                        viewInternal   ?stand_no&township&account&ward&q
//   GET   /parcels/:parcel_id             viewInternal   parcel profile
//   PATCH /gms/parcels/:parcel_id         editLayers     attributes only, never the boundary
//   GET   /wards/:ward_code/summary       viewInternal
//   POST  /gms/imports/general-plan       importSurvey   validation report; commit:true writes
//   GET   /gms/public/parcels/:parcel_id  anyone         public identify, no personal data
//   GET   /gms/key-registry               viewInternal
//   GET   /gms/dashboard                  viewInternal
//
// Tables: land.*, revenue_link.*, integration.* (migration 132).
// Role lists: src/services/gms/roles.js.
// ─────────────────────────────────────────────────────────────────────────

const { requireRole } = require('../middleware/jwtAuth')
const { GMS, SURVEY_ATTR_EDITORS } = require('../services/gms/roles')
const { importGeneralPlan } = require('../services/gms/parcelImport')

const tags = ['GMS']

// The ERP is the system of record for money: the GMS shows a band and links
// out. ERP_ACCOUNT_URL e.g. https://erp.council.local/accounts/{account}
const erpUrl = (account) => (process.env.ERP_ACCOUNT_URL
  ? process.env.ERP_ACCOUNT_URL.replace('{account}', encodeURIComponent(account))
  : null)

/** Worst band across a parcel's accounts, or no_account. */
function bandOf(bands) {
  const live = bands.filter(Boolean)
  if (!live.length) return 'no_account'
  return live.includes('in_arrears') ? 'in_arrears' : 'current'
}

const GEOMETRY_KEYS = ['geometry', 'geom', 'geom_source', 'geom_wgs84', 'coordinates', 'boundary']
const SURVEY_ATTRS = ['sg_ref', 'ward_code']

async function gmsRoutes(fastify) {
  const pg = fastify.pg
  const view = { preHandler: requireRole(fastify, GMS.viewInternal) }

  fastify.get('/parcels', { ...view, schema: { tags, summary: 'Find parcels by stand, township, ERP account or ward' } }, async (request) => {
    const { stand_no, township, account, ward, q } = request.query || {}
    const limit = Math.min(Number(request.query?.limit) || 50, 500)
    const where = []
    const args = []
    // `?` in sql becomes this value's placeholder (every occurrence).
    const add = (sql, v) => { args.push(v); where.push(sql.replaceAll('?', `$${args.length}`)) }
    if (stand_no) add('p.stand_no = ?', String(stand_no))
    if (township) add('p.township_code = ?', String(township))
    if (ward) add('p.ward_code = ?', String(ward))
    if (account) add('EXISTS (SELECT 1 FROM revenue_link.account_link a WHERE a.parcel_id = p.parcel_id AND a.erp_account_no = ?)', String(account))
    if (q) add('(p.parcel_id ILIKE ? OR p.stand_no ILIKE ? OR p.sg_ref ILIKE ?)', `%${q}%`)
    args.push(limit)
    const { rows } = await pg.query(
      `SELECT p.parcel_id, p.stand_no, p.township_code, p.ward_code, p.area_m2, p.accuracy_class,
              p.status, p.allocation_status, p.sg_ref,
              array_remove(array_agg(DISTINCT s.status_band), NULL) AS bands,
              count(DISTINCT a.erp_account_no)::int AS accounts
         FROM land.parcel p
         LEFT JOIN revenue_link.account_link a ON a.parcel_id = p.parcel_id
         LEFT JOIN revenue_link.billing_status s ON s.erp_account_no = a.erp_account_no
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        GROUP BY p.parcel_id
        ORDER BY p.township_code, p.stand_no
        LIMIT $${args.length}`,
      args,
    )
    return {
      success: true,
      data: rows.map(({ bands, ...r }) => ({
        ...r, area_m2: Number(r.area_m2), status_band: r.accounts ? bandOf(bands) : 'no_account',
      })),
    }
  })

  fastify.get('/parcels/:parcel_id', { ...view, schema: { tags, summary: 'Parcel profile' } }, async (request, reply) => {
    const id = String(request.params.parcel_id)
    const { rows: [p] } = await pg.query(
      `SELECT p.parcel_id, p.stand_no, p.township_code, p.ward_code, w.name AS ward_name,
              p.area_m2, round(p.area_m2 / 10000, 4) AS area_ha, p.sg_ref, p.accuracy_class,
              p.source, p.custodian_dept, p.status, p.allocation_status, p.valid_from, p.valid_to,
              c.code AS source_crs, p.transform_method, p.transform_accuracy_m,
              ST_AsGeoJSON(p.geom_wgs84, 7)::json AS geometry,
              gp.sg_ref AS general_plan_ref, gp.imported_at AS general_plan_imported_at
         FROM land.parcel p
         JOIN gis_ops.crs_registry c ON c.srid = p.source_srid
         LEFT JOIN admin.ward w ON w.ward_code = p.ward_code
         LEFT JOIN land.general_plan gp ON gp.import_id = p.general_plan_id
        WHERE p.parcel_id = $1`,
      [id],
    )
    if (!p) return reply.code(404).send({ success: false, error: 'not_found' })

    const [accounts, buildings, parents, children] = await Promise.all([
      pg.query(
        `SELECT a.erp_account_no, a.link_type, a.linked_on, s.status_band, s.as_at
           FROM revenue_link.account_link a
           LEFT JOIN revenue_link.billing_status s ON s.erp_account_no = a.erp_account_no
          WHERE a.parcel_id = $1 ORDER BY a.linked_on`, [id]),
      pg.query(
        `SELECT building_id, use, storeys, completion_date, source, accuracy_class
           FROM land.building WHERE parcel_id = $1 ORDER BY building_id`, [id]),
      pg.query(`SELECT parent_id AS parcel_id, event, event_date FROM land.parcel_lineage WHERE child_id = $1`, [id]),
      pg.query(`SELECT child_id AS parcel_id, event, event_date FROM land.parcel_lineage WHERE parent_id = $1`, [id]),
    ])

    return {
      success: true,
      data: {
        ...p,
        area_m2: Number(p.area_m2),
        area_ha: Number(p.area_ha),
        transform_accuracy_m: p.transform_accuracy_m == null ? null : Number(p.transform_accuracy_m),
        status_band: bandOf(accounts.rows.map((a) => a.status_band)),
        accounts: accounts.rows.map((a) => ({ ...a, status_band: a.status_band || 'unknown', erp_url: erpUrl(a.erp_account_no) })),
        buildings: buildings.rows,
        lineage: { parents: parents.rows, children: children.rows },
      },
    }
  })

  fastify.patch('/gms/parcels/:parcel_id', {
    preHandler: requireRole(fastify, GMS.editLayers),
    schema: { tags, summary: 'Edit parcel attributes (never the boundary)' },
  }, async (request, reply) => {
    const body = request.body || {}
    // Checked first, for every role: the answer to "can I move this boundary"
    // is the same whoever asks.
    if (GEOMETRY_KEYS.some((k) => k in body)) {
      return reply.code(409).send({
        success: false,
        error: 'boundary_survey_only',
        message: 'Parcel boundaries change only through an import of an approved general plan or diagram from the Survey Section. Ask the Senior GIS Officer (Data Management) to import the approved survey.',
      })
    }
    const fields = SURVEY_ATTRS.filter((k) => k in body)
    if (!fields.length) return reply.code(400).send({ success: false, error: 'no_editable_fields', editable: SURVEY_ATTRS })
    if (!SURVEY_ATTR_EDITORS.includes(request.user.role)) {
      return reply.code(403).send({
        success: false, error: 'not_custodian',
        message: 'These attributes are held for the Survey Section. Your department can edit only the layers it is custodian of.',
      })
    }
    const sets = fields.map((k, i) => `${k} = $${i + 2}`)
    try {
      const { rows } = await pg.query(
        `UPDATE land.parcel SET ${sets.join(', ')} WHERE parcel_id = $1 RETURNING parcel_id, sg_ref, ward_code`,
        [request.params.parcel_id, ...fields.map((k) => (body[k] == null ? null : String(body[k])))],
      )
      if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
      return { success: true, data: rows[0] }
    } catch (err) {
      if (err.code === '23503') return reply.code(400).send({ success: false, error: 'unknown_ward_code' })
      throw err
    }
  })

  fastify.get('/wards/:ward_code/summary', { ...view, schema: { tags, summary: 'Ward summary' } }, async (request, reply) => {
    const code = String(request.params.ward_code)
    const { rows: [w] } = await pg.query(
      `SELECT w.ward_code, w.name,
              count(p.parcel_id) FILTER (WHERE p.status = 'current')::int AS parcels,
              count(p.parcel_id) FILTER (WHERE p.status = 'current' AND p.allocation_status = 'allocated')::int AS allocated,
              count(p.parcel_id) FILTER (WHERE p.status = 'current' AND EXISTS (
                SELECT 1 FROM revenue_link.account_link a WHERE a.parcel_id = p.parcel_id))::int AS linked_to_account,
              count(p.parcel_id) FILTER (WHERE p.status = 'current'
                AND EXISTS (SELECT 1 FROM land.building b WHERE b.parcel_id = p.parcel_id)
                AND NOT EXISTS (SELECT 1 FROM revenue_link.account_link a WHERE a.parcel_id = p.parcel_id))::int AS structures_no_account,
              coalesce(sum(p.area_m2) FILTER (WHERE p.status = 'current'), 0) AS area_m2,
              (SELECT count(*)::int FROM admin.village v WHERE v.ward_code = w.ward_code) AS villages
         FROM admin.ward w
         LEFT JOIN land.parcel p ON p.ward_code = w.ward_code
        WHERE w.ward_code = $1
        GROUP BY w.ward_code`,
      [code],
    )
    if (!w) return reply.code(404).send({ success: false, error: 'not_found' })
    return { success: true, data: { ...w, area_m2: Number(w.area_m2) } }
  })

  fastify.post('/gms/imports/general-plan', {
    preHandler: requireRole(fastify, GMS.importSurvey),
    bodyLimit: 20 * 1024 * 1024,
    schema: { tags, summary: 'Import an approved general plan (validation report; commit to write)' },
  }, async (request, reply) => {
    const b = request.body || {}
    const result = await importGeneralPlan(pg, {
      sg_ref: typeof b.sg_ref === 'string' ? b.sg_ref.trim() : null,
      township_code: typeof b.township_code === 'string' ? b.township_code.trim() : null,
      source_srid: Number(b.source_srid),
      features: b.features ?? b.feature_collection?.features,
      commit: b.commit === true,
    }, request.user)
    if (!result.ok) return reply.code(422).send({ success: false, error: 'validation_failed', ...result })
    return { success: true, ...result }
  })

  // Public portal identify. Everything selected here is public by nature;
  // accounts, bands and names are not selected at all, so they cannot leak.
  fastify.get('/gms/public/parcels/:parcel_id', { schema: { tags, summary: 'Public parcel identify' } }, async (request, reply) => {
    const { rows: [p] } = await pg.query(
      `SELECT p.parcel_id, p.stand_no, p.township_code, w.name AS ward_name,
              p.area_m2, p.accuracy_class, ST_AsGeoJSON(p.geom_wgs84, 6)::json AS geometry
         FROM land.parcel p LEFT JOIN admin.ward w ON w.ward_code = p.ward_code
        WHERE p.parcel_id = $1 AND p.status = 'current'`,
      [String(request.params.parcel_id)],
    )
    if (!p) return reply.code(404).send({ success: false, error: 'not_found' })
    return { success: true, data: { ...p, area_m2: Number(p.area_m2) } }
  })

  fastify.get('/gms/key-registry', { ...view, schema: { tags, summary: 'Parcel to ERP account key registry' } }, async (request) => {
    const q = request.query?.q ? `%${request.query.q}%` : null
    const { rows } = await pg.query(
      `SELECT * FROM integration.key_registry
        WHERE $1::text IS NULL OR parcel_id ILIKE $1 OR stand_no ILIKE $1 OR erp_account_no ILIKE $1
        ORDER BY township_code, stand_no, erp_account_no LIMIT 500`,
      [q],
    )
    return { success: true, data: rows }
  })

  fastify.get('/gms/dashboard', { ...view, schema: { tags, summary: 'GIS Branch dashboard KPIs' } }, async () => {
    const { rows: [k] } = await pg.query(`
      SELECT
        (SELECT count(*) FROM land.parcel WHERE status = 'current')::int AS parcels,
        (SELECT count(DISTINCT a.parcel_id) FROM revenue_link.account_link a
           JOIN land.parcel p ON p.parcel_id = a.parcel_id AND p.status = 'current')::int AS parcels_linked,
        (SELECT count(*) FROM integration.outbox_event WHERE status = 'failed')::int AS failed_events,
        (SELECT count(*) FROM integration.outbox_event WHERE status = 'pending')::int AS pending_events,
        (SELECT count(*) FROM integration.reconciliation_item WHERE status = 'open')::int AS open_reconciliation`)
    return {
      success: true,
      data: { ...k, linked_share: k.parcels ? k.parcels_linked / k.parcels : null },
    }
  })
}

module.exports = { gmsRoutes, bandOf }
