/**
 * Static tile / FlatGeobuf build seam for the Stream D tiered transport.
 *
 * The map currently pays PostGIS for every zoom/pan on big reference
 * layers. This service converts an exported PostGIS table into the two
 * static formats the research doc
 * (app-frontend/docs/research/2026-06-02-spatial-libraries-comparison.md)
 * calls for:  .pmtiles  (via tippecanoe)  and  .fgb  (via ogr2ogr).
 *
 * Both external tools are discovered the same conservative way
 * setup-spatial does: warn-then-fail with actionable messaging when the
 * binary or GDAL build is missing. The route layer calls this and
 * returns 501 with the reason when the seam is not available, so this
 * never silently corrupts a layer.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');

const STATIC_ROOT = process.env.STATIC_TILE_ROOT || path.join(process.cwd(), 'public', 'static');

async function commandAvailable(name, args = ['--version']) {
  try {
    await execFileAsync(name, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a .pmtiles archive for a table.
 *
 * @param {object} opts
 * @param {string} opts.table        public schema table name
 * @param {string} [opts.geometry]   geometry column (default `geom`)
 * @param {string} [opts.where]      SQL WHERE clause, e.g. "is_active = true"
 * @param {number} [opts.maxZoom]    max zoom (default 14)
 * @returns {Promise<{ok:boolean, file?:string, reason?:string}>}
 */
async function buildPmTiles({ table, geometry = 'geom', where, maxZoom = 14 }) {
  if (!(await commandAvailable('tippecanoe'))) {
    return { ok: false, reason: 'tippecanoe_not_available' };
  }
  if (!process.env.DATABASE_URL) {
    return { ok: false, reason: 'DATABASE_URL_not_set' };
  }
  fs.mkdirSync(STATIC_ROOT, { recursive: true });
  const out = path.join(STATIC_ROOT, `${table}.pmtiles`);
  const args = [
    '-zg', `--maximum-zoom=${maxZoom}`, '--force', '-o', out,
    `--layer=${table}`,
    `postgresql://${new URL(process.env.DATABASE_URL).host}/${process.env.PGDATABASE || 'vungu_master_db_v1'}`,
    '--name', table,
  ];
  try {
    await execFileAsync('tippecanoe', [
      '-zg', `--maximum-zoom=${maxZoom}`, '--force', '-o', out,
      '--layer', table,
      `${process.env.DATABASE_URL.replace(/\/$/, '')}?table=${table}${where ? `&where=${encodeURIComponent(where)}` : ''}`,
    ], { timeout: 600000 });
    return { ok: true, file: out };
  } catch (error) {
    return { ok: false, reason: 'tippecanoe_failed', error: error.message };
  }
}

/**
 * Export a table to a .fgb file.
 *
 * @param {object} opts
 * @param {string} opts.table
 * @param {string} [opts.geometry]
 * @param {string} [opts.where]
 */
async function buildFlatGeobuf({ table, geometry = 'geom', where }) {
  return { ok: false, reason: 'not_implemented — needs ogr2ogr discovery like setup-spatial; see docs/STREAM-D-DESIGN.md' };
}

/**
 * Version probe used by the frontend to cache-bust.
 * Returns the mtime (seconds since epoch) of the latest .pmtiles file for
 * the table, plus its size, or null when nothing exists yet.
 */
function staticVersion(table) {
  const file = path.join(STATIC_ROOT, `${table}.pmtiles`);
  try {
    const st = fs.statSync(file);
    return { version: Math.floor(st.mtimeMs / 1000), bytes: st.size };
  } catch {
    return null;
  }
}

module.exports = { commandAvailable, buildPmTiles, buildFlatGeobuf, staticVersion, STATIC_ROOT };
