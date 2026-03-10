"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const rateLimiter_1 = __importDefault(require("./rateLimiter"));
const inputSanitizer_1 = __importDefault(require("./inputSanitizer"));
class SecurityMiddleware {
    auditService;
    constructor(auditService) {
        this.auditService = auditService;
    }
    /**
     * Comprehensive security middleware
     */
    securityMiddleware = async (request, reply, done) => {
        const startTime = Date.now();
        const clientIP = this.getClientIP(request);
        try {
            // Log API call
            await this.auditService.logSecurityEvent({
                event_type: 'API_CALL',
                severity: 'low',
                user_id: request.user?.id,
                ip_address: clientIP,
                user_agent: request.headers['user-agent'],
                details: {
                    method: request.method,
                    url: request.url,
                    path: request.routeOptions?.url
                }
            });
            // Apply input sanitization
            inputSanitizer_1.default.middleware(request, reply, done);
        }
        catch (error) {
            console.error('Security middleware error:', error);
            done();
        }
    };
    /**
     * Authentication event logger
     */
    authLogger = (event) => {
        return async (request, reply, done) => {
            const clientIP = this.getClientIP(request);
            try {
                await this.auditService.logSecurityEvent({
                    event_type: event,
                    severity: event === 'LOGIN_SUCCESS' ? 'low' : 'medium',
                    user_id: event === 'LOGIN_SUCCESS' ? request.user?.id : undefined,
                    ip_address: clientIP,
                    user_agent: request.headers['user-agent'],
                    details: {
                        method: request.method,
                        url: request.url,
                        timestamp: new Date().toISOString()
                    }
                });
            }
            catch (error) {
                console.error('Auth logger error:', error);
            }
            done();
        };
    };
    /**
     * Suspicious activity detector
     */
    suspiciousActivityDetector = async (request, reply, done) => {
        const clientIP = this.getClientIP(request);
        try {
            // Check for common attack patterns
            const suspiciousPatterns = [
                /\.\.\//, // Path traversal
                /<script/i, // XSS attempts
                /union.*select/i, // SQL injection
                /javascript:/i, // JavaScript protocol
                /data:.*base64/i // Data URLs
            ];
            const url = request.url.toLowerCase();
            const userAgent = (request.headers['user-agent'] || '').toLowerCase();
            for (const pattern of suspiciousPatterns) {
                if (pattern.test(url) || pattern.test(userAgent)) {
                    await this.auditService.logSecurityEvent({
                        event_type: 'SUSPICIOUS_PATTERN',
                        severity: 'high',
                        ip_address: clientIP,
                        user_agent: request.headers['user-agent'],
                        details: {
                            pattern: pattern.toString(),
                            url: request.url,
                            user_agent: request.headers['user-agent']
                        }
                    });
                    break;
                }
            }
        }
        catch (error) {
            console.error('Suspicious activity detector error:', error);
        }
        done();
    };
    /**
     * Request size limiter
     */
    requestSizeLimiter = (maxSize = 10 * 1024 * 1024) => {
        return (request, reply, done) => {
            const contentLength = parseInt(request.headers['content-length'] || '0');
            if (contentLength > maxSize) {
                return reply.status(413).send({
                    error: 'Payload Too Large',
                    message: `Request size ${contentLength} exceeds maximum allowed size of ${maxSize} bytes`
                });
            }
            done();
        };
    };
    /**
     * IP whitelist/blacklist middleware
     */
    ipFilter = (options) => {
        return (request, reply, done) => {
            const clientIP = this.getClientIP(request);
            // Check blacklist first
            if (options.blacklist && options.blacklist.includes(clientIP)) {
                return reply.status(403).send({
                    error: 'Forbidden',
                    message: 'Access denied from this IP address'
                });
            }
            // Check whitelist if provided
            if (options.whitelist && !options.whitelist.includes(clientIP)) {
                return reply.status(403).send({
                    error: 'Forbidden',
                    message: 'Access not allowed from this IP address'
                });
            }
            done();
        };
    };
    /**
     * Get client IP address
     */
    getClientIP(request) {
        return request.headers['x-forwarded-for']?.split(',')[0] ||
            request.headers['x-real-ip'] ||
            request.ip ||
            'unknown';
    }
    /**
     * Create rate limiters for different purposes
     */
    static createRateLimiters() {
        return {
            auth: rateLimiter_1.default.createAuthLimiter(),
            api: rateLimiter_1.default.createApiLimiter(),
            upload: rateLimiter_1.default.createUploadLimiter()
        };
    }
}
exports.default = SecurityMiddleware;
//# sourceMappingURL=security.js.map