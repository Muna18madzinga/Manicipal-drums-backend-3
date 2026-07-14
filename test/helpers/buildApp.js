require('dotenv').config()
const Fastify = require('fastify')
const fastifyPostgres = require('@fastify/postgres')
const fastifyCookie = require('@fastify/cookie')
const { paymentRoutes } = require('../../src/routes/payments')
const { authRoutes } = require('../../src/routes/auth')
const { developmentManagementRoutes } = require('../../src/routes/development-management')

async function buildAppForTest() {
  const app = Fastify({ logger: false })
  await app.register(fastifyPostgres, { connectionString: process.env.DATABASE_URL })
  await app.register(fastifyCookie, { secret: process.env.COOKIE_SECRET || process.env.JWT_SECRET })

  // Webhook callbacks arrive as application/x-www-form-urlencoded.
  // Fastify has no built-in parser for this content-type, so we add one
  // here. The raw string is also stored as request.rawBody so the Paynow
  // signature verifier can reconstruct field order.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      req.rawBody = body
      try {
        done(null, Object.fromEntries(new URLSearchParams(body)))
      } catch (err) {
        done(err)
      }
    },
  )
  await app.register(async (scope) => {
    await authRoutes(scope)
    await paymentRoutes(scope)
    await developmentManagementRoutes(scope)
  }, { prefix: '/api' })
  await app.ready()
  return app
}
module.exports = { buildAppForTest }
