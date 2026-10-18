/**
 * Restore a custom-format dump created by scripts/backup-db.js.
 *
 *   node scripts/restore-db.js backups/db-YYYYMMDD-HHMMSS.dump
 *   CONFIRM_RESTORE=1 node scripts/restore-db.js backups/db-….dump
 *
 * Requires DATABASE_URL (owner). Refuses non-localhost unless ALLOW_REMOTE_RESTORE=1.
 * Drops and recreates the target database name from DATABASE_URL — destructive.
 */
require('dotenv').config()
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const dump = process.argv[2]
if (!dump || !fs.existsSync(dump)) {
  console.error('Usage: CONFIRM_RESTORE=1 node scripts/restore-db.js <path-to.dump>')
  process.exit(1)
}
if (process.env.CONFIRM_RESTORE !== '1') {
  console.error('Refusing: set CONFIRM_RESTORE=1 to restore (destructive).')
  process.exit(1)
}
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL required')
  process.exit(1)
}
const u = new URL(url)
const host = u.hostname
if (!['localhost', '127.0.0.1', '::1'].includes(host) && process.env.ALLOW_REMOTE_RESTORE !== '1') {
  console.error(`Refusing restore to non-local host ${host}. Set ALLOW_REMOTE_RESTORE=1 if intentional.`)
  process.exit(1)
}

function findBin(name) {
  if (spawnSync(name, ['--version']).status === 0) return name
  const scoop = path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'postgresql', 'current', 'bin', `${name}.exe`)
  if (fs.existsSync(scoop)) return scoop
  const base = 'C:\\Program Files\\PostgreSQL'
  if (process.platform === 'win32' && fs.existsSync(base)) {
    for (const v of fs.readdirSync(base).sort((a, b) => Number(b) - Number(a))) {
      const exe = path.join(base, v, 'bin', `${name}.exe`)
      if (fs.existsSync(exe)) return exe
    }
  }
  return null
}

const db = u.pathname.replace(/^\//, '')
const adminUrl = new URL(url)
adminUrl.pathname = '/postgres'
const env = { ...process.env, PGPASSWORD: decodeURIComponent(u.password || '') }

console.log(`[restore] terminating connections to ${db}…`)
const psql = findBin('psql')
const pgRestore = findBin('pg_restore')
if (!psql || !pgRestore) {
  console.error('psql/pg_restore not found')
  process.exit(1)
}

spawnSync(psql, [adminUrl.toString(), '-v', 'ON_ERROR_STOP=1', '-c',
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid();`],
{ stdio: 'inherit', env })

console.log(`[restore] DROP DATABASE ${db}`)
spawnSync(psql, [adminUrl.toString(), '-v', 'ON_ERROR_STOP=1', '-c', `DROP DATABASE IF EXISTS "${db}";`],
  { stdio: 'inherit', env })
spawnSync(psql, [adminUrl.toString(), '-v', 'ON_ERROR_STOP=1', '-c', `CREATE DATABASE "${db}";`],
  { stdio: 'inherit', env })

console.log(`[restore] pg_restore ← ${dump}`)
const res = spawnSync(pgRestore, ['-d', url, '--no-owner', '--no-acl', dump], { stdio: 'inherit', env })
console.log(res.status === 0 ? '[restore] done' : `[restore] pg_restore exit ${res.status}`)
process.exit(res.status === 0 ? 0 : 1)
