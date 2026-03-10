import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { JWTPayload } from '../../models/AdminUser';
declare global {
    namespace Express {
        interface Request {
            user?: JWTPayload;
            adminUser?: any;
            permissions?: string[];
        }
    }
}
export declare class AuthMiddleware {
    private authService;
    constructor(pool: Pool);
    requireAuth: (req: Request, res: Response, next: NextFunction) => Promise<void>;
    requirePermission: (permission: string) => (req: Request, res: Response, next: NextFunction) => Promise<void>;
    requireRole: (role: string) => (req: Request, res: Response, next: NextFunction) => Promise<void>;
    optionalAuth: (req: Request, res: Response, next: NextFunction) => Promise<void>;
    private checkPermission;
}
export declare const createAuthMiddleware: (pool: Pool) => AuthMiddleware;
//# sourceMappingURL=auth.d.ts.map