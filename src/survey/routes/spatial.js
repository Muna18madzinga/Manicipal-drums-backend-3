import Project from '../models/project.js'
import Layer from '../models/layer.js'
import Feature from '../models/feature.js'
import db from '../config/db.js'
import { authenticateWithSchema } from '../utils/schemaAuth.js'

export default async function spatialRoutes(app) {
  // Get QGIS layer configuration for a specific project
  app.get('/spatial/qgis-layer/:projectId', {
    schema: {
      params: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    const { projectId } = request.params
    
    // Get project details
    const projectResult = await db.query(
      'SELECT id, name, client_name FROM survey_projects WHERE id = $1',
      [projectId]
    )
    
    if (projectResult.rows.length === 0) {
      return reply.code(404).send({ error: 'Project not found' })
    }
    
    const project = projectResult.rows[0]
    
    // Return QGIS connection info with filter
    return {
      ok: true,
      project: {
        id: project.id,
        name: project.project_name,
        client: project.client_name
      },
      qgis: {
        connection: {
          host: process.env.DB_HOST || 'localhost',
          port: process.env.DB_PORT || 5432,
          database: process.env.DB_NAME || 'survey-suite',
          username: process.env.DB_USER || 'postgres',
          schema: 'public',
          table: 'land_parcels',
          geometry_column: 'geom',
          srid: 22291 // Cape Lo 31
        },
        filter: `"project_id" = ${projectId}`,
        uri: `dbname='${process.env.DB_NAME || 'survey-suite'}' host=${process.env.DB_HOST || 'localhost'} port=${process.env.DB_PORT || 5432} user='${process.env.DB_USER || 'postgres'}' password='${process.env.DB_PASSWORD}' sslmode=disable table="land_parcels" (geom) sql="project_id" = ${projectId}`,
        instructions: [
          '1. Open QGIS',
          '2. Layer → Add Layer → Add PostGIS Layers',
          '3. Click "New" to create connection',
          `4. Name: Survey Task Manager - ${project.name}`,
          `5. Host: ${process.env.DB_HOST || 'localhost'}`,
          `6. Port: ${process.env.DB_PORT || 5432}`,
          `7. Database: ${process.env.DB_NAME || 'survey-suite'}`,
          `8. Username: ${process.env.DB_USER || 'postgres'}`,
          '9. Click "Test Connection"',
          '10. Click "Connect"',
          '11. Expand "public" schema',
          '12. Select "land_parcels" table',
          '13. Click "Add"',
          '14. Right-click layer → Filter...',
          `15. Enter: "project_id" = ${projectId}`,
          '16. Click OK'
        ]
      }
    }
  })

  // Create project
  app.post('/spatial/projects', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          code: { type: 'string' },
          description: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { name, code, description } = request.body
    const userId = request.user.sub

    const project = await Project.create({ 
      name, 
      userId, 
      code, 
      description 
    })
    reply.code(201).send(project)
  })

  // List projects
  app.get('/spatial/projects', {
    preHandler: [app.authenticate]
  }, async (request) => {
    return Project.findByUser(request.user.sub)
  })

  // Create layer
  app.post('/spatial/projects/:projectId/layers', {
    preHandler: [app.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          layer_type: { type: 'string' },
          geom_type: { type: 'string' },
          srid: { type: 'number' },
          params: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    const projectId = Number(request.params.projectId)
  const { name, layer_type, geom_type, srid, params } = request.body

    const project = await Project.findById(projectId)
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' })
    }

    const layer = await Layer.create({ 
      name,
      projectId,
      layerType: layer_type,
      geomType: geom_type,
      srid,
      params
    })
    reply.code(201).send(layer)
  })

  // List layers
  app.get('/spatial/projects/:projectId/layers', {
    preHandler: [app.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string' }
        }
      }
    }
  }, async (request) => {
    const projectId = Number(request.params.projectId)
    return Layer.findByProject(projectId)
  })

  // Get single layer by id
  app.get('/spatial/layers/:layerId', {
    preHandler: [app.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
      }
    }
  }, async (request, reply) => {
    const layerId = Number(request.params.layerId)
    const layer = await Layer.findById(layerId)
    if (!layer) return reply.code(404).send({ error: 'Layer not found' })
    return layer
  })

  // Create feature
  app.post('/spatial/layers/:layerId/features', {
    preHandler: [app.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['layerId'],
        properties: {
          layerId: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        properties: {
          geometry: { 
            type: 'object',
            properties: {
              type: { type: 'string' },
              coordinates: { type: 'array' }
            }
          },
          properties: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    const layerId = Number(request.params.layerId)
    const { geometry, properties } = request.body

    const layer = await Layer.findById(layerId)
    if (!layer) {
      return reply.code(404).send({ error: 'Layer not found' })
    }

    const feature = await Feature.create({
      layerId,
      projectId: layer.project_id,
      geometry,
      properties
    })
    reply.code(201).send(feature)
  })

  // Query features by bbox
  app.post('/spatial/layers/:layerId/query', {
    preHandler: [app.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['layerId'],
        properties: {
          layerId: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        required: ['bbox'],
        properties: {
          bbox: { 
            type: 'array',
            minItems: 4,
            maxItems: 4,
            items: { type: 'number' }
          }
        }
      }
    }
  }, async (request, reply) => {
    const layerId = Number(request.params.layerId)
    const { bbox } = request.body

    const layer = await Layer.findById(layerId)
    if (!layer) {
      return reply.code(404).send({ error: 'Layer not found' })
    }

    return Feature.queryByBBox(layerId, bbox)
  })

  // List features in a layer (paged, optional search)
  app.get('/spatial/layers/:layerId/features', {
    preHandler: [app.authenticate],
    schema: {
      params: { type: 'object', required: ['layerId'], properties: { layerId: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'number' },
          limit: { type: 'number' },
          search: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const layerId = Number(request.params.layerId)
    const layer = await Layer.findById(layerId)
    if (!layer) return reply.code(404).send({ error: 'Layer not found' })
    const { page = 1, limit = 50, search = '' } = request.query || {}
    const { items, total } = await Feature.listPaged(layerId, { page: Number(page)||1, limit: Number(limit)||50, search: String(search||'') })
    return { items, total, page: Number(page)||1, limit: Number(limit)||50 }
  })

  // Get GeoJSON features for map (optional search)
  app.get('/spatial/layers/:layerId/geojson', {
    preHandler: [app.authenticate],
    schema: {
      params: { type: 'object', required: ['layerId'], properties: { layerId: { type: 'string' } } },
      querystring: { type: 'object', properties: { search: { type: 'string' } } }
    }
  }, async (request, reply) => {
    const layerId = Number(request.params.layerId)
    const layer = await Layer.findById(layerId)
    if (!layer) return reply.code(404).send({ error: 'Layer not found' })
    const { items } = await Feature.listPaged(layerId, { page: 1, limit: 2000, search: String(request.query?.search||'') })
    return Feature.buildFeatureCollection(items)
  })

  // Update feature
  app.put('/spatial/features/:id', {
    preHandler: [app.authenticate],
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
          geometry: { 
            type: 'object',
            properties: {
              type: { type: 'string' },
              coordinates: { type: 'array' }
            }
          },
          properties: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    const id = Number(request.params.id)
    const { geometry, properties } = request.body

    const existing = await Feature.findById(id)
    if (!existing) {
      return reply.code(404).send({ error: 'Feature not found' })
    }

    const feature = await Feature.update(id, {
      geometry: geometry || existing.geometry,
      properties: properties || existing.properties
    })
    reply.send(feature)
  })

  // Search point features in a layer by beacon/name (properties.name ILIKE)
  app.get('/spatial/layers/:layerId/search', {
    preHandler: [app.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
      },
      querystring: {
        type: 'object',
        required: ['q'],
        properties: {
          q: { type: 'string' },
          limit: { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    const layerId = Number(request.params.layerId)
    const { q, limit } = request.query

    const layer = await Layer.findById(layerId)
    if (!layer) {
      return reply.code(404).send({ error: 'Layer not found' })
    }

    const rows = await Feature.searchByName(layerId, q, { limit: limit ? Number(limit) : 20 })
    return rows
  })

  // Transform an array of P(Y,X) points in a layer to WGS84 lat/lon via PostGIS (if available)
  app.post('/spatial/layers/:layerId/transform', {
    preHandler: [app.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
      },
      body: {
        type: 'object',
        required: ['points'],
        properties: {
          points: {
            type: 'array',
            items: {
              type: 'object',
              required: ['y','x'],
              properties: { y: { type: 'number' }, x: { type: 'number' } }
            },
            minItems: 1
          }
        }
      }
    }
  }, async (request, reply) => {
    const layerId = Number(request.params.layerId)
    const { points } = request.body

    const layer = await Layer.findById(layerId)
    if (!layer) return reply.code(404).send({ error: 'Layer not found' })
    const srid = Number(layer.srid || 0)
    if (!srid || !Number.isFinite(srid)) {
      return { ok: true, coords: points.map(() => null), note: 'No SRID on layer' }
    }

    // Build VALUES table with parameter placeholders
    const tuples = points.map((_, i) => `($${i*2+1}, $${i*2+2})`).join(',')
    const params = []
    for (const p of points) { params.push(p.y, p.x) }
    const sql = `
      SELECT json_agg(json_build_object('lat', ST_Y(g4326), 'lon', ST_X(g4326))) AS arr
      FROM (
        SELECT ST_Transform(ST_SetSRID(ST_MakePoint(v.y, v.x), $${params.length+1}), 4326) AS g4326
        FROM (VALUES ${tuples}) AS v(y, x)
      ) t`;
    try {
      const result = await db.query(sql, [...params, srid])
      const arr = result.rows[0]?.arr || []
      return { ok: true, coords: arr }
    } catch (err) {
      // Likely PostGIS functions unavailable
      return { ok: false, coords: points.map(() => null), error: 'Transform failed (PostGIS missing?)' }
    }
  })

  // Update a layer SRID (and optional central meridian) for admin correction
  app.put('/spatial/layers/:layerId/srid', {
    preHandler: [app.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
      },
      body: {
        type: 'object',
        properties: {
          srid: { type: 'number' },
          central_meridian: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const layerId = Number(request.params.layerId)
    const { srid, central_meridian } = request.body || {}
    const layer = await Layer.findById(layerId)
    if (!layer) return reply.code(404).send({ error: 'Layer not found' })

    let newSrid = Number(srid || layer.srid || 0)
    // If only central_meridian provided, map to EPSG
    if ((!srid || !Number.isFinite(Number(srid))) && central_meridian) {
      const cmKey = String(central_meridian).toUpperCase()
      const epsgMap = { LO25: 22285, LO27: 22287, LO29: 22289, LO31: 22291, LO33: 22293 }
      if (epsgMap[cmKey]) newSrid = epsgMap[cmKey]
    }
    if (!newSrid || !Number.isFinite(newSrid)) return reply.code(400).send({ error: 'SRID not provided or cannot be derived from central_meridian' })

    const params = { ...(layer.params || {}) }
    if (central_meridian) params.central_meridian = central_meridian
    const updated = await Layer.update(layerId, {
      name: layer.name,
      layerType: layer.layer_type,
      geomType: layer.geom_type,
      srid: newSrid,
      params
    })
    return updated
  })

  // Create project-specific views for QGIS workflow
  app.post('/spatial/create-project-views', {
    preHandler: [app.authenticate],
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
    
    try {
      const result = await db.query('SELECT create_project_views($1) as result', [project_id])
      const viewInfo = result.rows[0]?.result
      
      return { 
        ok: true, 
        message: `Views created for project ${project_id}`,
        ...viewInfo
      }
    } catch (err) {
      app.log.error(err)
      return reply.code(500).send({ ok: false, error: err.message })
    }
  })

  // Drop project-specific views
  app.delete('/spatial/project-views/:projectId', {
    preHandler: [app.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    const { projectId } = request.params
    
    try {
      const result = await db.query('SELECT drop_project_views($1) as result', [projectId])
      const viewInfo = result.rows[0]?.result
      
      return { 
        ok: true, 
        message: `Views dropped for project ${projectId}`,
        ...viewInfo
      }
    } catch (err) {
      app.log.error(err)
      return reply.code(500).send({ ok: false, error: err.message })
    }
  })

  // List all project views
  app.get('/spatial/project-views', {
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    try {
      const result = await db.query('SELECT * FROM list_project_views()')
      return { 
        ok: true, 
        views: result.rows
      }
    } catch (err) {
      app.log.error(err)
      return reply.code(500).send({ ok: false, error: err.message })
    }
  })

  // Get database connection info for QGIS integration (with schema-aware configuration)
  app.get('/spatial/db-connection', {
    preHandler: [app.authenticate, authenticateWithSchema],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          project_id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { project_id } = request.query || {}
    
    // Schema info is already populated by authenticateWithSchema middleware
    const surveyorSchema = request.surveyorSchema || 'public'
    const surveyorProfile = request.surveyorProfile
    
    // Get database config from environment or config
    const dbConfig = {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'survey-suite_v1',
      username: process.env.DB_USER || 'postgres',
      sslmode: process.env.DB_SSL || 'disable',
      schema: surveyorSchema
    }

    // Build QGIS connection string (without password)
    const qgisConnection = `postgresql://${dbConfig.username}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}?sslmode=${dbConfig.sslmode}`
    
    // Build connection URI for QGIS (alternative format)
    const qgisUri = `host=${dbConfig.host} port=${dbConfig.port} dbname=${dbConfig.database} user=${dbConfig.username} sslmode=${dbConfig.sslmode}`

    const response = {
      ok: true,
      connection: {
        host: dbConfig.host,
        port: dbConfig.port,
        database: dbConfig.database,
        username: dbConfig.username,
        sslmode: dbConfig.sslmode,
        schema: dbConfig.schema
      },
      qgis_connection_string: qgisConnection,
      qgis_uri: qgisUri,
      surveyor_schema: surveyorSchema,
      surveyor_profile: surveyorProfile ? {
        id: surveyorProfile.id,
        name: surveyorProfile.name
      } : null
    }

    // If project_id provided, include project-specific view names and check if views exist
    if (project_id) {
      // Get project details
      const projectResult = await db.query(
        'SELECT id, name, client_name FROM survey_projects WHERE id = $1',
        [project_id]
      )
      
      if (projectResult.rows.length === 0) {
        return reply.code(404).send({ error: 'Project not found' })
      }
      
      const project = projectResult.rows[0]
      
      // Check if views exist
      const viewCheck = await db.query(`
        SELECT EXISTS (
          SELECT FROM pg_views 
          WHERE schemaname = 'public' 
          AND viewname = $1
        ) as exists
      `, [`coordinate_points_project_${project_id}`])
      
      const viewsExist = viewCheck.rows[0]?.exists || false
      
      response.project_id = project_id
      response.project_name = project.name
      response.client_name = project.client_name
      response.views = {
        coordinate_points: `coordinate_points_project_${project_id}`,
        land_parcels: `land_parcels_project_${project_id}`,
        exist: viewsExist
      }
      
      if (viewsExist) {
        response.status = 'ready'
        response.instructions = [
          '✅ Project-specific views are ready!',
          '',
          '📍 STEP 1: OPEN QGIS',
          '  • Launch QGIS Desktop',
          '',
          '🔌 STEP 2: CREATE DATABASE CONNECTION',
          '  • Layer → Add Layer → Add PostGIS Layers',
          '  • Click "New" connection',
          `  • Name: Survey Task Manager - ${project.name}`,
          `  • Host: ${dbConfig.host}`,
          `  • Port: ${dbConfig.port}`,
          `  • Database: ${dbConfig.database}`,
          `  • Username: ${dbConfig.username}`,
          '  • Password: (enter database password)',
          '  • Click "Test Connection" → "OK"',
          '',
          '⚠️ STEP 3: ADD PROJECT-SPECIFIC LAYERS (IMPORTANT!)',
          `  • Expand "${dbConfig.schema}" schema`,
          `  • ✓ Add: ${response.views.coordinate_points}`,
          '    └─ This is your REFERENCE layer (read-only points)',
          `  • ✓ Add: ${response.views.land_parcels}`,
          '    └─ This is your DIGITIZATION layer (draw parcels here)',
          '    ⚠️ CRITICAL: When adding this layer:',
          '       1. Select the layer',
          '       2. Check "Select at id" or manually set Primary Key to "id"',
          '       3. This ensures QGIS can properly manage edits',
          '  • ⚠️ DO NOT use coordinate_points or land_parcels (base tables)',
          '',
          '🎯 STEP 4: CONFIGURE LAYERS',
          '  • Set CRS to EPSG:22291 (Hartebeesthoek94 / Lo31)',
          '  • Right-click coordinate layer → Properties → Labels',
          '    └─ Enable labels, use "name" field',
          '  • Settings → Snapping Options',
          '    └─ Enable snapping to coordinate layer (0.01m tolerance)',
          '',
          '✏️ STEP 5: DIGITIZE PARCELS',
          '  • Select land_parcels layer',
          '  • Toggle editing (pencil icon)',
          '  • Use "Add Polygon Feature" tool',
          '  • Snap vertices to coordinate points',
          '  • Enter "stand" name when prompted',
          '  • Save edits (disk icon)',
          '',
          '💾 STEP 6: RETURN TO SURVEY-SUITE',
          '  • Click "Refresh Parcels" button',
          '  • Your digitized parcels will appear',
          '  • Areas are calculated automatically',
          '',
          `🔒 Security: Only project ${project_id} data is visible in QGIS`
        ]
      } else {
        response.status = 'not_created'
        response.instructions = [
          '⚠️ Project views not created yet',
          '',
          'Click "Create Project Views" button first,',
          'then return here for QGIS connection instructions.'
        ]
      }
    } else {
      response.instructions = [
        '1. Open QGIS',
        '2. Go to Layer → Add Layer → Add PostGIS Layers',
        '3. Click "New" to create a new connection',
        `4. Name: Survey Task Manager`,
        `5. Host: ${dbConfig.host}`,
        `6. Port: ${dbConfig.port}`,
        `7. Database: ${dbConfig.database}`,
        `8. Username: ${dbConfig.username}`,
        '9. Password: (enter your database password)',
        '10. Click "Test Connection" then "OK"',
        '11. Select tables: coordinate_points, land_parcels',
        '12. Enable snapping: Settings → Snapping Options → 0.01m tolerance'
      ]
    }

    return response
  })

  // Batch create features with duplicate detection
  app.post('/spatial/layers/:layerId/features/batch', {
    preHandler: [app.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['layerId'],
        properties: { layerId: { type: 'string' } }
      },
      body: {
        type: 'object',
        required: ['features'],
        properties: {
          features: {
            type: 'array',
            items: {
              type: 'object',
              required: ['geometry', 'properties'],
              properties: {
                geometry: { type: 'object' },
                properties: { type: 'object' }
              }
            }
          },
          replace_duplicates: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    const layerId = Number(request.params.layerId)
    const { features, replace_duplicates = false } = request.body

    const layer = await Layer.findById(layerId)
    if (!layer) {
      return reply.code(404).send({ error: 'Layer not found' })
    }

    const results = {
      total: features.length,
      created: 0,
      skipped: 0,
      replaced: 0,
      errors: 0,
      details: []
    }

    for (const feat of features) {
      const name = feat.properties?.name
      
      if (!name) {
        results.errors++
        results.details.push({
          name: null,
          status: 'error',
          message: 'Missing name property'
        })
        continue
      }

      try {
        // Check if feature with this name already exists
        const existing = await Feature.findByLayerAndName(layerId, name)

        if (existing) {
          if (replace_duplicates) {
            // Update existing feature
            await Feature.update(existing.id, {
              geometry: feat.geometry,
              properties: feat.properties
            })
            results.replaced++
            results.details.push({
              name,
              status: 'replaced',
              id: existing.id
            })
          } else {
            // Skip duplicate
            results.skipped++
            results.details.push({
              name,
              status: 'skipped',
              message: 'Already exists',
              id: existing.id
            })
          }
        } else {
          // Create new feature
          const created = await Feature.create({
            layerId,
            projectId: layer.project_id,
            geometry: feat.geometry,
            properties: feat.properties
          })
          results.created++
          results.details.push({
            name,
            status: 'created',
            id: created.id
          })
        }
      } catch (err) {
        results.errors++
        results.details.push({
          name,
          status: 'error',
          message: err.message
        })
      }
    }

    return {
      ok: true,
      ...results
    }
  })
}