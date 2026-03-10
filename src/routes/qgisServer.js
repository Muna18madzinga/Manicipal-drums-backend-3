/**
 * QGIS Server Integration Routes
 * Production-grade QGIS Server API endpoints
 */

const { UltimateQGISBridge } = require('../services/admin/ultimateQGISBridge')

// Initialize QGIS Server bridge
let qgisServerBridge = null

// Initialize bridge on first use
function getBridge() {
  if (!qgisServerBridge) {
    qgisServerBridge = new UltimateQGISBridge({
      baseUrl: process.env.QGIS_SERVER_URL || 'http://localhost:8080',
      version: process.env.QGIS_SERVER_VERSION || '1.3.0',
      project: process.env.QGIS_PROJECT || '/vungu-project.qgs',
      timeout: parseInt(process.env.QGIS_SERVER_TIMEOUT) || 30000,
      maxRetries: parseInt(process.env.QGIS_SERVER_MAX_RETRIES) || 3
    })
  }
  return qgisServerBridge
}

// QGIS Server health check
async function qgisServerHealthRoutes(server, options) {
  server.get('/qgis-server/health', async (request, reply) => {
    try {
      console.log('[QGIS-Server] 🔍 Health check requested')
      
      const bridge = getBridge()
      const connectivity = await bridge.testConnectivity()
      
      if (connectivity.success) {
        console.log('[QGIS-Server] ✅ Health check passed')
        return {
          success: true,
          data: {
            status: 'healthy',
            server: bridge.serverConfig.baseUrl,
            project: bridge.serverConfig.project,
            timestamp: new Date().toISOString(),
            connectivity: connectivity
          }
        }
      } else {
        console.log('[QGIS-Server] ❌ Health check failed')
        return reply.status(503).send({
          success: false,
          error: 'QGIS Server is not reachable',
          details: connectivity
        })
      }
    } catch (error) {
      console.error('[QGIS-Server] ❌ Health check error:', error)
      return reply.status(500).send({
        success: false,
        error: 'Health check failed',
        details: error.message
      })
    }
  })
}

// QGIS Server capabilities
async function qgisServerCapabilitiesRoutes(server, options) {
  server.get('/qgis-server/capabilities', async (request, reply) => {
    try {
      console.log('[QGIS-Server] 📋 Capabilities requested')
      
      const bridge = getBridge()
      const capabilities = await bridge.getServerCapabilities()
      
      if (capabilities.success) {
        console.log('[QGIS-Server] ✅ Capabilities retrieved')
        return {
          success: true,
          data: {
            capabilities: capabilities.data,
            server: bridge.serverConfig.baseUrl,
            timestamp: new Date().toISOString()
          }
        }
      } else {
        console.log('[QGIS-Server] ❌ Capabilities failed')
        return reply.status(503).send({
          success: false,
          error: 'Failed to get server capabilities',
          details: capabilities
        })
      }
    } catch (error) {
      console.error('[QGIS-Server] ❌ Capabilities error:', error)
      return reply.status(500).send({
        success: false,
        error: 'Capabilities request failed',
        details: error.message
      })
    }
  })
}

// Ultimate QGIS style extraction
async function ultimateQGISStyleRoutes(server, options) {
  server.get('/qgis-server/layers/:layerName/style', async (request, reply) => {
    try {
      const { layerName } = request.params
      const { format, includeSVG, cache } = request.query
      
      console.log(`[QGIS-Server] 🎨 Ultimate style extraction for ${layerName}`)
      
      const bridge = getBridge()
      const style = await bridge.extractStyle(layerName, {
        format: format || 'unified',
        includeSVG: includeSVG !== 'false',
        cache: cache !== 'false'
      })
      
      console.log(`[QGIS-Server] ✅ Style extraction successful: ${style.symbols.length} symbols`)
      
      return {
        success: true,
        data: style,
        metadata: {
          extractionMethod: style.metadata.source,
          serverBased: true,
          extractionTime: style.extractionTime,
          symbolCount: style.symbols.length,
          hasSVG: style.metadata.hasSVG
        }
      }
    } catch (error) {
      console.error(`[QGIS-Server] ❌ Style extraction failed:`, error)
      return reply.status(500).send({
        success: false,
        error: 'Style extraction failed',
        details: error.message
      })
    }
  })
}

// QGIS Server WMS GetLegendGraphic proxy
async function qgisServerWMSRoutes(server, options) {
  server.get('/qgis-server/wms/legend/:layerName', async (request, reply) => {
    try {
      const { layerName } = request.params
      const { format, width, height, scale } = request.query
      
      console.log(`[QGIS-Server] 🎨 WMS GetLegendGraphic for ${layerName}`)
      
      const bridge = getBridge()
      const legend = await bridge.extractViaWMSLegend(layerName)
      
      if (legend.success) {
        // Set appropriate headers based on format
        if (legend.data._format === 'png') {
          reply.header('Content-Type', 'image/png')
          reply.header('Cache-Control', 'public, max-age=3600')
          return reply.send(Buffer.from(legend.data._legendGraphic.split(',')[1], 'base64'))
        } else {
          return {
            success: true,
            data: legend.data,
            metadata: {
              method: 'wms-legend',
              layerName,
              format: legend.data._format
            }
          }
        }
      } else {
        return reply.status(404).send({
          success: false,
          error: 'Legend not found',
          details: legend
        })
      }
    } catch (error) {
      console.error(`[QGIS-Server] ❌ WMS legend failed:`, error)
      return reply.status(500).send({
        success: false,
        error: 'WMS GetLegendGraphic failed',
        details: error.message
      })
    }
  })
}

