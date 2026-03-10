/**
 * Real-time Update Broadcaster
 * ============================
 * 
 * Broadcasts QGIS project changes to connected clients via WebSocket/SSE.
 * Ensures applicants always see the latest map data.
 */

const { EventEmitter } = require('events')

class UpdateBroadcaster extends EventEmitter {
  constructor() {
    super()
    this.clients = new Set()
    this.lastUpdate = null
  }

  // Add a new client connection
  addClient(response, clientId = null) {
    const id = clientId || `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    
    const client = {
      id,
      response,
      connectedAt: Date.now()
    }
    
    this.clients.add(client)
    
    // Setup SSE headers
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })
    
    // Send initial connection message
    this.sendToClient(client, {
      type: 'connected',
      message: 'Real-time updates active',
      timestamp: Date.now()
    })
    
    // Remove client on disconnect
    response.on('close', () => {
      this.removeClient(id)
    })
    
    console.log(`[Broadcaster] 👤 Client connected: ${id} (Total: ${this.clients.size})`)
    return id
  }

  // Remove a client
  removeClient(clientId) {
    for (const client of this.clients) {
      if (client.id === clientId) {
        this.clients.delete(client)
        console.log(`[Broadcaster] 👋 Client disconnected: ${clientId} (Total: ${this.clients.size})`)
        break
      }
    }
  }

  // Send message to specific client
  sendToClient(client, data) {
    try {
      client.response.write(`data: ${JSON.stringify(data)}\n\n`)
    } catch (error) {
      console.error(`[Broadcaster] ❌ Failed to send to ${client.id}:`, error.message)
      this.removeClient(client.id)
    }
  }

  // Broadcast to all connected clients
  broadcast(data) {
    this.lastUpdate = Date.now()
    const message = {
      ...data,
      timestamp: this.lastUpdate
    }
    
    console.log(`[Broadcaster] 📡 Broadcasting to ${this.clients.size} clients:`, data.type)
    
    for (const client of this.clients) {
      this.sendToClient(client, message)
    }
    
    // Also emit for internal listeners
    this.emit('broadcast', message)
  }

  // Broadcast layer/style changes
  broadcastLayerChange(changeType, layerName, details = {}) {
    this.broadcast({
      type: 'layer_change',
      changeType, // 'style_updated', 'layer_added', 'layer_removed'
      layerName,
      details,
      message: `Layer "${layerName}" ${changeType.replace('_', ' ')}`
    })
  }

  // Broadcast cache clear (general refresh)
  broadcastCacheClear(reason = 'QGIS project updated') {
    this.broadcast({
      type: 'cache_clear',
      reason,
      message: 'Map data has been updated. Refreshing...',
      affectedLayers: 'all'
    })
  }

  // Get status
  getStatus() {
    return {
      connectedClients: this.clients.size,
      lastUpdate: this.lastUpdate,
      uptime: process.uptime()
    }
  }
}

// Singleton instance
let broadcasterInstance = null

function getBroadcaster() {
  if (!broadcasterInstance) {
    broadcasterInstance = new UpdateBroadcaster()
  }
  return broadcasterInstance
}

module.exports = {
  UpdateBroadcaster,
  getBroadcaster
}
