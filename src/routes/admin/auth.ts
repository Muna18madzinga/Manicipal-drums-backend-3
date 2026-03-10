import { FastifyInstance } from 'fastify'
import { Pool } from 'pg'
import { AuthController } from '../../controllers/admin/authController'
import { AuthMiddleware } from '../../middleware/admin/auth'

export function createAuthRoutes(server: FastifyInstance, pool: Pool) {
  const authController = new AuthController(pool)
  const authMiddleware = new AuthMiddleware(pool)

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

  // Protected routes
  // server.post('/auth/logout', {
  //   preHandler: [authMiddleware.requireAuth],
    schema: {
      description: 'Admin user logout',
      tags: ['Authentication'],
      headers: {
        Authorization: { type: 'string' }
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
    preHandler: [authMiddleware.requireAuth],
    schema: {
      description: 'Get admin user profile',
      tags: ['Authentication'],
      headers: {
        Authorization: { type: 'string' }
      }
    }
  }, authController.getProfile)

  server.put('/auth/profile', {
    preHandler: [authMiddleware.requireAuth, authMiddleware.requirePermission('users.update')],
    schema: {
      description: 'Update admin user profile',
      tags: ['Authentication'],
      headers: {
        Authorization: { type: 'string' }
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
    preHandler: [authMiddleware.optionalAuth],
    schema: {
      description: 'Check authentication status',
      tags: ['Authentication'],
      headers: {
        Authorization: { type: 'string' }
      }
    }
  }, authController.checkAuth)
}
