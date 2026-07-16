/**
 * Authentication routes.
 *
 * Hardened (audit fixes):
 *   - Real signed JWTs via src/middleware/jwtAuth (HS256, expiry, issuer).
 *   - Customer self-register pinned to 'registered' / 'public'. Anything
 *     else from the body is ignored. Internal roles are issued only via
 *     the invite flow.
 *   - applicant_type column persisted (resident, landowner, business,
 *     consultant, visitor) for council routing and statistics.
 *   - Invite-accept now properly bcrypts the password (was a string concat).
 *   - Plaintext "hashed_<password>" login fallback removed.
 *   - PII (email + role) no longer logged.
 *   - /admin/users protected via requireAdmin preHandler.
 *
 * NOTE: Per-route rate-limit configs are wired in server.js when this
 * plugin is registered; this file does not need to set them itself.
 */

const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')

const {
  signAccessToken,
  signApiToken,
  verifyToken,
  requireAuth,
  requireAdmin,
  createSession,
  revokeSession,
  listSessions,
  setAuthCookies,
  clearAuthCookies,
  generateMfaSecret,
  verifyMfaToken,
  generateBackupCodes,
  signMfaPendingToken,
  verifyMfaPendingToken,
} = require('../middleware/jwtAuth')

const notifier = require('../services/notifier')

// Customer-facing registration is pinned to one of these two roles only.
// Anything else (including 'admin', 'planner', etc.) coming from the body
// is silently ignored. Internal roles flow exclusively through invites.
const CUSTOMER_ROLES = new Set(['registered', 'public'])

const APPLICANT_TYPES = new Set([
  'resident', 'landowner', 'business', 'consultant', 'visitor',
])

// Roles that can be issued via the invite system (employees).
const INVITABLE_ROLES = new Set([
  'admin', 'planner', 'viewer',
  'eo', 'env_officer', 'building_inspector', 'planning_clerk',
  'surveyor', 'gis_officer',
])

const VALID_USER_ROLES = new Set([
  'public', 'registered', 'viewer',
  'admin', 'planner', 'eo', 'env_officer', 'building_inspector',
  'planning_clerk', 'surveyor', 'gis_officer',
])

// Council staff = employees. Identical to INVITABLE_ROLES today, but named
// separately because it answers a different question — "is this an employee,
// not a citizen?" — used to scope GET /admin/users?staff=true. Derived from
// INVITABLE_ROLES so the two never drift.
//
// NOTE: `viewer` is deliberately a staff role (the IT-admin invite form
// creates "Viewer" employees), so a citizen carrying a legacy `viewer` role
// would be counted as staff. Acceptable: customer self-register only ever
// issues 'public' / 'registered', so this can't happen for new accounts.
const STAFF_ROLES = [...INVITABLE_ROLES]

// Crude but cheap input checks. Joi/zod is overkill here.
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const isString = (v, max = 255) => typeof v === 'string' && v.length > 0 && v.length <= max

function userToDTO(row) {
  return {
    id:             row.id,
    email:          row.email,
    name:           row.name,
    role:           row.role,
    organization:   row.organization,
    jobTitle:       row.job_title,
    department:     row.department,
    applicantType:  row.applicant_type ?? null,
    phone:          row.phone ?? null,
    nationalId:     row.national_id ?? null,
    address:        row.physical_address ?? null,
  }
}

