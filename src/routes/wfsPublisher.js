/**
 * WFS Publisher API Routes
 * 
 * Provides REST endpoints for automated WFS layer publishing
 * using PyQGIS scripts for novice users.
 */

const WFSLayerPublisher = require('../services/qgis/wfsPublisher');
const path = require('path');
const logger = require('../utils/logger');

class WFSPublisherRoutes {
  constructor() {
    this.publisher = new WFSLayerPublisher();
  }

  /**
   * Register WFS publisher routes
   * @param {Object} fastify - Fastify instance
   */
  registerRoutes(fastify) {
    // Publish specific layers for WFS
    fastify.post('/api/wfs/publish', {
      schema: {
        description: 'Publish specific layers for WFS service',
        tags: ['WFS', 'QGIS'],
        body: {
          type: 'object',
          required: ['projectPath', 'layerNames'],
          properties: {
            projectPath: {
              type: 'string',
              description: 'Path to QGIS project file (.qgs or .qgz)'
            },
            layerNames: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of layer names to publish for WFS'
            },
            options: {
              type: 'object',
              properties: {
                wfsUrl: { type: 'string', default: 'http://localhost:8080/wfs' },
                save: { type: 'boolean', default: true }
              }
            }
          }
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
              data: {
                type: 'object',
                properties: {
                  published: { type: 'array', items: { type: 'string' } },
                  failed: { type: 'array', items: { type: 'string' } },
                  totalAttempted: { type: 'number' },
                  successRate: { type: 'number' },
                  details: { type: 'string' }
                }
              }
            }
          },
          400: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: { type: 'string' },
              details: { type: 'string' }
            }
          },
          500: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              error: { type: 'string' },
              details: { type: 'string' }
            }
          }
        }
      }
    }, async (request, reply) => {
      try {
        const { projectPath, layerNames, options = {} } = request.body;
        
        logger.info(`[WFS Publisher API] 🚀 Publishing ${layerNames.length} layers for WFS`);
        
        // Validate project path
        const absoluteProjectPath = path.resolve(projectPath);
        
        // Publish layers
        const result = await this.publisher.publishLayers(absoluteProjectPath, layerNames, options);
        
        return {
          success: true,
          message: `Successfully published ${result.published.length} layers for WFS`,
          data: result
        };
        
      } catch (error) {
        logger.error(`[WFS Publisher API] ❌ Publishing failed: ${error.message}`);
        
        return reply.status(500).send({
          success: false,
          error: 'WFS publishing failed',
          details: error.message
        });
      }
    });

    // Publish all layers in a project
    fastify.post('/api/wfs/publish-all', {
      schema: {
        description: 'Publish all vector layers in a project for WFS service',
        tags: ['WFS', 'QGIS'],
        body: {
          type: 'object',
          required: ['projectPath'],
          properties: {
            projectPath: {
              type: 'string',
              description: 'Path to QGIS project file (.qgs or .qgz)'
            },
            options: {
              type: 'object',
              properties: {
                wfsUrl: { type: 'string', default: 'http://localhost:8080/wfs' },
                save: { type: 'boolean', default: true }
              }
            }
          }
        }
      }
    }, async (request, reply) => {
      try {
        const { projectPath, options = {} } = request.body;
        
        logger.info(`[WFS Publisher API] 🚀 Publishing ALL layers for WFS`);
        
        // Validate project path
        const absoluteProjectPath = path.resolve(projectPath);
        
        // Publish all layers
        const result = await this.publisher.publishAllLayers(absoluteProjectPath, options);
        
        return {
          success: true,
          message: `Successfully published ${result.published.length} layers for WFS`,
          data: result
        };
        
      } catch (error) {
        logger.error(`[WFS Publisher API] ❌ Publishing failed: ${error.message}`);
        
        return reply.status(500).send({
          success: false,
          error: 'WFS publishing failed',
          details: error.message
        });
      }
    });

    // Get publishing status/cache info
    fastify.get('/api/wfs/status', {
      schema: {
        description: 'Get WFS publisher cache status',
        tags: ['WFS', 'Status']
      }
    }, async (request, reply) => {
      try {
        const stats = this.publisher.getCacheStats();
        
        return {
          success: true,
          data: {
            cacheSize: stats.size,
            cachedProjects: stats.keys,
            timestamp: new Date().toISOString()
          }
        };
        
      } catch (error) {
        logger.error(`[WFS Publisher API] ❌ Status check failed: ${error.message}`);
        
        return reply.status(500).send({
          success: false,
          error: 'Status check failed',
          details: error.message
        });
      }
    });

    // Clear publishing cache
    fastify.delete('/api/wfs/cache', {
      schema: {
        description: 'Clear WFS publisher cache',
        tags: ['WFS', 'Cache']
      }
    }, async (request, reply) => {
      try {
        this.publisher.clearCache();
        
        return {
          success: true,
          message: 'WFS publisher cache cleared successfully'
        };
        
      } catch (error) {
        logger.error(`[WFS Publisher API] ❌ Cache clear failed: ${error.message}`);
        
        return reply.status(500).send({
          success: false,
          error: 'Cache clear failed',
          details: error.message
        });
      }
    });

    // Auto-publish and extract styled layer (complete workflow)
    fastify.post('/api/wfs/publish-and-style', {
      schema: {
        description: 'Auto-publish layers and extract styling with OGC Bridge',
        tags: ['WFS', 'OGC', 'Styling'],
        body: {
          type: 'object',
          required: ['projectPath', 'layerNames'],
          properties: {
            projectPath: {
              type: 'string',
              description: 'Path to QGIS project file'
            },
            layerNames: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of layer names to publish and style'
            },
            options: {
              type: 'object',
              properties: {
                wfsUrl: { type: 'string', default: 'http://localhost:8080/wfs' },
                save: { type: 'boolean', default: true },
                bbox: { type: 'string', description: 'Bounding box for features' },
                maxFeatures: { type: 'number', default: 1000 },
                includeLegend: { type: 'boolean', default: true }
              }
            }
          }
        }
      }
    }, async (request, reply) => {
      try {
        const { projectPath, layerNames, options = {} } = request.body;
        
        logger.info(`[WFS Publisher API] 🎨 Auto-publish and style workflow started`);
        
        // Step 1: Publish layers for WFS
        const publishResult = await this.publisher.publishLayers(projectPath, layerNames, options);
        
        if (publishResult.failed.length > 0) {
          logger.warn(`[WFS Publisher API] ⚠️ Some layers failed to publish: ${publishResult.failed.join(', ')}`);
        }
        
        // Step 2: Extract styling using OGC Bridge (if layers were published)
        const styledLayers = [];
        
        if (publishResult.published.length > 0) {
          // Import OGC Bridge for complete workflow
          let bridge;
          try {
            const { getBridge } = require('../services/ogc/unifiedOGCBridge');
            bridge = getBridge();
          } catch (bridgeError) {
            console.log('[WFS Publisher API] ⚠️ OGC Bridge not available, skipping styling extraction');
          }
          
          // Extract styling for each published layer
          if (bridge) {
            for (const layerName of publishResult.published) {
              try {
                const styledLayer = await bridge.getStyledLayer(layerName, {
                  bbox: options.bbox ? options.bbox.split(',').map(Number) : undefined,
                  maxFeatures: options.maxFeatures,
                  includeLegend: options.includeLegend
                });
                
                styledLayers.push({
                  layerName,
                  success: true,
                  data: styledLayer
                });
                
                logger.info(`[WFS Publisher API] ✅ Extracted styling for layer: ${layerName}`);
                
              } catch (styleError) {
                logger.error(`[WFS Publisher API] ❌ Styling extraction failed for ${layerName}: ${styleError.message}`);
                
                styledLayers.push({
                  layerName,
                  success: false,
                  error: styleError.message
                });
              }
            }
          } else {
            // Add placeholder for published layers when bridge is not available
            for (const layerName of publishResult.published) {
              styledLayers.push({
                layerName,
                success: false,
                error: 'OGC Bridge not available for styling extraction'
              });
            }
          }
        }
        
        return {
          success: true,
          message: `Published ${publishResult.published.length} layers and extracted styling for ${styledLayers.filter(l => l.success).length} layers`,
          data: {
            publishing: publishResult,
            styling: styledLayers,
            workflow: {
              steps: ['publish', 'extract-style'],
              completed: styledLayers.length > 0,
              timestamp: new Date().toISOString()
            }
          }
        };
        
      } catch (error) {
        logger.error(`[WFS Publisher API] ❌ Auto-publish and style workflow failed: ${error.message}`);
        
        return reply.status(500).send({
          success: false,
          error: 'Auto-publish and style workflow failed',
          details: error.message
        });
      }
    });
  }
}

module.exports = WFSPublisherRoutes;
