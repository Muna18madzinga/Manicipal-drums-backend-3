// src/services/planningSpatial.js
// ─────────────────────────────────────────────────────────────────────────
// PostGIS site-analysis + geometry laundering for the grounded Planning Studio
// AI assistant. This is the ONLY source of authoritative geometry in the
// pipeline: Claude and Llama receive facts computed here, and every draft they
// return is clipped/snapped/dropped back through here before the frontend
// sees it. Nothing the models invent can escape the parcel or land inside a
// no-go constraint.
//
//   buildSiteContext(pg, {layer, fid})  → verified site facts (Stage 1)
//   getParcelGrounding(pg, {layer, fid})→ parcel + entry points + nogo (Stage 3 prompt)
//   postProcessDraft(pg, {layer, fid, draft}) → laundered draft (Stage 3 output)
//
// CRS INVARIANT (read once — do NOT "optimize" these two rules away; the second
// one is a 40×-slower footgun if you drop it):
//   1. SRID reality: the vungu_* parcel tables are true EPSG:4326; the OSM-derived
//      layers (roads, waterways, buildings, landuse, *_areas, *_points) are stored
//      as SRID 900914 — a CRS84 alias whose coordinates are IDENTICAL to 4326
//      (lng/lat), only the SRID label differs. So `ST_SetSRID(geom,4326)` is a
//      lossless relabel, never a reprojection.
//   2. Index-safe spatial joins: EVERY join between the parcel and an OSM layer
//      MUST bbox-pre-filter with the BARE indexed column first —
//      `layer.geom && parcel.g` — because `&&` uses the GiST index and tolerates
//      the mixed SRID (it compares cached bboxes, identical coords). Only THEN do
//      the exact `ST_Intersects(ST_SetSRID(layer.geom,4326), parcel.g)` on the
//      handful of survivors. Wrapping the column in the bbox step defeats the
//      index → full table scan (711k buildings, 210k roads).
//   • Distances and areas cast ::geography so results are real ground metres/m².
//   • Topology ops (Intersection/Difference/Union/Snap) run in planar 4326;
//     accurate enough at single-parcel scale and matches tiles.js / tileQuery.js.
// ─────────────────────────────────────────────────────────────────────────

const { getLayer } = require('../config/spatialLayers')

// Only cadastral parcel tables may be analysed. Registry-driven allowlist —
// the table name is never taken from user input.
const PARCEL_LAYERS = new Set(['vungu_farm_cadastre', 'vungu_parcels'])

// natural_areas is SPARSE in this dataset (audited 2026-07: only cliff/spring/
// cave_entrance, a handful of features) and there is NO DEM/elevation layer, so
// "mountains / rough terrain" is a weak signal. These fclasses are still treated
// as no-go where present; the site analysis states the limitation explicitly.
const ROUGH_TERRAIN_FCLASS = ['cliff', 'rock', 'scree', 'peak', 'ridge', 'cave_entrance']
const SCHOOL_FCLASS = ['school', 'kindergarten', 'college', 'university']
const HEALTH_FCLASS = ['clinic', 'hospital', 'doctors', 'pharmacy', 'dentist']

const STREAM_BUFFER_M = 30          // EMA stream / river statutory setback
const SETTLEMENT_RADIUS_M = 10000   // nearby-context search radius
const AMENITY_RADIUS_M = 10000
const SNAP_TOL_DEG = 0.0005         // ~55 m at the equator — road endpoint snap
const MIN_ZONE_HA = 0.25            // drop laundered zones below this
const MIN_ROAD_M = 50               // drop laundered road segments below this
const HEAVY_CLIP_RATIO = 0.3        // keep, but note, zones that lost >70% of area
const COMPLEXITY_NPOINTS = 2000     // above this the parcel boundary is coarsened

// Boundary/no-go simplification tolerance in degrees (0.0002 ≈ 20 m). Coarser
// for pathologically complex parcels so the LLM payload stays token-bounded.
// Inlined as a SQL CASE so the decision travels with the query.
const SIMPLIFY_CASE = `CASE WHEN ST_NPoints((SELECT g FROM parcel)) > ${COMPLEXITY_NPOINTS} THEN 0.0006 ELSE 0.0002 END`

/** SQL array literal from a whitelist of [a-z_] tokens (safe to inline). */
function sqlTextArray(tokens) {
  const safe = tokens.filter(t => /^[a-z_]+$/.test(t)).map(t => `'${t}'`)
  return `ARRAY[${safe.join(',')}]::text[]`
}
const TERRAIN_ARR = sqlTextArray(ROUGH_TERRAIN_FCLASS)
const SCHOOL_ARR = sqlTextArray(SCHOOL_FCLASS)
const HEALTH_ARR = sqlTextArray(HEALTH_FCLASS)

