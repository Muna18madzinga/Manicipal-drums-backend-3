import { FastifyRequest, FastifyReply } from 'fastify';
import RateLimiter from './rateLimiter';
import SecurityAuditService from '../services/securityAuditService';
declare class SecurityMiddleware {
    private auditService;
    constructor(auditService: SecurityAuditService);
    /**
     * Comprehensive security middleware
     */
    securityMiddleware: (request: FastifyRequest, reply: FastifyReply, done: () => void) => Promise<void>;
    /**
     * Authentication event logger
     */
    authLogger: (event: "LOGIN_SUCCESS" | "LOGIN_FAILED" | "LOGOUT") => (request: FastifyRequest, reply: FastifyReply, done: () => void) => Promise<void>;
    /**
     * Suspicious activity detector
     */
    suspiciousActivityDetector: (request: FastifyRequest, reply: FastifyReply, done: () => void) => Promise<void>;
    /**
     * Request size limiter
     */
    requestSizeLimiter: (maxSize?: number) => (request: FastifyRequest, reply: FastifyReply, done: () => void) => FastifyReply<import("fastify").RouteGenericInterface, import("fastify").RawServerDefault, import("http").IncomingMessage, import("http").ServerResponse<import("http").IncomingMessage>, unknown, import("fastify").FastifySchema, import("fastify").FastifyTypeProviderDefault, unknown> | undefined;
    /**
     * IP whitelist/blacklist middleware
     */
    ipFilter: (options: {
        whitelist?: string[];
        blacklist?: string[];
    }) => (request: FastifyRequest, reply: FastifyReply, done: () => void) => FastifyReply<import("fastify").RouteGenericInterface, import("fastify").RawServerDefault, import("http").IncomingMessage, import("http").ServerResponse<import("http").IncomingMessage>, unknown, import("fastify").FastifySchema, import("fastify").FastifyTypeProviderDefault, unknown> | undefined;
    /**
     * Get client IP address
     */
    private getClientIP;
    /**
     * Create rate limiters for different purposes
     */
    static createRateLimiters(): {
        auth: RateLimiter;
        api: RateLimiter;
        upload: RateLimiter;
    };
}
export default SecurityMiddleware;
//# sourceMappingURL=security.d.ts.map