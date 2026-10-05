// src/services/syncCoverage.js
// ─────────────────────────────────────────────────────────────────────────────
// Reports, for every layer in the spatial registry, whether a row written to
// that layer actually reaches an open browser tab. One row per layer, one
// boolean that matters: `syncs`.
//
// WHY THIS EXISTS
// A break anywhere in the QGIS -> web chain is silent. The chain is
//
//   QGIS Desktop
//     -> PostGIS row write                     (always succeeds, silently)
//     -> trg_notify_spatial_change             (absent? nothing is broadcast)
//     -> LISTEN on 'spatial_change'            (backend)
//     -> table -> tile-layer id lookup         (unmapped? wrong source id)
//     -> tile cache invalidation               (missed? stale tiles for 24h)
//     -> SSE /api/map/events
//     -> getSource('vungu-' + layerId)         (no such source? undefined)
//     -> setTiles                              (map repaints)
//
// Every one of those steps fails quietly. On 2026-10-05 the zones layer was
// missing both the trigger and the base-table mapping, so a planner's QGIS save
// produced no browser update and no screen in the application could say why —
// it took four ad-hoc psql sessions to find. This report is that missing
// screen, as data.
//
// IT REPORTS THE WIRING, NOT A PROBE
// A static read of the registry plus two catalogue queries. It never writes to
// a table to see whether a notification fires, so it is safe against production
// and safe to poll. What it proves is that the chain is connected end to end
// for that layer; it cannot prove QGIS Desktop is currently open, nor that its
// edits carry attributes, nor that a particular save actually happened.
//
// THE MAPPING IS IMPORTED, NOT RE-DERIVED
// resolveLayerIdForTable comes from spatialChangeListener — the same function
// the live notification path calls. A second implementation of that lookup is
// precisely how the original defect stayed invisible: the report would have
// said "resolvable" while the listener fell through to the raw table name.

const { allLayers } = require('../config/spatialLayers')
const { resolveLayerIdForTable, getSpatialListenerStatus } = require('./spatialChangeListener')

// The frontend names every source `vungu-` + layer id (src/map/vunguBasemap.ts,
// addVunguBasemap). Spelled out as a constant because the failure of getting it
// wrong is a silent no-op on getSource(), which is the whole reason this file
// exists.
const SOURCE_PREFIX = 'vungu-'

const TRIGGER_NAME = 'trg_notify_spatial_change'

/**
 * pg_trigger.tgenabled values, and which ones actually fire a notification.
 *
 *   'O'  origin     — enabled, fires in normal operation. This is what
 *                     migration 109 creates.
 *   'D'  disabled   — the trigger EXISTS but is inert. `ALTER TABLE … DISABLE
 *                     TRIGGER` leaves the row in pg_trigger, so any check that
 *                     only asks "is the trigger there" reports a healthy layer
 *                     whose changes are never broadcast. This exact false
 *                     negative is why the state is read rather than inferred.
 *   'R'  replica    — fires only during logical replication of the standby, not
 *                     for an ordinary write.
 *   'A'  always     — fires regardless of role, which also works.
 *
 * 'D' and 'R' are distinguished in the report rather than collapsed, because
 * the fix differs: re-enable versus never meant to fire locally.
 */
const TRIGGER_FIRING = new Set(['O', 'A'])
const TRIGGER_STATE_TEXT = {
  O: 'enabled',
  A: 'enabled',
  D: 'disabled',
  R: 'replica only',
}

// pg_class.relkind -> the word we use in the report.
const RELKIND = {
  r: 'table',
  v: 'view',
  m: 'materialized view',
  p: 'partitioned table',
  f: 'foreign table',
}

/**
 * Every relation in `public` with its notify-trigger state and a live-row
 * estimate, in one query. Restricting relkind to (r,v,m,p,f) drops indexes,
 * sequences, TOAST and composite types, none of which a registry entry names.
 *
 * n_live_tup is the planner's estimate from pg_stat_user_tables, not count(*).
 * An exact count over every spatial table is a minute of I/O to draw one
 * column, so the report labels it as the estimate it is.
 */
async function readRelations(pg) {
  const { rows } = await pg.query(
    `SELECT c.relname                                   AS relation,
            c.relkind,
            (SELECT t.tgenabled
               FROM pg_trigger t
              WHERE t.tgrelid = c.oid
                AND t.tgname = $1
                AND NOT t.tgisinternal
              LIMIT 1)                               AS trigger_enabled,
            COALESCE(s.n_live_tup, 0)::bigint          AS approx_rows,
            -- pg_class.reltuples is -1 until the table has been analysed, and
            -- n_live_tup reads 0 forever if autovacuum never ran. A Vungu
            -- database in that state would show "0 rows" for a 672-row table,
            -- so the report refuses to state a number it cannot stand behind.
            (s.last_analyze IS NOT NULL OR s.last_autoanalyze IS NOT NULL)
                                                       AS stats_collected
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r','v','m','p','f')`,
    [TRIGGER_NAME],
  )
  const byName = new Map()
  for (const r of rows) byName.set(r.relation, r)
  return byName
}

