/**
 * First-party usage analytics: validation of what the browser sends, storage, retention and the
 * report the admin console reads. See migration 131 (page_view) for what is deliberately NOT stored.
 *
 * The server cannot prove a visitor consented: consent is the browser's, enforced in the client
 * (services/analytics.ts) and again here for Do Not Track. What the server CAN do is make sure
 * nothing identifying could be stored even by a client that lied: only a route pattern, a random
 * visitor id and a bare host are accepted, and everything else in the request is ignored.
 */

const { systemOf } = require('../lib/dbContext')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Route patterns look like /applications/:id or /admin/plan-workbench. No query, no fragment.
const PATH_RE = /^\/[A-Za-z0-9/_:.-]{0,198}$/
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/
const COUNCIL_TZ = 'Africa/Harare'
const REPORT_WINDOWS = [7, 30, 90]

/**
 * A pattern, never a concrete URL. A segment that looks like a record id (a UUID, or a run of
 * digits long enough to be a reference) means the client sent a real URL; refuse it rather than
 * store an identifier.
 */
function looksConcrete(path) {
  return path.split('/').some((seg) => UUID_RE.test(seg) || /\d{5,}/.test(seg))
}

/** Returns the cleaned fields to store, or { error } for a request to refuse. */
function parsePageView(body) {
  const b = body && typeof body === 'object' ? body : {}
  if (typeof b.path !== 'string' || !PATH_RE.test(b.path)) return { error: 'bad_path' }
  if (looksConcrete(b.path)) return { error: 'bad_path' }
  let visitorId = null
  if (b.visitorId !== undefined && b.visitorId !== null) {
    if (typeof b.visitorId !== 'string' || !UUID_RE.test(b.visitorId)) return { error: 'bad_visitor' }
    visitorId = b.visitorId.toLowerCase()
  }
  let referrerHost = null
  if (b.referrerHost !== undefined && b.referrerHost !== null) {
    const h = typeof b.referrerHost === 'string' ? b.referrerHost.toLowerCase() : ''
    if (!HOST_RE.test(h)) return { error: 'bad_referrer' }
    referrerHost = h
  }
  return { path: b.path, visitorId, referrerHost }
}

/** Do Not Track from the request itself, as a second line behind the client's own check. */
const doNotTrack = (headers) => headers && (headers.dnt === '1' || headers['sec-gpc'] === '1')

async function recordPageView(pg, v) {
  await systemOf(pg).query(
    'INSERT INTO public.page_view (path, visitor_id, referrer_host) VALUES ($1, $2, $3)',
    [v.path, v.visitorId, v.referrerHost])
}

/**
 * Delete page views older than the council's retention period. Day-guarded per process: the
 * cost lands on one request a day. There is no job scheduler in this deployment (the audit trail
 * prunes the same way). A period under 30 days is ignored as nonsense rather than obeyed.
 */
function makePruner(pg, getRetentionDays, log) {
  let last = 0
  return async function prune(now = Date.now()) {
    const DAY = 86_400_000
    if (now - last < DAY) return 0
    last = now
    try {
      const days = Number(await getRetentionDays())
      if (!Number.isFinite(days) || days < 30) return 0
      const { rowCount } = await systemOf(pg).query(
        "DELETE FROM public.page_view WHERE occurred_at < now() - ($1 || ' days')::interval",
        [String(Math.floor(days))])
      if (rowCount) log?.info?.({ rowCount, days }, 'page views pruned to retention period')
      return rowCount
    } catch (err) {
      log?.warn?.({ err }, 'page view prune failed')
      return 0
    }
  }
}

/** The window an admin may ask for: 7 by default, otherwise one of the offered windows. */
function parseWindow(value) {
  const n = Number(value)
  return REPORT_WINDOWS.includes(n) ? n : 7
}

/**
 * Totals, a row per calendar day (days with no views included, oldest first) and the most viewed
 * route patterns. Days are the council's local days, not UTC.
 */
async function usageReport(pg, days) {
  const win = parseWindow(days)
  const params = [win, COUNCIL_TZ]
  const { rows: [totals] } = await systemOf(pg).query(
    `SELECT COUNT(*)::int AS views, COUNT(DISTINCT visitor_id)::int AS visitors
       FROM public.page_view
      WHERE occurred_at >= (date_trunc('day', now() AT TIME ZONE $2) - ($1::int - 1) * interval '1 day') AT TIME ZONE $2`, params)
  const { rows: daily } = await systemOf(pg).query(
    `WITH d AS (
       SELECT generate_series(
                date_trunc('day', now() AT TIME ZONE $2) - ($1::int - 1) * interval '1 day',
                date_trunc('day', now() AT TIME ZONE $2), interval '1 day') AS day)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            COUNT(p.id)::int AS views,
            COUNT(DISTINCT p.visitor_id)::int AS visitors
       FROM d LEFT JOIN public.page_view p
         ON date_trunc('day', p.occurred_at AT TIME ZONE $2) = d.day
      GROUP BY d.day ORDER BY d.day`, params)
  const { rows: topPaths } = await systemOf(pg).query(
    `SELECT path, COUNT(*)::int AS views, COUNT(DISTINCT visitor_id)::int AS visitors
       FROM public.page_view
      WHERE occurred_at >= (date_trunc('day', now() AT TIME ZONE $2) - ($1::int - 1) * interval '1 day') AT TIME ZONE $2
      GROUP BY path ORDER BY views DESC, path LIMIT 15`, params)
  return { days: win, totalViews: totals.views, distinctVisitors: totals.visitors, daily, topPaths }
}

module.exports = { parsePageView, looksConcrete, doNotTrack, recordPageView, makePruner, parseWindow, usageReport, REPORT_WINDOWS }
