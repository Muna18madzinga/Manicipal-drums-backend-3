#!/usr/bin/env node
/**
 * Build a .pmtiles static file for one spatial layer without tippecanoe.
 *
 * Pipeline:
 *   1. Query PostGIS for the layer's extent (EPSG:4326).
 *   2. Compute Web-Mercator z/x/y tiles in [minzoom..maxzoom].
 *   3. GET each tile as an MVT .pbf from the running tile service
 *      (TILES_BASE_URL, default http://localhost:3000, using the same layer
 *      registry that builds the live endpoint — see src/routes/tiles.js).
 *   4. Package the gzipped MVT responses into an MBTiles sqlite database
 *      (node:sqlite), then convert to .pmtiles with the Protomaps CLI.
 *
 * Usage:
 *   node scripts/build-static-pmtiles.mjs --layer districts \
 *     --minzoom 0 --maxzoom 8 [--out public/static/districts.pmtiles]
 *
 * Tools required:
 *   - the backend (same process serves /api/tiles/*.pbf)
 *   - pmtiles from https://github.com/protomaps/go-pmtiles (PATH or PMTILES_BIN)
 */
import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import * as path from 'node:path'
import * as http from 'node:http'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { Client } = require('pg')

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg) => {
    if (!arg.startsWith('--')) return acc
    const body = arg.replace(/^--/, '')
    const eq = body.indexOf('=')
    if (eq > 0) acc.push([body.slice(0, eq), body.slice(eq + 1)])
    else {
      const i = process.argv.indexOf(arg)
      const next = process.argv[i + 1]
      acc.push([body, next && !next.startsWith('--') ? next : true])
    }
    return acc
  }, []),
)
const layerId = args.layer
const minzoom = Number(args.minzoom ?? 0)
const maxzoom = Number(args.maxzoom ?? 8)
const out = args.out || path.join('public', 'static', `${layerId}.pmtiles`)
const mbtiles = out.replace(/\.pmtiles$/, '') + '.mbtiles'
const baseUrl = process.env.TILES_BASE_URL || 'http://localhost:3000'
const pmtilesBin = process.env.PMTILES_BIN || 'pmtiles'

if (!layerId) {
  console.error('usage: node scripts/build-static-pmtiles.mjs --layer <id>')
  process.exit(1)
}

async function fetchTile(z, x, y) {
  return new Promise((resolve) => {
    http
      .get(`${baseUrl}/api/tiles/${layerId}/${z}/${x}/${y}.pbf`, (res) => {
        if (res.statusCode !== 200) return resolve(null)
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks)))
      })
      .on('error', () => resolve(null))
  })
}

function tileXY(lon, lat, z) {
  const n = 2 ** z
  const latRad = (lat * Math.PI) / 180
  return [
    Math.max(0, Math.min(n - 1, Math.floor(((lon + 180) / 360) * n))),
    Math.max(0, Math.min(n - 1, Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n))),
  ]
}

async function main() {
  const layersModule = require('../src/config/spatialLayers.js')
  const layer = layersModule.getLayer(layerId)
  if (!layer) {
    console.error(`unknown layer '${layerId}'; known:`, layersModule.LAYERS.map((l) => l.id).join(', '))
    process.exit(2)
  }
  console.log(`[build] layer=${layerId} table=${layer.table} zooms=${minzoom}..${maxzoom}`)

  const pg = new Client({ connectionString: process.env.DATABASE_URL })
  await pg.connect()
  const r = await pg.query(
    `SELECT round(ST_XMin(ST_Extent(geom))::numeric,4)::float AS x0,
            round(ST_YMin(ST_Extent(geom))::numeric,4)::float AS y0,
            round(ST_XMax(ST_Extent(geom))::numeric,4)::float AS x1,
            round(ST_YMax(ST_Extent(geom))::numeric,4)::float AS y1
       FROM public.${layer.table}`,
  )
  await pg.end()
  let { x0, y0, x1, y1 } = r.rows[0]
  if (!isFinite(x0)) { console.error('[build] no extent — table empty?'); process.exit(3) }
  console.log(`[build] extent lon ${x0}..${x1}, lat ${y0}..${y1}`)

  mkdirSync(path.dirname(out), { recursive: true })
  const db = new DatabaseSync(mbtiles)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
    CREATE TABLE IF NOT EXISTS metadata (name TEXT, value TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS tile_idx ON tiles (zoom_level, tile_column, tile_row);
  `)
  const insertTile = db.prepare('INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?,?,?,?)')
  const setMeta = db.prepare('INSERT OR REPLACE INTO metadata (name, value) VALUES (?,?)')

  let added = 0
  for (let z = minzoom; z <= maxzoom; z++) {
    const [xa, ya] = tileXY(x0, y1, z)
    const [xb, yb] = tileXY(x1, y0, z)
    for (let x = Math.min(xa, xb); x <= Math.max(xa, xb); x++) {
      for (let y = Math.min(ya, yb); y <= Math.max(ya, yb); y++) {
        const buf = await fetchTile(z, x, y)
        if (buf && buf.length > 0) {
          insertTile.run(z, x, y, buf)
          added++
        }
      }
    }
    console.log(`[build] z${z} added=${added}`)
  }
  setMeta.run('name', layer.title || layerId)
  setMeta.run('format', 'pbf')
  setMeta.run('minzoom', String(minzoom))
  setMeta.run('maxzoom', String(maxzoom))
  setMeta.run('bounds', `${x0},${y0},${x1},${y1}`)
  setMeta.run('center', `${(x0 + x1) / 2},${(y0 + y1) / 2},${Math.round((minzoom + maxzoom) / 2)}`)
  setMeta.run('description', `Static PMTiles build of ${layerId} from Vungu GIS tables`)
  db.close()

  if (added === 0) { console.error('[build] no tiles fetched — aborting'); process.exit(4) }

  // Convert the tiles store to a concrete .pmtiles archive.
  const exe = existsSync(pmtilesBin) ? pmtilesBin : (process.env.PMTILES_BIN || 'pmtiles')
  execFileSync(exe, ['convert', mbtiles, out], { stdio: 'inherit' })
  console.log(`[build] wrote ${out}`)
}

main().catch((err) => { console.error(err); process.exit(5) })
