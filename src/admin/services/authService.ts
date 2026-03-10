import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { AdminUser, AdminRole, JWTPayload } from '../../models/AdminUser';
import { AdminUserModel } from '../../models/AdminUser';
import { Pool } from 'pg';

export interface LoginCredentials {
  email: string;
  password: string;
  mfaCode?: string;
}

export interface AuthResponse {
  token: string;
  refreshToken: string;
  user: AdminUser;
  permissions: string[];
  expiresIn: number;
}

export class AuthService {
  private readonly jwtSecret: string;
  private readonly jwtRefreshSecret: string;
  private readonly tokenExpiry: string;
  private readonly refreshExpiry: string;
  private readonly adminUserModel: AdminUserModel;

  constructor(pool: Pool) {
    this.jwtSecret = process.env.JWT_SECRET || 'your-secret-key';
    this.jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || 'your-refresh-secret';
    this.tokenExpiry = process.env.JWT_EXPIRY || '15m';
    this.refreshExpiry = process.env.JWT_REFRESH_EXPIRY || '7d';
    this.adminUserModel = new AdminUserModel(pool);
  }

  async login(credentials: LoginCredentials): Promise<AuthResponse> {
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
    const isPasswordValid = await bcrypt.compare(credentials.password, user.password_hash);
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
    
    const payload: JWTPayload = {
      sub: user.id,
      email: user.email,
      role: adminUser.role,
      permissions,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + this.parseExpiry(this.tokenExpiry),
      sessionId
    };

    const token = jwt.sign(payload, this.jwtSecret);
    const refreshToken = jwt.sign(
      { sub: user.id, sessionId },
      this.jwtRefreshSecret,
      { expiresIn: this.refreshExpiry }
    );

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

  async refreshToken(refreshToken: string): Promise<Partial<AuthResponse>> {
    try {
      const decoded = jwt.verify(refreshToken, this.jwtRefreshSecret) as any;
      
      // Find admin user
      const adminUser = await this.adminUserModel.findByUserId(decoded.sub);
      if (!adminUser) {
        throw new Error('User not found');
      }

      // Generate new access token
      const sessionId = this.generateSessionId();
      const permissions = this.extractPermissions(adminUser);
      
      const payload: JWTPayload = {
        sub: decoded.sub,
        email: adminUser.user_id, // This should come from users table
        role: adminUser.role,
        permissions,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + this.parseExpiry(this.tokenExpiry),
        sessionId
      };

      const token = jwt.sign(payload, this.jwtSecret);

      return {
        token,
        permissions,
        expiresIn: this.parseExpiry(this.tokenExpiry)
      };
    } catch (error) {
      throw new Error('Invalid refresh token');
    }
  }

  async verifyToken(token: string): Promise<JWTPayload> {
    try {
      const decoded = jwt.verify(token, this.jwtSecret) as JWTPayload;
      
      // Verify user is still active admin
      const adminUser = await this.adminUserModel.findByUserId(decoded.sub);
      if (!adminUser) {
        throw new Error('User not found or inactive');
      }

      return decoded;
    } catch (error) {
      throw new Error('Invalid token');
    }
  }

  async logout(sessionId: string): Promise<void> {
    // In a real implementation, you would:
    // 1. Add the session ID to a blacklist in Redis
    // 2. Or remove the refresh token from the database
    // For now, we'll just log it
    console.log(`Session ${sessionId} logged out`);
  }

  private generateSessionId(): string {
    return Math.random().toString(36).substring(2, 15) + 
           Math.random().toString(36).substring(2, 15);
  }

  private extractPermissions(adminUser: AdminUser): string[] {
    const permissions: string[] = [];
    
    if (adminUser.role === AdminRole.SUPER_ADMIN) {
      return ['all'];
    }

    const extractFromObject = (obj: any, prefix: string = '') => {
      for (const [key, value] of Object.entries(obj)) {
        const permission = prefix ? `${prefix}.${key}` : key;
        
        if (value === true) {
          permissions.push(permission);
        } else if (typeof value === 'object' && value !== null) {
          extractFromObject(value, permission);
        }
      }
    };

    extractFromObject(adminUser.permissions);
    return permissions;
  }

  private parseExpiry(expiry: string): number {
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

  async hashPassword(password: string): Promise<string> {
    const saltRounds = 12;
    return bcrypt.hash(password, saltRounds);
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }
}
