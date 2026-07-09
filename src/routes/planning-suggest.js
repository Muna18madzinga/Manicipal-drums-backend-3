// src/routes/planning-suggest.js
// ─────────────────────────────────────────────────────────────────────────
// Grounded AI planning assistant for the Planning Studio. Three stages:
//
//   POST /api/planning/site-context  { layer, fid }
//     → verified PostGIS site facts (no LLM). Stage 1.
//   POST /api/planning/brief         { siteContext, answers? }
//     → Nemotron (NVIDIA NIM, thinking mode) analysis + clarifying questions
//       (no answers), or a design brief (with answers). The reasoner NEVER
//       emits geometry. Stage 2.
//   POST /api/planning/suggest       { layer, fid, brief }
//     → Llama 3.3 drafts geometry grounded on the parcel boundary + real road
//       entry points + no-go polygons, then deterministic PostGIS laundering
//       clips/snaps/drops everything back inside the parcel. Stage 3.
//
// Anti-hallucination guarantee: the authoritative geometry (boundary, entry
// points, no-go, and the final clip) is always recomputed server-side in
// planningSpatial.js. Nothing the models invent can escape the parcel.
//
// SECURITY / TENANCY: Vungu RDC is a SINGLE council (single-tenant). The model
// is therefore "any SUGGEST_ROLES user may analyse any parcel". Parcel tables
// are registry-allowlisted (never user-supplied). If this portal is ever made
// multi-tenant, add a per-council parcel scope here AND stop logging bare
// parcel fids — do not let a future split silently inherit open access.
//
// Guardrails:
//   • NVIDIA_API_KEY lives in backend .env only (one key, both NIM models).
//   • Rate limit is keyed per authenticated user so planners don't block each
//     other (falls back to IP for anon/forged tokens — which fail auth anyway).
//   • Every LLM response is runtime-validated; parse/shape failure → 503.
// ─────────────────────────────────────────────────────────────────────────

const jwt = require('jsonwebtoken')
const { requireRole } = require('../middleware/jwtAuth')
const { extractJson } = require('../services/aiClient')
const { buildSiteContext, getParcelGrounding, postProcessDraft } = require('../services/planningSpatial')

const SUGGEST_ROLES = ['planner', 'gis_officer', 'admin']
const PARCEL_LAYERS = ['vungu_farm_cadastre', 'vungu_parcels']

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions'
const NIM_MODEL = 'meta/llama-3.3-70b-instruct'
// Reasoning model for the analysis/brief stage. Nemotron thinking mode returns
// its chain-of-thought in `reasoning_content` and the answer in `content`, so
// the JSON contract stays clean.
const REASONING_MODEL = () => process.env.NIM_REASONING_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b'

// The only land-use tags and road classes the drafter may emit. sanitize*
// checks against these exhaustively; unknown values are dropped.
const ZONE_USES = ['single_residential', 'townhouse', 'mixed_use', 'commercial', 'school', 'health', 'community_centre', 'place_of_worship', 'recreation', 'open_space']
const ROAD_HIERARCHY = ['arterial', 'collector', 'local', 'access']

/** Consistent, machine-readable error envelope (frontend switches on `error`). */
function fail(reply, code, error, message) {
  return reply.code(code).send({ success: false, error, message: message || error })
}

/**
 * Rate-limit key: per authenticated user when a token is present, else per IP.
 * Runs in onRequest (before auth), so it decodes — not verifies — the token
 * purely to bucket requests; a forged token just gets its own bucket and still
 * fails auth before reaching any paid LLM call.
 */
function llmRateKey(request) {
  try {
    const auth = request.headers.authorization
    const token = request.cookies?.vungu_at || (auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null)
    if (token) { const d = jwt.decode(token); if (d && d.sub) return 'u:' + d.sub }
  } catch { /* fall through to IP */ }
  return 'ip:' + (request.headers['x-forwarded-for']?.split(',')[0] || request.ip)
}

