#!/usr/bin/env node
/**
 * Make a person a platform operator (may cross authorities and add authorities), or take it away.
 *
 *   node scripts/set-platform-user.js --email someone@example.org            grant
 *   node scripts/set-platform-user.js --email someone@example.org --remove   revoke
 *   node scripts/set-platform-user.js --list                                 who has it
 *
 * Nobody is a platform operator by default. An authority's own administrator is NOT one: they are
 * confined to their authority by row-level security (migration 154). Grant this only to the people
 * who run the central service.
 */
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

const KNOWN = new Set(['--email', '--remove', '--list'])
const USAGE = 'Usage: --email <address> [--remove] | --list'
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1] }

async function main() {
  const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && !KNOWN.has(a))
  if (unknown.length) { console.error(`Unknown option(s): ${unknown.join(' ')}\n${USAGE}`); process.exit(2) }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    if (process.argv.includes('--list')) {
      const { rows } = await pool.query('SELECT email, role FROM public.users WHERE is_platform ORDER BY email')
      console.log(rows.length ? rows.map((r) => `${r.email} (${r.role})`).join('\n') : 'Nobody is a platform operator.')
      return
    }
    const email = arg('email')
    if (!email) { console.error(USAGE); process.exit(2) }
    const on = !process.argv.includes('--remove')
    const { rows } = await pool.query('UPDATE public.users SET is_platform = $2 WHERE lower(email) = lower($1) RETURNING email, role', [email, on])
    if (!rows.length) throw new Error(`No user with the email ${email}.`)
    console.log(`${rows[0].email} (${rows[0].role}) is ${on ? 'now' : 'no longer'} a platform operator.`)
  } finally {
    await pool.end()
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
