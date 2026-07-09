// src/routes/__tests__/planning-suggest.test.js
// Unit test for the NIM proxy's response sanitizer — the only non-trivial logic
// that isn't a one-line guard. No DB, no env, no network (pure function).

const { sanitizeSuggestion } = require('../planning-suggest')

describe('planning-suggest sanitizeSuggestion', () => {
  test('keeps valid roads/zones and drops junk', () => {
    const out = sanitizeSuggestion({
      roads: [
        { type: 'LineString', coordinates: [[29.8, -19.4], [29.81, -19.4]] },
        { type: 'Point', coordinates: [29.8, -19.4] },        // wrong type → dropped
        { type: 'LineString', coordinates: [[29.8, -19.4]] },  // <2 coords → dropped
      ],
      zones: [
        { use: 'single_residential', geom: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] } },
        { use: 'x', geom: { type: 'Point', coordinates: [0, 0] } }, // not a Polygon → dropped
      ],
      notes: ['a', 2, 'b'],
    })
    expect(out).not.toBeNull()
    expect(out.roads).toHaveLength(1)
    expect(out.zones).toHaveLength(1)
    expect(out.notes).toEqual(['a', '2', 'b'])
  })

  test('returns null when nothing usable remains', () => {
    expect(sanitizeSuggestion({ roads: [], zones: [], notes: [] })).toBeNull()
    expect(sanitizeSuggestion(null)).toBeNull()
    expect(sanitizeSuggestion({ roads: 'nope' })).toBeNull()
  })
})
