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

const aiClient = require('./aiClient')

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
  application_received({ applicationId, reference, devType, standNumber, suburbWard, name }) {
    const greeting = name ? `Hello ${name},` : 'Hello,'
    const ref = reference || applicationId
    return {
      subject: `${COUNCIL}: application received — ${ref}`,
      text: [
        greeting,
        '',
        `Thank you for submitting your development application to ${COUNCIL}.`,
        `We have received it and registered it under reference ${ref}.`,
        standNumber ? `Site: Stand ${standNumber}${suburbWard ? ', ' + suburbWard : ''}.` : '',
        devType ? `Type of development: ${prettyStatus(devType)}.` : '',
        '',
        'What happens next: a planning clerk will check your documents and acknowledge ' +
          'your application. Once it is acknowledged, the statutory determination period begins. ' +
          'We will email you whenever the status changes — you do not need to do anything right now.',
        '',
        `You can follow progress at ${appTrackUrl(applicationId)}.`,
        '',
        `— ${COUNCIL}`,
      ].filter(Boolean).join('\n'),
    }
  },

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
  subject, text, html,
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
    `INSERT INTO notifications_outbox (user_id, email, channel, kind, subject, body_text, body_html, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB)
     RETURNING id`,
    [userId || null, email || null, channel, kind, subject, text, html || null, JSON.stringify(payload || {})],
  )
  return rows[0].id
}

/**
 * Wrap a plain-text email body in minimal, email-safe HTML. One <p> per
 * blank-line-separated block; single newlines become <br>. Keeps the council
 * letterhead simple and inline-styled (email clients ignore <style>).
 */
function textToHtml(text) {
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  const blocks = String(text).split(/\n{2,}/).map(b => b.trim()).filter(Boolean)
  const paras = blocks
    .map(b => `<p style="margin:0 0 1em;">${esc(b).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;line-height:1.6;max-width:560px;">
${paras}
</div>`
}

/**
 * Enqueue the "application received" acknowledgement, optionally fine-tuned
 * by the Claude text model. The deterministic template is always the floor:
 * if the model is unconfigured, slow, or returns something unusable, the
 * citizen still gets a correct, well-formed email.
 *
 * The subject stays deterministic (it carries the reference number); only the
 * body is rephrased, and only when the model preserves the reference + link.
 */
async function enqueueApplicationReceived(pg, {
  userId, email, name,
  applicationId, reference, devType, standNumber, suburbWard,
}) {
  const base = TEMPLATES.application_received({
    applicationId, reference, devType, standNumber, suburbWard, name,
  })
  const ref = reference || applicationId
  const trackUrl = appTrackUrl(applicationId)

  let bodyText = base.text
  try {
    const polished = await aiClient.chatText({
      system:
        `You write short, warm, professional acknowledgement emails for ${COUNCIL}, ` +
        `a Zimbabwean rural district council planning office. Use British English. ` +
        `No marketing language, no exclamation marks, no emojis, no markdown — plain text only. ` +
        `Keep it under 160 words. You MUST keep the reference number and the tracking link ` +
        `exactly as given, and sign off on a final line as "— ${COUNCIL}".`,
      user:
        `Write the body of an email confirming we received a citizen's development application.\n` +
        `Facts:\n` +
        `- Applicant name: ${name || '(unknown)'}\n` +
        `- Reference number: ${ref}\n` +
        `- Development type: ${devType || '(unspecified)'}\n` +
        `- Site: ${standNumber ? 'Stand ' + standNumber + (suburbWard ? ', ' + suburbWard : '') : '(not given)'}\n` +
        `- Tracking link: ${trackUrl}\n` +
        `Explain that the application is registered, a planning clerk will check the documents and ` +
        `acknowledge it, the statutory determination period starts on acknowledgement, and they will ` +
        `be emailed when the status changes. Return only the email body text.`,
      temperature: 0.4,
      maxTokens: 320,
    })
    // Only accept the rewrite if it kept the reference and the tracking link —
    // otherwise it has drifted and we keep the safe template.
    if (polished && polished.includes(ref) && polished.includes(trackUrl)) {
      bodyText = polished
    }
  } catch {
    // keep the template
  }

  return enqueue(pg, {
    userId, email,
    kind: 'application_received',
    subject: base.subject,
    text: bodyText,
    html: textToHtml(bodyText),
    payload: { applicationId, reference: ref },
  })
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
  enqueueApplicationReceived,
  recordApplicationStatusChange,
}