/**
 * Which BASE tables each named view reads from.
 *
 * This step has no counterpart in the registry: spatialLayers.js records
 * `zones_master`, a view, while the trigger can only sit on
 * `proposed_peri_urban_zones` underneath it. pg_depend + pg_rewrite is how
 * Postgres records a view's source relations, so the report asks the catalogue
 * rather than keeping its own hand-written list of base tables to fall out of
 * date the moment someone adds a view.
 */
async function readViewBases(pg, viewNames) {
  if (!viewNames.length) return new Map()
  const { rows } = await pg.query(
    `SELECT DISTINCT vw.relname AS view, src.relname AS base
       FROM pg_depend d
       JOIN pg_rewrite r ON r.oid = d.objid
       JOIN pg_class vw  ON vw.oid = r.ev_class
       JOIN pg_class src ON src.oid = d.refobjid
      WHERE vw.relname = ANY($1::text[])
        AND src.relkind IN ('r','p','m')
        AND src.relname <> vw.relname`,
    [viewNames],
  )
  const byView = new Map(viewNames.map((v) => [v, []]))
  for (const r of rows) {
    const list = byView.get(r.view)
    if (list) list.push(r.base)
  }
  for (const list of byView.values()) list.sort()
  return byView
}

/**
 * Build the coverage report.
 *
 * @param {object} pg   a @fastify/postgres instance (server.pg)
 * @returns {Promise<object>} { listener, summary, layers, unrouted }
 */
