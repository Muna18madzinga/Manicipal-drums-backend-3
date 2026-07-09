// src/routes/planning-suggest.js
// ─────────────────────────────────────────────────────────────────────────
// LLM layout-suggestion proxy for the Planning Studio "Generate compliant draft"
// button. Suggestion-ONLY: the frontend runs the returned geometry through the
// deterministic engine + Zimbabwe rulebook before anything is shown or saved.
//
//   POST /api/planning/suggest  { area, constraints, context:{setting} }
//     → { roads: LineString[], zones: {use, geom}[], notes: string[] }
//
// Guardrails:
//   • NVIDIA_API_KEY lives in backend .env only — never sent to the browser, never
//     logged. Missing key → 503 (frontend falls back to the offline generator).
//   • Body is schema-validated before any upstream call.
//   • Per-route rate limit respects the free NIM tier (1000 credits / 40 RPM).
//   • Upstream JSON is strictly shape-validated; parse/shape failure → 503.
// ─────────────────────────────────────────────────────────────────────────

const { requireRole } = require('../middleware/jwtAuth')

const SUGGEST_ROLES = ['planner', 'gis_officer', 'admin']
const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions'
const NIM_MODEL = 'meta/llama-3.3-70b-instruct'

const SYSTEM_PROMPT = [
  'You are a town-planning layout suggester for rural and urban parcels in Zimbabwe.',
  'RTCP Act [29:12] governs subdivision/development permits; EMA [20:27] and wetlands policy protect wetlands and streams;',
  'the Communal Land Act [20:04] governs communal land (RDC/traditional consent required — it is not private freehold and cannot be sold).',
  'Design a realistic, MIXED-USE neighbourhood — not a monoculture of single stands:',
  'a road hierarchy (a collector/spine plus local streets so every block has access);',
  'a small commercial / business centre and mixed-use frontage along the main road;',
  'institutional reserves (a primary school and a clinic) sized appropriately;',
  'public open space / parks distributed within walking distance; and residential of varying density',
  '(single residential, plus some medium-density townhouse/cluster areas).',
  'Return land-use ZONES as polygons tagged with a use from: single_residential, townhouse, mixed_use,',
  'commercial, school, health, community_centre, place_of_worship, recreation, open_space.',
  'Avoid wetlands and stream-banks where indicated; treat communal land as needing RDC/traditional consent.',
  'The authoritative rulebook and engine will validate your geometry; your proposal is a starting point only.',
  'Never state that a plan is legally compliant; defer to downstream validation.',
  'Respond ONLY with JSON: {"roads":[GeoJSON LineString...],"zones":[{"use":string,"geom":GeoJSON Polygon}...],"notes":[string...]}.',
].join(' ')

const bodySchema = {
  type: 'object',
  required: ['area', 'context'],
  properties: {
    area: { type: 'object' },
    constraints: { type: 'array' },
    context: {
      type: 'object',
      required: ['setting'],
      properties: { setting: { type: 'string', enum: ['urban', 'rural'] } },
    },
  },
}

/** Validate the shape we hand back to the client (defensive against LLM drift). */
function sanitizeSuggestion(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const roads = Array.isArray(parsed.roads)
    ? parsed.roads.filter(r => r && r.type === 'LineString' && Array.isArray(r.coordinates) && r.coordinates.length >= 2)
    : []
  const zones = Array.isArray(parsed.zones)
    ? parsed.zones.filter(z => z && z.geom && z.geom.type === 'Polygon' && Array.isArray(z.geom.coordinates))
        .map(z => ({ use: String(z.use || 'single_residential'), geom: z.geom }))
    : []
  const notes = Array.isArray(parsed.notes) ? parsed.notes.map(String).slice(0, 8) : []
  if (!roads.length && !zones.length) return null
  return { roads, zones, notes }
}

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
async function planningSuggestRoutes(fastify) {
  fastify.post(
    '/planning/suggest',
    {
      preHandler: requireRole(fastify, SUGGEST_ROLES),
      schema: { body: bodySchema },
      // Respect the free NIM tier — reuse the globally-registered @fastify/rate-limit.
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const key = process.env.NVIDIA_API_KEY
      if (!key) {
        return reply.code(503).send({ success: false, error: 'llm_not_configured', message: 'LLM suggestion service not configured; offline generator will be used.' })
      }

      const { area, constraints = [], context } = request.body
      const userPrompt = JSON.stringify({ setting: context.setting, area, constraints }).slice(0, 60000)

      let content
      try {
        const res = await fetch(NIM_URL, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: NIM_MODEL,
            temperature: 0.4,
            max_tokens: 2048,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: `Propose a subdivision layout for this parcel. ${userPrompt}` },
            ],
          }),
        })
        if (!res.ok) {
          fastify.log.warn({ status: res.status }, 'NIM upstream non-200')
          return reply.code(503).send({ success: false, error: 'llm_upstream_error' })
        }
        const json = await res.json()
        content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content
      } catch (err) {
        // Generic logging only — never log the key or full request.
        fastify.log.error({ err: err && err.message }, 'NIM request failed')
        return reply.code(503).send({ success: false, error: 'llm_request_failed' })
      }

      let parsed
      try { parsed = JSON.parse(content) } catch { return reply.code(503).send({ success: false, error: 'llm_bad_json' }) }
      const suggestion = sanitizeSuggestion(parsed)
      if (!suggestion) return reply.code(503).send({ success: false, error: 'llm_empty_suggestion' })

      return reply.send({ data: suggestion })
    },
  )
}

module.exports = { planningSuggestRoutes, sanitizeSuggestion }
