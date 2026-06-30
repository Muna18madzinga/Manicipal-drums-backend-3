// Property File / land register routes (migration 084).
//
// Parcel-centric dossier keyed by stand_number: summary, owners, zoning
// designations, existing uses, assessment/rates and subdivision/consolidation
// lineage. Reads return 200 with sensible empties (never 404 for a stand that
// simply has no register entry yet) so the frontend renders clean empty states.
// All endpoints are staff role-gated; owners + assessment carry PII.

const { requireRole } = require('../middleware/jwtAuth')

const STAFF_ROLES = ['admin', 'planner', 'planning_clerk', 'building_inspector', 'eo', 'surveyor', 'gis_officer', 'env_officer']
// Who may maintain (write) the land register.
const WRITERS = ['admin', 'planner', 'planning_clerk', 'gis_officer']

function isStr(v, max = 4096) { return typeof v === 'string' && v.length > 0 && v.length <= max }
function isDate(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) }
function numOrNull(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null }
function intOrNull(v) { return Number.isInteger(v) ? v : null }

function toSummary(row) {
  if (!row) return null
  return {
    stand_number: row.stand_number,
    ward: row.suburb_ward ?? null,
    address: row.street_address ?? null,
    aan: row.aan ?? null,
    pid: row.pid ?? null,
    area_sqm: row.area_sqm != null ? Number(row.area_sqm) : null,
    frontage_m: row.frontage_m != null ? Number(row.frontage_m) : null,
    units: row.units ?? null,
    dwellings: row.dwellings ?? null,
    corner_lot: !!row.corner_lot,
    dev_agreement: !!row.dev_agreement,
    follow_up_date: row.follow_up_date ?? null,
    heritage: {
      conservation_district: !!row.heritage_conservation_district,
      municipally_designated: !!row.heritage_municipal,
      provincially_designated: !!row.heritage_national,
      notes: row.heritage_notes ?? null,
    },
  }
}

function emptySummary(standNo) {
  return {
    stand_number: standNo, ward: null, address: null, aan: null, pid: null,
    area_sqm: null, frontage_m: null, units: null, dwellings: null,
    corner_lot: false, dev_agreement: false, follow_up_date: null, heritage: null,
  }
}

