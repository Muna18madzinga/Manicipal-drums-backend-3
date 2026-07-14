/**
 * Land Parcels API Routes
 * Handles CRUD operations for land parcels within survey projects
 */

export default async function (fastify, opts) {
  
  /**
   * GET /api/parcels/:projectId
   * Get all parcels for a specific project
   */
  fastify.get('/:projectId', async (request, reply) => {
    const { projectId } = request.params;
    
    const result = await fastify.surveyPg.query(
      `SELECT 
        id, project_id, parcel_number, parcel_name,
        boundary_points, area_sqm, area_hectares, area_acres,
        status, geometry_geojson,
        perimeter_m, compactness_index, shape_type, elongation_ratio,
        longest_side_m, shortest_side_m, average_side_m,
        is_valid_geometry, validation_errors, validation_warnings,
        closure_error_m, self_intersections, has_spikes, bounding_box,
        created_at, updated_at
      FROM land_parcels
      WHERE project_id = $1
      ORDER BY parcel_number`,
      [projectId]
    );
    
    return {
      success: true,
      data: result.rows,
      count: result.rows.length
    };
  });
  
  /**
   * POST /api/parcels
   * Create a new parcel (draft status)
   */
  fastify.post('/', async (request, reply) => {
    const { 
      project_id, 
      parcel_number, 
      parcel_name,
      boundary_points,
      area_sqm,
      area_hectares,
      area_acres,
      status,
      geometry_geojson,
      // QGIS-style fields
      perimeter_m,
      compactness_index,
      shape_type,
      elongation_ratio,
      longest_side_m,
      shortest_side_m,
      average_side_m,
      is_valid_geometry,
      validation_errors,
      validation_warnings,
      closure_error_m,
      self_intersections,
      has_spikes,
      bounding_box
    } = request.body;
    
    // Check for duplicate parcel number in this project
    const existingParcel = await fastify.surveyPg.query(
      'SELECT id FROM land_parcels WHERE project_id = $1 AND parcel_number = $2',
      [project_id, parcel_number]
    );
    
    if (existingParcel.rows.length > 0) {
      return reply.code(409).send({
        success: false,
        error: 'DUPLICATE_PARCEL',
        message: `Parcel ${parcel_number} already exists in this project`
      });
    }
    
    const result = await fastify.surveyPg.query(
      `INSERT INTO land_parcels 
        (project_id, parcel_number, parcel_name, boundary_points, 
         area_sqm, area_hectares, area_acres, status, geometry_geojson,
         perimeter_m, compactness_index, shape_type, elongation_ratio,
         longest_side_m, shortest_side_m, average_side_m,
         is_valid_geometry, validation_errors, validation_warnings,
         closure_error_m, self_intersections, has_spikes, bounding_box)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
      RETURNING *`,
      [
        project_id, 
        parcel_number, 
        parcel_name || null, 
        boundary_points,
        area_sqm || null,
        area_hectares || null,
        area_acres || null,
        status || 'draft',
        geometry_geojson ? JSON.stringify(geometry_geojson) : null,
        perimeter_m || null,
        compactness_index || null,
        shape_type || null,
        elongation_ratio || null,
        longest_side_m || null,
        shortest_side_m || null,
        average_side_m || null,
        is_valid_geometry !== undefined ? is_valid_geometry : true,
        validation_errors || null,
        validation_warnings || null,
        closure_error_m || null,
        self_intersections || 0,
        has_spikes || 0,
        bounding_box || null
      ]
    );
    
    return {
      success: true,
      data: result.rows[0]
    };
  });
  
  /**
   * PUT /api/parcels/:id
   * Update a parcel (add points, calculate area, update geometry)
   */
  fastify.put('/:id', async (request, reply) => {
    const { id } = request.params;
    const { 
      boundary_points,
      area_sqm,
      area_hectares,
      area_acres,
      status,
      geometry_geojson,
      parcel_name
    } = request.body;
    
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (boundary_points !== undefined) {
      updates.push(`boundary_points = $${paramCount++}`);
      values.push(boundary_points);
    }
    
    if (area_sqm !== undefined) {
      updates.push(`area_sqm = $${paramCount++}`);
      values.push(area_sqm);
    }
    
    if (area_hectares !== undefined) {
      updates.push(`area_hectares = $${paramCount++}`);
      values.push(area_hectares);
    }
    
    if (area_acres !== undefined) {
      updates.push(`area_acres = $${paramCount++}`);
      values.push(area_acres);
    }
    
    if (status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      values.push(status);
    }
    
    if (geometry_geojson !== undefined) {
      updates.push(`geometry_geojson = $${paramCount++}`);
      values.push(JSON.stringify(geometry_geojson));
    }
    
    if (parcel_name !== undefined) {
      updates.push(`parcel_name = $${paramCount++}`);
      values.push(parcel_name);
    }
    
    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);
    
    const result = await fastify.surveyPg.query(
      `UPDATE land_parcels 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING *`,
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
      data: result.rows[0]
    };
  });
  
  /**
   * DELETE /api/parcels/:id
   * Delete a parcel
   */
  fastify.delete('/:id', async (request, reply) => {
    const { id } = request.params;
    
    const result = await fastify.surveyPg.query(
      'DELETE FROM land_parcels WHERE id = $1 RETURNING *',
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
      message: 'Parcel deleted successfully',
      data: result.rows[0]
    };
  });
  
  /**
   * GET /api/parcels/:projectId/check-duplicate/:parcelNumber
   * Check if a parcel number already exists in the project
   */
  fastify.get('/:projectId/check-duplicate/:parcelNumber', async (request, reply) => {
    const { projectId, parcelNumber } = request.params;
    
    const result = await fastify.surveyPg.query(
      'SELECT id, parcel_number FROM land_parcels WHERE project_id = $1 AND parcel_number = $2',
      [projectId, parcelNumber]
    );
    
    return {
      success: true,
      exists: result.rows.length > 0,
      parcel: result.rows[0] || null
    };
  });
};
