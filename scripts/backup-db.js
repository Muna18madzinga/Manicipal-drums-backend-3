/**
 * Local/manual backup: database (pg_dump custom format) + uploads/ archive.
 *
 *   npm run backup
 *   BACKUP_KEEP=30 node scripts/backup-db.js
 *
 * Primary production backup is Render Postgres' automatic snapshots
 * (docs/OPERATIONS_RUNBOOK.md §3); this script is the manual/secondary path —
 * run it before risky migrations or bulk data operations, and on a schedule
 * (Task Scheduler / cron / Render cron job) for the uploads/ directory, which
 * Render snapshots do NOT cover.
 *
 * Outputs (retention: newest BACKUP_KEEP of each, default 14):
 *   backups/db-YYYYMMDD-HHMMSS.dump      restore: pg_restore -d "$URL" file.dump
 *   backups/uploads-YYYYMMDD-HHMMSS.zip  citizen documents + inspection photos
 *
 * Requires pg_dump on PATH (ships with PostgreSQL).
 */
require('dotenv').config()
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const BACKUP_DIR = path.join(ROOT, 'backups')
const UPLOADS_DIR = path.join(ROOT, 'uploads')
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 14)

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function prune(prefix) {
  const old = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith(prefix))
    .sort()            // timestamped names sort chronologically
    .slice(0, -KEEP)   // everything except the newest KEEP
  for (const f of old) {
    fs.unlinkSync(path.join(BACKUP_DIR, f))
    console.log(`[backup] pruned ${f}`)
  }
}

// pg_dump from PATH, else the newest standard Windows install (PG is often
// installed as a service without its bin/ on PATH).
function findPgDump() {
  if (spawnSync('pg_dump', ['--version']).status === 0) return 'pg_dump'
  const base = 'C:\\Program Files\\PostgreSQL'
  if (process.platform === 'win32' && fs.existsSync(base)) {
    const versions = fs.readdirSync(base).sort((a, b) => Number(b) - Number(a))
    for (const v of versions) {
      const exe = path.join(base, v, 'bin', 'pg_dump.exe')
      if (fs.existsSync(exe)) return exe
    }
  }
  return null
}

async function dumpDatabase(ts) {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set (check .env)')
  const pgDump = findPgDump()
  if (!pgDump) {
    throw new Error('pg_dump not found on PATH — install PostgreSQL client tools or add its bin/ to PATH')
  }
  const out = path.join(BACKUP_DIR, `db-${ts}.dump`)
  const res = spawnSync(pgDump, [url, '-Fc', '-f', out], { stdio: 'inherit' })
  if (res.status !== 0) throw new Error(`pg_dump exited with ${res.status}`)
  console.log(`[backup] database → ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`)
  prune('db-')
}

async function zipUploads(ts) {
  if (!fs.existsSync(UPLOADS_DIR) || fs.readdirSync(UPLOADS_DIR).length === 0) {
    console.log('[backup] uploads/ empty or missing — skipped')
    return
  }
  const archiver = require('archiver')
  const out = path.join(BACKUP_DIR, `uploads-${ts}.zip`)
  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(out)
    const zip = archiver('zip', { zlib: { level: 6 } })
    stream.on('close', resolve)
    zip.on('error', reject)
    zip.pipe(stream)
    zip.directory(UPLOADS_DIR, 'uploads')
    zip.finalize()
  })
  console.log(`[backup] uploads  → ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`)
  prune('uploads-')
}

async function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const ts = stamp()
  await dumpDatabase(ts)
  await zipUploads(ts)
  console.log('[backup] done — copy the newest files off-host (runbook §3)')
}

main().catch((err) => {
  console.error('[backup] failed:', err.message)
  process.exit(1)
})
