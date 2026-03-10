"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRoutes = authRoutes;
function authRoutes(fastify) {
    console.log('🔐 Auth routes registering...');
    // Test endpoint
    fastify.get('/test', async (request, reply) => {
        return { message: 'Auth routes working', timestamp: new Date().toISOString() };
    });
    // Simple login endpoint without JWT for testing
    fastify.post('/login', async (request, reply) => {
        console.log('🔐 Login endpoint called');
        return { message: 'Login endpoint working' };
    });
}
//# sourceMappingURL=auth.js.map