/** Strip heavy geometry from the site context — the reasoner works over facts, not polygons. */
function factsForReasoner(sc) {
  if (!sc || typeof sc !== 'object') return {}
  const p = sc.parcel || {}
  const nearest = (arr) => (arr && arr.length ? arr[0].distKm : null)
  return {
    parcel: { name: p.name, areaHa: p.areaHa, perimeterM: p.perimeterM, complexity: p.complexity },
    developableHa: sc.developableHa,
    roads: (sc.roads || []).map(r => ({ name: r.name, fclass: r.fclass, ref: r.ref, lengthInParcelM: r.lengthInParcelM, entryPointCount: (r.entryPoints || []).length })),
    water: {
      streams: (sc.water?.streams || []).map(s => ({ name: s.name, fclass: s.fclass, lengthInParcelM: s.lengthInParcelM })),
      waterAreas: sc.water?.waterAreas || [],
    },
    terrain: sc.terrain || [],
    protectedAreas: sc.protected || [],
    landuse: sc.landuse || [],
    buildings: sc.buildings || {},
    settlements: sc.settlements || [],
    amenities: {
      schoolsWithin10km: (sc.amenities?.schools || []).length,
      healthWithin10km: (sc.amenities?.health || []).length,
      nearestSchoolKm: nearest(sc.amenities?.schools),
      nearestHealthKm: nearest(sc.amenities?.health),
    },
  }
}

const ANALYST_SYSTEM = [
  'You are a senior town planner preparing a Local Development Plan brief for Vungu Rural District Council, Zimbabwe.',
  'You receive VERIFIED GIS site facts computed from the council PostGIS database. Treat them as ground truth and NEVER invent site features (roads, rivers, settlements, terrain) that are not listed.',
  'If any value you would need cannot be grounded in the provided facts or answers, leave it null or omit it — do not fabricate.',
  'Zimbabwe road reserve standards: national road 40 m; district distributor 30 m; local distributor 25/20/15 m by function.',
  'Amenity norms: 1 primary school (2.5–4 ha) per ~1000–1500 households; 1 secondary school (4–6 ha) per ~2000 households; 1 clinic (1–2 ha) per ~5000 people; local shopping centre 0.5–2 ha per neighbourhood.',
  'Statutory constraints: 30 m stream/river setback (EMA); avoid wetlands and protected areas entirely; communal land needs RDC/traditional consent.',
  'You produce reasoning, questions, and budgets ONLY. You NEVER output geometry or coordinates.',
  'RESPONSE MODES (respond with JSON only, no prose outside the JSON):',
  'If the user message has NO "answers" field: return {"analysis": string, "questions": [{"id": string, "question": string, "options"?: [string]}]} — a concise site analysis (size, access, water, constraints, nearby settlements/amenities, and note explicitly if terrain/elevation data is sparse) and up to 4 clarifying questions about intended land use, density, and amenities.',
  'If the user message HAS an "answers" field: return {"brief": {"summary": string, "developableHa": number, "roadHierarchy": [{"class": string, "hierarchy": "arterial|collector|local|access", "reserveWidthM": number, "connectsToEntryPoint"?: [number,number], "intent": string}], "zoneBudget": [{"use": string, "pct": number, "targetHa": number}], "amenities": [{"use": string, "count": number, "siteHa": number, "rationale": string}], "constraintBuffers": [{"kind": string, "bufferM": number}], "densityTargetPerHa": number, "estimatedHouseholds": number, "estimatedPopulation": number, "notes": [string]}}.',
  'zoneBudget percentages should sum to about 100. Use only these zone uses: ' + ZONE_USES.join(', ') + '.',
].join(' ')

