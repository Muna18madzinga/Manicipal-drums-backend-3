// src/routes/__tests__/planning-suggest.test.js
// Unit tests for the drafter-output sanitizer and the Claude brief-response
// validator — the two non-trivial pure functions in the route. No DB, no env,
// no network.

const { sanitizeSuggestion, validateBriefResponse } = require('../planning-suggest')

describe('planning-suggest sanitizeSuggestion', () => {
  test('keeps valid roads/zones, clamps width, defaults hierarchy, drops junk', () => {
    const out = sanitizeSuggestion({
      roads: [
        { hierarchy: 'collector', widthM: 20, name: 'Spine', geom: { type: 'LineString', coordinates: [[29.8, -19.4], [29.81, -19.4]] } },
        { widthM: 999, geom: { type: 'LineString', coordinates: [[29.8, -19.4], [29.82, -19.4]] } }, // no hierarchy → 'local', width clamped to 40
        { hierarchy: 'local', geom: { type: 'Point', coordinates: [29.8, -19.4] } },                 // not a LineString → dropped
        { hierarchy: 'local', geom: { type: 'LineString', coordinates: [[29.8, -19.4]] } },          // <2 coords → dropped
      ],
      zones: [
        { use: 'single_residential', geom: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] } },
        { use: 'commercial', geom: { type: 'Polygon', coordinates: [[[2, 2], [2, 3], [3, 3], [2, 2]]] } },
        { use: 'not_a_real_use', geom: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] } }, // unknown use → dropped
        { use: 'school', geom: { type: 'Point', coordinates: [0, 0] } },                              // not a Polygon → dropped
      ],
      notes: ['a', 2, 'b'],
    })
    expect(out).not.toBeNull()
    expect(out.roads).toHaveLength(2)
    expect(out.roads[0]).toMatchObject({ hierarchy: 'collector', widthM: 20, name: 'Spine' })
    expect(out.roads[1]).toMatchObject({ hierarchy: 'local', widthM: 40 }) // defaulted + clamped
    expect(out.zones).toHaveLength(2)
    expect(out.zones.map(z => z.use)).toEqual(['single_residential', 'commercial'])
    expect(out.notes).toEqual(['a', '2', 'b'])
  })

  test('returns null when nothing usable remains', () => {
    expect(sanitizeSuggestion({ roads: [], zones: [], notes: [] })).toBeNull()
    expect(sanitizeSuggestion(null)).toBeNull()
    expect(sanitizeSuggestion({ roads: 'nope' })).toBeNull()
  })
})

describe('planning-suggest validateBriefResponse', () => {
  test('questions mode requires analysis + questions array', () => {
    expect(validateBriefResponse({ analysis: 'ok', questions: [{ id: 'q1', question: 'use?' }] }, false))
      .toMatchObject({ analysis: 'ok' })
    expect(validateBriefResponse({ analysis: 'ok' }, false)).toBeNull()
    expect(validateBriefResponse({ questions: [] }, false)).toBeNull()
  })

  test('brief mode requires brief.zoneBudget array', () => {
    expect(validateBriefResponse({ brief: { summary: 's', zoneBudget: [{ use: 'single_residential', pct: 100, targetHa: 10 }] } }, true))
      .toHaveProperty('brief.summary', 's')
    expect(validateBriefResponse({ brief: { summary: 's' } }, true)).toBeNull()
    expect(validateBriefResponse({ analysis: 'x' }, true)).toBeNull()
  })
})
