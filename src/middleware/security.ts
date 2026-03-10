import { FastifyRequest, FastifyReply } from 'fastify';
import RateLimiter from './rateLimiter';
import InputSanitizer from './inputSanitizer';
import SecurityAuditService from '../services/securityAuditService';

class SecurityMiddleware {
  private auditService: SecurityAuditService;

  constructor(auditService: SecurityAuditService) {
    this.auditService = auditService;
  }

  /**
   * Comprehensive security middleware
   */
  securityMiddleware = async (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const startTime = Date.now();
    const clientIP = this.getClientIP(request);
    
    try {
      // Log API call
      await this.auditService.logSecurityEvent({
        event_type: 'API_CALL',
        severity: 'low',
        user_id: (request as any).user?.id,
        ip_address: clientIP,
        user_agent: request.headers['user-agent'],
        details: {
          method: request.method,
          url: request.url,
          path: request.routeOptions?.url
        }
      });

      // Apply input sanitization
      InputSanitizer.middleware(request, reply, done);

    } catch (error) {
      console.error('Security middleware error:', error);
      done();
    }
  };

  /**
   * Authentication event logger
   */
  authLogger = (event: 'LOGIN_SUCCESS' | 'LOGIN_FAILED' | 'LOGOUT') => {
    return async (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
      const clientIP = this.getClientIP(request);
      
      try {
        await this.auditService.logSecurityEvent({
          event_type: event,
          severity: event === 'LOGIN_SUCCESS' ? 'low' : 'medium',
          user_id: event === 'LOGIN_SUCCESS' ? (request as any).user?.id : undefined,
          ip_address: clientIP,
          user_agent: request.headers['user-agent'],
          details: {
            method: request.method,
            url: request.url,
            timestamp: new Date().toISOString()
          }
        });
      } catch (error) {
        console.error('Auth logger error:', error);
      }
      
      done();
    };
  };

  /**
   * Suspicious activity detector
   */
  suspiciousActivityDetector = async (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const clientIP = this.getClientIP(request);
    
    try {
      // Check for common attack patterns
      const suspiciousPatterns = [
        /\.\.\//,  // Path traversal
        /<script/i,  // XSS attempts
        /union.*select/i,  // SQL injection
        /javascript:/i,  // JavaScript protocol
        /data:.*base64/i  // Data URLs
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
    } catch (error) {
      console.error('Suspicious activity detector error:', error);
    }
    
    done();
  };

  /**
   * Request size limiter
   */
  requestSizeLimiter = (maxSize: number = 10 * 1024 * 1024) => {
    return (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
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
  ipFilter = (options: { whitelist?: string[], blacklist?: string[] }) => {
    return (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
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
  private getClientIP(request: FastifyRequest): string {
    return (request.headers['x-forwarded-for'] as string)?.split(',')[0] ||
           (request.headers['x-real-ip'] as string) ||
           request.ip ||
           'unknown';
  }

  /**
   * Create rate limiters for different purposes
   */
  static createRateLimiters() {
    return {
      auth: RateLimiter.createAuthLimiter(),
      api: RateLimiter.createApiLimiter(),
      upload: RateLimiter.createUploadLimiter()
    };
  }
}

export default SecurityMiddleware;
