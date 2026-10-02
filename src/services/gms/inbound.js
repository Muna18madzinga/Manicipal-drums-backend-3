// src/services/gms/inbound.js
// ─────────────────────────────────────────────────────────────────────────
// ERP -> GMS events. Exactly-once by construction: the inbound_event row and
// the effect commit together, and the row's unique event_id/idempotency_key
// turns a redelivery into a no-op.
// ─────────────────────────────────────────────────────────────────────────

const crypto = require('node:crypto')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BANDS = new Set(['current', 'in_arrears', 'closed'])

/** HMAC-SHA256 of the raw body, sent as `x-erp-signature: sha256=<hex>`. */
function verifySignature(rawBody, header, secret) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest()
  const given = Buffer.from(header.slice(7), 'hex')
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
}

// Business rule 5: money stays in the ERP. Whatever the ERP sends, amount
// fields are dropped before the payload is logged or read.
const MONEY_KEY = /amount|balance|owing|outstanding|arrears_value|total_due/i
function stripMoney(v) {
  if (Array.isArray(v)) return v.map(stripMoney)
  if (!v || typeof v !== 'object') return v
  return Object.fromEntries(Object.entries(v)
    .filter(([k]) => !MONEY_KEY.test(k))
    .map(([k, x]) => [k, stripMoney(x)]))
}

function envelopeError(ev) {
  if (!ev || typeof ev !== 'object') return 'body'
  if (!UUID.test(ev.event_id || '')) return 'event_id'
  if (typeof ev.type !== 'string' || !ev.type) return 'type'
  if (!Number.isInteger(ev.version)) return 'version'
  if (Number.isNaN(Date.parse(ev.occurred_at))) return 'occurred_at'
  if (typeof ev.source !== 'string' || !ev.source) return 'source'
  if (typeof ev.idempotency_key !== 'string' || !ev.idempotency_key) return 'idempotency_key'
  if (!ev.payload || typeof ev.payload !== 'object') return 'payload'
  return null
}

const HANDLERS = {
  async AccountLinked(client, p) {
    if (!p.parcel_id || !p.erp_account_no) return ['rejected', 'parcel_id and erp_account_no are required']
    const parcel = (await client.query(
      'SELECT status FROM land.parcel WHERE parcel_id = $1 FOR UPDATE', [p.parcel_id],
    )).rows[0]
    if (!parcel) return ['rejected', `unknown parcel ${p.parcel_id}`]
    if (parcel.status === 'retired') return ['rejected', `parcel ${p.parcel_id} is retired`]
    await client.query(
      `INSERT INTO revenue_link.account_link (parcel_id, erp_account_no, linked_on, verified_by)
       VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), 'ERP')
       ON CONFLICT DO NOTHING`,
      [p.parcel_id, String(p.erp_account_no), p.allocation_date || null],
    )
    await client.query(
      `UPDATE land.parcel SET allocation_status = 'allocated' WHERE parcel_id = $1`, [p.parcel_id],
    )
    return ['applied', null]
  },

  // Nightly. One account or a batch under `accounts`. Only the band and its
  // date are read: amounts in the payload are dropped, never stored (rule 5).
  async BillingStatusUpdated(client, p) {
    const items = Array.isArray(p.accounts) ? p.accounts : [p]
    let applied = 0
    for (const it of items) {
      if (!it?.erp_account_no || !BANDS.has(it.status_band) || Number.isNaN(Date.parse(it.as_at))) continue
      await client.query(
        `INSERT INTO revenue_link.billing_status (erp_account_no, status_band, as_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (erp_account_no) DO UPDATE
           SET status_band = EXCLUDED.status_band, as_at = EXCLUDED.as_at
         WHERE revenue_link.billing_status.as_at <= EXCLUDED.as_at`,
        [String(it.erp_account_no), it.status_band, it.as_at],
      )
      applied++
    }
    return applied ? ['applied', `${applied} of ${items.length} accounts`] : ['rejected', 'no valid accounts']
  },
}

/**
 * Returns { duplicate: true } for a redelivery, otherwise the outcome.
 * Types without a handler yet are kept as 'ignored' so a later phase can
 * replay them from integration.inbound_event.
 */
async function handleInbound(pg, raw) {
  const ev = { ...raw, payload: stripMoney(raw.payload) }
  const client = await pg.connect()
  try {
    await client.query('BEGIN')
    const inserted = await client.query(
      `INSERT INTO integration.inbound_event
         (event_id, type, version, occurred_at, source, idempotency_key, payload, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'ignored')
       ON CONFLICT DO NOTHING RETURNING event_id`,
      [ev.event_id, ev.type, ev.version, ev.occurred_at, ev.source, ev.idempotency_key,
        JSON.stringify(ev.payload)],
    )
    if (inserted.rowCount === 0) {
      await client.query('ROLLBACK')
      return { duplicate: true }
    }

    const handler = HANDLERS[ev.type]
    const [outcome, note] = handler
      ? await handler(client, ev.payload)
      : ['ignored', `no handler for ${ev.type} yet`]
    await client.query(
      'UPDATE integration.inbound_event SET outcome = $2, note = $3 WHERE event_id = $1',
      [ev.event_id, outcome, note],
    )
    await client.query('COMMIT')
    return { duplicate: false, outcome, note }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

module.exports = { handleInbound, verifySignature, envelopeError, stripMoney }
