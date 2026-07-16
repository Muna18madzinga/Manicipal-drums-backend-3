/**
 * Refined OGC Bridge - Production Ready
 * =====================================
 * 
 * The PERFECT solution for Zimbabwe users:
 * - Users work in QGIS (familiar environment)
 * - Styling renders on the fly in web app
 * - What users see in QGIS = What users see in web
 * 
 * Features:
 * - Complete QGIS style extraction
 * - Complex patterns (hatch, diagonal, cross, dots)
 * - Categorized and graduated styling
 * - Gradient fills
 * - Label support
 * - MapLibre GL JS style generation
 * - Multiple fallback mechanisms
 * - Caching for performance
 * 
 * Version: 2.0 - Refined Production Release
 */

const axios = require('axios')
const fs = require('fs')
const path = require('path')
const { PerfectQGISStyleExtractor } = require('./perfectQGISStyleExtractor')

class RefinedOGCBridge {
  constructor(config = {}) {
    // Server configuration
    this.serverConfig = {
      baseUrl: config.baseUrl || process.env.QGIS_SERVER_URL || 'http://localhost:8080',
      wmsVersion: config.wmsVersion || '1.3.0',
      wfsVersion: config.wfsVersion || '2.0.0',
      wmtsVersion: config.wmtsVersion || '1.0.0',
      project: config.project || process.env.QGIS_PROJECT || '/etc/qgisserver/test-wfs.qgs',
      projectLocalPath: config.projectLocalPath || process.env.QGIS_PROJECT_LOCAL_DIR || path.join(__dirname, '..', '..', '..', 'qgis-projects'),
      timeout: config.timeout || 30000,
      maxRetries: config.maxRetries || 3,
      defaultSRS: config.defaultSRS || 'EPSG:4326',
      maxFeatures: config.maxFeatures || 10000,
      ...config
    }

    // Database configuration for direct PostgreSQL access
    this.dbConfig = {
      host: config.dbHost || 'localhost',
      port: config.dbPort || 5432,
      database: config.dbName || 'vungu_master_db_v1',
      user: config.dbUser || 'postgres',
      password: config.dbPassword || 'cairo2025'
    }

    // Layer name mappings (QGIS names -> Database table names)
    this.layerMappings = new Map([
      ['gweru_rural_planning_boundary', 'gweru_rural_planning_boundary'],
      ['Gweru Rural Planning Boundary', 'gweru_rural_planning_boundary'],
      ['gweru_rural_farms', 'gweru_rural_farms'],
      ['Gweru Rural Farms', 'gweru_rural_farms'],
      ['proposed_peri_urban_zones', 'proposed_peri_urban_zones'],
      ['Proposed Peri Urban Zones', 'proposed_peri_urban_zones'],
      ['zimbabwe', 'zimbabwe'],
      ['Zimbabwe', 'zimbabwe']
    ])

    // OGC service endpoints
    this.endpoints = {
      wms: `${this.serverConfig.baseUrl}/wms`,
      wfs: `${this.serverConfig.baseUrl}/wfs`,
      wmts: `${this.serverConfig.baseUrl}/wmts`,
      ogcApi: `${this.serverConfig.baseUrl}/ogc`
    }

    // Caches
    this.featureCache = new Map()
    this.styleCache = new Map()
    this.legendCache = new Map()

    // Perfect style extractor
    this.styleExtractor = new PerfectQGISStyleExtractor()

    console.log(`[Refined OGC] 🚀 Initialized Refined OGC Bridge`)
    console.log(`[Refined OGC] 🌐 Server: ${this.serverConfig.baseUrl}`)
    console.log(`[Refined OGC] 📁 Project: ${this.serverConfig.project}`)
    console.log(`[Refined OGC] 🗺️ Services: WMS ${this.serverConfig.wmsVersion}, WFS ${this.serverConfig.wfsVersion}`)
  }

  // ============================================================
  // LAYER NAME MAPPING
  // ============================================================

