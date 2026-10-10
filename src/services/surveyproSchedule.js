/**
 * Running the SurveyPro importer on a schedule, safely: which councils to read, one run at a time, and a record of every run.
 *
 * The rules of the import itself are in src/services/surveyproImport.js. This is what makes it fit to run unattended:
 *   - COUNCILS. Each council has its own read-only login on SurveyPro (it can read that council's survey_share views and nothing else), so the
 *     importer reads each in turn. Configured by SURVEYPRO_READERS (JSON {"VUNGU": "postgresql://..."}) or SURVEYPRO_READERS_FILE (a path to the same,
 *     git-ignored), or, for a single council, SURVEYPRO_DATABASE_URL as before. A council whose SurveyPro cannot be reached fails ALONE; the others
 *     are still read.
 *   - ONE AT A TIME. A Postgres advisory lock, so two servers, a timer and a person, or a timer that overlaps itself, never import together.
 *     A run that finds it held is skipped, not queued.
 *   - A TRAIL. integration.surveypro_import_run: when, who started it, whether it applied, a status (ok, attention, failed) and what happened.
 *     "attention" means the register refused a layout or a boundary diverged, so a person has to look; the importer never retries what it refused.
 *   - NO SECRETS in the record, the report or the console: councils are named by their code or the key they were configured under, never by URL.
 * docs/SURVEYPRO-INTEGRATION.md, "Running it on a schedule".
 */
const fs = require('node:fs')
const { Pool } = require('pg')
const { runImport } = require('./surveyproImport')

const LOCK_KEY = 'vungu.surveypro-import'   // hashed by Postgres to the advisory-lock number
const QUIET_KEEP_DAYS = 7
const KEEP_DAYS = 365

/** The councils to read, as [{ name, url }]; never throws for a missing configuration (returns an empty list). */
function loadReaders(env = process.env) {
  const out = []
  let raw = env.SURVEYPRO_READERS
  if (!raw && env.SURVEYPRO_READERS_FILE && fs.existsSync(env.SURVEYPRO_READERS_FILE)) raw = fs.readFileSync(env.SURVEYPRO_READERS_FILE, 'utf8')
  if (raw) {
    let map
    try { map = JSON.parse(raw) } catch { throw new Error('SURVEYPRO_READERS is not valid JSON ({"CODE": "postgresql://..."})') }
    for (const [name, url] of Object.entries(map)) if (typeof url === 'string' && url) out.push({ name, url })
  }
  if (env.SURVEYPRO_DATABASE_URL && !out.some((r) => r.url === env.SURVEYPRO_DATABASE_URL)) out.push({ name: 'default', url: env.SURVEYPRO_DATABASE_URL })
  return out
}

/** The interval the server runs the import at, in minutes; 0 means "do not schedule" (the default). */
function scheduleMinutes(env = process.env) {
  const n = Number(env.SURVEYPRO_IMPORT_MINUTES)
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 24 * 60) : 0
}

const zero = () => ({ statuses: 0, imported: 0, unchanged: 0, diverged: 0, errors: 0, warnings: 0 })
const add = (a, b) => { for (const k of Object.keys(a)) a[k] += Number(b?.[k] || 0) }

/** What a council's report says happened, trimmed to what a person reads: the projects where something did. No URLs, no geometry. */
function slim(name, report) {
  const projects = []
  for (const r of report.projects || []) {
    if (r.failed) { projects.push({ project: r.project, name: r.name, failed: r.failed }); continue }
    const p = r.parcels
    const quiet = !r.status?.to && !r.status?.error && !p.imported.length && !p.diverged.length && !p.errors.length && !p.warnings.length
    if (quiet) continue
    projects.push({
      project: r.project, name: r.name, authority: r.authority, status: r.status,
      imported: p.imported.map((x) => ({ stand: x.stand, parcel_id: x.parcel_id })),
      diverged: p.diverged.map((x) => ({ stand: x.stand, parcel_id: x.parcel_id })),
      errors: p.errors.map(({ code, stand, parcel, parcel_id }) => ({ code, stand, parcel, parcel_id })),
      warnings: p.warnings.map(({ code, stand, parcel }) => ({ code, stand, parcel })),
    })
  }
  return { council: name, read: report.read, totals: report.totals, projects }
}

