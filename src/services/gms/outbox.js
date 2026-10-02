// src/services/gms/outbox.js
// ─────────────────────────────────────────────────────────────────────────
// Transactional outbox. enqueue() takes the caller's transaction client, so
// an event exists if and only if the change that caused it committed.
// Delivery happens later and never blocks editing (business rule 10).
// ─────────────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5

/** Minutes to wait after the n-th failed attempt: 1, 2, 4, 8 ... capped at 60. */
const backoffMinutes = (attempts) => Math.min(60, 2 ** Math.max(0, attempts - 1))

async function enqueue(client, type, payload, idempotencyKey) {
  const { rows } = await client.query(
    `INSERT INTO integration.outbox_event (type, payload, idempotency_key)
     VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING event_id`,
    [type, JSON.stringify(payload), idempotencyKey],
  )
  return rows[0]?.event_id ?? null
}

/** The wire shape: every field the contract promises, nothing internal. */
const envelope = (r) => ({
  event_id: r.event_id,
  type: r.type,
  version: r.version,
  occurred_at: r.occurred_at,
  source: r.source,
  idempotency_key: r.idempotency_key,
  payload: r.payload,
})

/**
 * Deliver one event now. Claims the row with SKIP LOCKED so two workers (or a
 * worker and a manual retry) never send the same event concurrently.
 *
 * ponytail: the row lock is held across the ERP call (up to the adapter
 * timeout). Fine at council volumes; switch to a claimed_until lease column
 * if the queue ever needs parallel workers.
 */
async function deliverOne(pg, adapter, eventId) {
  const client = await pg.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT * FROM integration.outbox_event
        WHERE event_id = $1 AND status = 'pending'
        FOR UPDATE SKIP LOCKED`,
      [eventId],
    )
    const ev = rows[0]
    if (!ev) { await client.query('ROLLBACK'); return null }

    let result
    try {
      result = await adapter.deliver(envelope(ev))
    } catch (err) {
      const attempts = ev.attempts + 1
      const failed = attempts >= MAX_ATTEMPTS
      await client.query(
        `UPDATE integration.outbox_event
            SET attempts = $2, last_error = $3,
                status = $4,
                next_attempt_at = now() + ($5 || ' minutes')::interval
          WHERE event_id = $1`,
        [ev.event_id, attempts, String(err.message).slice(0, 500),
          failed ? 'failed' : 'pending', String(backoffMinutes(attempts))],
      )
      await client.query('COMMIT')
      return { event_id: ev.event_id, status: failed ? 'failed' : 'pending', error: err.message }
    }

    await client.query(
      `UPDATE integration.outbox_event
          SET attempts = attempts + 1, status = $2::text, reply = $3::jsonb, last_error = NULL,
              acknowledged_at = CASE WHEN $2::text = 'acknowledged' THEN now() END
        WHERE event_id = $1`,
      [ev.event_id, result.status, JSON.stringify(result.reply ?? null)],
    )
    await client.query('COMMIT')
    return { event_id: ev.event_id, status: result.status }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** One worker tick: deliver whatever is due, oldest first. */
async function deliverDue(pg, adapter, limit = 50) {
  const { rows } = await pg.query(
    `SELECT event_id FROM integration.outbox_event
      WHERE status = 'pending' AND next_attempt_at <= now()
      ORDER BY occurred_at LIMIT $1`,
    [limit],
  )
  const results = []
  for (const r of rows) results.push(await deliverOne(pg, adapter, r.event_id))
  return results.filter(Boolean)
}

module.exports = { enqueue, deliverOne, deliverDue, backoffMinutes, MAX_ATTEMPTS }
