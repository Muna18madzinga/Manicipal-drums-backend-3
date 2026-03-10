const Fastify = require('fastify')

async function start() {
  const server = Fastify({
    logger: true
  })
  
  // Test route
  server.get('/test', async (request, reply) => {
    return { message: 'Minimal server working!', timestamp: new Date().toISOString() }
  })
  
  // Another test route
  server.get('/api/auth/test', async (request, reply) => {
    return { message: 'Auth test working!', timestamp: new Date().toISOString() }
  })
  
  try {
    await server.listen({ port: 3002, host: '0.0.0.0' })
    console.log('Minimal server running on http://localhost:3002')
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

start()
