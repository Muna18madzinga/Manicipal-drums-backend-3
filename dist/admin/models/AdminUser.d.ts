import { Pool } from 'pg';
export interface AdminUser {
    id: string;
    user_id: string;
    role: AdminRole;
    permissions: Record<string, any>;
    created_at: Date;
    updated_at: Date;
    last_login?: Date;
    is_active: boolean;
}
export declare enum AdminRole {
    SUPER_ADMIN = "super_admin",
    DATA_MANAGER = "data_manager",
    STYLE_MANAGER = "style_manager",
    VIEWER = "viewer"
}
export interface JWTPayload {
    sub: string;
    email: string;
    role: AdminRole;
    permissions: string[];
    iat: number;
    exp: number;
    sessionId: string;
}
export declare class AdminUserModel {
    private pool;
    constructor(pool: Pool);
    findByUserId(userId: string): Promise<AdminUser | null>;
    findById(id: string): Promise<AdminUser | null>;
    create(userData: {
        user_id: string;
        role: AdminRole;
        permissions?: Record<string, any>;
    }): Promise<AdminUser>;
    updateLastLogin(id: string): Promise<void>;
    updateRole(id: string, role: AdminRole, permissions?: Record<string, any>): Promise<AdminUser>;
    deactivate(id: string): Promise<void>;
    getAll(): Promise<AdminUser[]>;
    private getDefaultPermissions;
    hasPermission(userId: string, permission: string): Promise<boolean>;
}
//# sourceMappingURL=AdminUser.d.ts.map