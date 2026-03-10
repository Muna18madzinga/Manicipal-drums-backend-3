"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class InputSanitizer {
    static middleware = (request, reply, done) => {
        // Sanitize query parameters
        if (request.query) {
            request.query = this.sanitizeObject(request.query);
        }
        // Sanitize request body
        if (request.body) {
            request.body = this.sanitizeObject(request.body);
        }
        // Sanitize path parameters
        if (request.params) {
            request.params = this.sanitizeObject(request.params);
        }
        done();
    };
    static sanitizeObject(obj) {
        if (typeof obj !== 'object' || obj === null) {
            return this.sanitizeValue(obj);
        }
        if (Array.isArray(obj)) {
            return obj.map(item => this.sanitizeObject(item));
        }
        const sanitized = {};
        for (const [key, value] of Object.entries(obj)) {
            // Sanitize key names
            const sanitizedKey = this.sanitizeString(key);
            if (sanitizedKey) {
                sanitized[sanitizedKey] = this.sanitizeObject(value);
            }
        }
        return sanitized;
    }
    static sanitizeValue(value) {
        if (typeof value === 'string') {
            return this.sanitizeString(value);
        }
        if (typeof value === 'number') {
            return isNaN(value) ? 0 : value;
        }
        if (typeof value === 'boolean') {
            return value;
        }
        if (value === null || value === undefined) {
            return value;
        }
        // For other types, convert to string and sanitize
        return this.sanitizeString(String(value));
    }
    static sanitizeString(str) {
        if (!str)
            return str;
        return str
            // Remove potentially dangerous characters
            .replace(/[<>]/g, '')
            // Remove SQL injection patterns
            .replace(/[';\\]/g, '')
            // Remove dangerous SQL keywords
            .replace(/\b(ALTER|CREATE|DELETE|DROP|EXEC|INSERT|MERGE|SELECT|UPDATE|UNION)\b/gi, '')
            // Remove script tags
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            // Remove JavaScript event handlers
            .replace(/on\w+\s*=/gi, '')
            // Remove javascript: protocol
            .replace(/javascript:/gi, '')
            // Trim whitespace
            .trim();
    }
    // Specific sanitizers for different data types
    static sanitizeEmail(email) {
        if (!email)
            return email;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const sanitized = this.sanitizeString(email.toLowerCase());
        return emailRegex.test(sanitized) ? sanitized : '';
    }
    static sanitizePhoneNumber(phone) {
        if (!phone)
            return phone;
        // Keep only digits, plus, hyphen, and parentheses
        return phone.replace(/[^\d\+\-\(\)\s]/g, '');
    }
    static sanitizeFilename(filename) {
        if (!filename)
            return filename;
        // Remove path traversal characters and keep safe filename characters
        return filename.replace(/[\\\/:*?"<>|]/g, '').replace(/\.\./g, '');
    }
    static sanitizeSQL(query) {
        if (!query)
            return query;
        // Basic SQL injection protection
        return query.replace(/[';\\]/g, '');
    }
}
exports.default = InputSanitizer;
//# sourceMappingURL=inputSanitizer.js.map