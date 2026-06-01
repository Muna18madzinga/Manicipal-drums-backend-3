/**
 * Notifier — outbox writer + pluggable sender.
 *
 * Why an outbox: SMTP / SMS providers go down. If we tried to call them
 * synchronously from the request handler, a transient outage would
 * cause the whole request to fail (and possibly leave the DB and the
 * inbox out of sync). Instead, every "send X" intent is committed to
 * notifications_outbox in the same transaction as the DB change that
 * triggered it. A separate worker (out of scope this turn) drains
 * 'pending' rows and dispatches them.
 *
 * For now there is no worker — the rows still serve as:
 *   - an audit trail ("we did fire a notification when status changed"),
 *   - a UI feed ("recent activity"),
 *   - a queue once a worker is wired in (just flip rows to 'sent').
 *
 * Templates live in this file, deliberately hand-written rather than
 * Handlebars. Adding a real templating engine is one of the smallest
 * follow-ups when a designer wants HTML emails.
 */

const APP_NAME    = 'Vungu Spatial Data Portal'
const COUNCIL     = 'Vungu Rural District Council'
const APP_BASE    = process.env.FRONTEND_URL || 'http://localhost:5174'

// ════════════════════════════════════════════════════════════════════
// Templates — keep them small + plain. Each returns { subject, text }.
// HTML templates can be added later; the worker can choose the format.
// ════════════════════════════════════════════════════════════════════

function appTrackUrl(applicationId) {
  return `${APP_BASE}/applications/${encodeURIComponent(applicationId)}`
}

function inspectionTrackUrl(applicationId) {
  return `${APP_BASE}/applications/${encodeURIComponent(applicationId)}#inspections`
}

const TEMPLATES = {
  application_status_change({ applicationId, fromStatus, toStatus, name }) {
    const greeting = name ? `Hello ${name},` : 'Hello,'
    return {
      subject: `${COUNCIL}: application ${applicationId} — ${prettyStatus(toStatus)}`,
      text: [
        greeting,
        '',
        `Your development application ${applicationId} is now: ${prettyStatus(toStatus)}.`,
        fromStatus ? `(was: ${prettyStatus(fromStatus)})` : '',
        '',
        `You can track progress at ${appTrackUrl(applicationId)}.`,
        '',
        `— ${COUNCIL}`,
      ].filter(Boolean).join('\n'),
    }
  },

  inspection_scheduled({ applicationId, stageNumber, stageName, scheduledFor, name }) {
    const greeting = name ? `Hello ${name},` : 'Hello,'
    return {
      subject: `${COUNCIL}: inspection scheduled — Stage ${stageNumber} (${stageName})`,
      text: [
        greeting,
        '',
        `Your Stage ${stageNumber} inspection (${stageName}) for application ${applicationId} is scheduled for:`,
        formatDate(scheduledFor),
        '',
        'A building inspector will visit the site at the time above.',
        `Track progress at ${inspectionTrackUrl(applicationId)}.`,
        '',
        `— ${COUNCIL}`,
      ].join('\n'),
    }
  },

  inspection_rescheduled({ applicationId, stageNumber, stageName, oldDate, newDate, name }) {
    const greeting = name ? `Hello ${name},` : 'Hello,'
    return {
      subject: `${COUNCIL}: inspection rescheduled — Stage ${stageNumber}`,
      text: [
        greeting,
        '',
        `Your Stage ${stageNumber} inspection (${stageName}) for application ${applicationId} has been rescheduled.`,
        oldDate ? `Was: ${formatDate(oldDate)}` : '',
        `Now: ${formatDate(newDate)}`,
        '',
        `If this date does not work, contact the council promptly.`,
        `Track progress at ${inspectionTrackUrl(applicationId)}.`,
        '',
        `— ${COUNCIL}`,
      ].filter(Boolean).join('\n'),
    }
  },

  inspection_waitlisted({ applicationId, stageNumber, stageName, name }) {
    const greeting = name ? `Hello ${name},` : 'Hello,'
    return {
      subject: `${COUNCIL}: inspection booking received — on the waitlist`,
      text: [
        greeting,
        '',
        `Payment received for your Stage ${stageNumber} (${stageName}) inspection on application ${applicationId}.`,
        `You are now on the waitlist. We will email you a date as soon as a building inspector is assigned.`,
        '',
        `— ${COUNCIL}`,
      ].join('\n'),
    }
  },

  application_fee_paid({ permitId, name, receipt }) {
    const greeting = name ? `Hello ${name},` : 'Hello,'
    return {
      subject: `${COUNCIL}: application fee received — ${permitId}`,
      text: [
        greeting,
        '',
        `We have received your application fee for permit application ${permitId}.`,
        `Receipt number: ${receipt}.`,
        `Your application has been registered and will be reviewed shortly.`,
        '',
        `— ${COUNCIL}`,
      ].join('\n'),
    }
  },

  inspection_completed({ applicationId, stageNumber, stageName, passed, notes, name }) {
    const greeting = name ? `Hello ${name},` : 'Hello,'
    const verdict = passed ? 'PASSED' : 'FAILED'
    return {
      subject: `${COUNCIL}: Stage ${stageNumber} inspection — ${verdict}`,
      text: [
        greeting,
        '',
        `Your Stage ${stageNumber} (${stageName}) inspection for application ${applicationId} has been completed.`,
        `Result: ${verdict}.`,
        notes ? `\nInspector notes:\n${notes}` : '',
        '',
        `Track progress at ${inspectionTrackUrl(applicationId)}.`,
        '',
        `— ${COUNCIL}`,
      ].filter(Boolean).join('\n'),
    }
  },
}

