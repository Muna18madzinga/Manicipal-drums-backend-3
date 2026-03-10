/**
 * Vungu Master Plan - Unified Backend Server
 * Single consolidated server for all API endpoints
 */

const Fastify = require('fastify')

// Clear require cache for OGC services to force reload of .env configuration
delete require.cache[require.resolve('./src/routes/ogcServices')]
delete require.cache[require.resolve('./src/services/admin/refinedOGCBridge')]

// Import Smart QGIS Extractor
const { SmartQGISExtractor } = require('./src/services/admin/smartQGISExtractor')

// Import OGC Services Routes (WMS/WFS/WMTS)
const ogcServicesRoutes = require('./src/routes/ogcServices')

// Import Auth Routes
const { authRoutes } = require('./src/routes/auth')

// Import Public Routes
const { publicRoutes } = require('./src/routes/public')

// Import Spatial Routes
const { spatialRoutes } = require('./src/routes/spatial')

// Import Spatial Data Routes
let spatialDataRoutes
try {
  // Try TypeScript import first
  spatialDataRoutes = require('./src/routes/spatial-data.ts')
} catch (tsError) {
  try {
    // Fallback to JavaScript if available
    spatialDataRoutes = require('./src/routes/spatial-data.js')
  } catch (jsError) {
    console.warn('Could not load Spatial Data routes (both .ts and .js failed):', jsError.message)
  }
}

// Import Development Control Routes
let developmentControlRoutes
try {
  developmentControlRoutes = require('./src/routes/development-control-refactored.js')
} catch (tsError) {
  try {
    // Fallback to JavaScript if available
    developmentControlRoutes = require('./src/routes/development-control-refactored.js')
  } catch (jsError) {
    console.warn('Could not load Development Control routes (both .ts and .js failed):', jsError.message)
  }
}

// Import Enhanced Land Use Management Routes
let enhancedLandUseManagementRoutes
console.log('🔍 DEBUG: About to load Enhanced Land Use Management module...')
try {
  enhancedLandUseManagementRoutes = require('./routes/land-use-management-enhanced.js')
  console.log('✅ Enhanced Land Use Management module loaded:', typeof enhancedLandUseManagementRoutes)
  console.log('🔍 DEBUG: Module exists:', !!enhancedLandUseManagementRoutes)
} catch (error) {
  console.warn('❌ Could not load Enhanced Land Use Management routes:', error.message)
}

// Import Land Use Management Routes
let landUseManagementRoutes
try {
  landUseManagementRoutes = require('./src/routes/land-use-management.js')
} catch (error) {
  console.warn('Could not load Land Use Management routes:', error.message)
}

// Import Dynamic Layers Routes
let dynamicLayerRoutes
try {
  dynamicLayerRoutes = require('./src/routes/dynamic-layers')
} catch (error) {
  console.warn('Could not load Dynamic Layers routes:', error.message)
}

// Import QGIS Server Routes
let qgisServerRoutes
try {
  qgisServerRoutes = require('./src/routes/qgisServer')
} catch (error) {
  console.warn('Could not load QGIS Server routes:', error.message)
}

// Import WFS Publisher Routes
let wfsPublisherRoutes
try {
  const WFSPublisherRoutes = require('./src/routes/wfsPublisher')
  wfsPublisherRoutes = new WFSPublisherRoutes()
} catch (error) {
  console.warn('Could not load WFS Publisher routes:', error.message)
}

// Import Development Application Routes
let developmentApplicationRoutes
try {
  developmentApplicationRoutes = require('./src/routes/development-applications.js')
} catch (error) {
  console.warn('Could not load Development Application routes:', error.message)
}

