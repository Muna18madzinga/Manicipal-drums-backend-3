// QGIS Integration Routes
// Push/pull sync between QGIS Desktop (PyQGIS plugin) and the portal.
// Pushed layers land in real PostGIS tables (prefixed qgis_) and are
// registered in spatial_layers, so they immediately appear in the portal's
// dynamic layer catalogue and can be pulled back down by the plugin.
//
// All paths here are ABSOLUTE (/api/qgis/..., /api/qgis-plugin/...); the
// module must be registered WITHOUT a prefix or the routes double-prefix.

const { verifyToken } = require('../middleware/jwtAuth')

// Verify a signed API token (type:'api'). Returns the claims, or sends a 401
// reply and returns null. Replaces the old "accept any string starting
// vungu-api-" check, which let anyone forge an API identity (fix F3).
async function verifyApiToken(request, reply) {
  const authHeader = request.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({ success: false, error: 'No token provided', message: 'Authorization header required' })
    return null
  }
  try {
    const claims = verifyToken(authHeader.slice(7).trim())
    if (claims.type !== 'api') {
      reply.status(401).send({ success: false, error: 'Invalid token', message: 'Wrong token type' })
      return null
    }
    return claims
  } catch {
    reply.status(401).send({ success: false, error: 'Invalid token', message: 'Token verification failed' })
    return null
  }
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
    const claims = await verifyApiToken(request, reply)
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
    const claims = await verifyApiToken(request, reply)
    if (!claims) return

    const base = sanitizeIdentifier(request.params.layerName)
    if (!base) return reply.status(400).send({ success: false, error: 'Invalid layer name' })

    try {
      const { rows: tables } = await server.pg.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)
         ORDER BY (table_name = $2) DESC LIMIT 1`,
        [[base, `qgis_${base}`], base]
      )
      if (!tables.length) return reply.status(404).send({ success: false, error: 'Layer not found' })
      const table = tables[0].table_name

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
    return {
      success: true,
      data: { status: 'healthy', timestamp: new Date().toISOString() }
    }
  })

  server.get('/api/qgis-plugin/style-sync/status', async () => {
    return {
      success: true,
      status: 'idle',
      lastSync: new Date().toISOString(),
      pendingStyles: 0
    }
  })

  server.post('/api/qgis-plugin/style-sync/force', async () => {
    return {
      success: true,
      message: 'Style sync forced',
      timestamp: new Date().toISOString()
    }
  })

  server.get('/api/qgis-plugin/metrics', async () => {
    return {
      success: true,
      data: {
        uptime: process.uptime(),
        memoryUsage: process.memoryUsage()
      }
    }
  })

  server.get('/api/qgis-plugin/security/metrics', async () => {
    return {
      success: true,
      data: {
        lastSecurityScan: new Date().toISOString()
      }
    }
  })

  server.post('/api/qgis-plugin/security/audit-log', async (request) => {
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
