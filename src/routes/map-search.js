/**
 * /api/map-search — intelligent spatial search for the GIS map.
 *
 * Handles:
 *   - NL count queries:  "how many schools"  → COUNT from pois_points / pois_areas
 *   - Feature search:    "show hospitals"     → features + bbox
 *   - Zone filter:       "residential zones"  → vungu_proposed_peri_urban_zones
 *   - Stand lookup:      "HDR-001", "stand 5" → stands table exact / ILIKE
 *   - Ward lookup:       "ward 3"             → wards table + fly-to
 *
 * GET /api/map-search?q=<text>&bbox=<minLng,minLat,maxLng,maxLat>
 *
 * Response:
 *   { type, message, count, features, bbox, suggestions }
 */

'use strict'

// Vungu RDC planning extent — use this as the default spatial filter
// when no bbox is given (covers all master-plan zones + surrounding wards).
const VUNGU_BBOX = [29.4, -20.1, 30.5, -19.0]

// Keyword → fclass mapping for POI queries
const POI_KEYWORDS = {
  school:        ['school', 'kindergarten', 'college', 'university'],
  hospital:      ['hospital'],
  clinic:        ['clinic', 'doctors'],
  pharmacy:      ['pharmacy', 'chemist'],
  police:        ['police'],
  fire:          ['fire_station'],
  library:       ['library'],
  church:        ['church', 'place_of_worship'],
  mosque:        ['mosque'],
  bank:          ['bank', 'atm'],
  market:        ['marketplace', 'supermarket', 'convenience'],
  hotel:         ['hotel', 'motel', 'guesthouse'],
  restaurant:    ['restaurant', 'fast_food', 'cafe', 'bar', 'biergarten'],
  fuel:          ['fuel'],
  post:          ['post_office'],
  museum:        ['museum', 'attraction'],
  community:     ['community_centre'],
  tower:         ['comms_tower', 'tower'],
  cemetery:      ['cemetery'],
  hospital_area: ['hospital', 'clinic'],
}

// Keyword → zone type fragment for zone queries
const ZONE_KEYWORDS = {
  residential:  ['Residential', 'HDR', 'MDR', 'LDR'],
  commercial:   ['Commercial', 'Business', 'Economic'],
  industrial:   ['Industrial'],
  agricultural: ['Agricultural', 'Farm', 'Farming'],
  mixed:        ['Mixed'],
  corridor:     ['Corridor'],
  peri:         ['Peri-Urban'],
  beyond:       ['Beyond Peri-Urban'],
}

function parseBbox(bboxStr) {
  if (!bboxStr) return VUNGU_BBOX
  const parts = bboxStr.split(',').map(Number)
  if (parts.length === 4 && parts.every(isFinite)) return parts
  return VUNGU_BBOX
}

