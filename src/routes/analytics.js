/**
 * First-party usage analytics — receiving side.
 *
 *   POST /api/analytics/pageview     { path, visitorId?, referrerHost? }   public, 204
 *
 * (The admin's read side, GET /api/admin/usage, lives with the other console endpoints.)
 *
 * PUBLIC, SO DEFENSIVE
 * Anyone can call this, so it accepts only three small fields, each validated hard, ignores
 * everything else in the request, caps the body, and is rate limited per address far below the
 * global limit. It stores no IP address, user, user agent or query string (migration 131).
 *
 * It answers 204 in every case where the request was understood, including when analytics is
 * switched off, the browser says Do Not Track, or the server is merely not storing: the client
 * is fire-and-forget and learns nothing about the server's settings from the response. A request
 * that is malformed gets a 400 with a short code.
 */
const { systemOf } = require('../lib/dbContext')
const { getSetting } = require('../services/adminSettings')
const { parsePageView, doNotTrack, recordPageView, makePruner } = require('../services/usageAnalytics')

async function analyticsRoutes(fastify) {
  const pg = systemOf(fastify.pg)
  const prune = makePruner(pg, () => getSetting(fastify, 'analytics.retention_days'), fastify.log)

  fastify.post('/analytics/pageview', {
    bodyLimit: 2048,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const v = parsePageView(request.body)
    if (v.error) return reply.code(400).send({ success: false, error: v.error })
    if (doNotTrack(request.headers)) return reply.code(204).send()
    try {
      if ((await getSetting(fastify, 'analytics.enabled')) === false) return reply.code(204).send()
      await recordPageView(pg, v)
      void prune()
      return reply.code(204).send()
    } catch (err) {
      request.log.error({ err }, 'page view not recorded')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

module.exports = { analyticsRoutes }
