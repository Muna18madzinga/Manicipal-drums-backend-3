// Enhanced Land Use Management Routes
// Supports dynamic zone-land use relationships with three-tier development control

const { Pool } = require('pg');
const { requireRole } = require('../src/middleware/jwtAuth');

// Initialize route
async function landUseManagementRoutes(fastify, { auth }) {
  console.log('🔍 DEBUG: Starting enhanced land use routes initialization...');
  try {
    const pool = fastify.pg.pool;
    console.log('🔍 DEBUG: Database pool obtained:', !!pool);

    // NOTE: do NOT run a DB query at registration time. Awaiting a query inside
    // Fastify/avvio's boot can exceed the plugin timeout and abort the whole
    // server (AVV_ERR_PLUGIN_EXEC_TIMEOUT). The route handlers below query the
    // pool lazily per-request, which is the correct place for DB access.

    // Writes to zoning / land-use controls require a planning-editor role. The
    // previous `auth` option was never passed by server.js, so these mutations
    // were effectively unauthenticated; this enforces real authorization.
    const requireLandUseEditor = requireRole(fastify, ['planner', 'admin']);

  // ============================================
  // Land Use Groups Management
  // ============================================

  // Test route
  console.log('🔍 DEBUG: Registering test route...');
  fastify.get('/test', async (request, reply) => {
    console.log('🔍 DEBUG: Test route called');
    try {
      const result = await pool.query('SELECT NOW() as current_time');
      console.log('🔍 DEBUG: Test route DB query successful');
      return { success: true, time: result.rows[0].current_time };
    } catch (error) {
      console.error('🔍 DEBUG: Test route error:', error);
      return { success: false, error: error.message };
    }
  });
  console.log('🔍 DEBUG: Test route registered');

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
    // preHandler: auth.requireAuth // Auth disabled for testing
  }, async (request, reply) => {
    console.log('🔍 DEBUG: Groups endpoint called with query:', request.query);
    try {
      const { development_category, use_scale, is_active, page = 1, limit = 50 } = request.query;

      console.log('🔍 DEBUG: Parsed params:', {
        development_category,
        use_scale,
        is_active,
        page,
        limit
      });

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
          0 as land_use_controls_count
        FROM land_use_groups lug
        WHERE 1=1
      `;

      const params = [];
      const values = [];
      let paramIndex = 1;

      if (development_category) {
        query += ` AND lug.development_category = $${paramIndex++}`;
        params.push('development_category');
        values.push(development_category);
      }

      if (use_scale) {
        query += ` AND lug.use_scale = $${paramIndex++}`;
        params.push('use_scale');
        values.push(use_scale);
      }

      if (is_active !== undefined) {
        query += ` AND lug.is_active = $${paramIndex++}`;
        params.push('is_active');
        values.push(is_active);
      }

      query += ` GROUP BY lug.group_id, lug.group_code, lug.description, lug.group_category, lug.development_category, lug.use_scale, lug.notes, lug.is_active, lug.created_at ORDER BY lug.group_category, lug.group_code LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
      
      const offset = (page - 1) * limit;
      values.push(limit, offset);
      
      console.log('🔍 DEBUG: Final query:', query);
      console.log('🔍 DEBUG: Query params:', values);

      const result = await pool.query(query, values);
      console.log('🔍 DEBUG: Query executed successfully, rows:', result.rows.length);

      const countQuery = `
        SELECT COUNT(*) as total
        FROM land_use_groups lug
        WHERE 1=1
      `;

      const countValues = [];
      let countParamIndex = 1;

      if (development_category) {
        countQuery += ` AND lug.development_category = $${countParamIndex++}`;
        countValues.push(development_category);
      }

      if (use_scale) {
        countQuery += ` AND lug.use_scale = $${countParamIndex++}`;
        countValues.push(use_scale);
      }

      if (is_active !== undefined) {
        countQuery += ` AND lug.is_active = $${countParamIndex++}`;
        countValues.push(is_active);
      }

      const countResult = await pool.query(countQuery, countValues);

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
      console.error('🔍 DEBUG: Groups endpoint error:', error);
      fastify.log.error('Groups query error:', error);
      reply.code(500).send({ error: 'Failed to fetch land use groups' });
    }
  });

  // ============================================
  // Zones Management
  // ============================================

  // Get all zones
  fastify.get('/zones', {
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
      console.log('🏙️ ZONES ROUTE CALLED');
      const { page = 1, limit = 20 } = request.query;
      console.log('📄 Request params:', { page, limit });

      // ENRICHED QUERY: Get zones with all data (same pattern as controls)
      let query = `
        SELECT id, zone as zone_name, zone_type, scale_category, authority, zone_description
        FROM proposed_peri_urban_zones
        ORDER BY zone
      `;

      const values = [];
      let paramIndex = 1;

      // Add pagination
      const offset = (page - 1) * limit;
      query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
      values.push(limit, offset);

      console.log('🔍 Executing zones query with limit:', limit, 'offset:', offset);
      
      const result = await pool.query(query, values);
      console.log('✅ Query successful, rows returned:', result.rows.length);

      // Count query
      const countQuery = `SELECT COUNT(*) as total FROM proposed_peri_urban_zones`;
      
      const countResult = await pool.query(countQuery);
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
      console.log('❌ ZONES ROUTE ERROR:', error.message);
      fastify.log.error('Zones query error:', error);
      reply.code(500).send({ error: 'Failed to fetch zones' });
    }
  });

  // Create zone
  fastify.post('/zones', {
    schema: {
      body: {
        type: 'object',
        properties: {
          zone: { type: 'string', maxLength: 100 },
          zone_type: { type: 'string', maxLength: 50 },
          scale_category: { type: 'string', maxLength: 50 },
          authority: { type: 'string', maxLength: 100 }
        },
        required: ['zone', 'zone_type', 'scale_category']
      }
    },
    preHandler: requireLandUseEditor
  }, async (request, reply) => {
    try {
      const { zone, zone_type, scale_category, authority } = request.body;
      
      const result = await pool.query(`
        INSERT INTO proposed_peri_urban_zones (zone, zone_type, scale_category, authority, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        RETURNING *
      `, [zone, zone_type, scale_category, authority]);
      
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

  // Get zone-land use controls (ENRICHED VERSION for Development Matrix)
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

      // ENRICHED QUERY: Get controls with joined zone and group data
      let query = `
        SELECT
          zlc.id,
          puz.zone as zone_name,
          puz.zone_type,
          puz.scale_category,
          lug.group_code,
          lug.description,
          lug.group_category,
          lug.development_category,
          lug.use_scale,
          zlc.control_type,
          zlc.authority,
          zlc.conditions,
          zlc.created_at,
          zlc.updated_at
        FROM zone_land_use_controls zlc
        JOIN proposed_peri_urban_zones puz ON zlc.zone_id = puz.id
        JOIN land_use_groups lug ON zlc.land_use_group_id = lug.group_id
        ORDER BY puz.zone, lug.group_code, zlc.control_type
      `;

      const values = [];
      let paramIndex = 1;

      // Add pagination
      const offset = (page - 1) * limit;
      query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
      values.push(limit, offset);

      console.log('🔍 Executing enriched query with limit:', limit, 'offset:', offset);
      
      const result = await pool.query(query, values);
      console.log('✅ Query successful, rows returned:', result.rows.length);

      // Count query with JOINs
      const countQuery = `
        SELECT COUNT(*) as total
        FROM zone_land_use_controls zlc
        JOIN proposed_peri_urban_zones puz ON zlc.zone_id = puz.id
        JOIN land_use_groups lug ON zlc.land_use_group_id = lug.group_id
      `;
      
      const countResult = await pool.query(countQuery);
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
    preHandler: requireLandUseEditor
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
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        },
        required: ['id']
      },
      body: {
        type: 'object',
        properties: {
          control_type: { type: 'string', enum: ['permitted', 'prohibited', 'special_consent'] },
          authority: { type: 'string', maxLength: 100 },
          conditions: { type: 'string' }
        }
      }
    },
    preHandler: requireLandUseEditor
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
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' }
        },
        required: ['id']
      }
    },
    preHandler: requireLandUseEditor
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
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' }  // Allow string format for integer IDs
        },
        required: ['id']
      }
    },
    preHandler: auth && auth.requireAuth ? auth.requireAuth : undefined
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

  } catch (error) {
    console.error('🔍 DEBUG: Enhanced land use routes initialization error:', error);
    throw error;
  }

  return fastify;
};

module.exports = landUseManagementRoutes;
