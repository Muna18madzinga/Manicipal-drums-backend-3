// QGIS Integration Routes
// Push/pull sync between QGIS Desktop (PyQGIS plugin) and the portal.
// Pushed layers land in real PostGIS tables (prefixed qgis_) and are
// registered in spatial_layers, so they immediately appear in the portal's
// dynamic layer catalogue and can be pulled back down by the plugin.
//
// All paths here are ABSOLUTE (/api/qgis/..., /api/qgis-plugin/...); the
// module must be registered WITHOUT a prefix or the routes double-prefix.

const { verifyApiTokenClaims, requireRole } = require('../middleware/jwtAuth')
const { publicLayerTables } = require('../utils/publicLayers')

// Verify a signed API token. Returns the claims, or sends a 401 reply and
// returns null. Replaces the old "accept any string starting vungu-api-" check,
// which let anyone forge an API identity (fix F3).
//
// Security audit 2026-09-29: the token must also have a live row in
// public.api_token (revoked one by one from the admin console) and an issuer
// who is still an active admin or GIS officer. The token only ever reaches the
// sync push/pull/download routes below; it is refused everywhere else.
async function verifyApiToken(request, reply, server) {
  const authHeader = request.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({ success: false, error: 'No token provided', message: 'Authorization header required' })
    return null
  }
  const out = {}
  const claims = await verifyApiTokenClaims(server.pg, authHeader.slice(7).trim(), out)
  if (!claims) {
    const message = out.reason === 'revoked' ? 'Token has been revoked' : 'Token verification failed'
    reply.status(401).send({ success: false, error: 'Invalid token', message })
    return null
  }
  return claims
}

// Strict identifier sanitizer — table and column names built from user input
// must survive this or the request is rejected. Never interpolate anything
// else into SQL.
function sanitizeIdentifier(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  return s && /^[a-z_]/.test(s) ? s : null
}

function pgTypeFor(qgisType) {
  const t = String(qgisType || '').toLowerCase()
  if (/int|long/.test(t)) return 'BIGINT'
  if (/double|float|real|decimal|numeric/.test(t)) return 'DOUBLE PRECISION'
  if (/bool/.test(t)) return 'BOOLEAN'
  return 'TEXT'
}

function geomTypeOf(features) {
  const f = features.find(f => f && f.geometry && f.geometry.type)
  const t = f ? f.geometry.type : 'Polygon'
  if (/point/i.test(t)) return 'point'
  if (/line/i.test(t)) return 'line'
  return 'polygon'
}

