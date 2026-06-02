// src/lib/tileCache.js
//
// Two-tier MVT tile cache.
//
//   L1 — bounded in-process LRU (insertion-order Map). Microsecond hits,
//        process-local, dies on restart.
//   L2 — Redis (optional). Shared across processes / replicas, survives
//        deploys, ~1 ms hits.
//
// On a hit, L2 values are promoted into L1 so subsequent hits stay fast.
// On a miss, the caller renders the tile and writes to both.
//
// L2 is enabled when a `redis` client (e.g. ioredis or @fastify/redis) is
// passed in. Without it, the cache silently degrades to L1-only — the
// route code does not need to branch on cache shape.

const DEFAULT_TTL_SECONDS = 86_400 // 24 h, matches Cache-Control: max-age

class TileCache {
  /**
   * @param {object|number} options Either an options object or a legacy
   *   capacity number (preserves the v1 single-arg signature).
   * @param {number} [options.capacity=2000] L1 entry cap.
   * @param {object} [options.redis=null] ioredis-compatible client. Must
   *   support `getBuffer(key)` and `set(key, buf, 'EX', ttl)`.
   * @param {number} [options.ttlSeconds=86400] Redis TTL on `set`.
   * @param {string} [options.keyPrefix='tile:'] Redis key namespace.
   */
  constructor(options = {}) {
    const opts = typeof options === 'number' ? { capacity: options } : options
    this.capacity = opts.capacity ?? 2000
    this.redis = opts.redis ?? null
    this.ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS
    this.keyPrefix = opts.keyPrefix ?? 'tile:'
    /** @type {Map<string, Buffer>} */
    this.map = new Map()
  }

  _redisKey(key) {
    return this.keyPrefix + key
  }

  /**
   * Returns the cached tile bytes, or undefined on miss.
   * @param {string} key
   * @returns {Promise<Buffer|undefined>}
   */
  async get(key) {
    // L1
    if (this.map.has(key)) {
      const buf = this.map.get(key)
      // Touch for LRU: delete + re-set moves to the youngest end.
      this.map.delete(key)
      this.map.set(key, buf)
      return buf
    }
    // L2
    if (this.redis) {
      try {
        const cached = await this.redis.getBuffer(this._redisKey(key))
        if (cached) {
          this._setL1(key, cached)
          return cached
        }
      } catch {
        // Redis is best-effort; a hiccup must not break tile serving.
      }
    }
    return undefined
  }

  /**
   * Writes to both tiers (L2 best-effort).
   * @param {string} key
   * @param {Buffer} value
   * @returns {Promise<void>}
   */
  async set(key, value) {
    this._setL1(key, value)
    if (this.redis) {
      try {
        await this.redis.set(this._redisKey(key), value, 'EX', this.ttl)
      } catch {
        // swallow — L1 still has it for this instance
      }
    }
  }

  _setL1(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
  }

  /** Clears only L1. L2 (Redis) keeps its TTL-bound entries on purpose. */
  clear() {
    this.map.clear()
  }
}

module.exports = { TileCache }