const DRAFTER_SYSTEM = [
  'You are a geometry drafter. You receive PARCEL (GeoJSON polygon, WGS84 lng/lat), ENTRY_POINTS (points on the parcel boundary where existing roads connect), NOGO (polygons where nothing may be placed), and a DESIGN BRIEF from a senior planner.',
  'Draft the layout the brief specifies. HARD RULES:',
  '1. Every coordinate strictly inside PARCEL. 2. Every road starts at an ENTRY_POINT or on the parcel boundary and forms a connected network. 3. No zone overlaps NOGO. 4. Road hierarchy and reserve widths exactly as the brief specifies. 5. Zones sized to the brief hectare targets. 6. At most 40 vertices per geometry.',
  'Downstream GIS validation clips or deletes anything that violates these rules, so stay inside the parcel.',
  'Allowed road hierarchy values: ' + ROAD_HIERARCHY.join(', ') + '. Allowed zone use values: ' + ZONE_USES.join(', ') + '.',
  'Respond with JSON ONLY in exactly this shape:',
  '{"roads":[{"hierarchy":"collector","widthM":20,"name":"Spine Road","geom":{"type":"LineString","coordinates":[[lng,lat],[lng,lat]]}}],',
  '"zones":[{"use":"single_residential","geom":{"type":"Polygon","coordinates":[[[lng,lat],[lng,lat],[lng,lat],[lng,lat]]]}}],',
  '"notes":["short rationale"]}',
].join(' ')

// JSON schema handed to NIM when the model/endpoint supports guided decoding.
const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    roads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          hierarchy: { type: 'string', enum: ROAD_HIERARCHY },
          widthM: { type: 'number' },
          name: { type: 'string' },
          geom: { type: 'object', properties: { type: { type: 'string' }, coordinates: { type: 'array' } }, required: ['type', 'coordinates'] },
        },
        required: ['geom'],
      },
    },
    zones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          use: { type: 'string', enum: ZONE_USES },
          geom: { type: 'object', properties: { type: { type: 'string' }, coordinates: { type: 'array' } }, required: ['type', 'coordinates'] },
        },
        required: ['use', 'geom'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['roads', 'zones'],
}

/** Exhaustive validator for the drafter output. Enums checked, widths clamped,
 *  malformed / unknown entries dropped. Null if nothing usable remains. */
function sanitizeSuggestion(parsed) {
  if (!parsed || typeof parsed !== 'object') return null
  const finite2 = (c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])
  const clampWidth = (w) => Math.max(8, Math.min(40, Number.isFinite(Number(w)) ? Number(w) : 15))

  const roads = Array.isArray(parsed.roads) ? parsed.roads.filter(r =>
    r && r.geom && r.geom.type === 'LineString' && Array.isArray(r.geom.coordinates)
    && r.geom.coordinates.length >= 2 && r.geom.coordinates.every(finite2)
  ).map(r => ({
    hierarchy: ROAD_HIERARCHY.includes(r.hierarchy) ? r.hierarchy : 'local',
    widthM: clampWidth(r.widthM),
    name: r.name != null ? String(r.name).slice(0, 80) : undefined,
    geom: r.geom,
  })) : []

  const zones = Array.isArray(parsed.zones) ? parsed.zones.filter(z =>
    z && ZONE_USES.includes(z.use) && z.geom && z.geom.type === 'Polygon'
    && Array.isArray(z.geom.coordinates) && z.geom.coordinates.length
  ).map(z => ({ use: z.use, geom: z.geom })) : []

  const notes = Array.isArray(parsed.notes) ? parsed.notes.map(String).slice(0, 8) : []
  if (!roads.length && !zones.length) return null
  return { roads, zones, notes }
}

/** Validate the reasoner's brief-route response by mode. */
function validateBriefResponse(obj, hasAnswers) {
  if (!obj || typeof obj !== 'object') return null
  if (hasAnswers) {
    const b = obj.brief
    if (!b || typeof b !== 'object' || !Array.isArray(b.zoneBudget)) return null
    return { brief: b }
  }
  if (typeof obj.analysis !== 'string' || !Array.isArray(obj.questions)) return null
  return { analysis: obj.analysis, questions: obj.questions.slice(0, 4) }
}

/**
 * Call the NIM reasoning model (Nemotron thinking mode) for the analysis/brief
 * stage. Thinking tokens arrive in `reasoning_content` (discarded here — the
 * planner sees the conclusion, not the chain-of-thought); the answer JSON is in
 * `content`. Returns { content, usage } or throws with .status on upstream
 * failure. temperature 1 / top_p 0.95 are NVIDIA's recommended settings for
 * thinking mode — do not "fix" them down to typical JSON-task values.
 */
