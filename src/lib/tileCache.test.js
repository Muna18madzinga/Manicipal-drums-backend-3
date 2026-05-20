// src/lib/tileCache.test.js
const { TileCache } = require('./tileCache')

describe('TileCache', () => {
  test('stores and returns a buffer', () => {
    const c = new TileCache(3)
    const buf = Buffer.from('abc')
    c.set('k1', buf)
    expect(c.get('k1')).toBe(buf)
  })
  test('returns undefined for a missing key', () => {
    expect(new TileCache(3).get('nope')).toBeUndefined()
  })
  test('evicts the oldest entry past capacity', () => {
    const c = new TileCache(2)
    c.set('a', Buffer.from('a'))
    c.set('b', Buffer.from('b'))
    c.set('c', Buffer.from('c'))
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBeDefined()
    expect(c.get('c')).toBeDefined()
  })
})
