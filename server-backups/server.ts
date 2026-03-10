import Fastify from 'fastify'
import { fastifyCors } from '@fastify/cors'
import { fastifySwagger } from '@fastify/swagger'
import { fastifySwaggerUi } from '@fastify/swagger-ui'
import { fastifyCompress } from '@fastify/compress'
import { fastifyRateLimit } from '@fastify/rate-limit'
import { fastifyPostgres } from '@fastify/postgres'

// Import routes
import { publicRoutes } from './routes/public'
import { authRoutes } from './routes/auth'
import { spatialRoutes } from './routes/spatial'
import { spatialDataRoutes } from './routes/spatial-data'
import dynamicLayerRoutes from './routes/dynamic-layers'

import developmentControlRoutes from './routes/development-control-refactored'
import landUseManagementRoutes from './routes/land-use-management'

// Import admin routes from admin backend
import { createDataCleaningRoutes } from './admin/routes/dataCleaning'
import { createQmlParserRoutes } from './admin/routes/qmlParser'
import { createApprovalWorkflowRoutes } from './admin/routes/approvalWorkflows'
import { createBatchProcessingRoutes } from './admin/routes/batchProcessing'

async function createServer() {
  const server = Fastify({
    logger: true,
    trustProxy: true
  })

  // Register plugins
  await server.register(fastifyCors, {
    origin: process.env.NODE_ENV === 'production' 
      ? ['https://vungu-rdc.org'] 
      : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175', 'http://localhost:3000', 'http://127.0.0.1:58487']
  })

  await server.register(fastifySwagger, {
    swagger: {
      info: {
        title: 'Vungu Master Plan API',
        description: 'Unified backend for Vungu Spatial Data Portal and Administration',
        version: '1.0.0'
      }
    }
  })

  await server.register(fastifySwaggerUi, {
    routePrefix: '/docs'
  })

  await server.register(fastifyCompress)
  
  await server.register(fastifyRateLimit, {
    max: 100,
    timeWindow: '1 minute'
  })

  await server.register(fastifyPostgres, {
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:cairo2025@localhost:5432/vungu_master_db_v1'
  })

  // Health check - register first
  server.get('/health', async (request, reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() }
  })

  // Test route
  server.get('/api/test', async (request, reply) => {
    return { message: 'Main server routes working', timestamp: new Date().toISOString() }
  })

  // Simple test route
  server.get('/simple-test', async (request, reply) => {
    console.log('🔐 Simple test route called!')
    return { message: 'Simple test working', timestamp: new Date().toISOString() }
  })

  // Auth routes
  server.get('/api/auth/test', async (request, reply) => {
    console.log('🔐 Auth test route called!')
    return { message: 'Auth routes working', timestamp: new Date().toISOString() }
  })

  server.post('/api/auth/login', async (request, reply) => {
    console.log('🔐 Login endpoint called')
    try {
      const { email, password } = request.body as any
      
      // For now, return a simple success response
      if (email === 'admin@vungu.gov.zw' && password === 'admin123') {
        return {
          token: 'mock-jwt-token',
          user: {
            id: 'admin-id',
            email: 'admin@vungu.gov.zw',
            name: 'Admin User',
            role: 'admin',
            organization: 'Vungu RDC'
          }
        }
      } else {
        return reply.code(401).send({ error: 'Invalid credentials' })
      }
    } catch (error) {
      console.error('Login error:', error)
      return reply.code(500).send({ error: 'Login failed' })
    }
  })

  console.log('🔐 All routes registered successfully')
  
  // Register Development Control routes
  await server.register(developmentControlRoutes, { prefix: '/api/development-control' })
  console.log('✅ Development Control routes registered')
  
  // Register Land Use Management routes
  await server.register(landUseManagementRoutes, { prefix: '/api/land-use' })
  console.log('✅ Land Use Management routes registered')
  
  // Debug: Check what routes are actually registered
  console.log('🔐 Registered routes:', Object.keys(server).includes('routes'))
  console.log('🔐 Server instance type:', server.constructor.name)
  
  return server
}
async function start() {
  console.log('🚀 Starting server...')
  
  try {
    const server = await createServer()
    const port = parseInt(process.env.PORT || '3000')
    console.log('🚀 About to listen on port:', port)
    await server.listen({ port, host: '0.0.0.0' })
    console.log(` Server running on http://localhost:${port}`)
    console.log(` API Documentation: http://localhost:${port}/docs`)
  } catch (err) {
    console.error('Failed to start server:', err)
    process.exit(1)
  }
}

start()
