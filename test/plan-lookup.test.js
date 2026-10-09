jest.mock('../src/middleware/jwtAuth', () => ({ optionalAuth: () => async () => {}, requireAuth: () => async () => {}, requireRole: () => async () => {} }))
const { makePg } = require('./helpers/fakePg')
const { planLookupRoutes, parseQuery, NOTICE } = require('../src/routes/planLookup')

function makeServer(queryImpl) {
  const routes = {}
  const fake = makePg(queryImpl)
  const server = { pg: fake.pg, log: { error() {} }, get: (path, ...rest) => { routes['GET ' + path] = { handler: rest[rest.length - 1], opts: rest.length > 1 ? rest[0] : {} } } }
  const call = async (key, request) => {
    const reply = { statusCode: 200, body: null }
    reply.code = (c) => { reply.statusCode = c; return reply }
    reply.send = (b) => { reply.body = b; return reply }
    const out = await routes[key].handler({ query: {}, params: {}, log: { error() {} }, ...request }, reply)
    if (reply.body === null) reply.body = out   // a handler may return its result instead of sending it
    return { out, reply }
  }
  return { server, call, routes, fake }
}
const setup = async (impl) => { const s = makeServer(impl); await planLookupRoutes(s.server); return s }

describe('what a search may contain', () => {
  test('a stand number or a farm name, nothing that could be code or a wildcard flood', () => {
    expect(parseQuery('Dorset Farm 12')).toBe('Dorset Farm 12')
    expect(parseQuery('  1234/5  ')).toBe('1234/5')
    expect(parseQuery("Ndlovu's Estate")).toBe("Ndlovu's Estate")
    expect(parseQuery('Mhlanga-Ndebele')).toBe('Mhlanga-Ndebele')
    expect(parseQuery('a')).toBeNull()
    expect(parseQuery('x'.repeat(65))).toBeNull()
    expect(parseQuery("1'; DROP TABLE stands; --")).toBeNull()
    expect(parseQuery('<script>alert(1)</script>')).toBeNull()
    expect(parseQuery('%%')).toBeNull()
    expect(parseQuery(['a', 'b'])).toBeNull()
  })
  test('both routes are rate limited', async () => {
    const { routes } = await setup(async () => ({ rows: [] }))
    expect(routes['GET /plan-lookup/search'].opts.config.rateLimit.max).toBeLessThanOrEqual(60)
    expect(routes['GET /plan-lookup/:layer/:id'].opts.config.rateLimit.max).toBeLessThanOrEqual(60)
  })
})

describe('search', () => {
  test('a bad term is a 400 in plain words and touches nothing', async () => {
    const { call, fake } = await setup(async () => ({ rows: [] }))
    const { reply } = await call('GET /plan-lookup/search', { query: { q: 'x' } })
    expect(reply.statusCode).toBe(400)
    expect(reply.body.message).toMatch(/at least two/)
    expect(fake.pg.query).not.toHaveBeenCalled()
  })

  test('finds stands and farm parcels, stands first, capped at eight, with wildcards escaped', async () => {
    const seen = []
    const { call } = await setup(async (sql, params) => {
      seen.push({ sql, params })
      if (/FROM stands/.test(sql)) return { rows: Array.from({ length: 6 }, (_, i) => ({ layer: 'stands', id: `s${i}`, label: `S-${i}`, place: 'Ward 3', area_ha: '0.05' })) }
      return { rows: Array.from({ length: 6 }, (_, i) => ({ layer: 'vungu_parcels', id: `${i}`, label: `Farm ${i}`, place: 'Gweru', area_ha: '12.5' })) }
    })
    expect((await call('GET /plan-lookup/search', { query: { q: '50%_off' } })).reply.statusCode).toBe(400)   // a wildcard is not a valid term at all
    const ok = await call('GET /plan-lookup/search', { query: { q: 'Farm' } })
    expect(ok.reply.body.count).toBe(8)
    expect(ok.reply.body.data[0]).toMatchObject({ layer: 'stands', label: 'S-0', place: 'Ward 3', area_ha: 0.05 })
    expect(ok.reply.body.data[7].layer).toBe('vungu_parcels')
    expect(seen.every((s) => s.params[0] === '%Farm%')).toBe(true)
  })

  test('selects only name, place and area: never ownership or price', async () => {
    const seen = []
    const { call } = await setup(async (sql) => { seen.push(sql); return { rows: [] } })
    await call('GET /plan-lookup/search', { query: { q: 'Dorset' } })
    expect(seen.join(' ')).not.toMatch(/owner|price|national_id|phone|email/i)
  })
})