/** Resolve + validate the parcel table from the registry allowlist. */
function parcelTable(layer) {
  if (!PARCEL_LAYERS.has(layer)) return null
  const l = getLayer(layer)
  return l && l.table ? l.table : null
}

/** Parse a GeoJSON string, tolerating null/empty. */
function parseGeo(s) {
  if (!s) return null
  try { const g = JSON.parse(s); return g && g.coordinates && g.coordinates.length ? g : null }
  catch { return null }
}

/** Recursively collect [lng,lat] pairs from any GeoJSON geometry (dedup, capped). */
function pointsFromGeo(g, out = [], seen = new Set()) {
  if (!g) return out
  if (g.type === 'GeometryCollection') { (g.geometries || []).forEach(x => pointsFromGeo(x, out, seen)); return out }
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      const k = c[0].toFixed(6) + ',' + c[1].toFixed(6)
      if (!seen.has(k) && out.length < 24) { seen.add(k); out.push([+c[0].toFixed(6), +c[1].toFixed(6)]) }
    } else c.forEach(walk)
  }
  if (Array.isArray(g.coordinates)) walk(g.coordinates)
  return out
}

// The no-go union CTE. Assumes a preceding `parcel AS (... AS g ...)` in the
// same WITH clause. Each constraint component is clipped to the parcel BEFORE
// the union so ST_UnaryUnion never sees geometry larger than the parcel.
const NOGO_CTE = `
  comp AS (
    SELECT ST_Intersection(ST_Buffer(ST_SetSRID(w.geom,4326)::geography, ${STREAM_BUFFER_M})::geometry, p.g) AS g
      FROM waterways w, parcel p
      WHERE w.geom && ST_Expand(p.g, 0.01)
        AND ST_DWithin(ST_SetSRID(w.geom,4326)::geography, p.g::geography, ${STREAM_BUFFER_M})
    UNION ALL
    SELECT ST_Intersection(ST_SetSRID(a.geom,4326), p.g)
      FROM water_areas a, parcel p WHERE a.geom && p.g AND ST_Intersects(ST_SetSRID(a.geom,4326), p.g)
    UNION ALL
    SELECT ST_Intersection(ST_SetSRID(n.geom,4326), p.g)
      FROM natural_areas n, parcel p WHERE n.geom && p.g AND n.fclass = ANY(${TERRAIN_ARR}) AND ST_Intersects(ST_SetSRID(n.geom,4326), p.g)
    UNION ALL
    SELECT ST_Intersection(ST_SetSRID(pr.geom,4326), p.g)
      FROM protected_areas pr, parcel p WHERE pr.geom && p.g AND ST_Intersects(ST_SetSRID(pr.geom,4326), p.g)
  ),
  nogo AS (
    SELECT ST_UnaryUnion(ST_Collect(ST_MakeValid(g))) AS n
    FROM comp WHERE g IS NOT NULL AND NOT ST_IsEmpty(g)
  )`

const EMPTY_GEOM = `ST_GeomFromText('POLYGON EMPTY',4326)`

/**
 * Stage 1 — compute verified site facts for a parcel. Returns null if the
 * parcel is not found (caller → 404) or the layer is not allowlisted.
 */
