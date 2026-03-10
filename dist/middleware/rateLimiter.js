"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class RateLimiter {
    store = {};
    windowMs;
    maxRequests;
    constructor(windowMs = 15 * 60 * 1000, maxRequests = 100) {
        this.windowMs = windowMs;
        this.maxRequests = maxRequests;
        // Clean up expired entries every minute
        setInterval(() => this.cleanup(), 60 * 1000);
    }
    middleware = (request, reply) => {
        const key = this.getKey(request);
        const now = Date.now();
        const record = this.store[key];
        if (!record || now > record.resetTime) {
            // New window or expired window
            this.store[key] = {
                count: 1,
                resetTime: now + this.windowMs
            };
            return;
        }
        if (record.count >= this.maxRequests) {
            return reply.status(429).send({
                error: 'Too Many Requests',
                message: `Rate limit exceeded. Try again in ${Math.ceil((record.resetTime - now) / 1000)} seconds.`,
                retryAfter: Math.ceil((record.resetTime - now) / 1000)
            });
        }
        record.count++;
    };
    getKey(request) {
        // Use IP address for rate limiting
        const ip = request.headers['x-forwarded-for'] ||
            request.headers['x-real-ip'] ||
            request.ip;
        return ip || 'unknown';
    }
    cleanup() {
        const now = Date.now();
        Object.keys(this.store).forEach(key => {
            if (now > this.store[key].resetTime) {
                delete this.store[key];
            }
        });
    }
    // Create different limiters for different endpoints
    static createAuthLimiter() {
        return new RateLimiter(15 * 60 * 1000, 5); // 5 requests per 15 minutes for auth
    }
    static createApiLimiter() {
        return new RateLimiter(15 * 60 * 1000, 100); // 100 requests per 15 minutes for API
    }
    static createUploadLimiter() {
        return new RateLimiter(60 * 60 * 1000, 10); // 10 uploads per hour
    }
}
exports.default = RateLimiter;
//# sourceMappingURL=rateLimiter.js.map