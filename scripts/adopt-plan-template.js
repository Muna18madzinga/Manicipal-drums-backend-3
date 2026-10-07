#!/usr/bin/env node
/**
 * Give an authority its own plan, as a copy of a template.
 *
 *   node scripts/adopt-plan-template.js --authority CHIPINGE \
 *        --title "Chipinge RDC district master plan" --plan-type district_master
 *
 * The plan is a complete COPY of the template's zone types, land uses and decisions,
 * with provenance (derived_from_id) on every copied row. Edit the copy afterwards; the
 * template is never changed, and later edits to the template do not reach the copy.
 * GET /api/plans/<id>/diff shows how the copy differs from its template.
 *
 *   --template   id or part of the title of the template
 *   --profile    rural | urban: that profile's default template (default: rural)
 *   --plan-type  district_master | local | layout | scheme   (default: local)
 *   --status     unknown | draft | public_notice | approved | gazetted   (default: draft)
 *   --rollback   run it and undo it, to check it would succeed
 */
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

const KNOWN = new Set(['--authority', '--title', '--template', '--profile', '--plan-type', '--status', '--rollback'])
const USAGE = 'Usage: --authority <CODE> --title <text> [--template <id|title> | --profile rural|urban] [--plan-type district_master|local|layout|scheme] [--status draft] [--rollback]'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1] }

async function main() {
  const unknown = process.argv.slice(2).filter((a) => a.startsWith('--') && !KNOWN.has(a))
  if (unknown.length) { console.error(`Unknown option(s): ${unknown.join(' ')}\n${USAGE}`); process.exit(2) }
  const authorityCode = arg('authority') && arg('authority').toUpperCase()
  const title = arg('title')
  if (!authorityCode || !title) { console.error(USAGE); process.exit(2) }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const client = await pool.connect()
  try {
    const { rows: auth } = await client.query('SELECT id, authority_name, kind FROM local_authorities WHERE code = $1', [authorityCode])
    if (!auth.length) throw new Error(`No authority with code ${authorityCode}. Add it with scripts/add-authority.js.`)

    const t = arg('template')
    const { rows: tmpl } = t && UUID.test(t)
      ? await client.query('SELECT id, title FROM plan_instrument WHERE id = $1 AND is_template', [t])
      : await client.query(
        `SELECT i.id, i.title FROM plan_instrument i JOIN plan_profile p ON p.id = i.profile_id
          WHERE i.is_template AND ${t ? 'i.title ILIKE $1' : 'i.is_default_template AND p.code = $1'}
          ORDER BY i.created_at`, t ? [`%${t}%`] : [arg('profile') || 'rural'])
    if (tmpl.length !== 1) throw new Error(tmpl.length ? `"${t}" matches ${tmpl.length} templates; use an id` : 'No such template')

    await client.query('BEGIN')
    const { rows: [{ id }] } = await client.query('SELECT adopt_plan_template($1, $2, $3, $4, $5) AS id',
      [tmpl[0].id, auth[0].id, title, arg('plan-type') || 'local', arg('status') || 'draft'])
    const { rows: [s] } = await client.query('SELECT zone_types, land_uses, decisions FROM plan_instrument_summary WHERE id = $1', [id])
    const msg = `${auth[0].authority_name} adopted "${tmpl[0].title}" as "${title}": ${s.zone_types} zone types, ${s.land_uses} land uses, ${s.decisions} decisions copied (plan ${id}).`
    if (process.argv.includes('--rollback')) {
      await client.query('ROLLBACK')
      console.log(`Would have: ${msg}\nRolled back; nothing was kept.`)
      return
    }
    await client.query('COMMIT')
    console.log(msg)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw new Error(err.message + (/duplicate key/.test(err.message) ? ' (this authority already has a plan with that title and version)' : ''))
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
