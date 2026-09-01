// Public routes for the unified backend
async function publicRoutes(fastify) {
  // Get available layers (cached)
  fastify.get('/layers', async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(`
        SELECT 
          id,
          name,
          description,
          type,
          ST_AsGeoJSON(ST_Extent(geom)) as bounds,
          visible,
          style
        FROM layers 
        WHERE published = true 
        ORDER BY name
      `)
      
      return rows.map(layer => ({
        ...layer,
        bounds: layer.bounds ? JSON.parse(layer.bounds).coordinates[0] : null
      }))
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch layers' })
    }
  })

  // Get layer data (streaming for performance)
  fastify.get('/layers/:id/data', async (request, reply) => {
    try {
      const { id } = request.params
      const { bbox, limit = 1000 } = request.query
      
      let query = `
        SELECT 
          ST_AsGeoJSON(geom) as geometry,
          properties
        FROM layer_data 
        WHERE layer_id = $1
      `
      const params = [id]
      
      // Add bbox filter if provided
      if (bbox && bbox.length === 4) {
        query += ` AND geom && ST_MakeEnvelope($2, $3, $4, $5, 4326)`
        params.push(...bbox)
      }
      
      query += ` LIMIT $${params.length + 1}`
      params.push(limit)
      
      const { rows } = await fastify.pg.query(query, params)
      
      return {
        type: 'FeatureCollection',
        features: rows.map(row => ({
          type: 'Feature',
          geometry: JSON.parse(row.geometry),
          properties: row.properties || {}
        }))
      }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch layer data' })
    }
  })

  // Search places (geocoding)
  fastify.get('/search', async (request, reply) => {
    try {
      const { q, limit = 10 } = request.query
      
      const { rows } = await fastify.pg.query(`
        SELECT 
          id,
          name,
          type,
          ST_AsGeoJSON(ST_Centroid(geom)) as center,
          relevance
        FROM places 
        WHERE name ILIKE $1 
        ORDER BY relevance DESC, name
        LIMIT $2
      `, [`%${q}%`, limit])
      
      return rows.map(place => ({
        ...place,
        center: JSON.parse(place.center).coordinates
      }))
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Search failed' })
    }
  })

  // Get statistics
  fastify.get('/stats', async (request, reply) => {
    try {
      const [layers, places, users] = await Promise.all([
        fastify.pg.query('SELECT COUNT(*) as count FROM layers WHERE published = true'),
        fastify.pg.query('SELECT COUNT(*) as count FROM places'),
        fastify.pg.query('SELECT COUNT(*) as count FROM users WHERE active = true')
      ])
      
      return {
        layers: parseInt(layers.rows[0].count),
        places: parseInt(places.rows[0].count),
        users: parseInt(users.rows[0].count),
        lastUpdated: new Date().toISOString()
      }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch statistics' })
    }
  })

  // Portal analytics for the public landing page (HomeView getStats).
  // Each metric is independently guarded so a table missing in a given
  // environment degrades to 0 rather than 404/500 — the frontend then
  // shows "—" ("we never invent numbers"). Returned in the { data } envelope
  // the frontend unwraps.
  fastify.get('/admin/analytics', async (_request, reply) => {
    const count = async (sql) => {
      try {
        const { rows } = await fastify.pg.query(sql)
        return parseInt(rows[0].count, 10) || 0
      } catch {
        return 0
      }
    }
    const [layers, places, users] = await Promise.all([
      count("SELECT COUNT(*) AS count FROM layers WHERE published = true"),
      count("SELECT COUNT(*) AS count FROM places"),
      count("SELECT COUNT(*) AS count FROM users WHERE active = true"),
    ])
    return { data: { layers, places, downloads: 0, users } }
  })
}

module.exports = { publicRoutes }
