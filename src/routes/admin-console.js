// src/routes/admin-console.js
// ─────────────────────────────────────────────────────────────────────────
// The council IT Administrator's console API.
//
//   GET    /admin/overview                everything the landing page counts
//   GET    /admin/audit                   the trail, filtered + paginated (and prunes to retention, daily)
//   GET    /admin/audit/export            the same query as CSV
//   GET    /admin/audit/events            the distinct event types, for filters
//   GET    /admin/sessions                live sessions across ALL users
//   DELETE /admin/sessions/:id            revoke one
//   POST   /admin/users/:id/revoke-sessions   sign an officer out everywhere
//   GET    /admin/login-attempts          sign-in history + lockout state
//   POST   /admin/login-attempts/clear    lift a lockout early
//   GET    /admin/ip-blocks               POST · DELETE /:id (release)
//   GET    /admin/settings                PUT (bulk) · the enforced ones bite
//   GET    /admin/permissions             role × capability, from config
//   GET    /admin/system/health           database, process, migrations
//   GET    /admin/system/tables           row counts and sizes
//   GET    /admin/outbox                  POST /:id/retry · POST /:id/cancel
//   GET    /admin/announcements           POST · PATCH /:id · DELETE /:id
//   GET    /admin/org                     POST · PATCH /:id · DELETE /:id
//   GET    /admin/backups                 what is actually on disk
//
// WHY ONE FILE
// These are one console's endpoints and they share the role gate, the
// pagination shape and the error envelope. Splitting them would mean
// duplicating all three; the alternative — folding them into auth.js — would
// take that file past 1,500 lines of two unrelated concerns.
//
// WHAT THIS MODULE REFUSES TO DO
// Nothing here touches the planning record. The IT Admin provisions people and
// configures the system; they do not determine applications, and no endpoint
// in this file can. That separation is the same one ADMIN_BLOCKED enforces in
// the frontend router, stated once more where the data actually lives.
//
// EVERY ENDPOINT IS requireAdmin. There is no read-only tier: the audit trail
// names who did what, the session list carries addresses, and the settings
// carry the lockout policy. All three are admin-only by nature.
// ─────────────────────────────────────────────────────────────────────────

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { requireAdmin } = require('../middleware/jwtAuth')
const { invalidate, getSetting } = require('../services/adminSettings')
const permissions = require('../config/permissions')
const { activeTransportName } = require('../workers/emailWorker')

// ── Primitives ──────────────────────────────────────────────────────────

const isUuid = (v) =>
  typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v)

const isStr = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max
const orNull = (v, max) => (isStr(v, max) ? v.trim() : null)

/**
 * A page size the caller may choose, within a ceiling the server owns.
 *
 * The ceiling is not politeness: the audit trail grows without bound, and an
 * unbounded LIMIT on it is a way to take the database out from the browser.
 */
function pageArgs(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limit = Math.min(maxLimit, Math.max(1, Number(query?.limit) || defaultLimit))
  const offset = Math.max(0, Number(query?.offset) || 0)
  return { limit, offset }
}