async function mapSearchRoutes(fastify) {
  fastify.get('/map-search', async (req, reply) => {
    const q = String(req.query.q || '').trim().toLowerCase()
    if (!q) return reply.send({ type: 'empty', message: 'Enter a search term', features: [], count: 0, bbox: VUNGU_BBOX })

    const bbox = parseBbox(req.query.bbox)
    const [minLng, minLat, maxLng, maxLat] = bbox

    // ── 1. Count query: "how many X [in vungu]" ─────────────────────────
    const countMatch = q.match(/how many|count of?|number of/)
    if (countMatch) {
      return handleCountQuery(fastify, q, minLng, minLat, maxLng, maxLat, reply)
    }

    // ── 2. Stand lookup: "stand HDR-001", "HDR-001", "stand 5" ──────────
    const standPattern = /(?:stand\s+)?([a-z]+-\d+|\d{1,6})/i
    const standMatch = q.match(standPattern)
    if (standMatch || q.includes('stand')) {
      const result = await handleStandSearch(fastify, q, standMatch, reply)
      if (result) return result
    }

    // ── 3. Zone filter: "residential zones", "show commercial" ──────────
    for (const [key, fragments] of Object.entries(ZONE_KEYWORDS)) {
      if (q.includes(key)) {
        return handleZoneSearch(fastify, fragments, minLng, minLat, maxLng, maxLat, reply)
      }
    }

    // ── 4. POI feature search: "show schools", "hospitals" ──────────────
    for (const [keyword, fclasses] of Object.entries(POI_KEYWORDS)) {
      if (q.includes(keyword)) {
        return handlePoiSearch(fastify, fclasses, minLng, minLat, maxLng, maxLat, reply)
      }
    }

    // ── 5. Ward search: "ward 3", "ward seven" ──────────────────────────
    const wardMatch = q.match(/ward\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)/i)
    if (wardMatch) {
      return handleWardSearch(fastify, wardMatch[1], reply)
    }

    // ── 6. Place name search: fall back to pois_points name ILIKE ───────
    return handleNameSearch(fastify, q, minLng, minLat, maxLng, maxLat, reply)
  })

  // ── Vungu mask endpoint: country polygon minus Vungu planning extent ──
  // Used by the frontend to grey-out non-Vungu areas.
  fastify.get('/map-search/vungu-mask', async (_req, reply) => {
    try {
      const { rows } = await fastify.pg.query(`
        SELECT ST_AsGeoJSON(
          ST_Difference(
            (SELECT geom FROM country LIMIT 1),
            ST_Buffer(
              (SELECT ST_Union(geom) FROM vungu_proposed_peri_urban_zones WHERE is_active = true),
              0.15
            )
          )
        ) AS mask
      `)
      if (!rows[0]?.mask) return reply.code(404).send({ error: 'No mask' })
      return reply.send({
        type: 'Feature',
        geometry: JSON.parse(rows[0].mask),
        properties: {}
      })
    } catch (err) {
      fastify.log.error({ err }, 'vungu-mask failed')
      // Fall back: return a simple box covering all of Zimbabwe minus Vungu extent
      return reply.send({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [25.0, -23.0], [33.5, -23.0], [33.5, -15.5], [25.0, -15.5], [25.0, -23.0]
          ]]
        },
        properties: { fallback: true }
      })
    }
  })
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleCountQuery(fastify, q, minLng, minLat, maxLng, maxLat, reply) {
  // Find which entity type is being counted
  for (const [keyword, fclasses] of Object.entries(POI_KEYWORDS)) {
    if (q.includes(keyword)) {
      const placeholders = fclasses.map((_, i) => `$${i + 5}`).join(', ')
      const { rows } = await fastify.pg.query(
        `SELECT COUNT(*)::int as total,
                json_agg(json_build_object('name', name, 'lng', ST_X(geom)::numeric(9,6), 'lat', ST_Y(geom)::numeric(9,6), 'fclass', fclass)) as places
         FROM pois_points
         WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
           AND fclass = ANY(ARRAY[${placeholders}])`,
        [minLng, minLat, maxLng, maxLat, ...fclasses]
      )
      const total = rows[0].total
      const places = rows[0].places || []
      const names = places.slice(0, 5).map(p => p.name || p.fclass).filter(Boolean)

      let bbox = [minLng, minLat, maxLng, maxLat]
      if (places.length > 0) {
        const lngs = places.map(p => p.lng)
        const lats = places.map(p => p.lat)
        bbox = [Math.min(...lngs) - 0.05, Math.min(...lats) - 0.05,
                Math.max(...lngs) + 0.05, Math.max(...lats) + 0.05]
      }

      const label = keyword.charAt(0).toUpperCase() + keyword.slice(1)
      const nameStr = names.length ? ` (${names.join(', ')}${places.length > 5 ? '…' : ''})` : ''
      return reply.send({
        type: 'count',
        message: `${total} ${label}${total !== 1 ? 's' : ''} found in Vungu district${nameStr}`,
        count: total,
        bbox,
        features: places.map(p => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          properties: { name: p.name || p.fclass, fclass: p.fclass }
        }))
      })
    }
  }

  // Count stands
  if (q.includes('stand') || q.includes('plot') || q.includes('erf')) {
    const status = q.includes('available') ? 'available'
      : q.includes('allocated') ? 'allocated'
      : q.includes('reserved') ? 'reserved'
      : null
    const { rows } = await fastify.pg.query(
      `SELECT COUNT(*)::int as total FROM stands
       WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
         ${status ? `AND status = '${status}'` : ''}`,
      [minLng, minLat, maxLng, maxLat]
    )
    const label = status ? `${status} stand` : 'stand'
    return reply.send({
      type: 'count',
      message: `${rows[0].total} ${label}${rows[0].total !== 1 ? 's' : ''} in Vungu district`,
      count: rows[0].total,
      bbox: [minLng, minLat, maxLng, maxLat],
      features: []
    })
  }

  // Count zones
  if (q.includes('zone') || q.includes('zoning')) {
    const { rows } = await fastify.pg.query(
      `SELECT COUNT(*)::int as total, json_agg(DISTINCT zone) as zones
       FROM vungu_proposed_peri_urban_zones WHERE is_active = true`
    )
    return reply.send({
      type: 'count',
      message: `${rows[0].total} planning zones in Vungu district`,
      count: rows[0].total,
      bbox: VUNGU_BBOX,
      features: []
    })
  }

  return reply.send({ type: 'count', message: 'Specify what to count (e.g. "how many schools")', count: 0, bbox: VUNGU_BBOX, features: [] })
}

