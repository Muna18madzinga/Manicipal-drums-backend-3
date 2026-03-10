// Enhanced Land Use Management Routes
// Supports dynamic zone-land use relationships with three-tier development control

const { Pool } = require('pg');

// Initialize route
async function landUseManagementRoutes(fastify, { auth }) {
  const pool = fastify.pg.pool;

  // ============================================
  // Land Use Groups Management
  // ============================================

  // Get all land use groups with optional filtering
  fastify.get('/groups', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          development_category: { type: 'string', enum: ['permitted', 'prohibited', 'special_consent'] },
          use_scale: { type: 'string', enum: ['small_scale', 'large_scale', 'mixed_scale', 'all_scales'] },
          is_active: { type: 'boolean' }
        }
      }
    },
    preHandler: auth.requireAuth
  }, async (request, reply) => {
    try {
      const { development_category, use_scale, is_active, page = 1, limit = 20 } = request.query;
      
      let query = `
        SELECT 
          lug.group_id,
          lug.group_code,
          lug.description,
          lug.group_category,
          lug.development_category,
          lug.use_scale,
          lug.notes,
          lug.is_active,
          lug.created_at,
          COUNT(zlc.id) as land_use_controls_count
        FROM land_use_groups lug
        LEFT JOIN zone_land_use_controls zlc ON lug.group_id = zlc.land_use_group_id
        WHERE 1=1
      `;
      
      const params = [];
      const values = [];
      let paramIndex = 1;
      
      if (development_category) {
        query += ` AND lug.development_category = $${paramIndex++}`;
        params.push(development_category);
        values.push(development_category);
      }
      
      if (use_scale) {
        query += ` AND lug.use_scale = $${paramIndex++}`;
        params.push(use_scale);
        values.push(use_scale);
      }
      
      if (is_active !== undefined) {
        query += ` AND lug.is_active = $${paramIndex++}`;
        params.push(is_active);
        values.push(is_active === 'true' ? true : false);
      }
      
      query += ` GROUP BY lug.group_id, lug.group_code, lug.description, lug.group_category, lug.development_category, lug.use_scale, lug.notes, lug.is_active, lug.created_at`;
      query += ` ORDER BY lug.group_category, lug.group_code`;
      
      // Add pagination
      const offset = (page - 1) * limit;
      query += ` LIMIT $${limit} OFFSET $${offset}`;
      
      const result = await pool.query(query, values);
      
      const countQuery = `
        SELECT COUNT(*) as total
        FROM land_use_groups lug
        WHERE 1=1
      `;
      
      if (development_category) countQuery += ` AND lug.development_category = $${paramIndex++}`;
      if (use_scale) countQuery += ` AND lug.use_scale = $${paramIndex++}`;
      if (is_active !== undefined) countQuery += ` AND lug.is_active = $${paramIndex++}`;
      
      const countResult = await pool.query(countQuery, values.slice(0, paramIndex - 1));
      
      return reply.send({
        success: true,
        data: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(countResult.rows[0].total),
          totalPages: Math.ceil(countResult.rows[0].total / limit)
        }
      });
      
    } catch (error) {
      fastify.log.error('Land use groups query error:', error);
      reply.code(500).send({ error: 'Failed to fetch land use groups' });
    }
  });

  // Create new land use group
  fastify.post('/groups', {
    schema: {
      body: {
        type: 'object',
        properties: {
          group_code: { type: 'string', minLength: 1, maxLength: 10 },
          description: { type: 'string', minLength: 1, maxLength: 200 },
          group_category: { type: 'string', enum: ['residential', 'agricultural', 'commercial', 'institutional', 'industrial'] },
          development_category: { type: 'string', enum: ['permitted', 'prohibited', 'special_consent'] },
          use_scale: { type: 'string', enum: ['small_scale', 'large_scale', 'mixed_scale', 'all_scales'] },
          notes: { type: 'string' }
        }
      }
    },
    preHandler: auth.requireAuth
  }, async (request, reply) => {
    try {
      const { group_code, description, group_category, development_category, use_scale, notes } = request.body;
      const userId = request.user.id;
      
      const result = await pool.query(`
        INSERT INTO land_use_groups (group_code, description, group_category, development_category, use_scale, notes, is_active, created_at, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
        RETURNING *
      `, [group_code, description, group_category, development_category, use_scale, notes, true, userId]);
      
      reply.send({
        success: true,
        data: result.rows[0],
        message: 'Land use group created successfully'
      });
      
    } catch (error) {
      fastify.log.error('Create land use group error:', error);
      reply.code(500).send({ error: 'Failed to create land use group' });
    }
  });

  // Update land use group
  fastify.put('/groups/:id', {
    schema: {
      params: { id: { type: 'string', format: 'uuid' } },
      body: {
        type: 'object',
        properties: {
          group_code: { type: 'string', minLength: 1, maxLength: 10 },
          description: { type: 'string', minLength: 1, maxLength: 200 },
          group_category: { type: 'string', enum: ['residential', 'agricultural', 'commercial', 'institutional', 'industrial'] },
          development_category: { type: 'string', enum: ['permitted', 'prohibited', 'special_consent'] },
          use_scale: { type: 'string', enum: ['small_scale', 'large_scale', 'mixed_scale', 'all_scales'] },
          notes: { type: 'string' }
        }
      }
    },
    preHandler: auth.requireAuth
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { group_code, description, group_category, development_category, use_scale, notes } = request.body;
      const userId = request.user.id;
      
      const result = await pool.query(`
        UPDATE land_use_groups 
        SET group_code = $1, description = $2, group_category = $3, development_category = $4, use_scale = $5, notes = $6, updated_at = NOW(), updated_by = $7
        WHERE group_id = $8
        RETURNING *
      `, [group_code, description, group_category, development_category, use_scale, notes, userId, id]);
      
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Land use group not found' });
      }
      
      reply.send({
        success: true,
        data: result.rows[0],
        message: 'Land use group updated successfully'
      });
      
    } catch (error) {
      fastify.log.error('Update land use group error:', error);
      reply.code(500).send({ error: 'Failed to update land use group' });
    }
  });

  // Delete land use group
  fastify.delete('/groups/:id', {
    schema: {
      params: { id: { type: 'string', format: 'uuid' } }
    },
    preHandler: auth.requireAuth
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      
      // Check if group is being used in zone controls
      const usageCheck = await pool.query(
        'SELECT COUNT(*) as count FROM zone_land_use_controls WHERE land_use_group_id = $1',
        [id]
      );
      
      if (parseInt(usageCheck.rows[0].count) > 0) {
        return reply.code(400).send({ 
          error: 'Cannot delete land use group that is being used in zone controls',
          usage_count: parseInt(usageCheck.rows[0].count)
        });
      }
      
      const result = await pool.query(
        'DELETE FROM land_use_groups WHERE group_id = $1 RETURNING *',
        [id]
      );
      
      reply.send({
        success: true,
        message: 'Land use group deleted successfully'
      });
      
    } catch (error) {
      fastify.log.error('Delete land use group error:', error);
      reply.code(500).send({ error: 'Failed to delete land use group' });
    }
  });

  // ============================================
  // Zone Management (using proposed_peri_urban_zones)
  // ============================================

  // Get all zones with optional filtering
  fastify.get('/zones', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          zone_type: { type: 'string' },
          scale_category: { type: 'string', enum: ['small_scale', 'large_scale', 'mixed_scale'] },
          authority: { type: 'string' }
        }
      }
    },
    preHandler: auth.requireAuth
  }, async (request, reply) => {
    try {
      const { zone_type, scale_category, authority, page = 1, limit = 20 } = request.query;
      
      let query = `
        SELECT 
          puz.id,
          puz.zone as zone_name,
          puz.zone_type,
          puz.scale_category,
          puz.authority,
          COUNT(zlc.id) as land_use_controls_count
        FROM proposed_peri_urban_zones puz
        LEFT JOIN zone_land_use_controls zlc ON puz.id = zlc.zone_id
        WHERE 1=1
      `;
      
      const params = [];
      const values = [];
      let paramIndex = 1;
      
      if (zone_type) {
        query += ` AND puz.zone_type ILIKE $${paramIndex++}`;
        params.push(zone_type);
        values.push(`%${zone_type}%`);
      }
      
      if (scale_category) {
        query += ` AND puz.scale_category = $${paramIndex++}`;
        params.push(scale_category);
        values.push(scale_category);
      }
      
      if (authority) {
        query += ` AND puz.authority = $${paramIndex++}`;
        params.push(authority);
        values.push(authority);
      }
      
      query += ` GROUP BY puz.id, puz.zone, puz.zone_type, puz.scale_category, puz.authority`;
      
      // Add pagination
      const offset = (page - 1) * limit;
      query += ` ORDER BY puz.zone LIMIT $${limit} OFFSET $${offset}`;
      
      const result = await pool.query(query, values);
      
      const countQuery = `
        SELECT COUNT(*) as total
        FROM proposed_peri_urban_zones puz
        WHERE 1=1
      `;
      
      if (zone_type) countQuery += ` AND puz.zone_type ILIKE $${paramIndex++}`;
      if (scale_category) countQuery += ` AND puz.scale_category = $${paramIndex++}`;
      if (authority) countQuery += ` AND puz.authority = $${paramIndex++}`;
      
      const countResult = await pool.query(countQuery, values.slice(0, paramIndex - 1));
      
      return reply.send({
        success: true,
        data: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(countResult.rows[0].total),
          totalPages: Math.ceil(countResult.rows[0].total / limit)
        }
      });
      
    } catch (error) {
      fastify.log.error('Zones query error:', error);
      reply.code(500).send({ error: 'Failed to fetch zones' });
    }
  });

  // Create new zone
  fastify.post('/zones', {
    schema: {
      body: {
        type: 'object',
        properties: {
          zone: { type: 'string', minLength: 1, maxLength: 50 },
          zone_type: { type: 'string', enum: ['Communal Farming Zone', 'High Intensive Commercial Farming Zone', 'Estates Zone (Large Farms)', 'Irrigation Scheme Zone', 'Proposed Peri-Urban Zone'] },
          scale_category: { type: 'string', enum: ['small_scale', 'large_scale', 'mixed_scale'] },
          authority: { type: 'string', maxLength: 100 },
          zone_description: { type: 'string' }
        }
      }
    },
    preHandler: auth.requireAuth
  }, async (request, reply) => {
    try {
      const { zone, zone_type, scale_category, authority, zone_description } = request.body;
      const userId = request.user.id;
      
      const result = await pool.query(`
        INSERT INTO proposed_peri_urban_zones (zone, zone_type, scale_category, authority, zone_description, is_active, created_at, created_by)
        VALUES ($1, $2, $3, $4, $5, true, NOW(), $6)
        RETURNING *
      `, [zone, zone_type, scale_category, authority, zone_description, userId]);
      
      reply.send({
        success: true,
        data: result.rows[0],
        message: 'Zone created successfully'
      });
      
    } catch (error) {
      fastify.log.error('Create zone error:', error);
      reply.code(500).send({ error: 'Failed to create zone' });
    }
  });

  // ============================================
  // Zone-Land Use Controls Management
  // ============================================

  // Get zone-land use controls (SIMPLE VERSION for debugging)
  fastify.get('/controls', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
        }
      }
    }
    // Temporarily removed: preHandler: auth.requireAuth
  }, async (request, reply) => {
    try {
      console.log('🎯 CONTROLS ROUTE CALLED');
      const { page = 1, limit = 20 } = request.query;
      console.log('📄 Request params:', { page, limit });

      // Simple query without JOINs first
      const offset = (page - 1) * limit;
      console.log('🔍 Executing query with limit:', limit, 'offset:', offset);
      
      const result = await pool.query(`
        SELECT * FROM zone_land_use_controls
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]);
      
      console.log('✅ Query successful, rows returned:', result.rows.length);

      const countResult = await pool.query('SELECT COUNT(*) as total FROM zone_land_use_controls');
      console.log('📊 Count query successful, total:', countResult.rows[0].total);

      return reply.send({
        success: true,
        data: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: parseInt(countResult.rows[0].total),
          totalPages: Math.ceil(countResult.rows[0].total / limit)
        }
      });

    } catch (error) {
      console.log('❌ CONTROLS ROUTE ERROR:', error.message);
      fastify.log.error('Zone-land use controls query error:', error);
      reply.code(500).send({ error: 'Failed to fetch zone-land use controls' });
    }
  });

  // Create zone-land use control
  fastify.post('/controls', {
    schema: {
      body: {
        type: 'object',
        properties: {
          zone_id: { type: 'string', format: 'uuid' },
          land_use_group_id: { type: 'string', format: 'uuid' },
          control_type: { type: 'string', enum: ['permitted', 'prohibited', 'special_consent'] },
          authority: { type: 'string', maxLength: 100 },
          conditions: { type: 'string' }
        }
      }
    },
    preHandler: auth.requireAuth
  }, async (request, reply) => {
    try {
      const { zone_id, land_use_group_id, control_type, authority, conditions } = request.body;
      const userId = request.user.id;
      
      // Check if this combination already exists
      const existingCheck = await pool.query(
        'SELECT COUNT(*) as count FROM zone_land_use_controls WHERE zone_id = $1 AND land_use_group_id = $2 AND control_type = $3 AND authority = COALESCE($4, \'default\')',
        [zone_id, land_use_group_id, control_type, authority]
      );
      
      if (parseInt(existingCheck.rows[0].count) > 0) {
        return reply.code(400).send({ 
          error: 'Zone-land use control already exists for this combination',
          existing: true
        });
      }
      
      const result = await pool.query(`
        INSERT INTO zone_land_use_controls (zone_id, land_use_group_id, control_type, authority, conditions, created_at, created_by)
        VALUES ($1, $2, $3, $4, $5, NOW(), $6)
        RETURNING *
      `, [zone_id, land_use_group_id, control_type, authority, conditions, userId]);
      
      reply.send({
        success: true,
        data: result.rows[0],
        message: 'Zone-land use control created successfully'
      });
      
    } catch (error) {
      fastify.log.error('Create zone-land use control error:', error);
      reply.code(500).send({ error: 'Failed to create zone-land use control' });
    }
  });

  // Update zone-land use control
  fastify.put('/controls/:id', {
    schema: {
      params: { id: { type: 'string', format: 'uuid' } },
      body: {
        type: 'object',
        properties: {
          control_type: { type: 'string', enum: ['permitted', 'prohibited', 'special_consent'] },
          authority: { type: 'string', maxLength: 100 },
          conditions: { type: 'string' }
        }
      }
    },
    preHandler: auth.requireAuth
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { control_type, authority, conditions } = request.body;
      const userId = request.user.id;
      
      const result = await pool.query(`
        UPDATE zone_land_use_controls 
        SET control_type = $1, authority = $2, conditions = $3, updated_at = NOW(), updated_by = $4
        WHERE id = $5
        RETURNING *
      `, [control_type, authority, conditions, userId, id]);
      
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Zone-land use control not found' });
      }
      
      reply.send({
        success: true,
        data: result.rows[0],
        message: 'Zone-land use control updated successfully'
      });
      
    } catch (error) {
      fastify.log.error('Update zone-land use control error:', error);
      reply.code(500).send({ error: 'Failed to update zone-land use control' });
    }
  });

  // Delete zone-land use control
  fastify.delete('/controls/:id', {
    schema: {
      params: { id: { type: 'string', format: 'uuid' } }
    },
    preHandler: auth.requireAuth
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      
      const result = await pool.query(
        'DELETE FROM zone_land_use_controls WHERE id = $1 RETURNING *',
        [id]
      );
      
      reply.send({
        success: true,
        message: 'Zone-land use control deleted successfully'
      });
      
    } catch (error) {
      fastify.log.error('Delete zone-land use control error:', error);
      reply.code(500).send({ error: 'Failed to delete zone-land use control' });
    }
  });

  // ============================================
  // Development Matrix Management (Bonus Feature)
  // ============================================

  // Get development matrix for a specific zone
  fastify.get('/zones/:id/matrix', {
    schema: {
      params: { id: { type: 'string', format: 'uuid' } }
    },
    preHandler: auth.requireAuth
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      
      const result = await pool.query(`
        SELECT 
          puz.id as zone_id,
          puz.zone as zone_name,
          puz.zone_type,
          puz.scale_category,
          puz.authority,
          lug.group_code,
          lug.description,
          lug.group_category,
          lug.development_category,
          lug.use_scale,
          zlc.control_type,
          COUNT(CASE WHEN zlc.control_type = 'permitted' THEN 1 END) as permitted_count,
          COUNT(CASE WHEN zlc.control_type = 'prohibited' THEN 1 END) as prohibited_count,
          COUNT(CASE WHEN zlc.control_type = 'special_consent' THEN 1 END) as special_consent_count,
          COUNT(zlc.id) as total_controls
        FROM proposed_peri_urban_zones puz
        LEFT JOIN zone_land_use_controls zlc ON puz.id = zlc.zone_id
        LEFT JOIN land_use_groups lug ON zlc.land_use_group_id = lug.group_id
        WHERE puz.id = $1
        GROUP BY puz.id, lug.group_code, lug.description, lug.group_category, lug.development_category, lug.use_scale, zlc.control_type
      `, [id]);
      
      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Zone not found' });
      }
      
      // Format as development matrix
      const matrix = {};
      result.rows.forEach(row => {
        if (!matrix[row.zone_name]) {
          matrix[row.zone_name] = {};
        }
        
        matrix[row.zone_name][row.group_code] = {
          group_code: row.group_code,
          description: row.description,
          category: row.group_category,
          development_category: row.development_category,
          use_scale: row.use_scale,
          control_type: row.control_type,
          count: row.total_controls
        };
      });
      
      reply.send({
        success: true,
        data: matrix
      });
      
    } catch (error) {
      fastify.log.error('Development matrix query error:', error);
      reply.code(500).send({ error: 'Failed to fetch development matrix' });
    }
  });

  return fastify;
};

module.exports = landUseManagementRoutes;
