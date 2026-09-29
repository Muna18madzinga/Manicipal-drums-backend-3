// scripts/db-compact.js
// ─────────────────────────────────────────────────────────────────────────
// Reclaim dead space: VACUUM (FULL, ANALYZE) every table, largest first,
// and print the database size before and after.
//
// Why: the OSM clip (scripts/clip-osm-to-vungu.js) DELETEs the national rows
// but a plain VACUUM never gives the file space back — buildings held 27 MB
// of live rows in a 64 MB file. Migration 131 also drops columns, whose
// space is only reclaimed by a rewrite.
//
// VACUUM FULL takes an ACCESS EXCLUSIVE lock per table while it rewrites it
// and needs free disk equal to that table's size. Run it with the backend
// stopped: a table another session is reading is skipped after a 15 s lock
// wait (reported as "busy") instead of stalling the whole run.
// Refuses non-localhost databases unless --allow-remote is passed.
//
//   node scripts/db-compact.js              # DATABASE_URL from .env
//   node scripts/db-compact.js --dry-run    # list what would be compacted
// ─────────────────────────────────────────────────────────────────────────

require('dotenv').config()
const { Client } = require('pg')

const SCHEMAS = ['public', 'spatial_planning', 'planning_clerk', 'council_ops', 'survey', 'ref']

async function main() {
  const args = new Set(process.argv.slice(2))
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const host = new URL(url).hostname
  if (!['localhost', '127.0.0.1', '::1'].includes(host) && !args.has('--allow-remote')) {
    throw new Error(`Refusing to compact remote database "${host}" (pass --allow-remote to override).`)
  }

  const db = new Client({ connectionString: url })
  await db.connect()
  try {
    const size = async () => (await db.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS s')).rows[0].s
    const { rows: tables } = await db.query(`
      SELECT format('%I.%I', n.nspname, c.relname) AS name, pg_total_relation_size(c.oid) AS bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname = ANY($1)
       ORDER BY bytes DESC`, [SCHEMAS])

    const before = await size()
    console.log(`database size before: ${before} (${tables.length} tables)`)
    if (args.has('--dry-run')) {
      tables.slice(0, 15).forEach(t => console.log(`  ${t.name}  ${(t.bytes / 1048576).toFixed(1)} MB`))
      return
    }
    await db.query("SET lock_timeout = '15s'")
    const busy = []
    for (const t of tables) {
      const t0 = Date.now()
      try {
        await db.query(`VACUUM (FULL, ANALYZE) ${t.name}`)
      } catch (err) {
        if (err.code !== '55P03') throw err          // lock_not_available
        busy.push(t.name)
        continue
      }
      if (t.bytes > 1048576) console.log(`  compacted ${t.name} in ${Date.now() - t0} ms`)
    }
    if (busy.length) console.log(`  skipped (busy — stop the backend and re-run): ${busy.join(', ')}`)
    console.log(`database size after:  ${await size()}`)
  } finally {
    await db.end()
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })
