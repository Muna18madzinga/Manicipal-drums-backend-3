// src/routes/inspector-routing.js
// ─────────────────────────────────────────────────────────────────────────
// Road corridor for in-app navigation to an inspection site.
//
//   GET /inspector/route-corridor?minLng&minLat&maxLng&maxLat[&classes]
//
// Returns the road segments inside a bounding box as GeoJSON. The routing
// itself — graph, A*, turn instructions, re-routing — runs on the client, so
// this endpoint is READ-ONLY and stateless.
//
// WHY NOT pgRouting, which is installed (4.0.1):
// pgr_dijkstra needs source/target columns, and pgr_createTopology would ALTER
// the 210,240-row roads table on a cluster with known catalog corruption. A
// corridor fetch needs no schema change at all, and a corridor cached on the
// device keeps working when the signal drops — which a server round-trip per
// re-route cannot. Field use in a rural district decides this.
//
// CRS: roads are stored as SRID 900914 (a CRS84 alias, identical lng/lat
// coordinates). The bbox pre-filter uses the bare column with `&&`, which is
// GiST-indexed and does not reject the mixed SRID; the output relabels to 4326
// with ST_SetSRID, which is lossless. Same rule as inspectorSpatial.js.
// ─────────────────────────────────────────────────────────────────────────

const { requireRole } = require('../middleware/jwtAuth')

const STAFF_ROLES = [
  'admin', 'planner', 'planning_clerk', 'building_inspector',
  'eo', 'env_officer', 'surveyor', 'gis_officer',
]

// A vehicle corridor. Tracks are IN: in a rural district an inspector reaches
// most sites on a track (80,626 of them here), and excluding them would route
// a bakkie onto a trunk road and then nowhere. Footways, steps, cycleways and
// bridleways are OUT — routing a vehicle down a footpath is worse than failing.
const DRIVABLE_FCLASS = [
  'motorway', 'motorway_link', 'trunk', 'trunk_link',
  'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
  'residential', 'living_street', 'service', 'unclassified', 'unknown',
  'track', 'track_grade1', 'track_grade2', 'track_grade3', 'track_grade4', 'track_grade5',
]

// A corridor wider than this is a request to download the district. The client
// is told the cap so it can subdivide rather than guess.
const MAX_BBOX_SQ_KM = 1200
// Hard ceiling on rows. The response says when it was hit: a partial graph must
// never be routed on silently — a missing segment is an invented detour.
const MAX_SEGMENTS = 20000

function bboxFrom(query) {
  const n = (v) => {
    const x = Number(v)
    return Number.isFinite(x) ? x : null
  }
  const minLng = n(query.minLng); const minLat = n(query.minLat)
  const maxLng = n(query.maxLng); const maxLat = n(query.maxLat)
  if ([minLng, minLat, maxLng, maxLat].some(v => v === null)) return null
  if (minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90) return null
  if (minLng >= maxLng || minLat >= maxLat) return null
  return { minLng, minLat, maxLng, maxLat }
}

async function inspectorRoutingRoutes(fastify) {
  const pg = fastify.pg

  fastify.get('/inspector/route-corridor', {
    preHandler: requireRole(fastify, STAFF_ROLES),
  }, async (request, reply) => {
    const box = bboxFrom(request.query || {})
    if (!box) {
      return reply.code(400).send({
        success: false, error: 'bad_bbox',
        message: 'minLng, minLat, maxLng and maxLat are required, in range, and min must be less than max.',
      })
    }

    const drivableOnly = request.query.classes !== 'all'

    try {
      const area = await pg.query(
        `SELECT ST_Area(ST_MakeEnvelope($1,$2,$3,$4,4326)::geography) / 1000000 AS sq_km`,
        [box.minLng, box.minLat, box.maxLng, box.maxLat],
      )
      const bboxAreaSqKm = Math.round(Number(area.rows[0].sq_km) * 10) / 10
      if (bboxAreaSqKm > MAX_BBOX_SQ_KM) {
        return reply.code(413).send({
          success: false, error: 'bbox_too_large',
          message: `That corridor covers ${bboxAreaSqKm} km². Request smaller boxes and join them.`,
          bboxAreaSqKm, maxAreaSqKm: MAX_BBOX_SQ_KM,
        })
      }

      // LIMIT + 1: one row past the ceiling is how we know it was hit.
      const { rows } = await pg.query(
        `WITH box AS (SELECT ST_MakeEnvelope($1,$2,$3,$4,4326) AS g)
         SELECT r.fid, r.name, r.fclass, r.oneway, r.maxspeed,
                ST_AsGeoJSON(ST_SetSRID(r.geom, 4326), 6) AS geojson
           FROM roads r, box
          WHERE r.geom && box.g
            ${drivableOnly ? 'AND r.fclass = ANY($6::text[])' : ''}
          ORDER BY r.fid
          LIMIT $5`,
        drivableOnly
          ? [box.minLng, box.minLat, box.maxLng, box.maxLat, MAX_SEGMENTS + 1, DRIVABLE_FCLASS]
          : [box.minLng, box.minLat, box.maxLng, box.maxLat, MAX_SEGMENTS + 1],
      )

      const truncated = rows.length > MAX_SEGMENTS
      const kept = truncated ? rows.slice(0, MAX_SEGMENTS) : rows

      const features = []
      for (const r of kept) {
        let geometry = null
        try { geometry = JSON.parse(r.geojson) } catch { geometry = null }
        if (!geometry) continue
        features.push({
          type: 'Feature',
          id: r.fid,
          geometry,
          properties: {
            fid: r.fid,
            name: r.name || null,
            fclass: r.fclass,
            // OSM direction flag. This dataset holds only 'B' (both ways) and
            // 'F' (forward along the geometry). Anything that is not 'F' is
            // traversable in both directions.
            oneway: r.oneway || 'B',
            maxspeed: r.maxspeed == null ? null : Number(r.maxspeed) || null,
          },
        })
      }

      return {
        success: true,
        data: {
          type: 'FeatureCollection',
          features,
          truncated,
          segmentCount: features.length,
          bboxAreaSqKm,
          classes: drivableOnly ? 'drivable' : 'all',
        },
      }
    } catch (err) {
      request.log.error({ err }, '[inspector-routing] corridor failed')
      return reply.code(500).send({
        success: false, error: 'corridor_failed', message: 'The road corridor could not be loaded.',
      })
    }
  })
}

module.exports = {
  inspectorRoutingRoutes,
  _internals: { bboxFrom, DRIVABLE_FCLASS, MAX_BBOX_SQ_KM, MAX_SEGMENTS },
}