async function build() {
  const server = Fastify({
    logger: true,
    trustProxy: true
  })

  // Register CORS
  await server.register(require('@fastify/cors'), {
    origin: process.env.NODE_ENV === 'production' 
      ? ['https://vungu-rdc.org'] 
      : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175', 'http://localhost:3000', 'http://127.0.0.1:58487']
  })

  // Register Compression
  await server.register(require('@fastify/compress'))

  // Register Rate Limiting
  await server.register(require('@fastify/rate-limit'), {
    max: 100,
    timeWindow: '1 minute'
  })

  // Register PostgreSQL
  await server.register(require('@fastify/postgres'), {
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:cairo2025@localhost:5432/vungu_master_db_v1'
  })

  // Debug: Log all routes - MUST be added BEFORE route registrations
  server.addHook('onRoute', (routeOptions) => {
    console.log(`[Route] 🛣️ Registered: ${routeOptions.method} ${routeOptions.url}`)
  })

  // Health check - register first
  server.get('/health', async (request, reply) => {
    return { 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      service: 'vungu-unified-backend',
      version: '1.0.0'
    }
  })

  // Test route
  server.get('/api/test', async (request, reply) => {
    return { message: 'Unified backend server working!', timestamp: new Date().toISOString() }
  })

  // Simple test route
  server.get('/simple-test', async (request, reply) => {
    console.log('🔐 Simple test route called!')
    return { message: 'Simple test working', timestamp: new Date().toISOString() }
  })

  // Auth test route
  server.get('/api/auth/test', async (request, reply) => {
    console.log('🔐 Auth test route called!')
    return { message: 'Auth routes working', timestamp: new Date().toISOString() }
  })

  // Direct register endpoint (bypass stale auth module)
  server.post('/api/auth/register-direct', async (request, reply) => {
    console.log('[DIRECT-REG] Hit! Body:', JSON.stringify(request.body))
    try {
      const { name, email, phone, organization, role, password } = request.body || {}
      if (!name || !email || !password) {
        return reply.code(400).send({ success: false, message: 'Name, email, and password are required' })
      }
      const existing = await server.pg.query('SELECT id FROM users WHERE email = $1', [email])
      if (existing.rows.length > 0) {
        return reply.code(409).send({ success: false, message: 'User with this email already exists' })
      }
      const { rows } = await server.pg.query(
        `INSERT INTO users (email, full_name, role, organization, phone, password_hash, status, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', true, NOW(), NOW())
         RETURNING id, email, full_name, role, organization`,
        [email, name, role || 'registered', organization || null, phone || null, 'hashed_' + password]
      )
      console.log('[DIRECT-REG] User created:', rows[0].email)
      return reply.send({ success: true, data: { user: rows[0] }, message: 'Account created' })
    } catch (err) {
      console.error('[DIRECT-REG] ERROR:', err.message, err.detail)
      return reply.code(500).send({ success: false, message: String(err.message), detail: String(err.detail || ''), _v: 'direct' })
    }
  })

  // Register Public Routes
  try {
    await server.register(publicRoutes, { prefix: '/api' })
    console.log('✅ Public routes registered')
  } catch (error) {
    console.error('❌ Failed to register public routes:', error.message)
  }

  // Register Auth Routes
  try {
    console.log('[Debug] authRoutes type:', typeof authRoutes)
    await server.register(authRoutes, { prefix: '/api' })
    console.log('✅ Auth routes registered')
  } catch (authError) {
    console.error('❌ Failed to register auth routes:', authError.message)
  }

  // Register Spatial Routes
  try {
    await server.register(spatialRoutes, { prefix: '/api' })
    console.log('✅ Spatial routes registered')
  } catch (error) {
    console.error('❌ Failed to register spatial routes:', error.message)
  }

  // Register Spatial Data Routes
  if (spatialDataRoutes) {
    try {
      await server.register(spatialDataRoutes, { prefix: '/api' })
      console.log('✅ Spatial data routes registered')
    } catch (error) {
      console.error('❌ Failed to register spatial data routes:', error.message)
    }
  }

  // Register OGC Services Routes (WMS/WFS/WMTS)
  try {
    await server.register(ogcServicesRoutes, { prefix: '/api' })
    console.log('✅ OGC Services routes registered')
  } catch (error) {
    console.error('❌ Failed to register OGC Services routes:', error.message)
  }

  // Register Development Control Routes
  if (developmentControlRoutes) {
    await server.register(developmentControlRoutes, { prefix: '/api/development-control' })
    console.log('✅ Development Control routes registered')
  }

  // Register Enhanced Land Use Management Routes
  if (enhancedLandUseManagementRoutes) {
    try {
      console.log('🔧 About to register Enhanced Land Use Management Routes...')
      await server.register(enhancedLandUseManagementRoutes, { prefix: '/api/land-use' })
      console.log('✅ Enhanced Land Use Management routes registered')
    } catch (error) {
      console.error('❌ Failed to register Enhanced Land Use Management routes:', error)
    }
  }

  // Register Land Use Management Routes
  if (landUseManagementRoutes) {
    await server.register(landUseManagementRoutes, { prefix: '/api/land-use-management' })
    console.log('✅ Land Use Management routes registered')
  }

  // Register Dynamic Layers Routes
  if (dynamicLayerRoutes) {
    try {
      await server.register(dynamicLayerRoutes, { prefix: '/api/dynamic-layers' })
      console.log('✅ Dynamic Layers routes registered')
    } catch (error) {
      console.error('❌ Failed to register Dynamic Layers routes:', error.message)
    }
  }

  // Register QGIS Server Routes
  if (qgisServerRoutes && qgisServerRoutes.createQGISServerRoutes) {
    try {
      await qgisServerRoutes.createQGISServerRoutes(server)
      console.log('✅ QGIS Server routes registered')
    } catch (error) {
      console.error('❌ Failed to register QGIS Server routes:', error.message)
    }
  }

  // Register WFS Publisher Routes
  if (wfsPublisherRoutes) {
    await wfsPublisherRoutes.registerRoutes(server)
    console.log('✅ WFS Publisher routes registered')
  }

  // Register Development Application Routes
  if (developmentApplicationRoutes) {
    await server.register(developmentApplicationRoutes, { prefix: '/api' })
    console.log('✅ Development Application routes registered')
  }


  // All routes registered, print summary
  console.log('\n📋 Registered Routes:')
  const routes = server.printRoutes()
  console.log(routes)

  // 404 handler
  server.setNotFoundHandler(async (request, reply) => {
    reply.status(404).send({
      error: 'Not Found',
      message: `Route ${request.method} ${request.url} not found`,
      timestamp: new Date().toISOString()
    })
  })

  // Global error handler
  server.setErrorHandler(async (error, request, reply) => {
    server.log.error('Unhandled error:', error)
    
    reply.status(error.statusCode || 500).send({
      error: error.name || 'Internal Server Error',
      message: error.message || 'An unexpected error occurred',
      timestamp: new Date().toISOString(),
      ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
    })
  })

  return server
}

async function start() {
  console.log('🚀 Starting Vungu Unified Backend Server...')
  
  try {
    const server = await build()
    const port = parseInt(process.env.PORT || '3000')
    console.log('🚀 About to listen on port:', port)
    
    await server.listen({ 
      port, 
      host: '0.0.0.0' 
    })
    
    console.log(`\n🎉 Vungu Unified Backend Server running successfully!`)
    console.log(`📡 Server: http://localhost:${port}`)
    console.log(`🏥 Health Check: http://localhost:${port}/health`)
    console.log(`🧪 Test Route: http://localhost:${port}/api/test`)
    console.log(`🗺️  OGC Services: http://localhost:${port}/api/ogc`)
    console.log(`🏗️  Development Control: http://localhost:${port}/api/development-control`)
    console.log(`📊 Land Use Management: http://localhost:${port}/api/land-use`)
    console.log(`📋 All Routes: http://localhost:${port}/api/routes`)
    
  } catch (err) {
    console.error('❌ Failed to start server:', err)
    process.exit(1)
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...')
  process.exit(0)
})

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...')
  process.exit(0)
})

// Start the server
if (require.main === module) {
  start()
}

module.exports = { build, start }