async function buildSiteContext(pg, { layer, fid }) {
  const table = parcelTable(layer)
  if (!table) return null
  const id = Number(fid)
  if (!Number.isInteger(id)) return null

  const parcelCte = `WITH parcel AS (SELECT ST_MakeValid(ST_SetSRID(geom,4326)) AS g, ST_SetSRID(geom,4326) AS raw, name FROM "${table}" WHERE fid = $1)`

  // Q1 — parcel facts (+ npoints for the complexity guard, +raw validity).
  const facts = await pg.query(
    `${parcelCte}
     SELECT name,
       ST_Area(g::geography)/10000              AS area_ha,
       ST_Perimeter(g::geography)               AS perimeter_m,
       ST_NPoints(g)                            AS npoints,
       ST_IsValid(raw)                          AS raw_valid,
       ST_AsGeoJSON(ST_PointOnSurface(g),5)     AS centroid,
       ST_AsGeoJSON(ST_SimplifyPreserveTopology(g, ${SIMPLIFY_CASE}),5) AS boundary
     FROM parcel`, [id])
  if (!facts.rows.length) return null
  const f = facts.rows[0]
  const complexity = Number(f.npoints) > COMPLEXITY_NPOINTS ? 'high' : 'normal'

  const [roads, streams, overlays, landuse, buildings, settlements, amenities, nogoRow] = await Promise.all([
    pg.query(
      `${parcelCte}
       SELECT r.fid, r.name, r.fclass, r.ref,
         ST_Length(ST_Intersection(ST_SetSRID(r.geom,4326), p.g)::geography) AS length_in_m,
         ST_AsGeoJSON(ST_Intersection(ST_CollectionExtract(ST_SetSRID(r.geom,4326),2), ST_Boundary(p.g)),5) AS entry
       FROM roads r, parcel p
       WHERE r.geom && p.g AND ST_Intersects(ST_SetSRID(r.geom,4326), p.g)
       ORDER BY length_in_m DESC LIMIT 40`, [id]),
    pg.query(
      `${parcelCte}
       SELECT w.fid, w.name, w.fclass,
         ST_Length(ST_Intersection(ST_SetSRID(w.geom,4326), p.g)::geography) AS length_in_m
       FROM waterways w, parcel p
       WHERE w.geom && p.g AND ST_Intersects(ST_SetSRID(w.geom,4326), p.g)
       ORDER BY length_in_m DESC LIMIT 40`, [id]),
    pg.query(
      `${parcelCte}
       SELECT src, fclass, SUM(ST_Area(ST_Intersection(ST_SetSRID(s.g,4326), p.g)::geography))/10000 AS area_ha
       FROM (
         SELECT 'water'::text src, fclass, geom g FROM water_areas WHERE geom && (SELECT g FROM parcel)
         UNION ALL SELECT 'protected', fclass, geom FROM protected_areas WHERE geom && (SELECT g FROM parcel)
         UNION ALL SELECT 'terrain', fclass, geom FROM natural_areas WHERE fclass = ANY(${TERRAIN_ARR}) AND geom && (SELECT g FROM parcel)
       ) s, parcel p
       WHERE ST_Intersects(ST_SetSRID(s.g,4326), p.g)
       GROUP BY src, fclass ORDER BY area_ha DESC`, [id]),
    pg.query(
      `${parcelCte}
       SELECT l.fclass, SUM(ST_Area(ST_Intersection(ST_SetSRID(l.geom,4326), p.g)::geography))/10000 AS area_ha
       FROM landuse l, parcel p
       WHERE l.geom && p.g AND ST_Intersects(ST_SetSRID(l.geom,4326), p.g)
       GROUP BY l.fclass ORDER BY area_ha DESC LIMIT 20`, [id]),
    pg.query(
      `${parcelCte}
       SELECT count(*)::int AS n,
         COALESCE(SUM(ST_Area(ST_Intersection(ST_SetSRID(b.geom,4326), p.g)::geography)),0) AS total_sqm,
         COALESCE(AVG(ST_Area(ST_Intersection(ST_SetSRID(b.geom,4326), p.g)::geography)),0) AS avg_sqm
       FROM buildings b, parcel p
       WHERE b.geom && p.g AND ST_Intersects(ST_SetSRID(b.geom,4326), p.g)`, [id]),
    pg.query(
      `${parcelCte}
       SELECT pp.name, pp.fclass, pp.population,
         ST_Distance(ST_SetSRID(pp.geom,4326)::geography, p.g::geography)/1000 AS dist_km
       FROM places_points pp, parcel p
       WHERE pp.geom && ST_Expand(p.g, 0.15)
         AND ST_DWithin(ST_SetSRID(pp.geom,4326)::geography, p.g::geography, ${SETTLEMENT_RADIUS_M})
       ORDER BY dist_km ASC LIMIT 10`, [id]),
    pg.query(
      `${parcelCte}
       SELECT CASE WHEN po.fclass = ANY(${SCHOOL_ARR}) THEN 'school' ELSE 'health' END AS kind,
         po.name, po.fclass,
         ST_Distance(ST_SetSRID(po.geom,4326)::geography, p.g::geography)/1000 AS dist_km
       FROM pois_points po, parcel p
       WHERE po.geom && ST_Expand(p.g, 0.15)
         AND (po.fclass = ANY(${SCHOOL_ARR}) OR po.fclass = ANY(${HEALTH_ARR}))
         AND ST_DWithin(ST_SetSRID(po.geom,4326)::geography, p.g::geography, ${AMENITY_RADIUS_M})
       ORDER BY dist_km ASC LIMIT 20`, [id]),
    pg.query(
      `${parcelCte}, ${NOGO_CTE}
       SELECT ST_AsGeoJSON(ST_SimplifyPreserveTopology(COALESCE(n, ${EMPTY_GEOM}), ${SIMPLIFY_CASE}),5) AS nogo,
         ST_Area(ST_Difference((SELECT g FROM parcel), COALESCE(n, ${EMPTY_GEOM}))::geography)/10000 AS developable_ha
       FROM nogo`, [id]),
  ])

  const num = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100)
  const schools = [], health = []
  for (const a of amenities.rows) (a.kind === 'school' ? schools : health).push({ name: a.name, fclass: a.fclass, distKm: num(a.dist_km) })

  return {
    parcel: {
      layer, fid: id, name: f.name || null,
      areaHa: num(f.area_ha), perimeterM: num(f.perimeter_m),
      centroid: parseGeo(f.centroid)?.coordinates || null,
      boundary: parseGeo(f.boundary),
      complexity, rawValid: f.raw_valid,
    },
    developableHa: num(nogoRow.rows[0].developable_ha),
    roads: roads.rows.map(r => ({
      fid: r.fid, name: r.name, fclass: r.fclass, ref: r.ref,
      lengthInParcelM: num(r.length_in_m),
      entryPoints: pointsFromGeo(parseGeo(r.entry)),
    })),
    water: {
      streams: streams.rows.map(s => ({ fid: s.fid, name: s.name, fclass: s.fclass, lengthInParcelM: num(s.length_in_m) })),
      waterAreas: overlays.rows.filter(o => o.src === 'water').map(o => ({ fclass: o.fclass, areaHa: num(o.area_ha) })),
    },
    terrain: overlays.rows.filter(o => o.src === 'terrain').map(o => ({ fclass: o.fclass, areaHa: num(o.area_ha) })),
    protected: overlays.rows.filter(o => o.src === 'protected').map(o => ({ fclass: o.fclass, areaHa: num(o.area_ha) })),
    landuse: landuse.rows.map(l => ({ fclass: l.fclass, areaHa: num(l.area_ha) })),
    buildings: {
      count: buildings.rows[0].n,
      totalAreaSqm: num(buildings.rows[0].total_sqm),
      avgFootprintSqm: num(buildings.rows[0].avg_sqm),
    },
    settlements: settlements.rows.map(s => ({ name: s.name, fclass: s.fclass, population: s.population, distKm: num(s.dist_km) })),
    amenities: { schools, health },
    nogo: parseGeo(nogoRow.rows[0].nogo),
  }
}

