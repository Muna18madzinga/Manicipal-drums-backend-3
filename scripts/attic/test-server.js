const Fastify = require('fastify')

async function start() {
  const server = Fastify({
    logger: true
  })
  
  // Test route
  server.get('/test', async (request, reply) => {
    return { message: 'Test server working!', timestamp: new Date().toISOString() }
  })
  
  try {
    await server.listen({ port: 3001, host: '0.0.0.0' })
    console.log('Test server running on http://localhost:3001')
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

start()
