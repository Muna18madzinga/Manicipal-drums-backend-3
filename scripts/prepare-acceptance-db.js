#!/usr/bin/env node
/**
 * Build (and optionally test against) the database the acceptance suites need.
 *
 * WHY THIS EXISTS
 * ---------------
 * Six suites in src/routes/__tests__ are integration tests, not unit tests:
 *
 *   geometry-validation  gms.acceptance      gms.editing
 *   permit-workflow      soft-delete         stand-allocation
 *
 * Each documents its prerequisites in its own header -- migration 132+, the demo
 * users, and the Tsamba sample -- and each fails with 401 invalid_credentials
 * against a database that was not prepared. Without them, `npm test` reports a
 * pile of failures that look like product bugs and are not.
 *
 * So this builds a throwaway database from the migration path instead of
 * mutating a real one. That has a second payoff: a green run here also proves a
 * *freshly migrated* database can satisfy the acceptance tests, which is the
 * question a new deployment actually asks.
 *
 * It builds a scratch database, never the one in .env. That database is left in
 * place afterwards so failures can be inspected with psql; pass --fresh to
 * rebuild it from scratch.
 *
 * USAGE
 *   node scripts/prepare-acceptance-db.js            prepare, then run the suites
 *   node scripts/prepare-acceptance-db.js prepare    prepare only
 *   node scripts/prepare-acceptance-db.js test       run only (no rebuild)
 *   node scripts/prepare-acceptance-db.js prepare --fresh
 *
 * Or via npm: `npm run test:db`  /  `npm run test:db:prepare`
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..')
const SCRATCH_DB = process.env.ACCEPTANCE_DB_NAME || 'vungu_acceptance_test'

// Single source of truth, shared with jest.config.js -- see that file for what
// each suite needs and why it is not part of the plain `npm test` run.
const { integration: SUITES } = require('./test-suites')
const { configForSuites } = require('./lib/jestForSuites')

const DEMO_PASSWORD = 'demo1234'

function readEnvUrl() {
  const envFile = path.join(REPO, '.env')
  if (!fs.existsSync(envFile)) throw new Error('no .env in the repo root')
  const match = fs
    .readFileSync(envFile, 'utf8')
    .match(/^\s*DATABASE_URL\s*=\s*(.+)$/m)
  if (!match) throw new Error('DATABASE_URL is not set in .env')
  // .env allows surrounding quotes; a URL with an unquoted '#' would be a
  // comment as far as dotenv is concerned, so only strip matched quotes.
  return match[1].trim().replace(/^["']|["']$/g, '')
}

const adminUrl = readEnvUrl()
const base = new URL(adminUrl)
const user = decodeURIComponent(base.username)
const password = decodeURIComponent(base.password)
const host = base.hostname || 'localhost'
const port = Number(base.port || 5432)

/** Same server and credentials, different database. */
function urlFor(dbName) {
  const u = new URL(base.href)
  u.pathname = '/' + dbName
  return u.href
}

const TEST_URL = urlFor(SCRATCH_DB)

if (base.pathname.replace(/^\//, '') === SCRATCH_DB) {
  console.error(
    `Refusing to run: DATABASE_URL already points at ${SCRATCH_DB}.\n` +
      'Point .env at your real database, or set ACCEPTANCE_DB_NAME to something else.'
  )
  process.exit(2)
}

function run(label, args, extraEnv = {}) {
  process.stdout.write(`\n=== ${label}\n`)
  const r = spawnSync(process.execPath, args, {
    cwd: REPO,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
    shell: false,
  })
  if (r.status !== 0) throw new Error(`${label} exited ${r.status}`)
}

async function databaseExists() {
  const { Client } = require('pg')
  const c = new Client({ host, port, user, password, database: 'postgres' })
  await c.connect()
  try {
    const { rows } = await c.query('select 1 from pg_database where datname = $1', [SCRATCH_DB])
    return rows.length > 0
  } finally {
    await c.end()
  }
}

async function prepare({ fresh }) {
  if (!fresh && (await databaseExists())) {
    console.log(`=== ${SCRATCH_DB} already exists; reusing it (pass --fresh to rebuild)`)
  } else {
    console.log(`=== creating ${SCRATCH_DB}`)
    const { Client } = require('pg')
    const admin = new Client({ host, port, user, password, database: 'postgres' })
    await admin.connect()
    try {
      // A leftover connection from an interrupted run would block the DROP.
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()',
        [SCRATCH_DB]
      )
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`)
      await admin.query(`CREATE DATABASE ${SCRATCH_DB}`)
    } finally {
      await admin.end()
    }

    const db = new Client({ host, port, user, password, database: SCRATCH_DB })
    await db.connect()
    try {
      await db.query('CREATE EXTENSION IF NOT EXISTS postgis')
      await db.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
    } finally {
      await db.end()
    }
    console.log('=== postgis + uuid-ossp installed')
  }

  // dotenv does not overwrite variables already in the environment, so passing
  // DATABASE_URL through the child environment reliably redirects every one of
  // these scripts away from the database in .env.
  run('migrations', ['scripts/migrate.js'], { DATABASE_URL: TEST_URL })

  run('demo users', ['scripts/seed-demo-users.js'], {
    DATABASE_URL: TEST_URL,
    DEMO_SEED_ENABLED: 'true',
    DEMO_DEFAULT_PASSWORD: DEMO_PASSWORD,
  })

  run('tsamba sample', ['scripts/seed-tsamba.js'], { DATABASE_URL: TEST_URL })

  console.log(`\n${SCRATCH_DB} ready.`)
}

function test() {
  // Serial on purpose. These suites share one database, and the migration 107
  // topology trigger rejects overlapping stands globally -- so two suites
  // placing test stands in parallel make each other fail. Running them in band
  // costs a few seconds and removes a whole class of phantom failures.
  //
  // --config with the ignore list dropped: these paths are excluded by
  // testPathIgnorePatterns, and Jest applies that even to paths given
  // explicitly, so without the override it finds nothing and reports success.
  run(`acceptance suites (${SUITES.length})`, [
    'node_modules/jest/bin/jest.js',
    '--config',
    JSON.stringify(configForSuites(SUITES)),
    '--runInBand',
    ...SUITES,
  ], { DATABASE_URL: TEST_URL })
}

;(async () => {
  const argv = process.argv.slice(2)
  const mode = argv.find((a) => !a.startsWith('-')) || 'all'
  const fresh = argv.includes('--fresh')

  if (!['all', 'prepare', 'test'].includes(mode)) {
    console.error(`unknown mode "${mode}" (expected all, prepare or test)`)
    process.exit(2)
  }
  if (mode === 'all' || mode === 'prepare') await prepare({ fresh })
  if (mode === 'all' || mode === 'test') test()
})().catch((err) => {
  console.error(`\n${err.message}`)
  process.exit(1)
})
