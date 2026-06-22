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

// 4 000 tiles, 128 MB max, 24 h TTL
const cache = new TileCache(4000, 128 * 1024 * 1024, 24 * 60 * 60 * 1000)

function etagFor(key) {
  const day = new Date().toISOString().slice(0, 10)
  const hash = Buffer.from(`${key}:${day}`).toString('base64').slice(0, 16)
  return `"${hash}"`
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

async function tilesRoutes(fastify) {
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

      const data = out.filter((r) =>
        r.label &&
        Number.isFinite(r.center[0]) && Number.isFinite(r.center[1]) &&
        !(r.center[0] === 0 && r.center[1] === 0)
      )
      reply.header('Cache-Control', 'public, max-age=120').send({ success: true, data })
    } catch (err) {
      fastify.log.error({ err, q }, 'map search failed')
      return reply.code(500).send({ error: 'Search failed' })
    }
  })

  // ── NL count + POI search ─────────────────────────────────────────────────
  // Handles: "how many schools", "show hospitals", "residential zones",
  //          "available stands", "stand HDR-001".
  // Returns bbox so the frontend can flyTo the results.
  const POI_FCLASS_MAP = {
    school: ['school','kindergarten','college'],
    hospital: ['hospital'], clinic: ['clinic','doctors'],
    pharmacy: ['pharmacy','chemist'], police: ['police'],
    fire: ['fire_station'], library: ['library'],
    bank: ['bank','atm'], market: ['marketplace','supermarket'],
    hotel: ['hotel','guesthouse'], restaurant: ['restaurant','fast_food','cafe'],
    fuel: ['fuel'], community: ['community_centre'],
  }
  const VUNGU_BOX = [29.4, -20.1, 30.5, -19.0]

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
            const names = pts.slice(0, 5).map(p => p.name).filter(Boolean).join(', ')
            const lngs = pts.map(p => p.lng), lats = pts.map(p => p.lat)
            const bbox = pts.length
              ? [Math.min(...lngs)-0.05, Math.min(...lats)-0.05, Math.max(...lngs)+0.05, Math.max(...lats)+0.05]
              : VUNGU_BOX
            return reply.send({
              type: 'count',
              message: `${total} ${label}${total!==1?'s':''} in Vungu${names ? ` (${names}${pts.length>5?'…':''})` : ''}`,
              count: total, bbox,
              results: pts.map(p => ({
                type: 'poi', label: p.name || p.fclass,
                subtitle: cap((p.fclass||'').replace(/_/g,' ')),
                center: [p.lng, p.lat]
              }))
            })
          }
        }
        // Stands count
        if (/stand|plot|erf/.test(q)) {
          const status = q.includes('available') ? 'available'
            : q.includes('allocated') ? 'allocated'
            : q.includes('reserved') ? 'reserved' : null
          const cond = status ? `AND status = '${status}'` : ''
          const { rows } = await fastify.pg.query(
            `SELECT COUNT(*)::int as n FROM stands
             WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326)) ${cond}`,
            VUNGU_BOX
          )
          const lbl = status || 'total'
          return reply.send({
            type: 'count',
            message: `${rows[0].n} ${lbl} stand${rows[0].n!==1?'s':''} in Vungu RDC`,
            count: rows[0].n, bbox: VUNGU_BOX, results: []
          })
        }
      }

      // ── Stand status filter: "available stands", "show allocated" ────────────
      if (/stand|plot|erf/.test(q) && /available|allocated|reserved/.test(q)) {
        const status = q.includes('available') ? 'available'
          : q.includes('allocated') ? 'allocated' : 'reserved'
        const { rows } = await fastify.pg.query(
          `SELECT stand_number, ward, zone_type, status, area_sqm, price_usd,
                  ST_X(centroid)::numeric(9,6) as lng, ST_Y(centroid)::numeric(9,6) as lat
           FROM stands WHERE status = $1
           ORDER BY stand_number LIMIT 20`,
          [status]
        )
        if (rows.length) {
          const lngs = rows.map(r => Number(r.lng)), lats = rows.map(r => Number(r.lat))
          const bbox = [Math.min(...lngs)-0.05, Math.min(...lats)-0.05, Math.max(...lngs)+0.05, Math.max(...lats)+0.05]
          return reply.send({
            type: 'stand',
            message: `${rows.length} ${status} stand${rows.length!==1?'s':''} in Vungu RDC`,
            count: rows.length, bbox,
            results: rows.map(s => ({
              type: 'stand', label: `Stand ${s.stand_number}`,
              subtitle: `${cap(s.status)} — ${s.ward}`,
              meta: { zone_type: s.zone_type, area_sqm: Number(s.area_sqm), price_usd: Number(s.price_usd), status: s.status },
              center: [Number(s.lng), Number(s.lat)]
            }))
          })
        }
      }

      // ── Stand lookup ───────────────────────────────────────────────────────
      if (/stand|hdr|mdr|ec-/.test(q)) {
        const code = q.replace(/^(stand\s+)/,'').trim()
        const { rows } = await fastify.pg.query(
          `SELECT stand_number, ward, zone_type, status, area_sqm, price_usd,
                  ST_X(centroid)::numeric(9,6) as lng, ST_Y(centroid)::numeric(9,6) as lat,
                  ST_AsGeoJSON(geom) as geom
           FROM stands WHERE stand_number ILIKE $1 LIMIT 5`,
          [`%${code}%`]
        )
        if (rows.length) {
          const r = rows[0]
          const bbox = [Number(r.lng)-0.005, Number(r.lat)-0.005, Number(r.lng)+0.005, Number(r.lat)+0.005]
          return reply.send({
            type: 'stand',
            message: rows.length === 1
              ? `Stand ${r.stand_number} — ${cap(r.status)}, ${r.ward}`
              : `${rows.length} stands matching "${code}"`,
            count: rows.length, bbox,
            results: rows.map(s => ({
              type: 'stand', label: `Stand ${s.stand_number}`,
              subtitle: `${cap(s.status)} — ${s.ward}`,
              meta: { zone_type: s.zone_type, area_sqm: Number(s.area_sqm), price_usd: Number(s.price_usd), status: s.status },
              center: [Number(s.lng), Number(s.lat)]
            }))
          })
        }
      }

      // ── POI type show: "show schools", "hospitals near me" ────────────────
      for (const [kw, fclasses] of Object.entries(POI_FCLASS_MAP)) {
        if (q.includes(kw)) {
          const ph = fclasses.map((_, i) => `$${i+5}`).join(', ')
          const { rows } = await fastify.pg.query(
            `SELECT name, fclass,
                    ST_X(geom)::numeric(9,6) as lng,
                    ST_Y(geom)::numeric(9,6) as lat
             FROM pois_points
             WHERE ST_Intersects(geom, ST_MakeEnvelope($1,$2,$3,$4,4326))
               AND fclass = ANY(ARRAY[${ph}])
             ORDER BY name LIMIT 30`,
            [...VUNGU_BOX, ...fclasses]
          )
          if (rows.length) {
            const lngs = rows.map(r => Number(r.lng)), lats = rows.map(r => Number(r.lat))
            const bbox = [Math.min(...lngs)-0.05, Math.min(...lats)-0.05, Math.max(...lngs)+0.05, Math.max(...lats)+0.05]
            const label = kw.charAt(0).toUpperCase() + kw.slice(1)
            return reply.send({
              type: 'poi',
              message: `${rows.length} ${label}${rows.length!==1?'s':''} in Vungu area`,
              count: rows.length, bbox,
              results: rows.map(r => ({
                type: 'poi', label: r.name || cap(r.fclass),
                subtitle: cap((r.fclass||'').replace(/_/g,' ')),
                center: [Number(r.lng), Number(r.lat)]
              }))
            })
          }
        }
      }

      // ── Zone type filter ───────────────────────────────────────────────────
      if (/zone|residential|commercial|industrial|agricultural|corridor/.test(q)) {
        // Extract the meaningful term: strip stop words and 's' suffix from "zones"
        const zoneTerm = q.replace(/\b(zones?|show|find|all|in|vungu)\b/gi, ' ').trim().replace(/\s+/g, ' ') || q
        const { rows } = await fastify.pg.query(
          `SELECT zone, zone_type, area_ha,
                  ST_X(ST_Centroid(geom))::numeric(9,6) as lng,
                  ST_Y(ST_Centroid(geom))::numeric(9,6) as lat
           FROM vungu_proposed_peri_urban_zones
           WHERE is_active = true AND (zone ILIKE $1 OR zone_type ILIKE $1)
           ORDER BY area_ha::numeric DESC NULLS LAST LIMIT 20`,
          [`%${zoneTerm}%`]
        )
        if (rows.length) {
          const lngs = rows.map(r => Number(r.lng)), lats = rows.map(r => Number(r.lat))
          const bbox = [Math.min(...lngs)-0.05, Math.min(...lats)-0.05, Math.max(...lngs)+0.05, Math.max(...lats)+0.05]
          return reply.send({
            type: 'zone',
            message: `${rows.length} zone${rows.length!==1?'s':''} matching your query`,
            count: rows.length, bbox,
            results: rows.map(r => ({
              type: 'zone', label: r.zone || r.zone_type,
              subtitle: `${Number(r.area_ha).toFixed(0)} ha`,
              center: [Number(r.lng), Number(r.lat)]
            }))
          })
        }
      }

      return reply.send({ type: 'notfound',
        message: `No results. Try: "schools", "available stands", "residential zones", "stand HDR-001".`,
        count: 0, bbox: VUNGU_BOX, results: [] })
    } catch (err) {
      fastify.log.error({ err, q }, 'map-query failed')
      return reply.code(500).send({ error: 'Query failed' })
    }
  })

  // ── Vungu district mask (country minus planning zones buffer) ─────────────
  // Called once on map load; result cached for 24h (static data).
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
      if (!rows[0]?.mask) return reply.code(404).send({ error: 'Mask unavailable' })
      return reply.header('Cache-Control', 'public, max-age=86400').send({
        type: 'Feature', geometry: JSON.parse(rows[0].mask), properties: {}
      })
    } catch (err) {
      fastify.log.error({ err }, 'vungu-mask failed')
      return reply.code(500).send({ error: 'Mask failed' })
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

    const cached = cache.get(key)
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
      cache.set(key, compressed)

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

module.exports = { tilesRoutes, invalidateTileLayer }