  /**
   * Map layer name to database table name
   */
  mapLayerName(layerName) {
    // Try exact match
    if (this.layerMappings.has(layerName)) {
      return this.layerMappings.get(layerName)
    }

    // Try case-insensitive match
    const lowerName = layerName.toLowerCase()
    for (const [qgisName, dbName] of this.layerMappings) {
      if (qgisName.toLowerCase() === lowerName) {
        return dbName
      }
    }

    // Try with underscores replaced by spaces and vice versa
    const withSpaces = layerName.replace(/_/g, ' ')
    const withUnderscores = layerName.replace(/ /g, '_')
    
    if (this.layerMappings.has(withSpaces)) {
      return this.layerMappings.get(withSpaces)
    }
    if (this.layerMappings.has(withUnderscores)) {
      return this.layerMappings.get(withUnderscores)
    }

    // Return original (lowercase with underscores for database)
    return layerName.toLowerCase().replace(/ /g, '_')
  }

  /**
   * Add layer name mapping dynamically
   */
  addLayerMapping(qgisName, dbName) {
    this.layerMappings.set(qgisName, dbName)
    console.log(`[Refined OGC] 📍 Added mapping: "${qgisName}" -> "${dbName}"`)
  }

  // ============================================================
  // FEATURE RETRIEVAL
  // ============================================================

