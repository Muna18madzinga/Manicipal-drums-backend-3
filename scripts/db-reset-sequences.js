/**
 * Advance every owned sequence to its column's current maximum.
 *
 * A `pg_restore --data-only` writes explicit id values without touching the
 * sequences behind them, so after a restore every sequence still reads 1 and
 * the next INSERT collides on the primary key. Nothing looks wrong until
 * somebody tries to create a record.
 *
 * Run this immediately after any data-only restore.
 *
 *     node scripts/db-reset-sequences.js "postgresql://..."
 *     node scripts/db-reset-sequences.js       # uses DATABASE_URL
 */
try { require('dotenv').config({ quiet: true }) } catch (_) { /* dotenv optional */ }
const { Client } = require('pg')

async function main() {
  const url = process.argv[2] || process.env.DATABASE_URL
  if (!url) throw new Error('Pass a connection string or set DATABASE_URL.')

  const c = new Client({ connectionString: url })
  await c.connect()
  try {
    // Sequences reached through pg_depend: 'a' is a serial's owned-by link,
    // 'i' an identity column's.
    const { rows } = await c.query(`
      SELECT n.nspname AS sch, t.relname AS tbl, a.attname AS col
        FROM pg_class s
        JOIN pg_depend d  ON d.objid = s.oid AND d.deptype IN ('a','i')
        JOIN pg_class t   ON t.oid = d.refobjid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
       WHERE s.relkind = 'S'
       ORDER BY 1, 2, 3`)

    let done = 0
    const failed = []
    for (const r of rows) {
      // setval to max(col), or 1 when the table is empty. is_called stays
      // true, so the next nextval() returns max+1 rather than max.
      const sql = `
        SELECT setval(
          pg_get_serial_sequence('${r.sch}.${r.tbl}', '${r.col}'),
          GREATEST(COALESCE((SELECT max("${r.col}") FROM ${r.sch}.${r.tbl}), 0), 1)
        )`
      try {
        await c.query(sql)
        done++
      } catch (e) {
        failed.push(`${r.sch}.${r.tbl}.${r.col}: ${e.message.split('\n')[0]}`)
      }
    }

    console.log(`reset ${done}/${rows.length} sequences`)
    for (const f of failed) console.error(`FAILED ${f}`)
    if (failed.length) process.exitCode = 1
  } finally {
    await c.end()
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })
