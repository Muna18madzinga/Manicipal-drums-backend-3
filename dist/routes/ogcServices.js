/**
 * Unified OGC Services Routes
 * RESTful API endpoints for WMS, WFS, WMTS, and OGC API access
 */

const { UnifiedOGCBridge } = require('../services/admin/unifiedOGCBridge')

// Singleton bridge instance
let ogcBridge = null

function getBridge() {
  if (!ogcBridge) {
    ogcBridge = new UnifiedOGCBridge({
      baseUrl: process.env.QGIS_SERVER_URL || 'http://localhost:8080',
      wmsVersion: process.env.WMS_VERSION || '1.3.0',
      wfsVersion: process.env.WFS_VERSION || '2.0.0',
      wmtsVersion: process.env.WMTS_VERSION || '1.0.0',
      project: process.env.QGIS_PROJECT || '/vungu-project.qgs',
      timeout: parseInt(process.env.OGC_TIMEOUT) || 30000,
      maxRetries: parseInt(process.env.OGC_MAX_RETRIES) || 3,
      defaultSRS: process.env.DEFAULT_SRS || 'EPSG:4326',
      maxFeatures: parseInt(process.env.MAX_FEATURES) || 10000
    })
  }
  return ogcBridge
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
        
        // If QGIS Server returns no layers, fallback to WMS layers
        if (result.layers && result.layers.length === 0) {
          console.log('[OGC Routes] ⚠️ QGIS Server WFS has no layers, using WMS layers as fallback')
          
          // Get WMS capabilities to use same layers
          const wmsResult = await bridge.wmsGetCapabilities()
          
          if (wmsResult.layers && wmsResult.layers.length > 0) {
            // Convert WMS layers to WFS format
            const wfsLayers = wmsResult.layers.map(layer => ({
              name: layer.name,
              title: layer.title || layer.name,
              abstract: layer.abstract || `Vector layer ${layer.name}`,
              crs: layer.crs || 'EPSG:4326',
              bbox: layer.bbox || null
            }))
            
            return {
              success: true,
              data: {
                ...result,
                layers: wfsLayers,
                _source: 'wms-fallback',
                _note: 'WFS layers derived from WMS layers (direct PostgreSQL access)'
              }
            }
          }
        }
        
        return {
          success: true,
          data: result
        }
      } catch (qgisError) {
        console.log('[OGC Routes] ⚠️ QGIS Server WFS failed, trying WMS fallback...')
        
        // Fallback to WMS layers
        const bridge = getBridge()
        const wmsResult = await bridge.wmsGetCapabilities()
        
        if (wmsResult.layers && wmsResult.layers.length > 0) {
          const wfsLayers = wmsResult.layers.map(layer => ({
            name: layer.name,
            title: layer.title || layer.name,
            abstract: layer.abstract || `Vector layer ${layer.name}`,
            crs: layer.crs || 'EPSG:4326',
            bbox: layer.bbox || null
          }))
          
          return {
            success: true,
            data: {
              service: 'WFS',
              version: '2.0.0',
              title: 'Vungu GIS (Direct PostgreSQL Access)',
              layers: wfsLayers,
              _source: 'direct-postgresql',
              _note: 'WFS layers served via direct PostgreSQL access'
            }
          }
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
        
        const result = await bridge.wfsGetFeature(layerName, options)
        
        return {
          success: true,
          data: result
        }
      } catch (qgisError) {
        console.log(`[OGC Routes] ⚠️ QGIS Server WFS failed, trying direct PostgreSQL...`)
        
        // Fallback to direct PostgreSQL query
        const { Pool } = require('pg')
        const pool = new Pool({
          host: 'localhost',
          port: 5433,
          database: 'vungu_master_db_v1',
          user: 'postgres',
          password: 'cairo2025'
        })
        
        let query = `SELECT ST_AsGeoJSON(ST_Transform(geom, 4326)) as geojson FROM public."${layerName}"`
        
        if (bbox) {
          const [minx, miny, maxx, maxy] = bbox.split(',').map(Number)
          query += ` WHERE ST_Intersects(ST_Transform(geom, 4326), ST_MakeEnvelope(${minx}, ${miny}, ${maxx}, ${maxy}, 4326))`
        }
        
        if (maxFeatures) {
          query += ` LIMIT ${parseInt(maxFeatures)}`
        }
        
        const result = await pool.query(query)
        await pool.end()
        
        const features = result.rows.map(row => JSON.parse(row.geojson))
        
        return {
          success: true,
          data: {
            type: 'FeatureCollection',
            features: features,
            _source: 'direct-postgresql',
            _layerName: layerName
          }
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
      const result = await bridge.wmsGetCapabilities()
      
      return {
        success: true,
        data: result
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
      
      console.log(`[OGC Routes] 🖼️ WMS GetMap for ${layerName}`)
      
      const bridge = getBridge()
      const options = {}
      
      if (bbox) options.bbox = bbox.split(',').map(Number)
      if (width) options.width = parseInt(width)
      if (height) options.height = parseInt(height)
      if (format) options.format = format
      if (crs) options.crs = crs
      if (styles) options.styles = styles
      if (transparent !== undefined) options.transparent = transparent === 'true'
      
      const result = await bridge.wmsGetMap(layerName, options)
      
      // Return image directly or as JSON wrapper
      if (request.query.raw === 'true') {
        reply.header('Content-Type', result.contentType)
        return reply.send(Buffer.from(result.image.split(',')[1], 'base64'))
      }
      
      return {
        success: true,
        data: result
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
      
      const result = await bridge.wmsGetLegendGraphic(layerName, options)
      
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
        includeTileUrl
      } = request.query
      
      console.log(`[OGC Routes] 🚀 Styled layer request for ${layerName}`)
      
      const bridge = getBridge()
      const options = {
        useOgcApi: useOgcApi === 'true'
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
}

module.exports = ogcServicesRoutes
