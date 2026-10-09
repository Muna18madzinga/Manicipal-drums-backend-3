#!/usr/bin/env node
/**
 * Is every spatial table in the database classified in the concept registry (migration 162)?
 *
 *   node scripts/verify-spatial-registry.js
 *
 * Reads only. For each relation with a registered geometry column it checks there is a row in spatial_concept_source, so a
 * new table cannot appear without someone saying which concept it serves and whether it is canonical. It also reports:
 *   - registered relations that no longer exist (information only: a fresh database does not have the imported tables);
 *   - concepts with no canonical source that are not marked missing;
 *   - concepts with more than one canonical source (the "one canonical table per concept" rule).
 * Exit code 0 only if nothing is unclassified and no concept has two canonical sources.
 *
 * Per-person survey schemas (surveyor_*) are not classified one by one: they are flagged as a finding in the audit.
 */
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })
const { Pool } = require('pg')

let failures = 0
const note = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failures++ }

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const q = async (s, a) => (await pool.query(s, a)).rows
  try {
    const geo = await q(`SELECT DISTINCT f_table_schema AS s, f_table_name AS t FROM geometry_columns
                          WHERE f_table_schema NOT IN ('pg_catalog', 'information_schema', 'topology', 'tiger', 'tiger_data')
                            AND f_table_schema NOT LIKE 'surveyor\\_%' ESCAPE '\\'
                          ORDER BY 1, 2`)
    const registered = new Map((await q('SELECT relation, concept_code, role FROM spatial_concept_source')).map((r) => [r.relation, r]))
    console.log(`== ${geo.length} spatial relations in the database, ${registered.size} in the registry`)

    const missing = geo.map((r) => `${r.s}.${r.t}`).filter((rel) => !registered.has(rel))
    note(missing.length === 0, missing.length ? `unclassified: ${missing.join(', ')}` : 'every spatial relation is classified')

    const present = new Set(geo.map((r) => `${r.s}.${r.t}`))
    const stale = [...registered.keys()].filter((rel) => !present.has(rel))
    if (stale.length) console.log(`  info  registered but not present (expected on a fresh database): ${stale.join(', ')}`)

    const twice = await q(`SELECT concept_code, array_agg(relation ORDER BY relation) AS rels FROM spatial_concept_source
                            WHERE role = 'canonical' GROUP BY 1 HAVING count(*) > 1`)
    note(twice.length === 0, twice.length ? `more than one canonical source: ${twice.map((r) => `${r.concept_code} (${r.rels.join(', ')})`).join('; ')}` : 'no concept has two canonical sources')

    const none = await q(`SELECT c.code FROM spatial_concept c
                           WHERE c.status <> 'missing' AND NOT EXISTS (SELECT 1 FROM spatial_concept_source s WHERE s.concept_code = c.code AND s.role IN ('canonical', 'target'))
                             AND c.code NOT IN ('case_location', 'managed_feature')`)
    note(none.length === 0, none.length ? `concepts with data but no canonical or target source: ${none.map((r) => r.code).join(', ')}` : 'every concept with data names a canonical or target source')

    const live = await q(`SELECT c.code FROM spatial_concept c WHERE c.status = 'missing' AND EXISTS (SELECT 1 FROM spatial_concept_source s WHERE s.concept_code = c.code)`)
    note(live.length === 0, live.length ? `concepts marked missing that have sources: ${live.map((r) => r.code).join(', ')}` : 'no concept marked missing has a source')

    const shadow = await q(`SELECT relation FROM spatial_concept_source WHERE role IN ('legacy', 'duplicate') ORDER BY relation`)
    console.log(`  info  ${shadow.length} relation(s) are marked legacy or duplicate and are to be retired: ${shadow.map((r) => r.relation).join(', ')}`)
  } finally {
    await pool.end()
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nALL CHECKS PASSED')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => { console.error(err.message); process.exit(1) })
