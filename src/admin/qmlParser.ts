import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { QmlParserController } from '../../controllers/admin/qmlParserController';

export function createQmlParserRoutes(server: FastifyInstance, pool: Pool) {
  const qmlParserController = new QmlParserController(pool);

  // Create a new QML style template
  server.post('/qml-templates', {
    schema: {
      description: 'Create a new QML style template',
      tags: ['QML Parser'],
      body: {
        type: 'object',
        required: ['name', 'qml_content', 'style_type'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          qml_content: { type: 'string' },
          style_type: { 
            type: 'string',
            enum: ['point', 'line', 'polygon', 'raster']
          }
        }
      }
    }
  }, qmlParserController.createQmlTemplate);

  // Get QML template by ID
  server.get('/qml-templates/:templateId', {
    schema: {
      description: 'Get QML template by ID',
      tags: ['QML Parser'],
      params: {
        type: 'object',
        required: ['templateId'],
        properties: {
          templateId: { type: 'number' }
        }
      }
    }
  }, qmlParserController.getQmlTemplate);

  // Get all QML templates
  server.get('/qml-templates', {
    schema: {
      description: 'Get all QML templates',
      tags: ['QML Parser'],
      querystring: {
        type: 'object',
        properties: {
          style_type: { 
            type: 'string',
            enum: ['point', 'line', 'polygon', 'raster']
          }
        }
      }
    }
  }, qmlParserController.getQmlTemplates);

  // Update QML template
  server.put('/qml-templates/:templateId', {
    schema: {
      description: 'Update QML template',
      tags: ['QML Parser'],
      params: {
        type: 'object',
        required: ['templateId'],
        properties: {
          templateId: { type: 'number' }
        }
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          qml_content: { type: 'string' },
          style_type: { 
            type: 'string',
            enum: ['point', 'line', 'polygon', 'raster']
          },
          is_active: { type: 'boolean' }
        }
      }
    }
  }, qmlParserController.updateQmlTemplate);

  // Delete QML template
  server.delete('/qml-templates/:templateId', {
    schema: {
      description: 'Delete QML template',
      tags: ['QML Parser'],
      params: {
        type: 'object',
        required: ['templateId'],
        properties: {
          templateId: { type: 'number' }
        }
      }
    }
  }, qmlParserController.deleteQmlTemplate);

  // Validate QML content
  server.post('/qml-templates/validate', {
    schema: {
      description: 'Validate QML content',
      tags: ['QML Parser'],
      body: {
        type: 'object',
        required: ['qml_content'],
        properties: {
          qml_content: { type: 'string' }
        }
      }
    }
  }, qmlParserController.validateQmlContent);

  // Parse QML content
  server.post('/qml-templates/parse', {
    schema: {
      description: 'Parse QML content and return configuration',
      tags: ['QML Parser'],
      body: {
        type: 'object',
        required: ['qml_content'],
        properties: {
          qml_content: { type: 'string' }
        }
      }
    }
  }, qmlParserController.parseQmlContent);

  // Convert QML template to web format
  server.get('/qml-templates/:templateId/convert', {
    schema: {
      description: 'Convert QML template to web-compatible format',
      tags: ['QML Parser'],
      params: {
        type: 'object',
        required: ['templateId'],
        properties: {
          templateId: { type: 'number' }
        }
      }
    }
  }, qmlParserController.convertToWebStyle);

  // Get QML statistics
  server.get('/qml-templates/statistics', {
    schema: {
      description: 'Get QML template statistics',
      tags: ['QML Parser']
    }
  }, qmlParserController.getQmlStatistics);

  // Clone QML template
  server.post('/qml-templates/:templateId/clone', {
    schema: {
      description: 'Clone QML template',
      tags: ['QML Parser'],
      params: {
        type: 'object',
        required: ['templateId'],
        properties: {
          templateId: { type: 'number' }
        }
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' }
        }
      }
    }
  }, qmlParserController.cloneQmlTemplate);

  // Preview QML template
  server.get('/qml-templates/:templateId/preview', {
    schema: {
      description: 'Preview QML template',
      tags: ['QML Parser'],
      params: {
        type: 'object',
        required: ['templateId'],
        properties: {
          templateId: { type: 'number' }
        }
      }
    }
  }, qmlParserController.previewQmlTemplate);
}
