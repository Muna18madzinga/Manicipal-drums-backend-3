/**
 * What is already on the ground around a surveyor's work: the register's parcels near a place, as PUBLIC facts a surveyor needs to see.
 *
 * The register holds farms (digitised from maps, indicative), stands the Surveyor-General has approved, and stands a council has surveyed and
 * is waiting to have approved. A surveyor laying out a township needs to see all three, and to be told how far to trust each: an outline
 * digitised from a map can be tens of metres from where the beacons are, and nobody should set out from it. So every feature says what kind of
 * thing it is (`quality`) and, for the indicative ones, how far out it may be.
 *
 * Public fields ONLY, the same a citizen sees on the public portal: parcel id, stand number, township, kind, status, the Surveyor-General's
 * reference, the survey class and basis, the area, the farm number, the council. Never owners, ERP accounts, revenue bands or zoning.
 *
 * Geometry is returned in the survey system the surveyor works in (a Cape / Lo belt, the registry's own SRID for it), with the westing as X and
 * the southing as Y, exactly as SurveyPro keeps its own coordinates, so a layer is placed by the SAME transformation as the surveyor's own work.
 * The area asked for is capped (this is context around a job, not a way to download the register).
 *
 * Read-only. docs/HARMONIZATION-SCOPE.md, piece A2.
 */

const LO_ZONES = [25, 27, 29, 31, 33]
const MAX_SIDE_M = 6000          // a search window may not be wider or taller than this, buffer included
const MAX_RADIUS_M = 3000
const MAX_BUFFER_M = 1000
const DEFAULT_BUFFER_M = 250
const MAX_FEATURES = 1500

class ContextError extends Error {
  constructor(code, message, status = 422) { super(message); this.code = code; this.status = status }
}

/** How much to trust a parcel's outline, from what the register knows of how it was made. */
function qualityOf(p) {
  if (p.sg_ref || (p.accuracy_basis === 'general_plan' && p.origin === 'custodian')) return 'approved'
  if (p.origin === 'authority' && p.accuracy_basis === 'surveyed') return 'council_survey'
  return 'indicative'
}

/** Check the question before asking the database anything. Returns the cleaned area. */
function readArea(body) {
  const zone = Number(body.lo_zone)
  if (!LO_ZONES.includes(zone)) throw new ContextError('bad_zone', `lo_zone must be one of ${LO_ZONES.join(', ')}`)
  const buffer = body.buffer_m == null ? DEFAULT_BUFFER_M : Number(body.buffer_m)
  if (!Number.isFinite(buffer) || buffer < 0 || buffer > MAX_BUFFER_M) throw new ContextError('bad_buffer', `buffer_m must be between 0 and ${MAX_BUFFER_M}`)
  const a = body.area || {}
  if (Array.isArray(a.bbox)) {
    const [w1, s1, w2, s2] = a.bbox.map(Number)
    if (![w1, s1, w2, s2].every(Number.isFinite)) throw new ContextError('bad_area', 'bbox must be four numbers: west, south, east, north in the zone')
    const bbox = [Math.min(w1, w2) - buffer, Math.min(s1, s2) - buffer, Math.max(w1, w2) + buffer, Math.max(s1, s2) + buffer]
    if (bbox[2] - bbox[0] > MAX_SIDE_M || bbox[3] - bbox[1] > MAX_SIDE_M) throw new ContextError('area_too_large', `the area (with its buffer) may be at most ${MAX_SIDE_M} m on a side`)
    return { zone, kind: 'bbox', bbox }
  }
  if (a.center && a.radius_m != null) {
    const lon = Number(a.center.lon), lat = Number(a.center.lat), r = Number(a.radius_m) + buffer
    if (![lon, lat].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new ContextError('bad_area', 'center needs a longitude and a latitude')
    if (!(r > 0) || r > MAX_RADIUS_M) throw new ContextError('area_too_large', `the radius (with its buffer) may be at most ${MAX_RADIUS_M} m`)
    return { zone, kind: 'circle', lon, lat, radius: r }
  }
  throw new ContextError('bad_area', 'give an area: { bbox: [west, south, east, north] } or { center: { lon, lat }, radius_m }')
}

/**
 * The register's parcels in the area. `client` is read-only. Returns { srid, lo_zone, truncated, features }, each feature
 * { type: 'Feature', properties, geometry } with the geometry in the zone's coordinates (westing, southing).
 */
async function contextParcels(client, body) {
  const area = readArea(body)
  const srid = (await client.query(`SELECT srid FROM gis_ops.crs_registry WHERE code = 'Lo' || $1::text AND is_survey`, [area.zone])).rows[0]?.srid
  if (!srid) throw new ContextError('zone_unknown', `the register has no Lo${area.zone} belt`, 409)

  const window = area.kind === 'bbox'
    ? ['ST_SetSRID(ST_MakeEnvelope($2, $3, $4, $5), $1::int)', [srid, ...area.bbox]]
    : ['ST_Buffer(ST_Transform(ST_SetSRID(ST_MakePoint($2, $3), 4326), $1::int), $4)', [srid, area.lon, area.lat, area.radius]]
  const { rows } = await client.query(
    `WITH w AS (SELECT ${window[0]} AS g)
     SELECT p.parcel_id, p.stand_no, p.township_code, p.parcel_kind, p.origin, p.status, p.sg_ref, p.survey_class, p.accuracy_basis,
            p.estimated_accuracy_m, p.transform_accuracy_m, p.area_m2, p.cadastre_ref, la.code AS authority_code,
            ST_AsGeoJSON(ST_Transform(p.geom_source, $1::int), 3)::json AS geometry
       FROM land.parcel p
       JOIN w ON p.geom_wgs84 && ST_Transform(w.g, 4326)
       LEFT JOIN public.local_authorities la ON la.id = p.authority_id
      WHERE p.status IN ('current', 'legacy') AND ST_Intersects(ST_Transform(p.geom_source, $1::int), w.g)
      ORDER BY p.parcel_id
      LIMIT ${MAX_FEATURES + 1}`, window[1])

  const truncated = rows.length > MAX_FEATURES
  const features = rows.slice(0, MAX_FEATURES).map((p) => {
    const quality = qualityOf(p)
    return {
      type: 'Feature',
      properties: {
        parcel_id: p.parcel_id, stand_no: p.stand_no, township_code: p.township_code, kind: p.parcel_kind, status: p.status, quality,
        origin: p.origin, sg_ref: p.sg_ref, survey_class: p.survey_class, basis: p.accuracy_basis, area_m2: p.area_m2 == null ? null : Number(p.area_m2),
        farm_ref: p.parcel_kind === 'farm' ? p.cadastre_ref : null, council: p.authority_code,
        // how far out an INDICATIVE outline may be; null where it is a survey
        indicative_m: quality === 'indicative' ? Number(p.estimated_accuracy_m ?? p.transform_accuracy_m ?? 0) || null : null,
      },
      geometry: p.geometry,
    }
  })
  return { srid, lo_zone: area.zone, truncated, features }
}

module.exports = { contextParcels, readArea, qualityOf, ContextError, MAX_SIDE_M, MAX_RADIUS_M, MAX_BUFFER_M, MAX_FEATURES, LO_ZONES }