async function prune(pg) {
  await pg.query(`DELETE FROM integration.surveypro_import_run WHERE (status = 'ok' AND totals = '{}'::jsonb AND started_at < now() - ($1 || ' days')::interval) OR started_at < now() - ($2 || ' days')::interval`,
    [String(QUIET_KEEP_DAYS), String(KEEP_DAYS)])
}

/**
 * One run over every configured council.
 *   pg        VunGIS's system pool
 *   readers   [{ name, url }] (default: loadReaders())
 *   apply     false = read and report only (the importer's own dry run); nothing is changed and no run is recorded as applied
 *   trigger   'schedule' | 'manual' | 'cli'
 *   schema    the schema holding SurveyPro's share views (default survey_share)
 * Returns { skipped: true } when another run holds the lock; otherwise { id, status, applied, totals, councils: [...], error }.
 * Never throws for a problem with a council; throws only if VunGIS's own database cannot be written.
 */
async function runScheduled(pg, { readers = loadReaders(), apply = true, trigger = 'schedule', schema = process.env.SURVEYPRO_SHARE_SCHEMA || 'survey_share' } = {}) {
  const lock = await pg.connect()          // the lock lives on this connection; closing it releases it
  try {
    const got = (await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK_KEY])).rows[0].ok
    if (!got) return { skipped: true, reason: 'another run is in progress' }
    try {
      if (!readers.length) {
        const row = (await pg.query(`INSERT INTO integration.surveypro_import_run (trigger, applied, status, finished_at, error) VALUES ($1, $2, 'failed', now(), $3) RETURNING id`,
          [trigger, !!apply, 'no council is configured (SURVEYPRO_READERS, SURVEYPRO_READERS_FILE or SURVEYPRO_DATABASE_URL)'])).rows[0]
        return { id: row.id, status: 'failed', applied: !!apply, totals: zero(), councils: [], error: 'no council is configured' }
      }
      const run = (await pg.query(`INSERT INTO integration.surveypro_import_run (trigger, applied, councils) VALUES ($1, $2, $3) RETURNING id`, [trigger, !!apply, readers.length])).rows[0]
      const totals = zero(); const councils = []; let failed = false
      for (const reader of readers) {
        const source = new Pool({ connectionString: reader.url, max: 1, connectionTimeoutMillis: 15_000 })
        try {
          const report = await runImport(pg, source, { apply, schema })
          add(totals, report.totals)
          councils.push(slim(reader.name, report))
          if (report.projects?.some((p) => p.failed)) failed = true
        } catch (err) {
          failed = true
          // the message of a connection failure can name the host; the URL itself is never in it
          councils.push({ council: reader.name, failed: String(err.message || err).replace(/postgres(ql)?:\/\/\S+/gi, '[url]').slice(0, 300) })
        } finally { await source.end().catch(() => {}) }
      }
      const status = failed ? 'failed' : (totals.errors || totals.diverged) ? 'attention' : 'ok'
      const quiet = status === 'ok' && !totals.statuses && !totals.imported && !totals.warnings
      await pg.query(`UPDATE integration.surveypro_import_run SET finished_at = now(), status = $2, totals = $3::jsonb, report = $4::jsonb WHERE id = $1`,
        [run.id, status, JSON.stringify(quiet ? {} : totals), JSON.stringify(councils)])
      await prune(pg)
      return { id: run.id, status, applied: !!apply, totals, councils }
    } finally {
      await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {})
    }
  } finally { lock.release() }
}

/** The recent runs, newest first, for the console. */
async function recentRuns(pg, limit = 20) {
  return (await pg.query(
    `SELECT id, started_at, finished_at, trigger, applied, status, councils, totals, report, error
       FROM integration.surveypro_import_run ORDER BY started_at DESC, id DESC LIMIT $1`, [Math.min(Math.max(Number(limit) || 20, 1), 200)])).rows
}

module.exports = { loadReaders, scheduleMinutes, runScheduled, recentRuns, slim, LOCK_KEY }
