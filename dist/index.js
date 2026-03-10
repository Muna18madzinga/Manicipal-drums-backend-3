"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const cors_1 = __importDefault(require("@fastify/cors"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const compress_1 = __importDefault(require("@fastify/compress"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const multipart_1 = __importDefault(require("@fastify/multipart"));
const pg_1 = require("pg");
const auth_1 = require("./routes/admin/auth");
const ingestion_1 = require("./routes/admin/ingestion");
const styles_1 = require("./routes/admin/styles");
const validation_1 = require("./routes/admin/validation");
const audit_1 = require("./routes/admin/audit");
const monitoring_1 = require("./routes/admin/monitoring");
const qgis_1 = require("./routes/qgis");
const securityAuditService_1 = __importDefault(require("./services/securityAuditService"));
const styleSyncService_1 = __importDefault(require("./services/styleSyncService"));
const performanceMonitorService_1 = __importDefault(require("./services/performanceMonitorService"));
// Initialize Fastify app
const app = (0, fastify_1.default)({
    logger: {
        level: process.env.LOG_LEVEL || 'info',
        transport: {
            target: 'pino-pretty'
        }
    },
    trustProxy: true
});
const PORT = parseInt(process.env.ADMIN_PORT || '3001');
// Rate limiting
const limiter = (0, rate_limit_1.default)({
    timeWindow: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
});
// Database connection
const pool = new pg_1.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'vungu_master_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});
// Initialize Phase 5 Services
let securityAuditService;
let styleSyncService;
let performanceMonitorService;
// Initialize services
const initializeServices = async () => {
    try {
        console.log('🚀 Initializing Phase 5 Services...');
        // Initialize Security Audit Service
        securityAuditService = new securityAuditService_1.default(pool);
        await securityAuditService.initialize();
        console.log('✅ Security Audit Service initialized');
        // Initialize Style Sync Service
        styleSyncService = new styleSyncService_1.default();
        console.log('✅ Style Sync Service initialized');
        // Initialize Performance Monitor Service
        performanceMonitorService = new performanceMonitorService_1.default();
        console.log('✅ Performance Monitor Service initialized');
        // Make services globally available
        global.securityAuditService = securityAuditService;
        global.styleSyncService = styleSyncService;
        global.performanceMonitorService = performanceMonitorService;
        console.log('🎉 All Phase 5 Services initialized successfully!');
    }
    catch (error) {
        console.error('❌ Failed to initialize Phase 5 Services:', error);
        throw error;
    }
};
// Test database connection
pool.connect()
    .then(client => {
    app.log.info('✅ Database connected successfully');
    client.release();
})
    .catch(err => {
    app.log.error('❌ Database connection failed:', err);
    process.exit(1);
});
// Register plugins
app.register(cors_1.default, {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
});
app.register(helmet_1.default, {
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
});
app.register(compress_1.default);
app.register(multipart_1.default, {
    limits: {
        fileSize: 100 * 1024 * 1024, // 100MB
    },
});
app.register(rate_limit_1.default, limiter);
// Health check route
app.get('/health', async (request, reply) => {
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        service: 'vungu-admin-api',
        version: '1.0.0'
    };
});
// API Routes
app.register(async function (server) {
    (0, auth_1.createAuthRoutes)(server, pool);
    (0, ingestion_1.createIngestionRoutes)(server, pool);
    (0, styles_1.createStyleRoutes)(server, pool);
    (0, validation_1.createValidationRoutes)(server, pool);
    (0, audit_1.createAuditRoutes)(server, pool);
    (0, monitoring_1.createMonitoringRoutes)(server, pool);
}, { prefix: '/api/admin' });
// QGIS Integration Routes
app.register(async function (server) {
    (0, qgis_1.createQGISRoutes)(server);
}, { prefix: '/api/qgis' });
// Phase 5 Service Routes
app.register(async function (server) {
    // Performance monitoring endpoints
    server.get('/metrics', async (request, reply) => {
        if (performanceMonitorService) {
            return performanceMonitorService.getPerformanceReport();
        }
        return { error: 'Performance monitor not initialized' };
    });
    server.get('/alerts', async (request, reply) => {
        if (performanceMonitorService) {
            return performanceMonitorService.getAlerts();
        }
        return { error: 'Performance monitor not initialized' };
    });
    // Style sync status
    server.get('/style-sync/status', async (request, reply) => {
        if (styleSyncService) {
            return await styleSyncService.getSyncStatus();
        }
        return { error: 'Style sync service not initialized' };
    });
    server.post('/style-sync/force', async (request, reply) => {
        if (styleSyncService) {
            return await styleSyncService.forceSync();
        }
        return { error: 'Style sync service not initialized' };
    });
    // Security audit endpoints
    server.get('/security/metrics', async (request, reply) => {
        if (securityAuditService) {
            return securityAuditService.getMetrics();
        }
        return { error: 'Security audit service not initialized' };
    });
    server.post('/security/audit-log', async (request, reply) => {
        if (securityAuditService) {
            const { event_type, severity, details } = request.body;
            return securityAuditService.logEvent(event_type, severity, details);
        }
        return { error: 'Security audit service not initialized' };
    });
}, { prefix: '/api/phase5' });
// 404 handler
app.setNotFoundHandler(async (request, reply) => {
    reply.status(404).send({
        error: 'Not Found',
        message: `Route ${request.method} ${request.url} not found`,
        timestamp: new Date().toISOString()
    });
});
// Global error handler
app.setErrorHandler(async (error, request, reply) => {
    app.log.error('Unhandled error:', error);
    reply.status(error.statusCode || 500).send({
        error: error.name || 'Internal Server Error',
        message: error.message || 'An unexpected error occurred',
        timestamp: new Date().toISOString(),
        ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
    });
});
// Start server
const start = async () => {
    try {
        // Initialize Phase 5 Services first
        await initializeServices();
        await app.listen({
            port: PORT,
            host: '0.0.0.0'
        });
        app.log.info(`🚀 Vungu Admin API server running on port ${PORT}`);
        app.log.info(`📖 API documentation: http://localhost:${PORT}/api/admin`);
        app.log.info(`🏥 Health check: http://localhost:${PORT}/health`);
        app.log.info(`🔧 QGIS Integration: http://localhost:${PORT}/api/qgis`);
        app.log.info(`📊 Phase 5 Services: http://localhost:${PORT}/api/phase5`);
    }
    catch (err) {
        app.log.error(err);
        process.exit(1);
    }
};
start();
//# sourceMappingURL=index.js.map