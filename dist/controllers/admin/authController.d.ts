import { FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
export declare class AuthController {
    private authService;
    private adminUserModel;
    constructor(pool: Pool);
    login: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    refreshToken: (req: Request, res: Response) => Promise<void>;
    logout: (req: Request, res: Response) => Promise<void>;
    getProfile: (req: Request, res: Response) => Promise<void>;
    updateProfile: (req: Request, res: Response) => Promise<void>;
    checkAuth: (req: Request, res: Response) => Promise<void>;
}
//# sourceMappingURL=authController.d.ts.map