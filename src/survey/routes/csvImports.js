/**
 * CSV Import Management Routes
 * Handles CSV import tracking, smart merge analysis, and import history
 */

import crypto from 'crypto';
import { authenticateWithSchema } from '../utils/schemaAuth.js';
import { getCapeLoSRID } from '../utils/capeLoSRID.js';

export default async function csvImportRoutes(fastify, options) {
  const db = fastify.surveyPg;

  /**
   * GET /csv-imports?project_id=X
   * Get all CSV imports for a project
   */
  fastify.get('/csv-imports', {
    preHandler: [fastify.authenticate, authenticateWithSchema]
  }, async (request, reply) => {
    const { project_id } = request.query;

    if (!project_id) {
      return reply.code(400).send({ error: 'project_id is required' });
    }

    const schemaDb = request.db || db;

    try {
      const result = await schemaDb.query(
        `SELECT * FROM v_import_summary 
         WHERE project_id = $1 
         ORDER BY import_date DESC`,
        [project_id]
      );

      return { data: result.rows };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch CSV imports' });
    }
  });

  /**
   * GET /csv-imports/:id
   * Get details of a specific CSV import
   */
  fastify.get('/csv-imports/:id', {
    preHandler: [fastify.authenticate, authenticateWithSchema]
  }, async (request, reply) => {
    const { id } = request.params;
    const schemaDb = request.db || db;

    try {
      const result = await schemaDb.query(
        `SELECT i.*, 
                COUNT(DISTINCT p.id) AS parcel_count,
                COUNT(DISTINCT cp.id) AS point_count,
                u.username AS imported_by_username
         FROM project_csv_imports i
         LEFT JOIN land_parcels p ON p.import_id = i.id
         LEFT JOIN coordinate_points cp ON cp.import_id = i.id
         LEFT JOIN users u ON u.id = i.imported_by
         WHERE i.id = $1
         GROUP BY i.id, u.username`,
        [id]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'CSV import not found' });
      }

      return { data: result.rows[0] };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch CSV import details' });
    }
  });

  /**
   * GET /csv-imports/latest/:project_id
   * Get the latest CSV import for a project
   */
  fastify.get('/csv-imports/latest/:project_id', {
    preHandler: [fastify.authenticate, authenticateWithSchema]
  }, async (request, reply) => {
    const { project_id } = request.params;
    const schemaDb = request.db || db;

    try {
      const result = await schemaDb.query(
        `SELECT * FROM v_import_summary 
         WHERE project_id = $1 
         ORDER BY import_date DESC 
         LIMIT 1`,
        [project_id]
      );

      if (result.rows.length === 0) {
        return { data: null };
      }

      return { data: result.rows[0] };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch latest CSV import' });
    }
  });

  /**
   * POST /csv-imports
   * Create a new CSV import record
   */
  fastify.post('/csv-imports', {
    preHandler: [fastify.authenticate, authenticateWithSchema]
  }, async (request, reply) => {
    console.log('[CSV Import] 📥 POST /csv-imports endpoint hit');
    console.log('[CSV Import] Request body keys:', Object.keys(request.body || {}));
    
    const {
      project_id,
      csv_content,
      filename,
      point_count,
      coordinate_system,
      metadata = {}
    } = request.body;

    console.log('[CSV Import] Extracted values:', {
      project_id,
      filename,
      point_count,
      coordinate_system,
      csv_content_length: csv_content?.length || 0
    });

    if (!project_id || !csv_content || !point_count) {
      console.log('[CSV Import] ❌ Validation failed - missing required fields');
      return reply.code(400).send({
        error: 'project_id, csv_content, and point_count are required'
      });
    }

    try {
      console.log('[CSV Import] ✅ Validation passed, proceeding with import...');
      
      // Use surveyor-specific schema database connection
      const schemaDb = request.db || db;
      
      // Calculate CSV hash
      const csv_hash = crypto
        .createHash('sha256')
        .update(csv_content)
        .digest('hex');

      // Check if this exact CSV has been imported before FOR THIS SPECIFIC PROJECT
      // Uses surveyor's schema (set by authenticateWithSchema middleware)
      const existingResult = await schemaDb.query(
        `SELECT id FROM project_csv_imports 
         WHERE project_id = $1 AND csv_hash = $2`,
        [project_id, csv_hash]
      );

      if (existingResult.rows.length > 0) {
        // Allow re-import for the same project (user will get re-import dialog in frontend)
        // This is intentional - same CSV can be imported multiple times for corrections
        console.log('[CSV Import] Existing import found for project', project_id, '- allowing re-import');
      }

      // Get user ID from request (set by authenticate middleware)
      const imported_by = request.user?.id || null;

      // Create new import record in surveyor's schema
      const result = await schemaDb.query(
        `INSERT INTO project_csv_imports 
         (project_id, csv_hash, point_count, filename, imported_by, coordinate_system, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [project_id, csv_hash, point_count, filename, imported_by, coordinate_system, metadata]
      );

      return { data: result.rows[0] };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to create CSV import record' });
    }
  });

  /**
   * PUT /csv-imports/:id
   * Update CSV import metadata (e.g., mark documents as generated)
   */
  fastify.put('/csv-imports/:id', async (request, reply) => {
    const { id } = request.params;
    const { has_generated_documents, metadata } = request.body;

    try {
      const updates = [];
      const values = [];
      let paramIndex = 1;

      if (has_generated_documents !== undefined) {
        updates.push(`has_generated_documents = $${paramIndex++}`);
        values.push(has_generated_documents);
      }

      if (metadata !== undefined) {
        updates.push(`metadata = $${paramIndex++}`);
        values.push(metadata);
      }

      if (updates.length === 0) {
        return reply.code(400).send({ error: 'No fields to update' });
      }

      values.push(id);

      const result = await db.query(
        `UPDATE project_csv_imports 
         SET ${updates.join(', ')}
         WHERE id = $${paramIndex}
         RETURNING *`,
        values
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'CSV import not found' });
      }

      return { data: result.rows[0] };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to update CSV import' });
    }
  });

  /**
   * POST /csv-imports/analyze-merge
   * Analyze potential merge between existing and new CSV data
   */
  fastify.post('/csv-imports/analyze-merge', async (request, reply) => {
    console.log('[CSV Import] analyze-merge endpoint called');
    console.log('[CSV Import] Request body:', JSON.stringify(request.body, null, 2));
    
    const {
      project_id,
      new_points, // Array of { id, y, x }
      tolerance = 0.01 // Default 1cm tolerance
    } = request.body;

    console.log('[CSV Import] Parsed params:', { project_id, point_count: new_points?.length, tolerance });

    if (!project_id || !new_points || !Array.isArray(new_points)) {
      console.error('[CSV Import] Validation failed:', { project_id, has_new_points: !!new_points, is_array: Array.isArray(new_points) });
      return reply.code(400).send({
        error: 'project_id and new_points array are required'
      });
    }

    try {
      console.log('[CSV Import] Starting merge analysis for project:', project_id);
      // Get existing points for the project
      console.log('[CSV Import] Querying existing points...');
      const existingPointsResult = await db.query(
        `SELECT id, name, ST_X(geom) as y, ST_Y(geom) as x, import_id
         FROM coordinate_points
         WHERE project_id = $1`,
        [project_id]
      );

      const existingPoints = existingPointsResult.rows;
      console.log('[CSV Import] Found', existingPoints.length, 'existing points');

      // Get existing parcels
      console.log('[CSV Import] Querying existing parcels...');
      const parcelsResult = await db.query(
        `SELECT id, stand as designation, ST_AsGeoJSON(geom) as geometry, import_id, parcel_status
         FROM land_parcels
         WHERE project_id = $1 AND parcel_status = 'active'`,
        [project_id]
      );

      const parcels = parcelsResult.rows;
      console.log('[CSV Import] Found', parcels.length, 'existing parcels');

      // Perform matching analysis
      const matched = [];
      const newUnmatched = [];
      const removedPoints = [];

      // Match new points to existing points by coordinate proximity
      for (const newPt of new_points) {
        let bestMatch = null;
        let minDistance = Infinity;

        for (const oldPt of existingPoints) {
          const distance = Math.sqrt(
            Math.pow(newPt.y - oldPt.y, 2) +
            Math.pow(newPt.x - oldPt.x, 2)
          );

          if (distance <= tolerance && distance < minDistance) {
            minDistance = distance;
            bestMatch = oldPt;
          }
        }

        if (bestMatch) {
          matched.push({
            oldId: bestMatch.name,
            oldDbId: bestMatch.id,
            newId: newPt.id,
            coordinate: { y: newPt.y, x: newPt.x },
            distance: minDistance
          });
        } else {
          newUnmatched.push({
            id: newPt.id,
            coordinate: { y: newPt.y, x: newPt.x }
          });
        }
      }

      // Find removed points (in existing but not matched)
      const matchedOldIds = new Set(matched.map(m => m.oldDbId));
      for (const oldPt of existingPoints) {
        if (!matchedOldIds.has(oldPt.id)) {
          // Check if this point is used in any parcels
          const usedInParcels = [];
          for (const parcel of parcels) {
            const geom = JSON.parse(parcel.geometry);
            const coords = geom.coordinates[0]; // Polygon exterior ring

            for (const coord of coords) {
              const [x, y] = coord;
              const distance = Math.sqrt(
                Math.pow(y - oldPt.y, 2) +
                Math.pow(x - oldPt.x, 2)
              );
              if (distance <= tolerance) {
                usedInParcels.push(parcel.designation);
                break;
              }
            }
          }

          removedPoints.push({
            id: oldPt.name,
            dbId: oldPt.id,
            coordinate: { y: oldPt.y, x: oldPt.x },
            usedInParcels
          });
        }
      }

      // Analyze parcel impact
      const parcelAnalysis = {
        fullyMatched: [],
        partiallyMatched: [],
        orphaned: []
      };

      for (const parcel of parcels) {
        const geom = JSON.parse(parcel.geometry);
        const vertices = geom.coordinates[0]; // Polygon exterior ring

        let matchedVertices = 0;
        const missingVertices = [];

        for (const coord of vertices) {
          const [x, y] = coord;

          // Check if this vertex matches any new point
          const hasMatch = new_points.some(newPt => {
            const distance = Math.sqrt(
              Math.pow(y - newPt.y, 2) +
              Math.pow(x - newPt.x, 2)
            );
            return distance <= tolerance;
          });

          if (hasMatch) {
            matchedVertices++;
          } else {
            missingVertices.push({ y, x });
          }
        }

        const matchRatio = matchedVertices / vertices.length;

        if (matchRatio === 1.0) {
          parcelAnalysis.fullyMatched.push({
            id: parcel.id,
            designation: parcel.designation,
            vertexCount: vertices.length
          });
        } else if (matchRatio > 0) {
          parcelAnalysis.partiallyMatched.push({
            id: parcel.id,
            designation: parcel.designation,
            vertexCount: vertices.length,
            matchedCount: matchedVertices,
            matchRatio: Math.round(matchRatio * 100),
            missingVertices
          });
        } else {
          parcelAnalysis.orphaned.push({
            id: parcel.id,
            designation: parcel.designation,
            vertexCount: vertices.length
          });
        }
      }

      return {
        data: {
          matched,
          newPoints: newUnmatched,
          removedPoints,
          parcelAnalysis,
          summary: {
            existingPointCount: existingPoints.length,
            newPointCount: new_points.length,
            matchedCount: matched.length,
            newCount: newUnmatched.length,
            removedCount: removedPoints.length,
            parcelCount: parcels.length,
            fullyMatchedParcels: parcelAnalysis.fullyMatched.length,
            partiallyMatchedParcels: parcelAnalysis.partiallyMatched.length,
            orphanedParcels: parcelAnalysis.orphaned.length
          }
        }
      };
    } catch (error) {
      fastify.log.error('Error in analyze-merge:', error);
      console.error('[CSV Import] Analyze merge error:', error.message);
      console.error('[CSV Import] Stack:', error.stack);
      return reply.code(500).send({ 
        error: 'Failed to analyze merge',
        details: error.message 
      });
    }
  });

  /**
   * POST /csv-imports/execute-merge
   * Execute a smart merge based on analysis results
   */
  fastify.post('/csv-imports/execute-merge', async (request, reply) => {
    console.log('[CSV Import] execute-merge endpoint called');
    console.log('[CSV Import] Request body keys:', Object.keys(request.body));
    
    const {
      project_id,
      import_id,
      matched_points, // Array of { oldDbId, newId, coordinate }
      new_points, // Array of { id, y, x }
      orphaned_parcel_ids = [], // Parcels to delete
      partial_parcel_actions = {}, // { parcelId: 'delete' | 'keep' | 'review' }
      duplicate_tolerance = 0.1, // Default to standard precision (100mm)
      detectedCentralMeridian // Cape Lo zone detected from CSV System column (25/27/29/31/33)
    } = request.body;

    console.log('[CSV Import] Execute merge params:', {
      project_id,
      import_id,
      matched_count: matched_points?.length,
      new_count: new_points?.length,
      orphaned_count: orphaned_parcel_ids?.length,
      detectedCentralMeridian: detectedCentralMeridian || 'not provided'
    });

    if (!project_id || !import_id) {
      console.error('[CSV Import] Validation failed:', { project_id, import_id });
      return reply.code(400).send({
        error: 'project_id and import_id are required'
      });
    }

    const client = await db.connect();

    try {
      console.log('[CSV Import] Starting transaction...');
      await client.query('BEGIN');

      // Determine central meridian: Use detected value from CSV if provided, otherwise use project's setting
      let centralMeridian;
      let meridianSource;
      
      if (detectedCentralMeridian) {
        // CSV has System column with Cape Lo zone
        centralMeridian = detectedCentralMeridian;
        meridianSource = 'CSV System column';
        console.log(`[CSV Import] 🎯 Using central meridian from CSV System column: Lo ${centralMeridian}`);
      } else {
        // Fall back to project's central meridian setting
        const projectResult = await client.query(
          'SELECT central_meridian FROM survey_projects WHERE id = $1',
          [project_id]
        );
        
        if (projectResult.rows.length === 0) {
          throw new Error(`Project ${project_id} not found`);
        }
        
        centralMeridian = projectResult.rows[0].central_meridian;
        meridianSource = 'project setting';
        console.log(`[CSV Import] 📋 Using central meridian from project setting: Lo ${centralMeridian}`);
      }
      
      const srid = getCapeLoSRID(centralMeridian);
      console.log(`[CSV Import] Central meridian: Lo ${centralMeridian} (from ${meridianSource}), SRID: ${srid}`);

      // 0. Delete existing points for this project (for re-import)
      // This allows clean re-import without duplicate key violations
      const deleteResult = await client.query(
        'DELETE FROM coordinate_points WHERE project_id = $1',
        [project_id]
      );
      console.log('[CSV Import] Deleted', deleteResult.rowCount, 'existing points');

      // 1. Update matched points with new coordinates (if changed)
      console.log('[CSV Import] Updating', matched_points.length, 'matched points...');
      for (const match of matched_points) {
        // PostGIS ST_MakePoint expects (X, Y) where X=longitude-like, Y=latitude-like
        // EPSG:22291 axis definition: X=Westing (~97k), Y=Southing (~2.2M)
        // match.coordinate has: y=Westing, x=Southing (from CSV parser)
        // So we pass: ST_MakePoint(y, x) = ST_MakePoint(Westing, Southing)
        await client.query(
          `UPDATE coordinate_points
           SET geom = ST_SetSRID(ST_MakePoint($1, $2), $6),
               import_id = $3,
               name = $4
           WHERE id = $5`,
          [match.coordinate.y, match.coordinate.x, import_id, match.newId, match.oldDbId, srid]
        );

        // Record history
        await client.query(
          `INSERT INTO coordinate_point_history 
           (point_id, import_id, action, point_name, coordinates)
           VALUES ($1, $2, 'matched', $3, $4)`,
          [match.oldDbId, import_id, match.newId, JSON.stringify(match.coordinate)]
        );
      }

      // 2. Add new points (deduplicate by ID, averaging coordinates for duplicates)
      const pointGroups = new Map();
      for (const pt of new_points) {
        if (!pointGroups.has(pt.id)) {
          pointGroups.set(pt.id, [pt]);
        } else {
          pointGroups.get(pt.id).push(pt);
        }
      }
      
      const deduplicatedPoints = [];
      let duplicateCount = 0;
      
      for (const [id, points] of pointGroups.entries()) {
        if (points.length === 1) {
          deduplicatedPoints.push(points[0]);
        } else {
          // Multiple observations - average the coordinates
          duplicateCount += points.length - 1;
          
          // Calculate average
          const avgY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
          const avgX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
          
          // Check if observations are within user-specified tolerance
          const maxDiffY = Math.max(...points.map(p => Math.abs(p.y - avgY)));
          const maxDiffX = Math.max(...points.map(p => Math.abs(p.x - avgX)));
          const maxDiff = Math.max(maxDiffY, maxDiffX);
          
          if (maxDiff > duplicate_tolerance) {
            console.warn(`[CSV Import] Warning: Point ${id} has ${points.length} observations with max difference ${maxDiff.toFixed(3)}m (exceeds ${duplicate_tolerance}m tolerance)`);
          }
          
          console.log(`[CSV Import] Averaging ${points.length} observations for point ${id}: Y=${avgY.toFixed(3)}, X=${avgX.toFixed(3)} (max diff: ${maxDiff.toFixed(3)}m)`);
          
          deduplicatedPoints.push({
            id,
            y: avgY,
            x: avgX
          });
        }
      }
      
      console.log('[CSV Import] Adding', deduplicatedPoints.length, 'new points (', duplicateCount, 'duplicate observations averaged)...');
      for (const newPt of deduplicatedPoints) {
        // PostGIS ST_MakePoint expects (X, Y) where X=longitude-like, Y=latitude-like
        // EPSG:22291 axis definition: X=Westing (~97k), Y=Southing (~2.2M)
        // CSV provides: newPt.y=Westing, newPt.x=Southing (from CSV parser)
        // So we pass: ST_MakePoint(newPt.y, newPt.x) = ST_MakePoint(Westing, Southing)
        // SRID is determined from project's central_meridian setting
        const result = await client.query(
          `INSERT INTO coordinate_points 
           (project_id, name, geom, status, description, import_id)
           VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), $8), $5, $6, $7)
           RETURNING id`,
          [project_id, newPt.id, newPt.y, newPt.x, newPt.status, newPt.description, import_id, srid]
        );

        // Record history
        await client.query(
          `INSERT INTO coordinate_point_history 
           (point_id, import_id, action, point_name, coordinates)
           VALUES ($1, $2, 'created', $3, $4)`,
          [result.rows[0].id, import_id, newPt.id, JSON.stringify({ y: newPt.y, x: newPt.x })]
        );
      }

      // 3. Delete orphaned parcels
      if (orphaned_parcel_ids.length > 0) {
        await client.query(
          `UPDATE land_parcels
           SET parcel_status = 'orphaned'
           WHERE id = ANY($1)`,
          [orphaned_parcel_ids]
        );
      }

      // 4. Handle partial parcels based on actions
      for (const [parcelId, action] of Object.entries(partial_parcel_actions)) {
        if (action === 'delete') {
          await client.query(
            `UPDATE land_parcels
             SET parcel_status = 'orphaned'
             WHERE id = $1`,
            [parcelId]
          );
        } else if (action === 'review') {
          await client.query(
            `UPDATE land_parcels
             SET parcel_status = 'pending_review'
             WHERE id = $1`,
            [parcelId]
          );
        }
        // 'keep' action: do nothing, leave as active
      }

      // 5. Update import record
      await client.query(
        `UPDATE project_csv_imports
         SET has_generated_documents = FALSE
         WHERE id = $1`,
        [import_id]
      );

      console.log('[CSV Import] Committing transaction...');
      await client.query('COMMIT');

      console.log('[CSV Import] Merge executed successfully!');
      return {
        success: true,
        message: 'Merge executed successfully',
        data: {
          matched_count: matched_points.length,
          new_count: new_points.length,
          orphaned_parcels: orphaned_parcel_ids.length
        }
      };
    } catch (error) {
      console.error('[CSV Import] Execute merge error:', error.message);
      console.error('[CSV Import] Stack:', error.stack);
      await client.query('ROLLBACK');
      fastify.log.error('Error in execute-merge:', error);
      return reply.code(500).send({ 
        error: 'Failed to execute merge',
        details: error.message 
      });
    } finally {
      client.release();
    }
  });

  /**
   * GET /csv-imports/:id/history
   * Get point history for a specific import
   */
  fastify.get('/csv-imports/:id/history', async (request, reply) => {
    const { id } = request.params;

    try {
      const result = await db.query(
        `SELECT h.*, cp.name as current_point_name
         FROM coordinate_point_history h
         LEFT JOIN coordinate_points cp ON cp.id = h.point_id
         WHERE h.import_id = $1
         ORDER BY h.created_at DESC`,
        [id]
      );

      return { data: result.rows };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch import history' });
    }
  });
}
