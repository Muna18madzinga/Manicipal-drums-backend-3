import { FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { AuthController } from '../../controllers/admin/authControllerSimple'

export function createAuthRoutes(server: FastifyInstance, pool: Pool) {
  const authController = new AuthController(pool)

  // Public routes
  server.post('/auth/login', {
    schema: {
      description: 'Admin user login',
      tags: ['Authentication'],
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 6 },
          mfaCode: { type: 'string', minLength: 6, maxLength: 6 }
        }
      }
    }
  }, authController.login)

  server.post('/auth/refresh', {
    schema: {
      description: 'Refresh access token',
      tags: ['Authentication'],
      body: {
        type: 'object',
        required: ['refreshToken'],
        properties: {
          refreshToken: { type: 'string' }
        }
      }
    }
  }, authController.refreshToken)

  // API Token generation for QGIS Plugin
  server.post('/auth/generate-api-token', {
    schema: {
      description: 'Generate API token for QGIS Plugin',
      tags: ['Authentication'],
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 6 },
          pluginName: { type: 'string', default: 'vungu-qgis-plugin' }
        }
      }
    }
  }, authController.generateApiToken)

  // Email API token endpoint
  server.post('/auth/email-token', {
    schema: {
      description: 'Email API token to admin',
      tags: ['Authentication'],
      body: {
        type: 'object',
        required: ['token', 'email'],
        properties: {
          token: { type: 'string' },
          email: { type: 'string', format: 'email' },
          pluginName: { type: 'string', default: 'vungu-qgis-plugin' }
        }
      }
    }
  }, authController.emailApiToken)

  server.post('/auth/logout', {
    schema: {
      description: 'Admin user logout',
      tags: ['Authentication'],
      headers: {
        type: 'object',
        properties: {
          authorization: { type: 'string' }
        },
        required: ['authorization']
      },
      body: {
        type: 'object',
        required: ['refreshToken'],
        properties: {
          refreshToken: { type: 'string' }
        }
      }
    }
  }, authController.logout)

  server.get('/auth/profile', {
    schema: {
      description: 'Get admin user profile',
      tags: ['Authentication'],
      headers: {
        type: 'object',
        properties: {
          authorization: { type: 'string' }
        },
        required: ['authorization']
      }
    }
  }, authController.getProfile)

  server.put('/auth/profile', {
    schema: {
      description: 'Update admin user profile',
      tags: ['Authentication'],
      headers: {
        type: 'object',
        properties: {
          authorization: { type: 'string' }
        },
        required: ['authorization']
      },
      body: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['super_admin', 'data_manager', 'style_manager', 'viewer'] },
          permissions: { type: 'object' }
        }
      }
    }
  }, authController.updateProfile)

  server.get('/auth/check', {
    schema: {
      description: 'Check authentication status',
      tags: ['Authentication'],
      headers: {
        type: 'object',
        properties: {
          authorization: { type: 'string' }
        }
      }
    }
  }, authController.checkAuth)
}