async function propertyRoutes(fastify) {
  const pg = fastify.pg
  const readAuth = { preHandler: requireRole(fastify, STAFF_ROLES) }
  const writeAuth = { preHandler: requireRole(fastify, WRITERS) }

  // Resolve a property id from a stand number (read-only). Null when absent.
  async function findPropertyId(standNo) {
    const { rows } = await pg.query(
      'SELECT id FROM spatial_planning.property WHERE stand_number = $1', [standNo])
    return rows[0]?.id ?? null
  }
  // Resolve or create a minimal property row (for writes), returning its id.
  async function ensureProperty(standNo, userId) {
    const { rows } = await pg.query(
      `INSERT INTO spatial_planning.property (stand_number, created_by)
       VALUES ($1, $2)
       ON CONFLICT (stand_number) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [standNo, userId || null])
    return rows[0].id
  }

  // ── Summary ──────────────────────────────────────────────────────
  fastify.get('/properties/:standNo', readAuth, async (request, reply) => {
    const standNo = String(request.params.standNo)
    const { rows } = await pg.query(
      'SELECT * FROM spatial_planning.property WHERE stand_number = $1', [standNo])
    return reply.send({ success: true, data: rows[0] ? toSummary(rows[0]) : emptySummary(standNo) })
  })

  // ── Owners ───────────────────────────────────────────────────────
  fastify.get('/properties/:standNo/owners', readAuth, async (request, reply) => {
    const id = await findPropertyId(String(request.params.standNo))
    if (!id) return reply.send({ success: true, data: [] })
    const { rows } = await pg.query(
      `SELECT id, name, company, role, postal_address, phone, email, since
         FROM spatial_planning.parcel_owner WHERE property_id = $1 ORDER BY created_at ASC`, [id])
    return reply.send({ success: true, data: rows })
  })

  // ── Zoning designations ──────────────────────────────────────────
  fastify.get('/properties/:standNo/zoning', readAuth, async (request, reply) => {
    const id = await findPropertyId(String(request.params.standNo))
    if (!id) return reply.send({ success: true, data: [] })
    const { rows } = await pg.query(
      `SELECT id, designation, effective_date, notes, reference
         FROM spatial_planning.zoning_designation WHERE property_id = $1
        ORDER BY effective_date DESC NULLS LAST, created_at DESC`, [id])
    return reply.send({ success: true, data: rows })
  })

  // ── Existing uses (land_use exposed as `use`) ────────────────────
  fastify.get('/properties/:standNo/existing-uses', readAuth, async (request, reply) => {
    const id = await findPropertyId(String(request.params.standNo))
    if (!id) return reply.send({ success: true, data: [] })
    const { rows } = await pg.query(
      `SELECT id, land_use AS "use", recorded_at, notes
         FROM spatial_planning.existing_use WHERE property_id = $1 ORDER BY recorded_at DESC NULLS LAST`, [id])
    return reply.send({ success: true, data: rows })
  })

  // ── Assessment / rates ───────────────────────────────────────────
  fastify.get('/properties/:standNo/assessment', readAuth, async (request, reply) => {
    const { rows: pr } = await pg.query(
      'SELECT id, aan FROM spatial_planning.property WHERE stand_number = $1', [String(request.params.standNo)])
    const empty = { aan: pr[0]?.aan ?? null, roll_number: null, valuation: null, rateable_value: null, rates_balance: null, last_paid_at: null }
    if (!pr[0]) return reply.send({ success: true, data: empty })
    const { rows } = await pg.query(
      'SELECT aan, roll_number, valuation, rateable_value, rates_balance, last_paid_at FROM spatial_planning.property_assessment WHERE property_id = $1',
      [pr[0].id])
    if (!rows[0]) return reply.send({ success: true, data: empty })
    const a = rows[0]
    return reply.send({ success: true, data: {
      aan: a.aan ?? pr[0].aan ?? null, roll_number: a.roll_number ?? null,
      valuation: a.valuation != null ? Number(a.valuation) : null,
      rateable_value: a.rateable_value != null ? Number(a.rateable_value) : null,
      rates_balance: a.rates_balance != null ? Number(a.rates_balance) : null,
      last_paid_at: a.last_paid_at ?? null,
    } })
  })

  // ── Lineage (subdivision / consolidation) ────────────────────────
  fastify.get('/properties/:standNo/lineage', readAuth, async (request, reply) => {
    const id = await findPropertyId(String(request.params.standNo))
    if (!id) return reply.send({ success: true, data: { action: null, parent: null, children: [] } })
    const { rows: parentRows } = await pg.query(
      `SELECT p.stand_number, p.pid, l.action
         FROM spatial_planning.parcel_lineage l
         JOIN spatial_planning.property p ON p.id = l.parent_property_id
        WHERE l.child_property_id = $1 LIMIT 1`, [id])
    const { rows: childRows } = await pg.query(
      `SELECT p.stand_number, p.pid, l.action, l.created_at
         FROM spatial_planning.parcel_lineage l
         JOIN spatial_planning.property p ON p.id = l.child_property_id
        WHERE l.parent_property_id = $1 ORDER BY p.stand_number ASC`, [id])
    const action = parentRows[0]?.action ?? childRows[0]?.action ?? null
    return reply.send({ success: true, data: {
      action,
      parent: parentRows[0] ? { stand_number: parentRows[0].stand_number, pid: parentRows[0].pid ?? null } : null,
      children: childRows.map(c => ({ stand_number: c.stand_number, pid: c.pid ?? null, created_at: c.created_at })),
    } })
  })

  // ══ Writes (staff: maintain the register) ════════════════════════

  // Upsert the property record. Provided fields override; omitted fields kept.
  fastify.post('/properties', writeAuth, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.stand_number, 60)) {
      return reply.code(400).send({ success: false, error: 'stand_number required' })
    }
    try {
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.property
           (stand_number, suburb_ward, street_address, aan, pid, area_sqm, frontage_m,
            units, dwellings, corner_lot, dev_agreement, follow_up_date,
            heritage_conservation_district, heritage_municipal, heritage_national, heritage_notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (stand_number) DO UPDATE SET
           suburb_ward    = COALESCE(EXCLUDED.suburb_ward, spatial_planning.property.suburb_ward),
           street_address = COALESCE(EXCLUDED.street_address, spatial_planning.property.street_address),
           aan            = COALESCE(EXCLUDED.aan, spatial_planning.property.aan),
           pid            = COALESCE(EXCLUDED.pid, spatial_planning.property.pid),
           area_sqm       = COALESCE(EXCLUDED.area_sqm, spatial_planning.property.area_sqm),
           frontage_m     = COALESCE(EXCLUDED.frontage_m, spatial_planning.property.frontage_m),
           units          = COALESCE(EXCLUDED.units, spatial_planning.property.units),
           dwellings      = COALESCE(EXCLUDED.dwellings, spatial_planning.property.dwellings),
           corner_lot     = EXCLUDED.corner_lot,
           dev_agreement  = EXCLUDED.dev_agreement,
           follow_up_date = COALESCE(EXCLUDED.follow_up_date, spatial_planning.property.follow_up_date),
           heritage_conservation_district = EXCLUDED.heritage_conservation_district,
           heritage_municipal             = EXCLUDED.heritage_municipal,
           heritage_national              = EXCLUDED.heritage_national,
           heritage_notes = COALESCE(EXCLUDED.heritage_notes, spatial_planning.property.heritage_notes),
           updated_at     = NOW()
         RETURNING *`,
        [
          b.stand_number,
          isStr(b.ward, 120) ? b.ward : (isStr(b.suburb_ward, 120) ? b.suburb_ward : null),
          isStr(b.address, 4096) ? b.address : null,
          isStr(b.aan, 40) ? b.aan : null,
          isStr(b.pid, 40) ? b.pid : null,
          numOrNull(b.area_sqm), numOrNull(b.frontage_m),
          intOrNull(b.units), intOrNull(b.dwellings),
          !!b.corner_lot, !!b.dev_agreement,
          isDate(b.follow_up_date) ? b.follow_up_date : null,
          !!(b.heritage && b.heritage.conservation_district),
          !!(b.heritage && b.heritage.municipally_designated),
          !!(b.heritage && b.heritage.provincially_designated),
          b.heritage && isStr(b.heritage.notes, 4096) ? b.heritage.notes : null,
          request.user.id,
        ])
      return reply.code(201).send({ success: true, data: toSummary(rows[0]) })
    } catch (err) {
      request.log.error({ err }, 'upsert property failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/properties/:standNo/owners', writeAuth, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.name, 255) && !isStr(b.company, 255)) {
      return reply.code(400).send({ success: false, error: 'name or company required' })
    }
    const role = ['owner', 'occupier', 'agent'].includes(b.role) ? b.role : 'owner'
    try {
      const id = await ensureProperty(String(request.params.standNo), request.user.id)
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.parcel_owner (property_id, name, company, role, postal_address, phone, email, since)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, company, role, postal_address, phone, email, since`,
        [id, isStr(b.name, 255) ? b.name : (b.company || ''), isStr(b.company, 255) ? b.company : null,
         role, isStr(b.postal_address, 4096) ? b.postal_address : null,
         isStr(b.phone, 40) ? b.phone : null, isStr(b.email, 255) ? b.email : null,
         isDate(b.since) ? b.since : null])
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'add owner failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/properties/:standNo/zoning', writeAuth, async (request, reply) => {
    const b = request.body || {}
    if (!isStr(b.designation, 80)) return reply.code(400).send({ success: false, error: 'designation required' })
    try {
      const id = await ensureProperty(String(request.params.standNo), request.user.id)
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.zoning_designation (property_id, designation, effective_date, notes, reference)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, designation, effective_date, notes, reference`,
        [id, b.designation, isDate(b.effective_date) ? b.effective_date : null,
         isStr(b.notes, 4096) ? b.notes : null, isStr(b.reference, 120) ? b.reference : null])
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'add zoning designation failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/properties/:standNo/existing-uses', writeAuth, async (request, reply) => {
    const b = request.body || {}
    const useText = isStr(b.use, 120) ? b.use : (isStr(b.land_use, 120) ? b.land_use : null)
    if (!useText) return reply.code(400).send({ success: false, error: 'use required' })
    try {
      const id = await ensureProperty(String(request.params.standNo), request.user.id)
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.existing_use (property_id, land_use, recorded_at, notes)
         VALUES ($1,$2,$3,$4) RETURNING id, land_use AS "use", recorded_at, notes`,
        [id, useText, isDate(b.recorded_at) ? b.recorded_at : null, isStr(b.notes, 4096) ? b.notes : null])
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'add existing use failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.put('/properties/:standNo/assessment', writeAuth, async (request, reply) => {
    const b = request.body || {}
    try {
      const id = await ensureProperty(String(request.params.standNo), request.user.id)
      const { rows } = await pg.query(
        `INSERT INTO spatial_planning.property_assessment
           (property_id, aan, roll_number, valuation, rateable_value, rates_balance, last_paid_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (property_id) DO UPDATE SET
           aan = COALESCE(EXCLUDED.aan, spatial_planning.property_assessment.aan),
           roll_number = COALESCE(EXCLUDED.roll_number, spatial_planning.property_assessment.roll_number),
           valuation = COALESCE(EXCLUDED.valuation, spatial_planning.property_assessment.valuation),
           rateable_value = COALESCE(EXCLUDED.rateable_value, spatial_planning.property_assessment.rateable_value),
           rates_balance = COALESCE(EXCLUDED.rates_balance, spatial_planning.property_assessment.rates_balance),
           last_paid_at = COALESCE(EXCLUDED.last_paid_at, spatial_planning.property_assessment.last_paid_at),
           updated_at = NOW()
         RETURNING *`,
        [id, isStr(b.aan, 40) ? b.aan : null, isStr(b.roll_number, 40) ? b.roll_number : null,
         numOrNull(b.valuation), numOrNull(b.rateable_value), numOrNull(b.rates_balance),
         isDate(b.last_paid_at) ? b.last_paid_at : null])
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'upsert assessment failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // Link a parent stand to one or more child stands (subdivision/consolidation).
  fastify.post('/properties/:standNo/lineage', writeAuth, async (request, reply) => {
    const b = request.body || {}
    const action = ['subdivision', 'consolidation'].includes(b.action) ? b.action : null
    if (!action) return reply.code(400).send({ success: false, error: 'action (subdivision|consolidation) required' })
    const children = Array.isArray(b.children) ? b.children.filter(s => isStr(s, 60)) : []
    if (!children.length) return reply.code(400).send({ success: false, error: 'children stand numbers required' })
    try {
      const parentId = await ensureProperty(String(request.params.standNo), request.user.id)
      for (const childStand of children) {
        const childId = await ensureProperty(childStand, request.user.id)
        if (childId === parentId) continue
        await pg.query(
          `INSERT INTO spatial_planning.parcel_lineage (parent_property_id, child_property_id, action)
           VALUES ($1,$2,$3) ON CONFLICT (parent_property_id, child_property_id) DO UPDATE SET action = EXCLUDED.action`,
          [parentId, childId, action])
      }
      return reply.code(201).send({ success: true, linked: children.length })
    } catch (err) {
      request.log.error({ err }, 'link lineage failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

module.exports = { propertyRoutes, toSummary, emptySummary }
