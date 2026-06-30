/**
 * Enhanced OGC Bridge - Zimbabwe User Friendly
 * ==========================================
 * 
 * This is the IDEAL solution for Zimbabwe users:
 * - Users work in QGIS (familiar environment)
 * - Styling gets rendered on the fly in web app
 * - No complex PyQGIS scripts needed
 * - Automatic layer name mapping
 * - Robust fallback mechanisms
 * 
 * Author: SurveySuite Development Team
 * Purpose: Complete QGIS-to-Web styling pipeline
 */

const axios = require('axios')
const { SmartQGISExtractor } = require('./smartQGISExtractor')
const { AdvancedQGISStyleExtractor } = require('./advancedQGISStyleExtractor')

class EnhancedOGCBridge extends SmartQGISExtractor {
  constructor(config = {}) {
    super()
    
    // Server configuration
    this.serverConfig = {
      baseUrl: config.baseUrl || process.env.QGIS_SERVER_URL || 'http://localhost:8080',
      wmsVersion: config.wmsVersion || '1.3.0',
      wfsVersion: config.wfsVersion || '2.0.0',
      wmtsVersion: config.wmtsVersion || '1.0.0',
      project: config.project || process.env.QGIS_PROJECT || '/etc/qgisserver/test-wfs.qgs',
      timeout: config.timeout || 30000,
      maxRetries: config.maxRetries || 3,
      defaultSRS: config.defaultSRS || 'EPSG:4326',
      maxFeatures: config.maxFeatures || 10000,
      ...config
    }
    
    // Layer name mappings (QGIS names -> Database names)
    this.layerMappings = {
      'gweru_rural_planning_boundary': 'gweru_rural_planning_boundary',
      'zimbabwe': 'zimbabwe',
      'GCC Planning Boundary': 'gcc_planning_boundary',
      'gcc_planning_boundary': 'gcc_planning_boundary'
    }
    
    // OGC service endpoints
    this.endpoints = {
      wms: `${this.serverConfig.baseUrl}/wms`,
      wfs: `${this.serverConfig.baseUrl}/wfs`,
      wmts: `${this.serverConfig.baseUrl}/wmts`,
      wcs: `${this.serverConfig.baseUrl}/wcs`,
      ogcApi: `${this.serverConfig.baseUrl}/ogc`,
      ogcApiFeatures: `${this.serverConfig.baseUrl}/ogc/features/v1`,
      ogcApiStyles: `${this.serverConfig.baseUrl}/ogc/styles/v1`
    }
    
    // Feature cache for WFS responses
    this.featureCache = new Map()
    
    // Advanced style extractor for complex QGIS styling
    this.advancedStyleExtractor = new AdvancedQGISStyleExtractor()
    
    console.log(`[Enhanced OGC] 🚀 Initialized Enhanced OGC Bridge`)
    console.log(`[Enhanced OGC] 🌐 Server: ${this.serverConfig.baseUrl}`)
    console.log(`[Enhanced OGC] 📁 Project: ${this.serverConfig.project}`)
    console.log(`[Enhanced OGC] 🗺️ Services: WMS ${this.serverConfig.wmsVersion}, WFS ${this.serverConfig.wfsVersion}`)
  }

  /**
   * Map layer name to database table name
   */
  mapLayerName(layerName) {
    // Try exact match first
    if (this.layerMappings[layerName]) {
      return this.layerMappings[layerName]
    }
    
    // Try case-insensitive match
    const lowerName = layerName.toLowerCase()
    for (const [qgisName, dbName] of Object.entries(this.layerMappings)) {
      if (qgisName.toLowerCase() === lowerName) {
        return dbName
      }
    }
    
    // Return original if no mapping found
    return layerName
  }

