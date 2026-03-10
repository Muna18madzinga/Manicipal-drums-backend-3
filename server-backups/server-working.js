const Fastify = require('fastify')
const { fastifyCors } = require('@fastify/cors')
const { fastifySwagger } = require('@fastify/swagger')
const { fastifySwaggerUi } = require('@fastify/swagger-ui')
const { fastifyCompress } = require('@fastify/compress')
const { fastifyRateLimit } = require('@fastify/rate-limit')
const { fastifyPostgres } = require('@fastify/postgres')

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

  // Health check
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
      const { email, password } = request.body
      
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
