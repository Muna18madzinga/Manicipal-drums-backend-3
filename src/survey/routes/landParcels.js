import LandParcel from '../models/landParcel.js'
import { authenticateWithSchema } from '../utils/schemaAuth.js'
import db from '../config/db.js'

export default async function landParcelRoutes(app) {
  // List land parcels by project (with optional status filter)
  app.get('/land-parcels', {
    preHandler: [app.authenticate, authenticateWithSchema],
    schema: {
      querystring: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string' },
          status: { type: 'string', enum: ['draft', 'finalized', 'approved'] },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 10000, default: 50 }
        }
      }
    }
  }, async (request, reply) => {
    const { project_id, status, page = 1, limit = 50 } = request.query
    const dbConnection = request.db || db

    const result = await LandParcel.findFullByProject(dbConnection, project_id, status, { page, limit })
    return { ok: true, ...result }
  })

  // Get single land parcel
  app.get('/land-parcels/:id', {
    preHandler: [app.authenticate, authenticateWithSchema]
  }, async (request, reply) => {
    const { id } = request.params
    const dbConnection = request.db || db
    const parcel = await LandParcel.findById(dbConnection, id)
    if (!parcel) return reply.code(404).send({ ok: false, error: 'Parcel not found' })
    return { ok: true, data: parcel }
  })

  // Check for duplicate parcels before creating
  app.post('/land-parcels/check-duplicates', {
    preHandler: [app.authenticate, authenticateWithSchema],
    schema: {
      body: {
        type: 'object',
        required: ['project_id', 'stand', 'geom'],
        properties: {
          project_id: { type: 'string' },
          stand: { type: 'string' },
          geom: { type: 'object' },
          exclude_id: { type: 'number' } // For update checks
        }
      }
    }
  }, async (request, reply) => {
    const { project_id, stand, geom, exclude_id } = request.body
    const dbConnection = request.db || db
    
    try {
      const result = await LandParcel.checkDuplicates(dbConnection, project_id, stand, geom, exclude_id)
      return { ok: true, ...result }
    } catch (error) {
      console.error('[API] Error checking duplicates:', error)
      return reply.code(500).send({ 
        ok: false, 
        error: 'Failed to check for duplicates',
        details: error.message 
      })
    }
  })

  // Create land parcel
  app.post('/land-parcels', {
    preHandler: [app.authenticate], // Temporarily disabled authenticateWithSchema until schemas are created
    schema: {
      body: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string' },
          stand: { type: 'string' },
          designation: { type: 'string' },
          geom: { type: 'object' },
          geometry: { type: 'object' },
          owner: { type: 'string' },
          title_deed: { type: 'string' },
          survey_date: { type: 'string' },
          surveyor: { type: 'string' },
          notes: { type: 'string' },
          centroid_y: { type: 'number' },
          centroid_x: { type: 'number' },
          closure_error_m: { type: 'number' },
          closure_error: { type: 'number' },
          closure_ratio: { type: 'string' },
          area_m2: { type: 'number' },
          area_sqm: { type: 'number' },
          area_ha: { type: 'number' },
          perimeter_m: { type: 'number' },
          status: { type: 'string', enum: ['draft', 'finalized', 'approved'] },
          digitized_by: { type: 'number' },
          metadata: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    const dbConnection = request.db || db
    
    try {
      const data = request.body
      
      console.log('[API] Creating land parcel with data:', {
        project_id: data.project_id,
        stand: data.stand,
        designation: data.designation,
        status: data.status,
        has_geom: !!data.geom,
        has_geometry: !!data.geometry,
        has_metadata: !!data.metadata
      })
      
      // Map frontend fields to backend fields
      const stand = data.stand || data.designation
      const geom = data.geom || data.geometry
      const closureErrorM = data.closure_error_m || data.closure_error
      
      if (!stand) {
        return reply.code(400).send({ 
          ok: false, 
          error: 'Either stand or designation is required' 
        })
      }
      
      if (!geom) {
        return reply.code(400).send({ 
          ok: false, 
          error: 'Geometry is required (geom or geometry field)' 
        })
      }
      
      const parcel = await LandParcel.create(dbConnection, {
        projectId: data.project_id,
        stand: stand,
        designation: data.designation,
        geom: geom,
        owner: data.owner,
        titleDeed: data.title_deed,
        surveyDate: data.survey_date,
        surveyor: data.surveyor,
        notes: data.notes,
        centroidY: data.centroid_y,
        centroidX: data.centroid_x,
        closureErrorM: closureErrorM,
        closureRatio: data.closure_ratio,
        status: data.status || 'draft',
        digitizedBy: data.digitized_by,
        metadata: data.metadata
      })
      
      console.log('[API] ✅ Parcel created successfully:', parcel.id)
      return { ok: true, data: parcel }
    } catch (error) {
      console.error('[API] ❌ Error creating parcel:', error.message)
      console.error('[API] Stack:', error.stack)
      return reply.code(500).send({ 
        ok: false, 
        error: 'Failed to create parcel',
        details: error.message 
      })
    }
  })

  // Batch create land parcels
  app.post('/land-parcels/batch', {
    preHandler: [app.authenticate, authenticateWithSchema],
    schema: {
      body: {
        type: 'object',
        required: ['project_id', 'parcels'],
        properties: {
          project_id: { type: 'string' },
          parcels: {
            type: 'array',
            items: {
              type: 'object',
              required: ['stand', 'geom'],
              properties: {
                stand: { type: 'string' },
                geom: { type: 'object' },
                owner: { type: 'string' },
                title_deed: { type: 'string' },
                survey_date: { type: 'string' },
                surveyor: { type: 'string' },
                notes: { type: 'string' },
                centroid_y: { type: 'number' },
                centroid_x: { type: 'number' },
                closure_error_m: { type: 'number' },
                area_m2: { type: 'number' },
                area_ha: { type: 'number' },
                perimeter_m: { type: 'number' }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { project_id, parcels } = request.body
    const dbConnection = request.db || db
    
    try {
      const created = []
      const errors = []
      
      for (const parcelData of parcels) {
        try {
          const parcel = await LandParcel.create(dbConnection, {
            projectId: project_id,
            stand: parcelData.stand,
            geom: parcelData.geom,
            owner: parcelData.owner,
            titleDeed: parcelData.title_deed,
            surveyDate: parcelData.survey_date,
            surveyor: parcelData.surveyor,
            notes: parcelData.notes,
            centroidY: parcelData.centroid_y,
            centroidX: parcelData.centroid_x,
            closureErrorM: parcelData.closure_error_m,
            areaM2: parcelData.area_m2,
            areaHa: parcelData.area_ha,
            perimeterM: parcelData.perimeter_m
          })
          created.push(parcel)
        } catch (error) {
          errors.push({
            stand: parcelData.stand,
            error: error.message
          })
        }
      }
      
      return {
        ok: true,
        created: created.length,
        failed: errors.length,
        data: created,
        errors
      }
    } catch (error) {
      console.error('[API] Batch create error:', error)
      return reply.code(500).send({
        ok: false,
        error: 'Failed to batch create parcels',
        details: error.message
      })
    }
  })

  // Update land parcel
  app.put('/land-parcels/:id', {
    preHandler: [app.authenticate, authenticateWithSchema],
    schema: {
      body: {
        type: 'object',
        properties: {
          stand: { type: 'string' },
          designation: { type: 'string' },
          geom: { type: 'object' },
          owner: { type: 'string' },
          title_deed: { type: 'string' },
          survey_date: { type: 'string' },
          surveyor: { type: 'string' },
          notes: { type: 'string' },
          metadata: { type: 'object' },
          status: { type: 'string', enum: ['draft', 'finalized', 'approved'] }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params
    const data = request.body
    const dbConnection = request.db || db
    const parcel = await LandParcel.update(dbConnection, id, {
      stand: data.stand,
      designation: data.designation,
      geom: data.geom,
      owner: data.owner,
      titleDeed: data.title_deed,
      surveyDate: data.survey_date,
      surveyor: data.surveyor,
      notes: data.notes,
      metadata: data.metadata,
      status: data.status
    })
    if (!parcel) return reply.code(404).send({ ok: false, error: 'Parcel not found' })
    return { ok: true, data: parcel }
  })

  // Delete land parcel
  app.delete('/land-parcels/:id', {
    preHandler: [app.authenticate, authenticateWithSchema]
  }, async (request, reply) => {
    const { id } = request.params
    const dbConnection = request.db || db
    await LandParcel.delete(dbConnection, id)
    return { ok: true }
  })

  // Update project_id for parcels that don't have it (after QGIS digitization)
  app.post('/land-parcels/update-project', {
    preHandler: [app.authenticate, authenticateWithSchema],
    schema: {
      body: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { project_id } = request.body
    const dbConnection = request.db || db
    const result = await LandParcel.updateProjectId(dbConnection, project_id)
    return { ok: true, updated: result.rowCount }
  })

  // Export land parcels to PDF
  app.get('/land-parcels/export-pdf', {
    // preHandler: [app.authenticate], // Temporarily disabled for testing
    schema: {
      querystring: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { project_id } = request.query;
    
    try {
      // Get project details (you'll need to import and use your project model)
      // const project = await Project.findById(project_id);
      const project = { id: project_id, name: 'Project ' + project_id };
      
      // Get parcels with full details (fetch all for PDF — no display pagination needed)
      const dbConnection = request.db || db
      const { data: parcels } = await LandParcel.findFullByProject(dbConnection, project_id, null, { page: 1, limit: 10000 });

      if (!parcels || parcels.length === 0) {
        return reply.code(404).send({ ok: false, error: 'No parcels found for this project' });
      }
      
      // Generate PDF
      const { generateLandParcelReport } = await import('../utils/pdfGenerator.js');
      const pdfBuffer = await generateLandParcelReport(parcels, project);
      
      // Set response headers for PDF download
      reply
        .code(200)
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="land_parcels_${project_id}_${new Date().toISOString().split('T')[0]}.pdf"`)
        .header('Content-Length', pdfBuffer.length)
        .send(pdfBuffer);
      
    } catch (error) {
      console.error('Error generating PDF:', error);
      return reply.code(500).send({ 
        ok: false, 
        error: 'Failed to generate PDF',
        details: error.message 
      });
    }
  })

  // Calculate areas for parcels using shoelace method
  app.post('/land-parcels/calculate-areas', {
    preHandler: [app.authenticate, authenticateWithSchema],
    schema: {
      body: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string' },
          recalculate: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    const { project_id, recalculate = false } = request.body;
    
    console.log(`📐 Starting area calculation for project ${project_id}, recalculate=${recalculate}`);
    
    try {
      // Import area calculation utilities
      const { processParcel } = await import('../utils/areaCalculations.js');
      
      // Get parcels for this project (fetch all — area calculation requires full dataset)
      console.log(`🔍 Fetching parcels for project ${project_id}...`);
      const dbConnection = request.db || db
      const { data: parcels } = await LandParcel.findFullByProject(dbConnection, project_id, null, { page: 1, limit: 10000 });
      console.log(`📊 Found ${parcels.length} parcels to process`);
      
      if (parcels.length === 0) {
        console.log('ℹ️ No parcels found for this project');
        return {
          ok: true,
          processed: 0,
          errorCount: 0,
          results: [],
          errors: [],
          message: 'No parcels found for this project'
        };
      }
      
      // Get coordinate points for matching
      console.log('📍 Fetching coordinate points...');
      const CoordinatePoint = (await import('../models/coordinatePoint.js')).default;
      const coordinatePoints = await CoordinatePoint.findByProject(db, project_id);
      console.log(`📍 Found ${coordinatePoints.length} coordinate points`);
      
      if (coordinatePoints.length === 0) {
        console.warn('⚠️ No coordinate points found for this project. Area calculations will not be accurate.');
      }
      
      const results = [];
      const errorList = [];
      const batchUpdates = [];  // Collect all successful calculations before hitting the DB

      console.log('🔄 Starting parcel processing...');
      for (const [index, parcel] of parcels.entries()) {
        try {
          // Skip if already calculated (unless recalculate is true)
          if (!recalculate && parcel.area_calculated) {
            results.push({ stand: parcel.stand || `Parcel ${parcel.id}`, skipped: true, reason: 'Already calculated' });
            continue;
          }

          const parcelWithGeoData = { ...parcel, geojson: parcel.geojson || parcel.geom };
          const calculation = processParcel(parcelWithGeoData, coordinatePoints);

          batchUpdates.push({
            id: parcel.id,
            centroid_y: parseFloat(calculation.centroid.y),
            centroid_x: parseFloat(calculation.centroid.x),
            closure_error_m: parseFloat(calculation.residuals.closureError),
            area_calculated: true,
            calculation_data: calculation
          });

          results.push({ stand: parcel.stand || `Parcel ${parcel.id}`, area: calculation.area, success: true });
        } catch (error) {
          console.error(`❌ Error processing parcel ${parcel.stand || parcel.id}: ${error.message}`);
          errorList.push({ stand: parcel.stand || `Parcel ${parcel.id}`, error: error.message, stack: error.stack });
          results.push({ stand: parcel.stand || `Parcel ${parcel.id}`, success: false, error: error.message });
        }
      }

      // Single batch DB update for all successful calculations
      if (batchUpdates.length > 0) {
        console.log(`💾 Batch updating ${batchUpdates.length} parcels in a single query...`);
        try {
          await LandParcel.batchUpdateAreaCalculations(dbConnection, batchUpdates);
          console.log('✔️  Batch update complete');
        } catch (dbError) {
          console.error('❌ Batch database update failed:', dbError.message);
          throw new Error(`Failed to batch update parcels: ${dbError.message}`);
        }
      }

      // Log summary
      const successCount = results.filter(r => r.success).length;
      const skippedCount = results.filter(r => r.skipped).length;
      const failedCount = errorList.length;
      
      console.log(`\n📊 Area calculation complete!`);
      console.log(`✅ Success: ${successCount}`);
      console.log(`⏭️  Skipped: ${skippedCount}`);
      console.log(`❌ Failed: ${failedCount}`);
      
      if (failedCount > 0) {
        console.log('\n⚠️  Some parcels failed to process. Check the errors array for details.');
      }
      
      return {
        ok: true,
        processed: results.length,
        successCount,
        skippedCount,
        errorCount: failedCount,
        results,
        errors: errorList
      };
    } catch (error) {
      console.error('❌ Fatal error in area calculation:', error)
      return reply.status(500).send({
        ok: false,
        error: error.message,
        stack: error.stack
      })
    }
  })

  // Finalize parcels (batch status update)
  app.patch('/land-parcels/finalize', {
    preHandler: [app.authenticate, authenticateWithSchema],
    schema: {
      body: {
        type: 'object',
        required: ['parcel_ids'],
        properties: {
          parcel_ids: {
            type: 'array',
            items: { type: 'number' }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { parcel_ids } = request.body
    const dbConnection = request.db || db
    
    try {
      const finalized = await LandParcel.batchFinalize(dbConnection, parcel_ids)
      return {
        ok: true,
        finalized: finalized.length,
        data: finalized
      }
    } catch (error) {
      console.error('[API] Error finalizing parcels:', error)
      return reply.code(500).send({
        ok: false,
        error: 'Failed to finalize parcels',
        details: error.message
      })
    }
  })

  // Generate metadata for QGIS-digitized parcels
  app.post('/land-parcels/generate-metadata', {
    preHandler: [app.authenticate, authenticateWithSchema],
    schema: {
      body: {
        type: 'object',
        properties: {
          parcel_ids: { 
            type: 'array',
            items: { type: 'number' },
            description: 'Array of parcel IDs to generate metadata for. If empty, processes all parcels with missing metadata.'
          },
          project_id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { parcel_ids, project_id } = request.body
    const dbConnection = request.db || db
    
    try {
      console.log('[Generate Metadata] Request:', { parcel_ids, project_id })
      
      let results = []
      
      if (parcel_ids && parcel_ids.length > 0) {
        // Generate metadata for specific parcels
        for (const parcelId of parcel_ids) {
          try {
            const result = await db.query(`
              SELECT generate_parcel_metadata($1) as metadata
            `, [parcelId])
            
            const metadata = result.rows[0].metadata
            
            // Update parcel with generated metadata
            await db.query(`
              UPDATE land_parcels
              SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
              WHERE id = $2
            `, [metadata, parcelId])
            
            results.push({
              parcel_id: parcelId,
              updated: true,
              metadata: metadata
            })
            
            console.log(`[Generate Metadata] ✅ Generated metadata for parcel ${parcelId}`)
          } catch (error) {
            console.error(`[Generate Metadata] ❌ Error for parcel ${parcelId}:`, error.message)
            results.push({
              parcel_id: parcelId,
              updated: false,
              error: error.message
            })
          }
        }
      } else {
        // Generate metadata for all parcels with missing metadata in project
        const result = await db.query(`
          SELECT * FROM update_parcels_with_missing_metadata($1)
        `, [project_id || null])
        
        results = result.rows.map(row => ({
          parcel_id: row.parcel_id,
          stand: row.parcel_stand,
          updated: row.updated,
          error: row.error_message
        }))
        
        console.log(`[Generate Metadata] ✅ Processed ${results.length} parcels`)
      }
      
      const successCount = results.filter(r => r.updated).length
      const failureCount = results.filter(r => !r.updated).length
      
      return {
        ok: true,
        message: `Generated metadata for ${successCount} parcel(s)`,
        summary: {
          total: results.length,
          success: successCount,
          failed: failureCount
        },
        results
      }
    } catch (error) {
      console.error('[Generate Metadata] Error:', error)
      return reply.status(500).send({
        ok: false,
        error: 'Failed to generate metadata',
        details: error.message
      })
    }
  })

  // Check database schema for land_parcels table
  app.get('/land-parcels/schema', {
    preHandler: [app.authenticate, authenticateWithSchema],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          table: { type: 'string', default: 'land_parcels' }
        }
      }
    }
  }, async (request, reply) => {
    const { table } = request.query;
    
    try {
      const result = await db.query(`
        SELECT 
          column_name, 
          data_type,
          is_nullable,
          column_default
        FROM 
          information_schema.columns 
        WHERE 
          table_name = $1
        ORDER BY 
          ordinal_position
      `, [table]);
      
      return {
        ok: true,
        table,
        columns: result.rows
      };
    } catch (error) {
      console.error('Error fetching schema:', error);
      return reply.status(500).send({
        ok: false,
        error: error.message
      });
    }
  });
}
