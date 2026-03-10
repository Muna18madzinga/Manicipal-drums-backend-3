// Authentication routes for the unified backend

async function authRoutes(fastify) {
  // Admin registration endpoint
  fastify.post('/auth/register', async (request, reply) => {
    console.log('[AUTH-v2] Register endpoint hit')
    console.log('[AUTH-v2] Body:', JSON.stringify(request.body))
    try {
      const { name, email, phone, organization, role, password } = request.body || {}

      if (!name || !email || !password) {
        return reply.code(400).send({ success: false, message: 'Name, email, and password are required' })
      }

      // Check duplicate
      const existing = await fastify.pg.query('SELECT id FROM users WHERE email = $1', [email])
      if (existing.rows.length > 0) {
        return reply.code(409).send({ success: false, message: 'User with this email already exists' })
      }

      // Insert
      const { rows } = await fastify.pg.query(
        `INSERT INTO users (email, full_name, role, organization, phone, password_hash, status, active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', true, NOW(), NOW())
         RETURNING id, email, full_name, role, organization`,
        [email, name, role || 'registered', organization || null, phone || null, 'hashed_' + password]
      )

      console.log('[AUTH-v2] User created:', rows[0].email)
      return reply.send({ success: true, data: { user: rows[0] }, message: 'Account created successfully' })
    } catch (err) {
      console.error('[AUTH-v2] REGISTER ERROR:', err.message, err.detail, err.code)
      return reply.code(500).send({
        success: false,
        error: err.code || 'UNKNOWN',
        message: String(err.message || 'Unknown error'),
        detail: String(err.detail || ''),
        _v: 2
      })
    }
  })

  // Get current user profile
  fastify.get('/auth/me', async (request, reply) => {
    try {
      const authHeader = request.headers.authorization
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ success: false, error: 'No token provided' })
      }

      const token = authHeader.split(' ')[1]
      // Extract user ID from token (format: jwt_timestamp_userId)
      const parts = token.split('_')
      const userId = parts.slice(2).join('_')

      if (!userId) {
        return reply.status(401).send({ success: false, error: 'Invalid token' })
      }

      const { rows } = await fastify.pg.query(
        'SELECT id, email, full_name, role, organization, active FROM users WHERE id = $1 AND active = true',
        [userId]
      )

      if (rows.length === 0) {
        return reply.status(401).send({ success: false, error: 'User not found' })
      }

      const user = rows[0]
      return reply.send({
        success: true,
        data: {
          id: user.id,
          email: user.email,
          name: user.full_name,
          role: user.role,
          organization: user.organization
        }
      })
    } catch (error) {
      console.error('[AUTH] Profile fetch failed:', error)
      return reply.status(500).send({ success: false, error: 'Failed to fetch profile' })
    }
  })

  // Logout endpoint
  fastify.post('/auth/logout', async (request, reply) => {
    // Server-side session cleanup would go here in production
    return reply.send({ success: true, message: 'Logged out successfully' })
  })

  // Login endpoint
  fastify.post('/auth/login', async (request, reply) => {
    try {
      const { email, password } = request.body

      // Simple validation
      if (!email || !password) {
        return reply.status(400).send({
          success: false,
          error: 'Missing credentials',
          message: 'Email and password are required'
        })
      }

      console.log(`[AUTH] Login attempt for: ${email}`)
      
      // Debug: Check database connection
      const dbCheck = await fastify.pg.query('SELECT current_database() as db, current_user as user')
      console.log(`[AUTH] Connected to DB: ${dbCheck.rows[0].db} as user: ${dbCheck.rows[0].user}`)
      
      // Debug: Count all users
      const countResult = await fastify.pg.query('SELECT COUNT(*) as total FROM users')
      console.log(`[AUTH] Total users in database: ${countResult.rows[0].total}`)
      
      // Debug: List all users (limit 5)
      const allUsers = await fastify.pg.query('SELECT email, active FROM users LIMIT 5')
      console.log(`[AUTH] Users in DB:`, allUsers.rows)

      // Find user by email
      const { rows } = await fastify.pg.query(
        'SELECT id, email, full_name, role, organization, password_hash, active FROM users WHERE email = $1 AND active = true',
        [email]
      )

      console.log(`[AUTH] Query returned ${rows.length} rows`)

      if (rows.length === 0) {
        console.log(`[AUTH] User not found: ${email}`)
        return reply.status(401).send({
          success: false,
          error: 'Authentication failed',
          message: 'Invalid email or password'
        })
      }

      const user = rows[0]
      console.log(`[AUTH] Found user: ${user.email}, role: ${user.role}`)

      // Check password
      const expectedHash = 'hashed_' + password
      const isPasswordValid = user.password_hash === expectedHash || 
                             user.password_hash === password ||
                             user.password_hash?.includes(password)

      console.log('[AUTH Debug] Password valid:', isPasswordValid)

      if (!isPasswordValid) {
        console.log(`[AUTH] Invalid password for: ${email}`)
        return reply.status(401).send({
          success: false,
          error: 'Authentication failed',
          message: 'Invalid email or password'
        })
      }

      // Update last login
      await fastify.pg.query(
        'UPDATE users SET last_login_at = NOW() WHERE id = $1',
        [user.id]
      )

      // Generate simple token
      const token = 'jwt_' + Date.now() + '_' + user.id

      console.log(`[AUTH] User logged in: ${email}`)

      return reply.send({
        success: true,
        data: {
          token,
          user: {
            id: user.id,
            email: user.email,
            name: user.full_name,
            role: user.role,
            organization: user.organization
          }
        },
        message: 'Login successful'
      })
    } catch (error) {
      console.error('[AUTH] Login failed:', error)
      return reply.status(500).send({
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to login'
      })
    }
  })

  // Refresh token endpoint
  fastify.post('/auth/refresh', async (request, reply) => {
    try {
      const { refreshToken } = request.body || {}

      if (!refreshToken) {
        return reply.status(400).send({
          success: false,
          error: 'Missing refresh token',
          message: 'Refresh token is required'
        })
      }

      // Generate new token
      const newToken = 'jwt_' + Date.now() + '_refreshed'

      return reply.send({
        success: true,
        data: {
          token: newToken
        },
        message: 'Token refreshed successfully'
      })
    } catch (error) {
      console.error('[AUTH] Refresh failed:', error)
      return reply.status(500).send({
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to refresh token'
      })
    }
  })

  // API Token generation for QGIS Plugin
  fastify.post('/auth/generate-api-token', async (request, reply) => {
    try {
      const { email, password, pluginName } = request.body

      // Simple validation
      if (!email || !password) {
        return reply.status(400).send({
          error: 'Missing credentials',
          message: 'Email and password are required'
        })
      }

      // Generate a proper API token for QGIS Plugin
      const apiToken = `vungu-api-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`
      
      // Store token info (in production, save to database)
      const tokenInfo = {
        token: apiToken,
        pluginName: pluginName || 'vungu-qgis-plugin',
        email: email,
        generatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(), // 1 year
        permissions: ['api.read', 'api.write', 'layers.sync', 'styles.manage']
      }

      console.log(`[API] Generated new API token for ${email}: ${apiToken.substring(0, 30)}...`)

      return reply.send({
        success: true,
        data: {
          apiToken: apiToken,
          tokenInfo: tokenInfo,
          message: 'API token generated successfully for QGIS Plugin'
        }
      })
    } catch (error) {
      console.error('[API] Token generation failed:', error)
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to generate API token'
      })
    }
  })

  // Email API token
  fastify.post('/auth/email-api-token', async (request, reply) => {
    try {
      const { token, email, pluginName } = request.body

      // Validate input
      if (!token || !email) {
        return reply.status(400).send({
          error: 'Missing required fields',
          message: 'Token and email are required'
        })
      }

      // Mock email sending (in production, use actual email service)
      console.log(`[API] Emailing API token to ${email}: ${token.substring(0, 30)}...`)

      return reply.send({
        success: true,
        message: 'API token sent to email successfully',
        data: {
          email: email,
          pluginName: pluginName || 'vungu-qgis-plugin',
          sentAt: new Date().toISOString()
        }
      })
    } catch (error) {
      console.error('[API] Email token failed:', error)
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to email API token'
      })
    }
  })

  // Validate API token
  fastify.post('/auth/validate-api-token', async (request, reply) => {
    try {
      const { token } = request.body

      if (!token) {
        return reply.status(400).send({
          error: 'Missing token',
          message: 'API token is required'
        })
      }

      // Validate token format
      if (!token.startsWith('vungu-api-')) {
        return reply.status(401).send({
          error: 'Invalid token',
          message: 'Invalid API token format'
        })
      }

      // Mock token validation (in production, check against database)
      return reply.send({
        success: true,
        data: {
          valid: true,
          token: token,
          permissions: ['api.read', 'api.write', 'layers.sync', 'styles.manage'],
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
        }
      })
    } catch (error) {
      console.error('[API] Token validation failed:', error)
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to validate API token'
      })
    }
  })
}

module.exports = { authRoutes }
