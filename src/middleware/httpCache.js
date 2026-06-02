/**
 * HTTP caching middleware for SpartialIQ.
 *
 * Attaches Cache-Control headers to responses based on the route pattern.
 * Uses a simple in-process LRU map for server-side caching of DB-heavy
 * responses (vector tile catalog, exchange rate, planning templates).
 * For multi-instance deployments, replace the LRU with Redis (see notes).
 *
 * Cache tiers
 * ───────────
 *   tiles      1 year    Vector tiles (content-addressed; never mutate)
 *   static     1 hour    Layer catalog, planning templates
 *   dynamic    5 min     Exchange rate, stands list
 *   private    no-store  Auth'd user data, payment records
 */

'use strict'

// ── Tiny LRU for server-side API response caching ───────────────────────────

class LRUCache {
  constructor(maxEntries = 500, defaultTtlMs = 300_000) {
    this._max    = maxEntries
    this._ttl    = defaultTtlMs
    this._store  = new Map()
  }

  _evict() {
    // Map iterates in insertion order; evict oldest first.
    const oldest = this._store.keys().next().value
    if (oldest !== undefined) this._store.delete(oldest)
  }

  set(key, value, ttlMs) {
    if (this._store.has(key)) this._store.delete(key) // re-insert to refresh position
    if (this._store.size >= this._max) this._evict()
    this._store.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this._ttl) })
  }

  get(key) {
    const entry = this._store.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key)
      return undefined
    }
    // Move to end (most recently used)
    this._store.delete(key)
    this._store.set(key, entry)
    return entry.value
  }

  delete(key) { this._store.delete(key) }
  clear()     { this._store.clear() }
  get size()  { return this._store.size }
}

// Singleton shared across all route handlers in this process.
const apiCache = new LRUCache(1000, 5 * 60 * 1000)

// ── Cache-Control header helper ──────────────────────────────────────────────

const SECOND = 1
const MINUTE = 60 * SECOND
const HOUR   = 60 * MINUTE
const YEAR   = 365 * 24 * HOUR

function setCacheHeaders(reply, tier) {
  switch (tier) {
    case 'immutable':
      // Vector tiles: content is keyed by z/x/y so it is immutable once written.
      reply.header('Cache-Control', `public, max-age=${YEAR}, immutable`)
      reply.header('Vary', 'Accept-Encoding')
      break
    case 'static':
      // Layer catalog, templates: changes only on deploy.
      reply.header('Cache-Control', `public, max-age=${HOUR}, stale-while-revalidate=${HOUR}`)
      reply.header('Vary', 'Accept-Encoding')
      break
    case 'dynamic':
      // Exchange rate, stands: refreshes every 5 min.
      reply.header('Cache-Control', `public, max-age=${5 * MINUTE}, stale-while-revalidate=${MINUTE}`)
      reply.header('Vary', 'Accept-Encoding')
      break
    case 'private':
      // Auth'd endpoints: never cache in a shared proxy.
      reply.header('Cache-Control', 'private, no-store')
      break
    case 'none':
    default:
      reply.header('Cache-Control', 'no-store')
      break
  }
}

// ── Route-pattern → cache tier map ──────────────────────────────────────────

function cacheTierForPath(path, method) {
  if (method !== 'GET') return 'none'

  if (/^\/api\/tiles\/\w+\/\d+\/\d+\/\d+\.pbf/.test(path)) return 'immutable'
  if (path === '/api/tiles/layers' || path.startsWith('/api/tiles/layers')) return 'static'
  if (path.startsWith('/api/planning-assistant/templates')) return 'static'
  if (path === '/api/payments/rate') return 'dynamic'
  if (path === '/api/payments/methods') return 'static'
  if (path.startsWith('/api/stands') && !path.includes('/reserve')) return 'dynamic'
  if (path === '/api/inspection-stages') return 'static'
  if (path.startsWith('/api/planning-assistant/')) return 'dynamic'
  if (path.startsWith('/api/public')) return 'dynamic'

  return 'none'
}

// ── Fastify plugin ───────────────────────────────────────────────────────────

/**
 * Register as a Fastify plugin:
 *
 *   const httpCache = require('./src/middleware/httpCache')
 *   fastify.addHook('onSend', httpCache.onSendHook)
 *
 * Or register via:
 *   fastify.register(require('./src/middleware/httpCache'))
 */
async function httpCachePlugin(fastify) {
  fastify.addHook('onSend', async (request, reply) => {
    const tier = cacheTierForPath(request.url, request.method)
    if (tier !== 'none') setCacheHeaders(reply, tier)

    // Always set security headers for API responses.
    reply.header('X-Content-Type-Options', 'nosniff')

    return
  })
}

httpCachePlugin[Symbol.for('skip-override')] = true

// ── Server-side API cache helpers ────────────────────────────────────────────

/**
 * Wrap a Fastify handler with server-side caching.
 *
 *   fastify.get('/api/tiles/layers', cached('tiles-catalog', 60 * 60 * 1000, async (req, rep) => {
 *     // expensive DB query
 *   }))
 *
 * @param {string}   key    Cache key
 * @param {number}   ttlMs  TTL in milliseconds
 * @param {Function} fn     Original handler (request, reply) => payload
 */
function cached(key, ttlMs, fn) {
  return async function cachedHandler(request, reply) {
    const hit = apiCache.get(key)
    if (hit !== undefined) {
      reply.header('X-Cache', 'HIT')
      return hit
    }
    reply.header('X-Cache', 'MISS')
    const result = await fn(request, reply)
    apiCache.set(key, result, ttlMs)
    return result
  }
}

/**
 * Invalidate one or more server-side cache keys.
 * Call this from write routes (POST/PUT/DELETE) that mutate cached data.
 */
function invalidate(...keys) {
  for (const k of keys) apiCache.delete(k)
}

/** Invalidate everything (e.g. after a migration or bulk import). */
function invalidateAll() {
  apiCache.clear()
}

module.exports = {
  httpCachePlugin,
  setCacheHeaders,
  cacheTierForPath,
  cached,
  invalidate,
  invalidateAll,
  apiCache,
  SECOND, MINUTE, HOUR, YEAR,
}
