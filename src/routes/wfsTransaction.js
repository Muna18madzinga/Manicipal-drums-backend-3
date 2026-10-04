/**
 * WFS Transaction (WFS-T) Routes
 * Provides transactional WFS support for editing features
 */

const { requireRole } = require('../middleware/jwtAuth')
const { publicLayerTables } = require('../utils/publicLayers')

function sanitizeIdentifier(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  return s && /^[a-z_]/.test(s) ? s : null
}

function isPrivateTable(tableName) {
  const privatePrefixes = ['users', 'audit', 'sessions', 'password', 'mfa', 'auth', 'api_keys']
  const lower = tableName.toLowerCase()
  return privatePrefixes.some(p => lower.startsWith(p)) || lower.includes('token') || lower.includes('secret')
}

async function createWFSTransactionRoutes(server) {
  // POST /api/ogc/wfs/transaction
  server.post('/api/ogc/wfs/transaction', {
    preHandler: requireRole(server, ['planner', 'gis_officer', 'admin']),
  }, async (request, reply) => {
    const { typeName, features, insert, update, delete: deleteFeatures } = request.body || {}
    
    if (!typeName) {
      return reply.status(400).send({
        success: false,
        error: 'typeName is required',
      })
    }

    const base = sanitizeIdentifier(typeName)
    if (!base) {
      return reply.status(400).send({
        success: false,
        error: 'Invalid typeName',
      })
    }

    try {
      // Resolve table name
      let { rows: tables } = await server.pg.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)
         ORDER BY (table_name = $2) DESC LIMIT 1`,
        [[base, `qgis_${base}`], base]
      )

      if (!tables.length) {
        return reply.status(404).send({
          success: false,
          error: 'Layer not found',
        })
      }

      const table = tables[0].table_name
      
      // Check permissions - only allow editing of qgis_* staging tables or authorized spatial layers
      const allowed = table.startsWith('qgis_') || (await publicLayerTables(server.pg)).includes(table)
      if (!allowed || isPrivateTable(table)) {
        return reply.status(403).send({
          success: false,
          error: 'Not authorized to edit this layer',
        })
      }

      const client = await server.pg.connect()
      let inserted = 0, updated = 0, deleted = 0

      try {
        await client.query('BEGIN')

        // Handle INSERT operations
        const inserts = insert || (features ? features.filter((f) => !f.id) : [])
        for (const feature of inserts) {
          if (!feature.geometry) continue
          
          // Get columns
          const props = feature.properties || {}
          const colNames = Object.keys(props).filter(k => !['id', 'fid', 'gid'].includes(k.toLowerCase()))
          
          if (colNames.length > 0) {
            const cols = [...colNames, 'geom']
            const placeholders = colNames.map((_, i) => `$${i + 1}`).concat([`ST_SetSRID(ST_GeomFromGeoJSON($${colNames.length + 1}), 4326)`])
            const values = [...colNames.map(c => props[c]), JSON.stringify(feature.geometry)]
            
            await client.query(
              `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders.join(', ')})`,
              values
            )
            inserted++
          } else {
            // Just geometry
            await client.query(
              `INSERT INTO "${table}" (geom) VALUES (ST_SetSRID(ST_GeomFromGeoJSON($1), 4326))`,
              [JSON.stringify(feature.geometry)]
            )
            inserted++
          }
        }

        // Handle UPDATE operations
        const updates = update || (features ? features.filter((f) => f.id) : [])
        for (const feature of updates) {
          if (!feature.id || !feature.geometry) continue
          
          const idField = 'id' // Try common ID fields
          const props = feature.properties || {}
          const setClauses = []
          const values = []
          let idx = 1
          
          for (const k of Object.keys(props)) {
            if (['id', 'fid', 'gid'].includes(k.toLowerCase())) continue
            setClauses.push(`"${k}" = $${idx++}`)
            values.push(props[k])
          }
          setClauses.push(`geom = ST_SetSRID(ST_GeomFromGeoJSON($${idx++}), 4326)`)
          values.push(JSON.stringify(feature.geometry))
          values.push(feature.id)
          
          const result = await client.query(
            `UPDATE "${table}" SET ${setClauses.join(', ')} WHERE "${idField}" = $${idx}`,
            values
          )
          updated += result.rowCount || 0
        }

        // Handle DELETE operations
        const deletes = deleteFeatures || []
        for (const del of deletes) {
          if (!del.id) continue
          const result = await client.query(
            `DELETE FROM "${table}" WHERE id = $1 OR fid = $1 OR gid = $1`,
            [del.id]
          )
          deleted += result.rowCount || 0
        }

        await client.query('COMMIT')

        return reply.send({
          success: true,
          data: {
            inserted,
            updated,
            deleted,
            total: inserted + updated + deleted,
          },
        })
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    } catch (error) {
      request.log.error({ err: error }, '[WFS-T] Transaction failed')
      return reply.status(500).send({
        success: false,
        error: 'Transaction failed',
        details: error.message,
      })
    }
  })
}

module.exports = { createWFSTransactionRoutes }