describe('lookup', () => {
  const zoneRow = (over = {}) => ({
    zone_id: 7, zone_name: 'Mixed Density Residential', share_pct: '100.0', governing: true,
    plan_id: 'p1', plan_title: 'Vungu local plan', plan_version: 1, plan_status: 'gazetted', gazette_ref: 'SI 9 of 2027', effective_from: '2027-01-01',
    authority_name: 'Vungu RDC', provisional: false, zone_type_code: 'Mixed Density Residential', review_status: 'reviewed', reviewed_by: 'T. Dube', uses_in_plan: 5, ...over,
  })
  const useRows = [
    { group_code: 'A', group_description: 'Detached dwelling houses', group_category: 'residential', control_type: 'permitted', conditions: null },
    { group_code: 'D', group_description: 'Shops', group_category: 'commercial', control_type: 'special_consent', conditions: 'Trading hours 6am to 8pm' },
    { group_code: 'M', group_description: 'Industrial buildings', group_category: 'industrial', control_type: 'prohibited', conditions: null },
  ]
  const impl = (zones, uses = useRows) => async (sql) => {
    if (/parcel_geometry/.test(sql)) return { rows: [{ found: true }] }
    if (/FROM vungu_parcels WHERE fid/.test(sql)) return { rows: [{ label: 'Dorset Farm 12', place: 'Gweru', area_ha: '12.5' }] }
    if (/parcel_zoning_for/.test(sql)) return { rows: zones }
    if (/zone_effective_controls/.test(sql)) return { rows: uses }
    return { rows: [] }
  }
  const lookup = (s) => s.call('GET /plan-lookup/:layer/:id', { params: { layer: 'vungu_parcels', id: '42' } })

  test('refuses an unknown layer or a hostile id before touching the database', async () => {
    const s = await setup(impl([]))
    expect((await s.call('GET /plan-lookup/:layer/:id', { params: { layer: 'users', id: '1' } })).reply.statusCode).toBe(400)
    expect((await s.call('GET /plan-lookup/:layer/:id', { params: { layer: 'stands', id: "1'; --" } })).reply.statusCode).toBe(400)
    expect(s.fake.pg.query).not.toHaveBeenCalled()
  })

  test('names a parcel of the one parcel model (land.parcel) by its stand number, ward and area', async () => {
    const s = await setup(async (sql) => {
      if (/parcel_geometry/.test(sql)) return { rows: [{ found: true }] }
      if (/FROM land.parcel l/.test(sql)) return { rows: [{ label: 'Dorset Farm 12', place: 'Ward 14', area_ha: '12.5' }] }
      return { rows: [] }
    })
    const { reply } = await s.call('GET /plan-lookup/:layer/:id', { params: { layer: 'land.parcel', id: 'VP-12' } })
    expect(reply.body.data.parcel).toMatchObject({ layer: 'land.parcel', id: 'VP-12', label: 'Dorset Farm 12', place: 'Ward 14', area_ha: 12.5 })
  })

  test('an unknown parcel is a 404', async () => {
    const s = await setup(async (sql) => (/parcel_geometry/.test(sql) ? { rows: [{ found: false }] } : { rows: [] }))
    expect((await lookup(s)).reply.statusCode).toBe(404)
  })

  test('a parcel with no plan the caller may see is "not published": the same answer as an unzoned one', async () => {
    const s = await setup(impl([]))
    const { reply } = await lookup(s)
    expect(reply.body.data).toMatchObject({ published: false, provisional: false, results: [] })
    expect(reply.body.data.parcel).toMatchObject({ label: 'Dorset Farm 12', place: 'Gweru', area_ha: 12.5 })
    expect(reply.body.data.notice).toBe(NOTICE)
  })

  test('a gazetted plan: the zone, and the uses grouped as permitted, consent and not allowed, with conditions', async () => {
    const s = await setup(impl([zoneRow()]))
    const d = (await lookup(s)).reply.body.data
    expect(d.published).toBe(true)
    expect(d.provisional).toBe(false)
    const r = d.results[0]
    expect(r.plan).toMatchObject({ title: 'Vungu local plan', status: 'gazetted', gazette_ref: 'SI 9 of 2027', provisional: false, authority: 'Vungu RDC' })
    expect(r.zone.name).toBe('Mixed Density Residential')
    expect(r.uses.permitted.map((u) => u.code)).toEqual(['A'])
    expect(r.uses.special_consent[0]).toMatchObject({ code: 'D', conditions: 'Trading hours 6am to 8pm' })
    expect(r.uses.prohibited.map((u) => u.code)).toEqual(['M'])
    expect(r.not_decided).toBe(2)                       // 5 uses in the plan, 3 decided
  })

  test('a draft seen by staff is marked provisional, never presented as policy', async () => {
    const s = await setup(impl([zoneRow({ plan_status: 'draft', provisional: true, gazette_ref: null, review_status: 'unreviewed', reviewed_by: null })]))
    const d = (await lookup(s)).reply.body.data
    expect(d.provisional).toBe(true)
    expect(d.results[0].plan.provisional).toBe(true)
    expect(d.results[0].zone.review_status).toBe('unreviewed')
  })

  test('the zone and decisions are read as the person asking, so the database decides what they may see', async () => {
    const s = await setup(impl([zoneRow()]))
    await lookup(s)
    expect(s.fake.pg.connect).toHaveBeenCalled()        // the zone and uses ran through the tenancy helper
    const sqls = s.fake.calls.map((c) => c.sql).join('\n')
    expect(sqls).toMatch(/parcel_zoning_for/)
    expect(sqls).toMatch(/zone_effective_controls/)
  })

  test('a parcel in two plans returns both, the governing one first', async () => {
    const s = await setup(impl([zoneRow(), zoneRow({ zone_id: 8, governing: false, share_pct: '20', plan_id: 'p2', plan_title: 'Other plan' })]))
    const d = (await lookup(s)).reply.body.data
    expect(d.results.map((r) => r.governing)).toEqual([true, false])
    expect(d.results[1].plan.title).toBe('Other plan')
  })
})
