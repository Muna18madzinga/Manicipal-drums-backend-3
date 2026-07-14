import Project from '../models/project.js'
import Layer from '../models/layer.js'
import Feature from '../models/feature.js'
import db from '../config/db.js'
import { parse } from 'csv-parse/sync'

export default async function importRoutes(app) {
  // Note: @fastify/multipart is now registered globally in server.js
  // No need to register it again here

  app.post('/spatial/import/csv', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const parts = request.parts()
    const fields = {}
    let fileBuf = null
    for await (const p of parts) {
      if (p.type === 'file' && p.fieldname === 'file') {
        const chunks = []
        for await (const chunk of p.file) chunks.push(chunk)
        fileBuf = Buffer.concat(chunks)
      } else if (p.type === 'field') {
        fields[p.fieldname] = p.value
      }
    }

    if (!fileBuf) return reply.code(400).send({ ok: false, error: 'No file provided' })

  const { project_id, project_name, layer_id, layer_name, geometry_type, srid, central_meridian, zone } = fields
    let proj = null
    let layer = null

    if (layer_id) {
      layer = await Layer.findById(Number(layer_id))
      if (!layer) return reply.code(404).send({ ok: false, error: 'Layer not found' })
      proj = await Project.findById(layer.project_id)
      // If central_meridian provided and layer has no SRID, set it now using EPSG mapping
      const cm = fields['central_meridian'] ? String(fields['central_meridian']) : null
      if (cm && (!layer.srid || Number(layer.srid) === 0)) {
        const cmKey = cm.toUpperCase()
        const epsgMap = { LO25: 22285, LO27: 22287, LO29: 22289, LO31: 22291, LO33: 22293 }
        const sr = epsgMap[cmKey]
        if (sr) {
          try {
            const nextParams = { ...(layer.params || {}), central_meridian: cm }
            layer = await Layer.update(layer.id, { 
              name: layer.name,
              layerType: layer.layer_type,
              geomType: layer.geom_type,
              srid: sr,
              params: nextParams
            })
          } catch {}
        }
      }
    } else {
      if (project_id) {
        proj = await Project.findById(Number(project_id))
        if (!proj) return reply.code(404).send({ ok: false, error: 'Project not found' })
      } else {
        const name = project_name || 'Imported Project'
        // Find existing by name for this user, else create
        const existing = await db.query('SELECT * FROM projects WHERE user_id=$1 AND name=$2', [request.user.sub, name])
        // Don't set a constant code; projects.code is UNIQUE. Leave null to avoid 23505 conflicts.
        if (existing.rows[0]) {
          proj = existing.rows[0]
        } else {
          try {
            proj = await Project.create({ name, userId: request.user.sub, description: 'CSV import' })
          } catch (err) {
            // If another request created the same project simultaneously, reselect it
            if (err && (err.code === '23505' || /unique/i.test(String(err)))) {
              const again = await db.query('SELECT * FROM projects WHERE user_id=$1 AND name=$2', [request.user.sub, name])
              proj = again.rows[0]
            } else {
              throw err
            }
          }
        }
      }
      const gtype = (geometry_type || 'Point').trim()
      const lname = layer_name || `Imported ${gtype}s`
      const existingL = await db.query('SELECT * FROM layers WHERE project_id=$1 AND name=$2', [proj.id, lname])
      const layerType = gtype.toLowerCase() === 'point' ? 'points' : (gtype.toLowerCase() === 'linestring' ? 'lines' : 'polygons')

      // Build projection params from central meridian or zone
      const cm = central_meridian ? String(central_meridian) : null
      const zn = zone ? String(zone) : null
      const params = {}
      if (cm) params.central_meridian = cm
      if (zn) params.zone = zn
      let sr = srid ? Number(srid) : 0
      if (!sr && cm) {
        // Map common Zimbabwe Lo to an EPSG, user can override with explicit SRID
        const cmKey = cm.toUpperCase()
        const epsgMap = { LO25: 22285, LO27: 22287, LO29: 22289, LO31: 22291, LO33: 22293 }
        if (epsgMap[cmKey]) sr = epsgMap[cmKey]
      }
      if (existingL.rows[0]) {
        layer = existingL.rows[0]
      } else {
        try {
          layer = await Layer.create({ name: lname, projectId: proj.id, layerType, geomType: gtype, srid: sr, params })
        } catch (err) {
          if (err && (err.code === '23505' || /unique/i.test(String(err)))) {
            const again = await db.query('SELECT * FROM layers WHERE project_id=$1 AND name=$2', [proj.id, lname])
            layer = again.rows[0]
          } else {
            throw err
          }
        }
      }
    }

    // Parse CSV
    let records = []
    try {
      const text = fileBuf.toString('utf8')
      records = parse(text, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true, trim: true })
    } catch (err) {
      return reply.code(400).send({ ok: false, error: 'CSV parse failed', detail: err?.message })
    }

    // Map columns: accommodate F/P vs F_P; support WKT or coordinate lists for lines/polygons
    let inserted = 0, skipped = 0
    for (const r of records) {
      const gtype = (layer.geom_type || 'Point')
      const name = r['Point'] || r['POINT'] || r['Name'] || r['name'] || r['id'] || null
      const FP = r['Status'] ?? r['status'] ?? r['F/P'] ?? r['F_P'] ?? r['fp'] ?? null
      const DESC = r['Description'] ?? r['DESCRIPTION'] ?? r['description'] ?? null
      let geometry = null

      if (gtype === 'Point') {
        const Y = r['Y'] || r['y']
        const X = r['X'] || r['x']
        const y = Number(String(Y).replace(',', '.'))
        const x = Number(String(X).replace(',', '.'))
        if (!name || !Number.isFinite(y) || !Number.isFinite(x)) { skipped++; continue }
        geometry = { type: 'Point', coordinates: [y, x] }
      } else if (gtype === 'LineString') {
        // Accept either WKT in WKT column, or a COORDS column like "y1 x1; y2 x2; ..."
        const WKT = r['WKT'] || r['wkt']
        const COORDS = r['COORDS'] || r['coords']
        let coords = []
        if (WKT && /^LINESTRING/i.test(WKT)) {
          const inner = WKT.replace(/^LINESTRING\s*\(/i, '').replace(/\)\s*$/, '')
          coords = inner.split(',').map(p => p.trim().split(/\s+/).map(n => Number(n)))
        } else if (COORDS) {
          coords = String(COORDS).split(';').map(pair => pair.trim().split(/\s+/).map(n => Number(n)))
        } else {
          skipped++; continue
        }
        // Expect pairs as [y, x]
        if (coords.length < 2 || coords.some(c => c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1]))) { skipped++; continue }
        geometry = { type: 'LineString', coordinates: coords.map(c => [c[0], c[1]]) }
      } else if (gtype === 'Polygon') {
        const WKT = r['WKT'] || r['wkt']
        const RING = r['RING'] || r['ring'] // same pattern as COORDS but closed
        let ring = []
        if (WKT && /^POLYGON/i.test(WKT)) {
          const inner = WKT.replace(/^POLYGON\s*\(\(/i, '').replace(/\)\)\s*$/, '')
          ring = inner.split(',').map(p => p.trim().split(/\s+/).map(n => Number(n)))
        } else if (RING) {
          ring = String(RING).split(';').map(pair => pair.trim().split(/\s+/).map(n => Number(n)))
        } else {
          skipped++; continue
        }
        if (ring.length < 3 || ring.some(c => c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1]))) { skipped++; continue }
        // Ensure closed
        const first = ring[0], last = ring[ring.length - 1]
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]])
        geometry = { type: 'Polygon', coordinates: [ ring.map(c => [c[0], c[1]]) ] }
      } else {
        skipped++; continue
      }

      // Upsert-by-name within the layer when name exists
      if (name) {
        const existing = await db.query('SELECT id FROM features WHERE layer_id=$1 AND properties->>\'name\'=$2', [layer.id, String(name)])
        if (existing.rows[0]) { skipped++; continue }
      }
      try {
        const props = { ...(name ? { name: String(name) } : {}), f_p: FP || null, description: DESC || null, system: 'ZIM_P(Y,X)' }
        const created = await Feature.create({ layerId: layer.id, projectId: proj.id, geometry, properties: props })
        // Optional PostGIS geom if available and SRID provided or layer.srid set
        const sr = srid ? Number(srid) : (layer.srid || 0)
        if (sr && geometry?.type && Array.isArray(geometry.coordinates)) {
          const geomWkt = geometry.type === 'Point'
            ? `POINT(${geometry.coordinates[0]} ${geometry.coordinates[1]})`
            : (geometry.type === 'LineString'
              ? `LINESTRING(${geometry.coordinates.map(c => `${c[0]} ${c[1]}`).join(',')})`
              : (geometry.type === 'Polygon' ? `POLYGON((${geometry.coordinates[0].map(c => `${c[0]} ${c[1]}`).join(',')}))` : null))
          if (geomWkt) {
            try {
              await db.query('UPDATE features SET geom = ST_SetSRID(ST_GeomFromText($1), $2) WHERE id=$3', [geomWkt, sr, created.id])
            } catch {}
          }
        }
        inserted++
      } catch (err) {
        skipped++
      }
    }

    return { ok: true, project: proj, layer, inserted, skipped }
  })
}
