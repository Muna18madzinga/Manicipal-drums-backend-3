/**
 * seed-all-demo.js
 *
 * Run every demo seed, in dependency order.
 *
 * Users first, because every other script looks a user up by email. Then
 * the planner seed, which creates the committee meetings the golden thread
 * puts its agenda item on — run the other way round on an empty database,
 * the thread finds no meeting and silently skips the item. Then the golden
 * thread, because the per-role scripts attach to the case it creates. Order
 * among the rest does not matter.
 *
 *     node scripts/seed-all-demo.js
 *     node scripts/seed-all-demo.js --undo    # reverse order
 *
 * Each script owns its own transaction, so one failing cannot leave another
 * half-written. The runner keeps going and reports at the end rather than
 * stopping at the first failure, which would leave some portals populated
 * and some not, with no summary of which.
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const SCRIPTS = [
  'seed-demo-users.js',
  'seed-planner-demo.js',
  'seed-golden-thread.js',
  'seed-inspector-demo.js',
  'seed-inspector-register.js',
  'seed-eho-office.js',
  'seed-surveyor-demo.js',
  'seed-gis-officer-demo.js',
  'seed-admin-demo.js',
]

// seed-demo-users.js refuses to run without this, and it has no --undo:
// accounts are the one thing every other script depends on.
const USER_SEED_ENV = { ...process.env, DEMO_SEED_ENABLED: 'true' }

const undoing = process.argv.includes('--undo')
const order = undoing ? [...SCRIPTS].reverse() : SCRIPTS
const failed = []

for (const script of order) {
  if (undoing && script === 'seed-demo-users.js') continue // no --undo; keep the accounts
  process.stdout.write(`\n=== ${undoing ? 'undo' : 'seed'} ${script} ===\n`)
  try {
    execFileSync(
      process.execPath,
      [path.join(__dirname, script), ...(undoing ? ['--undo'] : [])],
      { stdio: 'inherit', env: USER_SEED_ENV },
    )
  } catch (_) {
    failed.push(script)
    process.stdout.write(`!! ${script} failed; continuing\n`)
  }
}

if (failed.length) {
  console.error(`\n${failed.length} script(s) failed: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`\n${undoing ? 'All demo data removed.' : 'All demo data seeded.'}`)
