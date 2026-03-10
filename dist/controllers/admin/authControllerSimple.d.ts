import { FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
export declare class AuthController {
    private pool;
    constructor(pool: Pool);
    login: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    generateApiToken: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    emailApiToken: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    refreshToken: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    logout: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    getProfile: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    updateProfile: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    checkAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}
//# sourceMappingURL=authControllerSimple.d.ts.map