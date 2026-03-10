"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthRoutes = createAuthRoutes;
const authController_1 = require("../../controllers/admin/authController");
const auth_1 = require("../../middleware/admin/auth");
function createAuthRoutes(server, pool) {
    const authController = new authController_1.AuthController(pool);
    const authMiddleware = new auth_1.AuthMiddleware(pool);
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
    }, authController.login);
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
    }, authController.refreshToken);
    // Protected routes
    server.post('/auth/logout', {
        preHandler: [authMiddleware.requireAuth],
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
    }, authController.logout);
    server.get('/auth/profile', {
        preHandler: [authMiddleware.requireAuth],
        schema: {
            description: 'Get admin user profile',
            tags: ['Authentication'],
            headers: {
                Authorization: { type: 'string' }
            }
        }
    }, authController.getProfile);
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
    }, authController.updateProfile);
    server.get('/auth/check', {
        preHandler: [authMiddleware.optionalAuth],
        schema: {
            description: 'Check authentication status',
            tags: ['Authentication'],
            headers: {
                Authorization: { type: 'string' }
            }
        }
    }, authController.checkAuth);
}
//# sourceMappingURL=auth.js.map