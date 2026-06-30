// Pure unit tests for the Property File response mappers (no DB required).
const { toSummary, emptySummary } = require('../properties')

describe('properties response mappers', () => {
  test('emptySummary returns a null-filled record keyed by the stand', () => {
    const s = emptySummary('1234')
    expect(s.stand_number).toBe('1234')
    expect(s.corner_lot).toBe(false)
    expect(s.dev_agreement).toBe(false)
    expect(s.heritage).toBeNull()
    expect(s.area_sqm).toBeNull()
    expect(s.units).toBeNull()
  })

  test('toSummary maps a DB row incl. nested heritage + numeric coercion', () => {
    const row = {
      stand_number: '1234', suburb_ward: 'Ward 5', street_address: '5 Main St',
      aan: 'AAN-1', pid: 'PID-1',
      area_sqm: '600.00', frontage_m: '20.00', units: 2, dwellings: 1,
      corner_lot: true, dev_agreement: false, follow_up_date: '2026-07-01',
      heritage_conservation_district: true, heritage_municipal: false,
      heritage_national: true, heritage_notes: 'listed',
    }
    const s = toSummary(row)
    expect(s.ward).toBe('Ward 5')
    expect(s.address).toBe('5 Main St')
    expect(s.area_sqm).toBe(600)        // coerced from numeric string
    expect(s.frontage_m).toBe(20)
    expect(s.corner_lot).toBe(true)
    expect(s.heritage).toEqual({
      conservation_district: true,
      municipally_designated: false,
      provincially_designated: true,
      notes: 'listed',
    })
  })

  test('toSummary(null) returns null', () => {
    expect(toSummary(null)).toBeNull()
  })
})
