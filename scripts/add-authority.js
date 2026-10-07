#!/usr/bin/env node
/**
 * Add a local authority (rural, urban) or a combination authority.
 *
 *   node scripts/add-authority.js --code CHIPINGE --name "Chipinge Rural District Council" \
 *        --kind rural --type "Rural District Council" --province Manicaland
 *
 *   node scripts/add-authority.js --code GWERU-VUNGU --name "Gweru-Vungu combination authority" \
 *        --kind combination --members GWERU,VUNGU
 *
 * A combination authority is created where two authorities' areas overlap; it needs at
 * least two members, who must already exist and must not themselves be combinations.
 * Refuses a code or name that already exists. Everything runs in one transaction.
 * Add --rollback to run it and undo it (to check it would succeed).
 */
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

const KNOWN = new Set(['--code', '--name', '--kind', '--type', '--province', '--members', '--rollback'])
const USAGE = 'Usage: --code <CODE> --name <name> --kind rural|urban|combination [--type <text>] [--province <text>] [--members CODE,CODE] [--rollback]'

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1] }

async function main() {
  const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && !KNOWN.has(a))
  if (unknown.length) { console.error(`Unknown option(s): ${unknown.join(' ')}\n${USAGE}`); process.exit(2) }
  const code = arg('code') && arg('code').toUpperCase()
  const name = arg('name')
  const kind = arg('kind')
  const members = (arg('members') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  if (!code || !name || !['rural', 'urban', 'combination'].includes(kind)) { console.error(USAGE); process.exit(2) }
  if (!/^[A-Z0-9-]{2,30}$/.test(code)) { console.error('code must be 2-30 letters, digits or hyphens'); process.exit(2) }
  if (kind === 'combination' && members.length < 2) { console.error('A combination authority needs at least two members (--members CODE,CODE)'); process.exit(2) }
  if (kind !== 'combination' && members.length) { console.error('--members is only for a combination authority'); process.exit(2) }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: [a] } = await client.query(
      `INSERT INTO local_authorities (authority_name, code, kind, authority_type, province)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, code, authority_name, kind`,
      [name, code, kind, arg('type'), arg('province')])
    for (const m of members) {
      const { rows } = await client.query('SELECT id FROM local_authorities WHERE code = $1', [m])
      if (!rows.length) throw new Error(`member authority ${m} does not exist`)
      await client.query('INSERT INTO authority_member (combination_id, member_id) VALUES ($1, $2)', [a.id, rows[0].id])
    }
    if (process.argv.includes('--rollback')) {
      await client.query('ROLLBACK')
      console.log(`Would add ${a.kind} authority ${a.code} "${a.authority_name}"${members.length ? ` with members ${members.join(', ')}` : ''}. Rolled back; nothing was kept.`)
      return
    }
    await client.query('COMMIT')
    console.log(`Added ${a.kind} authority ${a.code} "${a.authority_name}" (id ${a.id})${members.length ? ` with members ${members.join(', ')}` : ''}.`)
  } catch (err) {
    await client.query('ROLLBACK')
    const dup = /duplicate key/.test(err.message) ? ' (an authority with that code or name already exists)' : ''
    throw new Error(err.message + dup)
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
