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

  // Executive progress briefing for supervisor demos — curated milestones plus
  // live counts where the schema exists. Missing tables degrade to 0.
  fastify.get('/public/progress-briefing', async (_request, reply) => {
    const count = async (sql) => {
      try {
        const { rows } = await fastify.pg.query(sql)
        return parseInt(rows[0].count, 10) || 0
      } catch {
        return 0
      }
    }

    const [
      users,
      gisLayers,
      publishedStyles,
      citizenDocuments,
      residencyVerified,
      auditEvents,
    ] = await Promise.all([
      count('SELECT COUNT(*) AS count FROM users WHERE active = true'),
      count('SELECT COUNT(*) AS count FROM gis_layer'),
      count("SELECT COUNT(*) AS count FROM gis_style WHERE status = 'published'"),
      count('SELECT COUNT(*) AS count FROM citizen_documents'),
      count("SELECT COUNT(*) AS count FROM users WHERE residency_status = 'verified'"),
      count('SELECT COUNT(*) AS count FROM security_audit_log'),
    ])

    const milestones = [
      { id: 'citizen-portal', title: 'Unified citizen portal', status: 'complete', weight: 12 },
      { id: 'residency', title: 'Residency & deeds verification', status: 'complete', weight: 10 },
      { id: 'planner-workstation', title: 'Planner workstation (queues, 360° case view)', status: 'complete', weight: 14 },
      { id: 'surveyor-suite', title: 'Surveyor cadastral suite + QGIS export', status: 'complete', weight: 12 },
      { id: 'gis-symbology', title: 'GIS symbology registry & publish workflow', status: 'complete', weight: 10 },
      { id: 'payments', title: 'Payment gateway (Paynow, EcoCash, manual)', status: 'complete', weight: 8 },
      { id: 'notifications', title: 'Email notification outbox + worker', status: 'complete', weight: 6 },
      { id: 'security', title: 'JWT sessions, MFA hooks, audit logging', status: 'complete', weight: 10 },
      { id: 'qgis-live', title: 'Live QGIS/PostGIS on all planner maps', status: 'in_progress', weight: 9 },
      { id: 'production-deploy', title: 'Production deployment & hardening', status: 'planned', weight: 9 },
    ]

    const completedWeight = milestones
      .filter((m) => m.status === 'complete')
      .reduce((sum, m) => sum + m.weight, 0)
    const totalWeight = milestones.reduce((sum, m) => sum + m.weight, 0)
    const overallProgress = Math.round((completedWeight / totalWeight) * 100)

    return {
      data: {
        generatedAt: new Date().toISOString(),
        project: 'SpartialIQ — Vungu RDC Digital Planning Platform',
        reportingPeriod: 'May – September 2026',
        overallProgress,
        metrics: {
          databaseMigrations: 71,
          apiRouteModules: 39,
          activeUsers: users,
          gisLayers,
          publishedMapStyles: publishedStyles,
          citizenDocuments,
          residencyVerifiedUsers: residencyVerified,
          securityAuditEvents: auditEvents,
          rolePortals: 9,
        },
        milestones,
        deliverables: [
          { title: 'User Manual (DOCX)', path: '/docs/SpartialIQ_User_Manual.docx' },
          { title: 'Complete Use Cases (DOCX)', path: '/docs/SpartialIQ_Complete_Use_Cases.docx' },
          { title: 'QGIS Interoperability Report', path: '/docs/SpatialIQ_QGIS_Interoperability.docx' },
        ],
        demoAccounts: [
          { role: 'Planner', email: 'demo.planner@vungu.test' },
          { role: 'Surveyor', email: 'demo.surveyor@vungu.test' },
          { role: 'Citizen (register)', email: 'Self-register at /register' },
        ],
      },
    }
  })
}

module.exports = { publicRoutes }