async function buildSyncCoverage(pg) {
  const layers = allLayers()
  const knownLayerIds = new Set(layers.map((l) => l.id))

  const relations = await readRelations(pg)

  // Only non-table registry entries need the catalogue lookup. There are two.
  const viewNames = layers
    .map((l) => relations.get(l.table))
    .filter((r) => r && r.relkind !== 'r' && r.relkind !== 'p')
    .map((r) => r.relation)
  const viewBases = await readViewBases(pg, viewNames)

  const rows = layers.map((l) => {
    const rel = relations.get(l.table)
    const relkind = rel ? RELKIND[rel.relkind] || rel.relkind : null
    const isView = !!rel && rel.relkind !== 'r' && rel.relkind !== 'p'

    // Where a NOTIFY for this layer can actually originate. For a plain table
    // that is the table itself; for a view it is the base table(s) it reads,
    // because a trigger cannot be attached to a view.
    const notifyTables = isView ? (viewBases.get(l.table) || []) : rel ? [l.table] : []

    // Per notify table: is the trigger there, and does the table resolve to
    // THIS layer? The second half is the defect that survived longest — the
    // notification was broadcast under an id no browser source carries.
    const legs = notifyTables.map((t) => {
      const tRel = relations.get(t)
      const resolvedLayerId = resolveLayerIdForTable(t)
      return {
        table: t,
        exists: !!tRel,
        triggerAttached: !!tRel && tRel.trigger_enabled !== null && tRel.trigger_enabled !== undefined,
        // Present in pg_trigger is not the same as firing. A DISABLED trigger
        // broadcasts nothing, and reads as healthy to any existence check.
        triggerFires: !!tRel && TRIGGER_FIRING.has(tRel.trigger_enabled),
        triggerState: tRel?.trigger_enabled ? (TRIGGER_STATE_TEXT[tRel.trigger_enabled] ?? tRel.trigger_enabled) : null,
        resolvesToThisLayer: resolvedLayerId === l.id,
        resolvesTo: resolvedLayerId,
        browserSourceId: SOURCE_PREFIX + resolvedLayerId,
        // Can this id name a source in the browser? Sources are only ever
        // created for registry ids, so a resolved id outside the registry is
        // an event nobody renders.
        sourceRegistered: knownLayerIds.has(resolvedLayerId),
      }
    })

    // The one boolean that answers "will my QGIS edit show up".
    const syncs = legs.length > 0
      && legs.every((x) => x.exists && x.triggerAttached && x.triggerFires && x.resolvesToThisLayer)

    let breakStage = null
    let remedy = null
    if (!rel) {
      breakStage = 'relation-missing'
      remedy = `The registry names "${l.table}" but no such relation exists in schema public, so `
             + 'the layer can neither serve tiles nor broadcast edits. The table was renamed, dropped, '
             + 'or never loaded.'
    } else if (legs.length === 0) {
      breakStage = 'view-without-base-table'
      remedy = `"${l.table}" is a ${relkind} that reads from no base table, so no trigger can ever fire for it.`
    } else if (legs.some((x) => !x.exists)) {
      breakStage = 'base-table-missing'
      remedy = `"${l.table}" reads from a relation that does not exist in schema public.`
    } else if (legs.some((x) => !x.triggerAttached)) {
      const missing = legs.filter((x) => !x.triggerAttached).map((x) => x.table).join(', ')
      breakStage = 'trigger-missing'
      remedy = `No ${TRIGGER_NAME} on ${missing}, so a write there broadcasts nothing. This is the `
             + 'exact break of 2026-10-05. Attach it with: '
             + 'node scripts/apply-local-migration.js 109_spatial_change_notify.sql'
    } else if (legs.some((x) => x.triggerAttached && !x.triggerFires)) {
      // Present but inert. The dangerous one: an existence check says healthy.
      const inert = legs.filter((x) => x.triggerAttached && !x.triggerFires)
        .map((x) => `${x.table} (${x.triggerState})`).join(', ')
      breakStage = 'trigger-disabled'
      remedy = `${TRIGGER_NAME} exists on ${inert} but does not fire, so changes are saved and never `
             + 'broadcast. The trigger is present, so nothing else reports it as missing. Fix with: '
             + `ALTER TABLE <table> ENABLE TRIGGER ${TRIGGER_NAME};`
    } else if (legs.some((x) => !x.resolvesToThisLayer)) {
      const bad = legs.filter((x) => !x.resolvesToThisLayer)
      breakStage = 'unmapped-notify-table'
      remedy = `The trigger fires and the event is broadcast, but ${bad.map((x) => x.table).join(', ')} `
             + `resolves to "${bad[0].resolvesTo}" rather than "${l.id}". The browser looks for a source named `
             + `"${bad[0].browserSourceId}", which no registry entry creates, so the refresh is a silent no-op. `
             + 'Add the base table to TABLE_TO_LAYER in src/services/spatialChangeListener.js.'
    }

    return {
      layerId: l.id,
      title: l.title,
      group: l.group,
      geomType: l.geomType,
      registryTable: l.table,
      relationKind: relkind,
      isView,
      notifyTables,
      legs,
      syncs,
      browserSourceId: legs.length ? legs[0].browserSourceId : null,
      breakStage,
      remedy,
      // The whole path in one string, for a column that has to fit a phone.
      chain: [l.table, ...notifyTables].join(' \u2192 ') + ' \u2192 ' + (legs.length ? legs[0].browserSourceId : '(unresolved)'),
    }
  })

  /**
 * Exact row counts for the relations the report is going to warn about.
 *
 * n_live_tup is useless here: a Vungu database that has never been ANALYZE'd
 * reports 0 for every table, including the 672-row gweru_rural_farms, and a
 * "0 rows" warning reads as "empty, drop it" when it is not. But an exact
 * count(*) over twenty-four spatial layers is a minute of I/O, so this only
 * runs over the handful of relations already flagged as suspicious, and only
 * below a size ceiling — anything larger keeps the null rather than stalling a
 * diagnostic screen.
 */
const COUNTABLE_BYTES = 64 * 1024 * 1024
const MAX_COUNTED = 60

async function countSuspects(pg, relations) {
  const out = new Map()
  if (!relations.length) return out
  const { rows } = await pg.query(
    `SELECT c.relname AS relation, pg_total_relation_size(c.oid) AS bytes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [relations.map((r) => r.relation)],
  )
  const small = rows.filter((r) => Number(r.bytes) <= COUNTABLE_BYTES).slice(0, MAX_COUNTED)
  for (const r of small) {
    // relname is from pg_class, not from user input, but quote anyway — the
    // identifier is interpolated because count(*) cannot be parameterised.
    try {
      const c = await pg.query(`SELECT count(*)::int AS n FROM public."${r.relation.replace(/"/g, '""')}"`)
      out.set(r.relation, c.rows[0].n)
    } catch {
      // A relation we cannot count is left unstated rather than reported wrong.
    }
  }
  return out
}

