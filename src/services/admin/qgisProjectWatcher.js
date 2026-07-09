/**
 * Enhanced QGIS Project File Watcher
 * ================================
 *
 * Detects both style changes AND new/deleted layers,
 * triggering appropriate reload actions.
 */

const chokidar = require('chokidar')
const path = require('path')
const fs = require('fs')
const axios = require('axios')
const { getBroadcaster } = require('./updateBroadcaster')

class QGISProjectWatcher {
  constructor(bridge) {
    this.bridge = bridge
    this.watcher = null
    this.projectPath = this.getProjectPath()
    this.isWatching = false
    this.lastClearTime = 0
    this.debounceMs = 500
    this.knownLayers = new Set()
    this.lastLayerCount = 0
  }

  getProjectPath() {
    // Honor QGIS_PROJECT — the same env var the OGC / Ultimate bridges read —
    // so the watcher and the bridges always point at the same project. Only
    // fall back to a platform default when the env var is unset.
    if (process.env.QGIS_PROJECT) return process.env.QGIS_PROJECT
    return process.platform === 'win32'
      ? 'c:\\mataranyika\\vungu-master-alpha-qgis-server\\qgis-projects\\vungu-docker-minimal.qgs'
      : '/etc/qgisserver/vungu-docker-minimal.qgs'
  }

  start() {
    if (this.isWatching) {
      console.log('[Project Watcher] Already watching')
      return
    }

    if (!fs.existsSync(this.projectPath)) {
      console.log(`[Project Watcher] QGIS project not present (${this.projectPath}) — live symbology watch disabled; layers use stored styles`)
      return
    }

    // Initial layer scan
    const initialLayers = this.scanLayers()
    this.knownLayers = new Set(initialLayers)
    this.lastLayerCount = initialLayers.length

    const watchPath = path.dirname(this.projectPath)
    const filename = path.basename(this.projectPath)

    console.log(`[Project Watcher] 👁️ Watching ${filename} for style AND layer changes`)
    console.log(`[Project Watcher] 📁 Directory: ${watchPath}`)
    console.log(`[Project Watcher] 📊 Initial layers: ${this.lastLayerCount}`)

    // Verify file exists before watching
    if (!fs.existsSync(this.projectPath)) {
      console.error(`[Project Watcher] ❌ Cannot watch - file not found: ${this.projectPath}`)
      return this
    }

    console.log(`[Project Watcher] 🔍 File exists, size: ${fs.statSync(this.projectPath).size} bytes`)

    this.watcher = chokidar.watch(this.projectPath, {
      persistent: true,
      ignoreInitial: true,
      usePolling: process.platform === 'win32', // Use polling on Windows for reliability
      interval: 500, // Poll every 500ms
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100
      }
    })

    this.isWatching = true

    this.watcher
      .on('change', (filePath) => {
        console.log(`[Project Watcher] 🔔 RAW change event: ${filePath}`)
        this.handleFileChange(filePath, 'modified')
      })
      .on('add', (filePath) => {
        console.log(`[Project Watcher] 🔔 RAW add event: ${filePath}`)
        this.handleFileChange(filePath, 'added')
      })
      .on('raw', (event, filePath) => {
        console.log(`[Project Watcher] 🔔 RAW event: ${event} - ${filePath}`)
      })
      .on('error', (error) => {
        console.error('[Project Watcher] ❌ Error:', error)
        this.isWatching = false
      })
      .on('ready', () => {
        console.log('[Project Watcher] ✅ Ready. Watching for changes...')
        console.log(`[Project Watcher] 🔍 Watching file: ${this.projectPath}`)
        console.log(`[Project Watcher] 📊 Currently tracking ${this.knownLayers.size} layers`)
      })

