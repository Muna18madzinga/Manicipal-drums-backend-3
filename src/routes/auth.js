// Authentication routes for the unified backend
const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')

// Helper: extract user ID from token (format: jwt_timestamp_userId)
function getUserIdFromToken(token) {
  if (!token) return null
  const parts = token.split('_')
  // jwt_<timestamp>_<uuid> — uuid may contain dashes so we rejoin from index 2
  return parts.length >= 3 ? parts.slice(2).join('_') : null
}

// Helper: verify request is from an admin
async function requireAdmin(fastify, request, reply) {
  const authHeader = request.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({ success: false, error: 'No token provided' })
    return null
  }
  const token = authHeader.split(' ')[1]
  const userId = getUserIdFromToken(token)
  if (!userId) {
    reply.status(401).send({ success: false, error: 'Invalid token' })
    return null
  }
  const { rows } = await fastify.pg.query(
    'SELECT id, role FROM users WHERE id = $1 AND active = true',
    [userId]
  )
  if (rows.length === 0 || rows[0].role !== 'admin') {
    reply.status(403).send({ success: false, error: 'Admin access required' })
    return null
  }
  return rows[0]
}

async function authRoutes(fastify) {

  // ── Register ────────────────────────────────────────────────────────────
  fastify.post('/auth/register', async (request, reply) => {
    try {
      const { name, email, phone, organization, role, password } = request.body || {}

      if (!name || !email || !password) {
        return reply.code(400).send({ success: false, message: 'Name, email, and password are required' })
      }
      if (password.length < 8) {
        return reply.code(400).send({ success: false, message: 'Password must be at least 8 characters' })
      }

      const existing = await fastify.pg.query('SELECT id FROM users WHERE email = $1', [email])
      if (existing.rows.length > 0) {
        return reply.code(409).send({ success: false, message: 'User with this email already exists' })
      }

      const passwordHash = await bcrypt.hash(password, 10)
      const safeRole = ['registered', 'planner', 'viewer'].includes(role) ? role : 'registered'

      const { rows } = await fastify.pg.query(
        `INSERT INTO users (email, name, full_name, role, organization, phone, password_hash, status, active, created_at)
         VALUES ($1, $2, $2, $3, $4, $5, $6, 'active', true, NOW())
         RETURNING id, email, full_name AS name, role, organization`,
        [email, name, safeRole, organization || null, phone || null, passwordHash]
      )

      console.log('[AUTH] User registered:', rows[0].email)
      return reply.send({ success: true, data: { user: rows[0] }, message: 'Account created successfully' })
    } catch (err) {
      console.error('[AUTH] REGISTER ERROR:', err.message)
      return reply.code(500).send({ success: false, message: 'Registration failed', detail: err.message })
    }
  })

  // ── Login ────────────────────────────────────────────────────────────────
  fastify.post('/auth/login', async (request, reply) => {
    try {
      const { email, password } = request.body || {}

      if (!email || !password) {
        return reply.status(400).send({ success: false, error: 'Missing credentials', message: 'Email and password are required' })
      }

      console.log(`[AUTH] Login attempt: ${email}`)

      const { rows } = await fastify.pg.query(
        `SELECT id, email, COALESCE(full_name, name) AS name, role, organization,
                job_title, department, password_hash, active, status
         FROM users WHERE email = $1`,
        [email]
      )

      if (rows.length === 0) {
        return reply.status(401).send({ success: false, error: 'Authentication failed', message: 'Invalid email or password' })
      }

      const user = rows[0]

      if (!user.active || user.status === 'suspended') {
        return reply.status(403).send({ success: false, error: 'Account suspended', message: 'Your account has been suspended. Contact your administrator.' })
      }

      // Verify password — support both bcrypt and legacy hashed_ format
      let isPasswordValid = false
      if (user.password_hash && user.password_hash.startsWith('$2')) {
        isPasswordValid = await bcrypt.compare(password, user.password_hash)
      } else {
        // Legacy format: 'hashed_<password>'
        isPasswordValid = user.password_hash === 'hashed_' + password || user.password_hash === password
      }

      if (!isPasswordValid) {
        return reply.status(401).send({ success: false, error: 'Authentication failed', message: 'Invalid email or password' })
      }

      await fastify.pg.query('UPDATE users SET last_login_at = NOW(), last_login = NOW() WHERE id = $1', [user.id])

      const token = 'jwt_' + Date.now() + '_' + user.id

      console.log(`[AUTH] Login success: ${email} (${user.role})`)

      return reply.send({
        success: true,
        data: {
          token,
          user: {
            id:           user.id,
            email:        user.email,
            name:         user.name,
            role:         user.role,
            organization: user.organization,
            jobTitle:     user.job_title,
            department:   user.department
          }
        },
        message: 'Login successful'
      })
    } catch (error) {
      console.error('[AUTH] Login failed:', error)
      return reply.status(500).send({ success: false, error: 'Internal Server Error', message: 'Failed to login' })
    }
  })

  // ── Get current user profile ─────────────────────────────────────────────
  fastify.get('/auth/me', async (request, reply) => {
    try {
      const authHeader = request.headers.authorization
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ success: false, error: 'No token provided' })
      }

      const token = authHeader.split(' ')[1]
      const userId = getUserIdFromToken(token)
      if (!userId) {
        return reply.status(401).send({ success: false, error: 'Invalid token' })
      }

      const { rows } = await fastify.pg.query(
        `SELECT id, email, COALESCE(full_name, name) AS name, role, organization,
                job_title, department, active, created_at, last_login_at
         FROM users WHERE id = $1 AND active = true`,
        [userId]
      )

      if (rows.length === 0) {
        return reply.status(401).send({ success: false, error: 'User not found or inactive' })
      }

      const user = rows[0]
      return reply.send({
        success: true,
        data: {
          id:           user.id,
          email:        user.email,
          name:         user.name,
          role:         user.role,
          organization: user.organization,
          jobTitle:     user.job_title,
          department:   user.department,
          active:       user.active,
          created_at:   user.created_at,
          last_login:   user.last_login_at
        }
      })
    } catch (error) {
      console.error('[AUTH] Profile fetch failed:', error)
      return reply.status(500).send({ success: false, error: 'Failed to fetch profile' })
    }
  })

  // ── Logout ───────────────────────────────────────────────────────────────
  fastify.post('/auth/logout', async (request, reply) => {
    return reply.send({ success: true, message: 'Logged out successfully' })
  })

  // ── Refresh token ────────────────────────────────────────────────────────
  fastify.post('/auth/refresh', async (request, reply) => {
    try {
      const authHeader = request.headers.authorization
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ success: false, error: 'No token provided' })
      }
      const oldToken = authHeader.split(' ')[1]
      const userId = getUserIdFromToken(oldToken)
      if (!userId) {
        return reply.status(401).send({ success: false, error: 'Invalid token' })
      }
      const newToken = 'jwt_' + Date.now() + '_' + userId
      return reply.send({ success: true, data: { token: newToken } })
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'Failed to refresh token' })
    }
  })

  // ── Update profile ───────────────────────────────────────────────────────
  fastify.put('/auth/profile', async (request, reply) => {
    try {
      const authHeader = request.headers.authorization
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({ success: false, error: 'No token provided' })
      }
      const userId = getUserIdFromToken(authHeader.split(' ')[1])
      if (!userId) return reply.status(401).send({ success: false, error: 'Invalid token' })

      const { name, organization, jobTitle, department } = request.body || {}

      const { rows } = await fastify.pg.query(
        `UPDATE users SET
           name        = COALESCE($1, name),
           full_name   = COALESCE($1, full_name),
           organization = COALESCE($2, organization),
           job_title   = COALESCE($3, job_title),
           department  = COALESCE($4, department)
         WHERE id = $5
         RETURNING id, email, COALESCE(full_name, name) AS name, role, organization, job_title, department`,
        [name || null, organization || null, jobTitle || null, department || null, userId]
      )

      if (rows.length === 0) return reply.status(404).send({ success: false, error: 'User not found' })
      return reply.send({ success: true, data: rows[0] })
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'Failed to update profile' })
    }
  })

  // ════════════════════════════════════════════════════════════════════════
  // INVITE SYSTEM
  // ════════════════════════════════════════════════════════════════════════

  // Create invite (admin only)
  fastify.post('/auth/invite', async (request, reply) => {
    try {
      const admin = await requireAdmin(fastify, request, reply)
      if (!admin) return

      const { email, role, jobTitle, department } = request.body || {}

      if (!email || !role) {
        return reply.status(400).send({ success: false, message: 'Email and role are required' })
      }
      if (!['admin', 'planner', 'viewer'].includes(role)) {
        return reply.status(400).send({ success: false, message: 'Role must be admin, planner, or viewer' })
      }

      // Check if user already exists
      const existing = await fastify.pg.query('SELECT id FROM users WHERE email = $1', [email])
      if (existing.rows.length > 0) {
        return reply.status(409).send({ success: false, message: 'A user with this email already exists' })
      }

      // Invalidate any existing pending invites for this email
      await fastify.pg.query(
        'UPDATE invites SET used = true, used_at = NOW() WHERE email = $1 AND used = false',
        [email]
      )

      const token = uuidv4()
      const { rows } = await fastify.pg.query(
        `INSERT INTO invites (token, email, role, job_title, department, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '7 days')
         RETURNING id, token, email, role, job_title, department, expires_at, created_at`,
        [token, email, role, jobTitle || null, department || null, admin.id]
      )

      const invite = rows[0]
      console.log(`[INVITE] Created invite for ${email} (${role}) by admin ${admin.id}`)

      return reply.send({
        success: true,
        data: {
          token:      invite.token,
          email:      invite.email,
          role:       invite.role,
          jobTitle:   invite.job_title,
          department: invite.department,
          expiresAt:  invite.expires_at,
          inviteUrl:  `/invite?token=${invite.token}`
        },
        message: 'Invite created successfully'
      })
    } catch (error) {
      console.error('[INVITE] Create failed:', error)
      return reply.status(500).send({ success: false, error: 'Failed to create invite' })
    }
  })

  // Validate invite token
  fastify.get('/auth/invite/validate', async (request, reply) => {
    try {
      const { token } = request.query || {}
      if (!token) {
        return reply.status(400).send({ success: false, error: 'Token is required' })
      }

      const { rows } = await fastify.pg.query(
        `SELECT id, token, email, role, job_title, department, expires_at, used
         FROM invites WHERE token = $1`,
        [token]
      )

      if (rows.length === 0) {
        return reply.status(404).send({ success: false, error: 'Invite not found', valid: false })
      }

      const invite = rows[0]

      if (invite.used) {
        return reply.status(410).send({ success: false, error: 'Invite already used', valid: false })
      }
      if (new Date(invite.expires_at) < new Date()) {
        return reply.status(410).send({ success: false, error: 'Invite has expired', valid: false })
      }

      return reply.send({
        success: true,
        valid: true,
        data: {
          token:      invite.token,
          email:      invite.email,
          role:       invite.role,
          jobTitle:   invite.job_title,
          department: invite.department,
          expiresAt:  invite.expires_at
        }
      })
    } catch (error) {
      console.error('[INVITE] Validate failed:', error)
      return reply.status(500).send({ success: false, error: 'Failed to validate invite' })
    }
  })

  // Accept invite — create employee account
  fastify.post('/auth/invite/accept', async (request, reply) => {
    try {
      const { token, name, password } = request.body || {}

      if (!token || !name || !password) {
        return reply.status(400).send({ success: false, message: 'Token, name, and password are required' })
      }
      if (password.length < 8) {
        return reply.status(400).send({ success: false, message: 'Password must be at least 8 characters' })
      }

      const { rows: inviteRows } = await fastify.pg.query(
        'SELECT * FROM invites WHERE token = $1 AND used = false AND expires_at > NOW()',
        [token]
      )

      if (inviteRows.length === 0) {
        return reply.status(410).send({ success: false, error: 'Invite is invalid, used, or expired' })
      }

      const invite = inviteRows[0]

      // Check if email already registered
      const existing = await fastify.pg.query('SELECT id FROM users WHERE email = $1', [invite.email])
      if (existing.rows.length > 0) {
        return reply.status(409).send({ success: false, message: 'An account with this email already exists' })
      }

      const passwordHash = await bcrypt.hash(password, 10)

      // Create user account
      const { rows: userRows } = await fastify.pg.query(
        `INSERT INTO users (email, name, full_name, role, job_title, department, password_hash, status, active, created_at)
         VALUES ($1, $2, $2, $3, $4, $5, $6, 'active', true, NOW())
         RETURNING id, email, COALESCE(full_name, name) AS name, role, job_title, department`,
        [invite.email, name, invite.role, invite.job_title, invite.department, passwordHash]
      )

      // Mark invite as used
      await fastify.pg.query(
        'UPDATE invites SET used = true, used_at = NOW() WHERE id = $1',
        [invite.id]
      )

      const user = userRows[0]
      console.log(`[INVITE] Account created for ${user.email} (${user.role})`)

      return reply.send({
        success: true,
        data: {
          user: {
            id:         user.id,
            email:      user.email,
            name:       user.name,
            role:       user.role,
            jobTitle:   user.job_title,
            department: user.department
          }
        },
        message: `Account created! Welcome to Vungu RDC, ${name}.`
      })
    } catch (error) {
      console.error('[INVITE] Accept failed:', error)
      return reply.status(500).send({ success: false, error: 'Failed to create account' })
    }
  })

  // ════════════════════════════════════════════════════════════════════════
  // ADMIN USER MANAGEMENT
  // ════════════════════════════════════════════════════════════════════════

  // List all users
  fastify.get('/admin/users', async (request, reply) => {
    try {
      const admin = await requireAdmin(fastify, request, reply)
      if (!admin) return

      const { rows } = await fastify.pg.query(
        `SELECT id, email, COALESCE(full_name, name) AS name, role, organization,
                job_title, department, active, status, created_at, last_login_at
         FROM users ORDER BY created_at DESC`
      )

      return reply.send({
        success: true,
        data: rows.map(u => ({
          id:         u.id,
          email:      u.email,
          name:       u.name,
          role:       u.role,
          organization: u.organization,
          jobTitle:   u.job_title,
          department: u.department,
          active:     u.active,
          status:     u.status || (u.active ? 'active' : 'suspended'),
          createdAt:  u.created_at,
          lastLogin:  u.last_login_at
        }))
      })
    } catch (error) {
      console.error('[ADMIN] List users failed:', error)
      return reply.status(500).send({ success: false, error: 'Failed to fetch users' })
    }
  })

  // Update user (role, status, department, job title)
  fastify.put('/admin/users/:id', async (request, reply) => {
    try {
      const admin = await requireAdmin(fastify, request, reply)
      if (!admin) return

      const { id } = request.params
      const { role, status, jobTitle, department, name } = request.body || {}

      const validRoles   = ['admin', 'planner', 'viewer', 'registered']
      const validStatuses = ['active', 'suspended']

      if (role && !validRoles.includes(role)) {
        return reply.status(400).send({ success: false, message: 'Invalid role' })
      }
      if (status && !validStatuses.includes(status)) {
        return reply.status(400).send({ success: false, message: 'Invalid status' })
      }

      const { rows } = await fastify.pg.query(
        `UPDATE users SET
           role       = COALESCE($1, role),
           status     = COALESCE($2, status),
           active     = CASE WHEN $2 = 'suspended' THEN false WHEN $2 = 'active' THEN true ELSE active END,
           job_title  = COALESCE($3, job_title),
           department = COALESCE($4, department),
           name       = COALESCE($5, name),
           full_name  = COALESCE($5, full_name)
         WHERE id = $6
         RETURNING id, email, COALESCE(full_name, name) AS name, role, status, active, job_title, department`,
        [role || null, status || null, jobTitle || null, department || null, name || null, id]
      )

      if (rows.length === 0) return reply.status(404).send({ success: false, error: 'User not found' })

      console.log(`[ADMIN] User ${id} updated by admin ${admin.id}`)
      return reply.send({ success: true, data: rows[0], message: 'User updated' })
    } catch (error) {
      console.error('[ADMIN] Update user failed:', error)
      return reply.status(500).send({ success: false, error: 'Failed to update user' })
    }
  })

  // Suspend / reactivate user
  fastify.post('/admin/users/:id/suspend', async (request, reply) => {
    try {
      const admin = await requireAdmin(fastify, request, reply)
      if (!admin) return

      const { id } = request.params
      const { suspended } = request.body || {}
      const newStatus = suspended ? 'suspended' : 'active'

      const { rows } = await fastify.pg.query(
        `UPDATE users SET status = $1, active = $2 WHERE id = $3
         RETURNING id, email, status, active`,
        [newStatus, !suspended, id]
      )

      if (rows.length === 0) return reply.status(404).send({ success: false, error: 'User not found' })

      console.log(`[ADMIN] User ${id} ${newStatus} by admin ${admin.id}`)
      return reply.send({ success: true, data: rows[0], message: `User ${newStatus}` })
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'Failed to update user status' })
    }
  })

  // Delete user
  fastify.delete('/admin/users/:id', async (request, reply) => {
    try {
      const admin = await requireAdmin(fastify, request, reply)
      if (!admin) return

      const { id } = request.params

      if (id === admin.id) {
        return reply.status(400).send({ success: false, error: 'Cannot delete your own account' })
      }

      await fastify.pg.query('DELETE FROM users WHERE id = $1', [id])

      console.log(`[ADMIN] User ${id} deleted by admin ${admin.id}`)
      return reply.send({ success: true, message: 'User deleted' })
    } catch (error) {
      console.error('[ADMIN] Delete user failed:', error)
      return reply.status(500).send({ success: false, error: 'Failed to delete user' })
    }
  })

  // Reset password (admin sets a new temporary password)
  fastify.post('/admin/users/:id/reset-password', async (request, reply) => {
    try {
      const admin = await requireAdmin(fastify, request, reply)
      if (!admin) return

      const { id } = request.params
      const { newPassword } = request.body || {}

      if (!newPassword || newPassword.length < 8) {
        return reply.status(400).send({ success: false, message: 'New password must be at least 8 characters' })
      }

      const passwordHash = await bcrypt.hash(newPassword, 10)
      const { rows } = await fastify.pg.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id, email',
        [passwordHash, id]
      )

      if (rows.length === 0) return reply.status(404).send({ success: false, error: 'User not found' })

      console.log(`[ADMIN] Password reset for user ${id} by admin ${admin.id}`)
      return reply.send({ success: true, message: 'Password reset successfully' })
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'Failed to reset password' })
    }
  })

  // List all invites (admin only)
  fastify.get('/admin/invites', async (request, reply) => {
    try {
      const admin = await requireAdmin(fastify, request, reply)
      if (!admin) return

      const { rows } = await fastify.pg.query(
        `SELECT i.id, i.token, i.email, i.role, i.job_title, i.department,
                i.used, i.used_at, i.expires_at, i.created_at,
                COALESCE(u.full_name, u.name) AS invited_by_name
         FROM invites i
         LEFT JOIN users u ON u.id = i.invited_by
         ORDER BY i.created_at DESC`
      )

      return reply.send({
        success: true,
        data: rows.map(r => ({
          id:           r.id,
          token:        r.token,
          email:        r.email,
          role:         r.role,
          jobTitle:     r.job_title,
          department:   r.department,
          used:         r.used,
          usedAt:       r.used_at,
          expiresAt:    r.expires_at,
          createdAt:    r.created_at,
          invitedBy:    r.invited_by_name,
          inviteUrl:    `/invite?token=${r.token}`
        }))
      })
    } catch (error) {
      console.error('[ADMIN] List invites failed:', error)
      return reply.status(500).send({ success: false, error: 'Failed to fetch invites' })
    }
  })

  // Revoke invite
  fastify.delete('/admin/invites/:id', async (request, reply) => {
    try {
      const admin = await requireAdmin(fastify, request, reply)
      if (!admin) return

      const { id } = request.params
      await fastify.pg.query('DELETE FROM invites WHERE id = $1 AND used = false', [id])
      return reply.send({ success: true, message: 'Invite revoked' })
    } catch (error) {
      return reply.status(500).send({ success: false, error: 'Failed to revoke invite' })
    }
  })

  // ── Legacy QGIS API token endpoints ─────────────────────────────────────
  fastify.post('/auth/generate-api-token', async (request, reply) => {
    try {
      const { email, pluginName } = request.body || {}
      const apiToken = `vungu-api-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`
      return reply.send({
        success: true,
        data: {
          apiToken,
          email,
          pluginName: pluginName || 'vungu-qgis-plugin',
          expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
        }
      })
    } catch (error) {
      return reply.status(500).send({ error: 'Failed to generate API token' })
    }
  })

  fastify.post('/auth/email-api-token', async (request, reply) => {
    const { token, email, pluginName } = request.body || {}
    if (!token || !email) return reply.status(400).send({ error: 'Token and email are required' })
    return reply.send({ success: true, message: 'API token sent to email', data: { email, sentAt: new Date().toISOString() } })
  })

  fastify.post('/auth/validate-api-token', async (request, reply) => {
    const { token } = request.body || {}
    if (!token) return reply.status(400).send({ error: 'Token is required' })
    if (!token.startsWith('vungu-api-')) return reply.status(401).send({ error: 'Invalid token format' })
    return reply.send({ success: true, data: { valid: true, token, permissions: ['api.read', 'api.write', 'layers.sync', 'styles.manage'] } })
  })
}

module.exports = { authRoutes }
