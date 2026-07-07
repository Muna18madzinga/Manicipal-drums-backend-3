/**
 * Control Points Routes
 * Full CRUD operations for Zimbabwe control point database
 * 
 * NOTE: Control points are in the PUBLIC schema (shared across all surveyors)
 * Must use explicit schema qualification or base pool without search_path
 */

import pool from '../config/db.js';

const controlPointsRoutes = async (fastify, options) => {

  // Debug middleware to log all requests
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.url.includes('control-points')) {
      fastify.log.info({
        method: request.method,
        url: request.url,
        routeUrl: request.routeOptions?.url,
        params: request.params,
        query: request.query
      }, 'Control Points Request Debug')
    }
  })

  /**
   * GET /api/control-points
   * Get all control points with optional filtering and pagination
   */
  fastify.get('/', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 5000, default: 50 },
          type: { type: 'string', enum: ['PRIM', 'SEC', 'TERT', 'QUART', 'TSM'] },
          area: { type: 'string' },
          gauss_lo: { type: 'integer', enum: [27, 29, 31, 33] },
          deg_sqr: { type: 'string' },
          search: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { page = 1, limit = 50, type, area, gauss_lo, deg_sqr, search } = request.query;
      const offset = (page - 1) * limit;

      // Build WHERE clause dynamically
      const conditions = [];
      const params = [];
      let paramIndex = 1;

      if (type) {
        conditions.push(`type = $${paramIndex++}`);
        params.push(type);
      }

      if (area) {
        conditions.push(`area_nm ILIKE $${paramIndex++}`);
        params.push(`%${area}%`);
      }

      if (gauss_lo) {
        conditions.push(`gauss_lo = $${paramIndex++}`);
        params.push(gauss_lo);
      }

      if (deg_sqr) {
        conditions.push(`deg_sqr = $${paramIndex++}`);
        params.push(deg_sqr);
      }

      if (search) {
        conditions.push(`(monu_num ILIKE $${paramIndex} OR monu_name ILIKE $${paramIndex})`);
        params.push(`%${search}%`);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count (use explicit schema qualification for schema-per-surveyor)
      const countQuery = `SELECT COUNT(*) FROM survey.zim_control_points ${whereClause}`;
      const countResult = await pool.query(countQuery, params);
      const total = parseInt(countResult.rows[0].count);

      // Get paginated data
      params.push(limit, offset);
      const dataQuery = `
        SELECT 
          id, monu_num, monu_name, type, comp_sheet, topo,
          gauss_lo, y_gauss, x_gauss, 
          lat_wgs84, lng_wgs84,
          msl_hgt, ped_hgt, pill_hgt,
          top_signal, bot_signal, last_insp, deg_sqr, remark, area_nm
        FROM survey.zim_control_points
        ${whereClause}
        ORDER BY 
          CASE type 
            WHEN 'PRIM' THEN 1 
            WHEN 'SEC' THEN 2 
            WHEN 'TERT' THEN 3 
            WHEN 'QUART' THEN 4 
            WHEN 'TSM' THEN 5 
            ELSE 6 
          END,
          monu_num
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `;

      const dataResult = await pool.query(dataQuery, params);

      reply.send({
        data: dataResult.rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Failed to fetch control points' });
    }
  });

  /**
   * GET /api/control-points/nearby
   * Find control points near a given coordinate
   * MOVED BEFORE /:id to prevent route matching issues
   */
  fastify.get('/nearby', {
    schema: {
      querystring: {
        type: 'object',
        required: ['y', 'x', 'gauss_lo'],
        properties: {
          y: { type: 'number' },
          x: { type: 'number' },
          gauss_lo: { type: 'integer', enum: [27, 29, 31, 33] },
          radius: { type: 'number', default: 5000 }, // meters
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { y, x, gauss_lo, radius = 5000, limit = 10 } = request.query;

      // Simple distance calculation using Pythagorean theorem
      // For more accurate results, consider using PostGIS ST_Distance
      const result = await pool.query(
        `SELECT 
          id, monu_num, monu_name, type, comp_sheet, topo,
          gauss_lo, y_gauss, x_gauss, 
          lat_wgs84, lng_wgs84,
          msl_hgt, ped_hgt, pill_hgt,
          top_signal, bot_signal, last_insp, deg_sqr, remark, area_nm,
          SQRT(POWER(y_gauss - $1, 2) + POWER(x_gauss - $2, 2)) as distance
        FROM survey.zim_control_points
        WHERE gauss_lo = $3
          AND SQRT(POWER(y_gauss - $1, 2) + POWER(x_gauss - $2, 2)) <= $4
        ORDER BY distance
        LIMIT $5`,
        [y, x, gauss_lo, radius, limit]
      );

      reply.send(result.rows);
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Failed to find nearby control points' });
    }
  });

  /**
   * GET /api/control-points/stats
   * Get statistics about control points
   * MOVED BEFORE /:id to prevent route matching issues
   */
  fastify.get('/stats', async (request, reply) => {
    try {
      const result = await pool.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN type = 'PRIM' THEN 1 END) as primary_count,
          COUNT(CASE WHEN type = 'SEC' THEN 1 END) as secondary_count,
          COUNT(CASE WHEN type = 'TERT' THEN 1 END) as tertiary_count,
          COUNT(CASE WHEN type = 'QUART' THEN 1 END) as quaternary_count,
          COUNT(CASE WHEN gauss_lo = 27 THEN 1 END) as lo27_count,
          COUNT(CASE WHEN gauss_lo = 29 THEN 1 END) as lo29_count,
          COUNT(CASE WHEN gauss_lo = 31 THEN 1 END) as lo31_count,
          COUNT(CASE WHEN gauss_lo = 33 THEN 1 END) as lo33_count,
          COUNT(DISTINCT area_nm) as unique_areas
        FROM survey.zim_control_points
      `);

      reply.send(result.rows[0]);
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Failed to fetch statistics' });
    }
  });

  /**
   * GET /api/control-points/:id
   * Get a single control point by ID
   * MUST BE AFTER /nearby and /stats to avoid matching those routes
   */
  fastify.get('/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params;

      const result = await pool.query(
        `SELECT 
          id, monu_num, monu_name, type, comp_sheet, topo,
          gauss_lo, y_gauss, x_gauss, msl_hgt, ped_hgt, pill_hgt,
          top_signal, bot_signal, last_insp, deg_sqr, remark, area_nm
        FROM survey.zim_control_points
        WHERE id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Control point not found' });
      }

      reply.send(result.rows[0]);
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Failed to fetch control point' });
    }
  });

  /**
   * GET /api/control-points/monument/:monu_num
   * Get a control point by monument number
   */
  fastify.get('/monument/:monu_num', {
    schema: {
      params: {
        type: 'object',
        required: ['monu_num'],
        properties: {
          monu_num: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { monu_num } = request.params;

      const result = await pool.query(
        `SELECT 
          id, monu_num, monu_name, type, comp_sheet, topo,
          gauss_lo, y_gauss, x_gauss, msl_hgt, ped_hgt, pill_hgt,
          top_signal, bot_signal, last_insp, deg_sqr, remark, area_nm
        FROM survey.zim_control_points
        WHERE monu_num = $1`,
        [monu_num]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Control point not found' });
      }

      reply.send(result.rows[0]);
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Failed to fetch control point' });
    }
  });

  /**
   * POST /api/control-points
   * Create a new control point
   */
  fastify.post('/', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['monu_num', 'monu_name', 'type'],
        properties: {
          monu_num: { type: 'string', maxLength: 20 },
          monu_name: { type: 'string', maxLength: 100 },
          type: { type: 'string', enum: ['PRIM', 'SEC', 'TERT', 'QUART'] },
          comp_sheet: { type: 'string', maxLength: 20 },
          topo: { type: 'string', maxLength: 20 },
          gauss_lo: { type: 'integer', enum: [27, 29, 31, 33] },
          y_gauss: { type: 'number' },
          x_gauss: { type: 'number' },
          msl_hgt: { type: 'number' },
          ped_hgt: { type: 'number' },
          pill_hgt: { type: 'number' },
          top_signal: { type: 'number' },
          bot_signal: { type: 'number' },
          last_insp: { type: 'string', format: 'date' },
          deg_sqr: { type: 'string', maxLength: 10 },
          remark: { type: 'string' },
          area_nm: { type: 'string', maxLength: 100 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const userId = request.user.id;
      const {
        monu_num, monu_name, type, comp_sheet, topo,
        gauss_lo, y_gauss, x_gauss, msl_hgt, ped_hgt, pill_hgt,
        top_signal, bot_signal, last_insp, deg_sqr, remark, area_nm
      } = request.body;

      const result = await pool.query(
        `INSERT INTO survey.zim_control_points (
          monu_num, monu_name, type, comp_sheet, topo,
          gauss_lo, y_gauss, x_gauss, msl_hgt, ped_hgt, pill_hgt,
          top_signal, bot_signal, last_insp, deg_sqr, remark, area_nm
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING 
          id, monu_num, monu_name, type, comp_sheet, topo,
          gauss_lo, y_gauss, x_gauss, msl_hgt, ped_hgt, pill_hgt,
          top_signal, bot_signal, last_insp, deg_sqr, remark, area_nm`,
        [
          monu_num, monu_name, type, comp_sheet, topo,
          gauss_lo, y_gauss, x_gauss, msl_hgt, ped_hgt, pill_hgt,
          top_signal, bot_signal, last_insp, deg_sqr, remark, area_nm
        ]
      );

      reply.status(201).send(result.rows[0]);
    } catch (error) {
      fastify.log.error(error);
      if (error.code === '23505') { // Unique violation
        return reply.status(409).send({ error: 'Monument number already exists' });
      }
      reply.status(500).send({ error: 'Failed to create control point' });
    }
  });

  /**
   * PUT /api/control-points/:id
   * Update a control point
   */
  fastify.put('/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer' }
        }
      },
      body: {
        type: 'object',
        properties: {
          monu_num: { type: 'string', maxLength: 20 },
          monu_name: { type: 'string', maxLength: 100 },
          type: { type: 'string', enum: ['PRIM', 'SEC', 'TERT', 'QUART'] },
          comp_sheet: { type: 'string', maxLength: 20 },
          topo: { type: 'string', maxLength: 20 },
          gauss_lo: { type: 'integer', enum: [27, 29, 31, 33] },
          y_gauss: { type: 'number' },
          x_gauss: { type: 'number' },
          msl_hgt: { type: 'number' },
          ped_hgt: { type: 'number' },
          pill_hgt: { type: 'number' },
          top_signal: { type: 'number' },
          bot_signal: { type: 'number' },
          last_insp: { type: 'string', format: 'date' },
          deg_sqr: { type: 'string', maxLength: 10 },
          remark: { type: 'string' },
          area_nm: { type: 'string', maxLength: 100 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const userId = request.user.id;
      const updates = request.body;

      // Build dynamic UPDATE query
      const fields = [];
      const values = [];
      let paramIndex = 1;

      Object.keys(updates).forEach(key => {
        fields.push(`${key} = $${paramIndex++}`);
        values.push(updates[key]);
      });

      if (fields.length === 0) {
        return reply.status(400).send({ error: 'No fields to update' });
      }

      values.push(id);

      const query = `
        UPDATE survey.zim_control_points
        SET ${fields.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING 
          id, monu_num, monu_name, type, comp_sheet, topo,
          gauss_lo, y_gauss, x_gauss, msl_hgt, ped_hgt, pill_hgt,
          top_signal, bot_signal, last_insp, deg_sqr, remark, area_nm
      `;

      const result = await pool.query(query, values);

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Control point not found' });
      }

      reply.send(result.rows[0]);
    } catch (error) {
      fastify.log.error(error);
      if (error.code === '23505') { // Unique violation
        return reply.status(409).send({ error: 'Monument number already exists' });
      }
      reply.status(500).send({ error: 'Failed to update control point' });
    }
  });

  /**
   * DELETE /api/control-points/:id
   * Delete a control point
   */
  fastify.delete('/:id', {
    preHandler: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params;

      const result = await pool.query(
        'DELETE FROM survey.zim_control_points WHERE id = $1 RETURNING id',
        [id]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Control point not found' });
      }

      reply.send({ message: 'Control point deleted successfully', id: result.rows[0].id });
    } catch (error) {
      fastify.log.error(error);
      reply.status(500).send({ error: 'Failed to delete control point' });
    }
  });

  /**
   * POST /api/control-points/bulk-import
   * Bulk import control points from CSV/array
   */
  fastify.post('/bulk-import', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['points'],
        properties: {
          points: {
            type: 'array',
            items: {
              type: 'object',
              required: ['monu_num', 'monu_name', 'type'],
              properties: {
                monu_num: { type: 'string' },
                monu_name: { type: 'string' },
                type: { type: 'string' },
                comp_sheet: { type: 'string' },
                topo: { type: 'string' },
                gauss_lo: { type: 'integer' },
                y_gauss: { type: 'number' },
                x_gauss: { type: 'number' },
                msl_hgt: { type: 'number' },
                ped_hgt: { type: 'number' },
                pill_hgt: { type: 'number' },
                top_signal: { type: 'number' },
                bot_signal: { type: 'number' },
                last_insp: { type: 'string' },
                deg_sqr: { type: 'string' },
                remark: { type: 'string' },
                area_nm: { type: 'string' }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const client = await pool.connect();
    try {
      const userId = request.user.id;
      const { points } = request.body;

      await client.query('BEGIN');

      const inserted = [];
      const errors = [];

      for (const point of points) {
        try {
          const result = await client.query(
            `INSERT INTO survey.zim_control_points (
              monu_num, monu_name, type, comp_sheet, topo,
              gauss_lo, y_gauss, x_gauss, msl_hgt, ped_hgt, pill_hgt,
              top_signal, bot_signal, last_insp, deg_sqr, remark, area_nm
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            RETURNING id, monu_num`,
            [
              point.monu_num, point.monu_name, point.type, point.comp_sheet, point.topo,
              point.gauss_lo, point.y_gauss, point.x_gauss, point.msl_hgt, point.ped_hgt,
              point.pill_hgt, point.top_signal, point.bot_signal, point.last_insp,
              point.deg_sqr, point.remark, point.area_nm
            ]
          );
          inserted.push(result.rows[0]);
        } catch (error) {
          errors.push({
            monu_num: point.monu_num,
            error: error.message
          });
        }
      }

      await client.query('COMMIT');

      reply.send({
        success: true,
        inserted: inserted.length,
        errors: errors.length,
        details: { inserted, errors }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      fastify.log.error(error);
      reply.status(500).send({ error: 'Bulk import failed' });
    } finally {
      client.release();
    }
  });
};

export default controlPointsRoutes;