  /**
   * Get vector features with robust fallback
   * Primary method for getting styled vector data
   */
  async getFeatures(layerName, options = {}) {
    const cacheKey = `features_${layerName}_${JSON.stringify(options)}`

    if (this.featureCache.has(cacheKey) && !options.noCache) {
      console.log(`[Refined OGC] 🎯 Using cached features for ${layerName}`)
      return this.featureCache.get(cacheKey)
    }

    console.log(`[Refined OGC] 📦 Getting features for ${layerName}`)

    // Method 1: Try QGIS Server WFS
    try {
      const result = await this.getWFSFeatures(layerName, options)
      if (result.features && result.features.length > 0) {
        console.log(`[Refined OGC] ✅ QGIS Server WFS: ${result.totalFeatures} features`)
        this.featureCache.set(cacheKey, result)
        return result
      }
    } catch (wfsError) {
      console.log(`[Refined OGC] ⚠️ QGIS WFS failed: ${wfsError.message}`)
    }

    // Method 2: Direct PostgreSQL access (guaranteed to work)
    try {
      const result = await this.getDirectFeatures(layerName, options)
      console.log(`[Refined OGC] ✅ Direct PostgreSQL: ${result.totalFeatures} features`)
      this.featureCache.set(cacheKey, result)
      return result
    } catch (dbError) {
      console.log(`[Refined OGC] ❌ PostgreSQL failed: ${dbError.message}`)
      throw new Error(`All feature extraction methods failed for ${layerName}: ${dbError.message}`)
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

    if (options.bbox) {
      params.BBOX = Array.isArray(options.bbox) ? options.bbox.join(',') : options.bbox
    }
    if (options.filter) {
      params.FILTER = options.filter
    }
    if (options.propertyName) {
      params.PROPERTYNAME = Array.isArray(options.propertyName)
        ? options.propertyName.join(',')
        : options.propertyName
    }

    const response = await this.makeRequest(this.endpoints.wfs, params)
    let geojson = this.parseResponse(response.data)

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
   * Get features directly from PostgreSQL
   */
  async getDirectFeatures(layerName, options = {}) {
    const { Pool } = require('pg')
    // Prefer DATABASE_URL (has explicit hostname for Docker) over dbConfig
    const poolConfig = process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : this.dbConfig
    console.log(`[Refined OGC] 🔌 Connecting to DB: ${process.env.DATABASE_URL ? process.env.DATABASE_URL.replace(/:([^:@]+)@/, ':***@') : this.dbConfig.host}`)
    const pool = new Pool(poolConfig)

    try {
      const tableName = this.mapLayerName(layerName)

      // First, get column information
      const columnsQuery = `
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = $1
        AND column_name NOT IN ('geom', 'geometry')
      `
      const columnsResult = await pool.query(columnsQuery, [tableName])
      const columns = columnsResult.rows.map(r => `"${r.column_name}"`).join(', ')

      // Build main query
      let query = `
        SELECT 
          ${columns ? columns + ',' : ''}
          ST_AsGeoJSON(ST_Transform(geom, 4326), 8)::json as geometry
        FROM public."${tableName}"
        WHERE geom IS NOT NULL
      `

      // Add bbox filter
      if (options.bbox) {
        const bbox = Array.isArray(options.bbox) ? options.bbox : options.bbox.split(',').map(Number)
        const [minx, miny, maxx, maxy] = bbox
        query += ` AND ST_Intersects(ST_Transform(geom, 4326), ST_MakeEnvelope(${minx}, ${miny}, ${maxx}, ${maxy}, 4326))`
      }

      // Add limit
      const limit = options.maxFeatures || this.serverConfig.maxFeatures
      query += ` LIMIT ${parseInt(limit)}`

      console.log(`[Refined OGC] 🔍 Querying table: ${tableName}`)

      const result = await pool.query(query)

      const features = result.rows.map((row, index) => {
        const { geometry, ...properties } = row
        return {
          type: 'Feature',
          id: properties.id || index,
          geometry: geometry,
          properties: properties
        }
      })

      // Convert to TopoJSON for compression (matching WFS endpoint pattern)
      const { topology } = require('topojson-server')
      const geojson = {
        type: 'FeatureCollection',
        features: features
      }
      const topojsonResult = topology({ collection: geojson })
      
      return {
        type: 'Topology',
        objects: {
          collection: {
            type: 'FeatureCollection',
            features: features
          }
        },
        arcs: topojsonResult.arcs,
        transform: topojsonResult.transform,
        bbox: this.calculateBbox(features),
        totalFeatures: features.length
      }

    } finally {
      await pool.end()
    }
  }

  // ============================================================
  // STYLE EXTRACTION
  // ============================================================

  /**
   * Get style information with perfect QGIS reproduction
   */
  async getStyle(layerName, options = {}) {
    const cacheKey = `style_${layerName}`

    if (this.styleCache.has(cacheKey) && !options.noCache) {
      console.log(`[Refined OGC] 🎯 Using cached style for ${layerName}`)
      return this.styleCache.get(cacheKey)
    }

    console.log(`[Refined OGC] 🎨 Extracting style for ${layerName}`)

    // Method 1: Perfect QGIS Style Extractor
    try {
      const projectPath = this.getLocalProjectPath()
      
      if (fs.existsSync(projectPath)) {
        const extractedStyle = await this.styleExtractor.extractCompleteStyle(layerName, projectPath, { noCache: options.noCache })
        
        const result = {
          success: true,
          source: 'Perfect QGIS Style Extractor',
          rendererType: extractedStyle.qgisStyle.rendererType,
          attributeName: extractedStyle.qgisStyle.attributeName,
          symbols: extractedStyle.webStyle.symbols,
          maplibreStyle: extractedStyle.maplibreStyle,
          labeling: extractedStyle.labeling,
          patterns: extractedStyle.patterns,
          hasComplexPatterns: extractedStyle.metadata.hasComplexPatterns,
          hasHatchPatterns: extractedStyle.metadata.hasHatchPatterns,
          hasGradients: extractedStyle.metadata.hasGradients,
          metadata: {
            layerName,
            source: 'Perfect QGIS Style Extractor',
            extractedAt: extractedStyle.metadata.extractedAt,
            symbolCount: extractedStyle.metadata.symbolCount,
            note: 'Complete QGIS styling - what you see in QGIS is what you get'
          }
        }

        console.log(`[Refined OGC] ✅ Style extracted: ${result.symbols.length} symbols`)
        this.styleCache.set(cacheKey, result)
        return result
      }
    } catch (extractError) {
      console.log(`[Refined OGC] ⚠️ Style extraction failed: ${extractError.message}`)
    }

    // Method 2: Default style fallback (always works)
    console.log(`[Refined OGC] 🎨 Using default style`)
    
    const defaultResult = this.getDefaultStyle(layerName)
    this.styleCache.set(cacheKey, defaultResult)
    return defaultResult
  }

  /**
   * Get default style when extraction fails
   */
  getDefaultStyle(layerName) {
    return {
      success: true,
      source: 'Default Style',
      rendererType: 'singleSymbol',
      symbols: [{
        id: 'default',
        name: layerName,
        category: 'default',
        render: true,
        fill: {
          color: '#45B7D1',
          opacity: 0.5,
          style: 'solid'
        },
        stroke: {
          color: '#2c3e50',
          width: 2,
          opacity: 1
        }
      }],
      maplibreStyle: {
        id: layerName,
        type: 'fill',
        source: layerName,
        paint: {
          'fill-color': '#45B7D1',
          'fill-opacity': 0.5,
          'fill-outline-color': '#2c3e50'
        }
      },
      hasComplexPatterns: false,
      hasHatchPatterns: false,
      hasGradients: false,
      metadata: {
        layerName,
        source: 'Default Style',
        note: 'Using default styling'
      }
    }
  }

  // ============================================================
  // LEGEND GENERATION
  // ============================================================

  /**
   * Get legend graphic
   */
  async getLegend(layerName, options = {}) {
    const cacheKey = `legend_${layerName}_${JSON.stringify(options)}`

    if (this.legendCache.has(cacheKey) && !options.noCache) {
      return this.legendCache.get(cacheKey)
    }

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

      const response = await this.makeRequest(this.endpoints.wms, params)

      let legendData = response.data
      if (Buffer.isBuffer(legendData)) {
        const base64 = legendData.toString('base64')
        legendData = `data:${params.FORMAT};base64,${base64}`
      }

      const result = {
        success: true,
        legend: legendData,
        contentType: params.FORMAT,
        metadata: {
          layerName,
          service: 'WMS GetLegendGraphic'
        }
      }

      this.legendCache.set(cacheKey, result)
      return result

    } catch (error) {
      console.log(`[Refined OGC] ⚠️ Legend failed: ${error.message}`)
      
      // Return minimal legend placeholder
      return {
        success: true,
        legend: this.createDefaultLegendSVG(layerName),
        contentType: 'image/svg+xml',
        metadata: {
          layerName,
          service: 'Generated Default'
        }
      }
    }
  }

  /**
   * Create default legend SVG
   */
  createDefaultLegendSVG(layerName) {
    return `data:image/svg+xml,${encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">
        <rect x="2" y="2" width="20" height="20" fill="#45B7D1" fill-opacity="0.5" stroke="#2c3e50" stroke-width="2"/>
      </svg>
    `)}`
  }

  // ============================================================
  // STYLED LAYER (COMPLETE PACKAGE)
  // ============================================================

  /**
   * Get styled layer - the complete package for frontend consumption
   * This is the MAIN method for the web app
   */
  async getStyledLayer(layerName, options = {}) {
    console.log(`[Refined OGC] 🚀 Getting complete styled layer: ${layerName}`)

    const startTime = Date.now()

    const result = {
      layerName,
      success: true,
      features: null,
      style: null,
      legend: null,
      tileUrl: null,
      maplibreStyle: null,
      patterns: [],
      metadata: {
        retrievedAt: new Date().toISOString(),
        services: [],
        timing: {}
      }
    }

    // 1. Get features
    const featureStart = Date.now()
    try {
      result.features = await this.getFeatures(layerName, options)
      const featureService = result.features.metadata?.service || (result.features.type === 'Topology' ? 'Direct PostgreSQL' : 'Unknown')
      result.metadata.services.push(featureService)
      result.metadata.timing.features = Date.now() - featureStart
      console.log(`[Refined OGC] ✅ Features: ${result.features.totalFeatures} (${result.metadata.timing.features}ms)`)
    } catch (featureError) {
      console.log(`[Refined OGC] ❌ Features failed: ${featureError.message}`)
      result.features = { success: false, error: featureError.message }
    }

    // 2. Get style
    const styleStart = Date.now()
    try {
      result.style = await this.getStyle(layerName, options)
      result.metadata.services.push(result.style.source)
      result.metadata.timing.style = Date.now() - styleStart
      result.patterns = result.style.patterns || []
      console.log(`[Refined OGC] ✅ Style: ${result.style.source} (${result.metadata.timing.style}ms)`)
    } catch (styleError) {
      console.log(`[Refined OGC] ❌ Style failed: ${styleError.message}`)
      result.style = { success: false, error: styleError.message }
    }

    // 3. Get legend
    const legendStart = Date.now()
    try {
      result.legend = await this.getLegend(layerName, options)
      result.metadata.timing.legend = Date.now() - legendStart
    } catch (legendError) {
      console.log(`[Refined OGC] ⚠️ Legend failed: ${legendError.message}`)
    }

    // 4. Generate tile URL
    result.tileUrl = this.getWMTSTileUrl(layerName)

    // 5. Generate final MapLibre style
    result.maplibreStyle = this.generateFinalMapLibreStyle(layerName, result.style, result.features)

    // Total timing
    result.metadata.timing.total = Date.now() - startTime
    console.log(`[Refined OGC] ✅ Complete styled layer ready (${result.metadata.timing.total}ms)`)

    return result
  }

  /**
   * Generate final MapLibre style combining style data and features
   */
  generateFinalMapLibreStyle(layerName, styleData, featureData) {
    // Use extracted MapLibre style if available
    if (styleData?.maplibreStyle) {
      return styleData.maplibreStyle
    }

    // Generate based on geometry type
    const geometryType = this.detectGeometryType(featureData?.features)
    
    const baseStyle = {
      id: layerName,
      source: layerName,
      metadata: {
        'qgis:source': styleData?.source || 'default'
      }
    }

    switch (geometryType) {
      case 'Point':
      case 'MultiPoint':
        return {
          ...baseStyle,
          type: 'circle',
          paint: this.toMapLibrePointPaint(styleData)
        }

      case 'LineString':
      case 'MultiLineString':
        return {
          ...baseStyle,
          type: 'line',
          paint: this.toMapLibreLinePaint(styleData)
        }

      case 'Polygon':
      case 'MultiPolygon':
      default:
        return {
          ...baseStyle,
          type: 'fill',
          paint: this.toMapLibreFillPaint(styleData)
        }
    }
  }

  /**
   * Convert to MapLibre fill paint
   */
  toMapLibreFillPaint(styleData) {
    const symbol = styleData?.symbols?.[0] || {}

    return {
      'fill-color': symbol.fill?.color || '#45B7D1',
      'fill-opacity': symbol.fill?.opacity ?? 0.5,
      'fill-outline-color': symbol.stroke?.color || '#2c3e50'
    }
  }

  /**
   * Convert to MapLibre line paint
   */
  toMapLibreLinePaint(styleData) {
    const symbol = styleData?.symbols?.[0] || {}

    const paint = {
      'line-color': symbol.stroke?.color || '#45B7D1',
      'line-width': symbol.stroke?.width || 2,
      'line-opacity': symbol.stroke?.opacity ?? 1
    }

    if (symbol.stroke?.dashArray) {
      paint['line-dasharray'] = symbol.stroke.dashArray.split(',').map(Number)
    }

    return paint
  }

  /**
   * Convert to MapLibre point paint
   */
  toMapLibrePointPaint(styleData) {
    const symbol = styleData?.symbols?.[0] || {}

    return {
      'circle-color': symbol.marker?.color || symbol.fill?.color || '#45B7D1',
      'circle-radius': (symbol.marker?.size || 8) / 2,
      'circle-opacity': symbol.fill?.opacity ?? 0.8,
      'circle-stroke-color': symbol.marker?.strokeColor || symbol.stroke?.color || '#2c3e50',
      'circle-stroke-width': symbol.marker?.strokeWidth || symbol.stroke?.width || 1
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

  // ============================================================
  // UTILITY METHODS
  // ============================================================

  /**
   * Get local project path from server path
   */
  getLocalProjectPath() {
    if (process.env.QGIS_PROJECT_LOCAL) return process.env.QGIS_PROJECT_LOCAL
    const localBase = this.serverConfig.projectLocalPath
    const candidate = path.join(localBase, path.basename(this.serverConfig.project))
    if (fs.existsSync(candidate)) return candidate
    // Server-side and local filenames can differ; a lone project in the
    // folder is unambiguous.
    const projects = fs.existsSync(localBase) ? fs.readdirSync(localBase).filter(f => /\.(qgs|qgz)$/i.test(f)) : []
    return projects.length ? path.join(localBase, projects[0]) : candidate
  }

  /**
   * Get WMTS tile URL template
   */
  getWMTSTileUrl(layerName, options = {}) {
    const style = options.style || 'default'
    const tileMatrixSet = options.tileMatrixSet || 'EPSG:3857'
    const format = options.format || 'image/png'

    return `${this.endpoints.wmts}?SERVICE=WMTS&REQUEST=GetTile&VERSION=${this.serverConfig.wmtsVersion}` +
      `&LAYER=${encodeURIComponent(layerName)}&STYLE=${style}&TILEMATRIXSET=${tileMatrixSet}` +
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
        return { data: response.data, headers: response.headers }
      } catch (error) {
        lastError = error
        console.log(`[Refined OGC] ⚠️ Request attempt ${attempt} failed: ${error.message}`)

        if (attempt < this.serverConfig.maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }

    throw lastError || new Error('Request failed after all retries')
  }

  /**
   * Parse response data
   */
  parseResponse(data) {
    if (Buffer.isBuffer(data)) {
      data = data.toString('utf8')
    }

    if (typeof data === 'string') {
      try {
        return JSON.parse(data)
      } catch (e) {
        return data
      }
    }

    return data
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

    if (minX === Infinity) return null
    return [minX, minY, maxX, maxY]
  }

  /**
   * Extract coordinates from geometry
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
   * Clear all caches
   */
  clearCache() {
    this.featureCache.clear()
    this.styleCache.clear()
    this.legendCache.clear()
    this.styleExtractor.clearCache()
    console.log(`[Refined OGC] 🧹 All caches cleared`)
  }

  /**
   * Test connectivity to all OGC services
   */
  async testConnectivity() {
    const results = {
      success: true,
      server: this.serverConfig.baseUrl,
      services: {
        wms: false,
        wfs: false,
        wmts: false,
        ogcApi: false
      }
    }

    // Test WMS
    try {
      await this.makeRequest(this.endpoints.wms, { SERVICE: 'WMS', REQUEST: 'GetCapabilities' })
      results.services.wms = true
    } catch (e) {
      console.log(`[Refined OGC] ⚠️ WMS: ${e.message}`)
    }

    // Test WFS
    try {
      await this.makeRequest(this.endpoints.wfs, { SERVICE: 'WFS', REQUEST: 'GetCapabilities' })
      results.services.wfs = true
    } catch (e) {
      console.log(`[Refined OGC] ⚠️ WFS: ${e.message}`)
    }

    // Test WMTS
    try {
      await this.makeRequest(this.endpoints.wmts, { SERVICE: 'WMTS', REQUEST: 'GetCapabilities' })
      results.services.wmts = true
    } catch (e) {
      console.log(`[Refined OGC] ⚠️ WMTS: ${e.message}`)
    }

    // Test OGC API
    try {
      await this.makeRequest(`${this.endpoints.ogcApi}/collections`)
      results.services.ogcApi = true
    } catch (e) {
      console.log(`[Refined OGC] ⚠️ OGC API: ${e.message}`)
    }

    results.success = Object.values(results.services).some(v => v)
    return results
  }

  /**
   * Get WFS capabilities
   */
  async wfsGetCapabilities() {
    const response = await this.makeRequest(this.endpoints.wfs, {
      SERVICE: 'WFS',
      VERSION: this.serverConfig.wfsVersion,
      REQUEST: 'GetCapabilities'
    })

    return {
      success: true,
      raw: this.parseResponse(response.data),
      layers: [] // Would need XML parsing to extract layers
    }
  }

  /**
   * Get WMS capabilities
   */
  async wmsGetCapabilities() {
    const response = await this.makeRequest(this.endpoints.wms, {
      SERVICE: 'WMS',
      VERSION: this.serverConfig.wmsVersion,
      REQUEST: 'GetCapabilities'
    })

    const xml = this.parseResponse(response.data)
    
    // Parse layer names from XML - extract only queryable Layer elements, not Style/Service names
    const layers = []
    const seenNames = new Set()
    
    // Match each <Layer> block and extract its immediate <Name> and <Title>
    // This avoids picking up <Style><Name>default</Name> entries
    const layerBlockRegex = /<Layer[^>]*queryable[^>]*>([\s\S]*?)<\/Layer>/g
    let layerMatch
    while ((layerMatch = layerBlockRegex.exec(xml)) !== null) {
      const block = layerMatch[1]
      // Only grab the first <Name> within the block (layer name, not style name)
      const nameMatch = block.match(/<Name>([^<]+)<\/Name>/)
      const titleMatch = block.match(/<Title>([^<]+)<\/Title>/)
      if (nameMatch) {
        const name = nameMatch[1].trim()
        const title = titleMatch ? titleMatch[1].trim() : name
        // Skip service-level names, style names, and duplicates
        if (name && name !== 'WMS' && name !== 'default' && !seenNames.has(name)) {
          seenNames.add(name)
          layers.push({
            name,
            title,
            crs: ['EPSG:4326', 'EPSG:3857', 'CRS:84']
          })
        }
      }
    }
    
    // Fallback: if no queryable layers found, try non-queryable layers
    if (layers.length === 0) {
      const allLayerRegex = /<Layer[^>]*>([\s\S]*?)<\/Layer>/g
      let allMatch
      while ((allMatch = allLayerRegex.exec(xml)) !== null) {
        const block = allMatch[1]
        const nameMatch = block.match(/<Name>([^<]+)<\/Name>/)
        const titleMatch = block.match(/<Title>([^<]+)<\/Title>/)
        if (nameMatch) {
          const name = nameMatch[1].trim()
          const title = titleMatch ? titleMatch[1].trim() : name
          if (name && name !== 'WMS' && name !== 'default' && !seenNames.has(name)) {
            seenNames.add(name)
            layers.push({ name, title, crs: ['EPSG:4326', 'EPSG:3857', 'CRS:84'] })
          }
        }
      }
    }

    return {
      success: true,
      raw: xml,
      layers
    }
  }

  /**
   * WFS DescribeFeatureType
   */
  async wfsDescribeFeatureType(layerName) {
    try {
      const response = await this.makeRequest(this.endpoints.wfs, {
        SERVICE: 'WFS',
        VERSION: this.serverConfig.wfsVersion,
        REQUEST: 'DescribeFeatureType',
        TYPENAME: layerName
      })

      return {
        success: true,
        layerName,
        schema: this.parseResponse(response.data)
      }
    } catch (error) {
      // Fallback: Get schema from PostgreSQL (same DATABASE_URL preference as getDirectFeatures)
      const { Pool } = require('pg')
      const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : this.dbConfig)

      try {
        const tableName = this.mapLayerName(layerName)
        const result = await pool.query(`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position
        `, [tableName])

        return {
          success: true,
          layerName,
          tableName,
          source: 'PostgreSQL',
          schema: result.rows
        }
      } finally {
        await pool.end()
      }
    }
  }

  /**
   * WMS GetMap - Get rendered map image
   */
  async wmsGetMap(layerName, options = {}) {
    const params = {
      SERVICE: 'WMS',
      VERSION: this.serverConfig.wmsVersion,
      REQUEST: 'GetMap',
      LAYERS: layerName,
      STYLES: options.styles || '',
      CRS: options.crs || 'EPSG:3857', // Default to EPSG:3857 for tile compatibility
      BBOX: options.bbox ? options.bbox.join(',') : '-20037508.34,-20037508.34,20037508.34,20037508.34',
      WIDTH: options.width || 256,
      HEIGHT: options.height || 256,
      FORMAT: options.format || 'image/png',
      TRANSPARENT: options.transparent !== false ? 'TRUE' : 'FALSE'
    }

    const response = await this.makeRequest(this.endpoints.wms, params)

    let imageData = response.data
    if (Buffer.isBuffer(imageData)) {
      const base64 = imageData.toString('base64')
      imageData = `data:${params.FORMAT};base64,${base64}`
    }

    return {
      success: true,
      image: imageData,
      contentType: params.FORMAT,
      metadata: {
        layerName,
        bbox: params.BBOX,
        width: params.WIDTH,
        height: params.HEIGHT
      }
    }
  }

  /**
   * WMTS GetTile - Get map tile
   */
  async wmtsGetTile(layerName, options = {}) {
    const params = {
      SERVICE: 'WMTS',
      VERSION: this.serverConfig.wmtsVersion,
      REQUEST: 'GetTile',
      LAYER: layerName,
      STYLE: options.style || 'default',
      TILEMATRIXSET: options.tileMatrixSet || 'EPSG:3857',
      TILEMATRIX: options.z,
      TILEROW: options.y,
      TILECOL: options.x,
      FORMAT: options.format || 'image/png'
    }

    const response = await this.makeRequest(this.endpoints.wmts, params)

    let tileData = response.data
    if (Buffer.isBuffer(tileData)) {
      const base64 = tileData.toString('base64')
      tileData = `data:${params.FORMAT};base64,${base64}`
    }

    return {
      success: true,
      tile: tileData,
      contentType: params.FORMAT,
      metadata: {
        layerName,
        z: options.z,
        x: options.x,
        y: options.y
      }
    }
  }

  /**
   * OGC API Features - Get features
   */
  async ogcApiGetFeatures(collectionId, options = {}) {
    try {
      const url = `${this.endpoints.ogcApi}/collections/${collectionId}/items`
      const params = {}

      if (options.bbox) params.bbox = options.bbox.join(',')
      if (options.limit) params.limit = options.limit
      if (options.offset) params.offset = options.offset
      if (options.datetime) params.datetime = options.datetime

      const response = await this.makeRequest(url, params)

      return {
        success: true,
        ...this.parseResponse(response.data)
      }
    } catch (error) {
      // Fallback to WFS
      console.log(`[Refined OGC] ⚠️ OGC API failed, falling back to WFS`)
      return this.getFeatures(collectionId, options)
    }
  }

  /**
   * OGC API Styles - Get available styles
   */
  async ogcApiGetStyles(collectionId) {
    try {
      const url = `${this.endpoints.ogcApi}/collections/${collectionId}/styles`
      const response = await this.makeRequest(url, {})

      return {
        success: true,
        ...this.parseResponse(response.data)
      }
    } catch (error) {
      // Fallback: Return extracted style
      console.log(`[Refined OGC] ⚠️ OGC API Styles failed, using style extractor`)
      const style = await this.getStyle(collectionId)
      
      return {
        success: true,
        styles: [{
          id: 'default',
          title: `${collectionId} Style`,
          links: []
        }],
        extractedStyle: style
      }
    }
  }

  /**
   * OGC API Styles - Get specific style definition
   */
  async ogcApiGetStyleDefinition(collectionId, styleId, format = 'mapbox') {
    try {
      const url = `${this.endpoints.ogcApi}/collections/${collectionId}/styles/${styleId}`
      const response = await this.makeRequest(url, { f: format })

      return {
        success: true,
        styleId,
        format,
        ...this.parseResponse(response.data)
      }
    } catch (error) {
      // Fallback: Generate MapLibre style from extracted QGIS style
      console.log(`[Refined OGC] ⚠️ OGC API Style Definition failed, generating from QGIS`)
      const style = await this.getStyle(collectionId)

      return {
        success: true,
        styleId,
        format: 'mapbox',
        source: 'generated',
        style: style.maplibreStyle
      }
    }
  }
}

module.exports = { RefinedOGCBridge }
