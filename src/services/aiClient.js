/**
 * Claude (Anthropic) AI client.
 *
 * A thin wrapper over the Anthropic Messages API
 * (https://api.anthropic.com/v1/messages). Two capabilities are exposed:
 *
 *   chatText({ system, user })          → plain text completion
 *   analyzeImage({ buffer, mimeType,    → vision completion over an uploaded
 *                  prompt })               document / photo
 *
 * Both return `null` when the client is not configured (no ANTHROPIC_API_KEY)
 * or when the call fails, so callers can always degrade gracefully — the
 * app never depends on the model being reachable.
 *
 * Models are configurable via env so the deployment can pick the right
 * cost / latency / quality point. The defaults favour low latency (Haiku),
 * which suits the workflow here: the AI is a first-pass triage and staff
 * always make the final decision, so speed matters more than squeezing out
 * the last few points of extraction accuracy. Set ANTHROPIC_VISION_MODEL to
 * a Sonnet model if you want stronger document reading.
 *
 * Image handling: Claude accepts base64 images inline as content blocks.
 * Supported types are jpeg / png / gif / webp (HEIC is not supported — those
 * fall through to manual review). Very large images are skipped (returns
 * null) so we never blow the per-image size limit; the citizen's document
 * still reaches the staff queue.
 */

const axios = require('axios')

// The Messages API lives under /v1. A bare-host base URL — or a machine/user
// env var that shadows .env — 404s every call, so re-add /v1 for the official
// host. Custom proxies (any other host) are left exactly as configured.
function normalizeAnthropicBase(u) {
  const s = (u || 'https://api.anthropic.com/v1').replace(/\/+$/, '')
  return /\/\/api\.anthropic\.com$/.test(s) ? s + '/v1' : s
}
const BASE_URL  = normalizeAnthropicBase(process.env.ANTHROPIC_BASE_URL)
const API_KEY   = process.env.ANTHROPIC_API_KEY || ''
const VERSION   = process.env.ANTHROPIC_VERSION || '2023-06-01'
const TEXT_MODEL   = process.env.ANTHROPIC_TEXT_MODEL   || 'claude-haiku-4-5-20251001'
const VISION_MODEL = process.env.ANTHROPIC_VISION_MODEL || 'claude-haiku-4-5-20251001'
const TIMEOUT_MS   = Number(process.env.ANTHROPIC_TIMEOUT_MS || 30_000)

// Anthropic caps each base64 image at 5 MB. Keep raw bytes safely under that
// once base64-inflated (~1.33×); above this we skip the AI and let staff review.
const MAX_IMAGE_BYTES = Number(process.env.ANTHROPIC_MAX_IMAGE_BYTES || 3_700_000)

// Media types Claude vision accepts. HEIC and PDF are intentionally excluded.
const VISION_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

function isConfigured() {
  return Boolean(API_KEY)
}

function headers() {
  return {
    'x-api-key': API_KEY,
    'anthropic-version': VERSION,
    'content-type': 'application/json',
  }
}

/** Pull the assistant text out of a Messages API response. */
function textFromResponse(data) {
  const blocks = data?.content
  if (!Array.isArray(blocks)) return null
  const text = blocks
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
    .trim()
  return text || null
}

/**
 * Plain text chat completion. Returns the assistant message string, or null
 * on any failure / when unconfigured.
 *
 * @param {object}  opts
 * @param {string}  opts.system        system prompt (top-level Anthropic param)
 * @param {string}  opts.user          user prompt
 * @param {number} [opts.temperature]  default 0.3
 * @param {number} [opts.maxTokens]    default 700
 * @param {string} [opts.model]        override model
 * @param {(usage:object)=>void} [opts.onUsage]  called with the response
 *        `usage` block ({input_tokens, output_tokens}) on success — for
 *        telemetry. Never throws into the caller.
 */
async function chatText({ system, user, temperature = 0.3, maxTokens = 700, model, onUsage } = {}) {
  if (!isConfigured() || !user) return null

  const body = {
    model: model || TEXT_MODEL,
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: 'user', content: user }],
  }
  if (system) body.system = system

  try {
    const { data } = await axios.post(`${BASE_URL}/messages`, body, {
      headers: headers(), timeout: TIMEOUT_MS,
    })
    if (onUsage && data && data.usage) { try { onUsage(data.usage) } catch { /* telemetry must not break the call */ } }
    return textFromResponse(data)
  } catch {
    // Swallow — the caller falls back to a deterministic template / status.
    return null
  }
}

/**
 * Vision completion over a single image. Returns the assistant message
 * string, or null on any failure / when unconfigured / when the image type
 * is unsupported or too large for an inline request.
 *
 * @param {object} opts
 * @param {Buffer} opts.buffer    raw image bytes
 * @param {string} opts.mimeType  e.g. image/jpeg
 * @param {string} opts.prompt    instruction for the model
 * @param {number}[opts.maxTokens]
 * @param {string}[opts.model]
 */
async function analyzeImage({ buffer, mimeType, prompt, maxTokens = 700, model } = {}) {
  if (!isConfigured() || !buffer || !prompt) return null
  if (!VISION_MEDIA_TYPES.has(mimeType)) return null     // HEIC, PDF, unknown
  if (buffer.length > MAX_IMAGE_BYTES) return null        // too large to inline

  const body = {
    model: model || VISION_MODEL,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } },
        { type: 'text', text: prompt },
      ],
    }],
  }

  try {
    const { data } = await axios.post(`${BASE_URL}/messages`, body, {
      headers: headers(), timeout: TIMEOUT_MS,
    })
    return textFromResponse(data)
  } catch {
    return null
  }
}

/**
 * Pull the first JSON object out of a model response. LLMs frequently wrap
 * JSON in prose or ```json fences; this is tolerant of both. Returns the
 * parsed object or null.
 */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null
  // Strip code fences first.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

module.exports = {
  isConfigured,
  chatText,
  analyzeImage,
  extractJson,
  // exported for tests / introspection
  config: { BASE_URL, TEXT_MODEL, VISION_MODEL },
}
