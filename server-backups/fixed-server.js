// Fixed main server - starting from working minimal server
const Fastify = require('fastify')

// Clear require cache for OGC services to force reload of .env configuration
delete require.cache[require.resolve('./src/routes/ogcServices')]
delete require.cache[require.resolve('./src/services/admin/refinedOGCBridge')]

// Import Smart QGIS Extractor
const { SmartQGISExtractor } = require('./src/services/admin/smartQGISExtractor')

// Import OGC Services Routes
const ogcServicesRoutes = require('./src/routes/ogcServices')

// Import Auth Routes
const { authRoutes } = require('./src/routes/auth')

// Import WFS Publisher Routes
let wfsPublisherRoutes
try {
  const WFSPublisherRoutes = require('./src/routes/wfsPublisher')
  wfsPublisherRoutes = new WFSPublisherRoutes()
} catch (error) {
  console.warn('Could not load WFS Publisher routes:', error.message)
}

// Import Development Control Routes
let developmentControlRoutes
try {
  developmentControlRoutes = require('./src/routes/development-control-refactored.js')
} catch (error) {
  console.warn('Could not load Development Control routes:', error.message)
}

// Import Development Application Routes
let developmentApplicationRoutes
try {
  developmentApplicationRoutes = require('./src/routes/development-applications.js')
} catch (error) {
  console.warn('Could not load Development Application routes:', error.message)
}

// Import Land Use Management Routes
let landUseManagementRoutes
try {
  landUseManagementRoutes = require('./src/routes/land-use-management.js')
} catch (error) {
  console.warn('Could not load Land Use Management routes:', error.message)
}

async function build() {
  const server = Fastify({
    logger: true
  })

  // Register CORS
  await server.register(require('@fastify/cors'), {
    origin: process.env.NODE_ENV === 'production' 
      ? ['https://vungu-rdc.org'] 
      : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175', 'http://localhost:3000', 'http://127.0.0.1:58487']
  })

  // Register PostgreSQL
  await server.register(require('@fastify/postgres'), {
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:cairo2025@localhost:5432/vungu_master_db_v1'
  })

  // Debug: Log all routes - MUST be added BEFORE route registrations
  server.addHook('onRoute', (routeOptions) => {
    console.log(`[Route] 🛣️ Registered: ${routeOptions.method} ${routeOptions.url}`)
  })

  // Register OGC Services Routes (WMS/WFS/WMTS)
  await server.register(ogcServicesRoutes, { prefix: '/api' })
  
  // Register Auth Routes
  try {
    console.log('[Debug] authRoutes type:', typeof authRoutes)
    await server.register(authRoutes, { prefix: '/api' })
    console.log('✅ Auth routes registered')
  } catch (authError) {
    console.error('❌ Failed to register auth routes:', authError.message)
  }
  
  // Register WFS Publisher Routes
  if (wfsPublisherRoutes) {
    await wfsPublisherRoutes.registerRoutes(server)
    console.log('✅ WFS Publisher routes registered')
  }

  // Register Development Control Routes
  if (developmentControlRoutes) {
    await server.register(developmentControlRoutes, { prefix: '/api/development-control' })
    console.log('✅ Development Control routes registered')
  }

  // Register Development Application Routes
  if (developmentApplicationRoutes) {
    await server.register(developmentApplicationRoutes, { prefix: '/api' })
    console.log('✅ Development Application routes registered')
  }

  // Register Land Use Management Routes
  if (landUseManagementRoutes) {
    await server.register(landUseManagementRoutes, { prefix: '/api/land-use' })
    console.log('✅ Land Use Management routes registered')
  }

  // All routes registered, print summary
  console.log('\n📋 Registered Routes:')
  const routes = server.printRoutes()
  console.log(routes)

  // Enhanced layers endpoint with smart extraction
  server.get('/api/dynamic-layers/layers', async (request, reply) => {
    try {
      console.log('[Layers] 🚀 Loading layers with smart extraction...')
      
      // Sample layers for testing
      const sampleLayers = [
        {
          table_name: 'business_centres',
          display_name: 'Business Centres',
          geometry_type: 'point',
          description: 'Business centre locations',
          style_config: null
        },
        {
          table_name: 'growth_points',
          display_name: 'Growth Points',
          geometry_type: 'point',
          description: 'Growth point locations',
          style_config: null
        },
        {
          table_name: 'rural_service_centres',
          display_name: 'Rural Service Centres',
          geometry_type: 'point',
          description: 'Rural service centre locations',
          style_config: null
        }
      ]
      
      // Initialize Smart QGIS Extractor
      const smartExtractor = new SmartQGISExtractor()
      
      // Process layers with smart extraction
      const layersWithStyles = await Promise.all(sampleLayers.map(async (layer) => {
        let finalStyle = layer.style_config || getDefaultStyle(layer.geometry_type)
        
        // Try Smart QGIS extraction
        try {
          console.log(`[Layers] 🚀 Trying Smart QGIS Extractor for ${layer.display_name}`)
          const smartStyle = await smartExtractor.extractStyle(layer.table_name, {
            includeSVG: true,
            includeLabels: true,
            cache: true
          })
          
          if (smartStyle && smartStyle.symbols && smartStyle.symbols.length > 0) {
            console.log(`[Layers] 🎯 Smart extraction successful for ${layer.display_name}`)
            console.log(`[Layers] 📊 Extracted ${smartStyle.symbols.length} symbols, SVG: ${smartStyle.metadata.hasSVG}`)
            
            // Merge smart style with existing config
            finalStyle = {
              ...finalStyle,
              ...smartStyle,
              _smartExtraction: true,
              _extractionTime: smartStyle.extractionTime,
              _extractionSource: smartStyle.metadata.source
            }
          }
        } catch (error) {
          console.log(`[Layers] ⚠️ Smart extraction failed for ${layer.display_name}: ${error.message}`)
          // Use default style
        }
        
        return {
          id: layer.table_name,
          name: layer.display_name,
          type: layer.geometry_type,
          description: layer.description,
          style: finalStyle
        }
      }))
      
      console.log(`[Layers] ✅ Returning ${layersWithStyles.length} layers with smart extraction`)
      
      return {
        success: true,
        data: layersWithStyles
      }
    } catch (error) {
      console.error('[Layers] ❌ Failed to load layers:', error)
      return reply.code(500).send({ error: 'Failed to load layers', details: error.message })
    }
  })

  // Individual layer data endpoints
  server.get('/api/dynamic-layers/layer/:layerName', async (request, reply) => {
    try {
      const { layerName } = request.params
      console.log(`[Layer] 🚀 Loading individual layer data for ${layerName}`)
      
      // Try to get real data from database
      let geometries = []
      
      try {
        const query = `SELECT ST_AsGeoJSON(geom) as geometry, province_n as name, id FROM ${layerName} WHERE geom IS NOT NULL LIMIT 100`
        const result = await server.pg.query(query)
        console.log(`[Layer] 📊 Found ${result.rowCount} features in ${layerName}`)
        
        geometries = result.rows.map(row => {
          const geometry = JSON.parse(row.geometry)
          // Handle MultiPoint by converting to Point if needed
          if (geometry.type === 'MultiPoint') {
            return geometry.coordinates.map((coord, index) => ({
              type: "Point",
              coordinates: coord,
              properties: {
                name: row.name || `Feature ${row.id}-${index}`,
                id: `${row.id}-${index}`
              }
            }))
          } else {
            return [{
              type: "Point",
              coordinates: geometry.coordinates,
              properties: {
                name: row.name || `Feature ${row.id}`,
                id: row.id
              }
            }]
          }
        }).flat() // Flatten the array of arrays
        
        console.log(`[Layer] ✅ Successfully loaded ${geometries.length} features from database`)
      } catch (dbError) {
        console.log(`[Layer] 🔄 Database query failed, using sample data: ${dbError.message}`)
        
        // Fallback to sample data
        geometries = [
          {
            type: "Point",
            coordinates: [30.0, -20.0],
            properties: {
              name: `Sample ${layerName}`,
              id: 1
            }
          }
        ]
      }
      
      const layerData = {
        success: true,
        data: {
          type: "Topology",
          objects: {
            collection: {
              type: "GeometryCollection",
              geometries: geometries
            }
          },
          arcs: [],
          transform: {
            scale: [1, 1],
            translate: [0, 0]
          }
        },
        layerName: layerName
      }
      
      console.log(`[Layer] ✅ Returning TopoJSON data for ${layerName}`)
      console.log(`[Layer] 📊 Data structure: ${geometries.length} geometries`)
      
      return layerData
    } catch (error) {
      console.error(`[Layer] ❌ Failed to load layer:`, error)
      return reply.code(500).send({ error: 'Failed to load layer', details: error.message })
    }
  })

  // Default styles function
  function getDefaultStyle(geometryType) {
    switch (geometryType) {
      case 'point':
        return { color: '#96CEB4', radius: 8 }
      case 'line':
        return { color: '#DDA0DD', strokeWidth: 3 }
      case 'polygon':
        return { color: '#FF6B6B', fillOpacity: 0.3, strokeColor: '#FF6B6B' }
      default:
        return { color: '#BDC3C7' }
    }
  }

  // Test endpoint
  server.get('/test', async (request, reply) => {
    return { 
      message: 'Enhanced server with smart extraction is working!', 
      timestamp: new Date().toISOString(),
      endpoints: [
        'GET /test',
        'GET /api/dynamic-layers/layers (with smart extraction)'
      ]
    }
  })

  return server
}

async function start() {
  try {
    const server = await build()
    
    await server.listen({ port: 3000, host: '0.0.0.0' })
    
    console.log('🚀 Enhanced server running on http://localhost:3000')
    console.log('📝 Endpoints:')
    console.log('   - http://localhost:3000/test')
    console.log('   - http://localhost:3000/api/dynamic-layers/layers (with smart extraction)')
    console.log('   - http://localhost:3000/api/dynamic-layers/layer/:layerName (individual layer data)')
    console.log('')
    console.log('🌐 OGC Services (WMS/WFS/WMTS):')
    console.log('   - http://localhost:3000/api/ogc/health')
    console.log('   - http://localhost:3000/api/ogc/wfs/features/:layerName (Vector GeoJSON)')
    console.log('   - http://localhost:3000/api/ogc/wms/legend/:layerName (Legend graphic)')
    console.log('   - http://localhost:3000/api/ogc/wmts/tile/:layerName/:z/:x/:y (Map tiles)')
    console.log('   - http://localhost:3000/api/ogc/styled-layer/:layerName (Features + Style)')
    console.log('   - http://localhost:3000/api/ogc/maplibre-style/:layerName (MapLibre style)')
    console.log('')
    console.log('📝 Development Applications:')
    console.log('   - POST http://localhost:3000/api/development-applications (Submit)')
    console.log('   - GET  http://localhost:3000/api/development-applications (List)')
    console.log('   - GET  http://localhost:3000/api/development-applications/:id (Detail)')
    console.log('   - GET  http://localhost:3000/api/development-applications/stats (Statistics)')
    console.log('   - GET  http://localhost:3000/api/development-applications/development-types (Types)')
    
  } catch (err) {
    console.error('❌ Server failed to start:', err)
    process.exit(1)
  }
}

start()
