import db from '../config/db.js'
import { getCapeLoSRID } from '../utils/capeLoSRID.js'

// Geometry is stored in each project's native CRS (Lo 25/27/29/31/33).
// The column SRID constraint has been removed to support multi-zone storage.

export default {
  async findAll(dbConnection = db) {
    const result = await dbConnection.query('SELECT * FROM coordinate_points ORDER BY name')
    return result.rows
  },

  async findById(dbConnection = db, id) {
    const result = await dbConnection.query('SELECT * FROM coordinate_points WHERE id = $1', [id])
    return result.rows[0]
  },

  async findByProject(dbConnection = db, projectId) {
    // Determine the project's native SRID
    const projResult = await dbConnection.query(
      'SELECT central_meridian FROM survey_projects WHERE id = $1', [projectId]
    );
    const nativeSrid = projResult.rows.length > 0
      ? getCapeLoSRID(projResult.rows[0].central_meridian)
      : 22291;  // Default to Lo 31

    // No transformation needed - geometry is already stored in project's native CRS
    const result = await dbConnection.query(
      `SELECT 
        id, project_id, name, geom, elevation, description,
        survey_date, surveyor, created_at, updated_at,
        ST_X(geom) as y,
        ST_Y(geom) as x
       FROM coordinate_points 
       WHERE project_id = $1 
       ORDER BY name`,
      [projectId]
    )
    // Cape Lo / Gauss Lo coordinate convention:
    // ST_MakePoint(Westing, Southing) stores Westing as X ordinate, Southing as Y ordinate
    // So ST_X returns Westing (y), ST_Y returns Southing (x)
    return result.rows
  },

  async findByName(dbConnection = db, projectId, name) {
    const result = await dbConnection.query(
      'SELECT * FROM coordinate_points WHERE project_id = $1 AND name = $2',
      [projectId, name]
    )
    return result.rows[0]
  },

  async create(dbConnection = db, { projectId, name, y, x, elevation, description, surveyDate, surveyor, srid }) {
    // Get SRID from project's central meridian if not provided
    let finalSrid = srid;
    if (!finalSrid) {
      const projectResult = await dbConnection.query(
        'SELECT central_meridian FROM survey_projects WHERE id = $1',
        [projectId]
      );
      if (projectResult.rows.length > 0) {
        finalSrid = getCapeLoSRID(projectResult.rows[0].central_meridian);
      } else {
        finalSrid = 22291; // Default to Lo 31
      }
    }
    
    // Store geometry in project's native SRID (NOT forced to Lo 31)
    // Each project's data stays in its own central meridian
    const result = await dbConnection.query(
      `INSERT INTO coordinate_points 
       (project_id, name, geom, elevation, description, survey_date, surveyor) 
       VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), ${finalSrid}), $5, $6, $7, $8) 
       RETURNING *`,
      [projectId, name, y, x, elevation, description, surveyDate, surveyor]
    )
    
    console.log('[CoordinatePoint] ✅ Stored in project CRS:', {
      name,
      srid: finalSrid,
      centralMeridian: finalSrid === 22289 ? 29 : finalSrid === 22291 ? 31 : 'other'
    })
    
    return result.rows[0]
  },

  async batchCreate(dbConnection = db, projectId, points) {
    // Get SRID from project's central meridian
    const projectResult = await dbConnection.query(
      'SELECT central_meridian FROM survey_projects WHERE id = $1',
      [projectId]
    );
    const srid = projectResult.rows.length > 0 
      ? getCapeLoSRID(projectResult.rows[0].central_meridian)
      : 22291; // Default to Lo 31
    
    console.log(`[CoordinatePoint.batchCreate] 📏 Project central_meridian=${projectResult.rows[0]?.central_meridian}, native SRID=${srid}`);
    
    // Smart duplicate handling: detect duplicates and average coordinates if within reasonable limits
    const COORDINATE_TOLERANCE = 0.5; // 0.5 meters - reasonable survey measurement tolerance
    const processedPoints = new Map(); // name -> {x, y, elevation, description, count, coordinates[]}
    const skippedDuplicates = [];
    
    console.log(`[CoordinatePoint.batchCreate] 🔍 Pre-processing ${points.length} points for duplicates...`);
    
    for (const pt of points) {
      if (processedPoints.has(pt.name)) {
        const existing = processedPoints.get(pt.name);
        
        // Calculate coordinate difference
        const deltaY = Math.abs(pt.y - existing.y);
        const deltaX = Math.abs(pt.x - existing.x);
        const distance = Math.sqrt(deltaY * deltaY + deltaX * deltaX);
        
        if (distance <= COORDINATE_TOLERANCE) {
          // Within tolerance - average the coordinates
          existing.coordinates.push({ y: pt.y, x: pt.x });
          existing.count++;
          
          // Recalculate average
          const avgY = existing.coordinates.reduce((sum, c) => sum + c.y, 0) / existing.coordinates.length;
          const avgX = existing.coordinates.reduce((sum, c) => sum + c.x, 0) / existing.coordinates.length;
          
          existing.y = avgY;
          existing.x = avgX;
          
          console.log(`[CoordinatePoint.batchCreate] 📊 Duplicate "${pt.name}": averaged coordinates (distance: ${distance.toFixed(3)}m, count: ${existing.count})`);
          console.log(`  - New average: Y=${avgY.toFixed(3)}, X=${avgX.toFixed(3)}`);
        } else {
          // Outside tolerance - skip this duplicate
          skippedDuplicates.push({
            name: pt.name,
            distance: distance.toFixed(3),
            existing: { y: existing.y.toFixed(3), x: existing.x.toFixed(3) },
            duplicate: { y: pt.y.toFixed(3), x: pt.x.toFixed(3) }
          });
          console.warn(`[CoordinatePoint.batchCreate] ⚠️ Duplicate "${pt.name}" SKIPPED: coordinates differ by ${distance.toFixed(3)}m (> ${COORDINATE_TOLERANCE}m tolerance)`);
          console.warn(`  - Existing: Y=${existing.y.toFixed(3)}, X=${existing.x.toFixed(3)}`);
          console.warn(`  - Duplicate: Y=${pt.y.toFixed(3)}, X=${pt.x.toFixed(3)}`);
        }
      } else {
        // First occurrence - store it
        processedPoints.set(pt.name, {
          name: pt.name,
          y: pt.y,
          x: pt.x,
          elevation: pt.elevation,
          description: pt.description,
          count: 1,
          coordinates: [{ y: pt.y, x: pt.x }]
        });
      }
    }
    
    // Convert processed points back to array
    const uniquePoints = Array.from(processedPoints.values()).map(p => ({
      name: p.name,
      y: p.y,
      x: p.x,
      elevation: p.elevation,
      description: p.description
    }));
    
    console.log(`[CoordinatePoint.batchCreate] 📊 Pre-processing complete:`);
    console.log(`  - Original points: ${points.length}`);
    console.log(`  - Unique points: ${uniquePoints.length}`);
    console.log(`  - Averaged duplicates: ${points.length - uniquePoints.length - skippedDuplicates.length}`);
    console.log(`  - Skipped duplicates: ${skippedDuplicates.length}`);
    
    // Process in chunks to avoid PostgreSQL parameter limits
    const CHUNK_SIZE = 100;
    const allResults = [];
    const errors = [];
    
    for (let i = 0; i < uniquePoints.length; i += CHUNK_SIZE) {
      const chunk = uniquePoints.slice(i, i + CHUNK_SIZE);
      const chunkNum = Math.floor(i/CHUNK_SIZE) + 1;
      const totalChunks = Math.ceil(uniquePoints.length/CHUNK_SIZE);
      
      console.log(`[CoordinatePoint.batchCreate] Processing chunk ${chunkNum}/${totalChunks} (${chunk.length} points)`);
      
      try {
        const values = []
        const params = []
        let paramIndex = 1

        for (const pt of chunk) {
          // ST_MakePoint(Westing, Southing) in project's native CRS
          // Store directly in project's SRID (NOT transformed to Lo 31)
          values.push(`($${paramIndex}, $${paramIndex+1}, ST_SetSRID(ST_MakePoint($${paramIndex+2}, $${paramIndex+3}), ${srid}), $${paramIndex+4}, $${paramIndex+5})`)
          params.push(projectId, pt.name, pt.y, pt.x, pt.elevation || null, pt.description || null)
          paramIndex += 6
        }

        const sql = `
          INSERT INTO coordinate_points (project_id, name, geom, elevation, description)
          VALUES ${values.join(', ')}
          ON CONFLICT (project_id, name) 
          DO UPDATE SET 
            geom = EXCLUDED.geom,
            elevation = EXCLUDED.elevation,
            description = EXCLUDED.description,
            updated_at = CURRENT_TIMESTAMP
          RETURNING *
        `
        const result = await dbConnection.query(sql, params)
        allResults.push(...result.rows);
        console.log(`[CoordinatePoint.batchCreate] ✅ Chunk ${chunkNum}/${totalChunks} completed: ${result.rows.length} points`);
      } catch (error) {
        console.error(`[CoordinatePoint.batchCreate] ❌ ERROR in chunk ${chunkNum}/${totalChunks}:`, error.message);
        console.error(`[CoordinatePoint.batchCreate] Chunk details: ${chunk.length} points, first point: ${chunk[0]?.name}`);
        console.error(`[CoordinatePoint.batchCreate] Error stack:`, error.stack);
        errors.push({
          chunk: chunkNum,
          pointCount: chunk.length,
          firstPoint: chunk[0]?.name,
          error: error.message
        });
        // Continue processing remaining chunks instead of failing completely
      }
    }
    
    if (errors.length > 0) {
      console.error(`[CoordinatePoint.batchCreate] ⚠️ Completed with ${errors.length} chunk errors`);
      console.error(`[CoordinatePoint.batchCreate] Failed chunks:`, JSON.stringify(errors, null, 2));
      
      // Throw error to notify frontend that some points failed
      const totalFailed = errors.reduce((sum, e) => sum + e.pointCount, 0);
      throw new Error(
        `Batch insert partially failed: ${allResults.length} points succeeded, ${totalFailed} points failed. ` +
        `Failed chunks: ${errors.map(e => `#${e.chunk} (${e.pointCount} points, error: ${e.error})`).join(', ')}`
      );
    }
    
    console.log(`[CoordinatePoint.batchCreate] ✅ Successfully created/updated ${allResults.length} points`);
    
    if (skippedDuplicates.length > 0) {
      console.warn(`[CoordinatePoint.batchCreate] ⚠️ Warning: ${skippedDuplicates.length} duplicate(s) were skipped due to coordinate differences exceeding tolerance`);
    }
    
    return allResults;
  },

  async update(dbConnection = db, id, { name, y, x, elevation, description, surveyDate, surveyor, srid }) {
    // Get SRID from project's central meridian if not provided and coordinates are being updated
    let finalSrid = srid;
    if (!finalSrid && x !== undefined && y !== undefined) {
      const pointResult = await dbConnection.query(
        'SELECT project_id FROM coordinate_points WHERE id = $1',
        [id]
      );
      if (pointResult.rows.length > 0) {
        const projectResult = await dbConnection.query(
          'SELECT central_meridian FROM survey_projects WHERE id = $1',
          [pointResult.rows[0].project_id]
        );
        if (projectResult.rows.length > 0) {
          finalSrid = getCapeLoSRID(projectResult.rows[0].central_meridian);
        } else {
          finalSrid = 22291; // Default to Lo 31
        }
      }
    }
    
    // Store geometry in project's native SRID (NOT forced to Lo 31)
    const useSrid = finalSrid || 22291;
    // $2 and $3 carry explicit ::float8 casts so PostgreSQL can resolve their
    // type even when both are null. Without the casts, a description-only
    // update (y/x both null) fails with "could not determine data type of
    // parameter $2" (42P08) — the `$2 IS NOT NULL` expression doesn't
    // constrain the param type, and pg-node sends unknown-typed NULLs.
    const result = await dbConnection.query(
      `UPDATE coordinate_points
       SET name = COALESCE($1, name),
           geom = CASE WHEN $2::float8 IS NOT NULL AND $3::float8 IS NOT NULL
                  THEN ST_SetSRID(ST_MakePoint($2::float8, $3::float8), ${useSrid})
                  ELSE geom END,
           elevation = COALESCE($4, elevation),
           description = COALESCE($5, description),
           survey_date = COALESCE($6, survey_date),
           surveyor = COALESCE($7, surveyor)
       WHERE id = $8
       RETURNING *`,
      [name, y, x, elevation, description, surveyDate, surveyor, id]
    )
    
    console.log('[CoordinatePoint] ✅ Updated in project CRS:', {
      id,
      srid: useSrid,
      centralMeridian: useSrid === 22289 ? 29 : useSrid === 22291 ? 31 : 'other'
    })
    
    return result.rows[0]
  },

  async delete(dbConnection = db, id) {
    await dbConnection.query('DELETE FROM coordinate_points WHERE id = $1', [id])
  },

  async deleteByProject(dbConnection = db, projectId) {
    const result = await dbConnection.query('DELETE FROM coordinate_points WHERE project_id = $1', [projectId])
    return result.rowCount
  }
}
