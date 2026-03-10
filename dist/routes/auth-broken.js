"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRoutes = authRoutes;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
async function authRoutes(fastify) {
    console.log('🔐 Auth routes registering...');
    // Test endpoint
    fastify.get('/test', async (request, reply) => {
        return { message: 'Auth routes working', timestamp: new Date().toISOString() };
    });
    // Simple login endpoint without JWT for testing
    fastify.post('/login', async (request, reply) => {
        console.log('🔐 Login endpoint called');
        return { message: 'Login endpoint working' };
    });
    // Register
    fastify.post('/register', {
        schema: {
            description: 'User registration',
            tags: ['Authentication'],
            body: {
                type: 'object',
                required: ['email', 'password', 'name'],
                properties: {
                    email: { type: 'string', format: 'email' },
                    password: { type: 'string', minLength: 8 },
                    name: { type: 'string', minLength: 2 },
                    organization: { type: 'string' }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const { email, password, name, organization } = request.body;
            // Check if user already exists
            const existingUser = await fastify.pg.query('SELECT id FROM users WHERE email = $1', [email]);
            if (existingUser.rows[0]) {
                return reply.code(409).send({ error: 'Email already registered' });
            }
            // Hash password
            const passwordHash = await bcryptjs_1.default.hash(password, 10);
            // Create user
            const { rows } = await fastify.pg.query(`
        INSERT INTO users (email, password_hash, name, organization, role, active, created_at)
        VALUES ($1, $2, $3, $4, 'registered', true, NOW())
        RETURNING id, email, name, organization, role
      `, [email, passwordHash, name, organization]);
            const user = rows[0];
            // Generate token
            const token = fastify.jwt.sign({
                userId: user.id,
                email: user.email,
                role: user.role
            });
            return {
                token,
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    organization: user.organization,
                    role: user.role
                }
            };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Registration failed' });
        }
    });
    // Get current user
    fastify.get('/me', {
        preHandler: requireAuth,
        schema: {
            description: 'Get current user profile',
            tags: ['Authentication'],
            headers: {
                type: 'object',
                properties: {
                    Authorization: { type: 'string' }
                },
                required: ['Authorization']
            }
        }
    }, async (request, reply) => {
        try {
            const userId = request.user.userId;
            const { rows } = await fastify.pg.query(`
        SELECT id, email, name, organization, role, active, created_at, last_login
        FROM users 
        WHERE id = $1
      `, [userId]);
            if (!rows[0]) {
                return reply.code(404).send({ error: 'User not found' });
            }
            // Update last login
            await fastify.pg.query('UPDATE users SET last_login = NOW() WHERE id = $1', [userId]);
            return rows[0];
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Failed to fetch user profile' });
        }
    });
    // Logout (client-side token removal)
    fastify.post('/logout', {
        schema: {
            description: 'User logout',
            tags: ['Authentication']
        }
    }, async (request, reply) => {
        return { message: 'Logged out successfully' };
    });
    // Refresh token
    fastify.post('/refresh', {
        preHandler: requireAuth,
        schema: {
            description: 'Refresh JWT token',
            tags: ['Authentication']
        }
    }, async (request, reply) => {
        try {
            const userId = request.user.userId;
            const { rows } = await fastify.pg.query(`
        SELECT id, email, role, active
        FROM users 
        WHERE id = $1 AND active = true
      `, [userId]);
            if (!rows[0]) {
                return reply.code(401).send({ error: 'User not found or inactive' });
            }
            const user = rows[0];
            const token = fastify.jwt.sign({
                userId: user.id,
                email: user.email,
                role: user.role
            });
            return { token };
        }
        catch (error) {
            fastify.log.error(error);
            return reply.code(500).send({ error: 'Token refresh failed' });
        }
    });
}
//# sourceMappingURL=auth-broken.js.map