import { AdminUser, JWTPayload } from '../../models/AdminUser';
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
export declare class AuthService {
    private readonly jwtSecret;
    private readonly jwtRefreshSecret;
    private readonly tokenExpiry;
    private readonly refreshExpiry;
    private readonly adminUserModel;
    constructor(pool: Pool);
    login(credentials: LoginCredentials): Promise<AuthResponse>;
    refreshToken(refreshToken: string): Promise<Partial<AuthResponse>>;
    verifyToken(token: string): Promise<JWTPayload>;
    logout(sessionId: string): Promise<void>;
    private generateSessionId;
    private extractPermissions;
    private parseExpiry;
    hashPassword(password: string): Promise<string>;
    verifyPassword(password: string, hash: string): Promise<boolean>;
}
//# sourceMappingURL=authService.d.ts.map