async function callNimReasoning(key, messages, { maxTokens = 8192, reasoningBudget = 4096 } = {}) {
  const res = await fetch(NIM_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: REASONING_MODEL(),
      messages,
      temperature: 1, top_p: 0.95, max_tokens: maxTokens, stream: false,
      chat_template_kwargs: { enable_thinking: true },
      reasoning_budget: reasoningBudget,
    }),
  })
  if (!res.ok) {
    const err = new Error('nim_reasoning_upstream_' + res.status)
    err.status = res.status
    throw err
  }
  const json = await res.json()
  return { content: json?.choices?.[0]?.message?.content || null, usage: json?.usage || null }
}

/**
 * Call NIM, preferring guided json_schema decoding and falling back to plain
 * json_object if the endpoint rejects the schema. Returns { content, schemaMode }
 * or throws on a genuine upstream/transport failure.
 */
async function callNim(key, messages) {
  const base = { model: NIM_MODEL, temperature: 0.4, max_tokens: 4096, messages }
  const attempts = [
    ['json_schema', { ...base, response_format: { type: 'json_schema', json_schema: { name: 'subdivision_draft', schema: DRAFT_SCHEMA, strict: true } } }],
    ['json_object', { ...base, response_format: { type: 'json_object' } }],
  ]
  let lastStatus = 0
  for (const [schemaMode, body] of attempts) {
    const res = await fetch(NIM_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) {
      const json = await res.json()
      const content = json?.choices?.[0]?.message?.content
      return { content, schemaMode }
    }
    lastStatus = res.status
    // Only fall through to json_object on a 4xx that likely means "schema unsupported".
    if (res.status < 400 || res.status >= 500) break
  }
  const err = new Error('nim_upstream_' + lastStatus)
  err.status = lastStatus
  throw err
}

/**
 * @param {import('fastify').FastifyInstance} fastify
 */
