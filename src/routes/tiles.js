// src/routes/tiles.js
// Vector tile service: serves PostGIS layers as MVT (PBF).
//
// This file implements:
//   GET /api/tiles/layers           - layer catalog (JSON)
//   GET /api/tiles/:layer/:z/:x/:y.pbf - one MVT tile (binary, gzip)
//   GET /api/tiles/:layer/:id       - single feature GeoJSON popup
//   GET /api/tiles/topo/:layer      - full layer as simplified TopoJSON
//   GET /api/tiles/cache/stats      - cache diagnostics (admin only)
//   DELETE /api/tiles/cache/:layer  - invalidate one layer (admin only)

const zlib = require('zlib')
const { promisify } = require('util')
const gzip = promisify(zlib.gzip)

const { allLayers, getLayer } = require('../config/spatialLayers')
const { isValidTileCoord, buildTileQuery } = require('../lib/tileQuery')
const { TileCache } = require('../lib/tileCache')
const { requireAuth, requireRole } = require('../middleware/jwtAuth')

// Module-level tile cache: L1 in-process LRU (4 000 tiles / 128 MB / 24 h TTL).
// A Redis L2 is attached at registration time (see tilesRoutes) when
// @fastify/redis is available; without it the cache stays L1-only. Declared
// here (not inside tilesRoutes) so the module-level invalidateTileLayer export
// below can reach the same instance.
const cache = new TileCache({ capacity: 4000, maxBytes: 128 * 1024 * 1024 })

function etagFor(key) {
  const day = new Date().toISOString().slice(0, 10)
  const hash = Buffer.from(`${key}:${day}`).toString('base64').slice(0, 16)
  return `"${hash}"`
}

/** Capitalise the first letter of a string for tidy result subtitles. */
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

// ── Map-event SSE bus ─────────────────────────────────────────────────────
// Lightweight publish-subscribe for real-time map tile invalidation events.
// Callers (stands.js, zones.js, etc.) call `emitMapEvent({layer:'stands'})`
// after mutating spatial data. Connected browser tabs receive the event and
// bust their local tile-source cache so the map refreshes without a reload.
const _sseClients = new Set()

function emitMapEvent(payload) {
  if (_sseClients.size === 0) return
  const data = `data: ${JSON.stringify({ ...payload, ts: Date.now() })}\n\n`
  for (const res of _sseClients) {
    try { res.raw.write(data) } catch { _sseClients.delete(res) }
  }
}

