"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const AdminUser_1 = require("../../models/AdminUser");
const AdminUser_2 = require("../../models/AdminUser");
class AuthService {
    jwtSecret;
    jwtRefreshSecret;
    tokenExpiry;
    refreshExpiry;
    adminUserModel;
    constructor(pool) {
        this.jwtSecret = process.env.JWT_SECRET || 'your-secret-key';
        this.jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || 'your-refresh-secret';
        this.tokenExpiry = process.env.JWT_EXPIRY || '15m';
        this.refreshExpiry = process.env.JWT_REFRESH_EXPIRY || '7d';
        this.adminUserModel = new AdminUser_2.AdminUserModel(pool);
    }
    async login(credentials) {
        // Find user by email (assuming users table has email)
        const userQuery = `
      SELECT id, email, password_hash, is_active
      FROM users
      WHERE email = $1 AND is_active = true
    `;
        const userResult = await this.adminUserModel['pool'].query(userQuery, [credentials.email]);
        if (!userResult.rows[0]) {
            throw new Error('Invalid credentials');
        }
        const user = userResult.rows[0];
        // Verify password
        const isPasswordValid = await bcryptjs_1.default.compare(credentials.password, user.password_hash);
        if (!isPasswordValid) {
            throw new Error('Invalid credentials');
        }
        // Check if user is admin
        const adminUser = await this.adminUserModel.findByUserId(user.id);
        if (!adminUser) {
            throw new Error('Access denied: User is not an admin');
        }
        // Generate tokens
        const sessionId = this.generateSessionId();
        const permissions = this.extractPermissions(adminUser);
        const payload = {
            sub: user.id,
            email: user.email,
            role: adminUser.role,
            permissions,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + this.parseExpiry(this.tokenExpiry),
            sessionId
        };
        const token = jsonwebtoken_1.default.sign(payload, this.jwtSecret);
        const refreshToken = jsonwebtoken_1.default.sign({ sub: user.id, sessionId }, this.jwtRefreshSecret, { expiresIn: this.refreshExpiry });
        // Update last login
        await this.adminUserModel.updateLastLogin(adminUser.id);
        return {
            token,
            refreshToken,
            user: adminUser,
            permissions,
            expiresIn: this.parseExpiry(this.tokenExpiry)
        };
    }
    async refreshToken(refreshToken) {
        try {
            const decoded = jsonwebtoken_1.default.verify(refreshToken, this.jwtRefreshSecret);
            // Find admin user
            const adminUser = await this.adminUserModel.findByUserId(decoded.sub);
            if (!adminUser) {
                throw new Error('User not found');
            }
            // Generate new access token
            const sessionId = this.generateSessionId();
            const permissions = this.extractPermissions(adminUser);
            const payload = {
                sub: decoded.sub,
                email: adminUser.user_id, // This should come from users table
                role: adminUser.role,
                permissions,
                iat: Math.floor(Date.now() / 1000),
                exp: Math.floor(Date.now() / 1000) + this.parseExpiry(this.tokenExpiry),
                sessionId
            };
            const token = jsonwebtoken_1.default.sign(payload, this.jwtSecret);
            return {
                token,
                permissions,
                expiresIn: this.parseExpiry(this.tokenExpiry)
            };
        }
        catch (error) {
            throw new Error('Invalid refresh token');
        }
    }
    async verifyToken(token) {
        try {
            const decoded = jsonwebtoken_1.default.verify(token, this.jwtSecret);
            // Verify user is still active admin
            const adminUser = await this.adminUserModel.findByUserId(decoded.sub);
            if (!adminUser) {
                throw new Error('User not found or inactive');
            }
            return decoded;
        }
        catch (error) {
            throw new Error('Invalid token');
        }
    }
    async logout(sessionId) {
        // In a real implementation, you would:
        // 1. Add the session ID to a blacklist in Redis
        // 2. Or remove the refresh token from the database
        // For now, we'll just log it
        console.log(`Session ${sessionId} logged out`);
    }
    generateSessionId() {
        return Math.random().toString(36).substring(2, 15) +
            Math.random().toString(36).substring(2, 15);
    }
    extractPermissions(adminUser) {
        const permissions = [];
        if (adminUser.role === AdminUser_1.AdminRole.SUPER_ADMIN) {
            return ['all'];
        }
        const extractFromObject = (obj, prefix = '') => {
            for (const [key, value] of Object.entries(obj)) {
                const permission = prefix ? `${prefix}.${key}` : key;
                if (value === true) {
                    permissions.push(permission);
                }
                else if (typeof value === 'object' && value !== null) {
                    extractFromObject(value, permission);
                }
            }
        };
        extractFromObject(adminUser.permissions);
        return permissions;
    }
    parseExpiry(expiry) {
        const unit = expiry.slice(-1);
        const value = parseInt(expiry.slice(0, -1));
        switch (unit) {
            case 's': return value;
            case 'm': return value * 60;
            case 'h': return value * 3600;
            case 'd': return value * 86400;
            default: return 900; // Default 15 minutes
        }
    }
    async hashPassword(password) {
        const saltRounds = 12;
        return bcryptjs_1.default.hash(password, saltRounds);
    }
    async verifyPassword(password, hash) {
        return bcryptjs_1.default.compare(password, hash);
    }
}
exports.AuthService = AuthService;
//# sourceMappingURL=authService.js.map