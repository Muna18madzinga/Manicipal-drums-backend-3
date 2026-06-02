/**
 * Vungu Master Plan - Unified Backend Server
 * Single consolidated server for all API endpoints
 */

// Load .env so DATABASE_URL / JWT_SECRET / etc. reach process.env before any
// route module reads them. The dotenv dependency was installed but never wired.
require('dotenv').config()

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

// Import Stands + Planning Assistant routes (Turn A foundation).
// These power: citizens picking stands on the public map, and the
// planner's "what can be developed here" assistant. Both endpoints read
// from the existing zone_land_use_controls + planning_assistant_templates.
const { standsRoutes } = require('./src/routes/stands')
const { planningAssistantRoutes } = require('./src/routes/planning-assistant')
const plannerRoutes = require('./src/routes/planner')

// Turn B: inspection bookings + photos + status notifications.
// These plug into the existing development_applications table.
const { inspectionRoutes } = require('./src/routes/inspections')
const { applicationStatusRoutes } = require('./src/routes/application-status')

// Turn C: payments (USD/ZiG) + citizen-document verification.
const { paymentRoutes } = require('./src/routes/payments')
const { documentRoutes } = require('./src/routes/documents')

// Turn D: plan auto-review (PDF + CAD upload + deterministic checks).
const { planReviewRoutes } = require('./src/routes/plan-review')

// Turn E: DM Handbook 2021 v1.2 — permit applications, enforcement, building plans,
// stage inspections, and certificates of occupation (spatial_planning schema).
const { developmentManagementRoutes } = require('./src/routes/development-management')

// Import Public Routes
const { publicRoutes } = require('./src/routes/public')

// Import Spatial Routes
const { spatialRoutes } = require('./src/routes/spatial')

