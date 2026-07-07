import db from '../config/db.js'

export default async function projectMeridianCacheRoutes(fastify, options) {
  // Get cached selections for a project (all meridians)
  fastify.get('/projects/:projectId/meridian-cache', async (request, reply) => {
    try {
      const { projectId } = request.params
      
      const result = await db.query(
        `SELECT meridian, control_point_ids, updated_at
         FROM project_meridian_cache
         WHERE project_id = $1
         ORDER BY meridian`,
        [projectId]
      )
      
      // Convert to object format: { 27: [ids], 29: [ids], 31: [ids], 33: [ids] }
      const cache = {
        27: [],
        29: [],
        31: [],
        33: []
      }
      
      result.rows.forEach(row => {
        cache[row.meridian] = row.control_point_ids || []
      })
      
      return { ok: true, cache }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ ok: false, error: 'Failed to fetch meridian cache' })
    }
  })

  // Save/update cached selections for a specific meridian
  fastify.post('/projects/:projectId/meridian-cache', async (request, reply) => {
    try {
      const { projectId } = request.params
      const { meridian, controlPointIds } = request.body
      
      if (!meridian || ![27, 29, 31, 33].includes(meridian)) {
        return reply.code(400).send({ 
          ok: false, 
          error: 'Invalid meridian. Must be 27, 29, 31, or 33' 
        })
      }
      
      if (!Array.isArray(controlPointIds)) {
        return reply.code(400).send({ 
          ok: false, 
          error: 'controlPointIds must be an array' 
        })
      }
      
      // Check if project exists first
      const projectCheck = await db.query(
        'SELECT id FROM survey_projects WHERE id = $1',
        [projectId]
      )
      
      if (projectCheck.rows.length === 0) {
        fastify.log.warn(`[meridian-cache] Project ${projectId} not found`)
        return reply.code(404).send({ 
          ok: false, 
          error: `Project ${projectId} not found. It may have been deleted.` 
        })
      }
      
      // Upsert the cache entry
      await db.query(
        `INSERT INTO project_meridian_cache (project_id, meridian, control_point_ids, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (project_id, meridian)
         DO UPDATE SET 
           control_point_ids = EXCLUDED.control_point_ids,
           updated_at = CURRENT_TIMESTAMP`,
        [projectId, meridian, controlPointIds]
      )
      
      fastify.log.info(`Cached ${controlPointIds.length} control points for project ${projectId}, Lo${meridian}`)
      
      return { ok: true, message: 'Cache updated successfully' }
    } catch (error) {
      fastify.log.error(error)
      
      // Handle foreign key constraint violation
      if (error.code === '23503') {
        return reply.code(404).send({ 
          ok: false, 
          error: `Project ${request.params.projectId} not found. It may have been deleted.` 
        })
      }
      
      return reply.code(500).send({ ok: false, error: 'Failed to update meridian cache' })
    }
  })

  // Clear cache for a specific meridian
  fastify.delete('/projects/:projectId/meridian-cache/:meridian', async (request, reply) => {
    try {
      const { projectId, meridian } = request.params
      
      await db.query(
        'DELETE FROM project_meridian_cache WHERE project_id = $1 AND meridian = $2',
        [projectId, parseInt(meridian)]
      )
      
      return { ok: true, message: 'Cache cleared successfully' }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ ok: false, error: 'Failed to clear meridian cache' })
    }
  })

  // Clear all cached meridians for a project
  fastify.delete('/projects/:projectId/meridian-cache', async (request, reply) => {
    try {
      const { projectId } = request.params
      
      await db.query(
        'DELETE FROM project_meridian_cache WHERE project_id = $1',
        [projectId]
      )
      
      return { ok: true, message: 'All cache cleared successfully' }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ ok: false, error: 'Failed to clear cache' })
    }
  })
}
