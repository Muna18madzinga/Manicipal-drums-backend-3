// Cross-system check: the non-owner runtime login (SurveyPro migration 104). Connects AS the login the runner made and proves what it can and cannot do:
// no rights of its own on the tenant tables, no bypass of row-level security, no ownership, no DDL; and that every other scenario, run on this same
// login, is the proof it can still do everything the server needs.
// Run through scripts/cross-system/run.js; see docs/SURVEYPRO-INTEGRATION.md.
const { spawnSync } = require('child_process')
const WT = process.env.SURVEYPRO_BACKEND
const r = spawnSync('node', ['scripts/verify-runtime-login.js'], {
  cwd: WT, encoding: 'utf8',
  env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, APP_DATABASE_URL: process.env.XS_APP_URL, DATABASE_URL: process.env.XS_SCRATCH_URL },
})
process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '')
process.exit(r.status === 0 ? 0 : 1)
