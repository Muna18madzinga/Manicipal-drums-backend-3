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
const { zonesRoutes } = require('./src/routes/zones')

// Turn B: inspection bookings + photos + status notifications.
// These plug into the existing development_applications table.
const { inspectionRoutes } = require('./src/routes/inspections')
const { applicationStatusRoutes } = require('./src/routes/application-status')

// Turn C: payments (USD/ZiG) + citizen-document verification.
const { paymentRoutes } = require('./src/routes/payments')
const { documentRoutes } = require('./src/routes/documents')

// Editable public-site content (CMS) — replaces the static vungurdc.org.zw
// pages so the IT Admin can change wording, staff lists and committee duties.
const { siteContentRoutes } = require('./src/routes/site-content')

// Cross-dept notifications + KYC identity verification (migration 075).
const { notificationsRoutes } = require('./src/routes/notifications')
const { kycRoutes } = require('./src/routes/kyc')

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
const { statutoryPlansRoutes } = require('./src/routes/statutory-plans')
// QGIS Desktop plugin sync API (/api/qgis/sync/upload, /health, etc.). This
// was only wired in the unused src/index.ts entry point, so the plugin's
// endpoints 404'd on the running server.js. Register it here so the plugin works.
const { createQGISRoutes } = require('./src/routes/qgis')
const { gisRoutes } = require('./src/routes/gis')
const { planningRoutes } = require('./src/routes/planning')
const { planningSuggestRoutes } = require('./src/routes/planning-suggest')
const { citizenPortalRoutes } = require('./src/routes/citizen-portal')
const { surveyorRoutes } = require('./src/routes/surveyor')
const { surveyorComputeRoutes } = require('./src/routes/surveyorCompute')
const { controlPointRoutes } = require('./src/routes/controlPoints')
const { propertyRoutes } = require('./src/routes/properties')

// Intelligent map search: NL queries, stand lookup, POI counts, ward search.
const { mapSearchRoutes } = require('./src/routes/map-search')

// spatial-data.ts was a TypeScript rewrite of spatial.js and registers the same
// routes (e.g. /api/coordinate-points). Since spatial.js is already loaded above,
// loading spatial-data would cause a duplicate-route error. Skip it.
const spatialDataRoutes = undefined

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
try {
  enhancedLandUseManagementRoutes = require('./src/routes/land-use-management-enhanced.js')
} catch (error) {
  console.warn('Could not load Enhanced Land Use Management routes:', error.message)
}

