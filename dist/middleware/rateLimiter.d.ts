import { FastifyRequest, FastifyReply } from 'fastify';
declare class RateLimiter {
    private store;
    private windowMs;
    private maxRequests;
    constructor(windowMs?: number, maxRequests?: number);
    middleware: (request: FastifyRequest, reply: FastifyReply) => FastifyReply<import("fastify").RouteGenericInterface, import("fastify").RawServerDefault, import("http").IncomingMessage, import("http").ServerResponse<import("http").IncomingMessage>, unknown, import("fastify").FastifySchema, import("fastify").FastifyTypeProviderDefault, unknown> | undefined;
    private getKey;
    private cleanup;
    static createAuthLimiter(): RateLimiter;
    static createApiLimiter(): RateLimiter;
    static createUploadLimiter(): RateLimiter;
}
export default RateLimiter;
//# sourceMappingURL=rateLimiter.d.ts.map