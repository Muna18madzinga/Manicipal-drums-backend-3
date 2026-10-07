/**
 * Plan model — read-only view of authorities, plan profiles and plan instruments.
 *
 *   GET /api/authorities       every authority (rural, urban, combination), with the
 *                              current members of each combination authority
 *   GET /api/plan-profiles     the reusable profiles (rural, urban) and their template plans
 *   GET /api/plans             plan instruments; filter with ?authority=<code>,
 *                              ?profile=<code>, ?template=true|false
 *
 * Public, like the zone and matrix endpoints: authorities and the plans they
 * operate under are published planning information. Contact details are not
 * returned here. Writes arrive in a later phase.
 * See docs/architecture/02-data-model-proposal.md.
 */

const AUTHORITIES_SQL = `
  SELECT a.id, a.code, a.authority_name AS name, a.kind, a.authority_type, a.province,
         COALESCE(
           json_agg(json_build_object(
                      'id', m.id, 'code', m.code, 'name', m.authority_name,
                      'kind', m.kind, 'valid_from', am.valid_from, 'valid_to', am.valid_to)
                    ORDER BY m.authority_name) FILTER (WHERE m.id IS NOT NULL),
           '[]'::json) AS members,
         (SELECT COUNT(*) FROM plan_instrument i WHERE i.authority_id = a.id)::int AS plans
    FROM local_authorities a
    LEFT JOIN authority_member am
           ON am.combination_id = a.id AND (am.valid_to IS NULL OR am.valid_to >= CURRENT_DATE)
    LEFT JOIN local_authorities m ON m.id = am.member_id
   WHERE a.is_active
   GROUP BY a.id
   ORDER BY a.authority_name`

const PROFILES_SQL = `
  SELECT p.code, p.name, p.kind, p.description, p.status, p.version,
         t.id AS template_plan_id, t.title AS template_title,
         COALESCE(t.zone_types, 0) AS zone_types,
         COALESCE(t.land_uses, 0)  AS land_uses,
         COALESCE(t.decisions, 0)  AS decisions,
         (SELECT COUNT(*) FROM plan_instrument i
           WHERE i.profile_id = (SELECT id FROM plan_profile WHERE code = p.code) AND NOT i.is_template)::int
           AS plans_using_profile
    FROM plan_profile p
    LEFT JOIN plan_instrument_summary t ON t.profile_code = p.code AND t.is_template
   ORDER BY p.kind`

/** Build the plans query from the optional filters, with bound parameters. */
function plansQuery({ authority, profile, template }) {
  const where = []
  const params = []
  if (authority) { params.push(String(authority).toUpperCase()); where.push(`authority_code = $${params.length}`) }
  if (profile) { params.push(String(profile).toLowerCase()); where.push(`profile_code = $${params.length}`) }
  if (template === 'true' || template === 'false') { params.push(template === 'true'); where.push(`is_template = $${params.length}`) }
  return {
    sql: `SELECT * FROM plan_instrument_summary
           ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
           ORDER BY is_template DESC, authority_name NULLS FIRST, title, version`,
    params,
  }
}

async function planModelRoutes(fastify) {
  fastify.get('/authorities', async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(AUTHORITIES_SQL)
      return { success: true, count: rows.length, data: rows }
    } catch (err) {
      request.log.error({ err }, 'list authorities failed')
      return reply.code(500).send({ success: false, error: 'Failed to list authorities' })
    }
  })

  fastify.get('/plan-profiles', async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(PROFILES_SQL)
      return { success: true, count: rows.length, data: rows }
    } catch (err) {
      request.log.error({ err }, 'list plan profiles failed')
      return reply.code(500).send({ success: false, error: 'Failed to list plan profiles' })
    }
  })

  fastify.get('/plans', async (request, reply) => {
    try {
      const { sql, params } = plansQuery(request.query || {})
      const { rows } = await fastify.pg.query(sql, params)
      return { success: true, count: rows.length, data: rows }
    } catch (err) {
      request.log.error({ err }, 'list plans failed')
      return reply.code(500).send({ success: false, error: 'Failed to list plans' })
    }
  })
}

module.exports = { planModelRoutes, plansQuery, AUTHORITIES_SQL, PROFILES_SQL }
