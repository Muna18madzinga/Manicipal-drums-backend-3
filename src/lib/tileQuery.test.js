// src/lib/tileQuery.test.js
const { isValidTileCoord } = require('./tileQuery')

describe('isValidTileCoord', () => {
  test('accepts a valid tile coordinate', () => {
    expect(isValidTileCoord(10, 600, 580)).toBe(true)
  })
  test('accepts zoom 0 origin tile', () => {
    expect(isValidTileCoord(0, 0, 0)).toBe(true)
  })
  test('rejects negative zoom', () => {
    expect(isValidTileCoord(-1, 0, 0)).toBe(false)
  })
  test('rejects zoom above 22', () => {
    expect(isValidTileCoord(23, 0, 0)).toBe(false)
  })
  test('rejects x out of range for the zoom', () => {
    expect(isValidTileCoord(1, 2, 0)).toBe(false)
  })
  test('rejects non-integer coordinates', () => {
    expect(isValidTileCoord(10, 1.5, 2)).toBe(false)
  })
})
