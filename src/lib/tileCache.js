// src/lib/tileCache.js
// Bounded in-process cache for rendered MVT tiles. Insertion-order Map =
// simple FIFO eviction. This avoids a Redis dependency; the browser
// Cache-Control header carries most of the repeat-request load anyway.

class TileCache {
  /** @param {number} capacity max number of tiles to retain */
  constructor(capacity = 2000) {
    this.capacity = capacity
    /** @type {Map<string, Buffer>} */
    this.map = new Map()
  }

  /** @param {string} key @returns {Buffer|undefined} */
  get(key) {
    return this.map.get(key)
  }

  /** @param {string} key @param {Buffer} value */
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
  }

  clear() {
    this.map.clear()
  }
}

module.exports = { TileCache }
