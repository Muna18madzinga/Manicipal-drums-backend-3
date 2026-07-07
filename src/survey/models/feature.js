import db from '../config/db.js'

// Utility to compute bbox from a GeoJSON geometry
function computeBBox(geometry) {
  if (!geometry) return null
  const coords = []
  function extract(c) {
    if (typeof c[0] === 'number') {
      coords.push(c)
    } else {
      for (const inner of c) extract(inner)
    }
  }
  switch (geometry.type) {
    case 'Point':
      return [geometry.coordinates[0], geometry.coordinates[1], geometry.coordinates[0], geometry.coordinates[1]]
    case 'LineString':
    case 'MultiPoint':
    case 'Polygon':
    case 'MultiLineString':
    case 'MultiPolygon':
      extract(geometry.coordinates)
      break
    default:
      return null
  }
  if (!coords.length) return null
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
  for (const [x,y] of coords) {
    if (x < minx) minx = x
    if (y < miny) miny = y
    if (x > maxx) maxx = x
    if (y > maxy) maxy = y
  }
  return [minx, miny, maxx, maxy]
}

export default {
  async listPaged(layerId, { page = 1, limit = 50, search = '' } = {}) {
    const offset = (page - 1) * limit
    const where = ['layer_id = $1']
    const params = [layerId]
    let p = 2
    if (search && String(search).trim()) {
      where.push(`(
        (properties->>'name') ILIKE $${p} OR
        (properties->>'beacon') ILIKE $${p} OR
        (properties->>'label') ILIKE $${p} OR
        (properties->>'code') ILIKE $${p} OR
        CAST(id AS TEXT) ILIKE $${p}
      )`)
      params.push(`%${String(search).trim()}%`)
      p++
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const countSql = `SELECT COUNT(*) AS n FROM features ${whereSql}`
    const countRes = await db.query(countSql, params)
    const total = Number(countRes.rows[0]?.n || 0)
    const listSql = `SELECT * FROM features ${whereSql} ORDER BY created_at DESC LIMIT $${p} OFFSET $${p+1}`
    const listRes = await db.query(listSql, [...params, limit, offset])
    return { items: listRes.rows, total }
  },

  buildFeatureCollection(rows) {
    return {
      type: 'FeatureCollection',
      features: rows.map(r => ({
        type: 'Feature',
        id: r.id,
        geometry: r.geometry,
        properties: r.properties || {}
      }))
    }
  },
  async findById(id) {
    const result = await db.query(
      'SELECT * FROM features WHERE id = $1',
      [id]
    )
    return result.rows[0]
  },

  async findByLayer(layerId) {
    const result = await db.query(
      'SELECT * FROM features WHERE layer_id = $1 ORDER BY created_at DESC',
      [layerId]
    )
    return result.rows
  },

  async queryByBBox(layerId, bbox) {
    if (!Array.isArray(bbox) || bbox.length !== 4) {
      throw new Error('bbox must be array [minx,miny,maxx,maxy]')
    }
    const [minx,miny,maxx,maxy] = bbox

    const result = await db.query(
      'SELECT * FROM features WHERE layer_id = $1 AND bbox IS NOT NULL',
      [layerId]
    )

    // Filter in memory - to be replaced with PostGIS spatial index
    return result.rows.filter(f => {
      if (!f.bbox) return false
      const [fx1,fy1,fx2,fy2] = f.bbox
      return !(fx1 > maxx || fx2 < minx || fy1 > maxy || fy2 < miny)
    })
  },

  async searchByName(layerId, q, { limit = 20 } = {}) {
    const term = `%${q}%`
    // Search points by common label keys and id text
    const result = await db.query(
      `SELECT * FROM features 
       WHERE layer_id = $1 
         AND (geometry->>'type') = 'Point'
         AND (
           (properties->>'name') ILIKE $2 OR
           (properties->>'beacon') ILIKE $2 OR
           (properties->>'label') ILIKE $2 OR
           (properties->>'code') ILIKE $2 OR
           CAST(id AS TEXT) ILIKE $2
         )
       ORDER BY created_at DESC
       LIMIT $3`,
      [layerId, term, limit]
    )
    return result.rows
  },

  async create({ layerId, projectId, geometry = null, properties = {} }) {
    const bbox = computeBBox(geometry)
    const name = properties?.name || null
    const result = await db.query(
      'INSERT INTO features (layer_id, project_id, geometry, properties, bbox, name) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [layerId, projectId, geometry, properties, bbox, name]
    )
    return result.rows[0]
  },

  async update(id, { geometry, properties }) {
    const bbox = computeBBox(geometry)
    const name = properties?.name || null
    const result = await db.query(
      'UPDATE features SET geometry = $1, properties = $2, bbox = $3, name = $4, updated_at = NOW() WHERE id = $5 RETURNING *',
      [geometry, properties, bbox, name, id]
    )
    return result.rows[0]
  },

  async delete(id) {
    await db.query('DELETE FROM features WHERE id = $1', [id])
  },

  async findByLayerAndName(layerId, name) {
    const result = await db.query(
      'SELECT * FROM features WHERE layer_id = $1 AND name = $2 LIMIT 1',
      [layerId, name]
    )
    return result.rows[0]
  },

  async deleteByLayerAndNames(layerId, names) {
    if (!Array.isArray(names) || names.length === 0) return 0
    const placeholders = names.map((_, i) => `$${i + 2}`).join(',')
    const result = await db.query(
      `DELETE FROM features WHERE layer_id = $1 AND name IN (${placeholders})`,
      [layerId, ...names]
    )
    return result.rowCount
  }
}