"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const authService_1 = require("../../services/admin/authService");
const AdminUser_1 = require("../../models/AdminUser");
class AuthController {
    authService;
    adminUserModel;
    constructor(pool) {
        this.authService = new authService_1.AuthService(pool);
        this.adminUserModel = new AdminUser_1.AdminUserModel(pool);
    }
    login = async (request, reply) => {
        try {
            const { email, password, mfaCode } = request.body;
            // Validate input
            if (!email || !password) {
                res.status(400).json({
                    error: 'Missing credentials',
                    message: 'Email and password are required'
                });
                return;
            }
            // Validate email format
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                res.status(400).json({
                    error: 'Invalid email',
                    message: 'Please provide a valid email address'
                });
                return;
            }
            // Attempt login
            const authResponse = await this.authService.login({ email, password, mfaCode });
            // Set refresh token in HTTP-only cookie
            res.cookie('refreshToken', authResponse.refreshToken, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
            });
            // Return success response (without refresh token)
            res.status(200).json({
                success: true,
                message: 'Login successful',
                data: {
                    token: authResponse.token,
                    user: {
                        id: authResponse.user.id,
                        user_id: authResponse.user.user_id,
                        role: authResponse.user.role,
                        permissions: authResponse.permissions,
                        last_login: authResponse.user.last_login
                    },
                    permissions: authResponse.permissions,
                    expiresIn: authResponse.expiresIn
                }
            });
        }
        catch (error) {
            console.error('Login error:', error);
            if (error.message === 'Invalid credentials') {
                res.status(401).json({
                    error: 'Authentication failed',
                    message: 'Invalid email or password'
                });
                return;
            }
            if (error.message === 'Access denied: User is not an admin') {
                res.status(403).json({
                    error: 'Access denied',
                    message: 'You do not have admin privileges'
                });
                return;
            }
            res.status(500).json({
                error: 'Login failed',
                message: 'An error occurred during login'
            });
        }
    };
    refreshToken = async (req, res) => {
        try {
            const refreshToken = req.cookies?.refreshToken || req.body?.refreshToken;
            if (!refreshToken) {
                res.status(401).json({
                    error: 'No refresh token',
                    message: 'Refresh token is required'
                });
                return;
            }
            const refreshResponse = await this.authService.refreshToken(refreshToken);
            res.status(200).json({
                success: true,
                message: 'Token refreshed successfully',
                data: refreshResponse
            });
        }
        catch (error) {
            console.error('Refresh token error:', error);
            if (error.message === 'Invalid refresh token') {
                res.status(401).json({
                    error: 'Invalid refresh token',
                    message: 'Please login again'
                });
                return;
            }
            res.status(500).json({
                error: 'Token refresh failed',
                message: 'An error occurred while refreshing the token'
            });
        }
    };
    logout = async (req, res) => {
        try {
            const refreshToken = req.cookies?.refreshToken;
            const sessionId = req.user?.sessionId;
            // Clear refresh token cookie
            res.clearCookie('refreshToken');
            // Logout from auth service
            if (sessionId) {
                await this.authService.logout(sessionId);
            }
            res.status(200).json({
                success: true,
                message: 'Logout successful'
            });
        }
        catch (error) {
            console.error('Logout error:', error);
            res.status(500).json({
                error: 'Logout failed',
                message: 'An error occurred during logout'
            });
        }
    };
    getProfile = async (req, res) => {
        try {
            if (!req.user) {
                res.status(401).json({
                    error: 'Not authenticated',
                    message: 'User is not authenticated'
                });
                return;
            }
            // Get full admin user details
            const adminUser = await this.adminUserModel.findById(req.user.sub);
            if (!adminUser) {
                res.status(404).json({
                    error: 'User not found',
                    message: 'Admin user not found'
                });
                return;
            }
            res.status(200).json({
                success: true,
                data: {
                    user: {
                        id: adminUser.id,
                        user_id: adminUser.user_id,
                        role: adminUser.role,
                        permissions: adminUser.permissions,
                        created_at: adminUser.created_at,
                        last_login: adminUser.last_login,
                        is_active: adminUser.is_active
                    },
                    currentPermissions: req.permissions
                }
            });
        }
        catch (error) {
            console.error('Get profile error:', error);
            res.status(500).json({
                error: 'Profile fetch failed',
                message: 'An error occurred while fetching profile'
            });
        }
    };
    updateProfile = async (req, res) => {
        try {
            if (!req.user) {
                res.status(401).json({
                    error: 'Not authenticated',
                    message: 'User is not authenticated'
                });
                return;
            }
            const { role, permissions } = req.body;
            // Only super admins can update roles
            if (req.user.role !== 'super_admin' && (role || permissions)) {
                res.status(403).json({
                    error: 'Insufficient permissions',
                    message: 'Only super admins can update roles and permissions'
                });
                return;
            }
            // Update user
            const updatedUser = await this.adminUserModel.updateRole(req.user.sub, role, permissions);
            res.status(200).json({
                success: true,
                message: 'Profile updated successfully',
                data: {
                    user: updatedUser
                }
            });
        }
        catch (error) {
            console.error('Update profile error:', error);
            res.status(500).json({
                error: 'Profile update failed',
                message: 'An error occurred while updating profile'
            });
        }
    };
    checkAuth = async (req, res) => {
        try {
            if (!req.user) {
                res.status(401).json({
                    authenticated: false,
                    message: 'No valid authentication found'
                });
                return;
            }
            res.status(200).json({
                authenticated: true,
                user: {
                    id: req.user.sub,
                    email: req.user.email,
                    role: req.user.role,
                    permissions: req.permissions
                }
            });
        }
        catch (error) {
            console.error('Check auth error:', error);
            res.status(500).json({
                authenticated: false,
                error: 'Auth check failed',
                message: 'An error occurred while checking authentication'
            });
        }
    };
}
exports.AuthController = AuthController;
//# sourceMappingURL=authController.js.map