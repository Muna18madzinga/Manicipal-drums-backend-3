/**
 * Unified OGC Services Routes
 * RESTful API endpoints for WMS, WFS, WMTS, and OGC API access
 */

const { topology } = require('topojson-server')
const { RefinedOGCBridge } = require('../services/admin/refinedOGCBridge')
const { startProjectWatcher, getWatcherStatus } = require('../services/admin/qgisProjectWatcher')

// Generate a simple placeholder image when QGIS Server is not available
function generatePlaceholderImage(width, height, layerName) {
  const sharp = require('sharp')
  
  // Create a simple colored rectangle with text
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f0f0f0"/>
      <rect width="100%" height="100%" fill="none" stroke="#ccc" stroke-width="2"/>
      <text x="50%" y="40%" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" fill="#666">
        ${layerName}
      </text>
      <text x="50%" y="60%" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#999">
        QGIS Server Offline
      </text>
    </svg>
  `
  
  return Buffer.from(svg)
}

// Singleton bridge instance
let ogcBridge = null

function getBridge() {
  if (!ogcBridge) {
    ogcBridge = new RefinedOGCBridge({
      baseUrl: process.env.QGIS_SERVER_URL || 'http://localhost:8080',
      wmsVersion: process.env.WMS_VERSION || '1.3.0',
      wfsVersion: process.env.WFS_VERSION || '2.0.0',
      wmtsVersion: process.env.WMTS_VERSION || '1.0.0',
      project: process.env.QGIS_PROJECT || '/etc/qgisserver/vungu-docker-minimal-fixed.qgs',
      timeout: parseInt(process.env.OGC_TIMEOUT) || 5000,
      maxRetries: parseInt(process.env.OGC_MAX_RETRIES) || 1,
      defaultSRS: process.env.DEFAULT_SRS || 'EPSG:4326',
      maxFeatures: parseInt(process.env.MAX_FEATURES) || 10000,
      dbHost: process.env.PGHOST || process.env.DB_HOST || 'localhost',
      dbPort: parseInt(process.env.PGPORT) || 5432,
      dbName: process.env.PGDATABASE || process.env.DB_NAME || 'vungu_master_db_v1',
      dbUser: process.env.PGUSER || process.env.DB_USER || 'postgres',
      dbPassword: process.env.PGPASSWORD || process.env.DB_PASSWORD || 'cairo2025'
    })
    
    // Start file watcher for automatic style updates
    startProjectWatcher(ogcBridge)
  }
  return ogcBridge
}

/**
 * Calculate bounding box from GeoJSON features
 * @param {Array} features - GeoJSON features
 * @returns {Array} [minX, minY, maxX, maxY]
 */
function calculateBbox(features) {
  if (!features || features.length === 0) return null
  
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  
  for (const feature of features) {
    const coords = extractCoordinates(feature.geometry)
    for (const [x, y] of coords) {
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }
  
  return [minX, minY, maxX, maxY]
}

/**
 * Extract all coordinates from a geometry
 * @param {Object} geometry - GeoJSON geometry
 * @returns {Array} Array of [x, y] coordinates
 */
function extractCoordinates(geometry) {
  if (!geometry) return []
  
  const coords = []
  const type = geometry.type
  
  if (type === 'Point') {
    coords.push(geometry.coordinates)
  } else if (type === 'MultiPoint' || type === 'LineString') {
    coords.push(...geometry.coordinates)
  } else if (type === 'MultiLineString' || type === 'Polygon') {
    for (const ring of geometry.coordinates) {
      coords.push(...ring)
    }
  } else if (type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      for (const ring of polygon) {
        coords.push(...ring)
      }
    }
  }
  
  return coords
}

/**
 * Parse a CQL filter into a PARAMETERIZED SQL fragment.
 *
 * Security: the previous implementation string-built a WHERE clause from raw
 * user input and relied on a character allowlist, which was bypassable
 * (`a=1 OR 1=1`, sub-selects, quote breakouts) — a SQL-injection vector. This
 * version supports a safe subset only: comparisons (`field OP value`) joined by
 * AND/OR. Field names are validated as identifiers and quoted; every value is
 * returned as a BOUND parameter ($n), so no user value ever reaches the SQL
 * string. Anything outside the grammar (parens, IN, sub-selects, functions)
 * returns null and the filter is simply ignored.
 *
 * @param {string} cql        CQL filter string
 * @param {number} startIndex next bind-parameter number ($startIndex …)
 * @returns {{ clause: string, params: any[] } | null}
 */
function parseCQLLiteral(raw) {
  const s = String(raw).trim()
  const m = s.match(/^'((?:[^']|'')*)'$/)        // single-quoted string ('' escapes a quote)
  if (m) return m[1].replace(/''/g, "'")
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s) // plain number
  return undefined
}

function parseCQLFilter(cql, startIndex = 1) {
  if (!cql || typeof cql !== 'string' || cql.length > 1000) return null

  const params = []
  let idx = startIndex

  // Split on top-level AND/OR. Nested parentheses are not supported (return
  // null rather than risk an unsafe parse).
  const tokens = cql.split(/\s+(AND|OR)\s+/i)
  if (tokens.length % 2 === 0) return null // must be: comparison (CONN comparison)*

  const parts = []
  for (let i = 0; i < tokens.length; i += 2) {
    const m = tokens[i].trim().match(
      /^([A-Za-z_][A-Za-z0-9_]*)\s*(=|<>|!=|<=|>=|<|>|LIKE|ILIKE)\s*(.+)$/i,
    )
    if (!m) return null
    const field = m[1]
    const opRaw = m[2].toUpperCase()
    const value = parseCQLLiteral(m[3])
    if (value === undefined) return null
    const op = opRaw === '!=' ? '<>' : opRaw === 'LIKE' ? 'ILIKE' : opRaw
    params.push(value)
    parts.push(`"${field}" ${op} $${idx++}`)

    if (i + 1 < tokens.length) {
      const conn = tokens[i + 1].toUpperCase()
      if (conn !== 'AND' && conn !== 'OR') return null
      parts.push(conn)
    }
  }

  return { clause: parts.join(' '), params }
}

async function ogcServicesRoutes(fastify, options) {
  
  // ============================================================
  // Health & Capabilities
  // ============================================================
  
  /**
   * GET /ogc/health
   * Test connectivity to all OGC services
   */
  fastify.get('/ogc/health', async (request, reply) => {
    try {
      console.log('[OGC Routes] 🔍 Health check requested')
      const bridge = getBridge()
      const connectivity = await bridge.testConnectivity()
      
      return {
        success: true,
        data: {
          status: connectivity.success ? 'healthy' : 'degraded',
          services: connectivity.services,
          server: connectivity.server,
          timestamp: new Date().toISOString()
        }
      }
    } catch (error) {
      console.error('[OGC Routes] ❌ Health check failed:', error.message)
      return reply.status(500).send({
        success: false,
        error: 'Health check failed',
        details: error.message
      })
    }
  })

  // ============================================================
  // Layer Discovery - List layers from QGIS project
  // ============================================================
  
  /**
   * GET /ogc/layers
   * List all available layers from the QGIS project
   */
  fastify.get('/ogc/layers', async (request, reply) => {
    try {
      console.log('[OGC Routes] 📋 Listing layers from QGIS project')
      const { PerfectQGISStyleExtractor } = require('../services/admin/perfectQGISStyleExtractor')
      const extractor = new PerfectQGISStyleExtractor()
      
      // Get project path - use Windows path for local development
      const projectPath = process.platform === 'win32' 
        ? 'c:\\mataranyika\\vungu-master-alpha-qgis-server\\qgis-projects\\vungu-minimal.qgs'
        : '/etc/qgisserver/vungu-minimal.qgs'
      
      const layers = extractor.listProjectLayers(projectPath)
      
      return {
        success: true,
        data: {
          project: 'vungu-docker-minimal.qgs',
          layers,
          count: layers.length
        }
      }
    } catch (error) {
      console.error('[OGC Routes] ❌ Failed to list layers:', error.message)
      return reply.status(500).send({
        success: false,
        error: 'Failed to list layers',
        details: error.message
      })
    }
  })

  // ============================================================
  // WFS - Web Feature Service (Vector Features)
  // ============================================================
  
  /**
   * GET /ogc/wfs/capabilities
   * Get WFS server capabilities
   */
  fastify.get('/ogc/wfs/capabilities', async (request, reply) => {
    try {
      console.log('[OGC Routes] 📋 WFS GetCapabilities requested')
      
      // Try QGIS Server first
      try {
        const bridge = getBridge()
        const result = await bridge.wfsGetCapabilities()
        
        // If QGIS Server returns no layers, fallback to project file
        if (result.layers && result.layers.length === 0) {
          console.log('[OGC Routes] ⚠️ QGIS Server WFS has no layers, using project file fallback')
          
          const { PerfectQGISStyleExtractor } = require('../services/admin/perfectQGISStyleExtractor')
          const extractor = new PerfectQGISStyleExtractor()
          const projectPath = process.platform === 'win32' 
            ? 'c:\\mataranyika\\vungu-master-alpha-qgis-server\\qgis-projects\\vungu-minimal.qgs'
            : '/etc/qgisserver/vungu-minimal.qgs'
          
          const projectLayers = extractor.listProjectLayers(projectPath)
          
          if (projectLayers && projectLayers.length > 0) {
            const wfsLayers = projectLayers.map(layer => ({
              name: layer.name,
              title: layer.title || layer.name,
              abstract: layer.abstract || `Vector layer ${layer.name}`,
              crs: ['EPSG:4326', 'EPSG:3857'],
              bbox: layer.extent || null
            }))
            
            return {
              success: true,
              data: {
                ...result,
                layers: wfsLayers,
                _source: 'project-file-fallback',
                _note: 'WFS layers derived from QGIS project file'
              }
            }
          }
        }
        
        return {
          success: true,
          data: result
        }
      } catch (qgisError) {
        console.log('[OGC Routes] ⚠️ QGIS Server WFS failed, using QGIS project file fallback...')
        
        // Fallback: Read layers directly from QGIS project file
        try {
          const { PerfectQGISStyleExtractor } = require('../services/admin/perfectQGISStyleExtractor')
          const extractor = new PerfectQGISStyleExtractor()
          const projectPath = process.platform === 'win32' 
            ? 'c:\\mataranyika\\vungu-master-alpha-qgis-server\\qgis-projects\\vungu-minimal.qgs'
            : '/etc/qgisserver/vungu-minimal.qgs'
          
          const projectLayers = extractor.listProjectLayers(projectPath)
          
          if (projectLayers && projectLayers.length > 0) {
            const wfsLayers = projectLayers.map(layer => ({
              name: layer.name,
              title: layer.title || layer.name,
              abstract: layer.abstract || `Vector layer ${layer.name}`,
              crs: ['EPSG:4326', 'EPSG:3857'],
              bbox: layer.extent || null,
              geometryType: layer.geometryType || 'Unknown'
            }))
            
            console.log(`[OGC Routes] ✅ WFS fallback: Found ${wfsLayers.length} layers from project file`)
            
            return {
              success: true,
              data: {
                service: 'WFS',
                version: '2.0.0',
                title: 'Vungu GIS (Project File Fallback)',
                layers: wfsLayers,
                _source: 'project-file-fallback',
                _note: 'WFS layers derived from QGIS project file (QGIS Server unavailable)'
              }
            }
          }
        } catch (fallbackError) {
          console.log('[OGC Routes] ❌ Project file fallback also failed:', fallbackError.message)
        }
        
        throw qgisError
      }
    } catch (error) {
      console.error('[OGC Routes] ❌ WFS GetCapabilities failed:', error.message)
      return reply.status(500).send({
        success: false,
        error: 'WFS GetCapabilities failed',
        details: error.message
      })
    }
  })
  
  /**
   * GET /ogc/wfs/features/:layerName
   * Get vector features from WFS as GeoJSON
   */
  fastify.get('/ogc/wfs/features/:layerName', async (request, reply) => {
    try {
      const { layerName } = request.params
      const { 
        bbox, 
        maxFeatures, 
        propertyName, 
        filter, 
        srs,
        sortBy
      } = request.query
      
      console.log(`[OGC Routes] 📦 WFS GetFeature for ${layerName}`)
      
      // Try QGIS Server first
      try {
        const bridge = getBridge()
        const options = {}
        
        if (bbox) options.bbox = bbox.split(',').map(Number)
        if (maxFeatures) options.maxFeatures = parseInt(maxFeatures)
        if (propertyName) options.propertyName = propertyName.split(',')
        if (filter) options.filter = filter
        if (srs) options.srs = srs
        if (sortBy) options.sortBy = sortBy
        
        const result = await bridge.getFeatures(layerName, options)
        
        return {
          success: true,
          data: result
        }
      } catch (qgisError) {
        console.log(`[OGC Routes] ⚠️ QGIS Server WFS failed, trying direct PostgreSQL...`)
        
        // Fallback to direct PostgreSQL query
        const { Pool } = require('pg')
        const pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          host: process.env.DATABASE_URL ? undefined : 'localhost',
          port: process.env.DATABASE_URL ? undefined : 5432,
          database: process.env.DATABASE_URL ? undefined : 'vungu_master_db_v1',
          user: process.env.DATABASE_URL ? undefined : 'postgres',
          password: process.env.DATABASE_URL ? undefined : (process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres')
        })
        
        // Map layer name to table name
        const layerMappings = {
          'gweru_rural_farms': 'gweru_rural_farms',
          'proposed_peri_urban_zones': 'proposed_peri_urban_zones',
          'gweru_rural_planning_boundary': 'gweru_rural_planning_boundary',
          'zimbabwe': 'zimbabwe'
        }
        const tableName = layerMappings[layerName] || layerName
        
        // Dynamic column discovery - query information_schema for actual table columns
        const columnsQuery = `
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = $1
          AND column_name NOT IN ('geom', 'geometry')
          ORDER BY ordinal_position
        `
        const columnsResult = await pool.query(columnsQuery, [tableName])
        const columns = columnsResult.rows.map(r => `"${r.column_name}"`)
        
        // Build query with dynamic columns
        let query = `
          SELECT 
            ${columns.length > 0 ? columns.join(', ') + ',' : ''}
            ST_AsGeoJSON(ST_Transform(geom, 4326), 8)::json as geometry
          FROM public."${tableName}"
          WHERE geom IS NOT NULL
        `
        const params = []

        // Add bbox filter
        if (bbox) {
          const [minx, miny, maxx, maxy] = bbox.split(',').map(Number)
          query += ` AND ST_Intersects(ST_Transform(geom, 4326), ST_MakeEnvelope(${minx}, ${miny}, ${maxx}, ${maxy}, 4326))`
        }
        
        // Add CQL filter support (parameterized — values are bound, never concatenated)
        if (filter) {
          const parsed = parseCQLFilter(filter, params.length + 1)
          if (parsed) {
            query += ` AND ${parsed.clause}`
            params.push(...parsed.params)
          }
        }
        
        if (maxFeatures) {
          query += ` LIMIT ${parseInt(maxFeatures)}`
        }
        
        const result = await pool.query(query, params)
        await pool.end()
        
        // Build GeoJSON features with actual properties
        const features = result.rows.map((row, index) => {
          const { geometry, ...properties } = row
          return {
            type: 'Feature',
            id: properties.id || properties.gid || index,
            geometry: geometry,
            properties: properties
          }
        })
        
        // Calculate bbox from features
        const calculatedBbox = features.length > 0 ? calculateBbox(features) : null
        
        // Convert to TopoJSON for compression (matching dynamic-layers pattern)
        const geojson = {
          type: 'FeatureCollection',
          features: features
        }
        
        const topojsonResult = topology({ collection: geojson })
        
        // Return TopoJSON with embedded features for frontend extraction
        reply.header('Content-Type', 'application/json')
        return {
          type: 'Topology',
          objects: {
            collection: {
              type: 'FeatureCollection',
              features: features
            }
          },
          arcs: topojsonResult.arcs,
          transform: topojsonResult.transform,
          bbox: calculatedBbox,
          totalFeatures: features.length
        }
      }
    } catch (error) {
      console.error(`[OGC Routes] ❌ WFS GetFeature failed:`, error.message)
      return reply.status(500).send({
        success: false,
        error: 'WFS GetFeature failed',
        details: error.message
      })
    }
  })
  
  /**
   * GET /ogc/wfs/describe/:layerName
   * Get WFS DescribeFeatureType (schema)
   */
  fastify.get('/ogc/wfs/describe/:layerName', async (request, reply) => {
    try {
      const { layerName } = request.params
      
      console.log(`[OGC Routes] 📋 WFS DescribeFeatureType for ${layerName}`)
      
      const bridge = getBridge()
      const result = await bridge.wfsDescribeFeatureType(layerName)
      
      return {
        success: true,
        data: result
      }
    } catch (error) {
      console.error(`[OGC Routes] ❌ WFS DescribeFeatureType failed:`, error.message)
      return reply.status(500).send({
        success: false,
        error: 'WFS DescribeFeatureType failed',
        details: error.message
      })
    }
  })

  // ============================================================
  // WMS - Web Map Service (Rendered Images)
  // ============================================================
  
  /**
   * GET /ogc/wms/capabilities
   * Get WMS server capabilities
   */
  fastify.get('/ogc/wms/capabilities', async (request, reply) => {
    try {
      console.log('[OGC Routes] 📋 WMS GetCapabilities requested')
      const bridge = getBridge()
      
      try {
        const result = await bridge.wmsGetCapabilities()
        return {
          success: true,
          data: result
        }
      } catch (qgisError) {
        console.log('[OGC Routes] ⚠️ QGIS Server failed, using QGIS project file fallback:', qgisError.message)
        
        // Fallback: Read layers directly from QGIS project file
        try {
          const { PerfectQGISStyleExtractor } = require('../services/admin/perfectQGISStyleExtractor')
          const extractor = new PerfectQGISStyleExtractor()
          const projectPath = process.platform === 'win32' 
            ? 'c:\\mataranyika\\vungu-master-alpha-qgis-server\\qgis-projects\\vungu-minimal.qgs'
            : '/etc/qgisserver/vungu-minimal.qgs'
          
          const projectLayers = extractor.listProjectLayers(projectPath)
          
          if (projectLayers && projectLayers.length > 0) {
            console.log(`[OGC Routes] ✅ WMS fallback: Found ${projectLayers.length} layers from project file`)
            
            return {
              success: true,
              data: {
                success: true,
                service: 'WMS',
                version: '1.3.0',
                title: 'Vungu GIS (Project File Fallback)',
                layers: projectLayers.map(l => ({
                  name: l.name,
                  title: l.title || l.name,
                  abstract: l.abstract || `Layer ${l.name}`,
                  crs: ['EPSG:4326', 'EPSG:3857'],
                  bbox: l.extent
                })),
                _source: 'project-file-fallback',
                _note: 'WMS capabilities derived from QGIS project file (QGIS Server unavailable)'
              }
            }
          }
        } catch (fallbackError) {
          console.log('[OGC Routes] ❌ Project file fallback also failed:', fallbackError.message)
        }
        
        throw qgisError
      }
    } catch (error) {
      console.error('[OGC Routes] ❌ WMS GetCapabilities failed:', error.message)
      return reply.status(500).send({
        success: false,
        error: 'WMS GetCapabilities failed',
        details: error.message
      })
    }
  })
  
  /**
   * GET /ogc/wms/map/:layerName
   * Get rendered map image from WMS
   */
  fastify.get('/ogc/wms/map/:layerName', async (request, reply) => {
    try {
      const { layerName } = request.params
      const { 
        bbox, 
        width, 
        height, 
        format, 
        crs, 
        styles, 
        transparent 
      } = request.query
      
      console.log(`[OGC Routes] 🖼️ WMS GetMap for ${layerName}`, { bbox, width, height })
      
      const bridge = getBridge()
      const options = {}
      
      // Handle bbox - validate and parse
      if (bbox && !bbox.includes('{')) {
        // Parse bbox string like "29.5,-19.8,30.2,-19.1"
        const bboxValues = bbox.split(',').map(Number).filter(n => !isNaN(n))
        if (bboxValues.length === 4) {
          options.bbox = bboxValues
        } else {
          console.log('[OGC Routes] ⚠️ Invalid bbox, using default')
          // Default Gweru area in EPSG:3857 (Web Mercator)
          options.bbox = [3285414, -2278045, 3362604, -2190855]
        }
      } else {
        // Use default bbox if template placeholder or missing
        console.log('[OGC Routes] ⚠️ Using default bbox (EPSG:3857)')
        // Default Gweru area in EPSG:3857 (Web Mercator)
        options.bbox = [3285414, -2278045, 3362604, -2190855]
      }
      
      if (width) options.width = parseInt(width)
      if (height) options.height = parseInt(height)
      if (format) options.format = format
      // Default to EPSG:3857 for tile compatibility with MapLibre
      options.crs = crs || 'EPSG:3857'
      if (styles) options.styles = styles
      if (transparent !== undefined) options.transparent = transparent === 'true'
      
      // Try QGIS Server first
      try {
        const result = await bridge.wmsGetMap(layerName, options)
        
        // Return image directly as binary
        if (result.image && result.image.includes('base64')) {
          reply.header('Content-Type', result.contentType || 'image/png')
          const base64Data = result.image.split(',')[1]
          return reply.send(Buffer.from(base64Data, 'base64'))
        }
        
        return {
          success: true,
          data: result
        }
      } catch (qgisError) {
        console.log('[OGC Routes] ⚠️ QGIS Server WMS failed, using fallback:', qgisError.message)
        
        // Generate a simple placeholder image
        const placeholderImage = generatePlaceholderImage(options.width || 256, options.height || 256, layerName)
        
        reply.header('Content-Type', 'image/png')
        return reply.send(placeholderImage)
      }
    } catch (error) {
      console.error(`[OGC Routes] ❌ WMS GetMap failed:`, error.message)
      return reply.status(500).send({
        success: false,
        error: 'WMS GetMap failed',
        details: error.message
      })
    }
  })
  
  /**
   * GET /ogc/wms/legend/:layerName
   * Get legend graphic from WMS
   */
  fastify.get('/ogc/wms/legend/:layerName', async (request, reply) => {
    try {
      const { layerName } = request.params
      const { width, height, format, scale, rule } = request.query
      
      console.log(`[OGC Routes] 🎨 WMS GetLegendGraphic for ${layerName}`)
      
      const bridge = getBridge()
      const options = {}
      
      if (width) options.width = parseInt(width)
      if (height) options.height = parseInt(height)
      if (format) options.format = format
      if (scale) options.scale = parseInt(scale)
      if (rule) options.rule = rule
      
      const result = await bridge.getLegend(layerName, options)
      
      // Return image directly or as JSON wrapper
      if (request.query.raw === 'true') {
        reply.header('Content-Type', result.contentType)
        return reply.send(Buffer.from(result.legend.split(',')[1], 'base64'))
      }
      
      return {
        success: true,
        data: result
      }
    } catch (error) {
      console.error(`[OGC Routes] ❌ WMS GetLegendGraphic failed:`, error.message)
      return reply.status(500).send({
        success: false,
        error: 'WMS GetLegendGraphic failed',
        details: error.message
      })
    }
  })

  // ============================================================
  // WMTS - Web Map Tile Service (Cached Tiles)
  // ============================================================
  
  /**
   * GET /ogc/wmts/tile/:layerName/:z/:x/:y
   * Get map tile from WMTS
   */
  fastify.get('/ogc/wmts/tile/:layerName/:z/:x/:y', async (request, reply) => {
    try {
      const { layerName, z, x, y } = request.params
      const { format, style, tileMatrixSet } = request.query
      
      console.log(`[OGC Routes] 🧩 WMTS GetTile for ${layerName} (${z}/${x}/${y})`)
      
      const bridge = getBridge()
      const options = {
        z: parseInt(z),
        x: parseInt(x),
        y: parseInt(y)
      }
      
      if (format) options.format = format
      if (style) options.style = style
      if (tileMatrixSet) options.tileMatrixSet = tileMatrixSet
      
      const result = await bridge.wmtsGetTile(layerName, options)
      
      // Return tile image directly
      reply.header('Content-Type', result.contentType)
      return reply.send(Buffer.from(result.tile.split(',')[1], 'base64'))
      
    } catch (error) {
      console.error(`[OGC Routes] ❌ WMTS GetTile failed:`, error.message)
      return reply.status(500).send({
        success: false,
        error: 'WMTS GetTile failed',
        details: error.message
      })
    }
  })
  
  /**
   * GET /ogc/wmts/url/:layerName
   * Get WMTS tile URL template for MapLibre/Leaflet
   */
  fastify.get('/ogc/wmts/url/:layerName', async (request, reply) => {
    try {
      const { layerName } = request.params
      const { format, style, tileMatrixSet } = request.query
      
      console.log(`[OGC Routes] 🔗 WMTS tile URL for ${layerName}`)
      
      const bridge = getBridge()
      const tileUrl = bridge.getWMTSTileUrl(layerName, {
        format,
        style,
        tileMatrixSet
      })
      
      return {
        success: true,
        data: {
          layerName,
          tileUrl,
          usage: 'Replace {z}, {x}, {y} with tile coordinates'
        }
      }
    } catch (error) {
      console.error(`[OGC Routes] ❌ WMTS URL generation failed:`, error.message)
      return reply.status(500).send({
        success: false,
        error: 'WMTS URL generation failed',
        details: error.message
      })
    }
  })

  // ============================================================
  // OGC API Features (Modern REST API)
  // ============================================================
  
  /**
   * GET /ogc/api/features/:collectionId
   * Get features using OGC API Features
   */
  fastify.get('/ogc/api/features/:collectionId', async (request, reply) => {
    try {
      const { collectionId } = request.params
      const { bbox, limit, offset, datetime, properties } = request.query
      
      console.log(`[OGC Routes] 🔗 OGC API Features for ${collectionId}`)
      
      const bridge = getBridge()
      const options = {}
      
      if (bbox) options.bbox = bbox.split(',').map(Number)
      if (limit) options.limit = parseInt(limit)
      if (offset) options.offset = parseInt(offset)
      if (datetime) options.datetime = datetime
      if (properties) options.properties = properties.split(',')
      
      const result = await bridge.ogcApiGetFeatures(collectionId, options)
      
      return {
        success: true,
        data: result
      }
    } catch (error) {
      console.error(`[OGC Routes] ❌ OGC API Features failed:`, error.message)
      return reply.status(500).send({
        success: false,
        error: 'OGC API Features failed',
        details: error.message
      })
    }
  })
  
  /**
   * GET /ogc/api/styles/:collectionId
   * Get styles using OGC API Styles
   */
  fastify.get('/ogc/api/styles/:collectionId', async (request, reply) => {
    try {
      const { collectionId } = request.params
      
      console.log(`[OGC Routes] 🎨 OGC API Styles for ${collectionId}`)
      
      const bridge = getBridge()
      const result = await bridge.ogcApiGetStyles(collectionId)
      
      return {
        success: true,
        data: result
      }
    } catch (error) {
      console.error(`[OGC Routes] ❌ OGC API Styles failed:`, error.message)
      return reply.status(500).send({
        success: false,
        error: 'OGC API Styles failed',
        details: error.message
      })
    }
  })
  
  /**
   * GET /ogc/api/styles/:collectionId/:styleId
   * Get specific style definition
   */
  fastify.get('/ogc/api/styles/:collectionId/:styleId', async (request, reply) => {
    try {
      const { collectionId, styleId } = request.params
      const { format } = request.query
      
      console.log(`[OGC Routes] 📜 OGC API Style Definition for ${collectionId}/${styleId}`)
      
      const bridge = getBridge()
      const result = await bridge.ogcApiGetStyleDefinition(
        collectionId, 
        styleId, 
        format || 'mapbox'
      )
      
      return {
        success: true,
        data: result
      }
    } catch (error) {
      console.error(`[OGC Routes] ❌ OGC API Style Definition failed:`, error.message)
      return reply.status(500).send({
        success: false,
        error: 'OGC API Style Definition failed',
        details: error.message
      })
    }
  })

  // ============================================================
  // Combined: Styled Layers (The Complete Package)
  // ============================================================
  
  /**
   * GET /ogc/styled-layer/:layerName
   * Get layer with features AND styles combined
   * This is the main endpoint for frontend consumption
   */
  fastify.get('/ogc/styled-layer/:layerName', async (request, reply) => {
    try {
      const { layerName } = request.params
      const { 
        bbox, 
        maxFeatures, 
        useOgcApi,
        includeLegend,
        includeTileUrl,
        noCache
      } = request.query
      
      console.log(`[OGC Routes] 🚀 Styled layer request for ${layerName}`)
      
      const bridge = getBridge()
      const options = {
        useOgcApi: useOgcApi === 'true',
        noCache: noCache === 'true'
      }
      
      if (bbox) options.bbox = bbox.split(',').map(Number)
      if (maxFeatures) options.maxFeatures = parseInt(maxFeatures)
      
      const result = await bridge.getStyledLayer(layerName, options)
      
      // Optionally exclude some data to reduce payload
      if (includeLegend === 'false') delete result.legend
      if (includeTileUrl === 'false') delete result.tileUrl
      
      return {
        success: true,
        data: result
      }
    } catch (error) {
      console.error(`[OGC Routes] ❌ Styled layer request failed:`, error.message)
      return reply.status(500).send({
        success: false,
        error: 'Styled layer request failed',
        details: error.message
      })
    }
  })
  
  /**
   * GET /ogc/maplibre-style/:layerName
   * Get MapLibre GL JS compatible style for a layer
   */
  fastify.get('/ogc/maplibre-style/:layerName', async (request, reply) => {
    try {
      const { layerName } = request.params
      
      console.log(`[OGC Routes] 🎨 MapLibre style for ${layerName}`)
      
      const bridge = getBridge()
      const result = await bridge.getStyledLayer(layerName, {})
      
      return {
        success: true,
        data: {
          layerId: layerName,
          style: result.maplibreStyle,
          source: result.style?.source,
          legend: result.legend?.legend,
          tileUrl: result.tileUrl
        }
      }
    } catch (error) {
      console.error(`[OGC Routes] ❌ MapLibre style request failed:`, error.message)
      return reply.status(500).send({
        success: false,
        error: 'MapLibre style request failed',
        details: error.message
      })
    }
  })

  // ============================================================
  // Cache Management
  // ============================================================
  
  /**
   * POST /ogc/cache/clear
   * Clear all caches
   */
  fastify.post('/ogc/cache/clear', async (request, reply) => {
    try {
      console.log('[OGC Routes] 🧹 Cache clear requested')
      const bridge = getBridge()
      bridge.clearCache()
      
      return {
        success: true,
        message: 'Cache cleared successfully'
      }
    } catch (error) {
      console.error('[OGC Routes] ❌ Cache clear failed:', error.message)
      return reply.status(500).send({
        success: false,
        error: 'Cache clear failed',
        details: error.message
      })
    }
  })

  /**
   * GET /ogc/watcher/status
   * Get file watcher status for automatic style updates
   */
  fastify.get('/ogc/watcher/status', async (request, reply) => {
    try {
      const status = getWatcherStatus()
      return {
        success: true,
        data: status
      }
    } catch (error) {
      console.error('[OGC Routes] ❌ Watcher status failed:', error.message)
      return reply.status(500).send({
        success: false,
        error: 'Watcher status check failed',
        details: error.message
      })
    }
  })
}

// Initialize bridge on module load to start file watcher
try {
  console.log('[OGC Routes] 🚀 Initializing OGC Bridge and starting file watcher...')
  getBridge()
} catch (error) {
  console.error('[OGC Routes] ⚠️ Bridge initialization failed:', error.message)
  console.log('[OGC Routes] ℹ️ Bridge will be lazy-loaded on first request')
}

module.exports = ogcServicesRoutes
