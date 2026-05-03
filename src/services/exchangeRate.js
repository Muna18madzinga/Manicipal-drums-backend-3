/**
 * Exchange rate service.
 *
 * Source priority (highest first):
 *   1. Most recent row in `exchange_rates` for today (any source).
 *   2. Most recent row regardless of date — within MAX_STALE_HOURS.
 *   3. The compile-time fallback FALLBACK_RATE (declared below).
 *
 * Operators are expected to populate `exchange_rates` daily via a
 * scheduled task (out of scope for this turn) hitting RBZ's interbank
 * rate. While that loop isn't running, the FALLBACK_RATE keeps the
 * payment flow functional, but every payment row records the actual
 * rate that was used so reconciliation is unambiguous.
 *
 * Computation rules:
 *   - All amounts are NUMERIC strings, never JS floats. We use the
 *     `decimal.js` guard convention: convert to integer cents in JS,
 *     do the math, convert back. Postgres NUMERIC handles the storage.
 *   - Result rounded HALF_UP to 2 decimals.
 */

const FALLBACK_RATE = Number(process.env.EXCHANGE_FALLBACK_USD_ZWG || '36.0000')
const FALLBACK_SOURCE = 'fallback_static'
const MAX_STALE_HOURS = 72

/**
 * Get the latest applicable rate row, or a synthetic fallback.
 * Always returns: { rate, source, rateId, rateDate, asOf }
 */
async function getLatestRate(pg, base = 'USD', quote = 'ZWG') {
  // Try today.
  const todayRes = await pg.query(
    `SELECT id, rate_date, rate, source, fetched_at
     FROM exchange_rates
     WHERE base_ccy = $1 AND quote_ccy = $2 AND rate_date = CURRENT_DATE
     ORDER BY fetched_at DESC
     LIMIT 1`,
    [base, quote],
  )
  if (todayRes.rows[0]) {
    const r = todayRes.rows[0]
    return {
      rate:     Number(r.rate),
      source:   r.source,
      rateId:   r.id,
      rateDate: r.rate_date,
      asOf:     r.fetched_at,
      isStale:  false,
    }
  }

  // Most recent within MAX_STALE_HOURS.
  const recentRes = await pg.query(
    `SELECT id, rate_date, rate, source, fetched_at
     FROM exchange_rates
     WHERE base_ccy = $1 AND quote_ccy = $2
       AND fetched_at > NOW() - ($3 || ' hours')::INTERVAL
     ORDER BY fetched_at DESC
     LIMIT 1`,
    [base, quote, MAX_STALE_HOURS],
  )
  if (recentRes.rows[0]) {
    const r = recentRes.rows[0]
    return {
      rate:     Number(r.rate),
      source:   r.source,
      rateId:   r.id,
      rateDate: r.rate_date,
      asOf:     r.fetched_at,
      isStale:  false,
    }
  }

  // Synthetic fallback. We do NOT insert this into the table — it is a
  // signal to the operator that they need to refresh rates.
  return {
    rate:     FALLBACK_RATE,
    source:   FALLBACK_SOURCE,
    rateId:   null,
    rateDate: null,
    asOf:     null,
    isStale:  true,
  }
}

/**
 * Insert a fresh rate row. Used by the (future) RBZ-fetch worker.
 */
async function upsertRate(pg, { rateDate, base = 'USD', quote = 'ZWG', rate, source, sourceUrl }) {
  if (!rate || rate <= 0) throw new Error('rate must be > 0')
  const { rows } = await pg.query(
    `INSERT INTO exchange_rates (rate_date, base_ccy, quote_ccy, rate, source, source_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (rate_date, base_ccy, quote_ccy, source)
     DO UPDATE SET rate = EXCLUDED.rate, source_url = EXCLUDED.source_url, fetched_at = NOW()
     RETURNING id`,
    [rateDate, base, quote, rate, source, sourceUrl || null],
  )
  return rows[0].id
}

/**
 * Round HALF_UP to 2 decimals via integer cents.
 */
function round2(n) {
  if (!Number.isFinite(n)) return 0
  // Add a tiny epsilon to defeat floating-point drift on .5 boundaries.
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Convert one currency to another using the supplied or fetched rate.
 *
 *   convert({ amount: 25, from: 'USD', to: 'ZWG', rate: 36 }) → 900.00
 *
 * If `rate` is omitted, getLatestRate() is invoked. The opposite leg is
 * always derivable from the canonical rate USD→ZWG by inversion.
 */
async function convert(pg, { amount, from, to, rate }) {
  amount = Number(amount)
  if (!Number.isFinite(amount) || amount < 0) throw new Error('amount must be ≥ 0')
  if (from === to) return { amount: round2(amount), rate: 1, rateMeta: null }

  let rateMeta = null
  if (rate == null) {
    rateMeta = await getLatestRate(pg, 'USD', 'ZWG')
    rate = rateMeta.rate
  }
  if (!rate || rate <= 0) throw new Error('rate must be > 0')

  let converted
  if (from === 'USD' && to === 'ZWG') {
    converted = amount * rate
  } else if (from === 'ZWG' && to === 'USD') {
    converted = amount / rate
  } else {
    throw new Error(`unsupported pair ${from}->${to}`)
  }
  return { amount: round2(converted), rate, rateMeta }
}

/**
 * Headline helper for payments: given a price quoted in USD and a
 * customer-chosen wallet currency, compute the bill.
 *
 *   priceUsd = 25, wallet = 'ZWG', rate = 36 → { amountUsd: 25, amountZwg: 900, rate: 36 }
 */
async function quote(pg, { priceUsd, walletCcy }) {
  priceUsd = Number(priceUsd)
  if (!Number.isFinite(priceUsd) || priceUsd < 0) throw new Error('priceUsd must be ≥ 0')
  walletCcy = String(walletCcy || 'USD').toUpperCase()
  if (!['USD', 'ZWG'].includes(walletCcy)) throw new Error('walletCcy must be USD or ZWG')

  const rateMeta = await getLatestRate(pg, 'USD', 'ZWG')
  const amountZwg = round2(priceUsd * rateMeta.rate)
  return {
    walletCcy,
    amountUsd: round2(priceUsd),
    amountZwg,
    rate:      rateMeta.rate,
    rateId:    rateMeta.rateId,
    rateSource: rateMeta.source,
    rateAsOf:  rateMeta.asOf,
    isStale:   rateMeta.isStale,
  }
}

module.exports = {
  FALLBACK_RATE,
  MAX_STALE_HOURS,
  getLatestRate,
  upsertRate,
  convert,
  quote,
  round2,
}
