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

const { buildTileQuery } = require('./tileQuery')
const { getLayer } = require('../config/spatialLayers')

describe('buildTileQuery', () => {
  test('builds an MVT query with z/x/y/layer-name bound as params', () => {
    const { sql, params } = buildTileQuery(getLayer('provinces'), 6, 38, 36)
    expect(params).toEqual([6, 38, 36, 'provinces'])
    expect(sql).toMatch(/ST_AsMVT\(/)
    expect(sql).toMatch(/ST_AsMVTGeom/)
    expect(sql).toMatch(/FROM "provinces"/)
    expect(sql).toMatch(/"name_en"/)
  })
  test('omits the low-zoom filter when zoom is at or above maxZoom', () => {
    const { sql } = buildTileQuery(getLayer('roads'), 14, 9000, 9000)
    expect(sql).not.toMatch(/fclass IN/)
  })
  test('applies the low-zoom filter below maxZoom', () => {
    const { sql } = buildTileQuery(getLayer('roads'), 9, 300, 300)
    expect(sql).toMatch(/fclass IN \('motorway'/)
  })
})
