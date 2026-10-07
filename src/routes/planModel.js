/**
 * Plan model — read-only view of authorities, plan profiles and plan instruments.
 *
 *   GET /api/authorities       every authority (rural, urban, combination), with the
 *                              current members of each combination authority
 *   GET /api/plan-profiles     the reusable profiles (rural, urban) and their template plans
 *   GET /api/plans             plan instruments; filter with ?authority=<code>,
 *                              ?profile=<code>, ?template=true|false
 *   GET /api/plans/:id/diff    how a plan differs from the template it was adopted from, or
 *                              (?against=previous | <plan id>) from its previous version or another plan
 *   GET /api/plans/:a/compare/:b  two plans side by side by reference class: where they
 *                              overlap and which classes only one of them covers
 *   GET /api/plans/:id/crosswalk  each zone type and land use of a plan with the reference
 *                              (INSPIRE HILUCS) classes it is mapped to
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
    LEFT JOIN plan_instrument_summary t ON t.profile_code = p.code AND t.is_default_template
   ORDER BY p.kind`

// Local codes stay local; this is how they relate to a shared reference classification.
// Rows are 'proposed' until someone confirms them.
const CROSSWALK_SQL = `
  SELECT 'zone_type' AS kind, t.code, t.name AS label, k.scheme, k.code AS class_code,
         c.label AS class_label, k.relation, k.status
    FROM plan_zone_type t
    LEFT JOIN plan_zone_type_class k ON k.plan_zone_type_id = t.id
    LEFT JOIN reference_classification c ON c.scheme = k.scheme AND c.code = k.code
   WHERE t.plan_instrument_id = $1
  UNION ALL
  SELECT 'land_use', g.group_code, g.description, k.scheme, k.code, c.label, k.relation, k.status
    FROM land_use_groups g
    LEFT JOIN land_use_group_class k ON k.land_use_group_id = g.id
    LEFT JOIN reference_classification c ON c.scheme = k.scheme AND c.code = k.code
   WHERE g.plan_instrument_id = $1 AND g.is_active
   ORDER BY 1, 2, 5`

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

  // A plan adopted from a template is a complete copy; this lists every cell where the copy
  // has since changed (changed / added / removed), so drift from the template is visible.
  fastify.get('/plans/:id/diff', async (request, reply) => {
    const { id } = request.params
    if (!UUID_RE.test(id)) return reply.code(400).send({ success: false, error: 'plan id must be a uuid' })
    try {
      const against = (request.query || {}).against
      if (against !== undefined && against !== 'previous' && against !== 'template' && !UUID_RE.test(against)) {
        return reply.code(400).send({ success: false, error: 'against must be previous, template or a plan id' })
      }
      const { rows: plan } = await fastify.pg.query(
        'SELECT id, title, derived_from_id, supersedes_id FROM plan_instrument WHERE id = $1', [id])
      if (!plan.length) return reply.code(404).send({ success: false, error: 'Unknown plan' })
      const p = plan[0]

      // What to compare with: the template by default, else the previous version.
      let baseId = null
      let kind = null
      if (against === undefined || against === 'template') { baseId = p.derived_from_id; kind = 'template' }
      if (against === 'previous' || (against === undefined && !baseId)) { baseId = p.supersedes_id; kind = 'previous' }
      if (against && UUID_RE.test(against)) {
        const { rows: other } = await fastify.pg.query('SELECT id FROM plan_instrument WHERE id = $1', [against])
        if (!other.length) return reply.code(404).send({ success: false, error: 'Unknown plan to compare with' })
        baseId = against
        kind = 'plan'
      }
      if (!baseId) {
        return { success: true, count: 0, data: { plan_id: id, title: p.title, template_id: p.derived_from_id, against_id: null, changes: [], note: 'This plan was not adopted from a template and has no previous version.' } }
      }
      const { rows } = kind === 'template'
        ? await fastify.pg.query('SELECT * FROM plan_diff($1)', [id])
        : await fastify.pg.query('SELECT * FROM plan_decision_diff($1, $2)', [baseId, id])
      // Same field names whichever the comparison: from_/to_ always, template_/plan_ kept for older readers.
      const changes = rows.map((r) => ({
        zone_type_code: r.zone_type_code, land_use_code: r.land_use_code,
        from_decision: r.from_decision ?? r.template_decision, to_decision: r.to_decision ?? r.plan_decision,
        template_decision: r.template_decision ?? r.from_decision, plan_decision: r.plan_decision ?? r.to_decision,
        change: r.change,
      }))
      return { success: true, count: changes.length, data: { plan_id: id, title: p.title, template_id: p.derived_from_id, against_id: baseId, against: kind, changes } }
    } catch (err) {
      request.log.error({ err }, 'plan diff failed')
      return reply.code(500).send({ success: false, error: 'Failed to compute the plan diff' })
    }
  })

  fastify.get('/plans/:id/crosswalk', async (request, reply) => {
    const { id } = request.params
    if (!UUID_RE.test(id)) return reply.code(400).send({ success: false, error: 'plan id must be a uuid' })
    try {
      const { rows: plan } = await fastify.pg.query('SELECT id, title FROM plan_instrument WHERE id = $1', [id])
      if (!plan.length) return reply.code(404).send({ success: false, error: 'Unknown plan' })
      const { rows } = await fastify.pg.query(CROSSWALK_SQL, [id])
      return { success: true, count: rows.length, data: { plan_id: id, title: plan[0].title, rows } }
    } catch (err) {
      request.log.error({ err }, 'plan crosswalk failed')
      return reply.code(500).send({ success: false, error: 'Failed to read the plan crosswalk' })
    }
  })

  fastify.get('/plans/:a/compare/:b', async (request, reply) => {
    const { a, b } = request.params
    if (!UUID_RE.test(a) || !UUID_RE.test(b)) return reply.code(400).send({ success: false, error: 'plan ids must be uuids' })
    try {
      const { rows: found } = await fastify.pg.query('SELECT id, title FROM plan_instrument WHERE id = ANY($1::uuid[])', [[a, b]])
      if (found.length < (a === b ? 1 : 2)) return reply.code(404).send({ success: false, error: 'Unknown plan' })
      const { rows } = await fastify.pg.query('SELECT * FROM plan_compare($1, $2)', [a, b])
      const title = (id) => found.find((f) => f.id === id).title
      return { success: true, count: rows.length, data: { a: { id: a, title: title(a) }, b: { id: b, title: title(b) }, classes: rows } }
    } catch (err) {
      request.log.error({ err }, 'plan compare failed')
      return reply.code(500).send({ success: false, error: 'Failed to compare the plans' })
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

module.exports = { planModelRoutes, plansQuery, AUTHORITIES_SQL, PROFILES_SQL, CROSSWALK_SQL }