async function handleStandSearch(fastify, q, standMatch, reply) {
  // Try exact stand number first
  const numericOrCode = standMatch ? standMatch[1] : null
  if (numericOrCode) {
    const { rows } = await fastify.pg.query(
      `SELECT id::text, stand_number, ward, zone_type, use_scale, area_sqm, price_usd, status, description,
              ST_X(centroid)::numeric(9,6) as lng, ST_Y(centroid)::numeric(9,6) as lat,
              ST_AsGeoJSON(geom) as geom
       FROM stands
       WHERE UPPER(stand_number) = UPPER($1) OR stand_number ILIKE $2
       LIMIT 3`,
      [numericOrCode, `%${numericOrCode}%`]
    )
    if (rows.length > 0) {
      const stand = rows[0]
      const geomParsed = JSON.parse(stand.geom)
      const coords = geomParsed.coordinates[0]
      const lngs = coords.map(c => c[0])
      const lats = coords.map(c => c[1])
      return reply.send({
        type: 'stand',
        message: `Stand ${stand.stand_number} — ${stand.status}, ${stand.ward}`,
        count: rows.length,
        bbox: [Math.min(...lngs) - 0.002, Math.min(...lats) - 0.002,
               Math.max(...lngs) + 0.002, Math.max(...lats) + 0.002],
        features: rows.map(s => ({
          type: 'Feature',
          geometry: JSON.parse(s.geom),
          properties: {
            id: s.id, stand_number: s.stand_number, ward: s.ward,
            zone_type: s.zone_type, use_scale: s.use_scale,
            area_sqm: Number(s.area_sqm), price_usd: Number(s.price_usd),
            status: s.status, description: s.description,
            centroid_lng: Number(s.lng), centroid_lat: Number(s.lat)
          }
        }))
      })
    }
  }
  return null
}

async function handleZoneSearch(fastify, fragments, minLng, minLat, maxLng, maxLat, reply) {
  const conditions = fragments.map((_, i) => `zone ILIKE $${i + 5}`).join(' OR ')
  const { rows } = await fastify.pg.query(
    `SELECT id::text, zone, zone_type, area_ha, authority, is_active,
            ST_AsGeoJSON(geom) as geom,
            ST_X(ST_Centroid(geom))::numeric(9,6) as clng,
            ST_Y(ST_Centroid(geom))::numeric(9,6) as clat
     FROM vungu_proposed_peri_urban_zones
     WHERE is_active = true AND ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
       AND (${conditions})
     ORDER BY area_ha::numeric DESC NULLS LAST
     LIMIT 20`,
    [minLng, minLat, maxLng, maxLat, ...fragments.map(f => `%${f}%`)]
  )
  if (rows.length === 0) {
    return reply.send({ type: 'zone', message: 'No matching zones found', count: 0, bbox: VUNGU_BBOX, features: [] })
  }
  const lngs = rows.map(r => Number(r.clng))
  const lats = rows.map(r => Number(r.clat))
  return reply.send({
    type: 'zone',
    message: `${rows.length} matching zone${rows.length !== 1 ? 's' : ''} in Vungu district`,
    count: rows.length,
    bbox: [Math.min(...lngs) - 0.05, Math.min(...lats) - 0.05,
           Math.max(...lngs) + 0.05, Math.max(...lats) + 0.05],
    features: rows.map(r => ({
      type: 'Feature',
      geometry: JSON.parse(r.geom),
      properties: { id: r.id, zone: r.zone, zone_type: r.zone_type, area_ha: r.area_ha, is_active: r.is_active }
    }))
  })
}

