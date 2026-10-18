/**
 * Import real Property File / allottee rows from CSV (replaces demo seed).
 *
 * CSV headers (case-insensitive):
 *   stand_number, owner_name, national_id?, phone?, email?, deed_number?, is_primary?
 *
 *   node scripts/import-property-owners.js path/to/owners.csv
 *   node scripts/import-property-owners.js path/to/owners.csv --dry-run
 *
 * Upserts into spatial_planning.property + parcel_owner (or property_owner if present).
 * Uses DATABASE_URL (owner). Localhost only unless ALLOW_REMOTE_IMPORT=1.
 */
require('dotenv').config()
const fs = require('node:fs')
const { Pool } = require('pg')

const file = process.argv[2]
const dry = process.argv.includes('--dry-run')
if (!file || !fs.existsSync(file)) {
  console.error('Usage: node scripts/import-property-owners.js owners.csv [--dry-run]')
  process.exit(1)
}

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL required'); process.exit(1) }
const host = new URL(url).hostname
if (!['localhost', '127.0.0.1', '::1'].includes(host) && process.env.ALLOW_REMOTE_IMPORT !== '1') {
  console.error(`Refusing import to ${host}. Set ALLOW_REMOTE_IMPORT=1 if intentional.`)
  process.exit(1)
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return []
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase())
  return lines.slice(1).map((line) => {
    const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    const row = {}
    headers.forEach((h, i) => { row[h] = cols[i] || '' })
    return row
  })
}

async function main() {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'))
  console.log(`[import] ${rows.length} rows from ${file}${dry ? ' (dry-run)' : ''}`)
  if (!rows.length) process.exit(0)

  const pool = new Pool({ connectionString: url })
  let ok = 0
  let skip = 0
  try {
    for (const r of rows) {
      const stand = (r.stand_number || r.stand || '').trim()
      const name = (r.owner_name || r.name || r.allottee_name || '').trim()
      if (!stand || !name) { skip++; continue }
      if (dry) { console.log(`  would upsert ${stand} → ${name}`); ok++; continue }

      await pool.query('BEGIN')
      try {
        let propId
        const existing = await pool.query(
          `SELECT id FROM spatial_planning.property WHERE UPPER(stand_number) = UPPER($1) LIMIT 1`,
          [stand],
        )
        if (existing.rows[0]) {
          propId = existing.rows[0].id
        } else {
          const ins = await pool.query(
            `INSERT INTO spatial_planning.property (stand_number) VALUES ($1) RETURNING id`,
            [stand],
          )
          propId = ins.rows[0].id
        }

        // Prefer parcel_owner; fall back to property_owner naming.
        const ownerTable = (await pool.query(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'spatial_planning'
              AND table_name IN ('parcel_owner','property_owner')
            ORDER BY table_name LIMIT 1`,
        )).rows[0]?.table_name

        if (ownerTable) {
          await pool.query(
            `INSERT INTO spatial_planning.${ownerTable}
               (property_id, name, national_id, phone, email, deed_number, is_primary)
             VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,true))
             ON CONFLICT DO NOTHING`,
            [
              propId, name,
              r.national_id || null, r.phone || null, r.email || null,
              r.deed_number || null,
              r.is_primary === 'false' || r.is_primary === '0' ? false : true,
            ],
          ).catch(async () => {
            // Schema variants — minimal insert
            await pool.query(
              `INSERT INTO spatial_planning.${ownerTable} (property_id, name)
               VALUES ($1,$2)`,
              [propId, name],
            )
          })
        }

        await pool.query('COMMIT')
        ok++
      } catch (e) {
        await pool.query('ROLLBACK')
        console.error(`  FAIL ${stand}: ${e.message.split('\n')[0]}`)
        skip++
      }
    }
  } finally {
    await pool.end()
  }
  console.log(`[import] done: ${ok} ok, ${skip} skipped`)
}

main().catch((e) => { console.error(e); process.exit(1) })
