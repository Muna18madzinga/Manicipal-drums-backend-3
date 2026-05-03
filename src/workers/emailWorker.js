/**
 * Email worker — drains pending rows from notifications_outbox.
 *
 * Design:
 *   - Polls every POLL_INTERVAL_MS (default 30s) for `status='pending'`
 *     rows where `channel='email'` and `scheduled_at <= NOW()`.
 *   - Locks each row with `SELECT ... FOR UPDATE SKIP LOCKED` so multiple
 *     instances of the worker can run safely (horizontal scale).
 *   - Calls the active transport's `send({ to, subject, text, html? })`.
 *   - On success: status='sent', sent_at=NOW().
 *   - On transient failure: status stays 'pending', attempts++, last_error
 *     populated, scheduled_at += backoff(attempts).
 *   - On permanent failure (or max attempts reached): status='failed'.
 *
 * Transports:
 *   - 'console' (default in dev / when SMTP unconfigured) — prints to stdout
 *     so engineers can see what would have been sent.
 *   - 'smtp' — uses nodemailer if installed AND env SMTP_HOST is set.
 *
 * Adding Mailgun / SendGrid is one new factory: implement `send()` against
 * their REST API and select it via process.env.MAIL_TRANSPORT.
 *
 * Operational notes:
 *   - Boot the worker by running `node src/workers/emailWorker.js` in its
 *     own process, OR import startEmailWorker() from server.js (we do the
 *     latter when MAIL_WORKER_INPROC=1 — convenient for single-instance dev).
 *   - The worker NEVER blocks request paths.
 */

const POLL_INTERVAL_MS = Number(process.env.MAIL_POLL_MS || 30_000)
const BATCH_SIZE       = Number(process.env.MAIL_BATCH || 25)
const MAX_ATTEMPTS     = Number(process.env.MAIL_MAX_ATTEMPTS || 5)

// Transient errors retry; permanent ones give up immediately.
const PERMANENT_CODES = new Set(['EENVELOPE', 'EAUTH', 'EADDRESS'])

// ════════════════════════════════════════════════════════════════════
// Transports
// ════════════════════════════════════════════════════════════════════

/**
 * Console transport — used in dev or when SMTP is unconfigured. Does NOT
 * actually send mail; it logs what would have been sent. Returns
 * { ok: true } so the worker advances the row to 'sent'.
 */
function makeConsoleTransport(log) {
  return {
    name: 'console',
    async send({ to, subject, text }) {
      const banner = '─'.repeat(60)
      log.info(
        '\n' + banner +
        `\n[email/console] To: ${to}\n[email/console] Subject: ${subject}` +
        '\n' + text + '\n' + banner,
      )
      return { ok: true }
    },
  }
}

/**
 * SMTP transport — requires nodemailer to be installed. We resolve it at
 * factory time so the rest of the codebase doesn't pay for the dep when
 * it's not used.
 */
function makeSmtpTransport(log) {
  let nodemailer
  try {
    // eslint-disable-next-line global-require
    nodemailer = require('nodemailer')
  } catch {
    log.warn('SMTP transport requested but nodemailer is not installed; falling back to console.')
    return makeConsoleTransport(log)
  }
  const host = process.env.SMTP_HOST
  const port = Number(process.env.SMTP_PORT || 587)
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  const from = process.env.SMTP_FROM || 'no-reply@vungurdc.gov.zw'
  if (!host) {
    log.warn('SMTP transport requested but SMTP_HOST is not set; falling back to console.')
    return makeConsoleTransport(log)
  }

  const transporter = nodemailer.createTransport({
    host, port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
  })

  return {
    name: 'smtp',
    async send({ to, subject, text, html }) {
      try {
        const info = await transporter.sendMail({ from, to, subject, text, html })
        return { ok: true, providerMessageId: info.messageId }
      } catch (err) {
        return {
          ok: false,
          error: err.message || String(err),
          permanent: PERMANENT_CODES.has(err.code),
        }
      }
    },
  }
}

function selectTransport(log) {
  const desired = String(process.env.MAIL_TRANSPORT || 'console').toLowerCase()
  if (desired === 'smtp') return makeSmtpTransport(log)
  return makeConsoleTransport(log)
}