    return this
  }

  /**
   * Scan current layers in project file
   */
  scanLayers() {
    try {
      const content = fs.readFileSync(this.projectPath, 'utf8')
      const layerNames = this.extractLayerNames(content)
      return layerNames
    } catch (error) {
      console.error('[Project Watcher] ❌ Failed to scan layers:', error.message)
      return []
    }
  }

  /**
   * Extract layer names from QGS file content
   */
  extractLayerNames(content) {
    const layers = []
    const regex = /<layername>([^<]+)<\/layername>/g
    let match
    while ((match = regex.exec(content)) !== null) {
      layers.push(match[1])
    }
    return layers
  }

  handleFileChange(filePath, eventType) {
    console.log(`[Project Watcher] 🔥 ENTER handleFileChange: ${eventType} - ${filePath}`)
    const now = Date.now()
    const filename = path.basename(filePath)

    // Debounce to avoid multiple rapid clears
    if (now - this.lastClearTime < this.debounceMs) {
      console.log(`[Project Watcher] ⏭️ Debounced ${eventType} event for ${filename}`)
      return
    }

    this.lastClearTime = now
    console.log(`[Project Watcher] 📝 File ${eventType}: ${filename}`)

    // Read new layer list
    const newLayers = this.scanLayers()
    const newLayerSet = new Set(newLayers)

    // Detect changes
    const addedLayers = newLayers.filter(l => !this.knownLayers.has(l))
    const removedLayers = Array.from(this.knownLayers).filter(l => !newLayerSet.has(l))
    const layerCountChanged = newLayers.length !== this.lastLayerCount

    // Update tracking
    const oldKnownLayers = new Set(this.knownLayers)
    this.knownLayers = newLayerSet
    this.lastLayerCount = newLayers.length

    // Clear backend cache and broadcast
    if (this.bridge) {
      try {
        this.bridge.clearCache()
        console.log('[Project Watcher] ✅ Backend cache cleared')
        
        // Broadcast cache clear to all clients
        const broadcaster = getBroadcaster()
        broadcaster.broadcastCacheClear(`QGIS project ${eventType}: ${filename}`)
      } catch (error) {
        console.error('[Project Watcher] ❌ Failed to clear cache:', error.message)
      }
    }

    // Handle different types of changes
    if (addedLayers.length > 0) {
      console.log(`[Project Watcher] ➕ NEW LAYERS DETECTED: ${addedLayers.join(', ')}`)
      this.handleNewLayers(addedLayers)
    }

    if (removedLayers.length > 0) {
      console.log(`[Project Watcher] ➖ REMOVED LAYERS: ${removedLayers.join(', ')}`)
    }

    // Broadcast changes to connected clients
    const broadcaster = getBroadcaster()
    
    if (addedLayers.length > 0) {
      broadcaster.broadcastLayerChange('layer_added', addedLayers[0], { allAdded: addedLayers })
    }
    
    if (removedLayers.length > 0) {
      broadcaster.broadcastLayerChange('layer_removed', removedLayers[0], { allRemoved: removedLayers })
    }
    
    if (!addedLayers.length && !removedLayers.length) {
      broadcaster.broadcastLayerChange('style_updated', newLayers[0] || 'all', { layerCount: newLayers.length })
    }
    
    // Always broadcast cache clear for general refresh
    broadcaster.broadcastCacheClear(`QGIS project ${eventType}: ${filename}`)
  }

  /**
   * Handle new layers - restart QGIS Server Docker to pick up new layers
   */
  async handleNewLayers(addedLayers) {
    console.log(`[Project Watcher] ➕ NEW LAYERS DETECTED: ${addedLayers.join(', ')}`)
    console.log(`[Project Watcher] 🚀 Processing ${addedLayers.length} new layer(s)...`)

    // Restart QGIS Server Docker to reload project with new layers
    try {
      await this.restartQGISServerDocker()
    } catch (error) {
      console.log(`[Project Watcher] ⚠️ QGIS Server restart failed: ${error.message}`)
      console.log(`[Project Watcher] 💡 Manual restart required: docker restart vungu-qgis-server`)
    }

    console.log(`[Project Watcher] 📋 New layers will be available in WMS/WFS after restart`)
    addedLayers.forEach(layer => {
      console.log(`  - ${layer}`)
    })
  }

  /**
   * Restart QGIS Server Docker container to reload project
   */
  async restartQGISServerDocker() {
    const { exec } = require('child_process')
    const util = require('util')
    const execPromise = util.promisify(exec)

    console.log(`[Project Watcher] 🔄 Restarting QGIS Server Docker container...`)

    try {
      // Restart the container
      const { stdout, stderr } = await execPromise('docker restart vungu-qgis-server')
      console.log(`[Project Watcher] ✅ QGIS Server restarted: ${stdout.trim()}`)

      // Wait longer for QGIS Server to fully start up inside container
      console.log(`[Project Watcher] ⏳ Waiting 8 seconds for QGIS Server to initialize...`)
      await new Promise(resolve => setTimeout(resolve, 8000))

      // Retry verification a few times
      const qgisUrl = process.env.QGIS_SERVER_URL || 'http://localhost:8080'
      let retries = 3
      let ready = false

      while (retries > 0 && !ready) {
        try {
          const response = await axios.get(`${qgisUrl}/wms`, {
            params: { SERVICE: 'WMS', REQUEST: 'GetCapabilities' },
            timeout: 10000
          })
          if (response.status === 200) {
            ready = true
            console.log(`[Project Watcher] ✅ QGIS Server is ready with new layers!`)
          }
        } catch (e) {
          retries--
          if (retries > 0) {
            console.log(`[Project Watcher] ⏳ QGIS not ready yet, retrying... (${retries} left)`)
            await new Promise(resolve => setTimeout(resolve, 3000))
          }
        }
      }

      if (!ready) {
        console.log(`[Project Watcher] ⚠️ QGIS Server verification timed out, but restart likely succeeded`)
        console.log(`[Project Watcher] 💡 If layers don't appear, try: docker restart vungu-qgis-server`)
      }
    } catch (error) {
      // If docker command fails, log helpful message
      if (error.message.includes('command not found') || error.message.includes('docker')) {
        console.log(`[Project Watcher] ⚠️ Docker not available or container not found`)
        console.log(`[Project Watcher] 💡 Please restart manually: docker restart vungu-qgis-server`)
      } else {
        console.error(`[Project Watcher] ❌ Restart error:`, error.message)
      }
    }
  }

  stop() {
    if (this.watcher) {
      this.watcher.close()
      this.isWatching = false
      console.log('[Project Watcher] 🛑 Stopped watching')
    }
  }

  getStatus() {
    return {
      isWatching: this.isWatching,
      projectPath: this.projectPath,
      knownLayerCount: this.knownLayers.size,
      knownLayers: Array.from(this.knownLayers).slice(0, 10),
      lastClearTime: this.lastClearTime ? new Date(this.lastClearTime).toISOString() : null
    }
  }
}

// Singleton instance
let watcherInstance = null

function startProjectWatcher(bridge) {
  console.log('[Project Watcher] 🚀 startProjectWatcher called')
  if (!watcherInstance) {
    console.log('[Project Watcher] 🆕 Creating new watcher instance')
    watcherInstance = new QGISProjectWatcher(bridge)
    watcherInstance.start()
  } else {
    console.log('[Project Watcher] ℹ️ Watcher already exists')
  }
  return watcherInstance
}

function stopProjectWatcher() {
  if (watcherInstance) {
    watcherInstance.stop()
    watcherInstance = null
  }
}

function getWatcherStatus() {
  return watcherInstance ? watcherInstance.getStatus() : { isWatching: false }
}

module.exports = {
  QGISProjectWatcher,
  startProjectWatcher,
  stopProjectWatcher,
  getWatcherStatus
}