/**
 * Stage 3 grounding — the minimal authoritative geometry the Llama prompt needs:
 * the parcel boundary, the road entry points it must connect to, and the no-go
 * polygons it must avoid. Refetched server-side; never trust client geometry.
 */
async function getParcelGrounding(pg, { layer, fid }) {
  const table = parcelTable(layer)
  if (!table) return null
  const id = Number(fid)
  if (!Number.isInteger(id)) return null
  const parcelCte = `WITH parcel AS (SELECT ST_MakeValid(ST_SetSRID(geom,4326)) AS g FROM "${table}" WHERE fid = $1)`

  const [boundary, entries, nogoRow] = await Promise.all([
    pg.query(`${parcelCte} SELECT ST_AsGeoJSON(ST_SimplifyPreserveTopology(g, ${SIMPLIFY_CASE}),5) AS b, ST_NPoints(g) AS npoints FROM parcel`, [id]),
    pg.query(
      `${parcelCte}
       SELECT ST_AsGeoJSON(ST_Intersection(ST_CollectionExtract(ST_SetSRID(r.geom,4326),2), ST_Boundary(p.g)),5) AS entry
       FROM roads r, parcel p WHERE r.geom && p.g AND ST_Intersects(ST_SetSRID(r.geom,4326), p.g)`, [id]),
    pg.query(
      `${parcelCte}, ${NOGO_CTE}
       SELECT ST_AsGeoJSON(ST_SimplifyPreserveTopology(COALESCE(n, ${EMPTY_GEOM}), ${SIMPLIFY_CASE}),5) AS nogo FROM nogo`, [id]),
  ])
  if (!boundary.rows.length) return null
  const entryPoints = []
  const seen = new Set()
  for (const e of entries.rows) pointsFromGeo(parseGeo(e.entry), entryPoints, seen)
  return {
    parcel: parseGeo(boundary.rows[0].b),
    entryPoints,
    nogo: parseGeo(nogoRow.rows[0].nogo),
  }
}

/**
 * Stage 3 output — launder an LLM draft against the authoritative parcel + nogo.
 * Zones are clipped to (parcel − nogo); roads are clipped to the parcel and
 * their endpoints snapped to the boundary. Anything empty, out of bounds, or
 * below the size/length floor is dropped WITH a reason. This is the guarantee
 * that no hallucinated geometry reaches the map.
 *
 * @returns {{roads:Array, zones:Array, notes:string[], dropped:{roads:Array,zones:Array}}}
 */
