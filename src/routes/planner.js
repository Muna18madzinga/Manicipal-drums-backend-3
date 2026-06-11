// src/routes/planner.js
// Planner-portal helper routes. Frontend's plannerApi (src/services/api.ts)
// calls these on the planner workspace; until a real persistent
// notifications store exists they return safe empty defaults so the UI
// renders cleanly instead of logging 404s.

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
async function plannerRoutes(fastify) {
  // List notifications for the current planner. Real persistence will land
  // alongside the DM Handbook workflow (Permit Register events drive these);
  // for now return an empty list with a 1-minute cache so the planner
  // workspace stops 404-spamming the console.
  fastify.get('/planner/notifications', async (request, reply) => {
    reply.header('Cache-Control', 'private, max-age=60')
    return { success: true, data: [] }
  })

  // Mark a single notification read. Idempotent no-op until persistence
  // exists; returns 200 so the frontend's optimistic update succeeds.
  fastify.patch('/planner/notifications/:id/read', async (request, reply) => {
    return { success: true, id: request.params.id }
  })
}

module.exports = plannerRoutes