/** An ISO date from the query, or null. Never throws on junk. */
function when(value) {
  if (!value) return null
  const d = new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** RFC 4180 field: quote when it must be, double any quote inside. */
function csvField(value) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

async function adminConsoleRoutes(fastify) {
  const admin = { preHandler: requireAdmin(fastify) }

  // ═════════════════════════════════════════════════════════════════════
  // OVERVIEW
  // ═════════════════════════════════════════════════════════════════════
  // One round trip for the landing page. Eleven counts from eight tables;
  // fetching eight lists and counting them in the browser would move rows
  // across a rural Zimbabwean link only to throw away everything but the
  // length — the same reasoning as /eho/summary.
  fastify.get('/admin/overview', admin, async (_request, reply) => {
    try {
      const { rows } = await fastify.pg.query(`
        SELECT
          (SELECT count(*)::int FROM users
            WHERE deleted_at IS NULL AND role = ANY($1))                         AS staff_total,
          (SELECT count(*)::int FROM users
            WHERE deleted_at IS NULL AND role = ANY($1) AND active
              AND coalesce(status,'active') = 'active')                          AS staff_active,
          (SELECT count(*)::int FROM users
            WHERE deleted_at IS NULL AND role = ANY($1) AND status = 'suspended') AS staff_suspended,
          (SELECT count(*)::int FROM users
            WHERE deleted_at IS NULL AND NOT (role = ANY($1)))                   AS citizens,
          (SELECT count(*)::int FROM invites
            WHERE NOT used AND expires_at > now())                               AS invites_open,
          (SELECT count(*)::int FROM invites
            WHERE NOT used AND expires_at <= now())                              AS invites_expired,
          (SELECT count(*)::int FROM public.user_session
            WHERE revoked_at IS NULL AND expires_at > now())                     AS sessions_live,
          (SELECT count(DISTINCT user_id)::int FROM public.user_session
            WHERE revoked_at IS NULL AND expires_at > now())                     AS users_online,
          (SELECT count(*)::int FROM public.admin_login_attempt
            WHERE NOT succeeded AND attempted_at > now() - interval '24 hours')  AS failed_logins_24h,
          (SELECT count(*)::int FROM public.admin_audit_event
            WHERE occurred_at > now() - interval '24 hours')                     AS audit_events_24h,
          (SELECT count(*)::int FROM public.admin_audit_event
            WHERE severity IN ('high','critical')
              AND occurred_at > now() - interval '7 days')                       AS audit_notable_7d,
          (SELECT count(*)::int FROM public.admin_ip_block
            WHERE released_at IS NULL
              AND (expires_at IS NULL OR expires_at > now()))                    AS ip_blocks_live,
          (SELECT count(*)::int FROM public.notifications_outbox
            WHERE status = 'pending')                                            AS outbox_pending,
          (SELECT count(*)::int FROM public.notifications_outbox
            WHERE status = 'failed')                                             AS outbox_failed,
          (SELECT count(*)::int FROM public.admin_org_position
            WHERE holder_id IS NULL)                                             AS posts_vacant,
          (SELECT count(*)::int FROM public.admin_announcement
            WHERE withdrawn_at IS NULL AND starts_at <= now()
              AND (ends_at IS NULL OR ends_at > now()))                          AS announcements_live
      `, [permissions.STAFF_ROLES])

      const r = rows[0]
      return reply.send({
        success: true,
        data: {
          staff: {
            total: r.staff_total,
            active: r.staff_active,
            suspended: r.staff_suspended,
            // Neither active nor suspended: invited but never signed in.
            pending: r.staff_total - r.staff_active - r.staff_suspended,
          },
          citizens: r.citizens,
          invites: { open: r.invites_open, expired: r.invites_expired },
          sessions: { live: r.sessions_live, users: r.users_online },
          security: {
            failedLogins24h: r.failed_logins_24h,
            ipBlocks: r.ip_blocks_live,
            notable7d: r.audit_notable_7d,
          },
          audit: { events24h: r.audit_events_24h },
          outbox: { pending: r.outbox_pending, failed: r.outbox_failed },
          org: { vacancies: r.posts_vacant },
          announcements: { live: r.announcements_live },
        },
      })
    } catch (err) {
      logErr(fastify, err, 'admin overview failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ═════════════════════════════════════════════════════════════════════
  // AUDIT TRAIL
  // ═════════════════════════════════════════════════════════════════════

  /**
   * The WHERE clause and its parameters, built once and shared by the JSON
   * listing and the CSV export — so an operator who filters the screen and
   * then exports gets the rows they were looking at, not a different set.
   */
  function auditFilter(query) {
    const where = []
    const params = []
    const add = (sql, value) => { params.push(value); where.push(sql.replace('$?', `$${params.length}`)) }

    const from = when(query?.from)
    const to = when(query?.to)
    if (from) add('occurred_at >= $?', from)
    if (to) add('occurred_at <= $?', to)

    if (isStr(query?.event, 48)) add('event = $?', query.event.trim())
    if (isStr(query?.severity, 12) && ['low', 'medium', 'high', 'critical'].includes(query.severity)) {
      add('severity = $?', query.severity)
    }
    if (isUuid(query?.actor)) add('actor_id = $?', query.actor)
    if (isStr(query?.entityType, 48)) add('entity_type = $?', query.entityType.trim())
    if (isStr(query?.entityId, 64)) add('entity_id = $?', query.entityId.trim())
    if (query?.failuresOnly === 'true') where.push('status >= 400')

    // Free text over the three columns an operator actually types into: who,
    // what path, and which record.
    if (isStr(query?.q, 120)) {
      params.push(`%${query.q.trim().toLowerCase()}%`)
      where.push(`(lower(actor_email) LIKE $${params.length}
                   OR lower(path) LIKE $${params.length}
                   OR lower(coalesce(entity_id,'')) LIKE $${params.length})`)
    }

    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
  }

  /**
   * Apply the council's retention period.
   *
   * WHY IT RUNS HERE AND NOT ON A SCHEDULE
   * This deployment has no job scheduler, and adding one to prune a table would
   * be a lot of machinery for a daily DELETE. Piggy-backing on the audit
   * listing is enough: the trail is read by an administrator at least as often
   * as it needs pruning, and the day-guard means the cost lands on one request
   * per day rather than on every page of every filter.
   *
   * CRITICAL EVENTS ARE NEVER PRUNED. A determination or a privilege change is
   * the record a retention policy exists to protect, not to expire.
   *
   * Failure is swallowed: an administrator reading the trail must not be shown
   * an error because a housekeeping DELETE could not run.
   */
  let lastPrune = 0
  async function pruneAudit() {
    const DAY = 86_400_000
    if (Date.now() - lastPrune < DAY) return
    lastPrune = Date.now()
    try {
      const days = await getSetting(fastify, 'audit.retention_days')
      if (!Number.isFinite(Number(days)) || Number(days) < 30) return
      const { rowCount } = await fastify.pg.query(
        `DELETE FROM public.admin_audit_event
          WHERE occurred_at < now() - ($1 || ' days')::interval
            AND severity <> 'critical'`,
        [String(Math.floor(Number(days)))],
      )
      if (rowCount) fastify.log.info({ rowCount, days }, 'audit trail pruned to retention period')
    } catch (err) {
      fastify.log.warn({ err }, 'audit prune failed')
    }
  }

  fastify.get('/admin/audit', admin, async (request, reply) => {
    try {
      void pruneAudit()
      const { limit, offset } = pageArgs(request.query, { defaultLimit: 50, maxLimit: 200 })
      const { sql, params } = auditFilter(request.query)

      const [list, count] = await Promise.all([
        fastify.pg.query(
          `SELECT id, occurred_at, actor_id, actor_email, actor_role,
                  event, severity, method, path, status, duration_ms,
                  entity_type, entity_id, host(ip) AS ip, details
             FROM public.admin_audit_event
             ${sql}
            ORDER BY occurred_at DESC, id DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset],
        ),
        // The count is what lets the console say "1–50 of 2,431" instead of
        // "there may be more". Same filter, so the two can never disagree.
        fastify.pg.query(`SELECT count(*)::int AS n FROM public.admin_audit_event ${sql}`, params),
      ])

      return reply.send({
        success: true,
        data: list.rows,
        meta: { total: count.rows[0].n, limit, offset },
      })
    } catch (err) {
      logErr(fastify, err, 'audit list failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  /** The event vocabulary actually present, so the filter offers real choices. */
  fastify.get('/admin/audit/events', admin, async (_request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT event, count(*)::int AS n, max(occurred_at) AS last_seen
           FROM public.admin_audit_event
          WHERE occurred_at > now() - interval '90 days'
          GROUP BY event ORDER BY n DESC`,
      )
      return reply.send({ success: true, data: rows })
    } catch (err) {
      logErr(fastify, err, 'audit events failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  /**
   * CSV export.
   *
   * Streamed as text rather than assembled as JSON and converted in the
   * browser: an auditor's export is tens of thousands of rows, and building
   * that string twice — once as JSON, once as CSV — is the difference between
   * a download and a tab that stops responding. Hard-capped at 50,000 rows,
   * with the cap stated in the response headers so a truncated export is never
   * mistaken for a complete one.
   */
  fastify.get('/admin/audit/export', admin, async (request, reply) => {
    try {
      const MAX = 50_000
      const { sql, params } = auditFilter(request.query)
      const { rows } = await fastify.pg.query(
        `SELECT occurred_at, actor_email, actor_role, event, severity,
                method, path, status, duration_ms, entity_type, entity_id, host(ip) AS ip
           FROM public.admin_audit_event
           ${sql}
          ORDER BY occurred_at DESC
          LIMIT ${MAX}`,
        params,
      )

      const header = 'occurred_at,actor_email,actor_role,event,severity,method,path,status,duration_ms,entity_type,entity_id,ip'
      const body = rows.map((r) => [
        r.occurred_at?.toISOString?.() ?? r.occurred_at,
        r.actor_email, r.actor_role, r.event, r.severity, r.method, r.path,
        r.status, r.duration_ms, r.entity_type, r.entity_id, r.ip,
      ].map(csvField).join(',')).join('\n')

      const stamp = new Date().toISOString().slice(0, 10)
      reply.header('Content-Type', 'text/csv; charset=utf-8')
      reply.header('Content-Disposition', `attachment; filename="vungu-audit-${stamp}.csv"`)
      reply.header('X-Row-Count', String(rows.length))
      reply.header('X-Row-Limit', String(MAX))
      return reply.send(`${header}\n${body}\n`)
    } catch (err) {
      logErr(fastify, err, 'audit export failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ═════════════════════════════════════════════════════════════════════
  // SESSIONS
  // ═════════════════════════════════════════════════════════════════════
  // /auth/sessions is scoped to the caller's own sessions by design. This is
  // the other question — "who is signed in right now, and from where" — which
  // only the IT Admin may ask, and which they need after a laptop is lost.
  fastify.get('/admin/sessions', admin, async (request, reply) => {
    try {
      const { limit, offset } = pageArgs(request.query, { defaultLimit: 100, maxLimit: 500 })
      const where = ['s.revoked_at IS NULL', 's.expires_at > now()']
      const params = []
      if (isUuid(request.query?.user)) {
        params.push(request.query.user)
        where.push(`s.user_id = $${params.length}`)
      }
      if (request.query?.includeExpired === 'true') where.splice(0, 2)

      const { rows } = await fastify.pg.query(
        `SELECT s.id, s.user_id, s.ip, s.user_agent,
                s.created_at, s.last_used_at, s.expires_at, s.revoked_at,
                u.email, COALESCE(u.full_name, u.name) AS name, u.role
           FROM public.user_session s
           JOIN public.users u ON u.id = s.user_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY s.last_used_at DESC NULLS LAST
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset],
      )
      return reply.send({
        success: true,
        // The caller's own session is flagged so the console can stop them
        // revoking the session they are using and locking themselves out.
        data: rows.map((r) => ({ ...r, current: r.id === request.sessionId })),
        meta: { limit, offset },
      })
    } catch (err) {
      logErr(fastify, err, 'admin sessions failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.delete('/admin/sessions/:id', admin, async (request, reply) => {
    try {
      const { id } = request.params
      if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
      const { rowCount } = await fastify.pg.query(
        'UPDATE public.user_session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
        [id],
      )
      if (!rowCount) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true })
    } catch (err) {
      logErr(fastify, err, 'revoke session failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  /**
   * Sign one officer out of every device.
   *
   * The action after a lost laptop or a departure, and the reason it is one
   * endpoint rather than a loop of deletes in the browser: half a revocation
   * is worse than none, so it happens in one statement.
   */
  fastify.post('/admin/users/:id/revoke-sessions', admin, async (request, reply) => {
    try {
      const { id } = request.params
      if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
      const { rowCount } = await fastify.pg.query(
        'UPDATE public.user_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [id],
      )
      return reply.send({ success: true, data: { revoked: rowCount } })
    } catch (err) {
      logErr(fastify, err, 'revoke all sessions failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ═════════════════════════════════════════════════════════════════════
  // SIGN-IN SECURITY
  // ═════════════════════════════════════════════════════════════════════
  fastify.get('/admin/login-attempts', admin, async (request, reply) => {
    try {
      const { limit, offset } = pageArgs(request.query, { defaultLimit: 100, maxLimit: 500 })
      const where = []
      const params = []
      if (request.query?.failuresOnly === 'true') where.push('NOT a.succeeded')
      if (isStr(request.query?.email, 255)) {
        params.push(`%${request.query.email.trim().toLowerCase()}%`)
        where.push(`lower(a.email) LIKE $${params.length}`)
      }
      const from = when(request.query?.from)
      if (from) { params.push(from); where.push(`a.attempted_at >= $${params.length}`) }

      const [list, locked] = await Promise.all([
        fastify.pg.query(
          `SELECT a.id, a.attempted_at, a.email, a.user_id, host(a.ip) AS ip,
                  a.user_agent, a.succeeded, a.reason,
                  COALESCE(u.full_name, u.name) AS name, u.role
             FROM public.admin_login_attempt a
             LEFT JOIN public.users u ON u.id = a.user_id
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY a.attempted_at DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset],
        ),
        // Which addresses are locked out right now, computed the same way
        // loginSecurity.lockoutState computes it — failures since the last
        // success — so the console never shows a lockout the login route
        // would not apply.
        fastify.pg.query(
          `WITH s AS (
             SELECT lower(email) AS email, max(attempted_at) AS at
               FROM public.admin_login_attempt WHERE succeeded GROUP BY 1
           )
           SELECT lower(a.email) AS email,
                  count(*)::int  AS failures,
                  max(a.attempted_at) AS last_failure
             FROM public.admin_login_attempt a
             LEFT JOIN s ON s.email = lower(a.email)
            WHERE NOT a.succeeded AND a.reason <> 'locked_out'
              AND (s.at IS NULL OR a.attempted_at > s.at)
            GROUP BY 1
           HAVING count(*) >= (
             SELECT COALESCE(NULLIF(value,'')::int, 5)
               FROM public.admin_setting WHERE key = 'security.max_failed_attempts'
           )
            ORDER BY failures DESC`,
        ),
      ])

      return reply.send({
        success: true,
        data: list.rows,
        meta: { limit, offset, lockedOut: locked.rows },
      })
    } catch (err) {
      logErr(fastify, err, 'login attempts failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  /**
   * Lift a lockout before the window expires.
   *
   * Recorded as a synthetic SUCCESS rather than by deleting the failures: the
   * failures are evidence, and the lockout rule counts "failures since the
   * last success", so one row both clears the count and leaves a trail saying
   * who lifted it. Deleting would erase the incident.
   */
  fastify.post('/admin/login-attempts/clear', admin, async (request, reply) => {
    try {
      const email = orNull(request.body?.email, 255)
      if (!email) return reply.code(400).send({ success: false, error: 'email_required' })
      await fastify.pg.query(
        `INSERT INTO public.admin_login_attempt (email, ip, user_agent, succeeded, reason)
         VALUES ($1, $2::inet, $3, true, NULL)`,
        [email, null, `lockout cleared by ${request.user.email}`],
      )
      return reply.send({ success: true })
    } catch (err) {
      logErr(fastify, err, 'clear lockout failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── IP blocklist ──────────────────────────────────────────────────────
  fastify.get('/admin/ip-blocks', admin, async (request, reply) => {
    try {
      const live = request.query?.includeReleased !== 'true'
      const { rows } = await fastify.pg.query(
        `SELECT b.id, b.cidr::text AS cidr, b.reason, b.created_at, b.expires_at,
                b.released_at,
                COALESCE(c.full_name, c.name) AS created_by_name,
                COALESCE(r.full_name, r.name) AS released_by_name
           FROM public.admin_ip_block b
           LEFT JOIN public.users c ON c.id = b.created_by
           LEFT JOIN public.users r ON r.id = b.released_by
          ${live ? 'WHERE b.released_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > now())' : ''}
          ORDER BY b.created_at DESC`,
      )
      return reply.send({ success: true, data: rows })
    } catch (err) {
      logErr(fastify, err, 'ip blocks failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/admin/ip-blocks', admin, async (request, reply) => {
    try {
      const cidr = orNull(request.body?.cidr, 60)
      const reason = orNull(request.body?.reason, 500)
      if (!cidr || !reason) {
        return reply.code(400).send({ success: false, error: 'cidr_and_reason_required' })
      }
      const expiresAt = when(request.body?.expiresAt)

      // Postgres validates the CIDR: no regex here could tell 10.0.0.0/8 from
      // 10.0.0.1/8 (which is an error) as reliably as the type does.
      const { rows } = await fastify.pg.query(
        `INSERT INTO public.admin_ip_block (cidr, reason, expires_at, created_by)
         VALUES ($1::cidr, $2, $3, $4)
         ON CONFLICT (cidr) DO UPDATE
            SET reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at,
                created_by = EXCLUDED.created_by, created_at = now(),
                released_at = NULL, released_by = NULL
         RETURNING id, cidr::text AS cidr, reason, created_at, expires_at`,
        [cidr, reason, expiresAt, request.user.id],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      // 22P02 = invalid text representation: the operator typed something that
      // is not an address. That is a 400, not a server fault.
      if (err?.code === '22P02') {
        return reply.code(400).send({
          success: false, error: 'invalid_cidr',
          message: 'Enter an address (198.51.100.4) or a range (198.51.100.0/24).',
        })
      }
      logErr(fastify, err, 'create ip block failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.delete('/admin/ip-blocks/:id', admin, async (request, reply) => {
    try {
      const { id } = request.params
      if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
      const { rowCount } = await fastify.pg.query(
        `UPDATE public.admin_ip_block
            SET released_at = now(), released_by = $2
          WHERE id = $1 AND released_at IS NULL`,
        [id, request.user.id],
      )
      if (!rowCount) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true })
    } catch (err) {
      logErr(fastify, err, 'release ip block failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ═════════════════════════════════════════════════════════════════════
  // SETTINGS
  // ═════════════════════════════════════════════════════════════════════
  fastify.get('/admin/settings', admin, async (_request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT s.key, s.value, s.value_type, s.category, s.label, s.description,
                s.constraints, s.enforced, s.secret, s.updated_at,
                COALESCE(u.full_name, u.name) AS updated_by_name
           FROM public.admin_setting s
           LEFT JOIN public.users u ON u.id = s.updated_by
          ORDER BY s.category, s.key`,
      )
      return reply.send({
        success: true,
        // A secret is reported as set-or-not, never echoed. The console renders
        // an empty field with "leave blank to keep".
        data: rows.map((r) => (r.secret ? { ...r, value: r.value ? '••••••••' : '' } : r)),
      })
    } catch (err) {
      logErr(fastify, err, 'settings read failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  /**
   * Bulk update.
   *
   * One transaction for the whole form: a security page that saved four of six
   * settings and then failed would leave the council's policy in a state
   * nobody chose. Each value is validated against the row's own declared type
   * and constraints, so the rules live with the setting rather than here.
   */
  fastify.put('/admin/settings', admin, async (request, reply) => {
    const updates = request.body?.settings
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return reply.code(400).send({ success: false, error: 'settings_object_required' })
    }

    const client = await fastify.pg.connect()
    try {
      await client.query('BEGIN')

      const keys = Object.keys(updates)
      if (keys.length === 0) {
        await client.query('ROLLBACK')
        return reply.send({ success: true, data: { updated: 0 } })
      }

      const { rows: defs } = await client.query(
        'SELECT key, value_type, constraints FROM public.admin_setting WHERE key = ANY($1)',
        [keys],
      )
      const byKey = new Map(defs.map((d) => [d.key, d]))

      const rejected = []
      for (const key of keys) {
        const def = byKey.get(key)
        if (!def) { rejected.push({ key, why: 'unknown setting' }); continue }
        const problem = validateSetting(def, updates[key])
        if (problem) rejected.push({ key, why: problem })
      }
      if (rejected.length) {
        await client.query('ROLLBACK')
        return reply.code(400).send({ success: false, error: 'invalid_settings', data: { rejected } })
      }

      for (const key of keys) {
        await client.query(
          `UPDATE public.admin_setting
              SET value = $2, updated_at = now(), updated_by = $3
            WHERE key = $1`,
          [key, serialize(byKey.get(key).value_type, updates[key]), request.user.id],
        )
      }

      await client.query('COMMIT')
      // Drop the read cache so the change bites on the very next request
      // rather than up to the TTL later.
      invalidate()
      return reply.send({ success: true, data: { updated: keys.length } })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      logErr(fastify, err, 'settings write failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    } finally {
      client.release()
    }
  })

  // ═════════════════════════════════════════════════════════════════════
  // PERMISSIONS
  // ═════════════════════════════════════════════════════════════════════
  // Served from src/config/permissions.js rather than hand-written in the
  // browser, so the matrix an admin reads before granting a role is the one
  // this repository vouches for. See that file's header.
  fastify.get('/admin/permissions', admin, async (_request, reply) => {
    return reply.send({
      success: true,
      data: {
        roles: permissions.ASSIGNABLE_ROLES.map((id) => ({
          id,
          ...permissions.ROLE_LABELS[id],
          capabilities: permissions.capabilitiesFor(id),
        })),
        capabilities: permissions.matrix(),
      },
    })
  })

  // ═════════════════════════════════════════════════════════════════════
  // SYSTEM
  // ═════════════════════════════════════════════════════════════════════
  fastify.get('/admin/system/health', admin, async (_request, reply) => {
    try {
      const { rows } = await fastify.pg.query(`
        SELECT current_database()                                   AS database,
               version()                                            AS pg_version,
               pg_size_pretty(pg_database_size(current_database()))  AS size,
               pg_database_size(current_database())                  AS size_bytes,
               (SELECT count(*)::int FROM pg_stat_activity
                 WHERE datname = current_database())                 AS connections,
               (SELECT setting::int FROM pg_settings
                 WHERE name = 'max_connections')                     AS max_connections,
               (SELECT extract(epoch FROM now() - pg_postmaster_start_time())::int) AS pg_uptime_s,
               (SELECT count(*)::int FROM pg_extension
                 WHERE extname = 'postgis')                          AS postgis
      `)
      const db = rows[0]

      // The migrations table is optional — a database restored from a dump may
      // not carry it — so a missing table reports "unknown" rather than 500ing
      // the whole health page.
      let migrations = null
      try {
        const m = await fastify.pg.query(
          'SELECT count(*)::int AS applied, max(name) AS latest FROM public.schema_migrations',
        )
        migrations = m.rows[0]
      } catch { migrations = null }

      const mem = process.memoryUsage()
      return reply.send({
        success: true,
        data: {
          database: {
            name: db.database,
            version: String(db.pg_version).split(' ').slice(0, 2).join(' '),
            size: db.size,
            sizeBytes: Number(db.size_bytes),
            connections: db.connections,
            maxConnections: db.max_connections,
            uptimeSeconds: db.pg_uptime_s,
            postgis: db.postgis > 0,
          },
          migrations,
          process: {
            node: process.version,
            uptimeSeconds: Math.round(process.uptime()),
            rssBytes: mem.rss,
            heapUsedBytes: mem.heapUsed,
            env: process.env.NODE_ENV || 'development',
          },
          host: {
            platform: `${os.type()} ${os.release()}`,
            cpus: os.cpus().length,
            totalMemBytes: os.totalmem(),
            freeMemBytes: os.freemem(),
            // 1/5/15-minute load. Always [0,0,0] on Windows; the console says
            // so rather than drawing three flat lines and implying an idle box.
            loadAvg: os.loadavg(),
            loadAvgSupported: os.platform() !== 'win32',
          },
        },
      })
    } catch (err) {
      logErr(fastify, err, 'system health failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  /**
   * Table inventory.
   *
   * Live row estimates from pg_stat_user_tables rather than count(*) per
   * table: an exact count over the 24 spatial layers reads every heap page in
   * the database, which is a minute of I/O to draw one screen. n_live_tup is
   * within a percent after any autovacuum and costs nothing — the console
   * labels the column "approx" so nobody quotes it as a figure.
   */
  fastify.get('/admin/system/tables', admin, async (_request, reply) => {
    try {
      const { rows } = await fastify.pg.query(`
        SELECT n.nspname                                   AS schema,
               c.relname                                   AS name,
               COALESCE(s.n_live_tup, 0)::bigint           AS rows_approx,
               pg_total_relation_size(c.oid)               AS bytes,
               pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
               s.last_autovacuum, s.last_analyze
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
         WHERE c.relkind = 'r'
           AND n.nspname IN ('public', 'spatial_planning', 'survey')
         ORDER BY pg_total_relation_size(c.oid) DESC
         LIMIT 200
      `)
      return reply.send({
        success: true,
        data: rows.map((r) => ({ ...r, rows_approx: Number(r.rows_approx), bytes: Number(r.bytes) })),
      })
    } catch (err) {
      logErr(fastify, err, 'system tables failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ═════════════════════════════════════════════════════════════════════
  // NOTIFICATION OUTBOX
  // ═════════════════════════════════════════════════════════════════════
  // The council's outgoing mail. When an applicant says "I was never told",
  // this is where the answer is, which makes it an IT-support surface rather
  // than a planning one.
  fastify.get('/admin/outbox', admin, async (request, reply) => {
    try {
      const { limit, offset } = pageArgs(request.query, { defaultLimit: 50, maxLimit: 200 })
      const where = []
      const params = []
      const status = request.query?.status
      if (['pending', 'sent', 'failed', 'cancelled'].includes(status)) {
        params.push(status); where.push(`status = $${params.length}`)
      }
      if (isStr(request.query?.q, 160)) {
        params.push(`%${request.query.q.trim().toLowerCase()}%`)
        where.push(`(lower(email) LIKE $${params.length} OR lower(subject) LIKE $${params.length})`)
      }

      const [list, counts] = await Promise.all([
        fastify.pg.query(
          `SELECT id, email, channel, kind, subject, status, attempts, last_error,
                  scheduled_at, sent_at, created_at
             FROM public.notifications_outbox
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY created_at DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset],
        ),
        fastify.pg.query(
          `SELECT status, count(*)::int AS n FROM public.notifications_outbox GROUP BY status`,
        ),
      ])

      // What "sent" actually means in this deployment. The console needs it:
      // on the console transport the worker advances a row to 'sent' after
      // printing the message to the server log, and nothing leaves the
      // building. An administrator told that 86 notifications were sent has to
      // know which of those two happened.
      const transport = activeTransportName()
      return reply.send({
        success: true,
        data: list.rows,
        meta: {
          limit, offset,
          counts: Object.fromEntries(counts.rows.map((r) => [r.status, r.n])),
          delivery: {
            workerRunning: process.env.MAIL_WORKER_INPROC === '1',
            transport,
            // The one sentence that matters, composed here so the two clients
            // that will eventually ask cannot word it differently.
            delivers: transport === 'smtp',
          },
        },
      })
    } catch (err) {
      logErr(fastify, err, 'outbox list failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  /**
   * Put a failed message back in the queue.
   *
   * attempts is reset to 0 so the dispatcher's own max-attempts rule gives it
   * a fresh run; leaving the count would have it fail again immediately and
   * make the button look broken.
   */
  fastify.post('/admin/outbox/:id/retry', admin, async (request, reply) => {
    try {
      const { id } = request.params
      if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
      const { rows } = await fastify.pg.query(
        `UPDATE public.notifications_outbox
            SET status = 'pending', attempts = 0, last_error = NULL,
                scheduled_at = now(), updated_at = now()
          WHERE id = $1 AND status IN ('failed', 'cancelled')
          RETURNING id, status`,
        [id],
      )
      if (!rows.length) {
        return reply.code(409).send({
          success: false, error: 'not_retryable',
          message: 'Only a failed or cancelled message can be retried.',
        })
      }
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      logErr(fastify, err, 'outbox retry failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/admin/outbox/:id/cancel', admin, async (request, reply) => {
    try {
      const { id } = request.params
      if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
      const { rows } = await fastify.pg.query(
        `UPDATE public.notifications_outbox
            SET status = 'cancelled', updated_at = now()
          WHERE id = $1 AND status = 'pending'
          RETURNING id, status`,
        [id],
      )
      if (!rows.length) {
        return reply.code(409).send({
          success: false, error: 'not_cancellable',
          message: 'Only a message still waiting to be sent can be cancelled.',
        })
      }
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      logErr(fastify, err, 'outbox cancel failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ═════════════════════════════════════════════════════════════════════
  // ANNOUNCEMENTS
  // ═════════════════════════════════════════════════════════════════════
  fastify.get('/admin/announcements', admin, async (request, reply) => {
    try {
      const all = request.query?.all === 'true'
      const { rows } = await fastify.pg.query(
        `SELECT a.id, a.title, a.body, a.level, a.audience,
                a.starts_at, a.ends_at, a.created_at, a.withdrawn_at,
                COALESCE(u.full_name, u.name) AS created_by_name
           FROM public.admin_announcement a
           LEFT JOIN public.users u ON u.id = a.created_by
          ${all ? '' : `WHERE a.withdrawn_at IS NULL AND (a.ends_at IS NULL OR a.ends_at > now())`}
          ORDER BY a.starts_at DESC`,
      )
      return reply.send({ success: true, data: rows })
    } catch (err) {
      logErr(fastify, err, 'announcements failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/admin/announcements', admin, async (request, reply) => {
    try {
      const title = orNull(request.body?.title, 160)
      const body = orNull(request.body?.body, 4000)
      if (!title || !body) return reply.code(400).send({ success: false, error: 'title_and_body_required' })

      const level = ['info', 'warning', 'critical'].includes(request.body?.level) ? request.body.level : 'info'
      const audience = ['all', 'staff', 'admin'].includes(request.body?.audience) ? request.body.audience : 'staff'
      const startsAt = when(request.body?.startsAt) || new Date().toISOString()
      const endsAt = when(request.body?.endsAt)

      if (endsAt && endsAt <= startsAt) {
        return reply.code(400).send({ success: false, error: 'ends_before_starts' })
      }

      const { rows } = await fastify.pg.query(
        `INSERT INTO public.admin_announcement (title, body, level, audience, starts_at, ends_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, title, body, level, audience, starts_at, ends_at, created_at`,
        [title, body, level, audience, startsAt, endsAt, request.user.id],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      logErr(fastify, err, 'create announcement failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.patch('/admin/announcements/:id', admin, async (request, reply) => {
    try {
      const { id } = request.params
      if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
      const b = request.body || {}
      const { rows } = await fastify.pg.query(
        `UPDATE public.admin_announcement SET
           title     = COALESCE($2, title),
           body      = COALESCE($3, body),
           level     = COALESCE($4, level),
           audience  = COALESCE($5, audience),
           starts_at = COALESCE($6, starts_at),
           ends_at   = CASE WHEN $7::boolean THEN $8 ELSE ends_at END
         WHERE id = $1
         RETURNING id, title, body, level, audience, starts_at, ends_at, withdrawn_at`,
        [
          id,
          orNull(b.title, 160), orNull(b.body, 4000),
          ['info', 'warning', 'critical'].includes(b.level) ? b.level : null,
          ['all', 'staff', 'admin'].includes(b.audience) ? b.audience : null,
          when(b.startsAt),
          // COALESCE cannot express "set this to null": the caller has to say
          // it means it, which `endsAt` being present in the body does.
          Object.hasOwn(b, 'endsAt'), when(b.endsAt),
        ],
      )
      if (!rows.length) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      logErr(fastify, err, 'update announcement failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  /** Withdraw, not delete: an announcement that was live is a fact. */
  fastify.delete('/admin/announcements/:id', admin, async (request, reply) => {
    try {
      const { id } = request.params
      if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
      const { rowCount } = await fastify.pg.query(
        'UPDATE public.admin_announcement SET withdrawn_at = now() WHERE id = $1 AND withdrawn_at IS NULL',
        [id],
      )
      if (!rowCount) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true })
    } catch (err) {
      logErr(fastify, err, 'withdraw announcement failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ═════════════════════════════════════════════════════════════════════
  // ORGANISATION STRUCTURE
  // ═════════════════════════════════════════════════════════════════════
  fastify.get('/admin/org', admin, async (_request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        `SELECT p.id, p.title, p.department, p.system_role, p.holder_id,
                p.reports_to, p.sort_order,
                COALESCE(u.full_name, u.name) AS holder_name,
                u.email  AS holder_email,
                u.role   AS holder_role,
                u.status AS holder_status
           FROM public.admin_org_position p
           LEFT JOIN public.users u ON u.id = p.holder_id AND u.deleted_at IS NULL
          ORDER BY p.sort_order, p.title`,
      )
      return reply.send({
        success: true,
        // The mismatch flag is the point of holding system_role separately: a
        // Building Inspector post held by an account carrying `viewer` is the
        // access problem an IT admin is asked to find, and it is invisible in
        // a user list sorted by name.
        data: rows.map((r) => ({
          ...r,
          roleMismatch: Boolean(r.holder_id && r.system_role && r.holder_role !== r.system_role),
        })),
      })
    } catch (err) {
      logErr(fastify, err, 'org read failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.post('/admin/org', admin, async (request, reply) => {
    try {
      const title = orNull(request.body?.title, 160)
      if (!title) return reply.code(400).send({ success: false, error: 'title_required' })
      const { rows } = await fastify.pg.query(
        `INSERT INTO public.admin_org_position (title, department, system_role, holder_id, reports_to, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          title,
          orNull(request.body?.department, 120),
          permissions.ALL_ROLES.includes(request.body?.systemRole) ? request.body.systemRole : null,
          isUuid(request.body?.holderId) ? request.body.holderId : null,
          isUuid(request.body?.reportsTo) ? request.body.reportsTo : null,
          Number(request.body?.sortOrder) || 0,
        ],
      )
      return reply.code(201).send({ success: true, data: rows[0] })
    } catch (err) {
      logErr(fastify, err, 'create org position failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.patch('/admin/org/:id', admin, async (request, reply) => {
    try {
      const { id } = request.params
      if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
      const b = request.body || {}

      // A post cannot report to itself; the table's CHECK says so too, but a
      // 400 explains it and a constraint violation does not.
      if (isUuid(b.reportsTo) && b.reportsTo === id) {
        return reply.code(400).send({ success: false, error: 'self_parent' })
      }

      const { rows } = await fastify.pg.query(
        `UPDATE public.admin_org_position SET
           title       = COALESCE($2, title),
           department  = CASE WHEN $3::boolean THEN $4 ELSE department END,
           system_role = CASE WHEN $5::boolean THEN $6 ELSE system_role END,
           holder_id   = CASE WHEN $7::boolean THEN $8 ELSE holder_id END,
           reports_to  = CASE WHEN $9::boolean THEN $10 ELSE reports_to END,
           sort_order  = COALESCE($11, sort_order),
           updated_at  = now()
         WHERE id = $1
         RETURNING id`,
        [
          id,
          orNull(b.title, 160),
          // Each of these four can legitimately be cleared — a post can be
          // vacated, or moved to the top of the chart — so presence in the
          // body, not truthiness, decides whether it is written.
          Object.hasOwn(b, 'department'), orNull(b.department, 120),
          Object.hasOwn(b, 'systemRole'), permissions.ALL_ROLES.includes(b.systemRole) ? b.systemRole : null,
          Object.hasOwn(b, 'holderId'), isUuid(b.holderId) ? b.holderId : null,
          Object.hasOwn(b, 'reportsTo'), isUuid(b.reportsTo) ? b.reportsTo : null,
          Number.isFinite(Number(b.sortOrder)) ? Number(b.sortOrder) : null,
        ],
      )
      if (!rows.length) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true, data: rows[0] })
    } catch (err) {
      logErr(fastify, err, 'update org position failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  fastify.delete('/admin/org/:id', admin, async (request, reply) => {
    try {
      const { id } = request.params
      if (!isUuid(id)) return reply.code(400).send({ success: false, error: 'bad_id' })
      // The FK is ON DELETE SET NULL, so subordinate posts survive as
      // top-level rather than disappearing with their parent.
      const { rowCount } = await fastify.pg.query(
        'DELETE FROM public.admin_org_position WHERE id = $1', [id],
      )
      if (!rowCount) return reply.code(404).send({ success: false, error: 'not_found' })
      return reply.send({ success: true })
    } catch (err) {
      logErr(fastify, err, 'delete org position failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ═════════════════════════════════════════════════════════════════════
  // BACKUPS
  // ═════════════════════════════════════════════════════════════════════
  /**
   * What is actually on disk in backups/, which scripts/backup-db.js writes.
   *
   * Read from the filesystem rather than from a table of backup runs: a table
   * would record what the app BELIEVES was backed up, and the question an IT
   * admin needs answered before a risky migration is whether the file is
   * really there. A recorded run whose file has been deleted is the exact
   * failure this avoids.
   */
  fastify.get('/admin/backups', admin, async (_request, reply) => {
    const dir = path.resolve(__dirname, '..', '..', 'backups')
    try {
      if (!fs.existsSync(dir)) {
        return reply.send({
          success: true,
          data: { directory: dir, exists: false, files: [] },
        })
      }
      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.dump') || f.endsWith('.zip'))
        .map((f) => {
          const stat = fs.statSync(path.join(dir, f))
          return {
            name: f,
            kind: f.startsWith('uploads-') ? 'uploads' : 'database',
            bytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          }
        })
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))

      const newest = files[0]
      return reply.send({
        success: true,
        data: {
          directory: dir,
          exists: true,
          files,
          // The figure that matters: how old the most recent backup is. The
          // console turns this into a warning past 7 days.
          newestAgeHours: newest
            ? Math.round((Date.now() - new Date(newest.modifiedAt).getTime()) / 36e5)
            : null,
          // Stated rather than implied: this endpoint lists the SECONDARY,
          // manual backups. Render's automatic snapshots are the primary and
          // are not visible from here.
          note: 'Manual/secondary backups written by `npm run backup`. Render Postgres snapshots are the primary backup and are managed in the Render dashboard.',
        },
      })
    } catch (err) {
      logErr(fastify, err, 'backups list failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

// ── Helpers used above ──────────────────────────────────────────────────

/** A log line that works whether or not `request` is in scope. */
function logErr(fastify, err, message) {
  fastify.log.error({ err }, message)
}

/**
 * Validate one submitted value against its row's declared type and
 * constraints. Returns a human sentence when it is wrong, or null when it is
 * fine — the caller collects these so the form reports every problem at once
 * rather than one per round trip.
 */
function validateSetting(def, value) {
  const c = def.constraints || {}
  switch (def.value_type) {
    case 'number': {
      const n = Number(value)
      if (!Number.isFinite(n)) return 'must be a number'
      if (c.min !== undefined && n < c.min) return `must be at least ${c.min}`
      if (c.max !== undefined && n > c.max) return `must be at most ${c.max}`
      return null
    }
    case 'boolean':
      return typeof value === 'boolean' || value === 'true' || value === 'false'
        ? null : 'must be true or false'
    case 'json': {
      if (Array.isArray(c.choices)) {
        const list = Array.isArray(value) ? value : null
        if (!list) return 'must be a list'
        const bad = list.filter((v) => !c.choices.includes(v))
        if (bad.length) return `not permitted: ${bad.join(', ')}`
      }
      try { JSON.stringify(value); return null } catch { return 'must be valid JSON' }
    }
    default: {
      if (typeof value !== 'string') return 'must be text'
      if (c.max !== undefined && value.length > c.max) return `must be at most ${c.max} characters`
      if (Array.isArray(c.choices) && !c.choices.includes(value)) return `must be one of: ${c.choices.join(', ')}`
      return null
    }
  }
}

/** The text form the column stores, per declared type. */
function serialize(type, value) {
  if (type === 'json') return JSON.stringify(value)
  if (type === 'boolean') return String(value === true || value === 'true')
  return String(value)
}

module.exports = { adminConsoleRoutes, validateSetting, serialize }