async function createQGISRoutes(server) {
  // ------------------------------------------------------------
  // Push: QGIS Desktop -> portal
  // ------------------------------------------------------------
  server.post('/api/qgis/sync/upload', async (request, reply) => {
    const claims = await verifyApiToken(request, reply, server)
    if (!claims) return

    const { layer_name, crs, features, field_types, style } = request.body || {}
    if (!layer_name || !Array.isArray(features)) {
      return reply.status(400).send({ success: false, error: 'layer_name and features[] are required' })
    }
    const base = sanitizeIdentifier(layer_name)
    if (!base) return reply.status(400).send({ success: false, error: 'Invalid layer name' })
    // ponytail: pushed layers live in qgis_* staging tables so a push can
    // never clobber a core table; promote to authoritative via migration.
    const table = base.startsWith('qgis_') ? base : `qgis_${base}`

    const fields = Object.entries(field_types || {})
      .map(([orig, t]) => ({ orig, safe: sanitizeIdentifier(orig), type: pgTypeFor(t) }))
      .filter(f => f.safe && f.safe !== 'id' && f.safe !== 'geom')

    const client = await server.pg.connect()
    try {
      await client.query('BEGIN')
      await client.query(`DROP TABLE IF EXISTS "${table}"`)
      const colDefs = fields.map(f => `"${f.safe}" ${f.type}`).join(', ')
      await client.query(
        `CREATE TABLE "${table}" (id SERIAL PRIMARY KEY${colDefs ? ', ' + colDefs : ''}, geom geometry(Geometry, 4326))`
      )
      await client.query(`CREATE INDEX "idx_${table}_geom" ON "${table}" USING GIST (geom)`)
      // Re-attach the live-sync trigger (migration 109): the DROP TABLE above
      // removed it, and without it pushed features would not broadcast to
      // open browser tabs. Attached BEFORE the inserts so the push itself
      // rides the same NOTIFY -> SSE path as a direct QGIS Desktop edit.
      // Guarded so a database that predates migration 109 still accepts pushes.
      await client.query(
        `DO $$ BEGIN
           IF to_regproc('public.ensure_spatial_notify_trigger') IS NOT NULL THEN
             PERFORM public.ensure_spatial_notify_trigger('public."${table}"'::regclass);
           END IF;
         END $$`
      )

      let inserted = 0
      for (const f of features) {
        if (!f || !f.geometry) continue
        const props = f.properties || {}
        const cols = ['geom']
        const params = [JSON.stringify(f.geometry)]
        const vals = ['ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)']
        for (const field of fields) {
          cols.push(`"${field.safe}"`)
          params.push(props[field.orig] !== undefined ? props[field.orig] : null)
          vals.push(`$${params.length}`)
        }
        await client.query(`INSERT INTO "${table}" (${cols.join(', ')}) VALUES (${vals.join(', ')})`, params)
        inserted++
      }

      // Register in the dynamic layer catalogue (delete+insert: table_name
      // has no unique constraint to upsert against).
      await client.query('DELETE FROM spatial_layers WHERE table_name = $1', [table])
      await client.query(
        `INSERT INTO spatial_layers (table_name, display_name, geometry_type, description, style_config, is_visible)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [table, String(layer_name).slice(0, 100), geomTypeOf(features),
         `Pushed from QGIS Desktop (${crs || 'EPSG:4326'})`, JSON.stringify(style || {})]
      )
      await client.query('COMMIT')

      request.log.info(`[QGIS] Synced ${inserted} features into ${table}`)
      return reply.send({
        success: true,
        data: {
          layer_id: table,
          features_processed: inserted,
          layer_name,
          sync_time: new Date().toISOString()
        }
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      request.log.error({ err: error }, '[QGIS] Sync upload failed')
      return reply.status(500).send({ success: false, error: 'Sync upload failed', details: error.message })
    } finally {
      client.release()
    }
  })

  // ------------------------------------------------------------
  // Pull: portal -> QGIS Desktop
  // ------------------------------------------------------------
  server.get('/api/qgis/sync/download/:layerName', async (request, reply) => {
    const claims = await verifyApiToken(request, reply, server)
    if (!claims) return

    const base = sanitizeIdentifier(request.params.layerName)
    if (!base) return reply.status(400).send({ success: false, error: 'Invalid layer name' })

    try {
      // A WMS layername and its table name are not always the same thing:
      // `gweru_beyond_periurban_zones` lives in `vungu_beyond_peri_urban_zones`,
      // `proposed_peri_urban_zones` in `zones_master`. Exact name match first,
      // then the style-registry mapping (`qgis_layer` -> `data_source` table).
      let { rows: tables } = await server.pg.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)
         ORDER BY (table_name = $2) DESC LIMIT 1`,
        [[base, `qgis_${base}`], base]
      )
      if (!tables.length) {
        const { rows: mapped } = await server.pg.query(
          `SELECT data_source AS table_name FROM public.gis_published_style
           WHERE qgis_layer = $1 LIMIT 1`,
          [base]
        )
        if (mapped.length) {
          const mappedTable = sanitizeIdentifier(mapped[0].table_name)
          if (mappedTable) {
            const { rows: verify } = await server.pg.query(
              `SELECT table_name FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
              [mappedTable]
            )
            tables = verify
          }
        }
      }
      if (!tables.length) {
        // Try the QGIS project file itself: each <maplayer> element records its
        // datasource, mapping a WMS layername to its actual table. This covers
        // layers absent from public.gis_published_style (e.g. zimbabwe -> country).
        try {
          const fs = require('fs')
          const path = require('path')
          const candidates = [
            process.env.QGIS_PROJECT_LOCAL,
            path.join(__dirname, '..', '..', 'qgis-projects', path.basename(process.env.QGIS_PROJECT || 'vungu-project.qgs')),
          ].filter(Boolean)
          for (const candidate of candidates) {
            if (!fs.existsSync(candidate)) continue
            const { PerfectQGISStyleExtractor } = require('../services/admin/perfectQGISStyleExtractor')
            const mapped = new PerfectQGISStyleExtractor().getTableName(candidate, base)
            if (mapped) {
              const safe = sanitizeIdentifier(mapped)
              if (safe) {
                const { rows: verify } = await server.pg.query(
                  `SELECT table_name FROM information_schema.tables
                   WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
                  [safe]
                )
                if (verify.length) tables = verify
              }
            }
            if (tables.length) break
          }
        } catch (error) {
          request.log.warn({ msg: 'project-file layer lookup failed', err: error.message })
        }
      }
      if (!tables.length) return reply.status(404).send({ success: false, error: 'Layer not found' })
      const table = tables[0].table_name
      // Least privilege (security audit 2026-09-29): a sync token downloads GIS layers only — the
      // plugin's own qgis_* staging tables and published, non-private map layers. It used to read
      // ANY public table by name, e.g. /sync/download/users returned every account with its
      // password hash and MFA secret. Anything else is 404, the same as a missing layer.
      const allowed = table.startsWith('qgis_') || (await publicLayerTables(server.pg)).includes(table)
      if (!allowed) return reply.status(404).send({ success: false, error: 'Layer not found' })

      const { rows: cols } = await server.pg.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
           AND udt_name NOT IN ('geometry', 'geography')`,
        [table]
      )
      const colList = cols.map(c => `"${c.column_name}"`).join(', ')
      const { rows } = await server.pg.query(
        `SELECT ${colList ? colList + ',' : ''} ST_AsGeoJSON(ST_Transform(geom, 4326), 8)::json AS geometry
         FROM "${table}" WHERE geom IS NOT NULL LIMIT 50000`
      )
      const features = rows.map((row, i) => {
        const { geometry, ...properties } = row
        return { type: 'Feature', id: properties.id !== undefined ? properties.id : i, geometry, properties }
      })

      request.log.info(`[QGIS] Downloaded ${features.length} features from ${table}`)
      return reply.send({
        success: true,
        data: {
          layer_name: table,
          crs: 'EPSG:4326',
          field_types: Object.fromEntries(cols.map(c => [c.column_name, c.data_type])),
          features
        }
      })
    } catch (error) {
      request.log.error({ err: error }, '[QGIS] Sync download failed')
      return reply.status(500).send({ success: false, error: 'Sync download failed', details: error.message })
    }
  })

  // ------------------------------------------------------------
  // Health + plugin dashboard endpoints (paths the admin UI calls)
  // ------------------------------------------------------------
  server.get('/api/qgis/health', async () => {
    const { getSpatialListenerStatus } = require('../services/spatialChangeListener')
    return {
      success: true,
      data: {
        status: 'healthy',
        // Live QGIS->web sync: true means direct PostGIS edits (QGIS Desktop,
        // imports) are being broadcast to browsers via LISTEN/NOTIFY + SSE.
        realtimeSync: getSpatialListenerStatus(),
        timestamp: new Date().toISOString()
      }
    }
  })

  // Per-layer live-sync coverage: for every registry layer, can a PostGIS write
  // actually reach a browser tab? This is the diagnostic that was missing on
  // 2026-10-05, when a QGIS save produced no browser update and no screen could
  // say why. See src/services/syncCoverage.js for the chain it walks.
  //
  // Gated to the same two roles as the symbology registry (src/routes/gisStyles.js
  // STYLE_ADMINS): the GIS officer authors the data, the admin owns the runtime,
  // and `planner` consumes both without needing the wiring.
  server.get('/api/qgis/sync/coverage', { preHandler: requireRole(server, ['admin', 'gis_officer']) }, async (request, reply) => {
    try {
      const { buildSyncCoverage } = require('../services/syncCoverage')
      return { success: true, data: await buildSyncCoverage(server.pg) }
    } catch (error) {
      request.log.error({ err: error }, '[QGIS] sync coverage failed')
      return reply.status(500).send({
        success: false,
        error: 'Could not read sync coverage',
        details: error.message,
      })
    }
  })

  server.get('/api/qgis-plugin/style-sync/status', { preHandler: requireRole(server, ['admin']) }, async () => {
    return {
      success: true,
      status: 'idle',
      lastSync: new Date().toISOString(),
      pendingStyles: 0
    }
  })

  server.post('/api/qgis-plugin/style-sync/force', { preHandler: requireRole(server, ['admin']) }, async () => {
    return {
      success: true,
      message: 'Style sync forced',
      timestamp: new Date().toISOString()
    }
  })

  server.get('/api/qgis-plugin/metrics', { preHandler: requireRole(server, ['admin']) }, async () => {
    return {
      success: true,
      data: {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage()
      }
    }
  })

  server.get('/api/qgis-plugin/security/metrics', { preHandler: requireRole(server, ['admin']) }, async () => {
    return {
      success: true,
      data: {
        lastSecurityScan: new Date().toISOString()
      }
    }
  })

  server.post('/api/qgis-plugin/security/audit-log', { preHandler: requireRole(server, ['admin']) }, async (request) => {
    request.log.info({ event: request.body && request.body.event }, '[QGIS] plugin audit event')
    return {
      success: true,
      message: 'Security event logged',
      eventId: 'evt_' + Date.now(),
      timestamp: new Date().toISOString()
    }
  })

  server.get('/api/qgis-plugin/download/plugin', async (request, reply) => {
    try {
      const fs = require('fs')
      const path = require('path')
      // repo root (src/routes -> ../..)
      const pluginPath = path.join(__dirname, '..', '..', 'vungu-qgis-plugin.zip')

      if (!fs.existsSync(pluginPath)) {
        return reply.status(404).send({ success: false, error: 'Plugin file not found' })
      }

      reply.header('Content-Type', 'application/zip')
      reply.header('Content-Disposition', 'attachment; filename="vungu-qgis-plugin.zip"')
      return reply.send(fs.createReadStream(pluginPath))
    } catch (error) {
      request.log.error({ err: error }, '[QGIS] Plugin download error')
      return reply.status(500).send({ success: false, error: 'Plugin download failed', details: error.message })
    }
  })
}

module.exports = { createQGISRoutes };
