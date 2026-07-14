const { topology } = require('topojson-server')
const { QmlParserService } = require('../services/admin/qmlParserService')
const { SmartQGISExtractor } = require('../services/admin/smartQGISExtractor')
const { UltimateQGISBridge } = require('../services/admin/ultimateQGISBridge')

// Module-level singletons so extraction cache persists across requests
const ultimateBridge = new UltimateQGISBridge({
  baseUrl: process.env.QGIS_SERVER_URL || 'http://localhost:8080',
  version: process.env.QGIS_SERVER_VERSION || '1.3.0',
  project: process.env.QGIS_PROJECT || '/etc/qgisserver/vungu-docker-minimal-fixed.qgs',
  timeout: parseInt(process.env.QGIS_SERVER_TIMEOUT) || 5000,
  maxRetries: parseInt(process.env.QGIS_SERVER_MAX_RETRIES) || 1
})
const smartExtractor = new SmartQGISExtractor()

// Live QGIS symbology extraction is an OPTIONAL enhancement that needs an
// external QGIS Server plus a .qgs project and python bridge scripts. When
// that infrastructure is absent the extractors cascade through 5 strategies
// with retries per layer, storming the logs on every /layers request. So it
// is OFF unless QGIS_STYLE_EXTRACTION=true, and even when on it is skipped
// after a failed liveness probe. Layers always fall back to their stored
// style_config / default style, so the map is unaffected.
const QGIS_EXTRACTION_ENABLED = process.env.QGIS_STYLE_EXTRACTION === 'true'
const QGIS_PROBE_TTL_MS = 60_000
let qgisProbe = { ok: false, at: 0 }

async function qgisAvailable() {
  if (!QGIS_EXTRACTION_ENABLED) return false
  const now = Date.now()
  if (now - qgisProbe.at < QGIS_PROBE_TTL_MS) return qgisProbe.ok
  qgisProbe.at = now
  const base = process.env.QGIS_SERVER_URL || 'http://localhost:8080'
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 1500)
    const res = await fetch(base, { signal: ctrl.signal })
    clearTimeout(timer)
    qgisProbe.ok = res.status < 500
  } catch {
    qgisProbe.ok = false
  }
  if (!qgisProbe.ok) {
    console.log('[Layers] QGIS style extraction enabled but server unreachable — using stored styles')
  }
  return qgisProbe.ok
}

async function getTableSchema(fastify, tableName) {
  const query = `
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns 
    WHERE table_name = $1 AND table_schema = 'public'
    ORDER BY ordinal_position
  `
  const result = await fastify.pg.query(query, [tableName])
  return result.rows
}

async function getPrimaryKeyColumn(fastify, tableName) {
  const query = `
    SELECT a.attname 
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = $1::regclass AND i.indisprimary
  `
  const result = await fastify.pg.query(query, [tableName])
  return result.rows.length > 0 ? result.rows[0].attname : null
}

async function getGeometryColumn(fastify, tableName) {
  const query = `
    SELECT f_geometry_column 
    FROM geometry_columns 
    WHERE f_table_name = $1 AND f_table_schema = 'public'
  `
  const result = await fastify.pg.query(query, [tableName])
  return result.rows.length > 0 ? result.rows[0].f_geometry_column : 'geom'
}

async function getAttributeColumns(fastify, tableName, idColumn, geometryColumn) {
  const schema = await getTableSchema(fastify, tableName)
  
  // Filter out system columns and geometry
  const attributeColumns = schema
    .filter(col => 
      col.column_name !== idColumn && 
      col.column_name !== geometryColumn &&
      !col.column_name.startsWith('geom_') &&
      !col.column_name.endsWith('_geom') &&
      col.data_type !== 'geometry' &&
      col.data_type !== 'geography'
    )
    .map(col => col.column_name)
  
  // If no attributes found, return basic columns
  if (attributeColumns.length === 0) {
    return ['name', 'description']
  }
  
  return attributeColumns
}