// Vector tile service — serves zimbabwe.gpkg PostGIS layers as MVT.
const { tilesRoutes } = require('./src/routes/tiles')
const { parcelsRoutes } = require('./src/routes/parcels')
const { citizenPortalRoutes } = require('./src/routes/citizen-portal')

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

  const localOrigins = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:3000',
    'http://127.0.0.1:58487',
  ]
  const configuredOrigins = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
  const corsOrigins = configuredOrigins.length
    ? configuredOrigins
    : process.env.NODE_ENV === 'production'
      ? ['https://vungu-rdc.org']
      : localOrigins

  // Register CORS
  await server.register(require('@fastify/cors'), {
    origin: corsOrigins
  })

  // Register Compression
  await server.register(require('@fastify/compress'))

  // Register Rate Limiting.
  // - Global cap bumped from 100/min to 1000/min: a map app legitimately
  //   issues bursts of tile + feature requests when the user pans, zooms,
  //   or clicks across many overlapping layers.
  // - Skip /api/tiles/* and /api/wards entirely. They are read-only,
  //   already cache-controlled (1d on tiles, 1h on wards), and a single
  //   viewport easily blows past any sane per-IP cap on slow networks.
  //   Write endpoints (auth, applications, etc.) keep the global limit.
  await server.register(require('@fastify/rate-limit'), {
    max: 1000,
    timeWindow: '1 minute',
    allowList: (req) =>
      req.url.startsWith('/api/tiles/') ||
      req.url.startsWith('/api/wards') ||
      req.url.startsWith('/api/map-search'),
  })

  // Register PostgreSQL
  await server.register(require('@fastify/postgres'), {
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:cairo2025@localhost:5432/vungu_master_db_v1'
  })

  // Register Redis when REDIS_URL is set. Used by the MVT tile route as the
  // L2 cache behind its in-process LRU; survives restarts and is shared
  // across replicas. Without REDIS_URL the tile cache silently degrades to
  // L1-only, which is still fast — Redis is an optimisation, not a
  // requirement.
  if (process.env.REDIS_URL) {
    try {
      await server.register(require('@fastify/redis'), {
        url: process.env.REDIS_URL,
        closeClient: true,
      })
      server.log.info('Redis registered for tile L2 cache')
    } catch (err) {
      server.log.warn({ err }, 'Redis registration failed; continuing with L1-only cache')
    }
  }

  // Multipart form support — required by the inspection-photo upload
  // route (and any future file uploads). Hard-cap files at 10 MB.
  const path = require('node:path')
  await server.register(require('@fastify/multipart'), {
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  })

  // Static serving for uploaded photos. Mounted at /uploads — the same
  // path the inspection-photos route hands back as `storage_url`.
  // The directory is created on demand by the route handler if missing.
  const uploadsRoot = path.resolve(process.cwd(), 'uploads')
  try { require('node:fs').mkdirSync(uploadsRoot, { recursive: true }) } catch { /* noop */ }
  await server.register(require('@fastify/static'), {
    root: uploadsRoot,
    prefix: '/uploads/',
    decorateReply: false,
  })

  // (Removed) onRoute debug log — was extremely noisy at startup and
  // leaked the entire route surface to stdout. Use `server.printRoutes()`
  // (already called below) for a one-shot summary.

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
  server.get('/api/test', async () => {
    return { message: 'Unified backend server working', timestamp: new Date().toISOString() }
  })

  /*
    REMOVED:
      - /simple-test (debug only)
      - /api/auth/test (debug only)
      - /api/auth/register-direct
          The previous 'direct' register endpoint stored passwords as the
          string `'hashed_' + password` and accepted any role from the body,
          allowing unauthenticated role escalation. The proper /api/auth/register
          (registered below) replaces it with bcrypt + a hard-pinned customer
          role allow-list.
  */

  // Register Public Routes
  try {
    await server.register(publicRoutes, { prefix: '/api' })
    console.log('✅ Public routes registered')
  } catch (error) {
    console.error('❌ Failed to register public routes:', error.message)
  }

  // Register Auth Routes — hardened JWT + bcrypt; see src/routes/auth.js.
  // The auth scope gets a tighter rate limit than the rest of the API.
  // Default global limit (100/min) is fine for read endpoints; bursts on
  // /auth/login or /auth/register are almost always abusive.
  try {
    await server.register(async (scope) => {
      scope.addHook('onRequest', server.rateLimit({
        max: 10,
        timeWindow: '1 minute',
      }))
      await scope.register(authRoutes)
    }, { prefix: '/api' })
  } catch (authError) {
    server.log.error({ err: authError }, 'Failed to register auth routes')
  }

  // Register Stands + Planning Assistant routes (Turn A).
  // These mount under /api and respect the global rate-limit.
  try {
    await server.register(standsRoutes,            { prefix: '/api' })
    await server.register(planningAssistantRoutes, { prefix: '/api' })
    await server.register(plannerRoutes,           { prefix: '/api' })
    console.log('✅ Stands + Planning Assistant + Planner notifications routes registered')
  } catch (error) {
    server.log.error({ err: error }, 'Failed to register stands/planning routes')
  }

  // Register Inspection routes (Turn B): bookings, photos, notifications.
  try {
    await server.register(inspectionRoutes,         { prefix: '/api' })
    await server.register(applicationStatusRoutes,  { prefix: '/api' })
    console.log('✅ Inspection + status-change routes registered')
  } catch (error) {
    server.log.error({ err: error }, 'Failed to register inspection routes')
  }

  // Register Payments + Documents (Turn C).
  try {
    await server.register(paymentRoutes,   { prefix: '/api' })
    await server.register(documentRoutes,  { prefix: '/api' })
    console.log('✅ Payment + document routes registered')
  } catch (error) {
    server.log.error({ err: error }, 'Failed to register payment/document routes')
  }

  // Register Plan Review (Turn D).
  try {
    await server.register(planReviewRoutes, { prefix: '/api' })
    console.log('✅ Plan review routes registered')
  } catch (error) {
    server.log.error({ err: error }, 'Failed to register plan review routes')
  }

  // Register Development Management — DM Handbook 2021 v1.2 (Turn E).
  // Covers: permit applications, consultations, objections, appeals,
  // enforcement orders, prohibition orders, building plans,
  // stage inspections (Annexures 12/14), and certificates of occupation.
  try {
    await server.register(developmentManagementRoutes, { prefix: '/api' })
    console.log('✅ Development Management (DM Handbook v1.2) routes registered')
  } catch (error) {
    server.log.error({ err: error }, 'Failed to register development management routes')
  }

  // Register Spatial Routes
  try {
    await server.register(spatialRoutes, { prefix: '/api' })
    console.log('✅ Spatial routes registered')
  } catch (error) {
    console.error('❌ Failed to register spatial routes:', error.message)
  }

  try {
    await server.register(tilesRoutes, { prefix: '/api' })
    await server.register(parcelsRoutes, { prefix: '/api' })
    await server.register(citizenPortalRoutes, { prefix: '/api' })
    console.log('✅ Vector tile routes registered')
  } catch (error) {
    server.log.error({ err: error }, 'Failed to register tile routes')
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


  // Print the route summary in development only — useful when adding new
  // route plugins, but it shouldn't surface in production logs.
  if (process.env.NODE_ENV !== 'production') {
    console.log('\n📋 Registered Routes:')
    console.log(server.printRoutes())
  }

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

    // Optional in-process email worker — keeps the dev experience simple
    // (no second daemon needed). For multi-instance deploys, run
    // `node src/workers/emailWorker.js` separately and leave this off.
    if (process.env.MAIL_WORKER_INPROC === '1') {
      try {
        const { startEmailWorker } = require('./src/workers/emailWorker')
        startEmailWorker(server.pg.pool || server.pg, { log: server.log })
      } catch (err) {
        server.log.warn({ err }, 'Failed to start in-process email worker')
      }
    }

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
