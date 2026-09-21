/**
 * Print column definitions for tables a seed script is about to write to, so
 * nobody has to guess a column name. Guessing produces a script that fails
 * halfway through a transaction.
 *
 * Columns with no default that reject nulls are marked REQUIRED — every
 * insert must supply those. Foreign keys and check constraints are listed
 * too, since both decide what a valid row looks like.
 *
 *     node scripts/db-describe.js spatial_planning.stage_inspection ...
 *     node scripts/db-describe.js --empty     # every empty table
 */
try { require('dotenv').config({ quiet: true }) } catch (_) { /* optional */ }
const { Client } = require('pg')

const SCHEMAS = ['public', 'spatial_planning', 'survey']

async function emptyTables(c) {
  const { rows } = await c.query(
    `SELECT n.nspname || '.' || c.relname AS t
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = ANY($1)
      ORDER BY 1`, [SCHEMAS])
  const out = []
  for (const r of rows) {
    try {
      if ((await c.query(`SELECT count(*)::int n FROM ${r.t}`)).rows[0].n === 0) out.push(r.t)
    } catch (_) { /* unreadable: not a seed target */ }
  }
  return out
}

async function describe(c, t) {
  const [sch, tbl] = t.split('.')
  const cols = await c.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`, [sch, tbl])
  if (!cols.rows.length) { console.log(`\n## ${t}\n  (not found)`); return }

  console.log(`\n## ${t}`)
  for (const r of cols.rows) {
    const req = r.is_nullable === 'NO' && r.column_default === null ? '  REQUIRED' : ''
    const def = r.column_default ? `  default=${String(r.column_default).slice(0, 40)}` : ''
    console.log(`  ${r.column_name.padEnd(32)} ${r.data_type}${def}${req}`)
  }

  const fks = await c.query(
    `SELECT kcu.column_name, ccu.table_schema || '.' || ccu.table_name AS ref
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = $1 AND tc.table_name = $2`, [sch, tbl])
  for (const r of fks.rows) console.log(`  FK ${r.column_name} -> ${r.ref}`)

  // Check constraints carry the allowed values for status-style columns,
  // which is usually what a seed gets wrong.
  const cks = await c.query(
    `SELECT cc.check_clause, tc.constraint_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.check_constraints cc
         ON cc.constraint_name = tc.constraint_name AND cc.constraint_schema = tc.table_schema
      WHERE tc.constraint_type = 'CHECK'
        AND tc.table_schema = $1 AND tc.table_name = $2
        AND cc.check_clause NOT LIKE '%IS NOT NULL'`, [sch, tbl])
  for (const r of cks.rows) console.log(`  CHECK ${r.check_clause.replace(/\s+/g, ' ').slice(0, 160)}`)
}

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  try {
    let tables = process.argv.slice(2).filter(a => !a.startsWith('--'))
    if (process.argv.includes('--empty')) tables = await emptyTables(c)
    for (const t of tables) await describe(c, t)
  } finally {
    await c.end()
  }
}

main().catch(e => { console.error(e.message); process.exit(1) })
