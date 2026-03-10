// ============================================
// Fastify Routes: Development Control Matrix
// REFACTORED to use proposed_peri_urban_zones
// ============================================

async function developmentControlRoutes(fastify) {

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

  // GET /api/development-control/groups
  fastify.get('/groups', async (request, reply) => {
    const { rows } = await fastify.pg.query(`
      SELECT group_id, group_code, description, group_category, notes
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
    const { zone_id, group_id, permission_code } = request.query
    
    let query = `
      SELECT 
        dm.matrix_id,
        z.id AS zone_id,
        z.zone_code,
        z.zone AS zone_name,
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
    const params = []
    
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
    const { zone_id, group_code, permission_code, conditions, max_units, max_height_meters, min_lot_size_sqm } = request.body
    
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
          ORDER BY (
            SELECT COUNT(*) 
            FROM development_matrix dm 
            WHERE dm.zone_id = z.id AND dm.is_active = TRUE
          ) DESC
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
      
      // Get all development matrix rules for this zone
      const matrixQuery = `
        SELECT 
          g.group_code,
          g.description AS group_description,
          g.group_category,
          p.permission_code,
          p.description AS permission_description,
          p.color AS permission_color,
          dm.conditions,
          dm.max_units,
          dm.max_height_meters,
          dm.min_lot_size_sqm
        FROM development_matrix dm
        JOIN land_use_groups g ON dm.group_id = g.group_id
        JOIN permission_types p ON dm.permission_code = p.permission_code
        WHERE dm.zone_id = $1 AND dm.is_active = TRUE
        ORDER BY g.group_category, g.group_code
      `
      
      console.log(`🔍 Querying development matrix for zone_id: ${zone.zone_id}`)
      const { rows: matrixRows } = await fastify.pg.query(matrixQuery, [zone.zone_id])
      console.log(`📊 Found ${matrixRows.length} development rules for ${zone.zone_name}`)
      
      // Group by permission type
      const permitted = []
      const prohibited = []
      const consentRequired = []
      
      matrixRows.forEach(row => {
        const useInfo = {
          group_code: row.group_code,
          description: row.group_description,
          category: row.group_category,
          conditions: row.conditions,
          max_units: row.max_units,
          max_height_meters: row.max_height_meters,
          min_lot_size_sqm: row.min_lot_size_sqm
        }
        
        switch (row.permission_code) {
          case 'P':
            permitted.push(useInfo)
            break
          case 'X':
            prohibited.push(useInfo)
            break
          case 'SC':
            consentRequired.push(useInfo)
            break
        }
      })
      
      return { 
        success: true, 
        data: {
          parcel: parcel,
          zone: {
            zone_id: parcel.zone_id,
            zone_code: parcel.zone_code,
            zone_name: parcel.zone_name
          },
          development_summary: {
            permitted_count: permitted.length,
            prohibited_count: prohibited.length,
            consent_required_count: consentRequired.length
          },
          permitted_uses: permitted,
          prohibited_uses: prohibited,
          consent_required_uses: consentRequired
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

  // POST /api/development-control/update-compliance
  fastify.post('/update-compliance', async (request, reply) => {
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
  fastify.put('/parcels/:parcelId/zone', async (request, reply) => {
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
  fastify.get('/applications', async (request, reply) => {
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
  fastify.post('/applications', async (request, reply) => {
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
  fastify.post('/applicants', async (request, reply) => {
    const { surname, other_names, company_name, postal_address, telephone, email, is_company } = request.body
    
    const { rows } = await fastify.pg.query(`
      INSERT INTO applicants (surname, other_names, company_name, postal_address, telephone, email, is_company)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING applicant_id, surname, company_name, created_at
    `, [surname, other_names, company_name, postal_address, telephone, email, is_company || false])
    
    return { success: true, data: rows[0] }
  })

  // POST /api/development-control/owners - Create owner
  fastify.post('/owners', async (request, reply) => {
    const { surname, other_names, company_name, postal_address, telephone, email, is_company } = request.body
    
    const { rows } = await fastify.pg.query(`
      INSERT INTO owners (surname, other_names, company_name, postal_address, telephone, email, is_company)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING owner_id, surname, company_name, created_at
    `, [surname, other_names, company_name, postal_address, telephone, email, is_company || false])
    
    return { success: true, data: rows[0] }
  })

  // POST /api/development-control/agents - Create agent
  fastify.post('/agents', async (request, reply) => {
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
  fastify.post('/tpd1-applications', async (request, reply) => {
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
  fastify.post('/applications/:id/validate', async (request, reply) => {
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
  fastify.get('/applications/:id/summary', async (request, reply) => {
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
