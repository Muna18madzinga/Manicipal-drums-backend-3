"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = require("@fastify/cors");
const swagger_1 = require("@fastify/swagger");
const swagger_ui_1 = require("@fastify/swagger-ui");
const compress_1 = require("@fastify/compress");
const rate_limit_1 = require("@fastify/rate-limit");
const postgres_1 = require("@fastify/postgres");
async function createServer() {
    const server = (0, fastify_1.default)({
        logger: true,
        trustProxy: true
    });
    // Register plugins
    await server.register(cors_1.fastifyCors, {
        origin: process.env.NODE_ENV === 'production'
            ? ['https://vungu-rdc.org']
            : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175', 'http://localhost:3000', 'http://127.0.0.1:58487']
    });
    await server.register(swagger_1.fastifySwagger, {
        swagger: {
            info: {
                title: 'Vungu Master Plan API',
                description: 'Unified backend for Vungu Spatial Data Portal and Administration',
                version: '1.0.0'
            }
        }
    });
    await server.register(swagger_ui_1.fastifySwaggerUi, {
        routePrefix: '/docs'
    });
    await server.register(compress_1.fastifyCompress);
    await server.register(rate_limit_1.fastifyRateLimit, {
        max: 100,
        timeWindow: '1 minute'
    });
    await server.register(postgres_1.fastifyPostgres, {
        connectionString: process.env.DATABASE_URL || 'postgresql://postgres:cairo2025@localhost:5432/vungu_master_db'
    });
    // Health check - register first
    server.get('/health', async (request, reply) => {
        return { status: 'ok', timestamp: new Date().toISOString() };
    });
    // Test route
    server.get('/api/test', async (request, reply) => {
        return { message: 'Main server routes working', timestamp: new Date().toISOString() };
    });
    // Simple test route
    server.get('/simple-test', async (request, reply) => {
        console.log('🔐 Simple test route called!');
        return { message: 'Simple test working', timestamp: new Date().toISOString() };
    });
    // Auth routes
    server.get('/api/auth/test', async (request, reply) => {
        console.log('🔐 Auth test route called!');
        return { message: 'Auth routes working', timestamp: new Date().toISOString() };
    });
    server.post('/api/auth/login', async (request, reply) => {
        console.log('🔐 Login endpoint called');
        try {
            const { email, password } = request.body;
            // For now, return a simple success response
            if (email === 'admin@vungu.gov.zw' && password === 'admin123') {
                return {
                    token: 'mock-jwt-token',
                    user: {
                        id: 'admin-id',
                        email: 'admin@vungu.gov.zw',
                        name: 'Admin User',
                        role: 'admin',
                        organization: 'Vungu RDC'
                    }
                };
            }
            else {
                return reply.code(401).send({ error: 'Invalid credentials' });
            }
        }
        catch (error) {
            console.error('Login error:', error);
            return reply.code(500).send({ error: 'Login failed' });
        }
    });
    console.log('🔐 All routes registered successfully');
    // Debug: Check what routes are actually registered
    console.log('🔐 Registered routes:', Object.keys(server).includes('routes'));
    console.log('🔐 Server instance type:', server.constructor.name);
    return server;
}
async function start() {
    console.log('🚀 Starting server...');
    try {
        const server = await createServer();
        const port = parseInt(process.env.PORT || '3000');
        console.log('🚀 About to listen on port:', port);
        await server.listen({ port, host: '0.0.0.0' });
        console.log(` Server running on http://localhost:${port}`);
        console.log(` API Documentation: http://localhost:${port}/docs`);
    }
    catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}
start();
//# sourceMappingURL=server.js.map