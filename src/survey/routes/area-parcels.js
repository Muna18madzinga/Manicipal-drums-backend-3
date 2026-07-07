/**
 * Area Computation Parcels API Routes
 * Handles CRUD operations for digitized parcels in the cadastral workflow
 * Uses the new 'parcels' table with PostGIS geometry support
 */

export default async function (fastify, opts) {
  
  /**
   * GET /api/area-parcels?project_id=X&status=Y
   * Get all parcels for a specific project with optional status filter
   */
  fastify.get('/', async (request, reply) => {
    const { project_id, status } = request.query;
    
    if (!project_id) {
      return reply.code(400).send({
        success: false,
        error: 'MISSING_PROJECT_ID',
        message: 'project_id query parameter is required'
      });
    }
    
    let query = `
      SELECT 
        id, project_id, designation,
        ST_AsGeoJSON(geometry)::json as geometry,
        area_sqm, perimeter_m, closure_ratio, closure_error,
        status, digitized_at, digitized_by, finalized_at,
        metadata, created_at, updated_at
      FROM parcels
      WHERE project_id = $1
    `;
    
    const params = [project_id];
    
    if (status) {
      query += ` AND status = $2`;
      params.push(status);
    }
    
    query += ` ORDER BY created_at DESC`;
    
    const result = await fastify.surveyPg.query(query, params);
    
    return {
      success: true,
      data: result.rows,
      count: result.rows.length
    };
  });
  
  /**
   * POST /api/area-parcels
   * Create a new parcel (auto-save on digitization)
   */
  fastify.post('/', async (request, reply) => {
    const { 
      project_id, 
      designation,
      geometry, // GeoJSON polygon
      area_sqm,
      perimeter_m,
      closure_ratio,
      closure_error,
      status,
      digitized_by,
      metadata
    } = request.body;
    
    // Validate required fields
    if (!project_id || !designation || !geometry) {
      return reply.code(400).send({
        success: false,
        error: 'MISSING_REQUIRED_FIELDS',
        message: 'project_id, designation, and geometry are required'
      });
    }
    
    // Check for duplicate designation in this project
    const existingParcel = await fastify.surveyPg.query(
      'SELECT id, status FROM parcels WHERE project_id = $1 AND designation = $2',
      [project_id, designation]
    );
    
    if (existingParcel.rows.length > 0) {
      return reply.code(409).send({
        success: false,
        error: 'DUPLICATE_DESIGNATION',
        message: `Parcel ${designation} already exists in this project`,
        existing_parcel: existingParcel.rows[0]
      });
    }
    
    // Convert GeoJSON to PostGIS geometry
    const geojsonStr = JSON.stringify(geometry);
    
    const result = await fastify.surveyPg.query(
      `INSERT INTO parcels 
        (project_id, designation, geometry, area_sqm, perimeter_m, 
         closure_ratio, closure_error, status, digitized_by, metadata)
      VALUES ($1, $2, ST_GeomFromGeoJSON($3), $4, $5, $6, $7, $8, $9, $10)
      RETURNING 
        id, project_id, designation,
        ST_AsGeoJSON(geometry)::json as geometry,
        area_sqm, perimeter_m, closure_ratio, closure_error,
        status, digitized_at, digitized_by, finalized_at,
        metadata, created_at, updated_at`,
      [
        project_id, 
        designation,
        geojsonStr,
        area_sqm || null,
        perimeter_m || null,
        closure_ratio || null,
        closure_error || null,
        status || 'draft',
        digitized_by || null,
        metadata ? JSON.stringify(metadata) : '{}'
      ]
    );
    
    return {
      success: true,
      data: result.rows[0],
      message: `Parcel ${designation} saved successfully`
    };
  });
  
  /**
   * PUT /api/area-parcels/:id
   * Update a parcel (edit geometry, recalculate area, etc.)
   */
  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params;
    const { 
      designation,
      geometry,
      area_sqm,
      perimeter_m,
      closure_ratio,
      closure_error,
      status,
      metadata
    } = request.body;
    
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (designation !== undefined) {
      updates.push(`designation = $${paramCount++}`);
      values.push(designation);
    }
    
    if (geometry !== undefined) {
      updates.push(`geometry = ST_GeomFromGeoJSON($${paramCount++})`);
      values.push(JSON.stringify(geometry));
    }
    
    if (area_sqm !== undefined) {
      updates.push(`area_sqm = $${paramCount++}`);
      values.push(area_sqm);
    }
    
    if (perimeter_m !== undefined) {
      updates.push(`perimeter_m = $${paramCount++}`);
      values.push(perimeter_m);
    }
    
    if (closure_ratio !== undefined) {
      updates.push(`closure_ratio = $${paramCount++}`);
      values.push(closure_ratio);
    }
    
    if (closure_error !== undefined) {
      updates.push(`closure_error = $${paramCount++}`);
      values.push(closure_error);
    }
    
    if (status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      values.push(status);
      
      // Set finalized_at timestamp when status changes to 'finalized'
      if (status === 'finalized') {
        updates.push(`finalized_at = CURRENT_TIMESTAMP`);
      }
    }
    
    if (metadata !== undefined) {
      updates.push(`metadata = $${paramCount++}`);
      values.push(JSON.stringify(metadata));
    }
    
    if (updates.length === 0) {
      return reply.code(400).send({
        success: false,
        error: 'NO_UPDATES',
        message: 'No fields to update'
      });
    }
    
    values.push(id);
    
    const result = await fastify.surveyPg.query(
      `UPDATE parcels 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING 
        id, project_id, designation,
        ST_AsGeoJSON(geometry)::json as geometry,
        area_sqm, perimeter_m, closure_ratio, closure_error,
        status, digitized_at, digitized_by, finalized_at,
        metadata, created_at, updated_at`,
      values
    );
    
    if (result.rows.length === 0) {
      return reply.code(404).send({
        success: false,
        error: 'NOT_FOUND',
        message: 'Parcel not found'
      });
    }
    
    return {
      success: true,
      data: result.rows[0],
      message: `Parcel ${result.rows[0].designation} updated successfully`
    };
  });
  
  /**
   * DELETE /api/area-parcels/:id
   * Delete a parcel
   */
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params;
    
    const result = await fastify.surveyPg.query(
      `DELETE FROM parcels 
       WHERE id = $1 
       RETURNING designation`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return reply.code(404).send({
        success: false,
        error: 'NOT_FOUND',
        message: 'Parcel not found'
      });
    }
    
    return {
      success: true,
      message: `Parcel ${result.rows[0].designation} deleted successfully`
    };
  });
  
  /**
   * PATCH /api/area-parcels/finalize
   * Finalize multiple parcels (batch status update)
   */
  fastify.patch('/finalize', async (request, reply) => {
    const { project_id, parcel_ids } = request.body;
    
    if (!project_id || !parcel_ids || !Array.isArray(parcel_ids)) {
      return reply.code(400).send({
        success: false,
        error: 'INVALID_REQUEST',
        message: 'project_id and parcel_ids (array) are required'
      });
    }
    
    if (parcel_ids.length === 0) {
      return {
        success: true,
        message: 'No parcels to finalize',
        count: 0
      };
    }
    
    const result = await fastify.surveyPg.query(
      `UPDATE parcels 
       SET status = 'finalized', finalized_at = CURRENT_TIMESTAMP
       WHERE project_id = $1 AND id = ANY($2) AND status = 'draft'
       RETURNING id, designation`,
      [project_id, parcel_ids]
    );
    
    return {
      success: true,
      message: `${result.rows.length} parcels finalized`,
      count: result.rows.length,
      parcels: result.rows
    };
  });
  
  /**
   * GET /api/area-parcels/check-duplicate
   * Check if a designation already exists in the project
   */
  fastify.get('/check-duplicate', async (request, reply) => {
    const { project_id, designation } = request.query;
    
    if (!project_id || !designation) {
      return reply.code(400).send({
        success: false,
        error: 'MISSING_PARAMETERS',
        message: 'project_id and designation query parameters are required'
      });
    }
    
    const result = await fastify.surveyPg.query(
      'SELECT id, designation, status FROM parcels WHERE project_id = $1 AND designation = $2',
      [project_id, designation]
    );
    
    return {
      success: true,
      exists: result.rows.length > 0,
      parcel: result.rows[0] || null
    };
  });
  
  /**
   * GET /api/area-parcels/stats
   * Get statistics for parcels in a project
   */
  fastify.get('/stats', async (request, reply) => {
    const { project_id } = request.query;
    
    if (!project_id) {
      return reply.code(400).send({
        success: false,
        error: 'MISSING_PROJECT_ID',
        message: 'project_id query parameter is required'
      });
    }
    
    const result = await fastify.surveyPg.query(
      `SELECT 
        COUNT(*) as total_parcels,
        COUNT(*) FILTER (WHERE status = 'draft') as draft_parcels,
        COUNT(*) FILTER (WHERE status = 'finalized') as finalized_parcels,
        COUNT(*) FILTER (WHERE status = 'approved') as approved_parcels,
        SUM(area_sqm) as total_area_sqm,
        AVG(area_sqm) as avg_area_sqm,
        MIN(area_sqm) as min_area_sqm,
        MAX(area_sqm) as max_area_sqm
      FROM parcels
      WHERE project_id = $1`,
      [project_id]
    );
    
    return {
      success: true,
      data: result.rows[0]
    };
  });
}
