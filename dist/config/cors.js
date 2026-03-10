"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.corsConfig = void 0;
exports.corsConfig = {
    // Development configuration
    development: {
        origin: ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: [
            'Origin',
            'X-Requested-With',
            'Accept',
            'Authorization',
            'Content-Type',
            'Cache-Control',
            'Pragma'
        ],
        exposedHeaders: ['X-Total-Count', 'X-Page-Count'],
        maxAge: 86400 // 24 hours
    },
    // Production configuration
    production: {
        origin: (origin, callback) => {
            // Allow specific origins in production
            const allowedOrigins = [
                'https://vungu.gov.zw',
                'https://admin.vungu.gov.zw',
                'https://portal.vungu.gov.zw'
            ];
            // Allow requests with no origin (mobile apps, curl, etc.)
            if (!origin)
                return callback(null, true);
            if (allowedOrigins.includes(origin)) {
                callback(null, true);
            }
            else {
                callback(new Error('Not allowed by CORS'));
            }
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        allowedHeaders: [
            'Origin',
            'X-Requested-With',
            'Accept',
            'Authorization',
            'Content-Type'
        ],
        exposedHeaders: ['X-Total-Count'],
        maxAge: 3600 // 1 hour
    },
    // Get configuration based on environment
    getConfig: function () {
        const env = process.env.NODE_ENV || 'development';
        return this[env] || this.development;
    }
};
exports.default = exports.corsConfig;
//# sourceMappingURL=cors.js.map