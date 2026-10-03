#!/usr/bin/env node
/**
 * Run the suites that need a server actually listening on PORT.
 *
 * WHY THIS EXISTS
 * ---------------
 * permit-applications.citizen.test.js and surveyor.routes.test.js drive the real
 * HTTP surface with axios instead of app.inject, so an in-process Fastify
 * instance will not satisfy them. Left in `npm test` they fail with
 * ECONNREFUSED whenever no dev server happens to be running -- a failure that
 * reads like a broken feature and is only really "nobody started the server".
 *
 * So this owns the server's lifecycle for the duration of the run:
 *
 *   - If something healthy is already listening, it is reused and left alone.
 *     Starting a second one would either fail on the port or, worse, silently
 *     answer with a process this script then kills at the end.
 *   - Otherwise one is started here, waited on, and shut down afterwards.
 *
 * Shutdown is not a plain kill. server.js uses listenInCluster, so killing the
 * primary leaves a worker holding the port; the cleanup below targets every
 * node.exe whose command line is this repo's server.js, and is verified rather
 * than assumed.
 *
 * USAGE
 *   node scripts/run-live-server-tests.js            boot (if needed), run, stop
 *   node scripts/run-live-server-tests.js --keep-server   leave it running after
 *   node scripts/run-live-server-tests.js --no-boot   require a running server
 */

const path = require('node:path')
const http = require('node:http')
const { spawn, spawnSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..')
const { live: SUITES } = require('./test-suites')
const { configForSuites } = require('./lib/jestForSuites')

const PORT = Number(process.env.PORT || 3000)
const HOST = process.env.HOST || '127.0.0.1'
const HEALTH = `http://${HOST}:${PORT}/health`
const BOOT_TIMEOUT_MS = 60_000

const argv = process.argv.slice(2)
const keepServer = argv.includes('--keep-server')
const noBoot = argv.includes('--no-boot')

function health(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(HEALTH, { timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * The PID(s) holding the listening socket on PORT.
 *
 * Deliberately *not* found by matching `server.js` in the command line: a node
 * process started with a working directory (rather than a path argument) has no
 * repo path in its command line at all, so that match finds nothing while the
 * server is very much running. The port is unambiguous, and scoping by it means
 * this script can never take down an unrelated node process.
 */
function portOwners() {
  const ps = `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ` +
    `Select-Object -ExpandProperty OwningProcess -Unique`
  const out = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
  if (out.status !== 0) return []
  return (out.stdout || '')
    .split(/\r?\n/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
}

/**
 * Free the port, and confirm it stayed free.
 *
 * server.js uses listenInCluster, so killing the primary does not release the
 * port -- the primary hands the socket to a worker, which then sits on it
 * holding an orphaned server. taskkill /T on the port owner reaps the whole tree
 * in one go; the loop afterwards checks rather than assumes, because a leftover
 * worker here would break the *next* run rather than this one.
 */
async function stopServer() {
  const owners = portOwners()
  if (!owners.length) return

  console.log(`\n=== stopping server (pid ${owners.join(', ')})`)
  for (const pid of owners) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }

  for (let i = 0; i < 20; i++) {
    await sleep(500)
    if (!portOwners().length && !(await health())) return
  }

  // Escalate once: the cluster did not die politely.
  for (const pid of portOwners()) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  }
  await sleep(1000)
  if (portOwners().length || (await health())) {
    console.error('WARNING: could not free the port; a server may still be running.')
  }
}

async function boot() {
  console.log(`=== starting server on ${HOST}:${PORT}`)
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    detached: true,          // its own process group, so the tree kill is bounded
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()

  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await health()) {
      console.log(`=== healthy at ${HEALTH}`)
      return child.pid
    }
    await sleep(1000)
  }
  throw new Error(`server did not become healthy within ${BOOT_TIMEOUT_MS / 1000}s`)
}

async function main() {
  if (SUITES.length === 0) {
    console.log('No live-server suites registered.')
    return
  }

  let spawnedPid = null
  if (await health()) {
    console.log(`=== reusing the server already listening on ${HOST}:${PORT}`)
    if (keepServer) console.log('    (--keep-server given, it will be left running)')
  } else if (noBoot) {
    console.error(`Nothing healthy on ${HEALTH} and --no-boot was given.`)
    console.error('Start the backend first, or drop --no-boot.')
    process.exit(1)
  } else {
    spawnedPid = await boot()
  }

  try {
    console.log(`\n=== live suites (${SUITES.length})`)
    // --config with the ignore list dropped: these paths are excluded by
    // testPathIgnorePatterns, and Jest applies that even to arguments given
    // explicitly, so without this it reports "no tests found" and looks green.
    const r = spawnSync(
      process.execPath,
      [
        'node_modules/jest/bin/jest.js',
        '--config',
        JSON.stringify(configForSuites(SUITES)),
        ...SUITES,
      ],
      { cwd: REPO, stdio: 'inherit', env: process.env }
    )
    process.exitCode = r.status === null ? 1 : r.status
  } finally {
    // Only stop what we started. A reused server belongs to whoever launched it.
    if (spawnedPid && !keepServer) await stopServer()
    else if (spawnedPid && keepServer) {
      console.log(`\n=== leaving the server running (pid ${spawnedPid}), as asked`)
    }
  }
}

main().catch((err) => {
  console.error(`\n${err.message}`)
  process.exit(1)
})
