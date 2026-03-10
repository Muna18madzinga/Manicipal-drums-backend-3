import { FastifyInstance } from 'fastify'

export function authRoutes(fastify: FastifyInstance) {
  console.log('🔐 Auth routes registering...')
  
  // Test endpoint
  fastify.get('/test', async (request, reply) => {
    return { message: 'Auth routes working', timestamp: new Date().toISOString() }
  })
  
  // Simple login endpoint without JWT for testing
  fastify.post('/login', async (request, reply) => {
    console.log('🔐 Login endpoint called')
    return { message: 'Login endpoint working' }
  })
}
