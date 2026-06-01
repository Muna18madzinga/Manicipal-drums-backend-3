require('dotenv').config()
const Fastify = require('fastify')
const fastifyPostgres = require('@fastify/postgres')
const { paymentRoutes } = require('../../src/routes/payments')
const { authRoutes } = require('../../src/routes/auth')
const { developmentManagementRoutes } = require('../../src/routes/development-management')

async function buildAppForTest() {
  const app = Fastify({ logger: false })
  await app.register(fastifyPostgres, { connectionString: process.env.DATABASE_URL })
  await app.register(async (scope) => {
    await authRoutes(scope)
    await paymentRoutes(scope)
    await developmentManagementRoutes(scope)
  }, { prefix: '/api' })
  await app.ready()
  return app
}
module.exports = { buildAppForTest }
