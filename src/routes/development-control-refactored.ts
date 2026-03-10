// ============================================
// Fastify Routes: Development Control Matrix
// REFACTORED to use proposed_peri_urban_zones
// ============================================

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

export default async function developmentControlRoutes(fastify: FastifyInstance) {

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
    const { zone_type } = request.query as any
    
    let query = `
      SELECT 
        id AS zone_id,
        zone_code,
        name,
        zone_type,
        map_color,
        display_order,
        is_active,
        ST_Area(geom) / 10000 AS area_hectares,
        ST_AsGeoJSON(geom) AS geometry
      FROM proposed_peri_urban_zones
      WHERE is_active = TRUE
    `
    const params: any[] = []
    
    if (zone_type) {
      params.push(zone_type)
      query += ` AND zone_type = $${params.length}`
    }
    
    query += ` ORDER BY display_order, name`
    
    const { rows } = await fastify.pg.query(query, params)
    return { success: true, count: rows.length, data: rows }
  })

  // GET /api/development-control/zones/:zoneId
  fastify.get('/zones/:zoneId', {
    schema: {
      description: 'Get zone details with full matrix',
      tags: ['Development Control']
    }
  }, async (request: FastifyRequest<{ Params: { zoneId: string } }>, reply) => {
    const { zoneId } = request.params
    
    // Get zone details
    const zoneQuery = `
      SELECT 
        id AS zone_id,
        zone_code,
        name,
        zone_type,
        map_color,
        display_order,
        is_active,
        ST_Area(geom) / 10000 AS area_hectares,
        ST_AsGeoJSON(geom) AS geometry
      FROM proposed_peri_urban_zones
      WHERE id = $1
    `
    const { rows: zoneRows } = await fastify.pg.query(zoneQuery, [zoneId])
    
    if (zoneRows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Zone not found' })
    }
    
    // Get matrix for this zone
    const matrixQuery = `
      SELECT 
        g.group_code,
        g.description AS group_description,
        g.group_category,
        p.permission_code,
        p.description AS permission_description,
        p.color AS permission_color,
        p.icon AS permission_icon,
        dm.conditions,
        dm.max_units,
        dm.max_height_meters,
        dm.min_lot_size_sqm
      FROM development_matrix dm
      JOIN land_use_groups g ON dm.group_id = g.group_id
      JOIN permission_types p ON dm.permission_code = p.permission_code
      WHERE dm.zone_id = $1 AND dm.is_active = TRUE AND g.is_active = TRUE
      ORDER BY g.group_code
    `
    const { rows: matrixRows } = await fastify.pg.query(matrixQuery, [zoneId])
    
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
  }, async (request: FastifyRequest<{ Params: { zoneId: string } }>, reply) => {
    const { zoneId } = request.params
    const { include_geometry } = request.query as any
    
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

  // GET /api/development-control/groups
  fastify.get('/groups', async (request, reply) => {
    const { rows } = await fastify.pg.query(`
      SELECT group_id, group_code, description, short_name, group_category, notes
      FROM land_use_groups
      WHERE is_active = TRUE
      ORDER BY group_code
    `)
    return { success: true, data: rows }
  })

  // ============================================
  // DEVELOPMENT MATRIX
  // ============================================

  // GET /api/development-control/matrix
  fastify.get('/matrix', async (request, reply) => {
    const { zone_id, group_id, permission_code } = request.query as any
    
    let query = `
      SELECT 
        dm.matrix_id,
        z.id AS zone_id,
        z.zone_code,
        z.name AS zone_name,
        g.group_code,
        g.description AS group_description,
        p.permission_code,
        p.description AS permission_description,
        p.color AS permission_color,
        dm.conditions,
        dm.max_units,
        dm.max_height_meters,
        dm.min_lot_size_sqm
      FROM development_matrix dm
      JOIN proposed_peri_urban_zones z ON dm.zone_id = z.id
      JOIN land_use_groups g ON dm.group_id = g.group_id
      JOIN permission_types p ON dm.permission_code = p.permission_code
      WHERE dm.is_active = TRUE
    `
    const params: any[] = []
    
    if (zone_id) {
      params.push(zone_id)
      query += ` AND dm.zone_id = $${params.length}`
    }
    
    if (group_id) {
      params.push(group_id)
      query += ` AND dm.group_id = $${params.length}`
    }
    
    if (permission_code) {
      params.push(permission_code)
      query += ` AND dm.permission_code = $${params.length}`
    }
    
    query += ` ORDER BY z.display_order, g.group_code`
    
    const { rows } = await fastify.pg.query(query, params)
    return { success: true, count: rows.length, data: rows }
  })

  // POST /api/development-control/matrix
  fastify.post('/matrix', {
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
    const { zone_id, group_code, permission_code, conditions, max_units, max_height_meters, min_lot_size_sqm } = request.body as any
    
    // Get group_id from code
    const { rows: groupRows } = await fastify.pg.query(
      'SELECT group_id FROM land_use_groups WHERE group_code = $1',
      [group_code]
    )
    
    if (groupRows.length === 0) {
      return reply.status(400).send({ success: false, error: 'Invalid group code' })
    }
    
    const group_id = groupRows[0].group_id
    
    const query = `
      INSERT INTO development_matrix (zone_id, group_id, permission_code, conditions, max_units, max_height_meters, min_lot_size_sqm)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (zone_id, group_id) 
      DO UPDATE SET 
        permission_code = EXCLUDED.permission_code,
        conditions = EXCLUDED.conditions,
        max_units = EXCLUDED.max_units,
        max_height_meters = EXCLUDED.max_height_meters,
        min_lot_size_sqm = EXCLUDED.min_lot_size_sqm,
        is_active = TRUE
      RETURNING matrix_id
    `
    
    const { rows } = await fastify.pg.query(query, [
      zone_id, group_id, permission_code, conditions, max_units, max_height_meters, min_lot_size_sqm
    ])
    
    return { success: true, data: { matrix_id: rows[0].matrix_id } }
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
  }, async (request: FastifyRequest<{ Body: { parcelId: string, proposedUseCode: string } }>, reply) => {
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
        details: (error as Error).message 
      })
    }
  })

  // POST /api/development-control/update-compliance
  fastify.post('/update-compliance', async (request, reply) => {
    const { parcelId, proposedUseCode } = request.body as any
    
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
        details: (error as Error).message 
      })
    }
  })

  // ============================================
  // PARCELS
  // ============================================

  // GET /api/development-control/parcels
  fastify.get('/parcels', async (request, reply) => {
    const { zone_id, compliance_status, bbox, include_geometry } = request.query as any
    
    let query = `
      SELECT 
        f.gid AS parcel_id,
        f.stand_number,
        f.township_name,
        z.id AS zone_id,
        z.zone_code,
        z.name AS zone_name,
        g.group_code AS current_use_code,
        f.compliance_status,
        f.last_compliance_check,
        ST_Area(f.geom) / 10000 AS area_hectares
        ${include_geometry ? ', ST_AsGeoJSON(f.geom) AS geometry' : ''}
      FROM gweru_rural_farms f
      LEFT JOIN proposed_peri_urban_zones z ON f.zone_id = z.id
      LEFT JOIN land_use_groups g ON f.current_land_use_group_id = g.group_id
      WHERE 1=1
    `
    const params: any[] = []
    
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
    
    query += ` ORDER BY f.township_name, f.stand_number`
    
    const { rows } = await fastify.pg.query(query, params)
    return { success: true, count: rows.length, data: rows }
  })

  // GET /api/development-control/parcels/:parcelId/permitted-uses
  fastify.get('/parcels/:parcelId/permitted-uses', {
    schema: {
      description: 'Get permitted, prohibited, and consent-required uses for a parcel',
      tags: ['Development Control'],
      querystring: {
        type: 'object',
        properties: {
          zone_name: { type: 'string' },
          zone_code: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Params: { parcelId: string }, Querystring: { zone_name?: string, zone_code?: string } }>, reply) => {
    const { parcelId } = request.params
    const { zone_name, zone_code } = request.query

    try {
      // Get parcel details and geometry
      const parcelQuery = `
        SELECT
          f.gid AS parcel_id,
          f.stand_number,
          f.township_name,
          f.zone_id AS original_zone_id,
          ST_AsGeoJSON(f.geom) as geometry
        FROM gweru_rural_farms f
        WHERE f.gid = $1
      `
      const { rows: parcelRows } = await fastify.pg.query(parcelQuery, [parseInt(parcelId)])

      if (parcelRows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Parcel not found' })
      }

      const parcel = parcelRows[0]

      // Use geometric intersection to determine which zone(s) the parcel belongs to
      const zoneIntersectionQuery = `
        SELECT
          z.id,
          z.zone_code,
          z.name AS zone_name,
          ST_Area(ST_Intersection(f.geom, z.geom)) as intersection_area,
          ST_Area(f.geom) as parcel_area
        FROM gweru_rural_farms f
        CROSS JOIN proposed_peri_urban_zones z
        WHERE f.gid = $1
          AND z.is_active = TRUE
          AND ST_Intersects(f.geom, z.geom)
        ORDER BY ST_Area(ST_Intersection(f.geom, z.geom)) DESC
        LIMIT 1
      `

      const { rows: zoneRows } = await fastify.pg.query(zoneIntersectionQuery, [parseInt(parcelId)])

      let zoneId = null
      let zoneInfo = null

      if (zoneRows.length > 0) {
        const zone = zoneRows[0]
        zoneId = zone.id
        zoneInfo = {
          zone_id: zone.id,
          zone_code: zone.zone_code,
          zone_name: zone.zone_name,
          intersection_area_sqm: parseFloat(zone.intersection_area) || 0,
          parcel_area_sqm: parseFloat(zone.parcel_area) || 0,
          intersection_percentage: zone.parcel_area > 0 ?
            ((parseFloat(zone.intersection_area) / parseFloat(zone.parcel_area)) * 100) : 0
        }
      }
      // Override zone if specified in query params (takes precedence over geometric intersection)
      if (zone_name || zone_code) {
        let zoneOverrideQuery = 'SELECT id, zone_code, name FROM proposed_peri_urban_zones WHERE is_active = TRUE'
        const zoneParams: any[] = []

        if (zone_name) {
          zoneParams.push(zone_name)
          zoneOverrideQuery += ` AND name = $${zoneParams.length}`
        }

        if (zone_code) {
          zoneParams.push(zone_code)
          zoneOverrideQuery += ` AND zone_code = $${zoneParams.length}`
        }

        const { rows: zoneRows } = await fastify.pg.query(zoneOverrideQuery, zoneParams)
        if (zoneRows.length > 0) {
          const overrideZone = zoneRows[0]
          zoneId = overrideZone.id
          zoneInfo = {
            zone_id: overrideZone.id,
            zone_code: overrideZone.zone_code,
            zone_name: overrideZone.name,
            override_reason: 'query_parameter_override'
          }
        }
      }

      // If no zone found through geometric intersection or override, return error
      if (!zoneId) {
        return reply.status(404).send({
          success: false,
          error: 'No intersecting zone found for this parcel',
          parcel_id: parcel.parcel_id,
          parcel_geometry_found: !!parcel.geometry
        })
      }

      // Get development controls for the zone from development_matrix
      const matrixQuery = `
        SELECT
          dm.zone_id,
          dm.group_id,
          dm.permission_code,
          dm.conditions,
          dm.max_units,
          dm.max_height_meters,
          dm.min_lot_size_sqm,
          lug.group_code,
          lug.description AS group_description,
          lug.group_category,
          pt.description AS permission_description
        FROM development_matrix dm
        JOIN land_use_groups lug ON dm.group_id = lug.group_id
        JOIN permission_types pt ON dm.permission_code = pt.permission_code
        WHERE dm.zone_id = $1 AND dm.is_active = TRUE AND lug.is_active = TRUE
        ORDER BY lug.group_code
      `

      const { rows: matrixRows } = await fastify.pg.query(matrixQuery, [zoneId])

      // Group by permission type
      const permittedUses = matrixRows.filter(row => row.permission_code === 'P').map(row => ({
        group_code: row.group_code,
        description: row.group_description,
        category: row.group_category,
        conditions: row.conditions,
        max_units: row.max_units,
        max_height_meters: row.max_height_meters,
        min_lot_size_sqm: row.min_lot_size_sqm
      }))

      const prohibitedUses = matrixRows.filter(row => row.permission_code === 'X').map(row => ({
        group_code: row.group_code,
        description: row.group_description,
        category: row.group_category,
        conditions: row.conditions,
        max_units: row.max_units,
        max_height_meters: row.max_height_meters,
        min_lot_size_sqm: row.min_lot_size_sqm
      }))

      const consentRequiredUses = matrixRows.filter(row => row.permission_code === 'SC').map(row => ({
        group_code: row.group_code,
        description: row.group_description,
        category: row.group_category,
        conditions: row.conditions,
        max_units: row.max_units,
        max_height_meters: row.max_height_meters,
        min_lot_size_sqm: row.min_lot_size_sqm
      }))

      const response = {
        parcel: {
          parcel_id: parcel.parcel_id,
          stand_number: parcel.stand_number,
          township_name: parcel.township_name,
          original_zone_id: parcel.original_zone_id,
          geometry_available: !!parcel.geometry
        },
        zone: zoneInfo,
        development_summary: {
          permitted_count: permittedUses.length,
          prohibited_count: prohibitedUses.length,
          consent_required_count: consentRequiredUses.length
        },
        permitted_uses: permittedUses,
        prohibited_uses: prohibitedUses,
        consent_required_uses: consentRequiredUses
      }

      return { success: true, data: response }

    } catch (error) {
      console.error('Error fetching permitted uses:', error)
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch permitted uses',
        details: (error as Error).message
      })
    }
  })

  // ============================================
  // APPLICATIONS
  // ============================================

  // GET /api/development-control/applications
  fastify.get('/applications', async (request, reply) => {
    const { parcel_id, status } = request.query as any
    
    let query = `
      SELECT 
        da.application_id,
        da.application_number,
        da.status,
        da.date_submitted,
        da.description,
        f.gid AS parcel_id,
        f.stand_number,
        f.township_name,
        g.group_code AS proposed_use_code
      FROM development_applications da
      JOIN gweru_rural_farms f ON da.parcel_id = f.gid
      LEFT JOIN land_use_groups g ON da.proposed_land_use_group_id = g.group_id
      WHERE 1=1
    `
    const params: any[] = []
    
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
  fastify.post('/applications', async (request, reply) => {
    const { parcel_id, proposed_use_code, description, application_type = 'building_permit' } = request.body as any
    
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
  fastify.get('/dashboard', async (request, reply) => {
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
      SELECT z.name, COUNT(f.ogc_fid) AS parcel_count
      FROM proposed_peri_urban_zones z
      LEFT JOIN gweru_rural_farms f ON z.id = f.zone_id
      WHERE z.is_active = TRUE
      GROUP BY z.id, z.name
      ORDER BY z.display_order
    `)
    
    return { success: true, data: { summary: stats[0], zones } }
  })
}
