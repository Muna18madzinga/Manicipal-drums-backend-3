// src/lib/tileCache.test.js
const { TileCache } = require('./tileCache')

describe('TileCache (L1 LRU only)', () => {
  test('stores and returns a buffer', async () => {
    const c = new TileCache(3)
    const buf = Buffer.from('abc')
    await c.set('k1', buf)
    expect(await c.get('k1')).toBe(buf)
  })

  test('returns undefined for a missing key', async () => {
    expect(await new TileCache(3).get('nope')).toBeUndefined()
  })

  test('evicts the oldest entry past capacity', async () => {
    const c = new TileCache(2)
    await c.set('a', Buffer.from('a'))
    await c.set('b', Buffer.from('b'))
    await c.set('c', Buffer.from('c'))
    expect(await c.get('a')).toBeUndefined()
    expect(await c.get('b')).toBeDefined()
    expect(await c.get('c')).toBeDefined()
  })

  test('touching a key moves it to most-recent (LRU)', async () => {
    const c = new TileCache(2)
    await c.set('a', Buffer.from('a'))
    await c.set('b', Buffer.from('b'))
    await c.get('a')                       // touch a
    await c.set('c', Buffer.from('c'))     // pushes out the LRU, which is b
    expect(await c.get('a')).toBeDefined()
    expect(await c.get('b')).toBeUndefined()
    expect(await c.get('c')).toBeDefined()
  })
})

describe('TileCache (L2 Redis-backed)', () => {
  function fakeRedis() {
    const store = new Map()
    return {
      store,
      async getBuffer(k) { return store.get(k) },
      async set(k, v, _ex, _ttl) { store.set(k, v) },
    }
  }

  test('L1 miss falls through to L2 and promotes', async () => {
    const redis = fakeRedis()
    const c = new TileCache({ capacity: 2, redis })
    // Preload only L2 — directly put into the fake redis store.
    redis.store.set('tile:k', Buffer.from('xyz'))
    const got = await c.get('k')
    expect(got).toBeDefined()
    expect(got.toString()).toBe('xyz')
    // Promoted to L1: clear redis, hit must still resolve.
    redis.store.clear()
    expect(await c.get('k')).toBeDefined()
  })

  test('set writes to both tiers under the configured prefix', async () => {
    const redis = fakeRedis()
    const c = new TileCache({ capacity: 2, redis, keyPrefix: 'mvt:' })
    await c.set('layer/1/2/3', Buffer.from('payload'))
    expect(redis.store.has('mvt:layer/1/2/3')).toBe(true)
  })

  test('redis errors do not break get/set', async () => {
    const redis = {
      async getBuffer() { throw new Error('redis down') },
      async set()       { throw new Error('redis down') },
    }
    const c = new TileCache({ capacity: 2, redis })
    await expect(c.set('k', Buffer.from('v'))).resolves.toBeUndefined()
    // L1 still has it
    expect(await c.get('k')).toBeDefined()
  })
})