// QGIS Server WFS DescribeFeatureType proxy
async function qgisServerWFSRoutes(server, options) {
  server.get('/qgis-server/wfs/describe/:layerName', async (request, reply) => {
    try {
      const { layerName } = request.params
      const { outputFormat } = request.query
      
      console.log(`[QGIS-Server] 📋 WFS DescribeFeatureType for ${layerName}`)
      
      const bridge = getBridge()
      const describe = await bridge.extractViaWFSDescribe(layerName)
      
      if (describe.success) {
        return {
          success: true,
          data: describe.data,
          metadata: {
            method: 'wfs-describe',
            layerName,
            geometryType: describe.data._geometryType
          }
        }
      } else {
        return reply.status(404).send({
          success: false,
          error: 'Feature type not found',
          details: describe
        })
      }
    } catch (error) {
      console.error(`[QGIS-Server] ❌ WFS describe failed:`, error)
      return reply.status(500).send({
        success: false,
        error: 'WFS DescribeFeatureType failed',
        details: error.message
      })
    }
  })
}

// QGIS Server OGC API Styles proxy
async function qgisServerOGCAPIRoutes(server, options) {
  server.get('/qgis-server/api/styles/:layerName', async (request, reply) => {
    try {
      const { layerName } = request.params
      
      console.log(`[QGIS-Server] 🎯 OGC API styles for ${layerName}`)
      
      const bridge = getBridge()
      const styles = await bridge.extractViaOGCAPI(layerName)
      
      if (styles.success) {
        return {
          success: true,
          data: styles.data,
          metadata: {
            method: 'ogc-api-styles',
            layerName
          }
        }
      } else {
        return reply.status(404).send({
          success: false,
          error: 'OGC API styles not found',
          details: styles
        })
      }
    } catch (error) {
      console.error(`[QGIS-Server] ❌ OGC API styles failed:`, error)
      return reply.status(500).send({
        success: false,
        error: 'OGC API styles failed',
        details: error.message
      })
    }
  })
}

// QGIS Server performance metrics
async function qgisServerMetricsRoutes(server, options) {
  server.get('/qgis-server/metrics', async (request, reply) => {
    try {
      const bridge = getBridge()
      
      // Get bridge statistics
      const cacheStats = bridge.getCacheStats()
      
      // Test server connectivity
      const connectivity = await bridge.testConnectivity()
      
      return {
        success: true,
        data: {
          server: bridge.serverConfig.baseUrl,
          project: bridge.serverConfig.project,
          cache: cacheStats,
          connectivity: connectivity,
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          timestamp: new Date().toISOString()
        }
      }
    } catch (error) {
      console.error('[QGIS-Server] ❌ Metrics error:', error)
      return reply.status(500).send({
        success: false,
        error: 'Metrics collection failed',
        details: error.message
      })
    }
  })
}

// QGIS Server cache management
async function qgisServerCacheRoutes(server, options) {
  server.delete('/qgis-server/cache', async (request, reply) => {
    try {
      console.log('[QGIS-Server] 🗑️ Cache clear requested')
      
      const bridge = getBridge()
      bridge.clearCache()
      
      return {
        success: true,
        message: 'Cache cleared successfully',
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      console.error('[QGIS-Server] ❌ Cache clear error:', error)
      return reply.status(500).send({
        success: false,
        error: 'Cache clear failed',
        details: error.message
      })
    }
  })
  
  server.get('/qgis-server/cache/stats', async (request, reply) => {
    try {
      const bridge = getBridge()
      const stats = bridge.getCacheStats()
      
      return {
        success: true,
        data: stats,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      console.error('[QGIS-Server] ❌ Cache stats error:', error)
      return reply.status(500).send({
        success: false,
        error: 'Cache stats failed',
        details: error.message
      })
    }
  })
}

// Create all QGIS Server routes
async function createQGISServerRoutes(server) {
  console.log('[QGIS-Server] 🚀 Creating QGIS Server routes')
  
  // Health and capabilities
  await qgisServerHealthRoutes(server)
  await qgisServerCapabilitiesRoutes(server)
  
  // Style extraction
  await ultimateQGISStyleRoutes(server)
  
  // Service proxies
  await qgisServerWMSRoutes(server)
  await qgisServerWFSRoutes(server)
  await qgisServerOGCAPIRoutes(server)
  
  // Management
  await qgisServerMetricsRoutes(server)
  await qgisServerCacheRoutes(server)
  
  console.log('[QGIS-Server] ✅ QGIS Server routes created')
}

module.exports = { createQGISServerRoutes }
