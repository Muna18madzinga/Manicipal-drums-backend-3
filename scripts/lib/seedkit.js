/**
 * Shared helpers for the seed-*-demo scripts.
 *
 * No application table carries a demo marker of its own, and adding one to
 * each would reshape the domain schema for a testing concern. So a seed
 * records what it created in a side ledger, and --undo removes exactly those
 * rows. Demo data stays distinguishable from the council's real records
 * without the schema knowing demo data exists.
 */

/**
 * The name of `table`'s single-column primary key.
 *
 * Not every table keys on `id` — `public.site_content` keys on `slug`, and
 * assuming otherwise made --undo fail with "column id does not exist" and
 * roll back the whole removal. Discovered from the catalog rather than
 * listed here, so the next table with its own key needs no change.
 *
 * Falls back to 'id' for a composite or absent primary key, which is the
 * right guess for the tables a seed touches.
 */
const pkCache = new Map()
async function primaryKeyColumn (db, table) {
  if (pkCache.has(table)) return pkCache.get(table)
  const [sch, tbl] = table.includes('.') ? table.split('.') : ['public', table]
  const { rows } = await db.query(
    `SELECT a.attname
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
      WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2`, [sch, tbl])
  const col = rows.length === 1 ? rows[0].attname : 'id'
  pkCache.set(table, col)
  return col
}

/**
 * Record that a seed script created `id` in `table`.
 *
 * The id is stored as text so integer, uuid and text keys all work without
 * the caller caring which a table uses.
 */
async function remember (db, tag, table, id) {
  await db.query(
    `INSERT INTO public.seed_demo_ledger (tag, table_name, row_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [tag, table, String(id)],
  )
}

/**
 * Delete everything `tag` created, then the ledger rows themselves.
 *
 * Newest first: the ledger's insertion order is the dependency order, so
 * reversing it deletes children before the parents they reference. Deleting
 * a parent first would trip a foreign key and abort the transaction.
 */
async function forget (db, tag) {
  const { rows } = await db.query(
    `SELECT table_name, row_id FROM public.seed_demo_ledger
      WHERE tag = $1 ORDER BY id DESC`, [tag])
  let n = 0
  for (const r of rows) {
    const key = await primaryKeyColumn(db, r.table_name)
    const res = await db.query(
      `DELETE FROM ${r.table_name} WHERE "${key}"::text = $1`, [r.row_id])
    n += res.rowCount
  }
  await db.query('DELETE FROM public.seed_demo_ledger WHERE tag = $1', [tag])
  return n
}

/**
 * Insert `row` into `table` and remember it, or return the existing row's id
 * when `whereSql` already matches. This is what makes a seed re-runnable:
 * the second run finds the row and still wires up everything that depends
 * on it, rather than either duplicating it or skipping the dependants.
 */
async function ensure (db, tag, table, row, whereSql, whereParams) {
  const key = await primaryKeyColumn(db, table)
  const found = await db.query(
    `SELECT "${key}" AS k FROM ${table} WHERE ${whereSql} LIMIT 1`, whereParams)
  if (found.rows.length) return found.rows[0].k

  const cols = Object.keys(row)
  const ph = cols.map((_, i) => `$${i + 1}`)
  const { rows } = await db.query(
    `INSERT INTO ${table} (${cols.map(c => `"${c}"`).join(', ')})
     VALUES (${ph.join(', ')}) RETURNING "${key}" AS k`,
    cols.map(c => row[c]),
  )
  await remember(db, tag, table, rows[0].k)
  return rows[0].k
}

/** Clears the primary-key cache. For tests; a seed run is one process. */
function _resetPkCache () { pkCache.clear() }

module.exports = { remember, forget, ensure, primaryKeyColumn, _resetPkCache }
