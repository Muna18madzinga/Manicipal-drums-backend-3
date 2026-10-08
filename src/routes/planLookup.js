/**
 * Plan lookup: "what can I build here?" for a member of the public.
 *
 *   GET /api/plan-lookup/search?q=<stand number or farm name>   the parcels that match (public, name and place only)
 *   GET /api/plan-lookup/:layer/:id                             the zone and what the plan says is permitted there
 *
 * Public. What a caller sees follows the plan's visibility (migration 154): the public sees a plan only once it is
 * gazetted, signed-in staff also see their own authority's drafts. So a draft is never shown to the public, and when
 * staff preview one it is marked provisional (migration 161). "Not published" is the answer for a parcel that is in no
 * zone and for one whose plan is not yet public alike, so the page cannot be used to learn what is in preparation.
 *
 * Reads only. Nothing here decides anything: it reports the plan's own words (a null decision is "not decided",
 * never "allowed") and says it is information, not permission.
 */
const { optionalAuth } = require('../middleware/jwtAuth')
const { tenantPool } = require('../lib/tenancy')
const { parseParcelRef, PARCEL_LAYERS } = require('../utils/ruleSnapshot')
const { ZONE_USES_SQL } = require('../utils/zoneUses')

const MAX_Q = 64
const NOTICE = 'This is what the plan says about this land. It is information, not a permit or a decision. '
  + 'Every application is assessed by the council\'s planner.'

