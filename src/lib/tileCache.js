// src/lib/tileCache.js
//
// Two-tier MVT tile cache.
//
//   L1 — bounded in-process LRU (insertion-order Map) with byte accounting
//        and per-entry TTL. Microsecond hits, process-local, dies on restart.
//   L2 — Redis (optional). Shared across processes / replicas, survives
//        deploys, ~1 ms hits.
//
// On an L2 hit the value is promoted into L1 so subsequent hits stay fast.
// On a miss the caller renders the tile and writes to both tiers.
//
// L2 is enabled when a `redis` client (ioredis / @fastify/redis) is provided —
// either via the constructor or by assigning `cache.redis` after construction
// (the tiles route does the latter once @fastify/redis is registered). Without
// it the cache silently degrades to L1-only; route code never branches on the
// cache shape.

const DEFAULT_MAX_TILES   = 4000                 // entries
const DEFAULT_MAX_BYTES   = 128 * 1024 * 1024    // 128 MB
const DEFAULT_TTL_MS      = 24 * 60 * 60 * 1000  // 24 h, matches Cache-Control
const DEFAULT_REDIS_TTL_S = 86_400               // 24 h Redis EX

class TileCache {
  /**
   * @param {object|number} [options] Options object, or a legacy capacity
   *   number (preserves the original single-arg signature).
   * @param {number} [options.capacity=4000]  L1 max entry count.
   * @param {number} [options.maxBytes=134217728]  L1 max total bytes (0 = unlimited).
   * @param {number} [options.ttlMs=86400000]  L1 per-entry TTL ms (0 = never expire).
   * @param {object} [options.redis=null]  ioredis-compatible client. Needs
   *   getBuffer(key) and set(key, buf, 'EX', ttl); scan/del for invalidation.
   * @param {number} [options.redisTtlSeconds=86400]  Redis EX seconds.
   * @param {string} [options.keyPrefix='tile:']  Redis key namespace.
   */
  constructor(options = {}) {
    const opts = typeof options === 'number' ? { capacity: options } : options
    this.maxTiles  = opts.capacity ?? opts.maxTiles ?? DEFAULT_MAX_TILES
    this.maxBytes  = opts.maxBytes ?? DEFAULT_MAX_BYTES
    this.ttlMs     = opts.ttlMs ?? DEFAULT_TTL_MS
    this.redis     = opts.redis ?? null
    this.redisTtl  = opts.redisTtlSeconds ?? DEFAULT_REDIS_TTL_S
    this.keyPrefix = opts.keyPrefix ?? 'tile:'
    /** @type {Map<string, {buf: Buffer, ts: number}>} oldest first, newest re-inserted last */
    this.map = new Map()
    this.totalBytes = 0
    this._hits   = 0
    this._misses = 0
  }

  _redisKey(key) {
    return this.keyPrefix + key
  }

  /**
   * Returns cached tile bytes, or undefined on miss. Checks L1 then L2;
   * an L2 hit is promoted into L1.
   * @param {string} key
   * @returns {Promise<Buffer|undefined>}
   */
  async get(key) {
    // L1
    const entry = this.map.get(key)
    if (entry) {
      if (this.ttlMs && Date.now() - entry.ts > this.ttlMs) {
        this._evict(key, entry)
      } else {
        // LRU touch: move to the youngest end.
        this.map.delete(key)
        this.map.set(key, entry)
        this._hits++
        return entry.buf
      }
    }
    // L2
    if (this.redis) {
      try {
        const cached = await this.redis.getBuffer(this._redisKey(key))
        if (cached) {
          this._setL1(key, cached)
          this._hits++
          return cached
        }
      } catch {
        // Redis is best-effort; a hiccup must not break tile serving.
      }
    }
    this._misses++
    return undefined
  }

  /**
   * Writes to both tiers (L2 best-effort).
   * @param {string} key
   * @param {Buffer} buf
   * @returns {Promise<void>}
   */
  async set(key, buf) {
    this._setL1(key, buf)
    if (this.redis) {
      try {
        await this.redis.set(this._redisKey(key), buf, 'EX', this.redisTtl)
      } catch {
        // swallow — L1 still holds it for this instance
      }
    }
  }

  /** Insert/replace an entry in L1 with count + byte eviction. */
  _setL1(key, buf) {
    const existing = this.map.get(key)
    if (existing) {
      this.totalBytes -= existing.buf.length
      this.map.delete(key)
    }
    // Evict by count
    while (this.map.size >= this.maxTiles) {
      const oldestKey = this.map.keys().next().value
      this._evict(oldestKey, this.map.get(oldestKey))
    }
    // Evict by size
    if (this.maxBytes) {
      while (this.totalBytes + buf.length > this.maxBytes && this.map.size > 0) {
        const oldestKey = this.map.keys().next().value
        this._evict(oldestKey, this.map.get(oldestKey))
      }
    }
    this.map.set(key, { buf, ts: Date.now() })
    this.totalBytes += buf.length
  }

  /** @param {string} key */
  delete(key) {
    const entry = this.map.get(key)
    if (entry) this._evict(key, entry)
  }

  /** Clears only L1. L2 (Redis) keeps its TTL-bound entries on purpose. */
  clear() {
    this.map.clear()
    this.totalBytes = 0
  }

  /**
   * Invalidate all tiles for a specific layer (call after data ingestion).
   * Clears L1 synchronously and returns the L1 count; when L2 is enabled a
   * best-effort, fire-and-forget Redis cleanup runs in the background.
   * @param {string} layerId
   * @returns {number} number of L1 entries removed
   */
  invalidateLayer(layerId) {
    const prefix = `${layerId}/`
    const toDelete = []
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) toDelete.push(key)
    }
    for (const key of toDelete) this.delete(key)
    if (this.redis) { this._invalidateRedisLayer(prefix).catch(() => {}) }
    return toDelete.length
  }

  /** Best-effort SCAN + DEL of Redis keys for a layer prefix. */
  async _invalidateRedisLayer(prefix) {
    if (!this.redis || typeof this.redis.scan !== 'function') return
    try {
      const match = `${this.keyPrefix}${prefix}*`
      let cursor = '0'
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', match, 'COUNT', 200)
        cursor = next
        if (keys && keys.length) await this.redis.del(...keys)
      } while (cursor !== '0')
    } catch {
      // Redis cleanup is best-effort; TTL will expire any stragglers.
    }
  }

  stats() {
    const total = this._hits + this._misses
    return {
      entries:    this.map.size,
      totalBytes: this.totalBytes,
      totalMB:    (this.totalBytes / 1048576).toFixed(2),
      hits:       this._hits,
      misses:     this._misses,
      hitRate:    total ? `${((this._hits / total) * 100).toFixed(1)}%` : 'n/a',
      l2:         this.redis ? 'redis' : 'off',
    }
  }

  _evict(key, entry) {
    this.map.delete(key)
    if (entry) this.totalBytes -= entry.buf.length
  }
}

module.exports = { TileCache }
