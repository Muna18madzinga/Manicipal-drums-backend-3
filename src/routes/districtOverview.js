
// ── Live district overview for the public landing page ────────────────────
//
// The landing page publishes figures about the district, and until now those
// figures were typed into the template by hand. They are now read out of
// PostGIS, which means they are *the* figures — a ward added to
// public.wards changes the number on the home page and nowhere else has to
// be edited.
//
// WHY THIS IS CACHED AND NOT COMPUTED PER REQUEST
// Summing the length of every road clipped to the district polygon is a
// ~2s query, and the whole set is ~5s. That is fine once every six hours and
// indefensible on every page load by every anonymous visitor, which is also
// the shape of a trivial denial of service. The cache is warmed in the
// background at boot, so the first real visitor is served from memory.
//
// Each figure is its own statement on purpose: a table that is missing in a
// given environment yields null for that one tile, and the page still
// publishes the rest rather than 500ing or — worse — showing a 0 that reads
// as "this district has no roads".

const VUNGU_DISTRICT_PCODE = 'ZW1704'   // Gweru rural district = the Vungu RDC area
const OVERVIEW_TTL_MS = 6 * 60 * 60 * 1000

// `d` is the district polygon. MATERIALIZED stops the planner inlining the
// CTE into each branch of the join, which loses the GiST index.
const DISTRICT_CTE = `WITH d AS MATERIALIZED (
  SELECT geom FROM public.districts WHERE pcode = $1
)`

const FIGURES = {
  // Point-on-surface, not ST_Intersects: 49 ward polygons touch the district
  // boundary but only 19 are *in* the district, and the council has 19 wards.
  wards:      `${DISTRICT_CTE} SELECT count(*)::bigint AS v FROM public.wards w, d WHERE ST_Within(ST_PointOnSurface(w.geom), d.geom)`,
  hectares:   `${DISTRICT_CTE} SELECT round(ST_Area(d.geom::geography) / 10000)::bigint AS v FROM d`,
  roadKm:     `${DISTRICT_CTE} SELECT round(SUM(ST_Length(ST_Intersection(r.geom, d.geom)::geography)) / 1000)::bigint AS v FROM public.roads r, d WHERE ST_Intersects(r.geom, d.geom)`,
  buildings:  `${DISTRICT_CTE} SELECT count(*)::bigint AS v FROM public.buildings b, d WHERE ST_Intersects(b.geom, d.geom)`,
  waterBodies:`${DISTRICT_CTE} SELECT count(*)::bigint AS v FROM public.water_areas w, d WHERE ST_Intersects(w.geom, d.geom)`,
  settlements:`${DISTRICT_CTE} SELECT count(*)::bigint AS v FROM public.places_points p, d WHERE ST_Intersects(p.geom, d.geom)`,
  // Council-held registers. Already Vungu-only, so no district clip.
  parcels:    `SELECT count(*)::bigint AS v FROM public.vungu_parcels`,
  farms:      `SELECT count(*)::bigint AS v FROM public.vungu_farm_cadastre`,
  planningZones: `SELECT (
                    (SELECT count(*) FROM public.proposed_peri_urban_zones)
                  + (SELECT count(*) FROM public.vungu_beyond_peri_urban_zones)
                  )::bigint AS v`,
}

/** Figures that take the district pcode as $1. */
const NEEDS_DISTRICT = new Set(['wards', 'hectares', 'roadKm', 'buildings', 'waterBodies', 'settlements'])

function registerDistrictOverview(fastify) {
  /** @type {{ figures: Record<string, number|null>, asOf: string } | null} */
  let cache = null
  let inFlight = null
  let timer = null

  async function compute() {
    const entries = await Promise.all(
      Object.entries(FIGURES).map(async ([key, sql]) => {
        try {
          const params = NEEDS_DISTRICT.has(key) ? [VUNGU_DISTRICT_PCODE] : []
          const { rows } = await fastify.pg.query(sql, params)
          const raw = rows[0] && rows[0].v
          // count()/round() come back as strings from node-postgres (bigint).
          const value = raw == null ? null : Number(raw)
          return [key, Number.isFinite(value) ? value : null]
        } catch (err) {
          fastify.log.warn({ err, figure: key }, 'district overview figure unavailable')
          return [key, null]
        }
      }),
    )
    return { figures: Object.fromEntries(entries), asOf: new Date().toISOString() }
  }

  /** Serve the cache; recompute only when it is empty or past its TTL. */
  function refresh() {
    if (inFlight) return inFlight
    inFlight = compute()
      .then((next) => { cache = next; return next })
      .catch((err) => {
        fastify.log.error({ err }, 'district overview refresh failed')
        return cache            // keep serving the last good answer
      })
      .finally(() => { inFlight = null })
    return inFlight
  }

  function isStale() {
    return !cache || Date.now() - Date.parse(cache.asOf) > OVERVIEW_TTL_MS
  }

  fastify.get('/public/district-overview', async (_request, reply) => {
    // Stale-while-revalidate: a warm cache answers immediately and the
    // refresh happens behind the response. Only a cold start waits.
    if (isStale()) {
      const pending = refresh()
      if (!cache) await pending
    }
    if (!cache) {
      return reply.code(503).send({ error: 'overview_unavailable', message: 'District figures are being computed. Try again shortly.' })
    }
    reply.header('Cache-Control', 'public, max-age=900')
    return {
      district: { name: 'Vungu Rural District Council', province: 'Midlands', pcode: VUNGU_DISTRICT_PCODE },
      asOf: cache.asOf,
      figures: cache.figures,
    }
  })

  // Warm at boot so the first visitor is not the one who pays for the scan,
  // then keep it warm. unref() so the timer never holds the process open.
  // onReady, not fastify.ready(cb): calling .ready() from inside a plugin
  // during boot re-enters the boot sequence.
  fastify.addHook('onReady', async () => {
    refresh()                                  // deliberately not awaited
    timer = setInterval(refresh, OVERVIEW_TTL_MS)
    if (typeof timer.unref === 'function') timer.unref()
  })
  fastify.addHook('onClose', async () => { if (timer) clearInterval(timer) })
}

module.exports = { registerDistrictOverview, FIGURES, VUNGU_DISTRICT_PCODE }