// The enhanced version (land-use-management-enhanced.js) supersedes the old file.
// landUseManagementRoutes kept as undefined so the registration block below is skipped cleanly.
const landUseManagementRoutes = undefined

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

  // ── Security headers (@fastify/helmet) ──────────────────────────────────
  // Was installed but never registered. Without this, browsers receive no
  // X-Content-Type-Options, X-Frame-Options, Referrer-Policy, or
  // Content-Security-Policy headers — leaving the app open to clickjacking,
  // MIME sniffing, and data leakage.
  await server.register(require('@fastify/helmet'), {
    contentSecurityPolicy: {
      directives: {
        defaultSrc:    ["'self'"],
        scriptSrc:     ["'self'", "'unsafe-inline'"], // Vue needs inline scripts
        styleSrc:      ["'self'", "'unsafe-inline'"],
        imgSrc:        ["'self'", 'data:', 'blob:', '*.openstreetmap.org', '*.cartocdn.com'],
        connectSrc:    ["'self'", 'https://api.maptiler.com', 'https://basemaps.cartocdn.com'],
        workerSrc:     ["'self'", 'blob:'],
        frameSrc:      ["'none'"],
        objectSrc:     ["'none'"],
        upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,  // MapLibre workers need this off
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // tile CDN sharing
  })

  // Register CORS. Methods are listed explicitly so the preflight
  // Access-Control-Allow-Methods header includes PATCH/DELETE — the EO
  // determination (PATCH /permit-applications/:id/status) and other writes
  // are blocked otherwise when the browser calls :3000 directly (i.e. when
  // VITE_API_BASE_URL bypasses the Vite dev proxy).
  await server.register(require('@fastify/cors'), {
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
  })

  // Cookie support for httpOnly session cookies (auth.js / jwtAuth.js).
  // Replaces localStorage token storage — OWASP advises against storing
  // session/JWT/refresh tokens in localStorage (XSS can read it directly).
  await server.register(require('@fastify/cookie'), {
    secret: process.env.COOKIE_SECRET || process.env.JWT_SECRET,
  })

  // Register Compression
  await server.register(require('@fastify/compress'), {
    global: true,
    threshold: 1024,          // only compress responses > 1 KB
    encodings: ['gzip', 'deflate'],
  })

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
    keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0] || req.ip,
    errorResponseBuilder: () => ({
      success: false,
      error: 'too_many_requests',
      message: 'Rate limit exceeded. Please wait before retrying.',
    }),
    allowList: (req) =>
      req.url.startsWith('/api/tiles/') ||
      req.url.startsWith('/api/wards') ||
      req.url.startsWith('/api/map-search'),
  })

  // Register PostgreSQL. DATABASE_URL is required in production (no hardcoded
  // credentials in source). Local dev falls back to a standard password-less
  // localhost role so a leaked repo never ships a real password.
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl && process.env.NODE_ENV === 'production') {
    throw new Error('[db] DATABASE_URL must be set in production')
  }
  await server.register(require('@fastify/postgres'), {
    connectionString: databaseUrl || 'postgresql://postgres:postgres@localhost:5432/vungu_master_db_v1',
    // node-pg defaults to max 10 connections. A cold map load fires dozens
    // of concurrent ST_AsMVT tile queries across the 24 basemap layers,
    // which saturated the pool and queued interactive queries (single-
    // feature popups, auth) past the client's 30 s timeout. 30 connections
    // lets tile bursts and interactive traffic coexist; Postgres'
    // max_connections=100 still has headroom for the survey pool (20).
    max: 30,
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

  // Multipart form support — required by the inspection-photo upload route
  // and the Survey Task Manager document/plan uploads (scanned survey plan
  // PDFs run large, hence the 50 MB cap; files:1 was dropped for the same
  // reason — survey CSV/document endpoints accept multiple parts).
  const path = require('node:path')
  await server.register(require('@fastify/multipart'), {
    limits: { fileSize: 50 * 1024 * 1024 },
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

  // ── HTTP caching (Cache-Control headers + server-side LRU) ──────────
  const { httpCachePlugin } = require('./src/middleware/httpCache')
  await server.register(httpCachePlugin)

  // ── Audit logging (onResponse hook — never delays requests) ─────────
  // Writes every authenticated mutating request to security_audit_log.
  // Required for Zimbabwe municipal compliance (RTCP Act traceability).
  const { auditLogPlugin } = require('./src/middleware/auditLog')
  await server.register(auditLogPlugin)

  // ── OpenAPI / Swagger (H4) ──────────────────────────────────────────
  // @fastify/swagger was installed but never registered, so no API docs
  // were served. Registered here — before the route plugins — so it can
  // collect every route's schema into the generated spec. The interactive
  // UI is gated: a government deployment should not publish its full API
  // surface anonymously, so /api/docs is served only outside production
  // unless ENABLE_API_DOCS=true is set explicitly.
  await server.register(require('@fastify/swagger'), {
    openapi: {
      info: {
        title: 'Vungu RDC Planning Portal API',
        description: 'Municipal GIS planning platform — development control, GIS tiles, survey, and citizen services.',
        version: '2.0.0',
      },
      components: {
        securitySchemes: {
          // Browser clients authenticate with the httpOnly vungu_at cookie;
          // the QGIS plugin / integrations use a Bearer API token.
          cookieAuth: { type: 'apiKey', in: 'cookie', name: 'vungu_at' },
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  })
  if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_API_DOCS === 'true') {
    await server.register(require('@fastify/swagger-ui'), {
      routePrefix: '/api/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
    })
    server.log.info('API docs served at /api/docs')
  }

  // Health check - register first
  server.get('/health', async (request, reply) => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'spartialiq-backend',
      version: '2.0.0'
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
    await server.register(zonesRoutes,             { prefix: '/api' })
    await server.register(planningAssistantRoutes, { prefix: '/api' })
    await server.register(planningSuggestRoutes,   { prefix: '/api' })
    await server.register(plannerRoutes,           { prefix: '/api' })
    console.log('✅ Stands + Zones + Planning Assistant + Planner routes registered')
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
    await server.register(siteContentRoutes, { prefix: '/api' })
    console.log('✅ Payment + document + site-content routes registered')
  } catch (error) {
    server.log.error({ err: error }, 'Failed to register payment/document routes')
  }

  // Register cross-dept notifications + KYC (migration 075).
  try {
    await server.register(notificationsRoutes, { prefix: '/api' })
    await server.register(kycRoutes,           { prefix: '/api' })
    console.log('✅ Notifications + KYC routes registered')
  } catch (error) {
    server.log.error({ err: error }, 'Failed to register notifications/kyc routes')
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
    await server.register(statutoryPlansRoutes, { prefix: '/api' })
    await server.register(citizenPortalRoutes, { prefix: '/api' })
    await server.register(surveyorRoutes, { prefix: '/api' })
    await server.register(surveyorComputeRoutes, { prefix: '/api' })
    await server.register(controlPointRoutes, { prefix: '/api' })
    await server.register(propertyRoutes, { prefix: '/api' })
    await server.register(gisRoutes, { prefix: '/api' })
    await server.register(planningRoutes, { prefix: '/api' })
    console.log('✅ Vector tile + property register + GIS editing + planning routes registered')
  } catch (error) {
    server.log.error({ err: error }, 'Failed to register tile routes')
  }

  // Survey Task Manager (merged SurveySuite) — ESM plugin, mounted under
  // /api/survey so its route names never collide with vungu's /api/* set.
  try {
    const { default: surveyPlugin } = await import('./src/survey/plugin.js')
    await server.register(surveyPlugin, { prefix: '/api/survey' })
    console.log('✅ Survey Task Manager routes registered under /api/survey')
  } catch (error) {
    server.log.error({ err: error }, 'Failed to register Survey Task Manager routes')
    console.error('❌ Failed to register Survey Task Manager routes:', error.message)
  }

  // Register OGC Services Routes (WMS/WFS/WMTS)
  try {
    await server.register(ogcServicesRoutes, { prefix: '/api' })
    console.log('✅ OGC Services routes registered')
  } catch (error) {
    console.error('❌ Failed to register OGC Services routes:', error.message)
  }

  // Register QGIS Desktop plugin sync API under /api/qgis.
  try {
    await server.register(async (s) => { await createQGISRoutes(s) }, { prefix: '/api/qgis' })
    console.log('✅ QGIS plugin sync routes registered')
  } catch (error) {
    console.error('❌ Failed to register QGIS plugin sync routes:', error.message)
  }

  // Register Development Control Routes
  if (developmentControlRoutes) {
    await server.register(developmentControlRoutes, { prefix: '/api/development-control' })
    console.log('✅ Development Control routes registered')
  }

  // Register Enhanced Land Use Management Routes
  // The plugin function signature is: (fastify, { auth }) so we must pass the
  // auth helpers in the options object, not just the prefix.
  if (enhancedLandUseManagementRoutes) {
    try {
      const { requireAuth, requireRole } = require('./src/middleware/jwtAuth')
      await server.register(enhancedLandUseManagementRoutes, {
        prefix: '/api/land-use',
        auth: { requireAuth, requireRole },
      })
      console.log('✅ Enhanced Land Use Management routes registered')
    } catch (error) {
      console.error('❌ Failed to register Enhanced Land Use Management routes:', error.message)
    }
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

  // Global error handler. 4xx (validation / client) errors keep their
  // message; 5xx errors return a generic message so DB/driver internals and
  // stack traces are never leaked to the client (audit fix F10). Full detail
  // is logged server-side.
  server.setErrorHandler(async (error, request, reply) => {
    server.log.error({ err: error }, 'Unhandled error')

    const statusCode = error.statusCode || 500
    const isClientError = statusCode >= 400 && statusCode < 500
    reply.status(statusCode).send({
      error: isClientError ? (error.name || 'Error') : 'Internal Server Error',
      message: isClientError ? (error.message || 'Request error') : 'An unexpected error occurred',
      timestamp: new Date().toISOString(),
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
