// src/routes/gms-map.js
// ─────────────────────────────────────────────────────────────────────────
// GIS Management System map workspace support.
//
//   GET /gms/tiles/:layer/:z/:x/:y.pbf   viewInternal   parcels + GMS layers as MVT
//   GET /gms/search?q=                   viewInternal   one box: parcel, stand, account,
//                                                       ward, village, feature, coordinates
//   GET /gms/crs                         viewInternal   CRS registry (for the readout)
//   GET /gms/export/dxf                  viewInternal   ?layer&township&srid — any registered CRS
//
// Tiles are here, not in the public tile registry (config/spatialLayers.js),
// because that one is anonymous and these layers are internal.
// ─────────────────────────────────────────────────────────────────────────

const { requireRole } = require('../middleware/jwtAuth')
const { GMS } = require('../services/gms/roles')
const { audit } = require('../services/gms/audit')

const tags = ['GMS map']

const canViewLayer = (user, layer) => layer.access_level !== 'restricted'
  || GMS.personalData.includes(user.role)
  || (user.department && user.department === layer.custodian_dept)

// Label shown on the map and in search: the first of these the layer has.
const LABEL_SQL = `COALESCE(attrs->>'name', attrs->>'stand_no', attrs->>'trading_name', 'Feature ' || feature_id)`

/**
 * Typed coordinates in any registered CRS:
 *   -19.45, 29.8   |  29.8 -19.45          WGS84 degrees (either order, Zimbabwe ranges)
 *   UTM35S 793990 7846986  |  36S e n      UTM
 *   Lo29 -84021.98 2151376.55              Lo belt, Y then X as surveyors write them
 */