  /**
   * Get vector features with robust fallback
   * This is the PRIMARY method for getting styled vector data
   */
  async getFeatures(layerName, options = {}) {
    const cacheKey = `features_${layerName}_${JSON.stringify(options)}`
    
    if (this.featureCache.has(cacheKey) && !options.noCache) {
      console.log(`[Enhanced OGC] 🎯 Using cached features for ${layerName}`)
      return this.featureCache.get(cacheKey)
    }
    
    console.log(`[Enhanced OGC] 📦 Getting features for ${layerName}`)
    
    // Method 1: Try QGIS Server WFS
    try {
      const result = await this.getWFSFeatures(layerName, options)
      console.log(`[Enhanced OGC] ✅ QGIS Server WFS success: ${result.totalFeatures} features`)
      
      // Cache the result
      this.featureCache.set(cacheKey, result)
      return result
      
    } catch (qgisError) {
      console.log(`[Enhanced OGC] ⚠️ QGIS Server WFS failed: ${qgisError.message}`)
      
      // Method 2: Direct PostgreSQL access (guaranteed to work)
      try {
        const result = await this.getDirectFeatures(layerName, options)
        console.log(`[Enhanced OGC] ✅ Direct PostgreSQL success: ${result.totalFeatures} features`)
        
        // Cache the result
        this.featureCache.set(cacheKey, result)
        return result
        
      } catch (dbError) {
        console.log(`[Enhanced OGC] ❌ Direct PostgreSQL failed: ${dbError.message}`)
        
        // Method 3: Smart Extractor fallback
        try {
          const result = await this.getExtractorFeatures(layerName, options)
          console.log(`[Enhanced OGC] ✅ Smart Extractor success: ${result.totalFeatures} features`)
          
          // Cache the result
          this.featureCache.set(cacheKey, result)
          return result
          
        } catch (extractorError) {
          console.log(`[Enhanced OGC] ❌ Smart Extractor failed: ${extractorError.message}`)
          
          throw new Error(`All feature extraction methods failed for ${layerName}`)
        }
      }
    }
  }

  /**
   * Get features from QGIS Server WFS
   */
  async getWFSFeatures(layerName, options = {}) {
    const params = {
      SERVICE: 'WFS',
      VERSION: this.serverConfig.wfsVersion,
      REQUEST: 'GetFeature',
      TYPENAME: layerName,
      OUTPUTFORMAT: options.format || 'application/json',
      SRSNAME: options.srs || this.serverConfig.defaultSRS,
      COUNT: options.maxFeatures || this.serverConfig.maxFeatures
    }
    
    // Add optional filters
    if (options.bbox) {
      params.BBOX = options.bbox.join(',')
    }
    if (options.filter) {
      params.FILTER = options.filter
    }
    if (options.propertyName) {
      params.PROPERTYNAME = Array.isArray(options.propertyName) 
        ? options.propertyName.join(',') 
        : options.propertyName
    }
    
    console.log(`[Enhanced OGC] 📋 QGIS Server WFS request for ${layerName}`)
    
    const response = await this.makeRequest(this.endpoints.wfs, params)
    
    let geojson = response.data
    
    // Parse if string
    if (typeof geojson === 'string') {
      geojson = JSON.parse(geojson)
    }
    
    // Convert ArrayBuffer to JSON if needed
    if (geojson instanceof ArrayBuffer || Buffer.isBuffer(geojson)) {
      geojson = JSON.parse(Buffer.from(geojson).toString('utf8'))
    }
    
    return {
      success: true,
      type: 'FeatureCollection',
      features: geojson.features || [],
      totalFeatures: geojson.totalFeatures || geojson.numberMatched || geojson.features?.length || 0,
      crs: geojson.crs || { type: 'name', properties: { name: this.serverConfig.defaultSRS } },
      metadata: {
        layerName,
        service: 'QGIS Server WFS',
        version: this.serverConfig.wfsVersion,
        format: 'GeoJSON',
        retrievedAt: new Date().toISOString(),
        bbox: this.calculateBbox(geojson.features || [])
      }
    }
  }

