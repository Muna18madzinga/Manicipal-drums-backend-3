// ============================================
// Fastify Routes: Development Control Matrix
// File: backend/src/routes/development-control.ts
// ============================================

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'

// Types for request parameters
interface ParcelParams {
  parcelId: string
}

interface ComplianceBody {
  proposedUseCode: string
  user?: string
}

interface ApplicationBody {
  parcel_id: number
  proposed_land_use_group_code: string
  description: string
  application_type?: string
  estimated_cost?: number
  floor_area_sqm?: number
  number_of_units?: number
  building_height_meters?: number
}

export default async function developmentControlRoutes(fastify: FastifyInstance) {

  // ============================================
  // LAND USE ZONES
  // ============================================

  // GET /api/development-control/zones
  // List all land use zones
  fastify.get('/zones', {
    schema: {
      description: 'Get all land use zones',
      tags: ['Development Control'],
      querystring: {
        type: 'object',
        properties: {
          local_authority_id: { type: 'string' },
          zone_type: { type: 'string' }, // agricultural, residential, etc.
        }
      }
    }
  }, async (request, reply) => {
    const { local_authority_id, zone_type } = request.query as any
    
    let query = `
      SELECT 
        zone_id,
        zone_code,
        description,
        detailed_description,
        zone_type,
        display_order,
        map_color,
        la.code AS local_authority_code,
        la.name AS local_authority_name
      FROM land_use_zones z
      JOIN local_authorities la ON z.local_authority_id = la.authority_id
      WHERE z.is_active = TRUE
    `
    const params: any[] = []
    
    if (local_authority_id) {
      params.push(local_authority_id)
      query += ` AND z.local_authority_id = $${params.length}`
    }
    
    if (zone_type) {
      params.push(zone_type)
      query += ` AND z.zone_type = $${params.length}`
    }
    
    query += ` ORDER BY z.display_order, z.zone_code`
    
    const { rows } = await fastify.pg.query(query, params)
    return { success: true, data: rows }
  })

  // GET /api/development-control/zones/:zoneId
  fastify.get('/zones/:zoneId', {
    schema: {
      description: 'Get zone details with full matrix',
      tags: ['Development Control'],
      params: {
        type: 'object',
        properties: {
          zoneId: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Params: { zoneId: string } }>, reply) => {
    const { zoneId } = request.params
    
    // Get zone details
    const zoneQuery = `
      SELECT z.*, la.code AS local_authority_code, la.name AS local_authority_name
      FROM land_use_zones z
      JOIN local_authorities la ON z.local_authority_id = la.authority_id
      WHERE z.zone_id = $1
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

  // ============================================
  // LAND USE GROUPS
  // ============================================

  // GET /api/development-control/groups
  fastify.get('/groups', {
    schema: {
      description: 'Get all land use groups (A, B, C, etc.)',
      tags: ['Development Control']
    }
  }, async (request, reply) => {
    const query = `
      SELECT 
        group_id,
        group_code,
        description,
        short_name,
        group_category,
        typical_floor_area_sqm,
        typical_height_meters,
        notes
      FROM land_use_groups
      WHERE is_active = TRUE
      ORDER BY group_code
    `
    const { rows } = await fastify.pg.query(query)
    return { success: true, data: rows }
  })

  // ============================================
  // DEVELOPMENT MATRIX
  // ============================================

  // GET /api/development-control/matrix
  // Query the development matrix with filters
  fastify.get('/matrix', {
    schema: {
      description: 'Query development control matrix (P/X/SC rules)',
      tags: ['Development Control'],
      querystring: {
        type: 'object',
        properties: {
          zone_id: { type: 'string' },
          group_id: { type: 'string' },
          permission_code: { type: 'string', enum: ['P', 'X', 'SC'] },
          local_authority_id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { zone_id, group_id, permission_code, local_authority_id } = request.query as any
    
    let query = `
      SELECT 
        dm.matrix_id,
        z.zone_code,
        z.description AS zone_description,
        z.zone_type,
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
        dm.min_lot_size_sqm,
        dm.legal_reference,
        dm.effective_date,
        dm.expiry_date
      FROM development_matrix dm
      JOIN land_use_zones z ON dm.zone_id = z.zone_id
      JOIN land_use_groups g ON dm.group_id = g.group_id
      JOIN permission_types p ON dm.permission_code = p.permission_code
      JOIN local_authorities la ON z.local_authority_id = la.authority_id
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
    
    if (local_authority_id) {
      params.push(local_authority_id)
      query += ` AND z.local_authority_id = $${params.length}`
    }
    
    query += ` ORDER BY z.display_order, g.group_code`
    
    const { rows } = await fastify.pg.query(query, params)
    return { success: true, count: rows.length, data: rows }
  })

  // ============================================
  // COMPLIANCE CHECKING (CORE FEATURE)
  // ============================================

  // POST /api/development-control/compliance-check
  // Check if a proposed development is permitted on a parcel
  fastify.post('/compliance-check', {
    schema: {
      description: 'Check development permission for a parcel',
      tags: ['Development Control'],
      body: {
        type: 'object',
        required: ['parcelId', 'proposedUseCode'],
        properties: {
          parcelId: { type: 'string' },
          proposedUseCode: { type: 'string' }, // 'A', 'B', 'C', etc.
          user: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: ComplianceBody & { parcelId: string } }>, reply) => {
    const { parcelId, proposedUseCode, user } = request.body
    
    try {
      // Use the PostgreSQL function for compliance check
      const { rows } = await fastify.pg.query(
        'SELECT * FROM check_development_permission($1, $2)',
        [parseInt(parcelId), proposedUseCode]
      )
      
      if (rows.length === 0) {
        return reply.status(404).send({ 
          success: false, 
          error: 'Parcel not found or not linked to development matrix' 
        })
      }
      
      const result = rows[0]
      
      return { 
        success: true, 
        data: {
          parcel_id: parcelId,
          proposed_use_code: proposedUseCode,
          can_develop: result.can_develop,
          permission: {
            code: result.permission_code,
            description: result.permission_description,
            color: result.permission_color
          },
          zone: {
            code: result.zone_code,
            description: result.zone_description
          },
          current_use: result.current_use_code,
          proposed_use: {
            code: result.proposed_use_code,
            description: result.proposed_use_description
          },
          conditions: result.conditions,
          restrictions: result.restrictions,
          compliance_status: result.compliance_status
        }
      }
    } catch (error) {
      fastify.log.error(error)
      return reply.status(500).send({ 
        success: false, 
        error: 'Compliance check failed',
        details: (error as Error).message 
      })
    }
  })

  // POST /api/development-control/update-compliance
  // Update parcel compliance status
  fastify.post('/update-compliance', {
    schema: {
      description: 'Update parcel compliance status',
      tags: ['Development Control'],
      body: {
        type: 'object',
        required: ['parcelId', 'proposedUseCode'],
        properties: {
          parcelId: { type: 'string' },
          proposedUseCode: { type: 'string' },
          user: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: ComplianceBody & { parcelId: string } }>, reply) => {
    const { parcelId, proposedUseCode, user } = request.body
    
    try {
      const { rows } = await fastify.pg.query(
        'SELECT update_parcel_compliance($1, $2, $3) AS result',
        [parseInt(parcelId), proposedUseCode, user || 'api']
      )
      
      return { 
        success: true, 
        data: rows[0].result 
      }
    } catch (error) {
      fastify.log.error(error)
      return reply.status(500).send({ 
        success: false, 
        error: 'Failed to update compliance',
        details: (error as Error).message 
      })
    }
  })

  // GET /api/development-control/parcel-matrix/:parcelId
  // Get full compliance matrix for a parcel (all possible uses)
  fastify.get('/parcel-matrix/:parcelId', {
    schema: {
      description: 'Get full development matrix for a parcel',
      tags: ['Development Control'],
      params: {
        type: 'object',
        properties: {
          parcelId: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Params: { parcelId: string } }>, reply) => {
    const { parcelId } = request.params
    
    try {
      const { rows } = await fastify.pg.query(
        'SELECT * FROM get_parcel_full_matrix($1)',
        [parseInt(parcelId)]
      )
      
      return { 
        success: true, 
        count: rows.length,
        data: rows 
      }
    } catch (error) {
      fastify.log.error(error)
      return reply.status(500).send({ 
        success: false, 
        error: 'Failed to retrieve parcel matrix',
        details: (error as Error).message 
      })
    }
  })

  // ============================================
  // PARCELS WITH COMPLIANCE
  // ============================================

  // GET /api/development-control/parcels
  // Get gweru_rural_farms with compliance info
  fastify.get('/parcels', {
    schema: {
      description: 'Get parcels with development control compliance info',
      tags: ['Development Control'],
      querystring: {
        type: 'object',
        properties: {
          zone_id: { type: 'string' },
          compliance_status: { type: 'string', enum: ['compliant', 'non_compliant', 'special_consent_required', 'pending_review'] },
          township: { type: 'string' },
          bbox: { type: 'string' }, // 'xmin,ymin,xmax,ymax'
          include_geometry: { type: 'boolean', default: true }
        }
      }
    }
  }, async (request, reply) => {
    const { zone_id, compliance_status, township, bbox, include_geometry } = request.query as any
    
    let query = `
      SELECT 
        f.ogc_fid AS parcel_id,
        f.stand_number,
        f.township_name,
        z.zone_code,
        z.description AS zone_description,
        g.group_code AS current_use_code,
        g.description AS current_use_description,
        f.compliance_status,
        f.development_notes,
        f.last_compliance_check,
        ST_Area(f.geom) / 10000 AS area_hectares,
        ST_Area(f.geom) AS area_sqm
        ${include_geometry ? ', ST_AsGeoJSON(f.geom) AS geometry' : ''}
      FROM gweru_rural_farms f
      LEFT JOIN land_use_zones z ON f.zone_id = z.zone_id
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
    
    if (township) {
      params.push(`%${township}%`)
      query += ` AND f.township_name ILIKE $${params.length}`
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

  // PUT /api/development-control/parcels/:parcelId/zone
  // Update parcel zone assignment
  fastify.put('/parcels/:parcelId/zone', {
    schema: {
      description: 'Update parcel zone assignment',
      tags: ['Development Control'],
      params: {
        type: 'object',
        properties: {
          parcelId: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        required: ['zone_id'],
        properties: {
          zone_id: { type: 'string' },
          user: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Params: { parcelId: string }, Body: { zone_id: string, user?: string } }>, reply) => {
    const { parcelId } = request.params
    const { zone_id, user } = request.body
    
    try {
      const updateQuery = `
        UPDATE gweru_rural_farms
        SET 
          zone_id = $1,
          compliance_status = 'pending_review',
          development_notes = COALESCE(development_notes, '') || E'\n[' || NOW() || '] Zone updated to ' || $1 || ' by ' || COALESCE($3, 'api'),
          last_compliance_check = NOW()
        WHERE ogc_fid = $2
        RETURNING ogc_fid, stand_number, zone_id
      `
      const { rows } = await fastify.pg.query(updateQuery, [zone_id, parseInt(parcelId), user])
      
      if (rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Parcel not found' })
      }
      
      return { success: true, data: rows[0] }
    } catch (error) {
      fastify.log.error(error)
      return reply.status(500).send({ 
        success: false, 
        error: 'Failed to update parcel zone',
        details: (error as Error).message 
      })
    }
  })

  // ============================================
  // DEVELOPMENT APPLICATIONS
  // ============================================

  // GET /api/development-control/applications
  fastify.get('/applications', {
    schema: {
      description: 'Get development applications',
      tags: ['Development Control'],
      querystring: {
        type: 'object',
        properties: {
          parcel_id: { type: 'string' },
          status: { type: 'string' },
          application_type: { type: 'string' },
          date_from: { type: 'string' },
          date_to: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { parcel_id, status, application_type, date_from, date_to } = request.query as any
    
    let query = `
      SELECT 
        da.*,
        f.stand_number,
        f.township_name,
        g.group_code AS proposed_use_code,
        g.description AS proposed_use_description
      FROM development_applications da
      JOIN gweru_rural_farms f ON da.parcel_id = f.ogc_fid
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
    
    if (application_type) {
      params.push(application_type)
      query += ` AND da.application_type = $${params.length}`
    }
    
    if (date_from) {
      params.push(date_from)
      query += ` AND da.date_submitted >= $${params.length}`
    }
    
    if (date_to) {
      params.push(date_to)
      query += ` AND da.date_submitted <= $${params.length}`
    }
    
    query += ` ORDER BY da.date_submitted DESC`
    
    const { rows } = await fastify.pg.query(query, params)
    return { success: true, count: rows.length, data: rows }
  })

  // POST /api/development-control/applications
  // Submit new development application
  fastify.post('/applications', {
    schema: {
      description: 'Submit new development application',
      tags: ['Development Control'],
      body: {
        type: 'object',
        required: ['parcel_id', 'proposed_land_use_group_code', 'description'],
        properties: {
          parcel_id: { type: 'number' },
          proposed_land_use_group_code: { type: 'string' },
          description: { type: 'string' },
          application_type: { type: 'string', default: 'building_permit' },
          estimated_cost: { type: 'number' },
          floor_area_sqm: { type: 'number' },
          number_of_units: { type: 'number' },
          building_height_meters: { type: 'number' },
          submitted_by: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: ApplicationBody }>, reply) => {
    const {
      parcel_id,
      proposed_land_use_group_code,
      description,
      application_type = 'building_permit',
      estimated_cost,
      floor_area_sqm,
      number_of_units,
      building_height_meters,
      submitted_by
    } = request.body
    
    const client = await fastify.pg.connect()
    
    try {
      await client.query('BEGIN')
      
      // Get local authority for parcel
      const { rows: parcelRows } = await client.query(
        'SELECT authority_id, zone_id FROM gweru_rural_farms WHERE ogc_fid = $1',
        [parcel_id]
      )
      
      if (parcelRows.length === 0) {
        await client.query('ROLLBACK')
        return reply.status(404).send({ success: false, error: 'Parcel not found' })
      }
      
      const { authority_id, zone_id } = parcelRows[0]
      
      // Get group_id from code
      const { rows: groupRows } = await client.query(
        'SELECT group_id FROM land_use_groups WHERE group_code = $1 AND is_active = TRUE',
        [proposed_land_use_group_code]
      )
      
      if (groupRows.length === 0) {
        await client.query('ROLLBACK')
        return reply.status(400).send({ success: false, error: 'Invalid land use group code' })
      }
      
      const proposed_land_use_group_id = groupRows[0].group_id
      
      // Check compliance before creating application
      const { rows: complianceRows } = await client.query(
        'SELECT * FROM check_development_permission($1, $2)',
        [parcel_id, proposed_land_use_group_code]
      )
      
      const compliance = complianceRows[0]
      
      // Generate application number
      const year = new Date().getFullYear()
      const { rows: countRows } = await client.query(
        "SELECT COUNT(*) as count FROM development_applications WHERE application_number LIKE $1",
        [`GRDC/${year}/%`]
      )
      const sequence = parseInt(countRows[0].count) + 1
      const application_number = `GRDC/${year}/${sequence.toString().padStart(3, '0')}`
      
      // Insert application
      const insertQuery = `
        INSERT INTO development_applications (
          application_number,
          local_authority_id,
          parcel_id,
          proposed_land_use_group_id,
          proposed_zone_id,
          description,
          application_type,
          estimated_cost,
          floor_area_sqm,
          number_of_units,
          building_height_meters,
          matrix_permission_code,
          compliance_check_passed,
          compliance_conditions,
          submitted_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING application_id, application_number, status
      `
      
      const { rows: appRows } = await client.query(insertQuery, [
        application_number,
        authority_id,
        parcel_id,
        proposed_land_use_group_id,
        zone_id,
        description,
        application_type,
        estimated_cost,
        floor_area_sqm,
        number_of_units,
        building_height_meters,
        compliance.permission_code,
        compliance.can_develop,
        compliance.conditions,
        submitted_by || 'system'
      ])
      
      await client.query('COMMIT')
      
      return { 
        success: true, 
        data: {
          application: appRows[0],
          compliance: {
            can_develop: compliance.can_develop,
            permission_code: compliance.permission_code,
            permission_description: compliance.permission_description,
            conditions: compliance.conditions
          }
        }
      }
    } catch (error) {
      await client.query('ROLLBACK')
      fastify.log.error(error)
      return reply.status(500).send({ 
        success: false, 
        error: 'Failed to create application',
        details: (error as Error).message 
      })
    } finally {
      client.release()
    }
  })

  // PUT /api/development-control/applications/:applicationId/status
  fastify.put('/applications/:applicationId/status', {
    schema: {
      description: 'Update application status',
      tags: ['Development Control'],
      params: {
        type: 'object',
        properties: {
          applicationId: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { 
            type: 'string', 
            enum: ['under_review', 'site_inspection', 'committee_review', 'approved_with_conditions', 'approved', 'rejected', 'withdrawn']
          },
          reason: { type: 'string' },
          conditions: { type: 'string' },
          changed_by: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ 
    Params: { applicationId: string },
    Body: { status: string, reason?: string, conditions?: string, changed_by?: string }
  }>, reply) => {
    const { applicationId } = request.params
    const { status, reason, conditions, changed_by } = request.body
    
    try {
      const updateQuery = `
        UPDATE development_applications
        SET 
          status = $1,
          decision_conditions = COALESCE(decision_conditions, '') || E'\n[' || NOW() || '] ' || COALESCE($3, ''),
          ${status === 'approved' || status === 'approved_with_conditions' ? 'date_decided = NOW(),' : ''}
          ${status === 'rejected' ? 'date_decided = NOW(),' : ''}
          updated_at = NOW()
        WHERE application_id = $2
        RETURNING application_id, application_number, status, date_decided
      `
      
      const { rows } = await fastify.pg.query(updateQuery, [status, applicationId, conditions])
      
      if (rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Application not found' })
      }
      
      return { success: true, data: rows[0] }
    } catch (error) {
      fastify.log.error(error)
      return reply.status(500).send({ 
        success: false, 
        error: 'Failed to update application status',
        details: (error as Error).message 
      })
    }
  })

  // ============================================
  // DASHBOARD & REPORTS
  // ============================================

  // GET /api/development-control/dashboard
  fastify.get('/dashboard', {
    schema: {
      description: 'Get development control dashboard stats',
      tags: ['Development Control']
    }
  }, async (request, reply) => {
    // Get summary statistics
    const statsQuery = `
      SELECT 
        (SELECT COUNT(*) FROM gweru_rural_farms) AS total_parcels,
        (SELECT COUNT(*) FROM gweru_rural_farms WHERE zone_id IS NOT NULL) AS zoned_parcels,
        (SELECT COUNT(*) FROM gweru_rural_farms WHERE compliance_status = 'compliant') AS compliant_parcels,
        (SELECT COUNT(*) FROM gweru_rural_farms WHERE compliance_status = 'non_compliant') AS non_compliant_parcels,
        (SELECT COUNT(*) FROM gweru_rural_farms WHERE compliance_status = 'special_consent_required') AS sc_required_parcels,
        (SELECT COUNT(*) FROM development_applications WHERE status NOT IN ('approved', 'rejected', 'withdrawn')) AS active_applications,
        (SELECT COUNT(*) FROM development_applications WHERE date_submitted >= CURRENT_DATE - INTERVAL '30 days') AS recent_applications
    `
    
    const { rows: statsRows } = await fastify.pg.query(statsQuery)
    
    // Get zone distribution
    const zoneQuery = `
      SELECT 
        z.zone_code,
        z.description,
        COUNT(f.ogc_fid) AS parcel_count
      FROM land_use_zones z
      LEFT JOIN gweru_rural_farms f ON z.zone_id = f.zone_id
      WHERE z.is_active = TRUE
      GROUP BY z.zone_id, z.zone_code, z.description
      ORDER BY z.display_order
    `
    
    const { rows: zoneRows } = await fastify.pg.query(zoneQuery)
    
    // Get recent applications
    const recentAppsQuery = `
      SELECT 
        da.application_id,
        da.application_number,
        da.status,
        da.date_submitted,
        f.stand_number,
        f.township_name
      FROM development_applications da
      JOIN gweru_rural_farms f ON da.parcel_id = f.ogc_fid
      ORDER BY da.date_submitted DESC
      LIMIT 10
    `
    
    const { rows: recentApps } = await fastify.pg.query(recentAppsQuery)
    
    return { 
      success: true, 
      data: {
        summary: statsRows[0],
        zone_distribution: zoneRows,
        recent_applications: recentApps
      }
    }
  })
}
