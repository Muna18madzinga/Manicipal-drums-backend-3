import db from '../config/db.js'
import { getCapeLoSRID } from '../utils/capeLoSRID.js'

// Geometry is stored in each project's native CRS (Lo 25/27/29/31/33).
// The column SRID constraint has been removed to support multi-zone storage.

export default {
  async findAll(dbConnection = db) {
    const result = await dbConnection.query('SELECT * FROM land_parcels ORDER BY stand')
    return result.rows
  },

  async findById(dbConnection = db, id) {
    const result = await dbConnection.query('SELECT * FROM land_parcels WHERE id = $1', [id])
    return result.rows[0]
  },

  async findByProject(dbConnection = db, projectId) {
    const result = await dbConnection.query(
      'SELECT * FROM land_parcels WHERE project_id = $1 ORDER BY stand',
      [projectId]
    )
    return result.rows
  },

  async findByStand(dbConnection = db, projectId, stand) {
    const result = await dbConnection.query(
      'SELECT * FROM land_parcels WHERE project_id = $1 AND stand = $2',
      [projectId, stand]
    )
    return result.rows[0]
  },

  async create(dbConnection = db, { projectId, stand, designation, geom, owner, titleDeed, surveyDate, surveyor, notes, centroidY, centroidX, closureErrorM, closureRatio, status, digitizedBy, metadata }) {
    try {
      // Determine the project's native SRID from its central meridian
      const projResult = await dbConnection.query(
        'SELECT central_meridian FROM survey_projects WHERE id = $1', [projectId]
      );
      let nativeSrid = projResult.rows.length > 0 && projResult.rows[0].central_meridian
        ? getCapeLoSRID(projResult.rows[0].central_meridian)
        : 22291;  // Default to Lo 31

      // If no central_meridian set, detect from coordinate ranges
      if (!projResult.rows[0]?.central_meridian && geom?.coordinates?.[0]?.[0]) {
        const firstCoord = geom.coordinates[0][0]; // [x, y] where x is Southing, y is Westing
        const southing = Math.abs(firstCoord[0]); // X coordinate (Southing)
        
        // Detect zone from Southing ranges (approximate)
        let detectedZone = 31; // default
        if (southing >= 1800000 && southing < 2000000) detectedZone = 25;
        else if (southing >= 2000000 && southing < 2100000) detectedZone = 27;
        else if (southing >= 2100000 && southing < 2200000) detectedZone = 29;
        else if (southing >= 2200000 && southing < 2300000) detectedZone = 31;
        else if (southing >= 2300000 && southing < 2400000) detectedZone = 33;
        
        nativeSrid = getCapeLoSRID(detectedZone.toString());
        console.log(`[LandParcel] Auto-detected central meridian ${detectedZone} from coordinates (Southing: ${southing})`);
        
        // Update project with detected central_meridian
        await dbConnection.query(
          'UPDATE survey_projects SET central_meridian = $1 WHERE id = $2',
          [detectedZone.toString(), projectId]
        );
      }

      // Store geometry using the project's native SRID (NOT forced to Lo 31)
      // Each project's data stays in its own central meridian
      const result = await dbConnection.query(
        `INSERT INTO land_parcels 
         (project_id, stand, designation, geom, status, metadata) 
         VALUES ($1, $2, $3, spatial_planning.geom_from_geojson_checked($4, ${nativeSrid}), $5, $6)
         RETURNING *, ST_AsGeoJSON(geom)::jsonb as geom`,
        [projectId, stand, designation, JSON.stringify(geom), status || 'draft', metadata ? JSON.stringify(metadata) : null]
      )
      
      console.log('[LandParcel] ✅ Stored in project CRS:', {
        stand,
        srid: nativeSrid,
        centralMeridian: projResult.rows[0]?.central_meridian || 31,
        vertexCount: geom.coordinates?.[0]?.length
      })
      return result.rows[0]
    } catch (error) {
      // Handle unique constraint violation (duplicate stand)
      if (error.code === '23505' && error.constraint === 'unique_project_stand') {
        throw new Error(`Parcel with stand "${stand}" already exists in this project`)
      }
      // Handle spatial overlap error from trigger
      if (error.message && error.message.includes('overlaps with existing parcel')) {
        throw new Error(error.message)
      }
      throw error
    }
  },

  async update(dbConnection = db, id, { stand, designation, geom, owner, titleDeed, surveyDate, surveyor, notes, metadata, status }) {
    try {
      // Build dynamic UPDATE query based on provided fields
      const updates = [];
      const values = [];
      let paramIndex = 1;
      
      if (stand !== undefined) {
        updates.push(`stand = $${paramIndex++}`);
        values.push(stand);
      }
      if (designation !== undefined) {
        updates.push(`designation = $${paramIndex++}`);
        values.push(designation);
      }
      if (geom !== undefined) {
        // Look up native SRID for the project
        const ptResult = await dbConnection.query('SELECT project_id FROM land_parcels WHERE id = $1', [id]);
        let updateSrid = 22291;  // Default to Lo 31
        if (ptResult.rows.length > 0) {
          const prjResult = await dbConnection.query('SELECT central_meridian FROM survey_projects WHERE id = $1', [ptResult.rows[0].project_id]);
          if (prjResult.rows.length > 0) updateSrid = getCapeLoSRID(prjResult.rows[0].central_meridian);
        }
        // Store geometry in project's native SRID (NOT forced to Lo 31)
        updates.push(`geom = spatial_planning.geom_from_geojson_checked($${paramIndex++}, ${updateSrid})`);
        values.push(JSON.stringify(geom));
      }
      if (owner !== undefined) {
        updates.push(`owner = $${paramIndex++}`);
        values.push(owner);
      }
      if (titleDeed !== undefined) {
        updates.push(`title_deed = $${paramIndex++}`);
        values.push(titleDeed);
      }
      if (surveyDate !== undefined) {
        updates.push(`survey_date = $${paramIndex++}`);
        values.push(surveyDate);
      }
      if (surveyor !== undefined) {
        updates.push(`surveyor = $${paramIndex++}`);
        values.push(surveyor);
      }
      if (notes !== undefined) {
        updates.push(`notes = $${paramIndex++}`);
        values.push(notes);
      }
      if (metadata !== undefined) {
        updates.push(`metadata = $${paramIndex++}::jsonb`);
        values.push(JSON.stringify(metadata));
      }
      if (status !== undefined) {
        updates.push(`status = $${paramIndex++}`);
        values.push(status);
      }
      
      if (updates.length === 0) {
        throw new Error('No fields to update');
      }
      
      values.push(id);
      
      const result = await dbConnection.query(
        `UPDATE land_parcels 
         SET ${updates.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING *, ST_AsGeoJSON(geom)::jsonb as geometry`,
        values
      )
      return result.rows[0]
    } catch (error) {
      // Handle unique constraint violation (duplicate stand)
      if (error.code === '23505' && error.constraint === 'unique_project_stand') {
        throw new Error(`Parcel with stand "${stand}" already exists in this project`)
      }
      // Handle spatial overlap error from trigger
      if (error.message && error.message.includes('overlaps with existing parcel')) {
        throw new Error(error.message)
      }
      throw error
    }
  },

  async delete(dbConnection = db, id) {
    await dbConnection.query('DELETE FROM land_parcels WHERE id = $1', [id])
  },

  async deleteByProject(dbConnection = db, projectId) {
    const result = await dbConnection.query('DELETE FROM land_parcels WHERE project_id = $1', [projectId])
    return result.rowCount
  },

  // Get parcels with full computed attributes (paginated)
  async findFullByProject(dbConnection = db, projectId, status, { page = 1, limit = 50 } = {}) {
    // Determine project's native SRID
    const prjResult = await dbConnection.query(
      'SELECT central_meridian FROM survey_projects WHERE id = $1', [projectId]
    );
    const nativeSrid = prjResult.rows.length > 0
      ? getCapeLoSRID(prjResult.rows[0].central_meridian)
      : 22291;  // Default to Lo 31

    const offset = (page - 1) * limit

    let baseWhere = `WHERE "project_id" = $1`
    const params = [projectId]

    if (status) {
      baseWhere += ` AND "status" = $2`
      params.push(status)
    }

    // Total count (cheap — no spatial functions)
    const countResult = await dbConnection.query(
      `SELECT COUNT(*) FROM "land_parcels" lp ${baseWhere}`,
      params
    )
    const total = parseInt(countResult.rows[0].count, 10)

    // Paginated data with spatial computations
    const dataParams = [...params, limit, offset]
    const limitParam = params.length + 1
    const offsetParam = params.length + 2

    const query = `SELECT
      lp.*,
      ST_AsGeoJSON(lp.geom)::jsonb as geom,
      ST_NPoints(lp.geom) as vertex_count,
      ST_Area(lp.geom) as area_m2,
      ST_Area(lp.geom) / 10000 as area_ha,
      ST_Perimeter(lp.geom) as perimeter_m,
      ST_Y(ST_Centroid(lp.geom)) as centroid_y,
      ST_X(ST_Centroid(lp.geom)) as centroid_x
    FROM "land_parcels" lp
    ${baseWhere}
    ORDER BY "stand"
    LIMIT $${limitParam} OFFSET $${offsetParam}`

    const result = await dbConnection.query(query, dataParams)
    return {
      data: result.rows,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    }
  },

  // Update project_id for parcels that don't have it (after QGIS digitization)
  async updateProjectId(dbConnection = db, projectId) {
    const result = await dbConnection.query(
      'UPDATE "land_parcels" SET "project_id" = $1 WHERE "project_id" IS NULL',
      [projectId]
    )
    return result
  },

  // Update area calculation results for a single parcel
  async updateAreaCalculation(dbConnection = db, id, data) {
    const result = await dbConnection.query(
      `UPDATE "land_parcels"
      SET
        "centroid_y" = $1,
        "centroid_x" = $2,
        "closure_error_m" = $3,
        "area_calculated" = $4,
        "calculation_data" = $5,
        "updated_at" = NOW()
      WHERE "id" = $6
      RETURNING *`,
      [
        data.centroid_y,
        data.centroid_x,
        data.closure_error_m,
        data.area_calculated,
        data.calculation_data ? JSON.stringify(data.calculation_data) : null,
        id
      ]
    )
    return result.rows[0]
  },

  // Batch update area calculations — single round-trip for all parcels
  async batchUpdateAreaCalculations(dbConnection = db, updates) {
    if (!updates.length) return []

    const ids = updates.map(u => u.id)
    const centroidYs = updates.map(u => u.centroid_y)
    const centroidXs = updates.map(u => u.centroid_x)
    const closureErrors = updates.map(u => u.closure_error_m)
    const calcData = updates.map(u => u.calculation_data ? JSON.stringify(u.calculation_data) : null)

    const result = await dbConnection.query(
      `UPDATE "land_parcels" lp
       SET
         centroid_y      = v.centroid_y::double precision,
         centroid_x      = v.centroid_x::double precision,
         closure_error_m = v.closure_error_m::double precision,
         area_calculated = true,
         calculation_data = v.calc_data::jsonb,
         updated_at      = NOW()
       FROM (
         SELECT
           unnest($1::int[])    AS id,
           unnest($2::text[])   AS centroid_y,
           unnest($3::text[])   AS centroid_x,
           unnest($4::text[])   AS closure_error_m,
           unnest($5::text[])   AS calc_data
       ) v
       WHERE lp.id = v.id
       RETURNING lp.id, lp.stand`,
      [ids, centroidYs.map(String), centroidXs.map(String), closureErrors.map(String), calcData]
    )
    return result.rows
  },

  /**
   * Check for duplicate parcels by stand name and geometry
   * Returns duplicates found (if any)
   * 
   * @param {number} projectId - Project ID
   * @param {string} stand - Stand/Erf designation
   * @param {object} geom - GeoJSON polygon geometry
   * @param {number} excludeId - Parcel ID to exclude from check (for updates)
   * @returns {Promise<object>} { hasDuplicates: boolean, duplicates: array }
   */
  async checkDuplicates(dbConnection = db, projectId, stand, geom, excludeId = null) {
    try {
      // Normalize stand name for comparison (remove spaces, lowercase, remove suffixes like 'a', 'b')
      const normalizeStand = (s) => {
        if (!s) return ''
        return s.toLowerCase()
          .trim()
          .replace(/\s+/g, '') // Remove all spaces
          .replace(/[a-z]$/, '') // Remove trailing letter suffix
      }

      const normalizedStand = normalizeStand(stand)
      
      const duplicates = []
      
      // 1. Check for similar stand names (normalized comparison)
      const nameQuery = `
        SELECT id, stand, 
               ST_AsGeoJSON(geom)::jsonb as geometry
        FROM land_parcels 
        WHERE project_id = $1 
          AND id != COALESCE($2, -1)
        ORDER BY stand
      `
      const nameResult = await dbConnection.query(nameQuery, [projectId, excludeId])
      
      for (const existing of nameResult.rows) {
        const existingNormalized = normalizeStand(existing.stand)
        
        // Check if normalized names match
        if (existingNormalized === normalizedStand && existingNormalized.length > 0) {
          duplicates.push({
            type: 'similar_name',
            severity: 'high',
            existing_id: existing.id,
            existing_stand: existing.stand,
            message: `Stand "${stand}" is similar to existing stand "${existing.stand}"`,
            details: `Normalized: "${normalizedStand}" matches "${existingNormalized}"`
          })
        }
      }
      
      // Determine project's native SRID for geometry comparison
      const prjResult = await dbConnection.query(
        'SELECT central_meridian FROM survey_projects WHERE id = $1', [projectId]
      );
      const checkSrid = prjResult.rows.length > 0
        ? getCapeLoSRID(prjResult.rows[0].central_meridian)
        : 22291;  // Default to Lo 31

      // 2. Check for spatial overlaps using PostGIS
      // Convert GeoJSON to geometry using project's native SRID
      const overlapQuery = `
        WITH new_geom AS (
          SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), ${checkSrid}) as geom
        )
        SELECT 
          lp.id, 
          lp.stand,
          ST_AsGeoJSON(lp.geom)::jsonb as geometry,
          ST_Area(lp.geom) as area_m2,
          ST_Area(lp.geom) / 10000 as area_ha,
          ST_Area(ST_Intersection(lp.geom, ng.geom)) as overlap_area_m2,
          ROUND((ST_Area(ST_Intersection(lp.geom, ng.geom)) / NULLIF(ST_Area(lp.geom), 0) * 100)::numeric, 2) as overlap_percent
        FROM land_parcels lp, new_geom ng
        WHERE lp.project_id = $2
          AND lp.id != COALESCE($3, -1)
          AND ST_Intersects(lp.geom, ng.geom)
          AND NOT ST_Touches(lp.geom, ng.geom)
        ORDER BY overlap_area_m2 DESC
      `
      
      const overlapResult = await dbConnection.query(overlapQuery, [
        JSON.stringify(geom),
        projectId,
        excludeId
      ])
      
      for (const overlap of overlapResult.rows) {
        const overlapPercent = Number(overlap.overlap_percent) || 0
        
        // Classify overlap severity
        let severity = 'low'
        let type = 'partial_overlap'
        
        if (overlapPercent >= 95) {
          severity = 'critical'
          type = 'complete_overlap'
        } else if (overlapPercent >= 50) {
          severity = 'high'
          type = 'major_overlap'
        } else if (overlapPercent >= 10) {
          severity = 'medium'
          type = 'partial_overlap'
        }
        
        duplicates.push({
          type,
          severity,
          existing_id: overlap.id,
          existing_stand: overlap.stand,
          overlap_area_m2: Number(overlap.overlap_area_m2).toFixed(2),
          overlap_percent: overlapPercent,
          message: `Polygon overlaps ${overlapPercent.toFixed(1)}% with existing parcel "${overlap.stand}"`,
          details: `Overlap area: ${Number(overlap.overlap_area_m2).toFixed(2)} m²`
        })
      }
      
      // 3. Check for identical geometries (exact duplicates)
      const exactQuery = `
        WITH new_geom AS (
          SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), ${checkSrid}) as geom
        )
        SELECT 
          lp.id, 
          lp.stand,
          ST_AsGeoJSON(lp.geom)::jsonb as geometry
        FROM land_parcels lp, new_geom ng
        WHERE lp.project_id = $2
          AND lp.id != COALESCE($3, -1)
          AND ST_Equals(lp.geom, ng.geom)
      `
      
      const exactResult = await dbConnection.query(exactQuery, [
        JSON.stringify(geom),
        projectId,
        excludeId
      ])
      
      for (const exact of exactResult.rows) {
        duplicates.push({
          type: 'exact_geometry',
          severity: 'critical',
          existing_id: exact.id,
          existing_stand: exact.stand,
          message: `Identical polygon already exists for parcel "${exact.stand}"`,
          details: 'Geometries are exactly the same'
        })
      }
      
      return {
        hasDuplicates: duplicates.length > 0,
        duplicateCount: duplicates.length,
        duplicates: duplicates,
        // Summary by severity
        summary: {
          critical: duplicates.filter(d => d.severity === 'critical').length,
          high: duplicates.filter(d => d.severity === 'high').length,
          medium: duplicates.filter(d => d.severity === 'medium').length,
          low: duplicates.filter(d => d.severity === 'low').length
        }
      }
    } catch (error) {
      console.error('[LandParcel] Error checking duplicates:', error)
      throw error
    }
  },

  // Find parcels by status
  async findByStatus(dbConnection = db, projectId, status) {
    const result = await dbConnection.query(
      `SELECT * FROM land_parcels 
       WHERE project_id = $1 AND status = $2 
       ORDER BY stand`,
      [projectId, status]
    )
    return result.rows
  },

  // Update parcel status
  async updateStatus(dbConnection = db, id, status) {
    const result = await dbConnection.query(
      `UPDATE land_parcels 
       SET status = $1, 
           finalized_at = CASE WHEN $1 = 'finalized' THEN NOW() ELSE finalized_at END,
           updated_at = NOW()
       WHERE id = $2 
       RETURNING *`,
      [status, id]
    )
    return result.rows[0]
  },

  // Batch finalize parcels
  async batchFinalize(dbConnection = db, parcelIds) {
    const result = await dbConnection.query(
      `UPDATE land_parcels
       SET status = 'finalized', 
           finalized_at = NOW(), 
           updated_at = NOW()
       WHERE id = ANY($1)
       RETURNING id, stand, designation, status, finalized_at`,
      [parcelIds]
    )
    return result.rows
  },

  /**
   * Find Outside Figure parcel for a project
   * Searches for parcel with "outside figure" in stand name, designation, or description
   * or with is_outside_figure flag in metadata
   * 
   * @param {object} dbConnection - Database connection
   * @param {number} projectId - Project ID
   * @returns {Promise<object|null>} Outside Figure parcel with geometry, or null if not found
   */
  async findOutsideFigure(dbConnection = db, projectId) {
    // Determine project's native SRID for geometry transformation
    const prjResult = await dbConnection.query(
      'SELECT central_meridian FROM survey_projects WHERE id = $1', [projectId]
    );
    const nativeSrid = prjResult.rows.length > 0
      ? getCapeLoSRID(prjResult.rows[0].central_meridian)
      : 22291;  // Default to Lo 31
    
    // No transformation needed - geometry is already stored in project's native CRS
    
    const result = await dbConnection.query(
      `SELECT 
        lp.*,
        ST_AsGeoJSON(lp.geom)::jsonb as geom,
        ST_NPoints(lp.geom) as vertex_count,
        ST_Area(lp.geom) as area_m2,
        ST_Area(lp.geom) / 10000 as area_ha,
        ST_Perimeter(lp.geom) as perimeter_m
      FROM land_parcels lp
      WHERE project_id = $1
        AND (
          LOWER(stand) LIKE '%outside figure%'
          OR LOWER(designation) LIKE '%outside figure%'
          OR LOWER(notes) LIKE '%outside figure%'
          OR (metadata->>'is_outside_figure')::boolean = true
        )
      LIMIT 1`,
      [projectId]
    )
    return result.rows[0] || null
  }
}