async function tilesRoutes(fastify) {
  // Attach the Redis L2 to the module-level cache when @fastify/redis is
  // registered (REDIS_URL set). Without it the cache stays L1-only and the
  // route code is unaffected.
  if (fastify.redis) cache.redis = fastify.redis

  // ── Server-Sent Events: map tile invalidation ──────────────────────────
  // Clients connect to /api/map/events; the server pushes an event whenever
  // a spatial layer is mutated (stands registered, zones edited, etc.) so
  // the browser refreshes that tile source without a full page reload.
  fastify.get('/map/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.write(': connected\n\n')
    _sseClients.add(reply)
    request.raw.on('close', () => _sseClients.delete(reply))
    // keep-alive ping every 25 s so proxies don't close the connection
    const ping = setInterval(() => {
      try { reply.raw.write(': ping\n\n') }
      catch { clearInterval(ping); _sseClients.delete(reply) }
    }, 25000)
    request.raw.on('close', () => clearInterval(ping))
    // Never resolve — Fastify must not end the response
    await new Promise(() => {})
  })

  // Layer catalog — drives frontend layer panels.
  // IMPORTANT: this static route MUST be declared before the parametric
  // /tiles/:layer/:id route below; otherwise Fastify would treat the literal
  // segment "layers" as a value for :layer and shadow this handler entirely.
  // A non-numeric :id (e.g. a stray path segment) reaching that route is
  // intentionally rejected with 400 via the Number.isInteger check.
  fastify.get('/tiles/layers', async () => ({
    success: true,
    data: allLayers().map((l) => ({
      id: l.id,
      title: l.title,
      geomType: l.geomType,
      group: l.group,
      minzoom: l.minzoom,
      maxzoom: l.maxzoom,
    })),
  }))

  fastify.get('/tiles/cache/stats',
    { preHandler: [requireAuth, requireRole(['admin'])] },
    async () => ({ success: true, data: cache.stats() })
  )

  fastify.delete('/tiles/cache/:layer',
    { preHandler: [requireAuth, requireRole(['admin'])] },
    async (req) => {
      const count = cache.invalidateLayer(req.params.layer)
      return { success: true, data: { invalidated: count, layer: req.params.layer } }
    }
  )

  const COUNCIL_DISTRICT_PCODE = process.env.COUNCIL_DISTRICT_PCODE || 'ZW1704'
  fastify.get('/wards', async (request, reply) => {
    try {
      const scope = request.query?.scope === 'country' ? 'country' : 'council'
      const filter = scope === 'council' ? 'AND w.pcode LIKE $1' : ''
      const params = scope === 'council' ? [`${COUNCIL_DISTRICT_PCODE}%`] : []
      const { rows } = await fastify.pg.query(
        `SELECT w.fid,
                w.name_en AS ward_label,
                w.pcode,
                d.name_en AS district_name,
                ST_X(ST_Centroid(ST_SetSRID(w.geom, 4326))) AS lon,
                ST_Y(ST_Centroid(ST_SetSRID(w.geom, 4326))) AS lat
         FROM wards w
         LEFT JOIN districts d ON d.pcode = LEFT(w.pcode, 6)
         WHERE w.geom IS NOT NULL ${filter}
         ORDER BY d.name_en NULLS LAST,
                  CASE WHEN w.name_en ~ '^[0-9]+$' THEN LPAD(w.name_en, 4, '0') ELSE w.name_en END,
                  w.fid`,
        params
      )
      reply
        .header('Cache-Control', 'public, max-age=3600')
        .send({
          success: true,
          data: rows.map((r) => {
            const wardLabel = r.ward_label ? `Ward ${r.ward_label}` : `Ward ${r.fid}`
            const name = r.district_name ? `${wardLabel} - ${r.district_name}` : wardLabel
            return {
              fid: r.fid,
              name,
              pcode: r.pcode || null,
              center: [Number(r.lon), Number(r.lat)],
            }
          }),
        })
    } catch (err) {
      fastify.log.error({ err }, 'ward list query failed')
      return reply.code(500).send({ error: 'Ward lookup failed' })
    }
  })

  fastify.get('/map-search', async (request, reply) => {
    const q = String(request.query?.q || '').trim()
    if (q.length < 1) return { success: true, data: [] }
    const like = `%${q}%`
    const councilPcode = process.env.COUNCIL_DISTRICT_PCODE || 'ZW1704'

    try {
      const out = []

      const wards = await fastify.pg.query(
        `SELECT w.name_en AS ward, d.name_en AS district,
                ST_X(ST_Centroid(ST_SetSRID(w.geom, 4326))) AS lon,
                ST_Y(ST_Centroid(ST_SetSRID(w.geom, 4326))) AS lat
         FROM wards w
         LEFT JOIN districts d ON d.pcode = LEFT(w.pcode, 6)
         WHERE w.pcode LIKE $1
           AND (w.name_en ILIKE $2 OR ('ward ' || w.name_en) ILIKE $2)
         ORDER BY (CASE WHEN w.name_en ~ '^[0-9]+$' THEN LPAD(w.name_en, 4, '0') ELSE w.name_en END)
         LIMIT 8`,
        [`${councilPcode}%`, like]
      )
      for (const r of wards.rows) {
        out.push({
          type: 'ward',
          label: `Ward ${r.ward}`,
          subtitle: r.district ? `${r.district} Rural District` : 'Ward',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      const districts = await fastify.pg.query(
        `SELECT name_en AS label,
                ST_X(ST_Centroid(ST_SetSRID(geom, 4326))) AS lon,
                ST_Y(ST_Centroid(ST_SetSRID(geom, 4326))) AS lat
         FROM districts
         WHERE level = 2 AND name_en ILIKE $1
         ORDER BY name_en
         LIMIT 8`,
        [like]
      )
      for (const r of districts.rows) {
        out.push({
          type: 'place',
          label: r.label,
          subtitle: 'District',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      const parcels = await fastify.pg.query(
        `SELECT COALESCE(NULLIF(name, ''), name_cfu, 'Parcel ' || fid) AS label,
                district,
                ST_X(ST_Centroid(geom)) AS lon, ST_Y(ST_Centroid(geom)) AS lat
         FROM vungu_parcels
         WHERE geom IS NOT NULL AND (name ILIKE $1 OR name_cfu ILIKE $1)
         LIMIT 8`,
        [like]
      )
      for (const r of parcels.rows) {
        out.push({
          type: 'parcel',
          label: r.label,
          subtitle: r.district ? `Parcel - ${r.district}` : 'Parcel',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      const farms = await fastify.pg.query(
        `SELECT COALESCE(NULLIF(name, ''), name_cfu, 'Farm ' || fid) AS label,
                ST_X(ST_Centroid(geom)) AS lon, ST_Y(ST_Centroid(geom)) AS lat
         FROM vungu_farm_cadastre
         WHERE geom IS NOT NULL AND (name ILIKE $1 OR name_cfu ILIKE $1)
         LIMIT 8`,
        [like]
      )
      for (const r of farms.rows) {
        out.push({
          type: 'farm',
          label: r.label,
          subtitle: 'Farm cadastre',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      const places = await fastify.pg.query(
        `SELECT p.name AS label, p.fclass,
                d.name_en AS district,
                ST_X(ST_Centroid(ST_SetSRID(p.geom, 4326))) AS lon,
                ST_Y(ST_Centroid(ST_SetSRID(p.geom, 4326))) AS lat
         FROM places_points p
         LEFT JOIN districts d
           ON d.level = 2 AND ST_Contains(d.geom, ST_SetSRID(p.geom, ST_SRID(d.geom)))
         WHERE p.name ILIKE $1
         ORDER BY p.name
         LIMIT 8`,
        [like]
      )
      for (const r of places.rows) {
        out.push({
          type: 'place',
          label: r.label,
          subtitle: r.district ? `${r.district} Rural District` : 'Place',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      const pois = await fastify.pg.query(
        `SELECT p.name AS label, p.fclass,
                ST_X(ST_Centroid(ST_SetSRID(p.geom, 4326))) AS lon,
                ST_Y(ST_Centroid(ST_SetSRID(p.geom, 4326))) AS lat
         FROM pois_points p
         WHERE p.name ILIKE $1
         ORDER BY p.name
         LIMIT 8`,
        [like]
      )
      for (const r of pois.rows) {
        out.push({
          type: 'poi',
          label: r.label,
          subtitle: r.fclass ? cap(r.fclass.replace(/_/g, ' ')) : 'Facility',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      const zones = await fastify.pg.query(
        `SELECT zone AS label,
                ST_X(ST_Centroid(geom)) AS lon, ST_Y(ST_Centroid(geom)) AS lat
         FROM vungu_proposed_peri_urban_zones
         WHERE geom IS NOT NULL AND zone ILIKE $1
         LIMIT 8`,
        [like]
      )
      for (const r of zones.rows) {
        out.push({
          type: 'zone',
          label: r.label,
          subtitle: 'Proposed peri-urban zone',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      const beyond = await fastify.pg.query(
        `SELECT COALESCE(settlement, zone_code) AS label,
                ST_X(ST_Centroid(geom)) AS lon, ST_Y(ST_Centroid(geom)) AS lat
         FROM vungu_beyond_peri_urban_zones
         WHERE geom IS NOT NULL AND (settlement ILIKE $1 OR zone_code ILIKE $1 OR adm3_en ILIKE $1)
         LIMIT 8`,
        [like]
      )
      for (const r of beyond.rows) {
        if (!r.label) continue
        out.push({
          type: 'zone',
          label: r.label,
          subtitle: 'Land tenure zone',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      // ── Stands ────────────────────────────────────────────────────────
      const stands = await fastify.pg.query(
        `SELECT stand_number AS label, ward, zone_type, status,
                area_sqm, price_usd,
                ST_X(centroid)::numeric(9,6) AS lon,
                ST_Y(centroid)::numeric(9,6) AS lat
         FROM stands
         WHERE stand_number ILIKE $1
         LIMIT 8`,
        [like]
      )
      for (const r of stands.rows) {
        out.push({
          type: 'stand',
          label: `Stand ${r.label}`,
          subtitle: `${cap(r.status)} — ${r.ward || 'Vungu RDC'}`,
          meta: { zone_type: r.zone_type, area_sqm: Number(r.area_sqm), price_usd: Number(r.price_usd), status: r.status },
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      // ── Roads ──────────────────────────────────────────────────────────
      const roads = await fastify.pg.query(
        `SELECT DISTINCT ON (name) name AS label, fclass, ref,
                ST_X(ST_Centroid(geom))::numeric(9,6) AS lon,
                ST_Y(ST_Centroid(geom))::numeric(9,6) AS lat
         FROM roads
         WHERE ST_Intersects(geom, ST_MakeEnvelope(29.4,-20.1,30.5,-19.0,4326))
           AND name IS NOT NULL AND name != '' AND name ILIKE $1
         ORDER BY name, fclass
         LIMIT 6`,
        [like]
      )
      for (const r of roads.rows) {
        out.push({
          type: 'road',
          label: r.label,
          subtitle: cap((r.fclass||'').replace(/_/g,' ')),
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      // ── Wards ──────────────────────────────────────────────────────────
      const wardAc = await fastify.pg.query(
        `SELECT name_en AS ward_name, pcode,
                ST_X(ST_Centroid(geom))::numeric(9,6) AS lon,
                ST_Y(ST_Centroid(geom))::numeric(9,6) AS lat
         FROM wards WHERE pcode LIKE 'ZW1704%'
           AND (name_en ILIKE $1 OR ('ward ' || name_en) ILIKE $1)
         ORDER BY name_en LIMIT 5`,
        [like]
      )
      for (const r of wardAc.rows) {
        out.push({
          type: 'ward', label: `Ward ${r.ward_name}`,
          subtitle: 'Vungu RDC Ward',
          center: [Number(r.lon), Number(r.lat)],
        })
      }

      const data = out.filter((r) =>
        r.label &&
        Number.isFinite(r.center[0]) && Number.isFinite(r.center[1]) &&
        !(r.center[0] === 0 && r.center[1] === 0)
      )
      // Normalise: ensure every result has an `id` field (frontend uses it as :key)
      const normalised = data.map((r, i) => ({ id: `${r.type}-${i}`, ...r }))
      reply.header('Cache-Control', 'public, max-age=120').send({ success: true, data: normalised, results: normalised })
    } catch (err) {
      fastify.log.error({ err, q }, 'map search failed')
      return reply.code(500).send({ error: 'Search failed' })
    }
  })

  // ── NL count + POI search ─────────────────────────────────────────────────
  const POI_FCLASS_MAP = {
    school: ['school','kindergarten','college'],
    hospital: ['hospital'], clinic: ['clinic','doctors'],
    pharmacy: ['pharmacy','chemist'], police: ['police'],
    fire: ['fire_station'], library: ['library'],
    bank: ['bank','atm'], market: ['marketplace','supermarket'],
    hotel: ['hotel','guesthouse'], restaurant: ['restaurant','fast_food','cafe'],
    fuel: ['fuel'], community: ['community_centre'],
    church: ['place_of_worship'], mosque: ['place_of_worship'],
    prison: ['prison'], courthouse: ['courthouse'], embassy: ['embassy'],
    stadium: ['stadium'], park: ['park','playground','sports_centre'],
    office: ['public_building','town_hall'], cemetery: ['cemetery','grave_yard'],
  }
  const ROAD_FCLASS_MAP = {
    motorway: ['motorway','motorway_link'],
    primary: ['primary','primary_link'],
    secondary: ['secondary','secondary_link'],
    residential: ['residential','living_street'],
    track: ['track'],
    path: ['path','footway','cycleway'],
    service: ['service'],
  }
  const VUNGU_BOX = [29.4, -20.1, 30.5, -19.0]
  // Helper: compute bbox from array of {lng,lat} objects
  const rowsBbox = (rows, pad = 0.05) => {
    const lngs = rows.map(r => Number(r.lng)), lats = rows.map(r => Number(r.lat))
    return [Math.min(...lngs)-pad, Math.min(...lats)-pad, Math.max(...lngs)+pad, Math.max(...lats)+pad]
  }

  fastify.get('/map-query', async (request, reply) => {
    const q = String(request.query?.q || '').trim().toLowerCase()
    if (!q) return reply.send({ type: 'empty', message: 'Enter a query', results: [], bbox: VUNGU_BOX })

    try {
      // ── Count query ───────────────────────────────────────────────────────
      if (/how many|count|number of/.test(q)) {
        for (const [kw, fclasses] of Object.entries(POI_FCLASS_MAP)) {
          if (q.includes(kw)) {
            const ph = fclasses.map((_, i) => `$${i + 5}`).join(', ')
            const { rows } = await fastify.pg.query(
              `SELECT COUNT(*)::int as n,
                      json_agg(json_build_object(
                        'name', name, 'fclass', fclass,
                        'lng', ST_X(geom)::numeric(9,6),
                        'lat', ST_Y(geom)::numeric(9,6)
                      )) as pts
               FROM pois_points
               WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
                 AND fclass = ANY(ARRAY[${ph}])`,
              [...VUNGU_BOX, ...fclasses]
            )
            const total = rows[0].n
            const pts = rows[0].pts || []
            const label = kw.charAt(0).toUpperCase() + kw.slice(1)
            const bbox = pts.length ? rowsBbox(pts) : VUNGU_BOX
            return reply.send({
              type: 'poi', message: `${total} ${label}${total!==1?'s':''} in Vungu`,
              count: total, bbox,
              results: pts.map(p => ({
                type: 'poi', label: p.name || cap(p.fclass),
                subtitle: cap((p.fclass||'').replace(/_/g,' ')),
                center: [p.lng, p.lat],
                bbox: [p.lng-0.01, p.lat-0.01, p.lng+0.01, p.lat+0.01]
              }))
            })
          }
        }
        if (/stand|plot|erf/.test(q)) {
          const status = q.includes('available') ? 'available'
            : q.includes('allocated') ? 'allocated'
            : q.includes('reserved') ? 'reserved' : null
          const cond = status ? `AND status = $5` : ''
          const params = status ? [...VUNGU_BOX, status] : VUNGU_BOX
          const { rows } = await fastify.pg.query(
            `SELECT stand_number, status, ward,
                    ST_X(centroid)::numeric(9,6) as lng,
                    ST_Y(centroid)::numeric(9,6) as lat
             FROM stands
             WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326)) ${cond}
             ORDER BY stand_number LIMIT 30`, params)
          const bbox = rows.length ? rowsBbox(rows) : VUNGU_BOX
          return reply.send({
            type: 'stand', message: `${rows.length} ${status||'total'} stand${rows.length!==1?'s':''} in Vungu RDC`,
            count: rows.length, bbox,
            results: rows.map(s => ({
              type: 'stand', label: `Stand ${s.stand_number}`,
              subtitle: `${cap(s.status)} · ${s.ward||'Vungu'}`,
              status: s.status,
              center: [Number(s.lng), Number(s.lat)],
              bbox: [Number(s.lng)-0.003, Number(s.lat)-0.003, Number(s.lng)+0.003, Number(s.lat)+0.003]
            }))
          })
        }
        if (/road|street|highway/.test(q)) {
          const { rows } = await fastify.pg.query(
            `SELECT COUNT(*)::int as n FROM roads
             WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))`, VUNGU_BOX)
          return reply.send({ type: 'road', message: `${rows[0].n} road segments in Vungu area`,
            count: rows[0].n, bbox: VUNGU_BOX, results: [] })
        }
      }

      // ── Stands filter: "available stands", "show allocated", all stands ──
      if (/\bstands?\b|\bplots?\b|\berfs?\b/.test(q)) {
        const status = q.includes('available') ? 'available'
          : q.includes('allocated') ? 'allocated'
          : q.includes('reserved') ? 'reserved'
          : q.includes('withdrawn') ? 'withdrawn' : null
        const cond = status ? `AND status = $1` : ''
        const params = status ? [status] : []
        const { rows } = await fastify.pg.query(
          `SELECT stand_number, ward, zone_type, status, area_sqm, price_usd,
                  ST_X(centroid)::numeric(9,6) as lng, ST_Y(centroid)::numeric(9,6) as lat
           FROM stands WHERE 1=1 ${cond}
           ORDER BY stand_number LIMIT 30`, params)
        if (rows.length) {
          const bbox = rowsBbox(rows)
          return reply.send({
            type: 'stand',
            message: `${rows.length} ${status||'total'} stand${rows.length!==1?'s':''} in Vungu RDC`,
            count: rows.length, bbox,
            results: rows.map(s => ({
              type: 'stand', label: `Stand ${s.stand_number}`,
              subtitle: `${cap(s.status)} · Ward ${s.ward||'—'} · ${s.area_sqm}m²`,
              status: s.status,
              center: [Number(s.lng), Number(s.lat)],
              bbox: [Number(s.lng)-0.003, Number(s.lat)-0.003, Number(s.lng)+0.003, Number(s.lat)+0.003]
            }))
          })
        }
      }

      // ── POI type show ─────────────────────────────────────────────────────
      for (const [kw, fclasses] of Object.entries(POI_FCLASS_MAP)) {
        if (q.includes(kw)) {
          const ph = fclasses.map((_, i) => `$${i+5}`).join(', ')
          const { rows } = await fastify.pg.query(
            `SELECT name, fclass,
                    ST_X(geom)::numeric(9,6) as lng, ST_Y(geom)::numeric(9,6) as lat
             FROM pois_points
             WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
               AND fclass = ANY(ARRAY[${ph}])
             ORDER BY name LIMIT 50`,
            [...VUNGU_BOX, ...fclasses])
          if (rows.length) {
            const bbox = rowsBbox(rows)
            const label = kw.charAt(0).toUpperCase() + kw.slice(1)
            return reply.send({
              type: 'poi', message: `${rows.length} ${label}${rows.length!==1?'s':''} in Vungu area`,
              count: rows.length, bbox,
              results: rows.map(r => ({
                type: 'poi', label: r.name || cap(r.fclass),
                subtitle: cap((r.fclass||'').replace(/_/g,' ')),
                center: [Number(r.lng), Number(r.lat)],
                bbox: [Number(r.lng)-0.01, Number(r.lat)-0.01, Number(r.lng)+0.01, Number(r.lat)+0.01]
              }))
            })
          }
        }
      }

      // ── Roads ─────────────────────────────────────────────────────────────
      if (/\b(road|roads|street|highway|route|path|track)\b/.test(q)) {
        const ftype = Object.entries(ROAD_FCLASS_MAP).find(([k]) => q.includes(k))
        const fclasses = ftype ? ftype[1] : null
        const nameTerm = q.replace(/\b(road|roads|show|all|main|vungu|in|the|street|highway)\b/gi,' ').trim().replace(/\s+/g,' ')
        let rows
        if (fclasses) {
          const ph = fclasses.map((_, i) => `$${i+5}`).join(', ')
          const res = await fastify.pg.query(
            `SELECT COALESCE(NULLIF(name,''), ref, fclass) as label, fclass, ref,
                    ST_X(ST_Centroid(geom))::numeric(9,6) as lng,
                    ST_Y(ST_Centroid(geom))::numeric(9,6) as lat
             FROM roads WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
               AND fclass = ANY(ARRAY[${ph}]) AND name IS NOT NULL AND name != ''
             ORDER BY name LIMIT 30`, [...VUNGU_BOX, ...fclasses])
          rows = res.rows
        } else if (nameTerm.length > 1) {
          const res = await fastify.pg.query(
            `SELECT COALESCE(NULLIF(name,''), ref, fclass) as label, fclass, ref,
                    ST_X(ST_Centroid(geom))::numeric(9,6) as lng,
                    ST_Y(ST_Centroid(geom))::numeric(9,6) as lat
             FROM roads WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
               AND (name ILIKE $5 OR ref ILIKE $5)
             ORDER BY name LIMIT 30`, [...VUNGU_BOX, `%${nameTerm}%`])
          rows = res.rows
        } else {
          const res = await fastify.pg.query(
            `SELECT COALESCE(NULLIF(name,''), ref, fclass) as label, fclass,
                    ST_X(ST_Centroid(geom))::numeric(9,6) as lng,
                    ST_Y(ST_Centroid(geom))::numeric(9,6) as lat
             FROM roads WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
               AND fclass IN ('primary','secondary','trunk') AND name IS NOT NULL AND name != ''
             ORDER BY name LIMIT 30`, VUNGU_BOX)
          rows = res.rows
        }
        if (rows.length) {
          const bbox = rowsBbox(rows)
          return reply.send({
            type: 'road', message: `${rows.length} road${rows.length!==1?'s':''} in Vungu area`,
            count: rows.length, bbox,
            results: rows.map(r => ({
              type: 'road', label: r.label,
              subtitle: cap((r.fclass||'').replace(/_/g,' ')),
              center: [Number(r.lng), Number(r.lat)],
              bbox: [Number(r.lng)-0.02, Number(r.lat)-0.02, Number(r.lng)+0.02, Number(r.lat)+0.02]
            }))
          })
        }
      }

      // ── Wards ─────────────────────────────────────────────────────────────
      if (/\bward\b/.test(q)) {
        const wardNum = q.match(/ward\s*(\d+)/i)?.[1]
        const cond = wardNum ? `AND name_en = $5` : ''
        const params = wardNum ? [...VUNGU_BOX, wardNum] : VUNGU_BOX
        const { rows } = await fastify.pg.query(
          `SELECT name_en AS ward_name, pcode,
                  ST_X(ST_Centroid(geom))::numeric(9,6) as lng,
                  ST_Y(ST_Centroid(geom))::numeric(9,6) as lat
           FROM wards WHERE pcode LIKE 'ZW1704%'
             AND ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326)) ${cond}
           ORDER BY (CASE WHEN name_en ~ '^[0-9]+$' THEN LPAD(name_en,4,'0') ELSE name_en END)
           LIMIT 20`, params)
        if (rows.length) {
          const bbox = rowsBbox(rows)
          return reply.send({
            type: 'ward', message: wardNum ? `Ward ${wardNum} — Vungu RDC` : `${rows.length} wards in Vungu RDC`,
            count: rows.length, bbox,
            results: rows.map(r => ({
              type: 'ward', label: `Ward ${r.ward_name}`,
              subtitle: `Vungu RDC · ${r.pcode}`,
              center: [Number(r.lng), Number(r.lat)],
              bbox: [Number(r.lng)-0.05, Number(r.lat)-0.05, Number(r.lng)+0.05, Number(r.lat)+0.05]
            }))
          })
        }
      }

      // ── Farms ─────────────────────────────────────────────────────────────
      if (/\bfarms?\b/.test(q)) {
        const nameTerm = q.replace(/\b(farm|farms|show|all|vungu|in)\b/gi,' ').trim().replace(/\s+/g,' ')
        const cond = nameTerm.length > 1 ? `AND (name ILIKE $1 OR name_cfu ILIKE $1)` : ''
        const params = nameTerm.length > 1 ? [`%${nameTerm}%`] : []
        const { rows } = await fastify.pg.query(
          `SELECT COALESCE(NULLIF(name,''), name_cfu, 'Farm ' || fid::text) AS farm_name,
                  district,
                  ST_X(ST_Centroid(geom))::numeric(9,6) as lng,
                  ST_Y(ST_Centroid(geom))::numeric(9,6) as lat
           FROM vungu_farm_cadastre WHERE geom IS NOT NULL ${cond}
           ORDER BY farm_name LIMIT 30`, params)
        if (rows.length) {
          const bbox = rowsBbox(rows)
          return reply.send({
            type: 'farm', message: `${rows.length} farm${rows.length!==1?'s':''} in Vungu farm cadastre`,
            count: rows.length, bbox,
            results: rows.map(r => ({
              type: 'farm', label: r.farm_name,
              subtitle: r.district ? `${r.district} District` : 'Farm cadastre',
              center: [Number(r.lng), Number(r.lat)],
              bbox: [Number(r.lng)-0.02, Number(r.lat)-0.02, Number(r.lng)+0.02, Number(r.lat)+0.02]
            }))
          })
        }
      }

      // ── Parcels ───────────────────────────────────────────────────────────
      if (/\bparcels?\b/.test(q)) {
        const nameTerm = q.replace(/\b(parcel|parcels|show|all|vungu|in)\b/gi,' ').trim().replace(/\s+/g,' ')
        const cond = nameTerm.length > 1 ? `AND (name ILIKE $1 OR name_cfu ILIKE $1)` : ''
        const params = nameTerm.length > 1 ? [`%${nameTerm}%`] : []
        const { rows } = await fastify.pg.query(
          `SELECT COALESCE(NULLIF(name,''), name_cfu, 'Parcel ' || fid::text) AS parcel_name,
                  district,
                  ST_X(ST_Centroid(geom))::numeric(9,6) as lng,
                  ST_Y(ST_Centroid(geom))::numeric(9,6) as lat
           FROM vungu_parcels WHERE geom IS NOT NULL ${cond}
           ORDER BY parcel_name LIMIT 30`, params)
        if (rows.length) {
          const bbox = rowsBbox(rows)
          return reply.send({
            type: 'parcel', message: `${rows.length} parcel${rows.length!==1?'s':''} in Vungu`,
            count: rows.length, bbox,
            results: rows.map(r => ({
              type: 'parcel', label: r.parcel_name,
              subtitle: r.district ? `${r.district} District` : 'Land parcel',
              center: [Number(r.lng), Number(r.lat)],
              bbox: [Number(r.lng)-0.01, Number(r.lat)-0.01, Number(r.lng)+0.01, Number(r.lat)+0.01]
            }))
          })
        }
      }

      // ── Waterways / rivers ────────────────────────────────────────────────
      if (/\b(river|stream|waterway|dam|lake|water)\b/.test(q)) {
        const nameTerm = q.replace(/\b(river|stream|waterway|dam|lake|water|show|all|vungu|in)\b/gi,' ').trim().replace(/\s+/g,' ')
        const { rows } = await fastify.pg.query(
          nameTerm.length > 1
            ? `SELECT COALESCE(NULLIF(name,''),'Waterway') as wname, fclass,
                      ST_X(ST_Centroid(geom))::numeric(9,6) as lng,
                      ST_Y(ST_Centroid(geom))::numeric(9,6) as lat
               FROM waterways WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
                 AND name ILIKE $5 LIMIT 30`
            : `SELECT COALESCE(NULLIF(name,''),'Waterway') as wname, fclass,
                      ST_X(ST_Centroid(geom))::numeric(9,6) as lng,
                      ST_Y(ST_Centroid(geom))::numeric(9,6) as lat
               FROM waterways WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
                 AND name IS NOT NULL AND name != '' ORDER BY name LIMIT 30`,
          nameTerm.length > 1 ? [...VUNGU_BOX, `%${nameTerm}%`] : VUNGU_BOX)
        if (rows.length) {
          const bbox = rowsBbox(rows)
          return reply.send({
            type: 'waterway', message: `${rows.length} waterway${rows.length!==1?'s':''} in Vungu area`,
            count: rows.length, bbox,
            results: rows.map(r => ({
              type: 'waterway', label: r.wname,
              subtitle: cap((r.fclass||'').replace(/_/g,' ')),
              center: [Number(r.lng), Number(r.lat)],
              bbox: [Number(r.lng)-0.02, Number(r.lat)-0.02, Number(r.lng)+0.02, Number(r.lat)+0.02]
            }))
          })
        }
      }

      // ── Zones ─────────────────────────────────────────────────────────────
      if (/\b(zone|zones|residential|commercial|industrial|agricultural|corridor|peri.urban)\b/.test(q)) {
        const zoneTerm = q.replace(/\b(zones?|show|find|all|in|vungu|the)\b/gi,' ').trim().replace(/\s+/g,' ') || q
        const { rows } = await fastify.pg.query(
          `SELECT zone, zone_type, area_ha,
                  ST_X(ST_Centroid(geom))::numeric(9,6) as lng,
                  ST_Y(ST_Centroid(geom))::numeric(9,6) as lat
           FROM vungu_proposed_peri_urban_zones
           WHERE is_active = true AND (zone ILIKE $1 OR zone_type ILIKE $1)
           ORDER BY area_ha::numeric DESC NULLS LAST LIMIT 30`,
          [`%${zoneTerm}%`])
        if (rows.length) {
          const bbox = rowsBbox(rows)
          return reply.send({
            type: 'zone', message: `${rows.length} zone${rows.length!==1?'s':''} in Vungu`,
            count: rows.length, bbox,
            results: rows.map(r => ({
              type: 'zone', label: r.zone || r.zone_type,
              subtitle: `${Number(r.area_ha||0).toFixed(0)} ha · ${r.zone_type||'Zone'}`,
              center: [Number(r.lng), Number(r.lat)],
              bbox: [Number(r.lng)-0.02, Number(r.lat)-0.02, Number(r.lng)+0.02, Number(r.lat)+0.02]
            }))
          })
        }
        // fall through to beyond peri-urban zones
        const { rows: bRows } = await fastify.pg.query(
          `SELECT COALESCE(NULLIF(settlement,''), zone_code) as label, adm3_en,
                  ST_X(ST_Centroid(geom))::numeric(9,6) as lng,
                  ST_Y(ST_Centroid(geom))::numeric(9,6) as lat
           FROM vungu_beyond_peri_urban_zones WHERE geom IS NOT NULL
             AND (settlement ILIKE $1 OR zone_code ILIKE $1 OR adm3_en ILIKE $1) LIMIT 20`,
          [`%${zoneTerm}%`])
        if (bRows.length) {
          const bbox = rowsBbox(bRows)
          return reply.send({
            type: 'zone', message: `${bRows.length} beyond peri-urban zone${bRows.length!==1?'s':''} in Vungu`,
            count: bRows.length, bbox,
            results: bRows.map(r => ({
              type: 'zone', label: r.label,
              subtitle: r.adm3_en ? `${r.adm3_en} · Land tenure` : 'Land tenure zone',
              center: [Number(r.lng), Number(r.lat)],
              bbox: [Number(r.lng)-0.02, Number(r.lat)-0.02, Number(r.lng)+0.02, Number(r.lat)+0.02]
            }))
          })
        }
      }

      // ── Land use ──────────────────────────────────────────────────────────
      if (/\b(landuse|land.use|farmland|forest|orchard|grassland|industrial|recreation)\b/.test(q)) {
        const term = q.replace(/\b(landuse|land use|show|all|vungu|in)\b/gi,' ').trim().replace(/\s+/g,' ')
        const { rows } = await fastify.pg.query(
          `SELECT fclass,
                  COUNT(*)::int as n,
                  ST_X(ST_Centroid(ST_Union(geom)))::numeric(9,6) as lng,
                  ST_Y(ST_Centroid(ST_Union(geom)))::numeric(9,6) as lat
           FROM landuse
           WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
             AND fclass ILIKE $5
           GROUP BY fclass ORDER BY n DESC LIMIT 20`, [...VUNGU_BOX, `%${term||'%'}%`])
        if (rows.length) {
          return reply.send({
            type: 'landuse', message: `${rows.reduce((s,r)=>s+r.n,0)} land use polygons in Vungu area`,
            count: rows.length, bbox: VUNGU_BOX,
            results: rows.map(r => ({
              type: 'landuse', label: cap((r.fclass||'Unknown').replace(/_/g,' ')),
              subtitle: `${r.n} polygon${r.n!==1?'s':''}`,
              center: [Number(r.lng), Number(r.lat)],
              bbox: [Number(r.lng)-0.1, Number(r.lat)-0.1, Number(r.lng)+0.1, Number(r.lat)+0.1]
            }))
          })
        }
      }

      // ── Cemetery / Waste ──────────────────────────────────────────────────
      if (/\b(cemeter|burial|grave)\b/.test(q)) {
        const { rows } = await fastify.pg.query(
          `SELECT COALESCE(NULLIF(name,''),'Cemetery') as label,
                  ST_X(ST_Centroid(geom))::numeric(9,6) as lng,
                  ST_Y(ST_Centroid(geom))::numeric(9,6) as lat
           FROM vungu_cemeteries WHERE geom IS NOT NULL LIMIT 10`)
        if (rows.length) {
          const bbox = rowsBbox(rows)
          return reply.send({
            type: 'poi', message: `${rows.length} cemetery in Vungu`,
            count: rows.length, bbox,
            results: rows.map(r => ({
              type: 'poi', label: r.label, subtitle: 'Cemetery',
              center: [Number(r.lng), Number(r.lat)],
              bbox: [Number(r.lng)-0.01, Number(r.lat)-0.01, Number(r.lng)+0.01, Number(r.lat)+0.01]
            }))
          })
        }
      }
      if (/\b(waste|landfill|dump)\b/.test(q)) {
        const { rows } = await fastify.pg.query(
          `SELECT COALESCE(NULLIF(name,''),'Waste site') as label,
                  ST_X(ST_Centroid(geom))::numeric(9,6) as lng,
                  ST_Y(ST_Centroid(geom))::numeric(9,6) as lat
           FROM vungu_waste_management WHERE geom IS NOT NULL LIMIT 10`)
        if (rows.length) {
          const bbox = rowsBbox(rows)
          return reply.send({
            type: 'poi', message: `${rows.length} waste management site${rows.length!==1?'s':''} in Vungu`,
            count: rows.length, bbox,
            results: rows.map(r => ({
              type: 'poi', label: r.label, subtitle: 'Waste management',
              center: [Number(r.lng), Number(r.lat)],
              bbox: [Number(r.lng)-0.01, Number(r.lat)-0.01, Number(r.lng)+0.01, Number(r.lat)+0.01]
            }))
          })
        }
      }

      // ── Generic text fallback: search places + POIs ───────────────────────
      {
        const like = `%${q}%`
        const [placesRes, poisRes] = await Promise.all([
          fastify.pg.query(
            `SELECT name as label, fclass,
                    ST_X(ST_Centroid(ST_SetSRID(geom,4326)))::numeric(9,6) as lng,
                    ST_Y(ST_Centroid(ST_SetSRID(geom,4326)))::numeric(9,6) as lat
             FROM places_points WHERE name ILIKE $1 LIMIT 10`, [like]),
          fastify.pg.query(
            `SELECT name as label, fclass,
                    ST_X(ST_Centroid(ST_SetSRID(geom,4326)))::numeric(9,6) as lng,
                    ST_Y(ST_Centroid(ST_SetSRID(geom,4326)))::numeric(9,6) as lat
             FROM pois_points WHERE name ILIKE $1 LIMIT 10`, [like]),
        ])
        const rows = [...placesRes.rows, ...poisRes.rows].filter(r =>
          Number.isFinite(Number(r.lng)) && Number(r.lng)!==0)
        if (rows.length) {
          const bbox = rowsBbox(rows)
          return reply.send({
            type: 'place', message: `${rows.length} result${rows.length!==1?'s':''} for "${q}"`,
            count: rows.length, bbox,
            results: rows.map(r => ({
              type: r.fclass?.includes('school')||r.fclass?.includes('hospital') ? 'poi' : 'place',
              label: r.label, subtitle: cap((r.fclass||'').replace(/_/g,' ')),
              center: [Number(r.lng), Number(r.lat)],
              bbox: [Number(r.lng)-0.01, Number(r.lat)-0.01, Number(r.lng)+0.01, Number(r.lat)+0.01]
            }))
          })
        }
      }

      return reply.send({ type: 'notfound',
        message: `No results for "${q}". Try: schools, roads, available stands, residential zones, ward 3, farms, rivers.`,
        count: 0, bbox: VUNGU_BOX, results: [] })
    } catch (err) {
      fastify.log.error({ err, q }, 'map-query failed')
      return reply.code(500).send({ error: 'Query failed' })
    }
  })

  // ── Vungu district mask (country minus actual ward union boundary) ──────
  // Uses the union of Vungu RDC wards (pcode ZW1704*) so the cutout follows
  // real administrative boundary lines, not a rounded buffer.
  // ── Vungu RDC helper: exact ward-union geometry ─────────────────────────
  // Each ward's geom column has SRID 0 from the GPKG import.
  // We explicitly set 4326, run ST_MakeValid on every geometry before the
  // union, then snap the result to a grid (0.00001° ≈ 1 m) to eliminate
  // floating-point slivers that would produce hairline gaps or overlaps in
  // the rendered outline.
  const VUNGU_WARD_UNION_SQL = `
    WITH validated AS (
      SELECT ST_MakeValid(ST_SetSRID(geom::geometry, 4326)) AS g
      FROM   wards
      WHERE  pcode LIKE 'ZW1704%' AND geom IS NOT NULL
    ),
    unioned AS (
      SELECT ST_MakeValid(ST_Union(g)) AS g FROM validated
    )
    SELECT ST_SnapToGrid(g, 0.00001) AS vungu_geom FROM unioned
  `

  fastify.get('/map-search/vungu-mask', async (_req, reply) => {
    try {
      const { rows } = await fastify.pg.query(`
        WITH vungu AS (${VUNGU_WARD_UNION_SQL}),
        country_geom AS (
          SELECT ST_SetSRID(ST_MakeValid(geom::geometry), 4326) AS g
          FROM country LIMIT 1
        )
        SELECT ST_AsGeoJSON(
          ST_Difference(
            (SELECT g FROM country_geom),
            (SELECT vungu_geom FROM vungu)
          ),
          6
        ) AS mask
      `)
      if (!rows[0]?.mask) return reply.code(404).send({ error: 'Mask unavailable' })
      reply.header('Cache-Control', 'public, max-age=86400')
      return reply.send({ type: 'Feature', geometry: JSON.parse(rows[0].mask), properties: {} })
    } catch (err) {
      fastify.log.error({ err }, 'vungu-mask failed')
      return reply.code(500).send({ error: 'Mask failed' })
    }
  })

  // ── Vungu district outer boundary (precise administrative line) ──────────
  // Returns only the OUTER perimeter of the Vungu RDC ward union — no
  // internal ward boundaries — as a MultiLineString for crisp outline rendering.
  fastify.get('/map-search/vungu-boundary', async (_req, reply) => {
    try {
      const { rows } = await fastify.pg.query(`
        WITH vungu AS (${VUNGU_WARD_UNION_SQL})
        SELECT ST_AsGeoJSON(
          ST_Boundary(vungu_geom),
          6
        ) AS boundary
        FROM vungu
      `)
      if (!rows[0]?.boundary) return reply.code(404).send({ error: 'Boundary unavailable' })
      reply.header('Cache-Control', 'public, max-age=86400')
      return reply.send({ type: 'Feature', geometry: JSON.parse(rows[0].boundary), properties: {} })
    } catch (err) {
      fastify.log.error({ err }, 'vungu-boundary failed')
      return reply.code(500).send({ error: 'Boundary failed' })
    }
  })

  fastify.get('/tiles/:layer/:z/:x/:y.pbf', async (request, reply) => {
    const { layer: layerId } = request.params
    const z = Number(request.params.z)
    const x = Number(request.params.x)
    const y = Number(request.params.y)

    const layer = getLayer(layerId)
    if (!layer) {
      return reply.code(404).send({ error: `Unknown layer: ${layerId}` })
    }
    if (!isValidTileCoord(z, x, y)) {
      return reply.code(400).send({ error: 'Invalid tile coordinate' })
    }
    if (z < layer.minzoom || z > layer.maxzoom) {
      return reply
        .header('Cache-Control', 'public, max-age=604800')
        .code(204).send()
    }

    const key = `${layerId}/${z}/${x}/${y}`
    const etag = etagFor(key)

    if (request.headers['if-none-match'] === etag) {
      return reply.code(304).send()
    }

    const cached = await cache.get(key)
    if (cached) {
      return reply
        .header('Content-Type', 'application/vnd.mapbox-vector-tile')
        .header('Content-Encoding', 'gzip')
        .header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600')
        .header('ETag', etag)
        .header('X-Tile-Cache', 'hit')
        .send(cached)
    }

    try {
      const { sql, params } = buildTileQuery(layer, z, x, y)
      const { rows } = await fastify.pg.query(sql, params)
      const rawTile = rows[0]?.tile

      if (!rawTile || rawTile.length === 0) {
        return reply
          .header('Cache-Control', 'public, max-age=3600')
          .code(204).send()
      }
      const compressed = await gzip(Buffer.from(rawTile), { level: 6 })
      await cache.set(key, compressed)

      return reply
        .header('Content-Type', 'application/vnd.mapbox-vector-tile')
        .header('Content-Encoding', 'gzip')
        .header('Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600')
        .header('ETag', etag)
        .header('X-Tile-Cache', 'miss')
        .send(compressed)
    } catch (err) {
      // 42P01 = undefined_table: the layer is registered but the DB table
      // is missing (e.g. a layer not yet imported). Return an empty tile so
      // the map renders cleanly instead of logging a 500 per tile.
      if (err.code === '42P01') {
        return reply
          .header('Cache-Control', 'public, max-age=60')
          .code(204).send()
      }
      fastify.log.error({ err, layer: layerId, z, x, y }, 'tile query failed')
      return reply.code(500).send({ error: 'Tile generation failed' })
    }
  })

  fastify.get('/tiles/:layer/:id', async (request, reply) => {
    const { layer: layerId, id } = request.params
    const layer = getLayer(layerId)
    if (!layer) {
      return reply.code(404).send({ error: `Unknown layer: ${layerId}` })
    }
    const fid = Number(id)
    if (!Number.isInteger(fid)) {
      return reply.code(400).send({ error: 'Invalid feature id' })
    }
    try {
      const attrs = layer.attributes.map((a) => `"${a}"`).join(', ')
      const { rows } = await fastify.pg.query(
        `SELECT ${attrs}, ST_AsGeoJSON(ST_SetSRID(geom, 4326), 6) AS geometry
         FROM "${layer.table}" WHERE fid = $1`,
        [fid]
      )
      if (!rows.length) {
        return reply.code(404).send({ error: 'Feature not found' })
      }
      const { geometry, ...properties } = rows[0]
      return {
        type: 'Feature',
        geometry: JSON.parse(geometry),
        properties: { ...properties, _layer: layerId },
      }
    } catch (err) {
      fastify.log.error({ err, layer: layerId, id }, 'feature lookup failed')
      return reply.code(500).send({ error: 'Feature lookup failed' })
    }
  })

  fastify.get('/tiles/topo/:layer', async (request, reply) => {
    const layer = getLayer(request.params.layer)
    if (!layer) {
      return reply.code(404).send({ error: `Unknown layer: ${request.params.layer}` })
    }
    if (layer.group !== 'admin') {
      return reply.code(400).send({ error: 'TopoJSON only available for admin boundary layers' })
    }
    try {
      const attrs = layer.attributes.filter((a) => a !== 'fid')
      const attrPairs = attrs.map((a) => `'${a}', "${a}"`).join(', ')
      const simplifyDeg = 0.005
      const { rows } = await fastify.pg.query(
        `SELECT jsonb_agg(
           jsonb_build_object(
             'type', 'Feature',
             'id', fid,
             'geometry', ST_AsGeoJSON(
               ST_SimplifyPreserveTopology(ST_SetSRID(geom,4326), $1),
               5
             )::jsonb,
             'properties', jsonb_build_object(${attrPairs})
           )
         ) AS features
         FROM "${layer.table}"
         WHERE geom IS NOT NULL`,
        [simplifyDeg]
      )
      const features = rows[0]?.features || []
      let topology
      try {
        const { topology: topoFn } = require('topojson-server')
        topology = topoFn({ [layer.id]: { type: 'FeatureCollection', features } })
      } catch {
        topology = { type: 'FeatureCollection', features }
      }
      const json = JSON.stringify(topology)
      const compressed = await gzip(Buffer.from(json))
      return reply
        .header('Content-Type', 'application/geo+json')
        .header('Content-Encoding', 'gzip')
        .header('Cache-Control', 'public, max-age=604800')
        .send(compressed)
    } catch (err) {
      fastify.log.error({ err, layer: request.params.layer }, 'topo query failed')
      return reply.code(500).send({ error: 'TopoJSON generation failed' })
    }
  })
}

/** Invalidate all cached tiles for a layer — call after data mutations. */
function invalidateTileLayer(layerId) {
  return cache.invalidateLayer(layerId)
}

module.exports = { tilesRoutes, invalidateTileLayer, emitMapEvent }
