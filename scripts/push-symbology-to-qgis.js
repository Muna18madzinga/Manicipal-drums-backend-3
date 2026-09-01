#!/usr/bin/env node
/**
 * Push all published registry styles into vungu-project.qgs + canonical-qml/.
 * Run after gis:symbology:seed so QGIS Desktop and QGIS Server render the
 * same cartography the web map uses.
 *
 *   node scripts/push-symbology-to-qgis.js
 *   node scripts/push-symbology-to-qgis.js --dry-run
 */
require('dotenv').config()

const { Client } = require('pg')
const { pushAllToQgis } = require('../src/services/gis/qgisPublish')

const dryRun = process.argv.includes('--dry-run')

;(async () => {
  const db = new Client(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.PGHOST || 'localhost',
          user: process.env.PGUSER || 'postgres',
          database: process.env.PGDATABASE || 'vungu_master_db_v1',
          port: process.env.PGPORT || 5432,
        },
  )
  await db.connect()
  const pool = {
    query: (...a) => db.query(...a),
    connect: async () => ({ query: (...a) => db.query(...a), release: () => {} }),
  }

  console.log(`\nPushing published symbology to QGIS project${dryRun ? ' (dry run)' : ''}…\n`)
  const result = await pushAllToQgis(pool, { dryRun, actor: 'push-symbology-to-qgis', actorRole: 'admin' })
  console.log(JSON.stringify(result, null, 2))
  console.log(
    `\n${result.pushedToProject} written to .qgs, ${result.qmlOnly} QML sidecars, ${result.failed} failed\n`,
  )
  await db.end()
  process.exit(result.failed ? 1 : 0)
})().catch((e) => {
  console.error('push failed:', e.message)
  process.exit(1)
})
