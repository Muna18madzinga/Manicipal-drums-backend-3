// Admin routes for the unified backend
async function adminRoutes(fastify) {
  // Get all projects
  fastify.get('/projects', async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(`
        SELECT 
          id,
          name,
          description,
          status,
          created_at,
          updated_at,
          created_by,
          surveyor_id
        FROM survey_projects
        ORDER BY updated_at DESC
      `)
      
      return rows
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch projects' })
    }
  })

  // Get project details
  fastify.get('/projects/:id', async (request, reply) => {
    try {
      const { id } = request.params
      
      const { rows } = await fastify.pg.query(`
        SELECT 
          p.*,
          u.name as surveyor_name,
          u.email as surveyor_email
        FROM survey_projects p
        LEFT JOIN users u ON p.surveyor_id = u.id
        WHERE p.id = $1
      `, [id])
      
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Project not found' })
      }
      
      return rows[0]
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch project details' })
    }
  })

  // Create project
  fastify.post('/projects', async (request, reply) => {
    try {
      const { name, description, surveyor_id } = request.body
      
      const { rows } = await fastify.pg.query(`
        INSERT INTO survey_projects (name, description, surveyor_id, status, created_at, updated_at)
        VALUES ($1, $2, $3, 'active', NOW(), NOW())
        RETURNING *
      `, [name, description, surveyor_id])
      
      return { success: true, project: rows[0] }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Failed to create project' })
    }
  })

  // Get land parcels for project
  fastify.get('/projects/:id/parcels', async (request, reply) => {
    try {
      const { id } = request.params
      
      const { rows } = await fastify.pg.query(`
        SELECT 
          id,
          stand,
          description,
          area_m2,
          ST_AsGeoJSON(geom) as geometry,
          created_at,
          updated_at
        FROM land_parcels
        WHERE project_id = $1
        ORDER BY stand
      `, [id])
      
      return rows.map(parcel => ({
        ...parcel,
        geometry: JSON.parse(parcel.geometry)
      }))
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch parcels' })
    }
  })

  // Get users
  fastify.get('/users', async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(`
        SELECT 
          id,
          email,
          name,
          role,
          organization,
          active,
          created_at,
          last_login
        FROM users
        ORDER BY name
      `)
      
      return rows
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch users' })
    }
  })

  // Create user
  fastify.post('/users', async (request, reply) => {
    try {
      const { email, name, role, organization, password } = request.body
      
      // Hash password (simple for now, will add bcrypt later)
      const passwordHash = password // TODO: Add bcrypt
      
      const { rows } = await fastify.pg.query(`
        INSERT INTO users (email, name, role, organization, password_hash, active, created_at)
        VALUES ($1, $2, $3, $4, $5, true, NOW())
        RETURNING id, email, name, role, organization, active, created_at
      `, [email, name, role, organization, passwordHash])
      
      return { success: true, user: rows[0] }
    } catch (error) {
      fastify.log.error(error)
      if (error.code === '23505') { // Unique violation
        return reply.code(409).send({ error: 'Email already exists' })
      }
      return reply.code(500).send({ error: 'Failed to create user' })
    }
  })

  // Get system statistics
  fastify.get('/stats', async (request, reply) => {
    try {
      const [projects, parcels, users, layers] = await Promise.all([
        fastify.pg.query('SELECT COUNT(*) as count FROM survey_projects'),
        fastify.pg.query('SELECT COUNT(*) as count FROM land_parcels'),
        fastify.pg.query('SELECT COUNT(*) as count FROM users'),
        fastify.pg.query('SELECT COUNT(*) as count FROM layers')
      ])
      
      return {
        projects: parseInt(projects.rows[0].count),
        parcels: parseInt(parcels.rows[0].count),
        users: parseInt(users.rows[0].count),
        layers: parseInt(layers.rows[0].count),
        lastUpdated: new Date().toISOString()
      }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch statistics' })
    }
  })

  // Data cleaning operations
  fastify.post('/data-cleaning/clean-parcels', async (request, reply) => {
    try {
      const { projectId } = request.body
      
      // Remove duplicate parcels
      const { rows } = await fastify.pg.query(`
        DELETE FROM land_parcels 
        WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY stand, project_id ORDER BY id) as rn
            FROM land_parcels 
            WHERE project_id = $1
          ) t WHERE rn > 1
        )
        RETURNING id, stand
      `, [projectId])
      
      return { 
        success: true, 
        duplicatesRemoved: rows.length,
        removedParcels: rows 
      }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Data cleaning failed' })
    }
  })

  // Batch processing
  fastify.post('/batch/process-projects', async (request, reply) => {
    try {
      const { projectIds, operation } = request.body
      
      let results = []
      
      for (const projectId of projectIds) {
        try {
          if (operation === 'validate') {
            const { rows } = await fastify.pg.query(`
              SELECT COUNT(*) as parcel_count,
                     SUM(area_m2) as total_area
              FROM land_parcels 
              WHERE project_id = $1
            `, [projectId])
            
            results.push({
              projectId,
              success: true,
              parcelCount: parseInt(rows[0].parcel_count),
              totalArea: parseFloat(rows[0].total_area) || 0
            })
          }
        } catch (error) {
          results.push({
            projectId,
            success: false,
            error: error.message
          })
        }
      }
      
      return { success: true, results }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Batch processing failed' })
    }
  })
}

module.exports = { adminRoutes }