async function handlePoiSearch(fastify, fclasses, minLng, minLat, maxLng, maxLat, reply) {
  const placeholders = fclasses.map((_, i) => `$${i + 5}`).join(', ')
  const { rows } = await fastify.pg.query(
    `SELECT name, fclass,
            ST_X(geom)::numeric(9,6) as lng,
            ST_Y(geom)::numeric(9,6) as lat
     FROM pois_points
     WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
       AND fclass = ANY(ARRAY[${placeholders}])
     ORDER BY name
     LIMIT 50`,
    [minLng, minLat, maxLng, maxLat, ...fclasses]
  )
  if (rows.length === 0) {
    return reply.send({ type: 'poi', message: 'No matching places found in Vungu area', count: 0, bbox: VUNGU_BBOX, features: [] })
  }
  const lngs = rows.map(r => Number(r.lng))
  const lats = rows.map(r => Number(r.lat))
  const label = fclasses[0].charAt(0).toUpperCase() + fclasses[0].slice(1)
  return reply.send({
    type: 'poi',
    message: `${rows.length} ${label}${rows.length !== 1 ? 's' : ''} found in Vungu area`,
    count: rows.length,
    bbox: [Math.min(...lngs) - 0.05, Math.min(...lats) - 0.05,
           Math.max(...lngs) + 0.05, Math.max(...lats) + 0.05],
    features: rows.map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(r.lng), Number(r.lat)] },
      properties: { name: r.name || r.fclass, fclass: r.fclass }
    }))
  })
}

async function handleWardSearch(fastify, wardName, reply) {
  const numWords = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 }
  const wardNum = String(numWords[wardName?.toLowerCase()] || wardName)
  const { rows } = await fastify.pg.query(
    `SELECT fid, name_en, pcode,
            ST_X(ST_Centroid(geom))::numeric(9,6) as lng,
            ST_Y(ST_Centroid(geom))::numeric(9,6) as lat,
            ST_XMin(geom)::numeric(9,6) as minx, ST_YMin(geom)::numeric(9,6) as miny,
            ST_XMax(geom)::numeric(9,6) as maxx, ST_YMax(geom)::numeric(9,6) as maxy
     FROM wards
     WHERE name_en = $1
       AND ST_Intersects(geom, ST_MakeEnvelope(29.4, -20.1, 30.5, -19.0, 4326))
     LIMIT 3`,
    [wardNum]
  )
  if (rows.length === 0) {
    return reply.send({ type: 'ward', message: `Ward ${wardName} not found in Vungu area`, count: 0, bbox: VUNGU_BBOX, features: [] })
  }
  const r = rows[0]
  return reply.send({
    type: 'ward',
    message: `Ward ${wardNum} — Vungu district (pcode: ${r.pcode})`,
    count: rows.length,
    bbox: [Number(r.minx) - 0.01, Number(r.miny) - 0.01, Number(r.maxx) + 0.01, Number(r.maxy) + 0.01],
    features: rows.map(w => ({
      type: 'Feature',
      geometry: null,
      properties: { fid: w.fid, name: `Ward ${w.name_en}`, pcode: w.pcode, lng: Number(w.lng), lat: Number(w.lat) }
    }))
  })
}

async function handleNameSearch(fastify, q, minLng, minLat, maxLng, maxLat, reply) {
  const { rows } = await fastify.pg.query(
    `SELECT name, fclass,
            ST_X(geom)::numeric(9,6) as lng,
            ST_Y(geom)::numeric(9,6) as lat
     FROM pois_points
     WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
       AND name ILIKE $5
     UNION ALL
     SELECT name, fclass,
            ST_X(ST_Centroid(geom))::numeric(9,6) as lng,
            ST_Y(ST_Centroid(geom))::numeric(9,6) as lat
     FROM pois_areas
     WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
       AND name ILIKE $5
     ORDER BY name
     LIMIT 20`,
    [minLng, minLat, maxLng, maxLat, `%${q}%`]
  )
  if (rows.length === 0) {
    return reply.send({
      type: 'notfound',
      message: `No results for "${q}". Try "schools", "hospitals", "residential zones", or a stand number like "HDR-001".`,
      count: 0, bbox: VUNGU_BBOX, features: []
    })
  }
  const lngs = rows.map(r => Number(r.lng))
  const lats = rows.map(r => Number(r.lat))
  return reply.send({
    type: 'place',
    message: `${rows.length} place${rows.length !== 1 ? 's' : ''} matching "${q}"`,
    count: rows.length,
    bbox: [Math.min(...lngs) - 0.05, Math.min(...lats) - 0.05,
           Math.max(...lngs) + 0.05, Math.max(...lats) + 0.05],
    features: rows.map(r => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(r.lng), Number(r.lat)] },
      properties: { name: r.name || r.fclass, fclass: r.fclass }
    }))
  })
}

module.exports = { mapSearchRoutes }
