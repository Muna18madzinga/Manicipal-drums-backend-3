import CoordinatePoint from '../models/coordinatePoint.js'
import { authenticateWithSchema } from '../utils/schemaAuth.js'

export default async function coordinatePointRoutes(app) {
  // List coordinate points by project
  app.get('/coordinate-points', {
    preHandler: [app.authenticate, authenticateWithSchema],
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
    const db = request.db || (await import('../config/db.js')).default
    const points = await CoordinatePoint.findByProject(db, project_id)
    return { ok: true, data: points }
  })

  // Get single coordinate point
  app.get('/coordinate-points/:id', {
    preHandler: [app.authenticate, authenticateWithSchema]
  }, async (request, reply) => {
    const { id } = request.params
    const db = request.db || (await import('../config/db.js')).default
    const point = await CoordinatePoint.findById(db, id)
    if (!point) return reply.code(404).send({ ok: false, error: 'Point not found' })
    return { ok: true, data: point }
  })

  // Create coordinate point
  app.post('/coordinate-points', {
    preHandler: [app.authenticate, authenticateWithSchema],
    schema: {
      body: {
        type: 'object',
        required: ['project_id', 'name', 'y', 'x'],
        properties: {
          project_id: { type: 'string' },
          name: { type: 'string' },
          y: { type: 'number' },
          x: { type: 'number' },
          elevation: { type: 'number' },
          description: { type: 'string' },
          survey_date: { type: 'string' },
          surveyor: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const data = request.body
    const db = request.db || (await import('../config/db.js')).default
    const point = await CoordinatePoint.create(db, {
      projectId: data.project_id,
      name: data.name,
      y: data.y,
      x: data.x,
      elevation: data.elevation,
      description: data.description,
      surveyDate: data.survey_date,
      surveyor: data.surveyor
    })
    return { ok: true, data: point }
  })

  // Batch create coordinate points
  app.post('/coordinate-points/batch', {
    preHandler: [app.authenticate, authenticateWithSchema]
  }, async (request, reply) => {
    try {
      console.log('[Batch Insert] 📥 Route handler started');
      console.log(`[Batch Insert] Project ID: ${request.body.project_id}`);
      console.log(`[Batch Insert] Points count: ${request.body.points?.length || 0}`);
      console.log(`[Batch Insert] DB connection available: ${!!request.db}`);
      console.log(`[Batch Insert] Surveyor schema: ${request.surveyorSchema || 'NOT SET'}`);
      
      const { project_id, points } = request.body
      
      if (!points || points.length === 0) {
        console.error('[Batch Insert] ❌ No points provided');
        return reply.code(400).send({ ok: false, error: 'No points provided' })
      }
      
      // Log sample points
      console.log('[Batch Insert] 📊 Sample points (first 3):');
      points.slice(0, 3).forEach((pt, idx) => {
        console.log(`  ${idx + 1}. Name: ${pt.name}, Y: ${pt.y}, X: ${pt.x}`);
      });
      
      const db = request.db || (await import('../config/db.js')).default
      console.log('[Batch Insert] 🗄️ Calling CoordinatePoint.batchCreate...');
      
      const created = await CoordinatePoint.batchCreate(db, project_id, points)
      
      console.log(`[Batch Insert] ✅ Successfully created ${created.length} points`);
      console.log('[Batch Insert] 📊 Sample created points (first 3):');
      created.slice(0, 3).forEach((pt, idx) => {
        console.log(`  ${idx + 1}. ID: ${pt.id}, Name: ${pt.name}`);
      });
      
      return { ok: true, data: created, count: created.length }
    } catch (error) {
      console.error('[Batch Insert] ❌ ERROR:', error.message);
      console.error('[Batch Insert] Error type:', error.constructor.name);
      console.error('[Batch Insert] Stack:', error.stack);
      return reply.code(500).send({ ok: false, error: error.message, stack: error.stack })
    }
  })

  // Rename coordinate point by project_id + current name (no row ID needed on frontend)
  app.patch('/coordinate-points/rename', {
    preHandler: [app.authenticate, authenticateWithSchema],
    schema: {
      body: {
        type: 'object',
        required: ['project_id', 'old_name', 'new_name'],
        properties: {
          project_id: { type: 'string' },
          old_name: { type: 'string' },
          new_name: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { project_id, old_name, new_name } = request.body
    const db = request.db || (await import('../config/db.js')).default

    // Check new name is not already taken by a DIFFERENT point in this project
    const conflictCheck = await db.query(
      `SELECT id FROM coordinate_points WHERE project_id = $1 AND name = $2 AND name <> $3`,
      [project_id, new_name, old_name]
    )
    if (conflictCheck.rows.length > 0) {
      return reply.code(409).send({ ok: false, error: `Point name "${new_name}" already exists in this project` })
    }

    const result = await db.query(
      `UPDATE coordinate_points
       SET name = $1, updated_at = CURRENT_TIMESTAMP
       WHERE project_id = $2 AND name = $3
       RETURNING *`,
      [new_name, project_id, old_name]
    )
    if (result.rowCount === 0) {
      // Debug: check what project_ids exist for this name
      const debugCheck = await db.query(
        `SELECT id, project_id, name FROM coordinate_points WHERE name = $1 LIMIT 5`,
        [old_name]
      )
      console.error(`[Rename] ❌ Point "${old_name}" not found in project ${project_id}. Found in projects:`, debugCheck.rows.map(r => r.project_id))
      return reply.code(404).send({ ok: false, error: `Point "${old_name}" not found in project ${project_id}` })
    }
    return { ok: true, data: result.rows[0] }
  })

  // Update coordinate point (rename and/or update coordinates)
  app.put('/coordinate-points/:id', {
    preHandler: [app.authenticate, authenticateWithSchema],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          y: { type: 'number' },
          x: { type: 'number' },
          elevation: { type: 'number' },
          description: { type: 'string' },
          survey_date: { type: 'string' },
          surveyor: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params
    const data = request.body
    const db = request.db || (await import('../config/db.js')).default
    const point = await CoordinatePoint.update(db, id, {
      name: data.name,
      y: data.y,
      x: data.x,
      elevation: data.elevation,
      description: data.description,
      surveyDate: data.survey_date,
      surveyor: data.surveyor
    })
    if (!point) return reply.code(404).send({ ok: false, error: 'Point not found' })
    return { ok: true, data: point }
  })

  // Delete coordinate point by numeric id
  app.delete('/coordinate-points/:id', {
    preHandler: [app.authenticate, authenticateWithSchema]
  }, async (request, reply) => {
    const { id } = request.params
    const db = request.db || (await import('../config/db.js')).default
    await CoordinatePoint.delete(db, id)
    return { ok: true }
  })

  // Delete coordinate point by project_id + name (no numeric id required)
  app.delete('/coordinate-points/by-name', {
    preHandler: [app.authenticate, authenticateWithSchema],
    schema: {
      body: {
        type: 'object',
        required: ['project_id', 'name'],
        properties: {
          project_id: { type: 'string' },
          name: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { project_id, name } = request.body
    const db = request.db || (await import('../config/db.js')).default
    const result = await db.query(
      'DELETE FROM coordinate_points WHERE project_id = $1 AND name = $2 RETURNING id',
      [project_id, name]
    )
    if (result.rowCount === 0) {
      return reply.code(404).send({ ok: false, error: `Point "${name}" not found in project ${project_id}` })
    }
    console.log(`[CoordinatePoints] 🗑️ Deleted point "${name}" from project ${project_id} (id=${result.rows[0].id})`)
    return { ok: true, deleted: result.rows[0].id }
  })

  // Repair geom column for points with null geom using workflow step_data
  app.post('/coordinate-points/repair-geom', {
    preHandler: [app.authenticate, authenticateWithSchema]
  }, async (request, reply) => {
    const { project_id } = request.body
    if (!project_id) return reply.code(400).send({ ok: false, error: 'project_id required' })

    const db = request.db || (await import('../config/db.js')).default

    // Load workflow_state for this project to get coordinates
    const wfResult = await db.query(
      `SELECT workflow_state FROM survey_projects WHERE id = $1`,
      [project_id]
    )
    if (!wfResult.rows.length) return reply.code(404).send({ ok: false, error: 'Project not found' })

    const workflowState = wfResult.rows[0].workflow_state || {}
    const stepData = workflowState.step_data || {}

    // Extract points from various workflow locations:
    // 1. Top-level adjustedCoordinates (set by calculations-part1)
    // 2. step_data entries: csv-import, import_csv, coordinate-list, calculations-part1, field-book
    const topLevelPoints = workflowState.adjustedCoordinates || []
    const csvStep = stepData['csv-import'] || stepData['import_csv'] || stepData['coordinate-list'] || stepData['calculations-part1'] || stepData['field-book'] || {}
    const stepPoints = csvStep.points || csvStep.adjustedCoordinates || csvStep.coordinatePoints || csvStep.coordinates || []
    let wfPoints = topLevelPoints.length > 0 ? topLevelPoints : stepPoints

    // ⭐ CRITICAL FIX: If no workflow points found, fall back to database coordinates
    // The coordinate_points table stores geometry only - extract y/x using ST_X/ST_Y
    if (!wfPoints.length) {
      console.log(`[RepairGeom] No workflow points found. Falling back to database coordinates...`)
      const dbPoints = await db.query(
        `SELECT name, ST_X(geom) as y, ST_Y(geom) as x FROM coordinate_points WHERE project_id = $1`,
        [project_id]
      )
      if (dbPoints.rows.length > 0) {
        wfPoints = dbPoints.rows.map(row => ({
          name: row.name,
          y: Number(row.y),
          x: Number(row.x)
        }))
        console.log(`[RepairGeom] Found ${wfPoints.length} points in database`)
      }
    }

    if (!wfPoints.length) {
      console.log(`[RepairGeom] No points found in workflow state or database. step_data keys: ${Object.keys(stepData)}`)
      return reply.code(422).send({ ok: false, error: 'No coordinate points found in workflow state or database' })
    }

    // Get SRID from project central meridian
    const projResult = await db.query(
      'SELECT central_meridian FROM survey_projects WHERE id = $1', [project_id]
    )
    const { getCapeLoSRID } = await import('../utils/capeLoSRID.js')
    const srid = projResult.rows.length > 0
      ? getCapeLoSRID(projResult.rows[0].central_meridian)
      : 22291

    // Build name->coords map from workflow points
    const coordMap = new Map()
    for (const pt of wfPoints) {
      const name = pt.id || pt.name
      const y = Number(pt.y ?? pt.coordinateList?.y ?? pt.original?.y)
      const x = Number(pt.x ?? pt.coordinateList?.x ?? pt.original?.x)
      if (name && Number.isFinite(y) && Number.isFinite(x)) {
        coordMap.set(name, { y, x })
      }
    }

    console.log(`[RepairGeom] Project ${project_id}: ${coordMap.size} workflow points available`)

    // Update null-geom coordinate points
    let repaired = 0, skipped = 0
    const nullPoints = await db.query(
      `SELECT id, name FROM coordinate_points WHERE project_id = $1 AND geom IS NULL`,
      [project_id]
    )

    // Store geometry in project's native SRID (no forced transform to Lo 31)
    for (const row of nullPoints.rows) {
      const coords = coordMap.get(row.name)
      if (!coords) { skipped++; continue }
      await db.query(
        `UPDATE coordinate_points SET geom = ST_SetSRID(ST_MakePoint($1, $2), ${srid}) WHERE id = $3`,
        [coords.y, coords.x, row.id]
      )
      repaired++
    }

    console.log(`[RepairGeom] Repaired ${repaired}, skipped ${skipped}`)
    return { ok: true, repaired, skipped, total: nullPoints.rows.length }
  })
}