function prettyStatus(s) {
  if (!s) return 'Unknown'
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function formatDate(iso) {
  if (!iso) return 'date to be confirmed'
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-GB', {
      weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Harare',
    })
  } catch {
    return String(iso)
  }
}

/**
 * Write a single notification to the outbox.
 * The caller must have the `recipient` available — we don't look it up
 * here so the notifier can be used both with and without a DB lookup.
 *
 * Returns the inserted row id.
 */
async function enqueue(pg, {
  userId, email,
  channel = 'email',
  kind,
  templateData = {},
  subject, text,
  payload = {},
}) {
  // Render template if not pre-rendered.
  if ((!subject || !text) && TEMPLATES[kind]) {
    const rendered = TEMPLATES[kind](templateData || {})
    subject = subject || rendered.subject
    text    = text    || rendered.text
  }
  if (!subject || !text) {
    throw new Error(`notifier.enqueue: no template for kind=${kind} and no subject/text provided`)
  }
  if (!userId && !email) {
    // We accept that some kinds (in_app) don't need an email; require at
    // least *some* recipient hint or we'd be queuing unaddressable rows.
    throw new Error('notifier.enqueue: userId or email is required')
  }

  const { rows } = await pg.query(
    `INSERT INTO notifications_outbox (user_id, email, channel, kind, subject, body_text, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB)
     RETURNING id`,
    [userId || null, email || null, channel, kind, subject, text, JSON.stringify(payload || {})],
  )
  return rows[0].id
}

/**
 * Convenience: log + enqueue an application status change.
 *
 * Writes:
 *   1. application_status_history (audit row)
 *   2. notifications_outbox row to email the citizen
 *
 * Both happen in the caller's transaction (we accept a `pg` param and
 * the caller decides whether they wrap calls in BEGIN/COMMIT).
 */
async function recordApplicationStatusChange(pg, {
  applicationId, fromStatus, toStatus,
  changedBy,                         // actor user UUID
  citizenUserId, citizenEmail, citizenName,
  notes,
}) {
  await pg.query(
    `INSERT INTO application_status_history
       (application_id, from_status, to_status, changed_by, notes)
     VALUES ($1, $2, $3, $4, $5)`,
    [applicationId, fromStatus || null, toStatus, changedBy || null, notes || null],
  )

  if (citizenUserId || citizenEmail) {
    await enqueue(pg, {
      userId: citizenUserId, email: citizenEmail,
      kind: 'application_status_change',
      templateData: {
        applicationId, fromStatus, toStatus, name: citizenName,
      },
      payload: { applicationId, fromStatus, toStatus },
    })
  }
}

module.exports = {
  TEMPLATES,
  enqueue,
  recordApplicationStatusChange,
}