async function authRoutes(fastify) {
  // ── Register (customer self-service) ──────────────────────────────────
  fastify.post('/auth/register', async (request, reply) => {
    try {
      const body = request.body || {}
      const { name, email, phone, organization, password } = body

      if (!isString(name, 120) || !isString(email, 255) || !isString(password, 255)) {
        return reply.code(400).send({ success: false, message: 'Name, email, and password are required' })
      }
      if (!EMAIL_RX.test(email)) {
        return reply.code(400).send({ success: false, message: 'Invalid email address' })
      }
      if (password.length < 8) {
        return reply.code(400).send({ success: false, message: 'Password must be at least 8 characters' })
      }

      // Map client `applicant_type` → safe role. Body `role` is ignored.
      const applicantType = APPLICANT_TYPES.has(body.applicant_type)
        ? body.applicant_type
        : null
      const role = applicantType === 'visitor' ? 'public' : 'registered'

      const existing = await fastify.pg.query('SELECT id FROM users WHERE email = $1', [email])
      if (existing.rows.length > 0) {
        return reply.code(409).send({ success: false, message: 'An account with this email already exists' })
      }

      const passwordHash = await bcrypt.hash(password, 10)

      // Reusable applicant identity, captured once at sign-up.
      const nationalId = isString(body.national_id, 64) ? body.national_id : null
      const address    = isString(body.address, 500) ? body.address : null

      const { rows } = await fastify.pg.query(
        `INSERT INTO users (
           email, name, full_name, role, organization, phone,
           applicant_type, national_id, physical_address,
           password_hash, status, active, created_at
         )
         VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, 'active', true, NOW())
         RETURNING id, email, full_name AS name, role, organization,
                   job_title, department, applicant_type,
                   phone, national_id, physical_address`,
        [
          email, name, role,
          organization || null, phone || null, applicantType,
          nationalId, address, passwordHash,
        ],
      )

      const user = rows[0]
      const { accessToken, refreshToken } = await createSession(fastify, user, request)
      setAuthCookies(reply, { accessToken, refreshToken })

      return reply.send({
        success: true,
        data: { user: userToDTO(user), token: accessToken },
        message: 'Account created',
      })
    } catch (err) {
      request.log.error({ err }, 'register failed')
      return reply.code(500).send({ success: false, message: 'Registration failed' })
    }
  })

  // ── Login ─────────────────────────────────────────────────────────────
  fastify.post('/auth/login', async (request, reply) => {
    try {
      const { email, password } = request.body || {}

      if (!isString(email) || !isString(password)) {
        return reply.code(400).send({
          success: false, error: 'missing_credentials', message: 'Email and password are required',
        })
      }

      const { rows } = await fastify.pg.query(
        `SELECT id, email, COALESCE(full_name, name) AS name, role, organization,
                job_title, department, applicant_type, phone,
                national_id, physical_address, password_hash, active, status,
                mfa_enabled
         FROM users WHERE email = $1`,
        [email],
      )

      // Constant-ish-time response for unknown email — bcrypt against a
      // dummy hash so the timing matches a real check. Avoids username probing.
      const user = rows[0]
      const dummyHash = '$2b$10$abcdefghijklmnopqrstuv0000000000000000000000000000000'
      if (!user) {
        await bcrypt.compare(password, dummyHash)
        return reply.code(401).send({
          success: false, error: 'invalid_credentials', message: 'Invalid email or password',
        })
      }

      if (!user.active || user.status === 'suspended') {
        return reply.code(403).send({
          success: false, error: 'account_suspended', message: 'Your account has been suspended.',
        })
      }

      // Only accept bcrypt hashes. The legacy `'hashed_<password>'` format
      // and bare-string fallback have been removed (they bypassed hashing).
      if (!user.password_hash || !user.password_hash.startsWith('$2')) {
        request.log.warn({ userId: user.id }, 'legacy password hash; forcing reset')
        return reply.code(401).send({
          success: false, error: 'password_reset_required',
          message: 'Please reset your password.',
        })
      }

      const ok = await bcrypt.compare(password, user.password_hash)
      if (!ok) {
        return reply.code(401).send({
          success: false, error: 'invalid_credentials', message: 'Invalid email or password',
        })
      }

      if (user.mfa_enabled) {
        // Second factor required. Issue a short-lived pending token (not a
        // session) — the client must complete /auth/mfa/challenge with it
        // before any real access/refresh token or session row is created.
        const mfaToken = signMfaPendingToken(user.id)
        return reply.send({ success: true, data: { mfaRequired: true, mfaToken } })
      }

      await fastify.pg.query(
        'UPDATE users SET last_login_at = NOW(), last_login = NOW() WHERE id = $1',
        [user.id],
      )

      const { accessToken, refreshToken } = await createSession(fastify, user, request)
      setAuthCookies(reply, { accessToken, refreshToken })

      return reply.send({
        success: true,
        data: { user: userToDTO(user), token: accessToken },
        message: 'Login successful',
      })
    } catch (err) {
      request.log.error({ err }, 'login failed')
      return reply.code(500).send({
        success: false, error: 'internal', message: 'Failed to login',
      })
    }
  })

  // ── Get current user profile ─────────────────────────────────────────
  fastify.get('/auth/me', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    return reply.send({ success: true, data: userToDTO(request.user) })
  })

  // ── Logout ───────────────────────────────────────────────────────────
  // Session-aware: revokes the user_session row behind the refresh cookie
  // so the access token stops working immediately (authenticate() checks
  // session liveness on every request) instead of drifting on until its
  // natural 12h expiry.
  fastify.post('/auth/logout', async (request, reply) => {
    const refreshToken = request.cookies?.vungu_rt
    if (refreshToken) {
      try {
        const claims = verifyToken(refreshToken)
        if (claims.sid) await revokeSession(fastify, claims.sid)
      } catch (err) {
        request.log.warn({ err }, 'logout: could not verify refresh cookie (already expired?)')
      }
    }
    clearAuthCookies(reply)
    return reply.send({ success: true, message: 'Logged out' })
  })

  // ── Refresh token ────────────────────────────────────────────────────
  // ponytail: re-mints the access token against the existing session
  // (bumping last_used_at / resetting the idle clock) rather than rotating
  // the refresh token itself on every call. Full rotate-on-use is the next
  // hardening step if a stolen-refresh-token replay scenario needs closing.
  fastify.post('/auth/refresh', async (request, reply) => {
    try {
      const refreshToken = request.cookies?.vungu_rt || request.body?.refreshToken
      if (!isString(refreshToken)) {
        return reply.code(400).send({ success: false, message: 'No refresh token' })
      }

      let claims
      try {
        claims = verifyToken(refreshToken)
      } catch {
        return reply.code(401).send({ success: false, error: 'invalid_token' })
      }
      if (claims.type !== 'refresh') {
        return reply.code(401).send({ success: false, error: 'wrong_token_type' })
      }

      if (claims.sid) {
        const { rows: sessionRows } = await fastify.pg.query(
          'SELECT revoked_at, expires_at FROM public.user_session WHERE id = $1', [claims.sid])
        const session = sessionRows[0]
        if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
          clearAuthCookies(reply)
          return reply.code(401).send({ success: false, error: 'session_revoked' })
        }
      }

      const { rows } = await fastify.pg.query(
        `SELECT id, email, role, active, status FROM users WHERE id = $1`,
        [claims.sub],
      )
      const user = rows[0]
      if (!user || !user.active || user.status === 'suspended') {
        return reply.code(401).send({ success: false, error: 'invalid_user' })
      }

      const accessToken = signAccessToken({ id: user.id, role: user.role, email: user.email, sid: claims.sid })
      reply.setCookie('vungu_at', accessToken, {
        httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 12 * 60 * 60,
      })
      return reply.send({ success: true, data: { user: userToDTO(user) } })
    } catch (err) {
      request.log.error({ err }, 'refresh failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── MFA challenge (second step of login when mfa_enabled) ────────────
  fastify.post('/auth/mfa/challenge', async (request, reply) => {
    try {
      const { mfaToken, code } = request.body || {}
      if (!isString(mfaToken) || !isString(code, 20)) {
        return reply.code(400).send({ success: false, message: 'mfaToken and code are required' })
      }
      let claims
      try {
        claims = verifyMfaPendingToken(mfaToken)
      } catch {
        return reply.code(401).send({ success: false, error: 'invalid_or_expired_mfa_token' })
      }

      const { rows } = await fastify.pg.query(
        `SELECT id, email, COALESCE(full_name, name) AS name, role, organization,
                job_title, department, applicant_type, phone,
                national_id, physical_address, active, status,
                mfa_secret, mfa_backup_codes
         FROM users WHERE id = $1`,
        [claims.sub],
      )
      const user = rows[0]
      if (!user || !user.active || user.status === 'suspended') {
        return reply.code(401).send({ success: false, error: 'invalid_user' })
      }

      let ok = verifyMfaToken(user.mfa_secret, code)
      if (!ok && Array.isArray(user.mfa_backup_codes)) {
        for (let i = 0; i < user.mfa_backup_codes.length; i++) {
          if (await bcrypt.compare(code, user.mfa_backup_codes[i])) {
            ok = true
            const remaining = user.mfa_backup_codes.filter((_, idx) => idx !== i)
            await fastify.pg.query(
              'UPDATE users SET mfa_backup_codes = $1::jsonb WHERE id = $2',
              [JSON.stringify(remaining), user.id],
            )
            break
          }
        }
      }
      if (!ok) return reply.code(401).send({ success: false, error: 'invalid_mfa_code' })

      await fastify.pg.query(
        'UPDATE users SET last_login_at = NOW(), last_login = NOW() WHERE id = $1', [user.id])

      const { accessToken, refreshToken } = await createSession(fastify, user, request)
      setAuthCookies(reply, { accessToken, refreshToken })
      return reply.send({ success: true, data: { user: userToDTO(user), token: accessToken }, message: 'Login successful' })
    } catch (err) {
      request.log.error({ err }, 'mfa challenge failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── MFA enrolment (self-service, staff/admin) ─────────────────────────
  fastify.post('/auth/mfa/setup', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    const { secret, otpauthUrl } = generateMfaSecret(request.user.email)
    await fastify.pg.query('UPDATE users SET mfa_secret = $1 WHERE id = $2', [secret, request.user.id])
    return reply.send({ success: true, data: { secret, otpauthUrl } })
  })

  fastify.post('/auth/mfa/verify-setup', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    const { code } = request.body || {}
    const { rows } = await fastify.pg.query('SELECT mfa_secret FROM users WHERE id = $1', [request.user.id])
    const secret = rows[0]?.mfa_secret
    if (!secret || !verifyMfaToken(secret, code)) {
      return reply.code(400).send({ success: false, error: 'invalid_code' })
    }
    const backupCodes = generateBackupCodes()
    const hashed = await Promise.all(backupCodes.map((c) => bcrypt.hash(c, 10)))
    await fastify.pg.query(
      'UPDATE users SET mfa_enabled = true, mfa_backup_codes = $1::jsonb WHERE id = $2',
      [JSON.stringify(hashed), request.user.id],
    )
    return reply.send({ success: true, data: { backupCodes } })
  })

  fastify.post('/auth/mfa/disable', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    const { password } = request.body || {}
    const { rows } = await fastify.pg.query('SELECT password_hash FROM users WHERE id = $1', [request.user.id])
    const ok = rows[0]?.password_hash && await bcrypt.compare(password || '', rows[0].password_hash)
    if (!ok) return reply.code(401).send({ success: false, error: 'invalid_credentials' })
    await fastify.pg.query(
      'UPDATE users SET mfa_enabled = false, mfa_secret = NULL, mfa_backup_codes = NULL WHERE id = $1',
      [request.user.id],
    )
    return reply.send({ success: true })
  })

  // ── Sessions (device/session revocation) ──────────────────────────────
  fastify.get('/auth/sessions', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    const sessions = await listSessions(fastify, request.user.id)
    return reply.send({
      success: true,
      data: sessions.map((s) => ({ ...s, current: s.id === request.sessionId })),
    })
  })

  fastify.delete('/auth/sessions/:id', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    // Scope the revoke to the caller's own sessions — no cross-user reach.
    const { rows } = await fastify.pg.query(
      'SELECT id FROM public.user_session WHERE id = $1 AND user_id = $2',
      [request.params.id, request.user.id],
    )
    if (!rows[0]) return reply.code(404).send({ success: false, error: 'not_found' })
    await revokeSession(fastify, request.params.id)
    return reply.send({ success: true })
  })

  // ── Update profile ───────────────────────────────────────────────────
  fastify.put('/auth/profile', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const userId = request.user.id
      const { name, organization, jobTitle, department, phone, nationalId, address } = request.body || {}

      const { rows } = await fastify.pg.query(
        `UPDATE users SET
           name             = COALESCE($1, name),
           full_name        = COALESCE($1, full_name),
           organization     = COALESCE($2, organization),
           job_title        = COALESCE($3, job_title),
           department       = COALESCE($4, department),
           phone            = COALESCE($5, phone),
           national_id      = COALESCE($6, national_id),
           physical_address = COALESCE($7, physical_address),
           updated_at       = NOW()
         WHERE id = $8
         RETURNING id, email, COALESCE(full_name, name) AS name, role, organization,
                   job_title, department, applicant_type,
                   phone, national_id, physical_address`,
        [
          isString(name, 120) ? name : null,
          isString(organization, 255) ? organization : null,
          isString(jobTitle, 120) ? jobTitle : null,
          isString(department, 120) ? department : null,
          isString(phone, 32) ? phone : null,
          isString(nationalId, 64) ? nationalId : null,
          isString(address, 500) ? address : null,
          userId,
        ],
      )

      if (rows.length === 0) {
        return reply.code(404).send({ success: false, error: 'not_found' })
      }
      return reply.send({ success: true, data: userToDTO(rows[0]) })
    } catch (err) {
      request.log.error({ err }, 'profile update failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Change password (self) ───────────────────────────────────────────
  fastify.post('/auth/change-password', { preHandler: requireAuth(fastify) }, async (request, reply) => {
    try {
      const { currentPassword, newPassword } = request.body || {}
      if (!isString(currentPassword) || !isString(newPassword)) {
        return reply.code(400).send({ success: false, message: 'Both passwords required' })
      }
      if (newPassword.length < 8) {
        return reply.code(400).send({ success: false, message: 'Password must be at least 8 characters' })
      }

      const { rows } = await fastify.pg.query(
        `SELECT password_hash FROM users WHERE id = $1`,
        [request.user.id],
      )
      const hash = rows[0]?.password_hash
      if (!hash || !hash.startsWith('$2')) {
        return reply.code(400).send({ success: false, error: 'password_reset_required' })
      }
      const ok = await bcrypt.compare(currentPassword, hash)
      if (!ok) {
        return reply.code(401).send({ success: false, error: 'invalid_credentials' })
      }

      const newHash = await bcrypt.hash(newPassword, 10)
      await fastify.pg.query(
        `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
        [newHash, request.user.id],
      )
      return reply.send({ success: true, message: 'Password updated' })
    } catch (err) {
      request.log.error({ err }, 'change password failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ════════════════════════════════════════════════════════════════════
  // INVITE SYSTEM (employees only)
  // ════════════════════════════════════════════════════════════════════

  fastify.post('/auth/invite', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    try {
      const admin = request.user
      const { email, role, jobTitle, department } = request.body || {}

      if (!isString(email) || !EMAIL_RX.test(email) || !isString(role)) {
        return reply.code(400).send({ success: false, message: 'Email and role are required' })
      }
      if (!INVITABLE_ROLES.has(role)) {
        return reply.code(400).send({ success: false, message: 'Invalid role for invite' })
      }

      const existing = await fastify.pg.query('SELECT id FROM users WHERE email = $1', [email])
      if (existing.rows.length > 0) {
        return reply.code(409).send({ success: false, message: 'A user with this email already exists' })
      }

      // Invalidate any pending invites for this email.
      await fastify.pg.query(
        'UPDATE invites SET used = true, used_at = NOW() WHERE email = $1 AND used = false',
        [email],
      )

      const token = uuidv4()
      const { rows } = await fastify.pg.query(
        `INSERT INTO invites (token, email, role, job_title, department, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '7 days')
         RETURNING id, token, email, role, job_title, department, expires_at, created_at`,
        [token, email, role, jobTitle || null, department || null, admin.id],
      )
      const invite = rows[0]

      // Queue the invite email (outbox → emailWorker → SMTP). The link must be
      // absolute so it works from an email client. A notifier failure must not
      // fail the invite — the admin still gets the copyable link below.
      const appBase = process.env.FRONTEND_URL || 'http://localhost:5174'
      const absoluteUrl = `${appBase}/invite?token=${invite.token}`
      let emailQueued = false
      try {
        await notifier.enqueueStaffInvite(fastify.pg, {
          email:         invite.email,
          inviteUrl:     absoluteUrl,
          role:          invite.role,
          jobTitle:      invite.job_title,
          department:    invite.department,
          invitedByName: admin.name || admin.full_name || admin.email,
          expiresAt:     invite.expires_at,
        })
        emailQueued = true
      } catch (err) {
        request.log.error({ err }, 'invite email enqueue failed')
      }

      return reply.send({
        success: true,
        data: {
          token:     invite.token,
          email:     invite.email,
          role:      invite.role,
          jobTitle:  invite.job_title,
          department: invite.department,
          expiresAt: invite.expires_at,
          inviteUrl: `/invite?token=${invite.token}`,
          emailQueued,
        },
      })
    } catch (err) {
      request.log.error({ err }, 'invite create failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/auth/invite/validate', async (request, reply) => {
    try {
      const { token } = request.query || {}
      if (!isString(token)) {
        return reply.code(400).send({ success: false, error: 'token_required', valid: false })
      }
      const { rows } = await fastify.pg.query(
        `SELECT token, email, role, job_title, department, expires_at, used
         FROM invites WHERE token = $1`,
        [token],
      )
      if (rows.length === 0) {
        return reply.code(404).send({ success: false, error: 'not_found', valid: false })
      }
      const invite = rows[0]
      if (invite.used) {
        return reply.code(410).send({ success: false, error: 'used', valid: false })
      }
      if (new Date(invite.expires_at) < new Date()) {
        return reply.code(410).send({ success: false, error: 'expired', valid: false })
      }
      return reply.send({
        success: true, valid: true,
        data: {
          token:     invite.token,
          email:     invite.email,
          role:      invite.role,
          jobTitle:  invite.job_title,
          department: invite.department,
          expiresAt: invite.expires_at,
        },
      })
    } catch (err) {
      request.log.error({ err }, 'invite validate failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/auth/invite/accept', async (request, reply) => {
    try {
      const { token, name, password } = request.body || {}
      if (!isString(token) || !isString(name) || !isString(password)) {
        return reply.code(400).send({ success: false, message: 'token, name and password are required' })
      }
      if (password.length < 8) {
        return reply.code(400).send({ success: false, message: 'Password must be at least 8 characters' })
      }

      const { rows: inviteRows } = await fastify.pg.query(
        'SELECT * FROM invites WHERE token = $1 AND used = false AND expires_at > NOW()',
        [token],
      )
      if (inviteRows.length === 0) {
        return reply.code(410).send({ success: false, error: 'invite_invalid' })
      }
      const invite = inviteRows[0]

      const existing = await fastify.pg.query('SELECT id FROM users WHERE email = $1', [invite.email])
      if (existing.rows.length > 0) {
        return reply.code(409).send({ success: false, message: 'Account already exists' })
      }

      // FIX: previously `'hashed_' + password` was stored, defeating bcrypt.
      const passwordHash = await bcrypt.hash(password, 10)

      const { rows: userRows } = await fastify.pg.query(
        `INSERT INTO users (
           email, name, full_name, role, job_title, department,
           password_hash, status, active, created_at
         )
         VALUES ($1, $2, $2, $3, $4, $5, $6, 'active', true, NOW())
         RETURNING id, email, COALESCE(full_name, name) AS name, role,
                   organization, job_title, department, applicant_type`,
        [
          invite.email, name, invite.role, invite.job_title, invite.department,
          passwordHash,
        ],
      )

      await fastify.pg.query('UPDATE invites SET used = true, used_at = NOW() WHERE id = $1', [invite.id])

      const user = userRows[0]
      const { accessToken, refreshToken } = await createSession(fastify, user, request)
      setAuthCookies(reply, { accessToken, refreshToken })

      return reply.send({
        success: true,
        data: { user: userToDTO(user), token: accessToken },
        message: `Welcome to Vungu RDC, ${name}.`,
      })
    } catch (err) {
      request.log.error({ err }, 'invite accept failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ════════════════════════════════════════════════════════════════════
  // ADMIN USER MANAGEMENT
  // ════════════════════════════════════════════════════════════════════

  fastify.get('/admin/users', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    try {
      // Optional scoping (omit for back-compat: returns everyone):
      //   ?staff=true  → council employees only (the staff console default)
      //   ?staff=false → citizens only (everyone not in a staff role)
      const staff = request.query?.staff
      const where = ['deleted_at IS NULL']
      const params = []
      if (staff === 'true') {
        params.push(STAFF_ROLES)
        where.push(`role = ANY($${params.length})`)
      } else if (staff === 'false') {
        params.push(STAFF_ROLES)
        where.push(`(role IS NULL OR NOT (role = ANY($${params.length})))`)
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

      const { rows } = await fastify.pg.query(
        `SELECT id, email, COALESCE(full_name, name) AS name, role, organization,
                job_title, department, applicant_type, active, status,
                created_at, last_login_at
         FROM users ${whereSql} ORDER BY created_at DESC`,
        params,
      )
      return reply.send({
        success: true,
        data: rows.map(u => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          organization: u.organization,
          jobTitle: u.job_title,
          department: u.department,
          applicantType: u.applicant_type,
          active: u.active,
          status: u.status || (u.active ? 'active' : 'suspended'),
          createdAt: u.created_at,
          lastLogin: u.last_login_at,
        })),
      })
    } catch (err) {
      reply.log.error({ err }, 'list users failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.put('/admin/users/:id', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    try {
      const { id } = request.params
      const { role, status, jobTitle, department, name } = request.body || {}

      if (role && !VALID_USER_ROLES.has(role)) {
        return reply.code(400).send({ success: false, message: 'Invalid role' })
      }
      if (status && !['active', 'suspended'].includes(status)) {
        return reply.code(400).send({ success: false, message: 'Invalid status' })
      }

      const { rows } = await fastify.pg.query(
        `UPDATE users SET
           role       = COALESCE($1, role),
           status     = COALESCE($2, status),
           active     = CASE
                          WHEN $2 = 'suspended' THEN false
                          WHEN $2 = 'active'    THEN true
                          ELSE active
                        END,
           job_title  = COALESCE($3, job_title),
           department = COALESCE($4, department),
           name       = COALESCE($5, name),
           full_name  = COALESCE($5, full_name),
           updated_at = NOW()
         WHERE id = $6
         RETURNING id, email, COALESCE(full_name, name) AS name, role, status,
                   active, job_title, department, applicant_type`,
        [
          role || null, status || null,
          isString(jobTitle, 120) ? jobTitle : null,
          isString(department, 120) ? department : null,
          isString(name, 120) ? name : null,
          id,
        ],
      )
      if (rows.length === 0) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'update user failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/admin/users/:id/suspend', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    try {
      const { id } = request.params
      const { suspended } = request.body || {}
      const newStatus = suspended ? 'suspended' : 'active'
      const { rows } = await fastify.pg.query(
        `UPDATE users SET status = $1, active = $2, updated_at = NOW() WHERE id = $3
         RETURNING id, email, status, active`,
        [newStatus, !suspended, id],
      )
      if (rows.length === 0) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      request.log.error({ err }, 'suspend user failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.delete('/admin/users/:id', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    try {
      const { id } = request.params
      if (id === request.user.id) {
        return reply.code(400).send({ success: false, error: 'cannot_delete_self' })
      }
      // Soft delete (migration 103): the row stays for audit-log attribution and
      // recovery; active=false + status='deleted' lock the account out of login
      // and authenticate(). The email stays reserved until an admin restores or
      // a DBA anonymises the row.
      const { rowCount } = await fastify.pg.query(
        `UPDATE users
            SET active = false, status = 'deleted',
                deleted_at = NOW(), deleted_by = $2, updated_at = NOW()
          WHERE id = $1 AND deleted_at IS NULL`,
        [id, request.user.id],
      )
      if (rowCount === 0) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true })
    } catch (err) {
      request.log.error({ err }, 'delete user failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/admin/users/:id/reset-password', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    try {
      const { id } = request.params
      const { newPassword } = request.body || {}
      if (!isString(newPassword) || newPassword.length < 8) {
        return reply.code(400).send({ success: false, message: 'New password must be at least 8 characters' })
      }
      const passwordHash = await bcrypt.hash(newPassword, 10)
      const { rows } = await fastify.pg.query(
        'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
        [passwordHash, id],
      )
      if (rows.length === 0) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true })
    } catch (err) {
      request.log.error({ err }, 'reset password failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.get('/admin/invites', { preHandler: requireAdmin(fastify) }, async (_request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT i.id, i.token, i.email, i.role, i.job_title, i.department,
                i.used, i.used_at, i.expires_at, i.created_at,
                COALESCE(u.full_name, u.name) AS invited_by_name
         FROM invites i
         LEFT JOIN users u ON u.id = i.invited_by
         ORDER BY i.created_at DESC`,
      )
      return reply.send({
        success: true,
        data: rows.map(r => ({
          id: r.id,
          token: r.token,
          email: r.email,
          role: r.role,
          jobTitle: r.job_title,
          department: r.department,
          used: r.used,
          usedAt: r.used_at,
          expiresAt: r.expires_at,
          createdAt: r.created_at,
          invitedBy: r.invited_by_name,
          inviteUrl: `/invite?token=${r.token}`,
        })),
      })
    } catch (err) {
      reply.log.error({ err }, 'list invites failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.delete('/admin/invites/:id', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    try {
      const { id } = request.params
      await fastify.pg.query('DELETE FROM invites WHERE id = $1 AND used = false', [id])
      return reply.send({ success: true })
    } catch (err) {
      request.log.error({ err }, 'revoke invite failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ════════════════════════════════════════════════════════════════════
  // QGIS API token — admin-provisioned, cryptographically signed (fix F3).
  // The old format accepted any string starting `vungu-api-`; validation
  // now verifies an HS256 signature + type:'api' claim, so tokens cannot be
  // forged. Minting is restricted to admins (they set up the plugin).
  // ════════════════════════════════════════════════════════════════════
  fastify.post('/auth/generate-api-token', { preHandler: requireAdmin(fastify) }, async (request, reply) => {
    const { pluginName } = request.body || {}
    const apiToken = signApiToken({ id: request.user.id, pluginName })
    return reply.send({
      success: true,
      data: {
        apiToken,
        email: request.user.email,
        pluginName: pluginName || 'vungu-qgis-plugin',
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      },
    })
  })

  fastify.post('/auth/validate-api-token', async (request, reply) => {
    const { token } = request.body || {}
    if (!isString(token)) return reply.code(400).send({ success: false, error: 'token_required', valid: false })
    let claims
    try {
      claims = verifyToken(token)
    } catch {
      return reply.code(401).send({ success: false, error: 'invalid_token', valid: false })
    }
    if (claims.type !== 'api') {
      return reply.code(401).send({ success: false, error: 'wrong_token_type', valid: false })
    }
    return reply.send({
      success: true,
      data: { valid: true, permissions: ['api.read', 'api.write', 'layers.sync', 'styles.manage'] },
    })
  })
}

module.exports = { authRoutes }
