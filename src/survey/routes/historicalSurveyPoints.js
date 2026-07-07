/**
 * Historical Survey Points Routes
 * Handles import and management of previous survey data for beacon comparison
 * Used by Found Beacons Assessment module with SI 727 of 1979 tolerances
 */

import crypto from 'crypto';

export default async function historicalSurveyPointsRoutes(fastify, options) {
  const db = fastify.surveyPg;

  /**
   * GET /historical-survey-points?project_id=X
   * Get all historical survey points for a project
   */
  fastify.get('/historical-survey-points', async (request, reply) => {
    const { project_id } = request.query;

    if (!project_id) {
      return reply.code(400).send({ error: 'project_id is required' });
    }

    try {
      const result = await db.query(
        `SELECT * FROM historical_survey_points 
         WHERE project_id = $1 
         ORDER BY point_name`,
        [project_id]
      );

      return { data: result.rows };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch historical survey points' });
    }
  });

  /**
   * GET /historical-survey-points/comparison?project_id=X
   * Get beacon comparison analysis for a project
   */
  fastify.get('/historical-survey-points/comparison', async (request, reply) => {
    const { project_id, tolerance_type = 'urban' } = request.query;

    if (!project_id) {
      return reply.code(400).send({ error: 'project_id is required' });
    }

    // SI 727 tolerances
    const tolerance = tolerance_type === 'rural' ? 0.10 : 0.05;

    try {
      const result = await db.query(
        `SELECT * FROM v_beacon_comparison 
         WHERE project_id = $1 
         ORDER BY historical_point_name`,
        [project_id]
      );

      // Calculate summary statistics
      const rows = result.rows;
      const summary = {
        total_historical: rows.length,
        matched: rows.filter(r => r.current_point_id !== null).length,
        not_matched: rows.filter(r => r.current_point_id === null).length,
        within_tolerance: rows.filter(r => 
          r.linear_distance !== null && r.linear_distance <= tolerance
        ).length,
        exceeds_tolerance: rows.filter(r => 
          r.linear_distance !== null && r.linear_distance > tolerance
        ).length,
        tolerance_used: tolerance,
        tolerance_type: tolerance_type
      };

      return { 
        data: rows,
        summary: summary
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to fetch beacon comparison' });
    }
  });

  /**
   * POST /historical-survey-points/import
   * Import historical survey points from CSV data
   * Expected CSV format: Point, Y, X, SR_num, Description, Survey_date
   */
  fastify.post('/historical-survey-points/import', async (request, reply) => {
    const {
      project_id,
      points,
      filename,
      metadata = {}
    } = request.body;

    if (!project_id || !points || !Array.isArray(points) || points.length === 0) {
      return reply.code(400).send({
        error: 'project_id and points array are required'
      });
    }

    const client = await db.connect();

    try {
      await client.query('BEGIN');

      // Generate a simple import ID - use null since we don't need tracking
      const import_id = null;
      
      // Clear existing historical points for this project before re-importing
      await client.query(
        'DELETE FROM historical_survey_points WHERE project_id = $1',
        [project_id]
      );
      fastify.log.info(`[HistoricalSurveyPoints] Cleared existing points for project ${project_id} before import`);

      // Insert historical survey points
      let insertedCount = 0;
      let skippedCount = 0;
      const errors = [];

      fastify.log.info(`[HistoricalSurveyPoints] Processing ${points.length} points for project ${project_id}`);
      if (points.length > 0) {
        fastify.log.info(`[HistoricalSurveyPoints] First point keys: ${Object.keys(points[0]).join(', ')}`);
        fastify.log.info(`[HistoricalSurveyPoints] First point: ${JSON.stringify(points[0])}`);
      }

      for (const point of points) {
        try {
          // Validate required fields - check multiple possible field names
          const pointName = point.point_name || point.Point || point.name || point.NAME || point.beacon;
          if (!pointName) {
            fastify.log.warn(`[HistoricalSurveyPoints] Missing point name for: ${JSON.stringify(point)}`);
            errors.push({ point, error: 'Missing point name' });
            skippedCount++;
            continue;
          }

          let yCoord = parseFloat(point.y_coordinate || point.Y || point.y || point.northing || point.Northing);
          let xCoord = parseFloat(point.x_coordinate || point.X || point.x || point.easting || point.Easting);

          if (isNaN(yCoord) || isNaN(xCoord)) {
            errors.push({ point: pointName, error: 'Invalid coordinates' });
            skippedCount++;
            continue;
          }

          const insertParams = [
            project_id,
            pointName,
            yCoord,
            xCoord,
            point.sr_number || point.SR_num || null,
            point.description || point.Description || null,
            point.survey_date || point.Survey_date || null,
            point.coordinate_system || point.System || null,
            point.measurement_unit || point.Meas_unit || 'M',
            import_id,
            point.metadata || {}
          ];
          
          fastify.log.info(`[HistoricalSurveyPoints] Inserting point ${pointName}: Y=${yCoord}, X=${xCoord}`);

          await client.query(
            `INSERT INTO historical_survey_points 
             (project_id, point_name, y_coordinate, x_coordinate, sr_number, description, survey_date, coordinate_system, measurement_unit, import_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            insertParams
          );

          insertedCount++;
          fastify.log.info(`[HistoricalSurveyPoints] ✅ Inserted point ${pointName}`);
        } catch (pointError) {
          fastify.log.error(`[HistoricalSurveyPoints] ❌ Failed to insert ${point.point_name || point.Point}: ${pointError.message}`);
          errors.push({ point: point.point_name || point.Point, error: pointError.message });
          skippedCount++;
        }
      }

      await client.query('COMMIT');

      fastify.log.info(`[HistoricalSurveyPoints] Imported ${insertedCount} points for project ${project_id}`);

      return {
        success: true,
        import_id: import_id,
        inserted: insertedCount,
        skipped: skippedCount,
        errors: errors.length > 0 ? errors : undefined
      };

    } catch (error) {
      await client.query('ROLLBACK');
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to import historical survey points: ' + error.message });
    } finally {
      client.release();
    }
  });

  /**
   * GET /historical-survey-points/least-squares?project_id=X
   * Get beacon comparison with least squares analysis of dy/dx residuals
   * Returns matched beacons with residuals and statistical analysis
   */
  fastify.get('/historical-survey-points/least-squares', async (request, reply) => {
    const { project_id, tolerance_type = 'urban' } = request.query;

    if (!project_id) {
      return reply.code(400).send({ error: 'project_id is required' });
    }

    try {
      // Find which surveyor schema contains this project's historical points
      // We check for historical_survey_points since that's what we're comparing against
      const schemasResult = await db.query(
        `SELECT schema_name FROM surveyor_profiles WHERE schema_name IS NOT NULL ORDER BY schema_name`
      );
      
      let schemaName = null;
      for (const row of schemasResult.rows) {
        // Check if this schema has historical_survey_points for this project
        const checkResult = await db.query(
          `SELECT 1 FROM historical_survey_points WHERE project_id = $1 LIMIT 1`,
          [project_id]
        );
        if (checkResult.rows.length > 0) {
          // This schema has historical points, so it's the right one
          // Now verify it also has the project
          const projectCheck = await db.query(
            `SELECT 1 FROM ${row.schema_name}.survey_projects WHERE id = $1`,
            [project_id]
          );
          if (projectCheck.rows.length > 0) {
            schemaName = row.schema_name;
            break;
          }
        }
      }
      
      if (!schemaName) {
        return reply.code(404).send({ error: 'Project not found or no historical points imported' });
      }
      
      fastify.log.info(`[Least Squares] Using schema: ${schemaName} for project ${project_id}`);

      // Get all matched beacons with their residuals
      // PostGIS geometry: ST_MakePoint(Westing, Southing) with EPSG:22291
      // After coordinate swap fix: ST_X(geom) returns Westing (~97k), ST_Y(geom) returns Southing (~2.2M)
      // Historical table: y_coordinate = Westing, x_coordinate = Southing
      const result = await db.query(
        `SELECT 
          h.id AS historical_id,
          h.point_name,
          h.y_coordinate AS prev_y,
          h.x_coordinate AS prev_x,
          h.sr_number,
          h.description AS prev_description,
          h.survey_date AS prev_survey_date,
          h.coordinate_system AS prev_coord_system,
          h.measurement_unit AS prev_meas_unit,
          cp.id AS current_id,
          cp.name AS current_name,
          public.ST_X(cp.geom) AS curr_y,
          public.ST_Y(cp.geom) AS curr_x,
          cp.description AS curr_description,
          -- Calculate residuals (Previous - Current)
          (h.y_coordinate - public.ST_X(cp.geom)) AS dy,
          (h.x_coordinate - public.ST_Y(cp.geom)) AS dx,
          -- Linear distance
          SQRT(POWER(h.y_coordinate - public.ST_X(cp.geom), 2) + POWER(h.x_coordinate - public.ST_Y(cp.geom), 2)) AS linear_distance
        FROM historical_survey_points h
        INNER JOIN ${schemaName}.coordinate_points cp ON 
          cp.project_id = h.project_id AND 
          (cp.name = h.point_name OR cp.name ILIKE h.point_name)
        WHERE h.project_id = $1
        ORDER BY h.point_name`,
        [project_id]
      );

      const matchedBeacons = result.rows;

      if (matchedBeacons.length === 0) {
        return {
          success: true,
          matched_count: 0,
          beacons: [],
          least_squares: null,
          message: 'No matched beacons found. Import previous survey data and ensure point names match.'
        };
      }

      // Extract residuals for analysis
      const dyValues = matchedBeacons.map(b => parseFloat(b.dy));
      const dxValues = matchedBeacons.map(b => parseFloat(b.dx));
      const distances = matchedBeacons.map(b => parseFloat(b.linear_distance));
      const n = matchedBeacons.length;

      // Calculate least squares statistics
      const sumDy = dyValues.reduce((a, b) => a + b, 0);
      const sumDx = dxValues.reduce((a, b) => a + b, 0);
      
      // Mean residuals
      const meanDy = sumDy / n;
      const meanDx = sumDx / n;
      
      // Sum of squares for standard deviation
      const sumSqDy = dyValues.reduce((a, b) => a + Math.pow(b - meanDy, 2), 0);
      const sumSqDx = dxValues.reduce((a, b) => a + Math.pow(b - meanDx, 2), 0);
      
      // Standard deviation (using n-1 for sample)
      const stdDy = n > 1 ? Math.sqrt(sumSqDy / (n - 1)) : 0;
      const stdDx = n > 1 ? Math.sqrt(sumSqDx / (n - 1)) : 0;
      
      // RMS (Root Mean Square) error
      const rmsDy = Math.sqrt(dyValues.reduce((a, b) => a + b * b, 0) / n);
      const rmsDx = Math.sqrt(dxValues.reduce((a, b) => a + b * b, 0) / n);
      const rmsTotal = Math.sqrt(distances.reduce((a, b) => a + b * b, 0) / n);
      
      // Min/Max residuals
      const minDy = Math.min(...dyValues);
      const maxDy = Math.max(...dyValues);
      const minDx = Math.min(...dxValues);
      const maxDx = Math.max(...dxValues);
      const maxDistance = Math.max(...distances);
      
      // SI 727 tolerance check
      const tolerance = tolerance_type === 'rural' ? 0.10 : 0.05;
      const withinTolerance = matchedBeacons.filter(b => parseFloat(b.linear_distance) <= tolerance).length;
      const exceedsTolerance = matchedBeacons.filter(b => parseFloat(b.linear_distance) > tolerance).length;

      // Compute unit weight standard error (sigma naught)
      // σ₀ = √(Σv²/(n-u)) where v=residuals, n=observations, u=unknowns (typically 2 for shift)
      const redundancy = n > 2 ? n - 2 : 1;
      const sumVSquared = dyValues.reduce((a, b) => a + b * b, 0) + dxValues.reduce((a, b) => a + b * b, 0);
      const sigmaNaught = Math.sqrt(sumVSquared / redundancy);

      const leastSquaresAnalysis = {
        // Sample size
        n: n,
        redundancy: redundancy,
        
        // Mean residuals (systematic shift)
        mean_dy: meanDy,
        mean_dx: meanDx,
        
        // Standard deviations
        std_dy: stdDy,
        std_dx: stdDx,
        
        // RMS errors
        rms_dy: rmsDy,
        rms_dx: rmsDx,
        rms_total: rmsTotal,
        
        // Unit weight standard error
        sigma_naught: sigmaNaught,
        
        // Range
        min_dy: minDy,
        max_dy: maxDy,
        min_dx: minDx,
        max_dx: maxDx,
        max_distance: maxDistance,
        
        // Tolerance analysis
        tolerance_used: tolerance,
        tolerance_type: tolerance_type,
        within_tolerance: withinTolerance,
        exceeds_tolerance: exceedsTolerance,
        pass_rate: (withinTolerance / n * 100).toFixed(1),
        
        // Assessment
        assessment: exceedsTolerance === 0 ? 'PASS' : 
                    exceedsTolerance <= n * 0.1 ? 'MARGINAL' : 'FAIL',
        recommendation: exceedsTolerance === 0 
          ? 'All beacons within SI 727 tolerance. Coordinates can be adopted.'
          : `${exceedsTolerance} beacon(s) exceed tolerance. Review individual discrepancies.`
      };

      fastify.log.info(`[HistoricalSurveyPoints] Least squares analysis for project ${project_id}: n=${n}, σ₀=${sigmaNaught.toFixed(4)}m, RMS=${rmsTotal.toFixed(4)}m`);

      return {
        success: true,
        matched_count: n,
        beacons: matchedBeacons.map(b => ({
          point_name: b.point_name,
          prev_y: parseFloat(b.prev_y),
          prev_x: parseFloat(b.prev_x),
          curr_y: parseFloat(b.curr_y),
          curr_x: parseFloat(b.curr_x),
          dy: parseFloat(b.dy),
          dx: parseFloat(b.dx),
          linear_distance: parseFloat(b.linear_distance),
          within_tolerance: parseFloat(b.linear_distance) <= tolerance,
          sr_number: b.sr_number,
          prev_coord_system: b.prev_coord_system,
          prev_meas_unit: b.prev_meas_unit
        })),
        least_squares: leastSquaresAnalysis
      };

    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to perform least squares analysis: ' + error.message });
    }
  });

  /**
   * DELETE /historical-survey-points/:id
   * Delete a single historical survey point
   */
  fastify.delete('/historical-survey-points/:id', async (request, reply) => {
    const { id } = request.params;

    try {
      const result = await db.query(
        'DELETE FROM historical_survey_points WHERE id = $1 RETURNING *',
        [id]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Historical survey point not found' });
      }

      return { success: true, deleted: result.rows[0] };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to delete historical survey point' });
    }
  });

  /**
   * DELETE /historical-survey-points/project/:project_id
   * Delete all historical survey points for a project
   */
  fastify.delete('/historical-survey-points/project/:project_id', async (request, reply) => {
    const { project_id } = request.params;

    try {
      const result = await db.query(
        'DELETE FROM historical_survey_points WHERE project_id = $1 RETURNING id',
        [project_id]
      );

      return { 
        success: true, 
        deleted_count: result.rows.length 
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.code(500).send({ error: 'Failed to delete historical survey points' });
    }
  });
}