/** A search term: letters, digits and the punctuation a stand number or farm name carries. */
function parseQuery(q) {
  if (typeof q !== 'string') return null
  const t = q.trim().replace(/\s+/g, ' ')
  if (t.length < 2 || t.length > MAX_Q) return null
  return /^[\p{L}\p{N} .,'/&()#-]+$/u.test(t) ? t : null
}

const like = (t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`

async function planLookupRoutes(fastify) {
  const pg = fastify.pg
  const limit = { rateLimit: { max: 60, timeWindow: '1 minute' } }

  // Public cadastre names only: the same attributes the public map tiles show. Never ownership or price.
  fastify.get('/plan-lookup/search', { config: limit, preHandler: optionalAuth(fastify) }, async (request, reply) => {
    const q = parseQuery((request.query || {}).q)
    if (!q) return reply.code(400).send({ success: false, error: 'bad_query', message: 'Enter at least two letters or digits of a stand number or farm name.' })
    try {
      const parcels = await pg.query(
        `SELECT 'vungu_parcels' AS layer, fid::text AS id, COALESCE(NULLIF(name, ''), name_cfu, 'Parcel ' || fid) AS label,
                district AS place, NULLIF(area_ha::text, '')::numeric AS area_ha
           FROM vungu_parcels
          WHERE geom IS NOT NULL AND (name ILIKE $1 ESCAPE '\\' OR name_cfu ILIKE $1 ESCAPE '\\')
          ORDER BY (LOWER(name) = LOWER($2)) DESC, label LIMIT 8`, [like(q), q])
      const stands = await pg.query(
        `SELECT 'stands' AS layer, id::text AS id, stand_number AS label, ward AS place, ROUND(area_sqm / 10000.0, 4) AS area_ha
           FROM stands
          WHERE stand_number ILIKE $1 ESCAPE '\\'
          ORDER BY (LOWER(stand_number) = LOWER($2)) DESC, stand_number LIMIT 8`, [like(q), q])
      const data = [...stands.rows, ...parcels.rows].slice(0, 8).map((r) => ({
        layer: r.layer, id: r.id, label: r.label, place: r.place || null, area_ha: r.area_ha === null ? null : Number(r.area_ha),
      }))
      return { success: true, count: data.length, data }
    } catch (err) {
      request.log.error({ err }, 'plan lookup search failed')
      return reply.code(500).send({ success: false, error: 'internal', message: 'The search could not be completed.' })
    }
  })

  fastify.get('/plan-lookup/:layer/:id', { config: limit, preHandler: optionalAuth(fastify) }, async (request, reply) => {
    const ref = parseParcelRef(request.params.layer, request.params.id)
    if (!ref) return reply.code(400).send({ success: false, error: 'bad_parcel', message: `The parcel must be one of ${PARCEL_LAYERS.join(', ')}.` })
    const db = tenantPool(pg, request.user)
    try {
      const found = (await db.query('SELECT parcel_geometry($1, $2) IS NOT NULL AS found', [ref.layer, ref.id])).rows[0].found
      if (!found) return reply.code(404).send({ success: false, error: 'not_found', message: 'That parcel could not be found.' })

      const label = await parcelLabel(pg, ref)
      const zones = (await db.query(
        `SELECT pz.zone_id, pz.zone_name, pz.share_pct, pz.is_governing AS governing,
                i.id AS plan_id, i.title AS plan_title, i.version AS plan_version, i.status AS plan_status,
                i.gazette_ref, i.effective_from, a.authority_name,
                plan_is_provisional(i.status) AS provisional,
                t.code AS zone_type_code, t.review_status, t.reviewed_by,
                (SELECT COUNT(*)::int FROM land_use_groups g WHERE g.plan_instrument_id = i.id AND g.is_active) AS uses_in_plan
           FROM parcel_zoning_for($1, $2) pz
           JOIN plan_instrument i ON i.id = pz.plan_instrument_id
           LEFT JOIN local_authorities a ON a.id = i.authority_id
           LEFT JOIN plan_zone_type t ON t.id = pz.plan_zone_type_id
          ORDER BY pz.is_governing DESC, pz.share_pct DESC NULLS LAST, pz.zone_id`, [ref.layer, ref.id])).rows

      const results = []
      for (const z of zones) {
        const rows = (await db.query(ZONE_USES_SQL, [z.zone_id])).rows
        const group = (type) => rows.filter((r) => r.control_type === type)
          .map((r) => ({ code: r.group_code, description: r.group_description, category: r.group_category, conditions: r.conditions || null }))
        const permitted = group('permitted'), special = group('special_consent'), prohibited = group('prohibited')
        results.push({
          governing: z.governing, share_pct: z.share_pct === null ? null : Number(z.share_pct),
          plan: {
            id: z.plan_id, title: z.plan_title, version: z.plan_version, status: z.plan_status, authority: z.authority_name,
            gazette_ref: z.gazette_ref, effective_from: z.effective_from, provisional: z.provisional,
          },
          zone: { id: z.zone_id, name: z.zone_name, type_code: z.zone_type_code, review_status: z.review_status, reviewed_by: z.reviewed_by },
          uses: { permitted, special_consent: special, prohibited },
          not_decided: Math.max(0, z.uses_in_plan - permitted.length - special.length - prohibited.length),
        })
      }
      return {
        success: true,
        data: {
          parcel: { layer: ref.layer, id: ref.id, ...label },
          // "published" means a plan the caller may see covers the parcel. For the public that is a gazetted plan.
          published: results.length > 0,
          provisional: results.some((r) => r.plan.provisional),
          results,
          notice: NOTICE,
        },
      }
    } catch (err) {
      request.log.error({ err }, 'plan lookup failed')
      return reply.code(500).send({ success: false, error: 'internal', message: 'The lookup could not be completed.' })
    }
  })
}

/** The parcel's public name and place. */
async function parcelLabel(pg, ref) {
  if (ref.layer === 'vungu_parcels') {
    const r = await pg.query(`SELECT COALESCE(NULLIF(name, ''), name_cfu, 'Parcel ' || fid) AS label, district AS place, NULLIF(area_ha::text, '')::numeric AS area_ha
                                FROM vungu_parcels WHERE fid::text = $1`, [ref.id])
    return r.rows[0] ? { label: r.rows[0].label, place: r.rows[0].place || null, area_ha: r.rows[0].area_ha === null ? null : Number(r.rows[0].area_ha) } : { label: null, place: null, area_ha: null }
  }
  if (ref.layer === 'stands') {
    const r = await pg.query('SELECT stand_number AS label, ward AS place, ROUND(area_sqm / 10000.0, 4) AS area_ha FROM stands WHERE id::text = $1', [ref.id])
    return r.rows[0] ? { label: r.rows[0].label, place: r.rows[0].place || null, area_ha: r.rows[0].area_ha === null ? null : Number(r.rows[0].area_ha) } : { label: null, place: null, area_ha: null }
  }
  return { label: null, place: null, area_ha: null }
}

module.exports = { planLookupRoutes, parseQuery, NOTICE }
