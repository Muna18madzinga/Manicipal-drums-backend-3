"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthMiddleware = exports.AuthMiddleware = void 0;
const authService_1 = require("../../services/admin/authService");
class AuthMiddleware {
    authService;
    constructor(pool) {
        this.authService = new authService_1.AuthService(pool);
    }
    requireAuth = async (req, res, next) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                res.status(401).json({
                    error: 'No token provided',
                    message: 'Authorization header required'
                });
                return;
            }
            const token = authHeader.replace('Bearer ', '');
            try {
                const payload = await this.authService.verifyToken(token);
                req.user = payload;
                req.permissions = payload.permissions;
                next();
            }
            catch (tokenError) {
                res.status(401).json({
                    error: 'Invalid token',
                    message: 'Token is invalid or expired'
                });
                return;
            }
        }
        catch (error) {
            console.error('Auth middleware error:', error);
            res.status(500).json({
                error: 'Authentication error',
                message: 'Internal server error during authentication'
            });
        }
    };
    requirePermission = (permission) => {
        return async (req, res, next) => {
            try {
                if (!req.user) {
                    res.status(401).json({
                        error: 'Authentication required',
                        message: 'User not authenticated'
                    });
                    return;
                }
                // Super admin has all permissions
                if (req.user.role === 'super_admin') {
                    next();
                    return;
                }
                // Check specific permission
                const hasPermission = this.checkPermission(req.user.permissions, permission);
                if (!hasPermission) {
                    res.status(403).json({
                        error: 'Insufficient permissions',
                        message: `Permission '${permission}' required`,
                        required: permission,
                        userPermissions: req.user.permissions
                    });
                    return;
                }
                next();
            }
            catch (error) {
                console.error('Permission middleware error:', error);
                res.status(500).json({
                    error: 'Permission check error',
                    message: 'Internal server error during permission check'
                });
            }
        };
    };
    requireRole = (role) => {
        return async (req, res, next) => {
            try {
                if (!req.user) {
                    res.status(401).json({
                        error: 'Authentication required',
                        message: 'User not authenticated'
                    });
                    return;
                }
                if (req.user.role !== role) {
                    res.status(403).json({
                        error: 'Insufficient role',
                        message: `Role '${role}' required`,
                        required: role,
                        userRole: req.user.role
                    });
                    return;
                }
                next();
            }
            catch (error) {
                console.error('Role middleware error:', error);
                res.status(500).json({
                    error: 'Role check error',
                    message: 'Internal server error during role check'
                });
            }
        };
    };
    optionalAuth = async (req, res, next) => {
        try {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                const token = authHeader.replace('Bearer ', '');
                try {
                    const payload = await this.authService.verifyToken(token);
                    req.user = payload;
                    req.permissions = payload.permissions;
                }
                catch (tokenError) {
                    // Token is invalid, but we don't block the request
                    console.log('Optional auth: Invalid token provided');
                }
            }
            next();
        }
        catch (error) {
            console.error('Optional auth middleware error:', error);
            next(); // Continue even if auth fails
        }
    };
    checkPermission(userPermissions, requiredPermission) {
        // Check for "all" permission
        if (userPermissions.includes('all')) {
            return true;
        }
        // Check for exact permission match
        if (userPermissions.includes(requiredPermission)) {
            return true;
        }
        // Check for parent permissions (e.g., "data" matches "data.create")
        const permissionParts = requiredPermission.split('.');
        for (let i = permissionParts.length - 1; i > 0; i--) {
            const parentPermission = permissionParts.slice(0, i).join('.');
            if (userPermissions.includes(parentPermission)) {
                return true;
            }
        }
        return false;
    }
}
exports.AuthMiddleware = AuthMiddleware;
// Factory function to create middleware with pool
const createAuthMiddleware = (pool) => {
    return new AuthMiddleware(pool);
};
exports.createAuthMiddleware = createAuthMiddleware;
//# sourceMappingURL=auth.js.map