async function planningSuggestRoutes(fastify) {
  const rl = { rateLimit: { max: 10, timeWindow: '1 minute', keyGenerator: llmRateKey } }

  // ── Stage 1: deterministic site facts (no LLM) ─────────────────────────
  fastify.post('/planning/site-context', {
    preHandler: requireRole(fastify, SUGGEST_ROLES),
    schema: { body: { type: 'object', required: ['layer', 'fid'], properties: { layer: { type: 'string' }, fid: { type: 'integer' } } } },
  }, async (request, reply) => {
    const { layer, fid } = request.body
    if (!PARCEL_LAYERS.includes(layer)) return fail(reply, 400, 'bad_layer', 'Unknown parcel layer.')
    const t0 = Date.now()
    let ctx
    try {
      ctx = await buildSiteContext(fastify.pg, { layer, fid })
    } catch (err) {
      request.log.error({ err: err && err.message }, 'site-context query failed')
      return fail(reply, 500, 'site_context_failed', 'Could not analyse this parcel.')
    }
    if (!ctx) return fail(reply, 404, 'parcel_not_found', 'Parcel not found.')
    request.log.info({
      evt: 'planning_site_context', layer, fid, latency_ms: Date.now() - t0,
      area_ha: ctx.parcel.areaHa, roads: ctx.roads.length, nogo: !!ctx.nogo, complexity: ctx.parcel.complexity,
    }, 'planning site-context')
    return reply.send({ data: ctx })
  })

  // ── Stage 2: Nemotron analysis + questions, or design brief ────────────
  fastify.post('/planning/brief', {
    preHandler: requireRole(fastify, SUGGEST_ROLES),
    schema: { body: { type: 'object', required: ['siteContext'], properties: { siteContext: { type: 'object' }, answers: { type: 'object' } } } },
    config: rl,
  }, async (request, reply) => {
    const key = process.env.NVIDIA_API_KEY
    if (!key) return fail(reply, 503, 'llm_not_configured', 'AI planning assistant is not configured.')
    const { siteContext, answers } = request.body
    const hasAnswers = answers && typeof answers === 'object' && Object.keys(answers).length > 0

    const user = JSON.stringify({ facts: factsForReasoner(siteContext), answers: hasAnswers ? answers : undefined })
    const t0 = Date.now()
    let content = null, usage = null
    try {
      ({ content, usage } = await callNimReasoning(key, [
        { role: 'system', content: ANALYST_SYSTEM },
        { role: 'user', content: user },
      ]))
    } catch (err) {
      request.log.warn({ err: err && err.message, status: err && err.status }, 'NIM reasoning upstream error')
      return fail(reply, 503, 'llm_upstream_error', 'AI planning assistant is unavailable.')
    }
    const parsed = content ? extractJson(content) : null
    const out = validateBriefResponse(parsed, hasAnswers)
    request.log.info({
      evt: 'planning_brief', model: REASONING_MODEL(), mode: hasAnswers ? 'brief' : 'questions',
      latency_ms: Date.now() - t0,
      input_tokens: usage?.prompt_tokens, output_tokens: usage?.completion_tokens,
      json_drift: !!(content && !out),
    }, 'planning brief')
    if (!out) return fail(reply, 503, 'llm_json_drift', 'AI response could not be parsed.')
    return reply.send({ data: out })
  })

  // ── Stage 3: Llama drafts geometry, PostGIS launders it ────────────────
  fastify.post('/planning/suggest', {
    preHandler: requireRole(fastify, SUGGEST_ROLES),
    schema: { body: { type: 'object', required: ['layer', 'fid', 'brief'], properties: { layer: { type: 'string' }, fid: { type: 'integer' }, brief: { type: 'object' } } } },
    config: rl,
  }, async (request, reply) => {
    const key = process.env.NVIDIA_API_KEY
    if (!key) return fail(reply, 503, 'llm_not_configured', 'AI drafting service is not configured.')
    const { layer, fid, brief } = request.body
    if (!PARCEL_LAYERS.includes(layer)) return fail(reply, 400, 'bad_layer', 'Unknown parcel layer.')

    // Authoritative grounding — refetched server-side; client geometry ignored.
    const grounding = await getParcelGrounding(fastify.pg, { layer, fid })
    if (!grounding || !grounding.parcel) return fail(reply, 404, 'parcel_not_found', 'Parcel not found.')

    const userPrompt = JSON.stringify({
      PARCEL: grounding.parcel, ENTRY_POINTS: grounding.entryPoints, NOGO: grounding.nogo, BRIEF: brief,
    }).slice(0, 90000)

    const t0 = Date.now()
    let content, schemaMode
    try {
      ({ content, schemaMode } = await callNim(key, [
        { role: 'system', content: DRAFTER_SYSTEM },
        { role: 'user', content: `Draft the subdivision layout. ${userPrompt}` },
      ]))
    } catch (err) {
      request.log.warn({ err: err && err.message, status: err && err.status }, 'NIM upstream error')
      return fail(reply, 503, 'llm_upstream_error', 'AI drafting service is unavailable.')
    }

    let parsed
    try { parsed = JSON.parse(content) } catch { return fail(reply, 503, 'llm_json_drift', 'AI draft could not be parsed.') }
    const draft = sanitizeSuggestion(parsed)
    if (!draft) return fail(reply, 503, 'llm_empty_suggestion', 'AI produced no usable geometry.')

    let laundered
    try {
      laundered = await postProcessDraft(fastify.pg, { layer, fid, draft })
    } catch (err) {
      request.log.error({ err: err && err.message }, 'draft laundering failed')
      return fail(reply, 500, 'laundering_failed', 'Could not validate the AI draft geometry.')
    }
    if (!laundered) return fail(reply, 404, 'parcel_not_found', 'Parcel not found.')

    request.log.info({
      evt: 'planning_suggest', layer, fid, schema_mode: schemaMode, latency_ms: Date.now() - t0,
      roads_in: draft.roads.length, roads_out: laundered.roads.length,
      zones_in: draft.zones.length, zones_out: laundered.zones.length,
      dropped_roads: laundered.dropped.roads.map(d => d.reason),
      dropped_zones: laundered.dropped.zones.map(d => d.reason),
    }, 'planning suggest')

    return reply.send({ data: { roads: laundered.roads, zones: laundered.zones, notes: laundered.notes } })
  })
}

module.exports = { planningSuggestRoutes, sanitizeSuggestion, validateBriefResponse, factsForReasoner }