async function postProcessDraft(pg, { layer, fid, draft }) {
  const table = parcelTable(layer)
  if (!table) return null
  const id = Number(fid)
  if (!Number.isInteger(id)) return null

  const inZones = Array.isArray(draft?.zones) ? draft.zones : []
  const inRoads = Array.isArray(draft?.roads) ? draft.roads : []
  const zoneGj = inZones.map(z => JSON.stringify(z.geom || {}))
  const roadGj = inRoads.map(r => JSON.stringify(r.geom || {}))

  const parcelCte = `WITH parcel AS (SELECT ST_MakeValid(ST_SetSRID(geom,4326)) AS g FROM "${table}" WHERE fid = $1)`

  const zoneRows = zoneGj.length ? (await pg.query(
    `${parcelCte}, ${NOGO_CTE},
     dev AS (SELECT ST_Difference((SELECT g FROM parcel), COALESCE((SELECT n FROM nogo), ${EMPTY_GEOM})) AS d)
     SELECT z.idx,
       ST_AsGeoJSON(ST_CollectionExtract(ST_Intersection((SELECT d FROM dev), ST_MakeValid(ST_GeomFromGeoJSON(z.gj))),3),6) AS clipped,
       ST_Area(ST_MakeValid(ST_GeomFromGeoJSON(z.gj))::geography)/10000 AS orig_ha,
       ST_Area(ST_CollectionExtract(ST_Intersection((SELECT d FROM dev), ST_MakeValid(ST_GeomFromGeoJSON(z.gj))),3)::geography)/10000 AS clip_ha
     FROM unnest($2::text[]) WITH ORDINALITY AS z(gj, idx)`, [id, zoneGj])).rows : []

  // Clip → snap endpoints to the boundary → re-clip to the parcel. The final
  // re-clip is essential: snapping to the boundary can bulge a chord outside a
  // concave parcel, which would break the "everything inside" guarantee.
  const roadRows = roadGj.length ? (await pg.query(
    `${parcelCte}
     SELECT idx, ST_AsGeoJSON(final, 6) AS snapped, ST_Length(final::geography) AS len_m
     FROM (
       SELECT r.idx,
         ST_CollectionExtract(ST_Intersection((SELECT g FROM parcel),
           ST_LineMerge(ST_Snap(
             ST_CollectionExtract(ST_Intersection((SELECT g FROM parcel), ST_MakeValid(ST_GeomFromGeoJSON(r.gj))),2),
             ST_Boundary((SELECT g FROM parcel)), ${SNAP_TOL_DEG}))), 2) AS final
       FROM unnest($2::text[]) WITH ORDINALITY AS r(gj, idx)
     ) s`, [id, roadGj])).rows : []

  const notes = Array.isArray(draft?.notes) ? draft.notes.map(String).slice(0, 8) : []
  const dropped = { roads: [], zones: [] }

  const zones = []
  for (const row of zoneRows) {
    const src = inZones[row.idx - 1] || {}
    const geom = parseGeo(row.clipped)
    const clipHa = Number(row.clip_ha) || 0
    if (!geom) { dropped.zones.push({ use: src.use, reason: 'out_of_bounds' }); continue }
    if (clipHa < MIN_ZONE_HA) { dropped.zones.push({ use: src.use, reason: 'too_small' }); continue }
    if (Number(row.orig_ha) > 0 && clipHa / Number(row.orig_ha) < HEAVY_CLIP_RATIO)
      notes.push(`Zone ${row.idx} (${src.use || 'zone'}) was clipped heavily by constraints.`)
    zones.push({ use: src.use || 'single_residential', geom })
  }

  const roads = []
  for (const row of roadRows) {
    const src = inRoads[row.idx - 1] || {}
    const geom = parseGeo(row.snapped)
    const lenM = Number(row.len_m) || 0
    if (!geom) { dropped.roads.push({ name: src.name, reason: 'out_of_bounds' }); continue }
    if (lenM < MIN_ROAD_M) { dropped.roads.push({ name: src.name, reason: 'too_short' }); continue }
    roads.push({ hierarchy: src.hierarchy || 'local', widthM: src.widthM || 15, name: src.name, geom })
  }

  return { roads, zones, notes: notes.slice(0, 12), dropped }
}

module.exports = {
  buildSiteContext,
  getParcelGrounding,
  postProcessDraft,
  // exported for tests / introspection
  _internals: { parcelTable, pointsFromGeo, sqlTextArray, PARCEL_LAYERS, ROUGH_TERRAIN_FCLASS },
}
