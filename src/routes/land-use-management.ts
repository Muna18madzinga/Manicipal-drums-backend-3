/**
 * Land Use Management API Routes
 * CRUD operations for managing land uses, zones, and development matrix
 */

import { FastifyInstance } from 'fastify'

export default async function landUseManagementRoutes(fastify: FastifyInstance) {
  
  // ============================================
  // LAND USE GROUPS CRUD
  // ============================================

  // GET /api/land-use/groups
  // List all land use groups with pagination and filtering
  fastify.get('/groups', {
    schema: {
      description: 'Get all land use groups',
      tags: ['Land Use Management'],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 50 },
          search: { type: 'string' },
          category: { type: 'string' },
          is_active: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { page = 1, limit = 50, search, category, is_active } = request.query as any
    
    let whereClause = 'WHERE 1=1'
    const params: any[] = []
    let paramIndex = 1
    
    if (search) {
      whereClause += ` AND (group_code ILIKE $${paramIndex} OR description ILIKE $${paramIndex} OR short_name ILIKE $${paramIndex})`
      params.push(`%${search}%`)
      paramIndex++
    }
    
    if (category) {
      whereClause += ` AND group_category = $${paramIndex}`
      params.push(category)
      paramIndex++
    }
    
    if (is_active !== undefined) {
      whereClause += ` AND is_active = $${paramIndex}`
      params.push(is_active)
      paramIndex++
    }
    
    const offset = (page - 1) * limit
    
    // Get total count
    const countQuery = `SELECT COUNT(*) FROM land_use_groups ${whereClause}`
    const { rows: countRows } = await fastify.pg.query(countQuery, params)
    
    // Get data
    const dataQuery = `
      SELECT 
        group_id,
        group_code,
        description,
        short_name,
        group_category,
        typical_floor_area_sqm,
        typical_height_meters,
        notes,
        is_active,
        created_at,
        updated_at
      FROM land_use_groups 
      ${whereClause}
      ORDER BY group_code
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `
    params.push(limit, offset)
    
    const { rows } = await fastify.pg.query(dataQuery, params)
    
    return {
      success: true,
      data: rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countRows[0].count),
        totalPages: Math.ceil(countRows[0].count / limit)
      }
    }
  })

  // GET /api/land-use/groups/:id
  // Get specific land use group
  fastify.get('/groups/:id', {
    schema: {
      description: 'Get specific land use group',
      tags: ['Land Use Management'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as any
    
    const { rows } = await fastify.pg.query(`
      SELECT 
        group_id,
        group_code,
        description,
        short_name,
        group_category,
        typical_floor_area_sqm,
        typical_height_meters,
        notes,
        is_active,
        created_at,
        updated_at
      FROM land_use_groups 
      WHERE group_id = $1
    `, [id])
    
    if (rows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Land use group not found' })
    }
    
    return { success: true, data: rows[0] }
  })

  // POST /api/land-use/groups
  // Create new land use group
  fastify.post('/groups', {
    schema: {
      description: 'Create new land use group',
      tags: ['Land Use Management'],
      body: {
        type: 'object',
        required: ['group_code', 'description', 'group_category'],
        properties: {
          group_code: { type: 'string', minLength: 1, maxLength: 10 },
          description: { type: 'string', minLength: 1, maxLength: 255 },
          short_name: { type: 'string', maxLength: 100 },
          group_category: { type: 'string', enum: ['residential', 'commercial', 'industrial', 'institutional', 'recreational', 'agricultural', 'mixed'] },
          typical_floor_area_sqm: { type: 'number', minimum: 0 },
          typical_height_meters: { type: 'number', minimum: 0 },
          notes: { type: 'string' },
          is_active: { type: 'boolean', default: true }
        }
      }
    }
  }, async (request, reply) => {
    const {
      group_code,
      description,
      short_name,
      group_category,
      typical_floor_area_sqm,
      typical_height_meters,
      notes,
      is_active = true
    } = request.body as any
    
    try {
      const { rows } = await fastify.pg.query(`
        INSERT INTO land_use_groups (
          group_code, description, short_name, group_category,
          typical_floor_area_sqm, typical_height_meters, notes, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [group_code, description, short_name, group_category, typical_floor_area_sqm, typical_height_meters, notes, is_active])
      
      return { success: true, data: rows[0] }
    } catch (error: any) {
      if (error.code === '23505') {
        return reply.status(400).send({ success: false, error: 'Group code already exists' })
      }
      throw error
    }
  })

  // PUT /api/land-use/groups/:id
  // Update land use group
  fastify.put('/groups/:id', {
    schema: {
      description: 'Update land use group',
      tags: ['Land Use Management'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'number' }
        }
      },
      body: {
        type: 'object',
        properties: {
          group_code: { type: 'string', minLength: 1, maxLength: 10 },
          description: { type: 'string', minLength: 1, maxLength: 255 },
          short_name: { type: 'string', maxLength: 100 },
          group_category: { type: 'string', enum: ['residential', 'commercial', 'industrial', 'institutional', 'recreational', 'agricultural', 'mixed'] },
          typical_floor_area_sqm: { type: 'number', minimum: 0 },
          typical_height_meters: { type: 'number', minimum: 0 },
          notes: { type: 'string' },
          is_active: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as any
    const updates = request.body as any
    
    // Check if group exists
    const { rows: existingRows } = await fastify.pg.query(
      'SELECT group_id FROM land_use_groups WHERE group_id = $1',
      [id]
    )
    
    if (existingRows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Land use group not found' })
    }
    
    // Build dynamic update query
    const updateFields = Object.keys(updates).filter(key => updates[key] !== undefined)
    if (updateFields.length === 0) {
      return reply.status(400).send({ success: false, error: 'No fields to update' })
    }
    
    const setClause = updateFields.map((field, index) => `${field} = $${index + 2}`).join(', ')
    const values = [id, ...updateFields.map(field => updates[field])]
    
    try {
      const { rows } = await fastify.pg.query(`
        UPDATE land_use_groups 
        SET ${setClause}, updated_at = CURRENT_TIMESTAMP
        WHERE group_id = $1
        RETURNING *
      `, values)
      
      return { success: true, data: rows[0] }
    } catch (error: any) {
      if (error.code === '23505') {
        return reply.status(400).send({ success: false, error: 'Group code already exists' })
      }
      throw error
    }
  })

  // DELETE /api/land-use/groups/:id
  // Delete land use group (soft delete)
  fastify.delete('/groups/:id', {
    schema: {
      description: 'Delete land use group',
      tags: ['Land Use Management'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as any
    
    // Check if group is being used in development matrix
    const { rows: matrixRows } = await fastify.pg.query(
      'SELECT COUNT(*) FROM development_matrix WHERE group_id = $1 AND is_active = TRUE',
      [id]
    )
    
    if (parseInt(matrixRows[0].count) > 0) {
      return reply.status(400).send({ 
        success: false, 
        error: 'Cannot delete land use group that is being used in development matrix' 
      })
    }
    
    // Soft delete
    const { rows } = await fastify.pg.query(`
      UPDATE land_use_groups 
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE group_id = $1
      RETURNING *
    `, [id])
    
    if (rows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Land use group not found' })
    }
    
    return { success: true, data: rows[0] }
  })

  // ============================================
  // LAND USE ZONES CRUD
  // ============================================

  // GET /api/land-use/zones
  fastify.get('/zones', {
    schema: {
      description: 'Get all land use zones',
      tags: ['Land Use Management'],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number', default: 1 },
          limit: { type: 'number', default: 50 },
          search: { type: 'string' },
          local_authority_id: { type: 'string' },
          is_active: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { page = 1, limit = 50, search, local_authority_id, is_active } = request.query as any
    
    let whereClause = 'WHERE 1=1'
    const params: any[] = []
    let paramIndex = 1
    
    if (search) {
      whereClause += ` AND (zone_code ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`
      params.push(`%${search}%`)
      paramIndex++
    }
    
    if (local_authority_id) {
      whereClause += ` AND local_authority_id = $${paramIndex}`
      params.push(local_authority_id)
      paramIndex++
    }
    
    if (is_active !== undefined) {
      whereClause += ` AND is_active = $${paramIndex}`
      params.push(is_active)
      paramIndex++
    }
    
    const offset = (page - 1) * limit
    
    // Get total count
    const countQuery = `SELECT COUNT(*) FROM land_use_zones ${whereClause}`
    const { rows: countRows } = await fastify.pg.query(countQuery, params)
    
    // Get data
    const dataQuery = `
      SELECT 
        z.zone_id,
        z.zone_code,
        z.description,
        z.zone_type,
        z.local_authority_id,
        z.display_order,
        z.map_color,
        z.is_active,
        z.created_at,
        z.updated_at,
        la.code AS local_authority_code,
        la.name AS local_authority_name
      FROM land_use_zones z
      LEFT JOIN local_authorities la ON z.local_authority_id = la.authority_id
      ${whereClause}
      ORDER BY z.display_order, z.zone_code
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `
    params.push(limit, offset)
    
    const { rows } = await fastify.pg.query(dataQuery, params)
    
    return {
      success: true,
      data: rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countRows[0].count),
        totalPages: Math.ceil(countRows[0].count / limit)
      }
    }
  })

  // ============================================
  // DEVELOPMENT MATRIX CRUD
  // ============================================

  // GET /api/land-use/matrix
  fastify.get('/matrix', {
    schema: {
      description: 'Get development matrix rules',
      tags: ['Land Use Management'],
      querystring: {
        type: 'object',
        properties: {
          zone_id: { type: 'number' },
          group_id: { type: 'number' },
          permission_code: { type: 'string' },
          is_active: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { zone_id, group_id, permission_code, is_active } = request.query as any
    
    let whereClause = 'WHERE 1=1'
    const params: any[] = []
    let paramIndex = 1
    
    if (zone_id) {
      whereClause += ` AND dm.zone_id = $${paramIndex}`
      params.push(zone_id)
      paramIndex++
    }
    
    if (group_id) {
      whereClause += ` AND dm.group_id = $${paramIndex}`
      params.push(group_id)
      paramIndex++
    }
    
    if (permission_code) {
      whereClause += ` AND dm.permission_code = $${paramIndex}`
      params.push(permission_code)
      paramIndex++
    }
    
    if (is_active !== undefined) {
      whereClause += ` AND dm.is_active = $${paramIndex}`
      params.push(is_active)
      paramIndex++
    }
    
    const { rows } = await fastify.pg.query(`
      SELECT 
        dm.matrix_id,
        dm.zone_id,
        dm.group_id,
        dm.permission_code,
        dm.conditions,
        dm.max_units,
        dm.max_height_meters,
        dm.min_lot_size_sqm,
        dm.is_active,
        dm.created_at,
        dm.updated_at,
        z.zone_code,
        z.description AS zone_description,
        g.group_code,
        g.description AS group_description,
        p.description AS permission_description,
        p.color AS permission_color
      FROM development_matrix dm
      JOIN land_use_zones z ON dm.zone_id = z.zone_id
      JOIN land_use_groups g ON dm.group_id = g.group_id
      JOIN permission_types p ON dm.permission_code = p.permission_code
      ${whereClause}
      ORDER BY z.display_order, g.group_code, p.permission_code
    `, params)
    
    return { success: true, data: rows }
  })

  // POST /api/land-use/matrix
  fastify.post('/matrix', {
    schema: {
      description: 'Create development matrix rule',
      tags: ['Land Use Management'],
      body: {
        type: 'object',
        required: ['zone_id', 'group_id', 'permission_code'],
        properties: {
          zone_id: { type: 'number' },
          group_id: { type: 'number' },
          permission_code: { type: 'string' },
          conditions: { type: 'string' },
          max_units: { type: 'number', minimum: 0 },
          max_height_meters: { type: 'number', minimum: 0 },
          min_lot_size_sqm: { type: 'number', minimum: 0 },
          is_active: { type: 'boolean', default: true }
        }
      }
    }
  }, async (request, reply) => {
    const {
      zone_id,
      group_id,
      permission_code,
      conditions,
      max_units,
      max_height_meters,
      min_lot_size_sqm,
      is_active = true
    } = request.body as any
    
    try {
      const { rows } = await fastify.pg.query(`
        INSERT INTO development_matrix (
          zone_id, group_id, permission_code, conditions,
          max_units, max_height_meters, min_lot_size_sqm, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [zone_id, group_id, permission_code, conditions, max_units, max_height_meters, min_lot_size_sqm, is_active])
      
      return { success: true, data: rows[0] }
    } catch (error: any) {
      if (error.code === '23505') {
        return reply.status(400).send({ success: false, error: 'Matrix rule already exists for this combination' })
      }
      throw error
    }
  })

  // PUT /api/land-use/matrix/:id
  fastify.put('/matrix/:id', {
    schema: {
      description: 'Update development matrix rule',
      tags: ['Land Use Management'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'number' }
        }
      },
      body: {
        type: 'object',
        properties: {
          permission_code: { type: 'string' },
          conditions: { type: 'string' },
          max_units: { type: 'number', minimum: 0 },
          max_height_meters: { type: 'number', minimum: 0 },
          min_lot_size_sqm: { type: 'number', minimum: 0 },
          is_active: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as any
    const updates = request.body as any
    
    // Check if matrix rule exists
    const { rows: existingRows } = await fastify.pg.query(
      'SELECT matrix_id FROM development_matrix WHERE matrix_id = $1',
      [id]
    )
    
    if (existingRows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Matrix rule not found' })
    }
    
    // Build dynamic update query
    const updateFields = Object.keys(updates).filter(key => updates[key] !== undefined)
    if (updateFields.length === 0) {
      return reply.status(400).send({ success: false, error: 'No fields to update' })
    }
    
    const setClause = updateFields.map((field, index) => `${field} = $${index + 2}`).join(', ')
    const values = [id, ...updateFields.map(field => updates[field])]
    
    try {
      const { rows } = await fastify.pg.query(`
        UPDATE development_matrix 
        SET ${setClause}, updated_at = CURRENT_TIMESTAMP
        WHERE matrix_id = $1
        RETURNING *
      `, values)
      
      return { success: true, data: rows[0] }
    } catch (error: any) {
      if (error.code === '23505') {
        return reply.status(400).send({ success: false, error: 'Matrix rule already exists for this combination' })
      }
      throw error
    }
  })

  // DELETE /api/land-use/matrix/:id
  fastify.delete('/matrix/:id', {
    schema: {
      description: 'Delete development matrix rule',
      tags: ['Land Use Management'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params as any
    
    // Soft delete
    const { rows } = await fastify.pg.query(`
      UPDATE development_matrix 
      SET is_active = false, updated_at = CURRENT_TIMESTAMP
      WHERE matrix_id = $1
      RETURNING *
    `, [id])
    
    if (rows.length === 0) {
      return reply.status(404).send({ success: false, error: 'Matrix rule not found' })
    }
    
    return { success: true, data: rows[0] }
  })
}
