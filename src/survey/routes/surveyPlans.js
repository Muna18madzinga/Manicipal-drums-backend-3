/**
 * Survey Plans API Routes
 * Handles generation of General Plans, Diagrams, and Working Plans
 */

import { generateGeneralPlan, generateDiagram, generateWorkingPlan } from '../utils/surveyPlanGenerator.js'
import LandParcel from '../models/landParcel.js'
import CoordinatePoint from '../models/coordinatePoint.js'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default async function surveyPlanRoutes(app) {
  
  /**
   * POST /general-plan
   * Generate a General Plan (developed or undeveloped portion)
   */
  app.post('/general-plan', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string' },
          plan_type: { type: 'string', enum: ['developed', 'undeveloped'], default: 'undeveloped' },
          scale: { type: 'string', default: '1:1000' },
          surveyor_name: { type: 'string' },
          license_number: { type: 'string' },
          survey_date: { type: 'string' },
          notes: { type: 'array', items: { type: 'string' } },
          sheet_number: { type: 'string', default: '1 of 1' }
        }
      }
    }
  }, async (request, reply) => {
    const {
      project_id,
      plan_type = 'undeveloped',
      scale = '1:1000',
      surveyor_name,
      license_number,
      survey_date,
      notes = [],
      sheet_number = '1 of 1'
    } = request.body

    try {
      console.log(`📋 Generating ${plan_type} General Plan for project ${project_id}`)

      const db = request.db || (await import('../config/db.js')).default

      // Get project details
      const projectResult = await db.query(
        'SELECT * FROM survey_projects WHERE id = $1',
        [project_id]
      )
      
      if (projectResult.rows.length === 0) {
        return reply.code(404).send({
          ok: false,
          error: 'Project not found'
        })
      }

      const project = projectResult.rows[0]

      // Get parcels with computed areas (fetch all — needed for plan generation)
      console.log('📊 Fetching parcels...')
      const { data: parcels } = await LandParcel.findFullByProject(db, project_id, null, { page: 1, limit: 10000 })
      console.log(`Found ${parcels.length} parcels`)

      if (parcels.length === 0) {
        return reply.code(400).send({
          ok: false,
          error: 'No parcels found for this project. Please digitize parcels first.'
        })
      }

      // Get coordinate points
      console.log('📍 Fetching coordinate points...')
      const coordinatePoints = await CoordinatePoint.findByProject(db, project_id)
      console.log(`Found ${coordinatePoints.length} coordinate points`)

      // Generate output filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0]
      const filename = `general-plan-${plan_type}-${project.name.replace(/\s+/g, '_')}-${timestamp}.pdf`
      const outputPath = path.join(__dirname, '../../temp', filename)

      // Ensure temp directory exists
      const tempDir = path.join(__dirname, '../../temp')
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true })
      }

      // Generate plan
      console.log('🎨 Generating PDF...')
      await generateGeneralPlan({
        project,
        parcels,
        coordinatePoints,
        planType: plan_type,
        outputPath,
        metadata: {
          surveyorName: surveyor_name || project.surveyor || '',
          licenseNumber: license_number || '',
          surveyDate: survey_date || new Date().toISOString().split('T')[0],
          scale,
          sheetNumber: sheet_number,
          notes
        }
      })

      console.log('✅ General Plan generated successfully')

      // Read the file and send as response
      const pdfBuffer = fs.readFileSync(outputPath)

      // Clean up temp file
      fs.unlinkSync(outputPath)

      // Send PDF
      reply
        .code(200)
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Content-Length', pdfBuffer.length)
        .send(pdfBuffer)

    } catch (error) {
      console.error('❌ Error generating General Plan:', error)
      return reply.code(500).send({
        ok: false,
        error: 'Failed to generate General Plan',
        details: error.message,
        stack: error.stack
      })
    }
  })

  /**
   * POST /diagram
   * Generate a Survey Diagram
   */
  app.post('/diagram', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string' },
          scale: { type: 'string', default: '1:500' },
          surveyor_name: { type: 'string' },
          license_number: { type: 'string' },
          survey_date: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    return reply.code(501).send({
      ok: false,
      error: 'Diagram generation not yet implemented',
      message: 'This feature is coming soon'
    })
  })

  /**
   * POST /working-plan
   * Generate a Working Plan
   */
  app.post('/working-plan', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['project_id'],
        properties: {
          project_id: { type: 'string' },
          scale: { type: 'string', default: '1:1000' }
        }
      }
    }
  }, async (request, reply) => {
    return reply.code(501).send({
      ok: false,
      error: 'Working Plan generation not yet implemented',
      message: 'This feature is coming soon'
    })
  })

  /**
   * GET /preview
   * Get preview data for survey plan (without generating PDF)
   */
  app.get('/preview', {
    preHandler: [app.authenticate],
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
    const { project_id } = request.query

    try {
      const db = request.db || (await import('../config/db.js')).default

      // Get project (schema-aware)
      const projectResult = await db.query(
        'SELECT * FROM "survey_projects" WHERE id = $1',
        [project_id]
      )

      if (projectResult.rows.length === 0) {
        return reply.code(404).send({
          ok: false,
          error: 'Project not found'
        })
      }

      const project = projectResult.rows[0]

      // Get parcels and coordinate points (fetch all — needed for plan summary)
      const { data: parcels } = await LandParcel.findFullByProject(db, project_id, null, { page: 1, limit: 10000 })
      const coordinatePoints = await CoordinatePoint.findByProject(db, project_id)

      // Calculate total area
      const totalArea = parcels.reduce((sum, p) => sum + (p.area_ha || 0), 0)

      return {
        ok: true,
        data: {
          project,
          parcel_count: parcels.length,
          coordinate_point_count: coordinatePoints.length,
          total_area_ha: totalArea.toFixed(4),
          total_area_m2: (totalArea * 10000).toFixed(2),
          parcels: parcels.map(p => ({
            id: p.id,
            stand: p.stand,
            area_ha: p.area_ha,
            area_m2: p.area_m2
          }))
        }
      }

    } catch (error) {
      console.error('Error fetching preview data:', error)
      return reply.code(500).send({
        ok: false,
        error: 'Failed to fetch preview data',
        details: error.message
      })
    }
  })
}
