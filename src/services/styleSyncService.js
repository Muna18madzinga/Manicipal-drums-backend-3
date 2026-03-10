// Automated Style Synchronization Service
// Handles real-time style synchronization between QGIS and web interface

const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');
const { Pool } = require('pg');

class StyleSyncService extends EventEmitter {
  constructor() {
    super();
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL
    });
    
    // Configuration
    this.syncInterval = '*/5 * * * *'; // Every 5 minutes
    this.styleDirectory = path.join(__dirname, '../assets/styles');
    this.qmlDirectory = path.join(__dirname, '../assets/qml');
    
    // State tracking
    this.isSyncing = false;
    this.lastSyncTime = null;
    this.syncHistory = [];
    this.styleVersions = new Map();
    
    // Initialize service
    this.initialize();
  }

  async initialize() {
    try {
      console.log('[StyleSync] 🎨 Initializing style synchronization service...');
      
      // Create directories if they don't exist
      await this.ensureDirectories();
      
      // Load existing style versions
      await this.loadStyleVersions();
      
      // Start scheduled sync
      this.startScheduledSync();
      
      // Setup file watchers for real-time sync
      await this.setupFileWatchers();
      
      console.log('[StyleSync] ✅ Style synchronization service initialized');
      
    } catch (error) {
      console.error('[StyleSync] ❌ Failed to initialize:', error);
      this.emit('error', error);
    }
  }

  async ensureDirectories() {
    const directories = [this.styleDirectory, this.qmlDirectory];
    
    for (const dir of directories) {
      try {
        await fs.access(dir);
      } catch (error) {
        await fs.mkdir(dir, { recursive: true });
        console.log(`[StyleSync] 📁 Created directory: ${dir}`);
      }
    }
  }

  async loadStyleVersions() {
    try {
      const query = `
        SELECT id, name, version, content, updated_at 
        FROM qml_templates 
        WHERE is_active = true
        ORDER BY updated_at DESC
      `;
      
      const result = await this.pool.query(query);
      
      for (const row of result.rows) {
        this.styleVersions.set(row.name, {
          id: row.id,
          version: row.version,
          content: row.content,
          last_modified: new Date(row.updated_at)
        });
      }
      
      console.log(`[StyleSync] 📋 Loaded ${this.styleVersions.size} style versions`);
      
    } catch (error) {
      console.error('[StyleSync] ❌ Failed to load style versions:', error);
    }
  }

  startScheduledSync() {
    console.log('[StyleSync] ⏰ Starting scheduled style sync (every 5 minutes)');
    
    cron.schedule(this.syncInterval, async () => {
      if (!this.isSyncing) {
        await this.performScheduledSync();
      }
    });
  }

  async setupFileWatchers() {
    try {
      const chokidar = require('chokidar');
      
      // Watch QML directory for changes
      const watcher = chokidar.watch(this.qmlDirectory, {
        ignored: /(^|[\/\\])\../, // ignore dotfiles
        persistent: true
      });
      
      watcher.on('change', async (filePath) => {
        const fileName = path.basename(filePath, '.qml');
        console.log(`[StyleSync] 📝 QML file changed: ${fileName}`);
        await this.syncStyleFile(filePath, fileName);
      });
      
      watcher.on('add', async (filePath) => {
        const fileName = path.basename(filePath, '.qml');
        console.log(`[StyleSync] ➕ New QML file: ${fileName}`);
        await this.syncStyleFile(filePath, fileName);
      });
      
      console.log('[StyleSync] 👁️ File watchers setup complete');
      
    } catch (error) {
      console.error('[StyleSync] ❌ Failed to setup file watchers:', error);
    }
  }

  async performScheduledSync() {
    try {
      console.log('[StyleSync] 🔄 Performing scheduled style sync...');
      
      const syncResult = await this.syncAllStyles();
      
      this.lastSyncTime = new Date();
      this.syncHistory.push({
        timestamp: this.lastSyncTime,
        type: 'scheduled',
        result: syncResult
      });
      
      // Keep only last 100 sync records
      if (this.syncHistory.length > 100) {
        this.syncHistory = this.syncHistory.slice(-100);
      }
      
      this.emit('sync-completed', syncResult);
      
    } catch (error) {
      console.error('[StyleSync] ❌ Scheduled sync failed:', error);
      this.emit('sync-failed', error);
    }
  }

  async syncAllStyles() {
    this.isSyncing = true;
    
    try {
      const result = {
        synced: 0,
        updated: 0,
        created: 0,
        errors: []
      };
      
      // Get all QML files
      const qmlFiles = await fs.readdir(this.qmlDirectory);
      const qmlFilesFiltered = qmlFiles.filter(file => file.endsWith('.qml'));
      
      console.log(`[StyleSync] 📁 Found ${qmlFilesFiltered.length} QML files to sync`);
      
      for (const file of qmlFilesFiltered) {
        try {
          const filePath = path.join(this.qmlDirectory, file);
          const styleName = path.basename(file, '.qml');
          
          const syncResult = await this.syncStyleFile(filePath, styleName);
          
          if (syncResult.created) {
            result.created++;
          } else if (syncResult.updated) {
            result.updated++;
          }
          
          result.synced++;
          
        } catch (error) {
          result.errors.push({
            file: file,
            error: error.message
          });
          console.error(`[StyleSync] ❌ Failed to sync ${file}:`, error);
        }
      }
      
      console.log(`[StyleSync] ✅ Sync completed: ${result.synced} processed, ${result.created} created, ${result.updated} updated`);
      
      return result;
      
    } finally {
      this.isSyncing = false;
    }
  }

  async syncStyleFile(filePath, styleName) {
    try {
      // Read file content
      const content = await fs.readFile(filePath, 'utf8');
      
      // Calculate file hash for version control
      const crypto = require('crypto');
      const hash = crypto.createHash('md5').update(content).digest('hex');
      
      // Check if style exists and has changed
      const existingVersion = this.styleVersions.get(styleName);
      const hasChanged = !existingVersion || existingVersion.hash !== hash;
      
      if (!hasChanged) {
        return { created: false, updated: false, unchanged: true };
      }
      
      // Parse QML content
      const parsedStyle = await this.parseQMLContent(content);
      
      // Save to database
      const styleRecord = await this.saveStyleToDatabase({
        name: styleName,
        content: content,
        parsed_content: parsedStyle,
        hash: hash,
        version: existingVersion ? existingVersion.version + 1 : 1
      });
      
      // Update local version tracking
      this.styleVersions.set(styleName, {
        id: styleRecord.id,
        version: styleRecord.version,
        content: content,
        hash: hash,
        last_modified: new Date(styleRecord.updated_at)
      });
      
      // Notify QGIS plugin of change
      await this.notifyQGISPlugin(styleName, styleRecord);
      
      console.log(`[StyleSync] ✅ Synced style: ${styleName} (v${styleRecord.version})`);
      
      return {
        created: !existingVersion,
        updated: !!existingVersion,
        version: styleRecord.version
      };
      
    } catch (error) {
      console.error(`[StyleSync] ❌ Failed to sync style ${styleName}:`, error);
      throw error;
    }
  }

  async parseQMLContent(content) {
    try {
      // Parse QML XML content
      const { DOMParser } = require('xmldom');
      const parser = new DOMParser();
      const doc = parser.parseFromString(content, 'text/xml');
      
      // Extract style information
      const symbols = [];
      const symbolElements = doc.getElementsByTagName('symbol');
      
      for (const symbolEl of symbolElements) {
        const symbol = {
          name: symbolEl.getAttribute('name') || 'unnamed',
          type: symbolEl.getAttribute('type') || 'fill',
          layers: []
        };
        
        // Extract symbol layers
        const layerElements = symbolEl.getElementsByTagName('layer');
        for (const layerEl of layerElements) {
          const layer = {
            pass: layerEl.getAttribute('pass') || '0',
            class: layerEl.getAttribute('class') || 'SimpleFill',
            properties: {}
          };
          
          // Extract properties
          const propElements = layerEl.getElementsByTagName('prop');
          for (const propEl of propElements) {
            const k = propEl.getAttribute('k');
            const v = propEl.getAttribute('v');
            if (k && v) {
              layer.properties[k] = v;
            }
          }
          
          symbol.layers.push(layer);
        }
        
        symbols.push(symbol);
      }
      
      return {
        symbols: symbols,
        format: 'qml',
        parsed_at: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('[StyleSync] ❌ Failed to parse QML content:', error);
      return { symbols: [], format: 'qml', error: error.message };
    }
  }

  async saveStyleToDatabase(styleData) {
    try {
      const query = `
        INSERT INTO qml_templates (name, content, parsed_content, hash, version, is_active, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW())
        ON CONFLICT (name) 
        DO UPDATE SET 
          content = EXCLUDED.content,
          parsed_content = EXCLUDED.parsed_content,
          hash = EXCLUDED.hash,
          version = qml_templates.version + 1,
          updated_at = NOW()
        RETURNING id, name, version, updated_at
      `;
      
      const values = [
        styleData.name,
        styleData.content,
        JSON.stringify(styleData.parsed_content),
        styleData.hash,
        styleData.version
      ];
      
      const result = await this.pool.query(query, values);
      
      return result.rows[0];
      
    } catch (error) {
      console.error('[StyleSync] ❌ Failed to save style to database:', error);
      throw error;
    }
  }

  async notifyQGISPlugin(styleName, styleRecord) {
    try {
      // Emit event for real-time notification
      this.emit('style-updated', {
        styleName: styleName,
        version: styleRecord.version,
        timestamp: new Date().toISOString()
      });
      
      // If WebSocket server is available, send notification
      if (global.wsServer) {
        global.wsServer.clients.forEach(client => {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(JSON.stringify({
              type: 'style_update',
              data: {
                styleName: styleName,
                version: styleRecord.version,
                timestamp: new Date().toISOString()
              }
            }));
          }
        });
      }
      
    } catch (error) {
      console.error('[StyleSync] ❌ Failed to notify QGIS plugin:', error);
    }
  }

  async getSyncStatus() {
    return {
      is_syncing: this.isSyncing,
      last_sync_time: this.lastSyncTime,
      total_styles: this.styleVersions.size,
      sync_history: this.syncHistory.slice(-10), // Last 10 syncs
      next_sync: this.getNextSyncTime()
    };
  }

  getNextSyncTime() {
    // Calculate next sync time (5 minutes from last sync)
    if (this.lastSyncTime) {
      const nextSync = new Date(this.lastSyncTime);
      nextSync.setMinutes(nextSync.getMinutes() + 5);
      return nextSync;
    }
    return new Date(Date.now() + 5 * 60 * 1000); // 5 minutes from now
  }

  async forceSync() {
    if (this.isSyncing) {
      throw new Error('Sync already in progress');
    }
    
    console.log('[StyleSync] 🚀 Force sync initiated');
    return await this.performScheduledSync();
  }

  async getStyleVersion(styleName) {
    return this.styleVersions.get(styleName);
  }

  async getAllStyleVersions() {
    return Array.from(this.styleVersions.entries()).map(([name, version]) => ({
      name,
      ...version
    }));
  }

  async shutdown() {
    console.log('[StyleSync] 🛑 Shutting down style synchronization service...');
    
    // Stop cron jobs
    cron.getTasks().forEach(task => task.stop());
    
    // Close database connection
    await this.pool.end();
    
    console.log('[StyleSync] ✅ Style synchronization service shutdown complete');
  }
}

module.exports = StyleSyncService;