// Every relation a registry layer is actually served from or triggered on.
  const backingRelations = new Set(rows.flatMap((r) => [r.registryTable, ...r.notifyTables]))

  // Triggers that broadcast to nobody. These are NOT registry layers, so no row
  // above can report them: a relation carrying the trigger whose resolved id is
  // not in the registry emits an SSE event that no browser source can consume.
  // The gweru_* group is real data (a second council's boundaries) that nothing
  // serves; layer_data and places are empty leftovers.
  // Only FIRING triggers belong in these lists. An inert trigger broadcasts
  // nothing, so listing it would overstate the wiring problems; conversely it
  // must not be silently dropped either, which is why the check uses the same
  // TRIGGER_FIRING set as the layer verdict.
  const fires = (r) => TRIGGER_FIRING.has(r.trigger_enabled)
  const unroutedRel = [...relations.values()]
    .filter((r) => fires(r) && !knownLayerIds.has(resolveLayerIdForTable(r.relation)))
  const shadowedRel = [...relations.values()]
    .filter((r) => fires(r)
      && knownLayerIds.has(resolveLayerIdForTable(r.relation))
      && !backingRelations.has(r.relation))
  const counts = await countSuspects(pg, [...unroutedRel, ...shadowedRel])

  const rowsFor = (rel) => ({
    approxRows: counts.has(rel.relation)
      ? counts.get(rel.relation)
      : (rel.stats_collected ? Number(rel.approx_rows) : null),
    // Whether the number above is a real count or a planner estimate. The page
    // labels it, because "1 row" and "1 estimated row" mean different things
    // when deciding whether to drop a table.
    exact: counts.has(rel.relation),
    statsCollected: !!rel.stats_collected,
  })

  const unrouted = unroutedRel
    .map((r) => ({
      relation: r.relation,
      relationKind: RELKIND[r.relkind] || r.relkind,
      ...rowsFor(r),
      resolvesTo: resolveLayerIdForTable(r.relation),
      browserSourceId: SOURCE_PREFIX + resolveLayerIdForTable(r.relation),
      note: 'Writes here broadcast an event under a layer id the browser has no source for. '
          + 'Either drop the table, or register the layer and serve it.',
    }))
    .sort((a, b) => (b.approxRows ?? -1) - (a.approxRows ?? -1) || a.relation.localeCompare(b.relation))

  // Relations that resolve to a registry id but are NOT that layer's backing
  // table. vungu_proposed_peri_urban_zones is exactly this: an orphan copy of
  // the zones table that docs/SSOT-spatial.md records as dropped on 2026-07-23
  // and which was never dropped. Its writes fire the trigger and evict the real
  // zones tile cache, then tell the browser to refresh the zones source — which
  // re-renders tiles served from zones_master, so the edit appears accepted and
  // nothing changes. That is worse than a clean no-op: it looks like it worked.
  // Caught here because a bare "is the id routable" check says yes, and the only
  // thing that catches it is asking whether this relation is the one the registry
  // actually reads.
  const shadowed = shadowedRel
    .map((r) => ({
      relation: r.relation,
      relationKind: RELKIND[r.relkind] || r.relkind,
      ...rowsFor(r),
      claimsLayerId: resolveLayerIdForTable(r.relation),
      note: 'This relation fires the trigger under a real layer id but is not the table the '
          + 'registry serves that layer from, so its writes invalidate the right cache and change '
          + 'nothing on the map. Almost certainly a leftover copy.',
    }))
    .sort((a, b) => a.relation.localeCompare(b.relation))

  const broken = rows.filter((r) => !r.syncs)
  const listener = getSpatialListenerStatus()
  const triggersInert = [...relations.values()]
    .filter((r) => r.trigger_enabled && !fires(r))
    .map((r) => ({ relation: r.relation, state: TRIGGER_STATE_TEXT[r.trigger_enabled] }))
    .sort((a, b) => a.relation.localeCompare(b.relation))

  return {
    listener: {
      ...listener,
      // The counters are process-lifetime and read 0 after every restart. With
      // this field the page can say "since <connectedAt>", so the first screen a
      // user opens does not read "0 notifications" and look broken.
      countersSince: listener.connectedAt || null,
    },
    summary: {
      layers: rows.length,
      syncing: rows.length - broken.length,
      broken: broken.length,
      triggersAttached: [...relations.values()].filter((r) => r.trigger_enabled !== null).length,
      // Present but never firing. Called out separately because it is invisible
      // to a trigger count — the 2026-10-05 audit counted 29 and looked clean
      // partly for this reason.
      triggersInert,
      unroutedTriggers: unrouted.length,
      shadowedTriggers: shadowed.length,
      // The single number a page opens on: anything other than 0 is a break
      // somewhere in the wiring, and every one of them is listed below.
      wiringProblems: broken.length + unrouted.length + shadowed.length + triggersInert.length,
      // Ordered by stage, which is the order a reader diagnoses in.
      breaks: broken
        .sort((a, b) => a.layerId.localeCompare(b.layerId))
        .map((r) => ({ layerId: r.layerId, title: r.title, stage: r.breakStage, remedy: r.remedy })),
    },
    layers: rows,
    unrouted,
    shadowed,
  }
}

module.exports = { buildSyncCoverage, SOURCE_PREFIX, TRIGGER_NAME }