// ============================================
// Fastify Routes: Development Control Matrix
// REFACTORED to use proposed_peri_urban_zones
// ============================================
//
// SECURITY (audit fix F2): PII reads, applicant/owner/agent writes, TPD1
// submissions and zoning/matrix master-data edits now require a valid JWT.
// Public spatial reference reads (zones, groups, matrix lookup, parcels,
// permitted-uses, compliance-check, local authorities, live updates) stay
// open for the public map.

const { requireAuth, requireRole } = require('../middleware/jwtAuth')
const {
  DEFAULT_PLAN_SQL, PLAN_ZONE_TYPE_SQL,
  ZONE_USES_SQL, ZONE_TYPE_USES_SQL, ZONE_TYPES_SQL, LAND_USES_SQL, ZONE_TYPE_CELLS_SQL,
  RULES_COUNT_SQL, PERMISSION_CODE, CONTROL_TYPE, groupUses, buildGrid,
} = require('../utils/zoneUses')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Council staff who may read the PII application register / dashboard.
const STAFF_ROLES = [
  'admin', 'planner', 'planning_clerk', 'eo',
  'gis_officer', 'env_officer', 'building_inspector', 'surveyor',
]

async function developmentControlRoutes(fastify) {
  // Auth shortcuts (see F2): authd = any logged-in user; staffOnly = council
  // staff; adminPlanner = zoning/matrix master-data editors only.
  const authd = { preHandler: requireAuth(fastify) }
  const staffOnly = { preHandler: requireRole(fastify, STAFF_ROLES) }
  const adminPlanner = { preHandler: requireRole(fastify, ['admin', 'planner']) }

  // ============================================
  // ZONES (using proposed_peri_urban_zones)
  // ============================================

  // GET /api/development-control/zones
  fastify.get('/zones', {
    schema: {
      description: 'Get all zones from proposed_peri_urban_zones',
      tags: ['Development Control']
    }
  }, async (request, reply) => {
    const { zone_type } = request.query
    
    let query = `
      SELECT 
        id,
        zone_code,
        zone as zone_name,
        zone_type,
        '' as description,
        is_active
      FROM proposed_peri_urban_zones
      WHERE is_active = TRUE
    `
    
    const params = []
    if (zone_type) {
      query += ` AND zone_type = $1`
      params.push(zone_type)
    }
    
    query += ` ORDER BY display_order, zone`
    
    const { rows } = await fastify.pg.query(query, params)
    return { success: true, count: rows.length, data: rows }
  })

  // GET /api/development-control/zones/:zoneId
  fastify.get('/zones/:zoneId', {
    schema: {
      description: 'Get zone details with full matrix',
      tags: ['Development Control']
    }
  }, async (request, reply) => {
    const { zoneId } = request.params
    
    // Get zone details
    const zoneQuery = `
      SELECT 
        id AS zone_id,
        zone_code,
        zone AS name,
        zone_type,
        map_color,
        display_order,
        is_active,
        ST_Area(geom) / 10000 AS area_hectares,
        ST_AsGeoJSON(geom) AS geometry
      FROM proposed_peri_urban_zones z
      WHERE z.id = $1 AND z.is_active = TRUE
    `
    const { rows: zoneRows } = await fastify.pg.query(zoneQuery, [zoneId])
    
    if (zoneRows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Zone not found' })
    }
    
    // Get matrix for this zone
    const { rows: controlRows } = await fastify.pg.query(ZONE_USES_SQL, [zoneId])
    // Same shape as before (permission_code P / SC / X), now from zone_land_use_controls.
    const matrixRows = controlRows.map(r => ({
      group_code: r.group_code,
      group_description: r.group_description,
      group_category: r.group_category,
      permission_code: PERMISSION_CODE[r.control_type],
      permission_description: r.control_type,
      conditions: r.conditions,
      max_units: null,
      max_height_meters: null,
      min_lot_size_sqm: null
    }))
    
    return { 
      success: true, 
      data: {
        zone: zoneRows[0],
        matrix: matrixRows
      }
    }
  })

  // GET /api/development-control/zones/:zoneId/parcels
  fastify.get('/zones/:zoneId/parcels', {
    schema: {
      description: 'Get parcels within a zone',
      tags: ['Development Control']
    }
  }, async (request, reply) => {
    const { zoneId } = request.params
    const { include_geometry } = request.query
    
    const query = `
      SELECT 
        f.gid AS parcel_id,
        f.stand_number,
        f.township_name,
        f.compliance_status,
        f.last_compliance_check,
        ST_Area(f.geom) / 10000 AS area_hectares
        ${include_geometry ? ', ST_AsGeoJSON(f.geom) AS geometry' : ''}
      FROM gweru_rural_farms f
      WHERE f.zone_id = $1
      ORDER BY f.township_name, f.stand_number
    `
    
    const { rows } = await fastify.pg.query(query, [zoneId])
    return { success: true, count: rows.length, data: rows }
  })

  // ============================================
  // LAND USE GROUPS
  // ============================================

  // The plan a request is about: ?plan=<id>, else the rural profile template (so clients
  // written before plans existed keep working). Sends the error itself and returns null
  // when the id is malformed or unknown.
  async function planFor(request, reply) {
    const value = request.query && request.query.plan
    if (!value) {
      const { rows } = await fastify.pg.query(DEFAULT_PLAN_SQL)
      if (!rows.length) { reply.code(404).send({ success: false, error: 'No default plan is configured' }); return null }
      return rows[0].id
    }
    if (!UUID_RE.test(value)) { reply.code(400).send({ success: false, error: 'plan must be a plan id' }); return null }
    const { rows } = await fastify.pg.query('SELECT id FROM plan_instrument WHERE id = $1', [value])
    if (!rows.length) { reply.code(404).send({ success: false, error: 'Unknown plan' }); return null }
    return rows[0].id
  }

  // GET /api/development-control/groups?plan=<id>   a plan's land uses
  fastify.get('/groups', async (request, reply) => {
    const plan = await planFor(request, reply)
    if (!plan) return
    const { rows } = await fastify.pg.query(`
      SELECT id AS group_id, group_code, description, group_category, notes
      FROM land_use_groups
      WHERE is_active = TRUE AND plan_instrument_id = $1
      ORDER BY display_order, group_code
    `, [plan])
    return { success: true, data: rows }
  })

  // ============================================
  // DEVELOPMENT MATRIX
  // ============================================

  // GET /api/development-control/matrix
  fastify.get('/matrix', async (request, reply) => {
    const { zone_id, group_id, permission_code } = request.query

    let query = `
      SELECT
        c.id AS matrix_id,
        z.id AS zone_id,
        z.zone_code,
        z.zone AS zone_name,
        g.group_code,
        g.description AS group_description,
        c.control_type,
        c.conditions,
        c.notes
      FROM zone_land_use_controls c
      JOIN proposed_peri_urban_zones z ON c.zone_id = z.id
      JOIN land_use_groups g ON c.land_use_group_id = g.id
      WHERE c.deleted_at IS NULL
    `
    const params = []

    if (zone_id) {
      params.push(zone_id)
      query += ` AND c.zone_id = $${params.length}`
    }

    if (group_id) {
      params.push(group_id)
      query += ` AND c.land_use_group_id = $${params.length}`
    }

    if (permission_code) {
      const type = CONTROL_TYPE[permission_code] || permission_code
      params.push(type)
      query += ` AND c.control_type = $${params.length}`
    }

    query += ` ORDER BY z.display_order, g.group_code`

    const { rows } = await fastify.pg.query(query, params)
    return {
      success: true,
      count: rows.length,
      data: rows.map(r => ({ ...r, permission_code: PERMISSION_CODE[r.control_type] }))
    }
  })

  // ── District development control matrix (zone type x coded land use) ──────
  // The council's printed matrix: eleven land-use zones across, ~32 coded land
  // uses down, P / X / SC in each cell, blank where nothing is decided. Public,
  // like permitted-uses: it is published planning policy.

  // GET /api/development-control/zone-types?plan=<id>
  fastify.get('/zone-types', async (request, reply) => {
    const plan = await planFor(request, reply)
    if (!plan) return
    const { rows } = await fastify.pg.query(ZONE_TYPES_SQL, [plan])
    return { success: true, count: rows.length, data: rows }
  })

  // GET /api/development-control/zone-types/:code/uses?plan=<id>
  fastify.get('/zone-types/:code/uses', async (request, reply) => {
    const plan = await planFor(request, reply)
    if (!plan) return
    const { code } = request.params
    const { rows: found } = await fastify.pg.query(PLAN_ZONE_TYPE_SQL, [plan, code])
    if (!found.length) return reply.code(404).send({ success: false, error: 'Unknown zone type' })
    const { rows } = await fastify.pg.query(ZONE_TYPE_USES_SQL, [plan, code])
    return { success: true, data: { zone_type: found[0], ...groupUses(rows) } }
  })

  // GET /api/development-control/matrix/grid?plan=<id>
  fastify.get('/matrix/grid', async (request, reply) => {
    const plan = await planFor(request, reply)
    if (!plan) return
    const [zoneTypes, landUses, cells] = await Promise.all([
      fastify.pg.query(ZONE_TYPES_SQL, [plan]),
      fastify.pg.query(LAND_USES_SQL, [plan]),
      fastify.pg.query(ZONE_TYPE_CELLS_SQL, [plan]),
    ])
    return {
      success: true,
      data: buildGrid({ zoneTypes: zoneTypes.rows, landUses: landUses.rows, cells: cells.rows }),
    }
  })

  // POST /api/development-control/matrix
  fastify.post('/matrix', {
    ...adminPlanner,
    schema: {
      description: 'Create or update matrix rule',
      tags: ['Development Control'],
      body: {
        type: 'object',
        required: ['zone_id', 'group_code', 'permission_code'],
        properties: {
          zone_id: { type: 'integer' },
          group_code: { type: 'string' },
          permission_code: { type: 'string', enum: ['P', 'X', 'SC'] },
          conditions: { type: 'string' },
          max_units: { type: 'integer' },
          max_height_meters: { type: 'number' },
          min_lot_size_sqm: { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    // max_units / max_height_meters / min_lot_size_sqm are accepted for
    // compatibility but the canonical table does not store them.
    const { zone_id, group_code, permission_code, conditions } = request.body

    // Land-use codes are per plan: take the code from the polygon's own plan, else from
    // a template's shared vocabulary.
    const { rows: groupRows } = await fastify.pg.query(
      `SELECT g.id
         FROM land_use_groups g
         LEFT JOIN plan_instrument gi ON gi.id = g.plan_instrument_id
        WHERE g.group_code = $1 AND g.is_active
          AND (g.plan_instrument_id = (SELECT plan_instrument_id FROM proposed_peri_urban_zones WHERE id = $2)
               OR gi.is_template)
        ORDER BY (g.plan_instrument_id = (SELECT plan_instrument_id FROM proposed_peri_urban_zones WHERE id = $2)) DESC NULLS LAST,
                 g.created_at
        LIMIT 1`,
      [group_code, zone_id]
    )

    if (groupRows.length === 0) {
      return reply.status(400).send({ success: false, error: 'Invalid group code' })
    }

    const { rows } = await fastify.pg.query(`
      INSERT INTO zone_land_use_controls (zone_id, land_use_group_id, control_type, conditions)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (zone_id, land_use_group_id)
      DO UPDATE SET
        control_type = EXCLUDED.control_type,
        conditions   = EXCLUDED.conditions,
        updated_at   = NOW(),
        deleted_at   = NULL,
        deleted_by   = NULL
      RETURNING id
    `, [zone_id, groupRows[0].id, CONTROL_TYPE[permission_code], conditions ?? null])

    return { success: true, data: { matrix_id: rows[0].id } }
  })

  // ============================================
  // COMPLIANCE CHECKING
  // ============================================

  // POST /api/development-control/compliance-check
  fastify.post('/compliance-check', {
    schema: {
      description: 'Check if proposed use is permitted on parcel',
      tags: ['Development Control'],
      body: {
        type: 'object',
        required: ['parcelId', 'proposedUseCode'],
        properties: {
          parcelId: { type: 'string' },
          proposedUseCode: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { parcelId, proposedUseCode } = request.body
    
    try {
      const { rows } = await fastify.pg.query(
        'SELECT * FROM check_development_permission($1, $2)',
        [parseInt(parcelId), proposedUseCode]
      )
      
      if (rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Parcel not found' })
      }
      
      return { success: true, data: rows[0] }
    } catch (error) {
      return reply.status(500).send({ 
        success: false, 
        error: 'Compliance check failed',
        details: error.message 
      })
    }
  })

  // GET /api/development-control/parcels/:parcelId/permitted-uses
  fastify.get('/parcels/:parcelId/permitted-uses', {
    schema: {
      description: 'Get all permitted uses for a parcel from development matrix',
      tags: ['Development Control'],
      params: {
        type: 'object',
        properties: {
          parcelId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { parcelId } = request.params
    const { zone_name, zone_code } = request.query || {}
    
    try {
      // First get the parcel information
      const parcelQuery = `
        SELECT 
          f.id AS parcel_id,
          f.name AS stand_number,
          f.district AS township_name
        FROM gweru_rural_farms f
        WHERE f.id = $1
      `
      
      const { rows: parcelRows } = await fastify.pg.query(parcelQuery, [parseInt(parcelId)])
      
      if (parcelRows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Parcel not found' })
      }
      
      const parcel = parcelRows[0]
      
      // If a specific zone is provided (from spatial analysis), use it
      // Otherwise, fall back to the parcel's assigned zone
      let zone = null
      if (zone_name) {
        // Find the zone by name from spatial analysis
        // If multiple zones have the same name, use the one with the most development rules
        const zoneQuery = `
          SELECT 
            z.id AS zone_id,
            z.zone_code,
            z.zone AS zone_name
          FROM proposed_peri_urban_zones z
          WHERE z.zone = $1
          ORDER BY ${RULES_COUNT_SQL} DESC
          LIMIT 1
        `
        const { rows: zoneRows } = await fastify.pg.query(zoneQuery, [zone_name])
        if (zoneRows.length > 0) {
          zone = zoneRows[0]
          console.log(`📋 Using zone: ${zone.zone_name} (ID: ${zone.zone_id}) for development controls`)
        }
      } else {
        // Fall back to parcel's assigned zone (original behavior)
        const parcelZoneQuery = `
          SELECT 
            z.id AS zone_id,
            z.zone_code,
            z.zone AS zone_name
          FROM gweru_rural_farms f
          LEFT JOIN proposed_peri_urban_zones z ON f.zone_id = z.id
          WHERE f.id = $1
        `
        const { rows: parcelZoneRows } = await fastify.pg.query(parcelZoneQuery, [parseInt(parcelId)])
        if (parcelZoneRows.length > 0 && parcelZoneRows[0].zone_id) {
          zone = parcelZoneRows[0]
        }
      }
      
      // If no zone found, return empty result
      if (!zone) {
        return { 
          success: true, 
          data: {
            parcel: parcel,
            zone: null,
            permitted_uses: [],
            prohibited_uses: [],
            consent_required_uses: []
          }
        }
      }
      
      const uses = await usesForZone(zone.zone_id)
      return {
        success: true,
        data: {
          parcel: parcel,
          zone,
          development_summary: {
            permitted_count: uses.permitted_uses.length,
            prohibited_count: uses.prohibited_uses.length,
            consent_required_count: uses.consent_required_uses.length
          },
          ...uses
        }
      }
    } catch (error) {
      return reply.status(500).send({
        success: false,
        error: 'Failed to get permitted uses',
        details: error.message
      })
    }
  })

  // GET /api/development-control/zoning-at?lng=&lat=
  // Zone and permitted uses at a map point, for the citizen map. Public, like
  // permitted-uses: the development matrix is published planning law.
  fastify.get('/zoning-at', async (request, reply) => {
    const lng = Number(request.query?.lng)
    const lat = Number(request.query?.lat)
    if (!Number.isFinite(lng) || !Number.isFinite(lat)
        || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      return reply.code(400).send({ success: false, error: 'valid lng and lat are required' })
    }
    try {
      // Overlapping zones: prefer the one with the most active rules, as
      // permitted-uses does for a named zone.
      const { rows } = await fastify.pg.query(
        `SELECT z.id AS zone_id, z.zone_code, z.zone AS zone_name
         FROM proposed_peri_urban_zones z
         WHERE z.is_active = TRUE
           AND ST_Contains(z.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
         ORDER BY ${RULES_COUNT_SQL} DESC
         LIMIT 1`,
        [lng, lat]
      )
      const zone = rows[0] || null
      if (!zone) {
        return { success: true, data: { zone: null, permitted_uses: [], prohibited_uses: [], consent_required_uses: [] } }
      }
      return { success: true, data: { zone, ...(await usesForZone(zone.zone_id)) } }
    } catch (error) {
      request.log.error({ err: error }, 'zoning-at failed')
      return reply.status(500).send({ success: false, error: 'Failed to look up zoning' })
    }
  })

  // Zoning rules for one zone polygon, grouped permitted / prohibited / special
  // consent. Reads zone_land_use_controls (see utils/zoneUses.js).
  async function usesForZone(zoneId) {
    const { rows } = await fastify.pg.query(ZONE_USES_SQL, [zoneId])
    return groupUses(rows)
  }

  // POST /api/development-control/update-compliance
  fastify.post('/update-compliance', staffOnly, async (request, reply) => {
    const { parcelId, proposedUseCode } = request.body
    
    try {
      const { rows } = await fastify.pg.query(
        'SELECT update_parcel_compliance($1, $2) AS result',
        [parseInt(parcelId), proposedUseCode]
      )
      return { success: true, data: rows[0].result }
    } catch (error) {
      return reply.status(500).send({ 
        success: false, 
        error: 'Failed to update compliance',
        details: error.message 
      })
    }
  })

  // ============================================
  // PARCELS
  // ============================================

  // GET /api/development-control/parcels
  fastify.get('/parcels', async (request, reply) => {
    const { zone_id, compliance_status, bbox, include_geometry } = request.query
    
    let query = `
      SELECT 
        f.id AS parcel_id,
        f.name AS stand_number,
        f.district AS township_name,
        z.id AS zone_id,
        z.zone_code,
        z.zone AS zone_name,
        g.group_code AS current_use_code,
        f.compliance_status,
        f.last_compliance_check,
        ST_Area(f.geom) / 10000 AS area_hectares
        ${include_geometry ? ', ST_AsGeoJSON(f.geom) AS geometry' : ''}
      FROM gweru_rural_farms f
      LEFT JOIN proposed_peri_urban_zones z ON f.zone_id = z.id
      LEFT JOIN land_use_groups g ON f.current_land_use_group_id = g.group_id
      WHERE ST_IsValid(f.geom) AND f.geom IS NOT NULL
    `
    const params = []
    
    if (zone_id) {
      params.push(zone_id)
      query += ` AND f.zone_id = $${params.length}`
    }
    
    if (compliance_status) {
      params.push(compliance_status)
      query += ` AND f.compliance_status = $${params.length}`
    }
    
    if (bbox) {
      const [xmin, ymin, xmax, ymax] = bbox.split(',').map(parseFloat)
      params.push(`SRID=4326;POLYGON((${xmin} ${ymin}, ${xmax} ${ymin}, ${xmax} ${ymax}, ${xmin} ${ymax}, ${xmin} ${ymin}))`)
      query += ` AND ST_Intersects(f.geom, ST_GeomFromEWKT($${params.length}))`
    }
    
    query += ` ORDER BY f.district, f.name`
    
    const { rows } = await fastify.pg.query(query, params)
    return { success: true, count: rows.length, data: rows }
  })

  // PUT /api/development-control/parcels/:parcelId/zone
  fastify.put('/parcels/:parcelId/zone', staffOnly, async (request, reply) => {
    const { parcelId } = request.params
    const { zone_id } = request.body
    
    const { rows } = await fastify.pg.query(
      `UPDATE gweru_rural_farms 
       SET zone_id = $1, compliance_status = 'pending_review', last_compliance_check = NOW()
       WHERE id = $2 
       RETURNING id, name AS stand_number, zone_id`,
      [zone_id, parseInt(parcelId)]
    )
    
    if (rows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Parcel not found' })
    }
    
    return { success: true, data: rows[0] }
  })

  // ============================================
  // APPLICATIONS
  // ============================================

  // GET /api/development-control/applications
  fastify.get('/applications', staffOnly, async (request, reply) => {
    const { parcel_id, status } = request.query
    
    let query = `
      SELECT 
        da.application_id,
        da.application_number,
        da.status,
        da.date_submitted,
        da.description,
        f.id AS parcel_id,
        f.name AS stand_number,
        f.district AS township_name,
        g.group_code AS proposed_use_code
      FROM development_applications da
      JOIN gweru_rural_farms f ON da.parcel_id = f.id
      LEFT JOIN land_use_groups g ON da.proposed_use_id = g.group_id
      WHERE 1=1
    `
    const params = []
    
    if (parcel_id) {
      params.push(parseInt(parcel_id))
      query += ` AND da.parcel_id = $${params.length}`
    }
    
    if (status) {
      params.push(status)
      query += ` AND da.status = $${params.length}`
    }
    
    query += ` ORDER BY da.date_submitted DESC`
    
    const { rows } = await fastify.pg.query(query, params)
    return { success: true, count: rows.length, data: rows }
  })

  // POST /api/development-control/applications
  fastify.post('/applications', authd, async (request, reply) => {
    const { parcel_id, proposed_use_code, description, application_type = 'building_permit' } = request.body
    
    const client = await fastify.pg.connect()
    
    try {
      await client.query('BEGIN')
      
      // Get group_id
      const { rows: groupRows } = await client.query(
        'SELECT group_id FROM land_use_groups WHERE group_code = $1',
        [proposed_use_code]
      )
      
      if (groupRows.length === 0) {
        await client.query('ROLLBACK')
        return reply.status(400).send({ success: false, error: 'Invalid use code' })
      }
      
      // Check compliance
      const { rows: compRows } = await client.query(
        'SELECT * FROM check_development_permission($1, $2)',
        [parcel_id, proposed_use_code]
      )
      
      const compliance = compRows[0]
      
      // Generate app number
      const year = new Date().getFullYear()
      const { rows: countRows } = await client.query(
        "SELECT COUNT(*) FROM development_applications WHERE application_number LIKE $1",
        [`APP/${year}/%`]
      )
      const appNumber = `APP/${year}/${(parseInt(countRows[0].count) + 1).toString().padStart(3, '0')}`
      
      // Insert
      const { rows } = await client.query(`
        INSERT INTO development_applications 
          (application_number, parcel_id, proposed_land_use_group_id, description, application_type, matrix_permission_code, compliance_check_passed)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING application_id, application_number, status
      `, [appNumber, parcel_id, groupRows[0].group_id, description, application_type, compliance.permission_code, compliance.can_develop])
      
      await client.query('COMMIT')
      
      return { 
        success: true, 
        data: {
          application: rows[0],
          compliance: { can_develop: compliance.can_develop, permission_code: compliance.permission_code }
        }
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  // ============================================
  // DASHBOARD
  // ============================================

  // GET /api/development-control/dashboard
  fastify.get('/dashboard', staffOnly, async (request, reply) => {
    const statsQuery = `
      SELECT 
        (SELECT COUNT(*) FROM gweru_rural_farms) AS total_parcels,
        (SELECT COUNT(*) FROM gweru_rural_farms WHERE zone_id IS NOT NULL) AS zoned_parcels,
        (SELECT COUNT(*) FROM gweru_rural_farms WHERE compliance_status = 'compliant') AS compliant,
        (SELECT COUNT(*) FROM gweru_rural_farms WHERE compliance_status = 'non_compliant') AS non_compliant,
        (SELECT COUNT(*) FROM gweru_rural_farms WHERE compliance_status = 'special_consent_required') AS sc_required,
        (SELECT COUNT(*) FROM development_applications WHERE status NOT IN ('approved', 'rejected')) AS active_apps
    `
    
    const { rows: stats } = await fastify.pg.query(statsQuery)
    
    // Zone distribution
    const { rows: zones } = await fastify.pg.query(`
      SELECT z.zone AS name, COUNT(f.id) AS parcel_count
      FROM proposed_peri_urban_zones z
      LEFT JOIN gweru_rural_farms f ON z.id = f.zone_id
      WHERE z.is_active = TRUE
      GROUP BY z.id, z.zone
      ORDER BY z.display_order
    `)
    
    return { success: true, data: { summary: stats[0], zones } }
  })

  // ============================================
  // TPD1 APPLICATION ENHANCED ENDPOINTS
  // ============================================

  // POST /api/development-control/applicants - Create applicant
  fastify.post('/applicants', authd, async (request, reply) => {
    const { surname, other_names, company_name, postal_address, telephone, email, is_company } = request.body
    
    const { rows } = await fastify.pg.query(`
      INSERT INTO applicants (surname, other_names, company_name, postal_address, telephone, email, is_company)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING applicant_id, surname, company_name, created_at
    `, [surname, other_names, company_name, postal_address, telephone, email, is_company || false])
    
    return { success: true, data: rows[0] }
  })

  // POST /api/development-control/owners - Create owner
  fastify.post('/owners', authd, async (request, reply) => {
    const { surname, other_names, company_name, postal_address, telephone, email, is_company } = request.body
    
    const { rows } = await fastify.pg.query(`
      INSERT INTO owners (surname, other_names, company_name, postal_address, telephone, email, is_company)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING owner_id, surname, company_name, created_at
    `, [surname, other_names, company_name, postal_address, telephone, email, is_company || false])
    
    return { success: true, data: rows[0] }
  })

  // POST /api/development-control/agents - Create agent
  fastify.post('/agents', authd, async (request, reply) => {
    const { full_name, company_name, postal_address, telephone, email } = request.body
    
    const { rows } = await fastify.pg.query(`
      INSERT INTO agents (full_name, company_name, postal_address, telephone, email)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING agent_id, full_name, created_at
    `, [full_name, company_name, postal_address, telephone, email])
    
    return { success: true, data: rows[0] }
  })

  // GET /api/development-control/local-authorities - List authorities
  fastify.get('/local-authorities', async (request, reply) => {
    const { rows } = await fastify.pg.query(`
      SELECT authority_id, authority_name, authority_type, address, telephone, email, application_fee
      FROM local_authorities
      WHERE is_active = TRUE
      ORDER BY authority_name
    `)
    return { success: true, count: rows.length, data: rows }
  })

  // POST /api/development-control/tpd1-applications - Full TPD1 submission
  fastify.post('/tpd1-applications', authd, async (request, reply) => {
    const {
      // Part I: General
      authority_id,
      applicant_id,
      owner_id,
      agent_id,
      parcel_id,
      application_type,
      payment_receipt_number,
      payment_amount,
      
      // Part II: Development Details
      description,
      proposed_use_code,
      is_new_construction,
      is_alteration,
      is_addition,
      external_floor_area,
      estimated_cost,
      change_of_use_details,
      
      // Part III: Additional Info
      is_mining,
      mining_details,
      restoration_programme,
      num_floors,
      total_floor_area,
      parking_occupants,
      parking_visitors,
      parking_loading_spaces,
      industrial_processes,
      trade_waste_details,
      emissions_details,
      effluent_disposal_method,
      noise_details,
      has_retail_sales,
      
      // Spatial
      boundary_geometry,
      boundary_source
    } = request.body
    
    const client = await fastify.pg.connect()
    
    try {
      await client.query('BEGIN')
      
      // Get group_id from code
      const { rows: groupRows } = await client.query(
        'SELECT group_id FROM land_use_groups WHERE group_code = $1',
        [proposed_use_code]
      )
      
      if (groupRows.length === 0) {
        await client.query('ROLLBACK')
        return reply.status(400).send({ success: false, error: 'Invalid proposed use code' })
      }
      
      // Generate application number using database function
      const { rows: appNumRows } = await client.query(
        'SELECT generate_application_number($1) as app_number',
        [authority_id]
      )
      const appNumber = appNumRows[0].app_number
      
      // Insert full application
      const { rows } = await client.query(`
        INSERT INTO development_applications (
          application_number, authority_id, applicant_id, owner_id, agent_id, parcel_id,
          application_type, payment_receipt_number, payment_amount, payment_date,
          description, proposed_use_id,
          is_new_construction, is_alteration, is_addition, external_floor_area, estimated_cost,
          change_of_use_details,
          is_mining, mining_details, restoration_programme,
          num_floors, total_floor_area,
          parking_occupants, parking_visitors, parking_loading_spaces,
          industrial_processes, trade_waste_details, emissions_details, 
          effluent_disposal_method, noise_details, has_retail_sales,
          boundary_geometry, boundary_source
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, ST_SetSRID(ST_GeomFromGeoJSON($32), 4326), $33)
        RETURNING application_id, application_number, status, created_at
      `, [
        appNumber, authority_id, applicant_id, owner_id, agent_id, parcel_id,
        application_type, payment_receipt_number, payment_amount,
        description, groupRows[0].group_id,
        is_new_construction, is_alteration, is_addition, external_floor_area, estimated_cost,
        change_of_use_details,
        is_mining, mining_details, restoration_programme,
        num_floors, total_floor_area,
        parking_occupants, parking_visitors, parking_loading_spaces,
        industrial_processes, trade_waste_details, emissions_details,
        effluent_disposal_method, noise_details, has_retail_sales,
        boundary_geometry, boundary_source
      ])
      
      const application = rows[0]
      
      // Run compliance check
      await client.query('SELECT check_application_compliance($1)', [application.application_id])
      
      // Get compliance result
      const { rows: compRows } = await client.query(
        'SELECT matrix_permission_code, compliance_check_passed, compliance_status FROM development_applications WHERE application_id = $1',
        [application.application_id]
      )
      
      await client.query('COMMIT')
      
      return {
        success: true,
        data: {
          application: application,
          compliance: compRows[0]
        }
      }
    } catch (error) {
      await client.query('ROLLBACK')
      console.error('TPD1 Application Error:', error)
      return reply.status(500).send({
        success: false,
        error: 'Failed to submit application',
        details: error.message
      })
    } finally {
      client.release()
    }
  })

  // POST /api/development-control/applications/:id/validate - Validate completeness
  fastify.post('/applications/:id/validate', staffOnly, async (request, reply) => {
    const { id } = request.params
    
    const { rows } = await fastify.pg.query(
      'SELECT * FROM validate_application_complete($1)',
      [id]
    )
    
    return {
      success: true,
      data: {
        is_complete: rows[0].is_complete,
        missing_fields: rows[0].missing_fields,
        required_documents: rows[0].required_documents
      }
    }
  })

  // GET /api/development-control/applications/:id/summary - Get full summary
  // Staff only: these legacy rows carry no owner, so there is no way to check
  // that a client is reading their own application (was login-only — any
  // signed-in citizen could read any application by id).
  fastify.get('/applications/:id/summary', staffOnly, async (request, reply) => {
    const { id } = request.params
    
    const { rows } = await fastify.pg.query(
      'SELECT * FROM v_application_summary WHERE application_id = $1',
      [id]
    )
    
    if (rows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Application not found' })
    }
    
    return { success: true, data: rows[0] }
  })

  // ============================================
  // REAL-TIME UPDATES (SSE)
  // ============================================

  // GET /api/development-control/live-updates - SSE stream for real-time updates
  fastify.get('/live-updates', {
    schema: {
      description: 'Server-Sent Events stream for real-time QGIS updates',
      tags: ['Development Control']
    }
  }, async (request, reply) => {
    const { getBroadcaster } = require('../services/admin/updateBroadcaster')
    const broadcaster = getBroadcaster()
    
    // Add this response to broadcaster clients
    const clientId = broadcaster.addClient(reply.raw)
    
    // Keep connection alive
    const keepAlive = setInterval(() => {
      try {
        reply.raw.write(':heartbeat\n\n')
      } catch (e) {
        clearInterval(keepAlive)
        broadcaster.removeClient(clientId)
      }
    }, 30000) // Every 30 seconds
    
    // Cleanup on close
    reply.raw.on('close', () => {
      clearInterval(keepAlive)
      broadcaster.removeClient(clientId)
    })
    
    // Don't close the reply - keep connection open
    return reply
  })

  // GET /api/development-control/live-status - Get broadcaster status
  fastify.get('/live-status', async (request, reply) => {
    const { getBroadcaster } = require('../services/admin/updateBroadcaster')
    const broadcaster = getBroadcaster()
    return { success: true, data: broadcaster.getStatus() }
  })
}

module.exports = developmentControlRoutes