function parseCoordinates(q) {
  const s = q.trim()
  let m = s.match(/^(?:utm\s*)?(35|36)\s*s[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)$/i)
  if (m) return { srid: 32700 + Number(m[1]), x: Number(m[2]), y: Number(m[3]), label: `UTM ${m[1]}S` }
  m = s.match(/^lo\s*(27|29|31|33)[\s,]+(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)$/i)
  if (m) return { srid: 922000 + Number(m[1]), x: Number(m[2]), y: Number(m[3]), label: `Lo${m[1]}` }
  m = s.match(/^(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    const isLat = (v) => v >= -23 && v <= -15
    const isLon = (v) => v >= 25 && v <= 34
    if (isLat(a) && isLon(b)) return { srid: 4326, x: b, y: a, label: 'WGS84' }
    if (isLon(a) && isLat(b)) return { srid: 4326, x: a, y: b, label: 'WGS84' }
  }
  return null
}

// ── Minimal DXF R12 writer (POLYLINE / POINT / TEXT): every CAD reads R12. ──
function dxfDocument(entities, comments) {
  const out = comments.map((c) => `999\n${c}`)
  out.push('0\nSECTION\n2\nENTITIES')
  for (const e of entities) out.push(e)
  out.push('0\nENDSEC\n0\nEOF')
  return out.join('\n') + '\n'
}
const n = (v) => Number(v).toFixed(3)
function dxfPolyline(layer, coords, closed) {
  const parts = [`0\nPOLYLINE\n8\n${layer}\n66\n1\n70\n${closed ? 1 : 0}`]
  const pts = closed ? coords.slice(0, -1) : coords
  for (const [x, y] of pts) parts.push(`0\nVERTEX\n8\n${layer}\n10\n${n(x)}\n20\n${n(y)}\n30\n0.0`)
  parts.push(`0\nSEQEND\n8\n${layer}`)
  return parts.join('\n')
}
const dxfPoint = (layer, [x, y]) => `0\nPOINT\n8\n${layer}\n10\n${n(x)}\n20\n${n(y)}\n30\n0.0`
const dxfText = (layer, [x, y], text, h) =>
  `0\nTEXT\n8\n${layer}\n10\n${n(x)}\n20\n${n(y)}\n30\n0.0\n40\n${h}\n1\n${String(text).replace(/[\r\n]/g, ' ')}`

/** GeoJSON geometry -> DXF entities, with an optional coordinate mapping. */
function geometryToDxf(layer, g, map) {
  const ring = (r) => r.map(map)
  switch (g.type) {
    case 'Point': return [dxfPoint(layer, map(g.coordinates))]
    case 'MultiPoint': return g.coordinates.map((c) => dxfPoint(layer, map(c)))
    case 'LineString': return [dxfPolyline(layer, ring(g.coordinates), false)]
    case 'MultiLineString': return g.coordinates.map((l) => dxfPolyline(layer, ring(l), false))
    case 'Polygon': return g.coordinates.map((r) => dxfPolyline(layer, ring(r), true))
    case 'MultiPolygon': return g.coordinates.flatMap((p) => p.map((r) => dxfPolyline(layer, ring(r), true)))
    default: return []
  }
}

async function gmsMapRoutes(fastify) {
  const pg = fastify.pg
  const view = { preHandler: requireRole(fastify, GMS.viewInternal) }

  fastify.get('/gms/tiles/:layer/:z/:x/:y.pbf', { ...view, schema: { tags, summary: 'Vector tile' } }, async (request, reply) => {
    const { layer } = request.params
    const [z, x, y] = ['z', 'x', 'y'].map((k) => Number(request.params[k]))
    if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22) return reply.code(400).send({ success: false, error: 'bad_tile' })

    let sql
    const args = [z, x, y]
    if (layer === 'parcels') {
      sql = `SELECT ST_AsMVT(t, 'parcels', 4096, 'geom') AS tile FROM (
               SELECT ST_AsMVTGeom(ST_Transform(p.geom_wgs84, 3857), b.env, 4096, 64, true) AS geom,
                      p.parcel_id, p.stand_no, p.township_code, p.accuracy_class, p.status, p.allocation_status
                 FROM land.parcel p, b
                WHERE p.geom_wgs84 && ST_Transform(b.env, 4326) AND p.status <> 'retired') t`
    } else {
      const { rows: [l] } = await pg.query('SELECT * FROM gis_ops.layer WHERE layer_id = $1', [layer])
      if (!l || !canViewLayer(request.user, l)) return reply.code(404).send({ success: false, error: 'not_found' })
      args.push(layer)
      sql = `SELECT ST_AsMVT(t, $4, 4096, 'geom') AS tile FROM (
               SELECT ST_AsMVTGeom(ST_Transform(f.geom, 3857), b.env, 4096, 64, true) AS geom,
                      f.feature_id, f.accuracy_class, ${LABEL_SQL} AS label
                 FROM gis_ops.feature f, b
                WHERE f.layer_id = $4 AND f.status = 'published' AND f.geom && ST_Transform(b.env, 4326)) t`
    }
    const { rows: [r] } = await pg.query(`WITH b AS (SELECT ST_TileEnvelope($1, $2, $3) AS env) ${sql}`, args)
    return reply
      .header('content-type', 'application/vnd.mapbox-vector-tile')
      // Edits publish on QA approval; a minute of staleness is fine and
      // saves the 3G link from refetching every pan.
      .header('cache-control', 'private, max-age=60')
      .send(r.tile)
  })

  fastify.get('/gms/crs', { ...view, schema: { tags, summary: 'CRS registry' } }, async () => {
    const { rows } = await pg.query(
      'SELECT srid, code, name, datum, proj4text, is_survey, transform_method, accuracy_m FROM gis_ops.crs_registry ORDER BY srid')
    return { success: true, data: rows.map((r) => ({ ...r, accuracy_m: r.accuracy_m == null ? null : Number(r.accuracy_m) })) }
  })

  fastify.get('/gms/search', { ...view, schema: { tags, summary: 'Search everything with a location' } }, async (request) => {
    const q = String(request.query?.q || '').trim().slice(0, 100)
    if (q.length < 2) return { success: true, data: [] }
    const results = []

    const coord = parseCoordinates(q)
    if (coord) {
      const { rows: [c] } = await pg.query(
        `SELECT ST_X(g) AS lng, ST_Y(g) AS lat
           FROM ST_Transform(ST_SetSRID(ST_MakePoint($1, $2), $3::int), 4326) AS g`,
        [coord.x, coord.y, coord.srid]).catch(() => ({ rows: [] }))
      if (c) results.push({ kind: 'coordinate', id: q, label: `${coord.label} ${coord.x}, ${coord.y}`, detail: `${Number(c.lat).toFixed(6)}, ${Number(c.lng).toFixed(6)}`, center: [c.lng, c.lat] })
    }

    const like = `%${q}%`
    const prefix = `${q}%`
    const box = (alias) => `ST_AsGeoJSON(ST_Envelope(${alias}), 7)::json AS env,
      ARRAY[ST_X(ST_PointOnSurface(${alias})), ST_Y(ST_PointOnSurface(${alias}))] AS center`
    // ST_Envelope of a point is the point: no box to fit, just a centre.
    const bbox = (env) => (env?.type === 'Polygon' ? [...env.coordinates[0][0], ...env.coordinates[0][2]] : null)

    const [parcels, accounts, wards, villages, features] = await Promise.all([
      pg.query(`SELECT parcel_id, stand_no, township_code, status, ${box('geom_wgs84')}
                  FROM land.parcel
                 WHERE parcel_id ILIKE $1 OR stand_no = $2 OR sg_ref ILIKE $3
                 ORDER BY status = 'current' DESC, township_code, stand_no LIMIT 8`, [prefix, q, like]),
      pg.query(`SELECT a.erp_account_no, p.parcel_id, p.stand_no, p.township_code, ${box('p.geom_wgs84')}
                  FROM revenue_link.account_link a JOIN land.parcel p ON p.parcel_id = a.parcel_id
                 WHERE a.erp_account_no ILIKE $1 LIMIT 8`, [prefix]),
      pg.query(`SELECT ward_code, name, ${box('geom')} FROM admin.ward
                 WHERE ward_code ILIKE $1 OR name ILIKE $1 LIMIT 5`, [like]),
      pg.query(`SELECT v.village_id, v.name, w.name AS ward, ST_X(v.geom) AS lng, ST_Y(v.geom) AS lat
                  FROM admin.village v JOIN admin.ward w ON w.ward_code = v.ward_code
                 WHERE v.name ILIKE $1 AND v.geom IS NOT NULL LIMIT 5`, [like]),
      pg.query(`SELECT f.feature_id, f.layer_id, l.title, l.access_level, l.custodian_dept, ${LABEL_SQL} AS label, ${box('f.geom')}
                  FROM gis_ops.feature f JOIN gis_ops.layer l ON l.layer_id = f.layer_id
                 WHERE f.status = 'published'
                   AND (${LABEL_SQL} ILIKE $1 OR ('F-' || f.feature_id) ILIKE $2)
                 LIMIT 10`, [like, q]),
    ])
    for (const r of parcels.rows) results.push({ kind: 'parcel', id: r.parcel_id, label: `Stand ${r.stand_no}, ${r.township_code}`, detail: `${r.parcel_id}${r.status !== 'current' ? ` · ${r.status}` : ''}`, center: r.center, bbox: bbox(r.env) })
    for (const r of accounts.rows) results.push({ kind: 'account', id: r.parcel_id, label: `Account ${r.erp_account_no}`, detail: `Stand ${r.stand_no}, ${r.township_code}`, center: r.center, bbox: bbox(r.env) })
    for (const r of wards.rows) results.push({ kind: 'ward', id: r.ward_code, label: r.name, detail: r.ward_code, center: r.center, bbox: bbox(r.env) })
    for (const r of villages.rows) results.push({ kind: 'village', id: r.village_id, label: r.name, detail: r.ward, center: [r.lng, r.lat] })
    for (const r of features.rows.filter((f) => canViewLayer(request.user, f))) {
      results.push({ kind: 'feature', id: String(r.feature_id), layer_id: r.layer_id, label: r.label, detail: `${r.title} · F-${r.feature_id}`, center: r.center, bbox: bbox(r.env) })
    }
    // ponytail: permits, assets and work orders join this list in the phases
    // that build those registers.
    return { success: true, data: results }
  })

  fastify.get('/gms/export/dxf', { ...view, schema: { tags, summary: 'DXF export in any registered CRS' } }, async (request, reply) => {
    const layerId = String(request.query?.layer || 'parcels')
    const srid = Number(request.query?.srid)
    const { rows: [crs] } = await pg.query('SELECT * FROM gis_ops.crs_registry WHERE srid = $1', [Number.isInteger(srid) ? srid : 0])
    if (!crs) return reply.code(400).send({ success: false, error: 'unknown_crs' })

    let rows
    let label
    if (layerId === 'parcels') {
      const township = String(request.query?.township || '')
      if (!township) return reply.code(400).send({ success: false, error: 'township_required' })
      // Survey coordinates go out exactly as the Survey Section supplied them
      // when the requested CRS is the source CRS; otherwise transformed.
      ;({ rows } = await pg.query(
        `SELECT stand_no AS label,
                ST_AsGeoJSON(g, 3)::json AS geometry, ST_AsGeoJSON(ST_PointOnSurface(g), 3)::json AS anchor
           FROM (SELECT stand_no, CASE WHEN source_srid = $2 THEN geom_source
                                       ELSE ST_Transform(geom_source, $2::int) END AS g
                   FROM land.parcel WHERE township_code = $1 AND status = 'current') p
          ORDER BY stand_no`, [township, srid]))
      label = `parcels ${township}`
    } else {
      const { rows: [l] } = await pg.query('SELECT * FROM gis_ops.layer WHERE layer_id = $1', [layerId])
      if (!l || !canViewLayer(request.user, l)) return reply.code(404).send({ success: false, error: 'not_found' })
      ;({ rows } = await pg.query(
        `SELECT ${LABEL_SQL} AS label, ST_AsGeoJSON(g, 3)::json AS geometry, ST_AsGeoJSON(ST_PointOnSurface(g), 3)::json AS anchor
           FROM (SELECT *, ST_Transform(geom, $2::int) AS g FROM gis_ops.feature
                  WHERE layer_id = $1 AND status = 'published') f`, [layerId, srid]))
      label = l.title
    }

    // Lo coordinates are Y (positive west) and X (positive south). Plotted as
    // is they draw mirrored, so CAD gets the usual surveyor's convention:
    // drawing x = -Y, drawing y = -X. Distances, areas and shape are exact.
    const lo = crs.is_survey
    const map = lo ? ([yy, xx]) => [-yy, -xx] : ([a, b]) => [a, b]
    const textH = crs.srid === 4326 ? 0.00002 : 2
    const layerName = layerId.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
    const entities = []
    for (const r of rows) {
      entities.push(...geometryToDxf(layerName, r.geometry, map))
      if (r.label) entities.push(dxfText(`${layerName}_LABELS`, map(r.anchor.coordinates), r.label, textH))
    }
    await audit(pg, request, {
      event: 'EXPORT', severity: 'medium', entityType: 'gms_layer', entityId: layerId,
      details: { format: 'dxf', crs: crs.code, features: rows.length, filter: request.query?.township || null },
    })
    const doc = dxfDocument(entities, [
      `Vungu RDC GIS Branch export: ${label}`,
      `CRS: ${crs.name} (${crs.code})${lo ? ' - drawing x = -Y, drawing y = -X (Lo survey convention)' : ''}`,
      `Features: ${rows.length}. Generated ${new Date().toISOString()}`,
    ])
    return reply
      .header('content-type', 'application/dxf')
      .header('content-disposition', `attachment; filename="${layerId}-${crs.code}.dxf"`)
      .send(doc)
  })
}

module.exports = { gmsMapRoutes, parseCoordinates, geometryToDxf }
