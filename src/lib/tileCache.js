// src/lib/tileCache.js
// Production-grade LRU tile cache with TTL and size accounting.
// Replaces the original insertion-order Map with true LRU eviction so the
// most recently accessed tiles stay hot regardless of insertion order.
// Also tracks byte usage so the cache won't eat unbounded memory.

const DEFAULT_MAX_TILES  = 4000          // entries
const DEFAULT_MAX_BYTES  = 128 * 1024 * 1024  // 128 MB
const DEFAULT_TTL_MS     = 24 * 60 * 60 * 1000  // 24 hours

class TileCache {
  /**
   * @param {number} maxTiles  maximum number of tile entries
   * @param {number} maxBytes  maximum total byte size (0 = unlimited)
   * @param {number} ttlMs     time-to-live per entry in ms (0 = never expire)
   */
  constructor(maxTiles = DEFAULT_MAX_TILES, maxBytes = DEFAULT_MAX_BYTES, ttlMs = DEFAULT_TTL_MS) {
    this.maxTiles = maxTiles
    this.maxBytes = maxBytes
    this.ttlMs    = ttlMs
    /** @type {Map<string, {buf: Buffer, ts: number}>} ordered newest-first via delete+reinsert */
    this.map = new Map()
    this.totalBytes = 0
    this._hits   = 0
    this._misses = 0
  }

  /** @param {string} key @returns {Buffer|undefined} */
  get(key) {
    const entry = this.map.get(key)
    if (!entry) { this._misses++; return undefined }

    // TTL check
    if (this.ttlMs && Date.now() - entry.ts > this.ttlMs) {
      this._evict(key, entry)
      this._misses++
      return undefined
    }

    // LRU: move to end (most-recent)
    this.map.delete(key)
    this.map.set(key, entry)
    this._hits++
    return entry.buf
  }

  /** @param {string} key @param {Buffer} buf */
  set(key, buf) {
    // Remove existing entry for this key first
    const existing = this.map.get(key)
    if (existing) {
      this.totalBytes -= existing.buf.length
      this.map.delete(key)
    }

    // Evict by count
    while (this.map.size >= this.maxTiles) {
      const oldestKey = this.map.keys().next().value
      const oldestEntry = this.map.get(oldestKey)
      this._evict(oldestKey, oldestEntry)
    }

    // Evict by size
    if (this.maxBytes) {
      while (this.totalBytes + buf.length > this.maxBytes && this.map.size > 0) {
        const oldestKey = this.map.keys().next().value
        const oldestEntry = this.map.get(oldestKey)
        this._evict(oldestKey, oldestEntry)
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

  clear() {
    this.map.clear()
    this.totalBytes = 0
  }

  /** Invalidate all tiles for a specific layer (call after data ingestion) */
  invalidateLayer(layerId) {
    const prefix = `${layerId}/`
    const toDelete = []
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) toDelete.push(key)
    }
    for (const key of toDelete) this.delete(key)
    return toDelete.length
  }

  stats() {
    const total = this._hits + this._misses
    return {
      entries:   this.map.size,
      totalBytes: this.totalBytes,
      totalMB:   (this.totalBytes / 1048576).toFixed(2),
      hits:      this._hits,
      misses:    this._misses,
      hitRate:   total ? `${((this._hits / total) * 100).toFixed(1)}%` : 'n/a',
    }
  }

  _evict(key, entry) {
    this.map.delete(key)
    if (entry) this.totalBytes -= entry.buf.length
  }
}

module.exports = { TileCache }
