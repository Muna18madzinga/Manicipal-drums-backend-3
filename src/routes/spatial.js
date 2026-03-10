// Spatial routes for the unified backend
async function spatialRoutes(fastify) {
  // Spatial query - find features within bounds
  fastify.post('/query', async (request, reply) => {
    try {
      const { bbox, layerIds, geometryType = 'all', limit = 1000 } = request.body
      
      let query = `
        SELECT 
          layer_id,
          ST_AsGeoJSON(geom) as geometry,
          properties
        FROM layer_data 
        WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      `
      const params = [...bbox]
      
      // Filter by layer IDs if specified
      if (layerIds && layerIds.length > 0) {
        query += ` AND layer_id = ANY($${params.length + 1})`
        params.push(layerIds)
      }
      
      // Filter by geometry type if specified
      if (geometryType !== 'all') {
        const typeCondition = geometryType === 'point' ? 'ST_GeometryType(geom) = \'ST_Point\'' :
                            geometryType === 'line' ? 'ST_GeometryType(geom) IN (\'ST_LineString\', \'ST_MultiLineString\')' :
                            'ST_GeometryType(geom) IN (\'ST_Polygon\', \'ST_MultiPolygon\')'
        query += ` AND ${typeCondition}`
      }
      
      query += ` LIMIT $${params.length + 1}`
      params.push(limit)
      
      const { rows } = await fastify.pg.query(query, params)
      
      return {
        success: true,
        data: rows.map(row => ({
          layer_id: row.layer_id,
          geometry: JSON.parse(row.geometry),
          properties: row.properties || {}
        }))
      }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ 
        success: false, 
        error: 'Spatial query failed' 
      })
    }
  })

  // Get layer metadata
  fastify.get('/layers/:id/metadata', async (request, reply) => {
    try {
      const { id } = request.params
      
      const { rows } = await fastify.pg.query(`
        SELECT 
          l.id,
          l.name,
          l.description,
          l.type,
          l.style,
          l.published,
          COUNT(ld.id) as feature_count,
          ST_AsGeoJSON(ST_Extent(ld.geom)) as bounds
        FROM layers l
        LEFT JOIN layer_data ld ON l.id = ld.layer_id
        WHERE l.id = $1
        GROUP BY l.id, l.name, l.description, l.type, l.style, l.published
      `, [id])
      
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Layer not found' })
      }
      
      const layer = rows[0]
      return {
        ...layer,
        bounds: layer.bounds ? JSON.parse(layer.bounds).coordinates[0] : null,
        feature_count: parseInt(layer.feature_count)
      }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch layer metadata' })
    }
  })

  // Create/update layer
  fastify.post('/layers', async (request, reply) => {
    try {
      const { id, name, description, type, style, published = false } = request.body
      
      const { rows } = await fastify.pg.query(`
        INSERT INTO layers (id, name, description, type, style, published)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          type = EXCLUDED.type,
          style = EXCLUDED.style,
          published = EXCLUDED.published
        RETURNING *
      `, [id, name, description, type, JSON.stringify(style), published])
      
      return { success: true, layer: rows[0] }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Failed to save layer' })
    }
  })

  // Add features to layer
  fastify.post('/layers/:id/features', async (request, reply) => {
    try {
      const { id } = request.params
      const { features } = request.body
      
      if (!features || !Array.isArray(features)) {
        return reply.code(400).send({ error: 'Invalid features data' })
      }
      
      // Start transaction
      const client = await fastify.pg.connect()
      
      try {
        await client.query('BEGIN')
        
        for (const feature of features) {
          await client.query(`
            INSERT INTO layer_data (layer_id, geom, properties)
            VALUES ($1, ST_GeomFromGeoJSON($2), $3)
          `, [id, JSON.stringify(feature.geometry), JSON.stringify(feature.properties)])
        }
        
        await client.query('COMMIT')
        
        return { success: true, added: features.length }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Failed to add features' })
    }
  })

  // Update layer with QML style
  fastify.post('/layers/:id/qml-style', async (request, reply) => {
    try {
      const { id } = request.params
      const { qml_content } = request.body
      
      if (!qml_content) {
        return reply.code(400).send({ error: 'QML content is required' })
      }
      
      // Initialize QML parser service
      const qmlParserService = new QmlParserService(fastify.pg)
      
      // Parse QML content
      const parsedConfig = await qmlParserService.parseQmlContent(qml_content)
      
      // Convert to web-compatible format
      const webStyle = await qmlParserService.convertToWebStyle(id)
      
      // Update layer with parsed style
      const { rows } = await fastify.pg.query(`
        UPDATE layers 
        SET style = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `, [JSON.stringify({
        ...parsedConfig,
        _rendererType: parsedConfig.rendererType,
        _categories: parsedConfig.symbols?.map(s => ({
          value: s.value,
          label: s.label,
          style: s
        })) || [],
        _webStyle: webStyle
      }), id])
      
      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Layer not found' })
      }
      
      return {
        success: true,
        layer: rows[0],
        parsedStyle: parsedConfig
      }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ 
        error: 'Failed to process QML style',
        details: error.message 
      })
    }
  })

  // Get coordinate points for a project
  fastify.get('/coordinate-points', async (request, reply) => {
    try {
      const { project_id } = request.query
      
      const { rows } = await fastify.pg.query(`
        SELECT 
          id,
          name,
          ST_X(geom) as x,
          ST_Y(geom) as y,
          ST_Z(geom) as z,
          description,
          type
        FROM coordinate_points
        WHERE project_id = $1
        ORDER BY name
      `, [project_id])
      
      return rows.map(point => ({
        ...point,
        x: parseFloat(point.x),
        y: parseFloat(point.y),
        z: parseFloat(point.z || 0)
      }))
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch coordinate points' })
    }
  })
}

module.exports = { spatialRoutes }
