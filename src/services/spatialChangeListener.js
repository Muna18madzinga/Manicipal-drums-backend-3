// src/services/spatialChangeListener.js
// Dedicated Postgres LISTEN connection for real-time QGIS <-> web sync.
//
// Migration 109 attaches a row trigger to every geometry table that fires
// pg_notify('spatial_change', {schema, table, op, id}) on any write — from
// the API, from QGIS Desktop editing PostGIS directly, or from bulk imports.
// This service LISTENs on that channel, coalesces bursts (a QGIS "save
// edits" can commit hundreds of rows at once), invalidates the tile cache
// for the affected layer and pushes one SSE event over the existing
// /api/map/events bus so every open browser tab refreshes just that layer.
// No polling anywhere in the chain.

const { Client } = require('pg')
const { LAYERS } = require('../config/spatialLayers')
const { invalidateTileLayer, emitMapEvent } = require('../routes/tiles')

// table name -> tile-layer id. Most registry entries serve their own table;
// `stands` serves through stands_tile_view, so map its BASE table too —
// triggers live on base tables, never on views.
const TABLE_TO_LAYER = new Map(LAYERS.map((l) => [l.table, l.id]))
TABLE_TO_LAYER.set('stands', 'stands')

const RECONNECT_MIN_MS = 2000
const RECONNECT_MAX_MS = 30000
const FLUSH_MS = 300 // coalesce window for bursts of row notifications

class SpatialChangeListener {
  constructor({ connectionString, log = console }) {
    this.connectionString = connectionString
    this.log = log
    this.client = null
    this.stopped = false
    this.reconnectDelay = RECONNECT_MIN_MS
    this.pending = new Map() // layerId -> { ops: {INSERT: n, ...}, table }
    this.flushTimer = null
    this.stats = { notifications: 0, eventsEmitted: 0, connectedAt: null, reconnects: 0 }
  }

  async start() {
    this.stopped = false
    await this._connect()
  }

  async _connect() {
    if (this.stopped) return
    const client = new Client({ connectionString: this.connectionString })
    try {
      await client.connect()
      await client.query('LISTEN spatial_change')
      this.client = client
      this.reconnectDelay = RECONNECT_MIN_MS
      this.stats.connectedAt = new Date().toISOString()
      this.log.info('[spatial-listener] LISTEN spatial_change active — QGIS/PostGIS edits now push live to browsers')

      client.on('notification', (msg) => this._onNotification(msg))
      client.on('error', (err) => {
        this.log.error({ err }, '[spatial-listener] connection error — reconnecting')
        this._scheduleReconnect()
      })
      client.on('end', () => {
        if (!this.stopped) this._scheduleReconnect()
      })
    } catch (err) {
      this.log.error({ err }, '[spatial-listener] connect failed — retrying')
      try { await client.end() } catch { /* already dead */ }
      this._scheduleReconnect()
    }
  }

  _scheduleReconnect() {
    if (this.stopped) return
    const dead = this.client
    this.client = null
    if (dead) { dead.removeAllListeners(); dead.end().catch(() => {}) }
    this.stats.reconnects++
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS)
    setTimeout(() => { this._connect() }, delay).unref()
  }

  _onNotification(msg) {
    let payload
    try { payload = JSON.parse(msg.payload) } catch { return }
    if (!payload || !payload.table) return
    this.stats.notifications++

    // Registry tables map to their tile-layer id; anything else (qgis_*
    // staging pushes, survey parcels…) is emitted under its own table name
    // so dynamic-layer consumers can react too.
    const layerId = TABLE_TO_LAYER.get(payload.table) || payload.table
    const entry = this.pending.get(layerId) || { ops: {}, table: payload.table }
    entry.ops[payload.op] = (entry.ops[payload.op] || 0) + 1
    this.pending.set(layerId, entry)

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this._flush(), FLUSH_MS)
      this.flushTimer.unref()
    }
  }

  _flush() {
    this.flushTimer = null
    for (const [layerId, entry] of this.pending) {
      try { invalidateTileLayer(layerId) } catch { /* cache miss is fine */ }
      emitMapEvent({
        layer: layerId,
        table: entry.table,
        action: 'changed',
        source: 'postgis',
        ops: entry.ops,
      })
      this.stats.eventsEmitted++
      this.log.info({ layer: layerId, ops: entry.ops }, '[spatial-listener] change pushed to clients')
    }
    this.pending.clear()
  }

  async stop() {
    this.stopped = true
    if (this.flushTimer) { clearTimeout(this.flushTimer); this._flush() }
    const client = this.client
    this.client = null
    if (client) {
      client.removeAllListeners()
      try { await client.end() } catch { /* shutting down */ }
    }
  }

  getStatus() {
    return {
      listening: !!this.client,
      ...this.stats,
      pendingLayers: [...this.pending.keys()],
    }
  }
}

let instance = null

async function startSpatialChangeListener({ connectionString, log }) {
  if (!instance) {
    instance = new SpatialChangeListener({ connectionString, log })
    await instance.start()
  }
  return instance
}

async function stopSpatialChangeListener() {
  if (instance) {
    await instance.stop()
    instance = null
  }
}

function getSpatialListenerStatus() {
  return instance ? instance.getStatus() : { listening: false }
}

module.exports = {
  SpatialChangeListener,
  startSpatialChangeListener,
  stopSpatialChangeListener,
  getSpatialListenerStatus,
}