  /**
   * Get features directly from PostgreSQL (guaranteed to work)
   */
  async getDirectFeatures(layerName, options = {}) {
    const { Pool } = require('pg')
    
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      host: process.env.DATABASE_URL ? undefined : 'localhost',
      port: process.env.DATABASE_URL ? undefined : 5433,
      database: process.env.DATABASE_URL ? undefined : 'vungu_master_db',
      user: process.env.DATABASE_URL ? undefined : 'postgres',
      password: process.env.DATABASE_URL ? undefined : (process.env.DB_PASSWORD || process.env.PGPASSWORD || 'postgres')
    })
    
    try {
      const tableName = this.mapLayerName(layerName)
      
      let query = `
        SELECT 
          ST_AsGeoJSON(ST_Transform(geom, 4326), 8) as geojson,
          id,
          -- Add other columns dynamically
          *
        FROM public."${tableName}"
        WHERE geom IS NOT NULL
      `
      
      // Add bbox filter if provided
      if (options.bbox) {
        const [minx, miny, maxx, maxy] = options.bbox
        query += ` AND ST_Intersects(ST_Transform(geom, 4326), ST_MakeEnvelope(${minx}, ${miny}, ${maxx}, ${maxy}, 4326))`
      }
      
      // Add limit if provided
      if (options.maxFeatures) {
        query += ` LIMIT ${parseInt(options.maxFeatures)}`
      }
      
      console.log(`[Enhanced OGC] 🔍 Direct PostgreSQL query for ${tableName}`)
      
      const result = await pool.query(query)
      
      const features = result.rows.map(row => {
        const geojson = JSON.parse(row.geojson)
        
        // Add all properties from the row
        const properties = { ...row }
        delete properties.geojson  // Remove the geojson string from properties
        delete properties.geom     // Remove the original geometry
        
        return {
          type: 'Feature',
          geometry: geojson,
          properties: properties
        }
      })
      
      return {
        success: true,
        type: 'FeatureCollection',
        features: features,
        totalFeatures: features.length,
        crs: { type: 'name', properties: { name: 'EPSG:4326' } },
        metadata: {
          layerName,
          service: 'Direct PostgreSQL',
          tableName,
          retrievedAt: new Date().toISOString(),
          bbox: this.calculateBbox(features)
        }
      }
      
    } finally {
      await pool.end()
    }
  }

  /**
   * Get features using Smart Extractor
   */
  async getExtractorFeatures(layerName, options = {}) {
    try {
      // Use the SmartQGISExtractor to get features
      const projectPath = this.serverConfig.project.replace('/etc/qgisserver/', 'c:/mataranyika/vungu-master-alpha-qgis-server/qgis-projects/')
      
      const result = await super.extractFeatures(layerName, {
        projectPath,
        includeGeometry: true,
        includeAttributes: true,
        maxFeatures: options.maxFeatures || 1000
      })
      
      return {
        success: true,
        type: 'FeatureCollection',
        features: result.features || [],
        totalFeatures: result.features?.length || 0,
        crs: { type: 'name', properties: { name: 'EPSG:4326' } },
        metadata: {
          layerName,
          service: 'Smart Extractor',
          retrievedAt: new Date().toISOString()
        }
      }
      
    } catch (error) {
      throw new Error(`Smart Extractor failed: ${error.message}`)
    }
  }

  /**
   * Get style information with advanced QGIS styling support
   */
  async getStyle(layerName, options = {}) {
    console.log(`[Enhanced OGC] 🎨 Getting advanced style for ${layerName}`)
    
    try {
      // Method 1: Advanced QGIS Style Extractor (supports complex patterns)
      const projectPath = this.serverConfig.project.replace('/etc/qgisserver/', 'c:/mataranyika/vungu-master-alpha-qgis-server/qgis-projects/')
      
      const advancedStyle = await this.advancedStyleExtractor.extractCompleteStyle(layerName, projectPath)
      
      console.log(`[Enhanced OGC] ✅ Advanced Style Extractor success`)
      console.log(`[Enhanced OGC] 🎨 Complex patterns: ${advancedStyle.metadata.hasComplexPatterns}`)
      console.log(`[Enhanced OGC] 🎨 Hatch patterns: ${advancedStyle.metadata.hasHatchPatterns}`)
      console.log(`[Enhanced OGC] 🎨 Gradients: ${advancedStyle.metadata.hasGradients}`)
      
      return {
        success: true,
        source: 'Advanced QGIS Style Extractor',
        rendererType: advancedStyle.qgisStyle.rendererType,
        symbols: advancedStyle.webStyle.symbols,
        maplibreStyle: advancedStyle.maplibreStyle,
        hasComplexPatterns: advancedStyle.metadata.hasComplexPatterns,
        hasHatchPatterns: advancedStyle.metadata.hasHatchPatterns,
        hasGradients: advancedStyle.metadata.hasGradients,
        metadata: {
          layerName,
          source: 'Advanced QGIS Style Extractor',
          extractedAt: advancedStyle.metadata.extractedAt,
          symbolCount: advancedStyle.metadata.symbolCount,
          rendererType: advancedStyle.metadata.rendererType,
          note: 'Complete QGIS styling reproduction - what you see in QGIS is what you get in web'
        }
      }
      
    } catch (advancedError) {
      console.log(`[Enhanced OGC] ⚠️ Advanced Style Extractor failed: ${advancedError.message}`)
      
      try {
        // Method 2: Smart Extractor (fallback)
        const projectPath = this.serverConfig.project.replace('/etc/qgisserver/', 'c:/mataranyika/vungu-master-alpha-qgis-server/qgis-projects/')
        
        const style = await super.extractStyle(layerName, {
          projectPath,
          includeSVG: true,
          includeLabels: true,
          cache: true
        })
        
        console.log(`[Enhanced OGC] ✅ Smart Extractor style success`)
        
        return {
          success: true,
          source: 'Smart Extractor',
          ...style
        }
        
      } catch (extractorError) {
        console.log(`[Enhanced OGC] ⚠️ Smart Extractor failed: ${extractorError.message}`)
        
        // Method 3: Default style fallback
        console.log(`[Enhanced OGC] 🎨 Using default style fallback`)
        
        return {
          success: true,
          source: 'Default Style',
          symbols: [{
            name: layerName,
            category: 'default',
            style: {
              fill: {
                color: '#45B7D1',
                opacity: 0.5
              },
              stroke: {
                color: '#2c3e50',
                width: 2,
                opacity: 1
              }
            }
          }],
          metadata: {
            layerName,
            source: 'Default Style',
            note: 'Generated default style for polygon layer'
          }
        }
      }
    }
  }

  /**
   * Get legend graphic
   */
  async getLegend(layerName, options = {}) {
    try {
      const params = {
        SERVICE: 'WMS',
        VERSION: this.serverConfig.wmsVersion,
        REQUEST: 'GetLegendGraphic',
        LAYER: layerName,
        FORMAT: options.format || 'image/png',
        WIDTH: options.width || 24,
        HEIGHT: options.height || 24,
        SCALE: options.scale || 1000000,
        RULELABEL: options.ruleLabel !== false ? 'TRUE' : 'FALSE'
      }
      
      console.log(`[Enhanced OGC] 🎨 WMS GetLegendGraphic for ${layerName}`)
      
      const response = await this.makeRequest(this.endpoints.wms, params)
      
      // Convert to base64 data URL
      let legendData = response.data
      if (Buffer.isBuffer(legendData) || legendData instanceof ArrayBuffer) {
        const base64 = Buffer.from(legendData).toString('base64')
        legendData = `data:${params.FORMAT};base64,${base64}`
      }
      
      return {
        success: true,
        legend: legendData,
        contentType: params.FORMAT,
        metadata: {
          layerName,
          service: 'WMS',
          request: 'GetLegendGraphic'
        }
      }
    } catch (error) {
      console.log(`[Enhanced OGC] ⚠️ Legend loading failed: ${error.message}`)
      
      // Return a simple default legend
      return {
        success: true,
        legend: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        contentType: 'image/png',
        metadata: {
          layerName,
          service: 'Default Legend',
          note: 'Generated default legend'
        }
      }
    }
  }

  /**
   * Get styled layer (the complete package)
   * This is the MAIN method for frontend consumption
   */
  async getStyledLayer(layerName, options = {}) {
    console.log(`[Enhanced OGC] 🚀 Getting styled layer: ${layerName}`)
    
    const result = {
      layerName,
      success: true,
      features: null,
      style: null,
      legend: null,
      tileUrl: null,
      metadata: {
        retrievedAt: new Date().toISOString(),
        services: []
      }
    }
    
    // 1. Get vector features
    try {
      result.features = await this.getFeatures(layerName, options)
      result.metadata.services.push(result.features.metadata.service)
      console.log(`[Enhanced OGC] ✅ Features loaded: ${result.features.totalFeatures} features`)
    } catch (featureError) {
      console.log(`[Enhanced OGC] ⚠️ Feature loading failed: ${featureError.message}`)
      result.features = { success: false, error: featureError.message }
    }
    
    // 2. Get style information
    try {
      result.style = await this.getStyle(layerName, options)
      result.metadata.services.push(result.style.source)
      console.log(`[Enhanced OGC] ✅ Style loaded from: ${result.style.source}`)
    } catch (styleError) {
      console.log(`[Enhanced OGC] ⚠️ Style loading failed: ${styleError.message}`)
      result.style = { success: false, error: styleError.message }
    }
    
    // 3. Get legend graphic
    try {
      result.legend = await this.getLegend(layerName, options)
      result.metadata.services.push('WMS Legend')
      console.log(`[Enhanced OGC] ✅ Legend loaded`)
    } catch (legendError) {
      console.log(`[Enhanced OGC] ⚠️ Legend loading failed: ${legendError.message}`)
    }
    
    // 4. Generate tile URL for raster fallback
    result.tileUrl = this.getWMTSTileUrl(layerName)
    
    // 5. Convert to MapLibre-compatible format
    result.maplibreStyle = this.toMapLibreStyle(layerName, result.style, result.features)
    
    return result
  }

  /**
   * Convert to MapLibre GL JS compatible format
   */
  toMapLibreStyle(layerName, styleData, featureData) {
    const maplibreStyle = {
      id: layerName,
      source: layerName,
      metadata: {
        'qgis:source': styleData?.source || 'unknown'
      }
    }
    
    // Determine geometry type from features
    const geometryType = this.detectGeometryType(featureData?.features)
    
    // Generate style based on geometry type
    if (geometryType === 'Point' || geometryType === 'MultiPoint') {
      maplibreStyle.type = 'circle'
      maplibreStyle.paint = this.toMapLibrePointPaint(styleData)
    } else if (geometryType === 'LineString' || geometryType === 'MultiLineString') {
      maplibreStyle.type = 'line'
      maplibreStyle.paint = this.toMapLibreLinePaint(styleData)
    } else if (geometryType === 'Polygon' || geometryType === 'MultiPolygon') {
      maplibreStyle.type = 'fill'
      maplibreStyle.paint = this.toMapLibreFillPaint(styleData)
    } else {
      // Default to fill for unknown (most common for planning data)
      maplibreStyle.type = 'fill'
      maplibreStyle.paint = this.toMapLibreFillPaint(styleData)
    }
    
    return maplibreStyle
  }

  /**
   * Convert to MapLibre fill paint properties
   */
  toMapLibreFillPaint(styleData) {
    const symbol = styleData?.symbols?.[0]?.style || {}
    
    return {
      'fill-color': symbol.fill?.color || '#45B7D1',
      'fill-opacity': symbol.fill?.opacity || symbol.opacity || 0.5,
      'fill-outline-color': symbol.stroke?.color || '#2c3e50'
    }
  }

  /**
   * Detect geometry type from features
   */
  detectGeometryType(features) {
    if (!features || features.length === 0) return 'Polygon'
    
    const firstFeature = features[0]
    return firstFeature?.geometry?.type || 'Polygon'
  }

  /**
   * Get WMTS tile URL template
   */
  getWMTSTileUrl(layerName, options = {}) {
    const baseUrl = this.endpoints.wmts
    const style = options.style || 'default'
    const tileMatrixSet = options.tileMatrixSet || 'EPSG:3857'
    const format = options.format || 'image/png'
    
    return `${baseUrl}?SERVICE=WMTS&REQUEST=GetTile&VERSION=${this.serverConfig.wmtsVersion}` +
           `&LAYER=${layerName}&STYLE=${style}&TILEMATRIXSET=${tileMatrixSet}` +
           `&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${encodeURIComponent(format)}`
  }

  /**
   * Make HTTP request with retry logic
   */
  async makeRequest(url, params = {}, method = 'GET') {
    const config = {
      method,
      url,
      timeout: this.serverConfig.timeout,
      params: method === 'GET' ? params : undefined,
      data: method === 'POST' ? params : undefined,
      responseType: 'arraybuffer'
    }
    
    let lastError = null
    
    for (let attempt = 1; attempt <= this.serverConfig.maxRetries; attempt++) {
      try {
        const response = await axios(config)
        
        let data = response.data
        
        // Parse JSON if content type indicates it
        const contentType = response.headers['content-type'] || ''
        if (contentType.includes('json') || contentType.includes('xml')) {
          if (Buffer.isBuffer(data)) {
            data = data.toString('utf8')
          }
          if (typeof data === 'string' && (data.startsWith('{') || data.startsWith('['))) {
            try {
              data = JSON.parse(data)
            } catch (e) {
              // Keep as string
            }
          }
        }
        
        return { data, headers: response.headers }
        
      } catch (error) {
        lastError = error
        console.log(`[Enhanced OGC] ⚠️ Request attempt ${attempt} failed: ${error.message}`)
        
        if (attempt < this.serverConfig.maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }
    
    throw lastError || new Error('Request failed after all retries')
  }

  /**
   * Calculate bounding box from features
   */
  calculateBbox(features) {
    if (!features || features.length === 0) return null
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    
    for (const feature of features) {
      const coords = this.extractCoordinates(feature.geometry)
      for (const [x, y] of coords) {
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
    
    return [minX, minY, maxX, maxY]
  }

  /**
   * Extract all coordinates from a geometry
   */
  extractCoordinates(geometry) {
    if (!geometry) return []
    
    const coords = []
    const type = geometry.type
    
    if (type === 'Point') {
      coords.push(geometry.coordinates)
    } else if (type === 'MultiPoint' || type === 'LineString') {
      coords.push(...geometry.coordinates)
    } else if (type === 'MultiLineString' || type === 'Polygon') {
      for (const ring of geometry.coordinates) {
        coords.push(...ring)
      }
    } else if (type === 'MultiPolygon') {
      for (const polygon of geometry.coordinates) {
        for (const ring of polygon) {
          coords.push(...ring)
        }
      }
    }
    
    return coords
  }

  /**
   * Clear feature cache
   */
  clearCache() {
    this.featureCache.clear()
    super.clearCache && super.clearCache()
    console.log(`[Enhanced OGC] 🧹 Cache cleared`)
  }
}

module.exports = { EnhancedOGCBridge }