async function dynamicLayerRoutes(fastify) {

  // Get available layers
  fastify.get('/layers', async (request, reply) => {
    try {
      const query = `
        SELECT sl.table_name, sl.display_name, sl.geometry_type, sl.description, sl.style_config
        FROM spatial_layers sl
        INNER JOIN information_schema.tables ist
          ON ist.table_schema = 'public' AND ist.table_name = sl.table_name
        WHERE sl.is_visible = true
        ORDER BY sl.display_name
      `
      
      const { rows } = await fastify.pg.query(query)

      // Probe once per request (cached ~60s). When QGIS integration is off or
      // unreachable, skip extraction entirely — no per-layer retry storm.
      const useQgis = await qgisAvailable()

      // Check for QGIS Server layers and merge with ultimate extraction
      const layersWithStyles = await Promise.all(rows.map(async (layer) => {
        let finalStyle = layer.style_config || getDefaultStyle(layer.geometry_type)

        if (!useQgis) {
          return {
            id: layer.table_name,
            name: layer.display_name,
            type: layer.geometry_type,
            description: layer.description,
            style: finalStyle
          }
        }

        // Try Ultimate QGIS Bridge extraction first (production-grade)
        try {
          console.log(`[Layers] 🚀 Trying Ultimate QGIS Bridge for ${layer.display_name}`)
          const ultimateStyle = await ultimateBridge.extractStyle(layer.table_name, {
            includeSVG: true,
            includeLabels: true,
            cache: true
          })
          
          if (ultimateStyle && ultimateStyle.symbols && ultimateStyle.symbols.length > 0) {
            console.log(`[Layers] 🎯 Ultimate extraction successful for ${layer.display_name}`)
            console.log(`[Layers] 📊 Extracted ${ultimateStyle.symbols.length} symbols, SVG: ${ultimateStyle.metadata.hasSVG}`)
            console.log(`[Layers] 🌐 Source: ${ultimateStyle.metadata.source}`)
            
            // Merge ultimate style with existing config
            finalStyle = {
              ...finalStyle,
              ...ultimateStyle,
              _ultimateExtraction: true,
              _extractionTime: ultimateStyle.extractionTime,
              _extractionSource: ultimateStyle.metadata.source,
              _serverBased: ultimateStyle.metadata.serverBased
            }
          }
        } catch (error) {
          console.log(`[Layers] ⚠️ Ultimate extraction failed for ${layer.display_name}: ${error.message}`)
          
          // Fallback to Smart Extractor
          try {
            const smartStyle = await smartExtractor.extractStyle(layer.table_name, {
              includeSVG: true,
              includeLabels: true,
              cache: true
            })
            
            if (smartStyle && smartStyle.symbols && smartStyle.symbols.length > 0) {
              console.log(`[Layers] 🔄 Smart extraction fallback successful for ${layer.display_name}`)
              console.log(`[Layers] 📊 Extracted ${smartStyle.symbols.length} symbols, SVG: ${smartStyle.metadata.hasSVG}`)
              
              finalStyle = {
                ...finalStyle,
                ...smartStyle,
                _smartExtraction: true,
                _extractionTime: smartStyle.extractionTime,
                _extractionSource: smartStyle.metadata.source
              }
            }
          } catch (smartError) {
            console.log(`[Layers] ⚠️ Smart extraction also failed for ${layer.display_name}: ${smartError.message}`)
            // Use existing style config
          }
        }
        
        return {
          id: layer.table_name,
          name: layer.display_name,
          type: layer.geometry_type,
          description: layer.description,
          style: finalStyle
        }
      }))
      
      return {
        success: true,
        data: layersWithStyles
      }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Failed to load layers', details: error.message })
    }
  })

  // Get layer data as TopoJSON
  fastify.get('/layer/:tableName', {
    schema: {
      params: {
        type: 'object',
        properties: {
          tableName: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          bbox: { type: 'string' },
          limit: { type: 'number', default: 1000 },
          where: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { tableName } = request.params
      const { bbox, limit = 1000, where } = request.query
      
      // Validate table name to prevent SQL injection
      const validTables = await getValidTables(fastify)
      if (!validTables.includes(tableName)) {
        return reply.code(404).send({ error: 'Layer not found' })
      }
      
      // Build query with optional filters
      // Smart schema detection
      const idColumn = await getPrimaryKeyColumn(fastify, tableName)
      const geometryColumn = await getGeometryColumn(fastify, tableName)
      const attributeColumns = await getAttributeColumns(fastify, tableName, idColumn, geometryColumn)
      
      if (!idColumn) {
        return reply.code(500).send({ 
          error: 'Unable to determine primary key column', 
          details: `Table ${tableName} has no primary key` 
        })
      }
      
      // Filter out NULL and invalid geometries. Some legacy tables
      // (e.g. gweru_rivers) contain self-intersecting or otherwise broken
      // geometries that serialise to [NaN, NaN] and break JSON.parse below.
      // ST_MakeValid attempts to repair them; rows that can't be repaired
      // still slip through, so we also try/catch the JSON.parse per-row.
      let query = `
        SELECT
          ${idColumn},
          ${attributeColumns.join(', ')},
          ST_AsGeoJSON(ST_Transform(ST_MakeValid(${geometryColumn}), 4326)) as geometry
        FROM ${tableName}
        WHERE ${geometryColumn} IS NOT NULL
          AND NOT ST_IsEmpty(${geometryColumn})
      `

      const params = []

      if (where) {
        query += ` AND ${where}`
      }

      if (bbox) {
        const [minX, minY, maxX, maxY] = bbox.split(',').map(Number)
        query += ` AND ST_Intersects(${geometryColumn}, ST_MakeEnvelope($1, $2, $3, $4, 4326))`
        params.push(minX, minY, maxX, maxY)
      }

      query += ` LIMIT $${params.length + 1}`
      params.push(limit)

      const { rows } = await fastify.pg.query(query, params)

      // Per-row parse: skip any rows where the JSON has NaN/Infinity (PostGIS
      // can emit those for unsalvageable geometries) rather than failing
      // the whole request.
      let skipped = 0
      const features = []
      for (const row of rows) {
        try {
          if (!row.geometry || row.geometry.includes('NaN') || row.geometry.includes('Infinity')) {
            skipped++
            continue
          }
          features.push({
            type: 'Feature',
            geometry: JSON.parse(row.geometry),
            properties: getFeatureProperties(row, tableName, idColumn),
          })
        } catch (parseErr) {
          skipped++
        }
      }
      if (skipped > 0) {
        fastify.log.warn({ tableName, skipped, kept: features.length }, 'dynamic-layers: dropped rows with invalid geometry')
      }
      
      // Convert to TopoJSON for compression
      const geojson = {
        type: 'FeatureCollection',
        features: features
      }
      
      const topojsonResult = topology({ collection: geojson })
      
      // Ensure the TopoJSON has the structure the frontend expects
      const result = {
        type: 'Topology',
        objects: {
          collection: {
            type: 'FeatureCollection',
            features: features
          }
        },
        arcs: topojsonResult.arcs,
        transform: topojsonResult.transform
      }
      
      return result
      
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ error: 'Failed to load layer data', details: error.message })
    }
  })

  // Upload QML style to layer
  fastify.post('/layers/:layerName/qml-style', async (request, reply) => {
    try {
      const { layerName } = request.params
      const { qml_content } = request.body
      
      if (!qml_content) {
        return reply.code(400).send({ error: 'QML content is required' })
      }
      
      // Initialize QML parser service
      const qmlParserService = new QmlParserService(fastify.pg)
      
      // Parse QML content with layer name for QGIS plugin extraction
      const parsedConfig = await qmlParserService.parseQmlContent(qml_content, layerName)
      
      // Find the layer in spatial_layers
      const layerQuery = `
        SELECT table_name, display_name 
        FROM spatial_layers 
        WHERE table_name = $1 OR display_name = $1
      `
      const layerResult = await fastify.pg.query(layerQuery, [layerName])
      
      if (layerResult.rows.length === 0) {
        return reply.code(404).send({ error: 'Layer not found' })
      }
      
      const layer = layerResult.rows[0]
      
      // Update or create layer in layers table with QML style
      const { rows } = await fastify.pg.query(`
        INSERT INTO layers (id, name, description, type, style, published)
        VALUES ($1, $2, $3, $4, $5, true)
        ON CONFLICT (id) DO UPDATE SET
          style = EXCLUDED.style,
          updated_at = NOW()
        RETURNING *
      `, [layer.table_name, layer.display_name, 'Layer with QML style', 'unknown', JSON.stringify({
        ...parsedConfig,
        _rendererType: parsedConfig.rendererType,
        _categories: parsedConfig.symbols?.map(s => ({
          value: s.value,
          label: s.label,
          style: s
        })) || []
      })])
      
      // Also update spatial_layers style_config
      await fastify.pg.query(`
        UPDATE spatial_layers 
        SET style_config = $1
        WHERE table_name = $2
      `, [JSON.stringify({
        ...parsedConfig,
        _rendererType: parsedConfig.rendererType,
        _categories: parsedConfig.symbols?.map(s => ({
          value: s.value,
          label: s.label,
          style: s
        })) || []
      }), layer.table_name])
      
      return {
        success: true,
        layer: rows[0],
        parsedStyle: parsedConfig,
        message: `QML style applied to layer ${layer.display_name}`
      }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ 
        error: 'Failed to process QML style',
        details: error.message 
      })
    }
  })

  // Helper functions
  async function getValidTables(fastify) {
    const query = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN (
        SELECT table_name FROM spatial_layers WHERE is_visible = true
      )
      ORDER BY table_name
    `
    
    const { rows } = await fastify.pg.query(query)
    return rows.map(row => row.table_name)
  }

  function getFeatureProperties(row, tableName, idColumn) {
    const { geometry, ...properties } = row
    
    // Extract the ID based on the primary key column
    const id = properties[idColumn] || properties.gid || properties.id
    delete properties[idColumn]
    delete properties.gid
    delete properties.id
    
    // Add common properties
    return {
      id: id,
      ...properties,
      layer_type: tableName
    }
  }

  function getDefaultStyle(geometryType) {
    const styles = {
      point: { color: '#FF6B6B', radius: 6 },
      line: { color: '#4ECDC4', strokeWidth: 2 },
      polygon: { color: '#45B7D1', fillOpacity: 0.3 }
    }
    return styles[geometryType] || styles.point
  }
}

module.exports = dynamicLayerRoutes
