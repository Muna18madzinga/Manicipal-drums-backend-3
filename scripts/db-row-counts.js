/**
 * Print `schema.table<TAB>count` for every ordinary table in the application
 * schemas, sorted. Used to prove a rebuild preserved every row: take a
 * snapshot of the old database, another of the new, and diff them.
 *
 * Reads pg_class rather than information_schema, because information_schema
 * is unreadable while pg_depend is damaged — which is the situation this
 * script exists to get us out of.
 *
 * A table that cannot be read prints ERROR:<sqlstate> rather than aborting,
 * so one corrupt relation still yields a complete report.
 *
 *     node scripts/db-row-counts.js "postgresql://..."
 *     node scripts/db-row-counts.js            # uses DATABASE_URL
 */
try { require('dotenv').config({ quiet: true }) } catch (_) { /* dotenv optional */ }
const { Client } = require('pg')

const SCHEMAS = ['public', 'spatial_planning', 'survey']

async function main() {
  const url = process.argv[2] || process.env.DATABASE_URL
  if (!url) throw new Error('Pass a connection string or set DATABASE_URL.')

  const c = new Client({ connectionString: url })
  await c.connect()
  try {
    const { rows } = await c.query(
      `SELECT n.nspname || '.' || c.relname AS tbl
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = ANY($1)
        ORDER BY 1`,
      [SCHEMAS],
    )
    for (const r of rows) {
      let n
      try {
        n = (await c.query(`SELECT count(*)::int AS n FROM ${r.tbl}`)).rows[0].n
      } catch (e) {
        n = `ERROR:${e.code}`
      }
      console.log(`${r.tbl}\t${n}`)
    }
  } finally {
    await c.end()
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })
