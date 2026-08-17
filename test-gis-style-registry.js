#!/usr/bin/env node
/**
 * Smoke test for the enterprise GIS symbology registry (migration 114).
 *
 * These are not nice-to-have assertions -- each one corresponds to an
 * architectural non-negotiable. If any fails, symbology drift is possible
 * again and the guarantee is void.
 *
 * Run: node test-gis-style-registry.js
 */
require('dotenv').config()
const { Client } = require('pg')

const LAYER = '__test_registry_layer__'
let pass = 0
let fail = 0

function ok(name) { console.log(`  PASS  ${name}`); pass++ }
function bad(name, detail) { console.log(`  FAIL  ${name}\n        ${detail}`); fail++ }

/** Asserts the query is refused by the database. */
async function mustReject(c, name, sql, params) {
  try {
    await c.query(sql, params)
    bad(name, 'expected the database to reject this, but it succeeded')
  } catch (e) {
    ok(`${name} -- rejected: ${e.message.split('\n')[0].slice(0, 88)}`)
  }
}

async function mustAccept(c, name, sql, params) {
  try {
    const r = await c.query(sql, params)
    ok(name)
    return r
  } catch (e) {
    bad(name, e.message)
    return null
  }
}

const doc = (colour) => JSON.stringify({
  schema: 'vungu.gis.style/1',
  layerId: LAYER,
  geometry: 'polygon',
  renderer: { type: 'single', symbol: { kind: 'fill', fill: colour, fillOpacity: 1 } },
})

function insertStyle(c, version, status, opts = {}) {
  const { fidelity = 'direct', colour = '#f1dd7c' } = opts
  const published = status === 'published'
  return c.query(
    `INSERT INTO gis_style
       (layer_id, style_name, style_version, status, source, source_path,
        definition, renderer_type, opacity, fidelity, checksum,
        created_by, approved_by, approved_at, published_by, published_at)
     VALUES ($1,$2,$3,$4::gis_style_status,'qgis','test.qgs',
             $5::jsonb,'single',1.0,$6,$7,'test.author','test.approver',now(),
             CASE WHEN $8 THEN 'test.publisher' ELSE NULL END,
             CASE WHEN $8 THEN now() ELSE NULL END)`,
    [LAYER, `${LAYER} v${version}`, version, status, doc(colour),
     fidelity, `sha256:test${version}`, published],
  )
}

async function purge(c) {
  await c.query('ALTER TABLE gis_style DISABLE TRIGGER gis_style_no_delete_published')
  await c.query('ALTER TABLE gis_style_audit DISABLE TRIGGER gis_style_audit_immutable')
  await c.query('DELETE FROM gis_style WHERE layer_id = $1', [LAYER])
  await c.query('DELETE FROM gis_style_audit WHERE layer_id = $1', [LAYER])
  await c.query('ALTER TABLE gis_style_audit ENABLE TRIGGER gis_style_audit_immutable')
  await c.query('ALTER TABLE gis_style ENABLE TRIGGER gis_style_no_delete_published')
  await c.query('DELETE FROM gis_layer WHERE layer_id = $1', [LAYER])
}

;(async () => {
  const c = new Client(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.PGHOST || 'localhost',
          user: process.env.PGUSER,
          password: process.env.PGPASSWORD,
          database: process.env.PGDATABASE,
          port: process.env.PGPORT || 5432,
        },
  )
  await c.connect()
  const db = (await c.query('select current_database() d')).rows[0].d
  console.log(`\nGIS style registry guarantees -- ${db}\n`)

  await purge(c)
  await c.query(
    `INSERT INTO gis_layer (layer_id, display_name, geometry, data_source)
     VALUES ($1, 'Registry test layer', 'polygon', 'nonexistent_test_table')`,
    [LAYER],
  )

  console.log('1. Lifecycle')
  await mustAccept(c, 'v1 can be published with recorded approval',
    'SELECT 1 WHERE true')
  await insertStyle(c, 1, 'published')
  ok('v1 published')

  console.log('\n2. One published style per layer (the core guarantee)')
  await mustReject(
    c, 'a second published version for the same layer',
    `INSERT INTO gis_style (layer_id, style_name, style_version, status, source,
       definition, renderer_type, opacity, fidelity, checksum, approved_by, published_at)
     VALUES ($1,'dupe',2,'published','qgis',$2::jsonb,'single',1.0,'direct','sha256:x','a',now())`,
    [LAYER, doc('#ff0000')],
  )

  console.log('\n3. Published styles are immutable')
  await mustReject(
    c, 'changing the definition of a published style',
    'UPDATE gis_style SET definition = $2::jsonb WHERE layer_id = $1 AND style_version = 1',
    [LAYER, doc('#00ff00')],
  )
  await mustReject(
    c, 'changing the checksum of a published style',
    "UPDATE gis_style SET checksum = 'sha256:tampered' WHERE layer_id = $1 AND style_version = 1",
    [LAYER],
  )
  await mustReject(
    c, 'reverting a published style to draft',
    "UPDATE gis_style SET status = 'draft' WHERE layer_id = $1 AND style_version = 1",
    [LAYER],
  )
  await mustReject(
    c, 'deleting a published style',
    'DELETE FROM gis_style WHERE layer_id = $1 AND style_version = 1',
    [LAYER],
  )

  console.log('\n4. Publication requires recorded approval')
  await mustReject(
    c, 'publishing without approved_by',
    `INSERT INTO gis_style (layer_id, style_name, style_version, status, source,
       definition, renderer_type, opacity, fidelity, checksum, published_at)
     VALUES ($1,'unapproved',7,'published','qgis',$2::jsonb,'single',1.0,'direct','sha256:u',now())`,
    [LAYER, doc('#123456')],
  )

  console.log('\n5. Unsupported symbology cannot reach production')
  await mustReject(
    c, 'publishing a style whose fidelity is `unsupported`',
    `INSERT INTO gis_style (layer_id, style_name, style_version, status, source,
       definition, renderer_type, opacity, fidelity, checksum, approved_by, published_at)
     VALUES ($1,'geomgen',8,'published','qgis',$2::jsonb,'single',1.0,'unsupported','sha256:g','a',now())`,
    [LAYER, doc('#654321')],
  )
  await mustAccept(
    c, 'the same style may exist as a draft, so it stays visible and fixable',
    `INSERT INTO gis_style (layer_id, style_name, style_version, status, source,
       definition, renderer_type, opacity, fidelity, checksum)
     VALUES ($1,'geomgen',8,'draft','qgis',$2::jsonb,'single',1.0,'unsupported','sha256:g')`,
    [LAYER, doc('#654321')],
  )

  console.log('\n6. Rollback: deprecate the live version, publish another')
  await mustAccept(
    c, 'deprecating the live version (roll forward) is allowed',
    "UPDATE gis_style SET status = 'deprecated' WHERE layer_id = $1 AND style_version = 1",
    [LAYER],
  )
  await insertStyle(c, 2, 'approved')
  await mustAccept(
    c, 'v2 can then be published',
    `UPDATE gis_style SET status='published', published_by='test', published_at=now()
     WHERE layer_id=$1 AND style_version=2`,
    [LAYER],
  )
  const active = await c.query(
    'SELECT style_version FROM gis_published_style WHERE layer_id = $1', [LAYER],
  )
  active.rows[0]?.style_version === 2
    ? ok('gis_published_style resolves to exactly one version (v2)')
    : bad('gis_published_style resolves to v2', `got ${JSON.stringify(active.rows)}`)

  console.log('\n7. Audit trail is append-only')
  await c.query(
    `INSERT INTO gis_style_audit (layer_id, event, to_version, actor)
     VALUES ($1, 'published', 2, 'test.publisher')`, [LAYER],
  )
  await mustReject(
    c, 'editing an audit row',
    "UPDATE gis_style_audit SET actor = 'someone.else' WHERE layer_id = $1", [LAYER],
  )
  await mustReject(
    c, 'deleting an audit row',
    'DELETE FROM gis_style_audit WHERE layer_id = $1', [LAYER],
  )

  console.log('\n8. Data / style separation')
  const cols = await c.query(
    `SELECT count(*)::int n FROM information_schema.columns
      WHERE table_name IN ('gis_layer','gis_style','gis_style_audit')
        AND (udt_name = 'geometry' OR column_name = 'geom')`,
  )
  cols.rows[0].n === 0
    ? ok('registry holds no geometry -- PostGIS remains the sole data authority')
    : bad('registry holds no geometry', `${cols.rows[0].n} geometry column(s) found`)

  await purge(c)
  await c.end()

  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('\nharness error:', e.message); process.exit(1) })
