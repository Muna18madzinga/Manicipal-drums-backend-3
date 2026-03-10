import Fastify from 'fastify'

async function start() {
  const server = Fastify({
    logger: true
  })

  // Health check
  server.get('/health', async (request, reply) => {
    return { status: 'ok', timestamp: new Date().toISOString() }
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

  // Login endpoint
  server.post('/api/auth/login', async (request, reply) => {
    console.log('🔐 Login endpoint called')
    try {
      const { email, password } = request.body as any
      
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

  try {
    const port = parseInt(process.env.PORT || '3001')
    console.log('🚀 About to listen on port:', port)
    await server.listen({ port, host: '0.0.0.0' })
    console.log(` Server running on http://localhost:${port}`)
  } catch (err) {
    console.error('Failed to start server:', err)
    process.exit(1)
  }
}

start()