// ════════════════════════════════════════════════════════════════════
// Worker
// ════════════════════════════════════════════════════════════════════

function backoffMs(attempts) {
  // 30s, 2m, 5m, 15m, 1h.
  return [30_000, 120_000, 300_000, 900_000, 3_600_000][Math.min(attempts, 4)]
}

async function processBatch(pg, transport, log) {
  // Use a transaction so the rows are FOR UPDATE-locked while we send.
  // SKIP LOCKED lets parallel workers each take a different slice.
  const client = await pg.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id, user_id, email, kind, subject, body_text, body_html, attempts
       FROM notifications_outbox
       WHERE status = 'pending'
         AND channel = 'email'
         AND scheduled_at <= NOW()
         AND email IS NOT NULL
       ORDER BY scheduled_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [BATCH_SIZE],
    )

    if (rows.length === 0) {
      await client.query('COMMIT')
      return { processed: 0, sent: 0, failed: 0 }
    }

    let sent = 0
    let failed = 0
    for (const row of rows) {
      let result
      try {
        result = await transport.send({
          to: row.email,
          subject: row.subject,
          text: row.body_text,
          html: row.body_html || undefined,
        })
      } catch (err) {
        result = { ok: false, error: err.message || String(err), permanent: false }
      }

      if (result.ok) {
        await client.query(
          `UPDATE notifications_outbox
              SET status = 'sent',
                  sent_at = NOW(),
                  last_error = NULL,
                  updated_at = NOW()
            WHERE id = $1`,
          [row.id],
        )
        sent++
      } else {
        const nextAttempts = row.attempts + 1
        const giveUp = result.permanent || nextAttempts >= MAX_ATTEMPTS
        if (giveUp) {
          await client.query(
            `UPDATE notifications_outbox
                SET status     = 'failed',
                    attempts   = $2,
                    last_error = $3,
                    updated_at = NOW()
              WHERE id = $1`,
            [row.id, nextAttempts, result.error || 'send failed'],
          )
        } else {
          const delay = backoffMs(row.attempts)
          await client.query(
            `UPDATE notifications_outbox
                SET attempts     = $2,
                    last_error   = $3,
                    scheduled_at = NOW() + ($4 || ' milliseconds')::INTERVAL,
                    updated_at   = NOW()
              WHERE id = $1`,
            [row.id, nextAttempts, result.error || 'send failed', delay],
          )
        }
        failed++
      }
    }

    await client.query('COMMIT')
    return { processed: rows.length, sent, failed }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Start an in-process polling loop. Returns a stop() function.
 *
 * Use this from server.js when MAIL_WORKER_INPROC=1, so single-instance
 * deployments don't need a second process. Multi-instance deployments
 * should run the worker as its own service (see the bottom of this file).
 */
function startEmailWorker(pg, options = {}) {
  const log = options.log || console
  const transport = selectTransport(log)
  let stopped = false
  let timer = null

  log.info?.(`[email] worker started, transport=${transport.name}, poll=${POLL_INTERVAL_MS}ms`)

  async function tick() {
    if (stopped) return
    try {
      const r = await processBatch(pg, transport, log)
      if (r.processed > 0) {
        log.info?.(`[email] processed=${r.processed} sent=${r.sent} failed=${r.failed}`)
      }
    } catch (err) {
      log.error?.({ err }, '[email] batch failed')
    } finally {
      if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS)
    }
  }
  // Kick off immediately so a freshly-enqueued row is sent within ~1s, not 30s.
  setTimeout(tick, 500)

  return function stop() {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

module.exports = { startEmailWorker, processBatch, selectTransport }

// ════════════════════════════════════════════════════════════════════
// Standalone runner.
// Usage: node src/workers/emailWorker.js
// ════════════════════════════════════════════════════════════════════
if (require.main === module) {
  // eslint-disable-next-line global-require
  const { Pool } = require('pg')
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ||
      'postgresql://postgres:cairo2025@localhost:5432/vungu_master_db_v1',
  })
  startEmailWorker(pool, { log: console })

  process.on('SIGINT', () => { process.exit(0) })
  process.on('SIGTERM', () => { process.exit(0) })
}
