/**
 * Planning Assistant routes.
 *
 *   POST /api/planning-assistant/suggest
 *     Body: { standId? } | { lng, lat } [, purpose ]
 *     Returns the rules-engine suggestion: zone + template + flags.
 *
 *   POST /api/planning-assistant/decide
 *     Body: { standId, landUseGroupCode } | { lng, lat, landUseGroupCode }
 *     Returns one of permitted | special_consent | prohibited | unknown.
 *
 *   GET  /api/planning-assistant/templates
 *     Public read of the active templates (so the planner UI can show
 *     "what envelope would apply").
 *
 * Auth posture:
 *   - /suggest and /decide are useful to citizens (the citizen portal
 *     calls /suggest after picking a stand) and to staff. Public reads.
 *   - /templates is also public.
 *
 * Mutation of templates is admin-only and currently happens through DB
 * migrations; an admin UI is a follow-up turn.
 */

const planningAssistant = require('../services/planningAssistant')

const isString = (v, max = 255) =>
  typeof v === 'string' && v.length > 0 && v.length <= max
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v)

async function planningAssistantRoutes(fastify) {
  // ── Suggest a plan for a parcel ─────────────────────────────────────
  fastify.post('/planning-assistant/suggest', async (request, reply) => {
    try {
      const body = request.body || {}
      const standId = isString(body.standId) ? body.standId : null
      const lng = body.lng != null ? Number(body.lng) : null
      const lat = body.lat != null ? Number(body.lat) : null
      const purpose = isString(body.purpose, 64) ? body.purpose : undefined

      if (!standId && (!isFiniteNumber(lng) || !isFiniteNumber(lat))) {
        return reply.code(400).send({
          success: false,
          error: 'bad_request',
          message: 'Provide standId, or both lng and lat.',
        })
      }

      const result = await planningAssistant.suggestPlan(fastify.pg, {
        standId,
        lng,
        lat,
        purpose,
      })
      return reply.send({ success: true, data: result })
    } catch (err) {
      request.log.error({ err }, 'planning suggest failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Decision: is this use allowed here? ─────────────────────────────
  fastify.post('/planning-assistant/decide', async (request, reply) => {
    try {
      const body = request.body || {}
      const landUseGroupCode = isString(body.landUseGroupCode, 16) ? body.landUseGroupCode : null
      if (!landUseGroupCode) {
        return reply.code(400).send({
          success: false,
          error: 'bad_request',
          message: 'landUseGroupCode is required.',
        })
      }

      let zoneId = null
      if (isString(body.zoneId)) {
        zoneId = body.zoneId
      } else if (isString(body.standId)) {
        const stand = await planningAssistant.loadZoneByStand(fastify.pg, body.standId)
        zoneId = stand?.zone_id ?? null
      } else if (isFiniteNumber(Number(body.lng)) && isFiniteNumber(Number(body.lat))) {
        const zone = await planningAssistant.loadZoneByPoint(
          fastify.pg, Number(body.lng), Number(body.lat),
        )
        zoneId = zone?.id ?? null
      } else {
        return reply.code(400).send({
          success: false,
          error: 'bad_request',
          message: 'Provide zoneId, standId, or lng/lat.',
        })
      }

      const decision = await planningAssistant.decideUse(fastify.pg, {
        zoneId,
        landUseGroupCode,
      })
      return reply.send({ success: true, data: decision })
    } catch (err) {
      request.log.error({ err }, 'planning decide failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })

  // ── Templates listing (read-only) ───────────────────────────────────
  fastify.get('/planning-assistant/templates', async (request, reply) => {
    try {
      const { zoneType, scaleCategory, ward } = request.query || {}
      const params = []
      const where = ['is_active = true']
      if (isString(zoneType, 64))      { params.push(zoneType);     where.push(`zone_type = $${params.length}`) }
      if (isString(scaleCategory, 20)) { params.push(scaleCategory); where.push(`scale_category = $${params.length}`) }
      if (isString(ward, 64))          { params.push(ward);          where.push(`(ward = $${params.length} OR ward IS NULL)`) }

      const { rows } = await fastify.pg.query(
        `SELECT id, zone_type, scale_category, purpose, ward,
                display_name, description,
                min_area_sqm, max_area_sqm, min_frontage_m,
                max_plot_coverage_pct, max_floor_area_ratio,
                max_height_m, max_storeys,
                setback_front_m, setback_rear_m, setback_side_m,
                extras, source_citation
         FROM planning_assistant_templates
         WHERE ${where.join(' AND ')}
         ORDER BY zone_type, scale_category, purpose, ward NULLS LAST`,
        params,
      )

      return reply.send({
        success: true,
        data: rows.map(r => ({
          id:            r.id,
          zoneType:      r.zone_type,
          scaleCategory: r.scale_category,
          purpose:       r.purpose,
          ward:          r.ward,
          displayName:   r.display_name,
          description:   r.description,
          envelope: {
            minAreaSqm:         numOrNull(r.min_area_sqm),
            maxAreaSqm:         numOrNull(r.max_area_sqm),
            minFrontageM:       numOrNull(r.min_frontage_m),
            maxPlotCoveragePct: numOrNull(r.max_plot_coverage_pct),
            maxFloorAreaRatio:  numOrNull(r.max_floor_area_ratio),
            maxHeightM:         numOrNull(r.max_height_m),
            maxStoreys:         r.max_storeys,
            setbackFrontM:      numOrNull(r.setback_front_m),
            setbackRearM:       numOrNull(r.setback_rear_m),
            setbackSideM:       numOrNull(r.setback_side_m),
          },
          extras:         r.extras ?? {},
          sourceCitation: r.source_citation,
        })),
      })
    } catch (err) {
      request.log.error({ err }, 'list templates failed')
      return reply.code(500).send({ success: false, error: 'internal' })
    }
  })
}

function numOrNull(v) {
  return v == null ? null : Number(v)
}

module.exports = { planningAssistantRoutes }
