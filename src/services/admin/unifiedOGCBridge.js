/**
 * Unified OGC Services Bridge
 * Complete WMS/WFS/WMTS/OGC API integration for QGIS-to-Frontend styling
 * 
 * Services:
 * - WMS: Web Map Service (pre-rendered tiles/images)
 * - WFS: Web Feature Service (vector features with attributes)
 * - WMTS: Web Map Tile Service (cached tiles)
 * - OGC API: Modern REST-based feature and style services
 */

const axios = require('axios')
const { SmartQGISExtractor } = require('./smartQGISExtractor')

class UnifiedOGCBridge extends SmartQGISExtractor {
  constructor(config = {}) {
    super()
    
    // Server configuration
    this.serverConfig = {
      baseUrl: config.baseUrl || process.env.QGIS_SERVER_URL || 'http://localhost:8080',
      wmsVersion: config.wmsVersion || '1.3.0',
      wfsVersion: config.wfsVersion || '2.0.0',
      wmtsVersion: config.wmtsVersion || '1.0.0',
      project: config.project || process.env.QGIS_PROJECT || '/vungu-project.qgs',
      timeout: config.timeout || 30000,
      maxRetries: config.maxRetries || 3,
      defaultSRS: config.defaultSRS || 'EPSG:4326',
      maxFeatures: config.maxFeatures || 10000,
      ...config
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
    
    console.log(`[UnifiedOGC] 🚀 Initialized Unified OGC Bridge`)
    console.log(`[UnifiedOGC] 🌐 Server: ${this.serverConfig.baseUrl}`)
    console.log(`[UnifiedOGC] 📁 Project: ${this.serverConfig.project}`)
    console.log(`[UnifiedOGC] 🗺️ Services: WMS ${this.serverConfig.wmsVersion}, WFS ${this.serverConfig.wfsVersion}, WMTS ${this.serverConfig.wmtsVersion}`)
  }

  // ============================================================
  // WFS - Web Feature Service (Vector Features)
  // ============================================================
  
  /**
   * WFS GetFeature - Retrieve vector features as GeoJSON
   * This is the PRIMARY method for getting styled vector data
   */
  async wfsGetFeature(layerName, options = {}) {
    const cacheKey = `wfs_features_${layerName}_${JSON.stringify(options)}`
    
    if (this.featureCache.has(cacheKey) && !options.noCache) {
      console.log(`[UnifiedOGC] 🎯 Using cached WFS features for ${layerName}`)
      return this.featureCache.get(cacheKey)
    }
    
    try {
      const params = {
        SERVICE: 'WFS',
        VERSION: this.serverConfig.wfsVersion,
        REQUEST: 'GetFeature',
        TYPENAME: layerName,
        OUTPUTFORMAT: options.format || 'application/json', // GeoJSON
        SRSNAME: options.srs || this.serverConfig.defaultSRS,
        COUNT: options.maxFeatures || this.serverConfig.maxFeatures
      }
      
      // Add optional filters
      if (options.bbox) {
        params.BBOX = options.bbox.join(',')
      }
      if (options.filter) {
        params.FILTER = options.filter // CQL or OGC Filter
      }
      if (options.propertyName) {
        params.PROPERTYNAME = Array.isArray(options.propertyName) 
          ? options.propertyName.join(',') 
          : options.propertyName
      }
      if (options.sortBy) {
        params.SORTBY = options.sortBy
      }
      
      console.log(`[UnifiedOGC] 📦 WFS GetFeature request for ${layerName}`)
      console.log(`[UnifiedOGC] 📋 Parameters:`, params)
      
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
      
      const result = {
        success: true,
        type: 'FeatureCollection',
        features: geojson.features || [],
        totalFeatures: geojson.totalFeatures || geojson.numberMatched || geojson.features?.length || 0,
        crs: geojson.crs || { type: 'name', properties: { name: this.serverConfig.defaultSRS } },
        metadata: {
          layerName,
          service: 'WFS',
          version: this.serverConfig.wfsVersion,
          format: 'GeoJSON',
          retrievedAt: new Date().toISOString(),
          bbox: this.calculateBbox(geojson.features || [])
        }
      }
      
      console.log(`[UnifiedOGC] ✅ WFS GetFeature success: ${result.totalFeatures} features`)
      
      // Cache the result
      this.featureCache.set(cacheKey, result)
      
      return result
      
    } catch (error) {
      console.error(`[UnifiedOGC] ❌ WFS GetFeature failed for ${layerName}:`, error.message)
      throw new Error(`WFS GetFeature failed: ${error.message}`)
    }
  }
  
  /**
   * WFS DescribeFeatureType - Get layer schema
   */
  async wfsDescribeFeatureType(layerName) {
    try {
      const params = {
        SERVICE: 'WFS',
        VERSION: this.serverConfig.wfsVersion,
        REQUEST: 'DescribeFeatureType',
        TYPENAME: layerName,
        OUTPUTFORMAT: 'application/json'
      }
      
      console.log(`[UnifiedOGC] 📋 WFS DescribeFeatureType for ${layerName}`)
      
      const response = await this.makeRequest(this.endpoints.wfs, params)
      
      return {
        success: true,
        schema: response.data,
        metadata: {
          layerName,
          service: 'WFS',
          request: 'DescribeFeatureType'
        }
      }
    } catch (error) {
      console.error(`[UnifiedOGC] ❌ WFS DescribeFeatureType failed:`, error.message)
      throw error
    }
  }
  
  /**
   * WFS GetCapabilities - Discover available layers
   */
  async wfsGetCapabilities() {
    try {
      const params = {
        SERVICE: 'WFS',
        VERSION: this.serverConfig.wfsVersion,
        REQUEST: 'GetCapabilities'
      }
      
      console.log(`[UnifiedOGC] 📋 WFS GetCapabilities`)
      
      const response = await this.makeRequest(this.endpoints.wfs, params)
      
      // Parse capabilities to extract layer list
      const layers = this.parseWFSCapabilities(response.data)
      
      return {
        success: true,
        layers,
        raw: response.data,
        metadata: {
          service: 'WFS',
          version: this.serverConfig.wfsVersion,
          server: this.serverConfig.baseUrl
        }
      }
    } catch (error) {
      console.error(`[UnifiedOGC] ❌ WFS GetCapabilities failed:`, error.message)
      throw error
    }
  }

  // ============================================================
  // WMS - Web Map Service (Rendered Images)
  // ============================================================
  
  /**
   * WMS GetMap - Get rendered map image
   */
  async wmsGetMap(layerName, options = {}) {
    try {
      const params = {
        SERVICE: 'WMS',
        VERSION: this.serverConfig.wmsVersion,
        REQUEST: 'GetMap',
        LAYERS: layerName,
        STYLES: options.styles || '',
        CRS: options.crs || this.serverConfig.defaultSRS,
        BBOX: options.bbox?.join(',') || '-180,-90,180,90',
        WIDTH: options.width || 256,
        HEIGHT: options.height || 256,
        FORMAT: options.format || 'image/png',
        TRANSPARENT: options.transparent !== false ? 'TRUE' : 'FALSE'
      }
      
      console.log(`[UnifiedOGC] 🖼️ WMS GetMap for ${layerName}`)
      
      const response = await this.makeRequest(this.endpoints.wms, params)
      
      // Convert to base64 data URL
      let imageData = response.data
      if (Buffer.isBuffer(imageData) || imageData instanceof ArrayBuffer) {
        const base64 = Buffer.from(imageData).toString('base64')
        imageData = `data:${params.FORMAT};base64,${base64}`
      }
      
      return {
        success: true,
        image: imageData,
        contentType: params.FORMAT,
        metadata: {
          layerName,
          service: 'WMS',
          request: 'GetMap',
          bbox: params.BBOX,
          size: { width: params.WIDTH, height: params.HEIGHT }
        }
      }
    } catch (error) {
      console.error(`[UnifiedOGC] ❌ WMS GetMap failed:`, error.message)
      throw error
    }
  }
  
  /**
   * WMS GetLegendGraphic - Get layer legend/symbol
   */
  async wmsGetLegendGraphic(layerName, options = {}) {
    try {
      const params = {
        SERVICE: 'WMS',
        VERSION: this.serverConfig.wmsVersion,
        REQUEST: 'GetLegendGraphic',
        LAYER: layerName,
        FORMAT: options.format || 'image/png',
        WIDTH: options.width || 20,
        HEIGHT: options.height || 20,
        SCALE: options.scale || 1000000,
        RULELABEL: options.ruleLabel !== false ? 'TRUE' : 'FALSE'
      }
      
      if (options.rule) {
        params.RULE = options.rule
      }
      
      console.log(`[UnifiedOGC] 🎨 WMS GetLegendGraphic for ${layerName}`)
      
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
      console.error(`[UnifiedOGC] ❌ WMS GetLegendGraphic failed:`, error.message)
      throw error
    }
  }
  
  /**
   * WMS GetCapabilities
   */
  async wmsGetCapabilities() {
    try {
      const params = {
        SERVICE: 'WMS',
        VERSION: this.serverConfig.wmsVersion,
        REQUEST: 'GetCapabilities'
      }
      
      console.log(`[UnifiedOGC] 📋 WMS GetCapabilities`)
      
      const response = await this.makeRequest(this.endpoints.wms, params)
      
      return {
        success: true,
        capabilities: response.data,
        metadata: {
          service: 'WMS',
          version: this.serverConfig.wmsVersion
        }
      }
    } catch (error) {
      console.error(`[UnifiedOGC] ❌ WMS GetCapabilities failed:`, error.message)
      throw error
    }
  }

  // ============================================================
  // WMTS - Web Map Tile Service (Cached Tiles)
  // ============================================================
  
  /**
   * WMTS GetTile - Get cached map tile
   */
  async wmtsGetTile(layerName, options = {}) {
    try {
      const params = {
        SERVICE: 'WMTS',
        VERSION: this.serverConfig.wmtsVersion,
        REQUEST: 'GetTile',
        LAYER: layerName,
        STYLE: options.style || 'default',
        TILEMATRIXSET: options.tileMatrixSet || 'EPSG:3857',
        TILEMATRIX: options.tileMatrix || options.z || 0,
        TILEROW: options.tileRow || options.y || 0,
        TILECOL: options.tileCol || options.x || 0,
        FORMAT: options.format || 'image/png'
      }
      
      console.log(`[UnifiedOGC] 🧩 WMTS GetTile for ${layerName} (z=${params.TILEMATRIX}, x=${params.TILECOL}, y=${params.TILEROW})`)
      
      const response = await this.makeRequest(this.endpoints.wmts, params)
      
      // Convert to base64
      let tileData = response.data
      if (Buffer.isBuffer(tileData) || tileData instanceof ArrayBuffer) {
        const base64 = Buffer.from(tileData).toString('base64')
        tileData = `data:${params.FORMAT};base64,${base64}`
      }
      
      return {
        success: true,
        tile: tileData,
        contentType: params.FORMAT,
        metadata: {
          layerName,
          service: 'WMTS',
          z: params.TILEMATRIX,
          x: params.TILECOL,
          y: params.TILEROW
        }
      }
    } catch (error) {
      console.error(`[UnifiedOGC] ❌ WMTS GetTile failed:`, error.message)
      throw error
    }
  }
  
  /**
   * Get WMTS tile URL template for MapLibre/Leaflet
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

  // ============================================================
  // OGC API Features (Modern REST API)
  // ============================================================
  
  /**
   * OGC API Features - Get features (modern REST endpoint)
   */
  async ogcApiGetFeatures(collectionId, options = {}) {
    try {
      let url = `${this.endpoints.ogcApiFeatures}/collections/${collectionId}/items`
      
      const params = {
        limit: options.limit || 1000,
        offset: options.offset || 0,
        f: options.format || 'json'
      }
      
      if (options.bbox) {
        params.bbox = options.bbox.join(',')
      }
      if (options.datetime) {
        params.datetime = options.datetime
      }
      if (options.properties) {
        params.properties = options.properties.join(',')
      }
      
      console.log(`[UnifiedOGC] 🔗 OGC API Features for ${collectionId}`)
      
      const response = await this.makeRequest(url, params)
      
      let geojson = response.data
      if (typeof geojson === 'string') {
        geojson = JSON.parse(geojson)
      }
      if (Buffer.isBuffer(geojson)) {
        geojson = JSON.parse(geojson.toString('utf8'))
      }
      
      return {
        success: true,
        type: 'FeatureCollection',
        features: geojson.features || [],
        numberMatched: geojson.numberMatched,
        numberReturned: geojson.numberReturned || geojson.features?.length,
        links: geojson.links,
        metadata: {
          collectionId,
          service: 'OGC API Features',
          format: 'GeoJSON'
        }
      }
    } catch (error) {
      console.error(`[UnifiedOGC] ❌ OGC API Features failed:`, error.message)
      throw error
    }
  }
  
  /**
   * OGC API Styles - Get style for collection
   */
  async ogcApiGetStyles(collectionId) {
    try {
      const url = `${this.endpoints.ogcApiStyles}/collections/${collectionId}/styles`
      
      console.log(`[UnifiedOGC] 🎨 OGC API Styles for ${collectionId}`)
      
      const response = await this.makeRequest(url, {})
      
      return {
        success: true,
        styles: response.data.styles || [],
        metadata: {
          collectionId,
          service: 'OGC API Styles'
        }
      }
    } catch (error) {
      console.error(`[UnifiedOGC] ❌ OGC API Styles failed:`, error.message)
      throw error
    }
  }
  
  /**
   * OGC API - Get specific style definition (SLD, Mapbox Style, etc.)
   */
  async ogcApiGetStyleDefinition(collectionId, styleId, format = 'mapbox') {
    try {
      const url = `${this.endpoints.ogcApiStyles}/collections/${collectionId}/styles/${styleId}`
      
      const params = {
        f: format // 'sld', 'mapbox', 'qml'
      }
      
      console.log(`[UnifiedOGC] 📜 OGC API Style Definition for ${collectionId}/${styleId}`)
      
      const response = await this.makeRequest(url, params)
      
      return {
        success: true,
        styleId,
        format,
        definition: response.data,
        metadata: {
          collectionId,
          service: 'OGC API Styles'
        }
      }
    } catch (error) {
      console.error(`[UnifiedOGC] ❌ OGC API Style Definition failed:`, error.message)
      throw error
    }
  }

  // ============================================================
  // Combined: Features + Styles (The Complete Package)
  // ============================================================
  
  /**
   * Get layer with features AND styles combined
   * This is the main method for frontend consumption
   */
  async getStyledLayer(layerName, options = {}) {
    console.log(`[UnifiedOGC] 🚀 Getting styled layer: ${layerName}`)
    
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
    
    // 1. Get vector features (WFS or OGC API Features)
    try {
      if (options.useOgcApi) {
        result.features = await this.ogcApiGetFeatures(layerName, options)
        result.metadata.services.push('OGC API Features')
      } else {
        result.features = await this.wfsGetFeature(layerName, options)
        result.metadata.services.push('WFS')
      }
      console.log(`[UnifiedOGC] ✅ Features loaded: ${result.features.totalFeatures || result.features.features?.length} features`)
    } catch (featureError) {
      console.log(`[UnifiedOGC] ⚠️ Feature loading failed: ${featureError.message}`)
      result.features = { success: false, error: featureError.message }
    }
    
    // 2. Get style information
    try {
      // Try OGC API Styles first (if available)
      if (options.useOgcApi) {
        try {
          const styles = await this.ogcApiGetStyles(layerName)
          if (styles.styles?.length > 0) {
            const defaultStyle = styles.styles[0]
            const styleDef = await this.ogcApiGetStyleDefinition(layerName, defaultStyle.id, 'mapbox')
            result.style = {
              source: 'OGC API Styles',
              ...styleDef
            }
            result.metadata.services.push('OGC API Styles')
          }
        } catch (ogcStyleError) {
          console.log(`[UnifiedOGC] ⚠️ OGC API Styles not available, trying Smart Extractor`)
        }
      }
      
      // Fallback to Smart Extractor
      if (!result.style) {
        const smartStyle = await super.extractStyle(layerName, {
          includeSVG: true,
          includeLabels: true,
          cache: true
        })
        result.style = {
          source: 'Smart Extractor',
          ...smartStyle
        }
        result.metadata.services.push('Smart Extractor')
      }
      
      console.log(`[UnifiedOGC] ✅ Style loaded from: ${result.style.source}`)
    } catch (styleError) {
      console.log(`[UnifiedOGC] ⚠️ Style loading failed: ${styleError.message}`)
      result.style = { success: false, error: styleError.message }
    }
    
    // 3. Get legend graphic
    try {
      result.legend = await this.wmsGetLegendGraphic(layerName, {
        format: 'image/png',
        width: 24,
        height: 24
      })
      result.metadata.services.push('WMS GetLegendGraphic')
      console.log(`[UnifiedOGC] ✅ Legend loaded`)
    } catch (legendError) {
      console.log(`[UnifiedOGC] ⚠️ Legend loading failed: ${legendError.message}`)
    }
    
    // 4. Generate tile URL for raster fallback
    result.tileUrl = this.getWMTSTileUrl(layerName)
    
    // 5. Convert to MapLibre-compatible format
    result.maplibreStyle = this.toMapLibreStyle(layerName, result.style, result.features)
    
    return result
  }
  
  /**
   * Convert extracted style to MapLibre GL JS compatible format
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
      // Default to circle for unknown
      maplibreStyle.type = 'circle'
      maplibreStyle.paint = this.toMapLibrePointPaint(styleData)
    }
    
    // Add categorized styling if available
    if (styleData?.symbols?.length > 1) {
      maplibreStyle.paint = this.toMapLibreCategorizedPaint(styleData, geometryType)
    }
    
    return maplibreStyle
  }
  
  /**
   * Convert to MapLibre point paint properties
   */
  toMapLibrePointPaint(styleData) {
    const symbol = styleData?.symbols?.[0]?.style || {}
    
    return {
      'circle-radius': symbol.size || 6,
      'circle-color': symbol.fill?.color || '#45B7D1',
      'circle-opacity': symbol.fill?.opacity || symbol.opacity || 0.8,
      'circle-stroke-color': symbol.stroke?.color || '#2c3e50',
      'circle-stroke-width': symbol.stroke?.width || 1,
      'circle-stroke-opacity': symbol.stroke?.opacity || 1
    }
  }
  
  /**
   * Convert to MapLibre line paint properties
   */
  toMapLibreLinePaint(styleData) {
    const symbol = styleData?.symbols?.[0]?.style || {}
    
    return {
      'line-color': symbol.stroke?.color || symbol.fill?.color || '#45B7D1',
      'line-width': symbol.stroke?.width || 2,
      'line-opacity': symbol.stroke?.opacity || symbol.opacity || 0.8
    }
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
   * Convert to MapLibre categorized paint (data-driven styling)
   */
  toMapLibreCategorizedPaint(styleData, geometryType) {
    const symbols = styleData?.symbols || []
    const attribute = styleData?.attribute || 'type'
    
    // Build match expression for categorized styling
    const colorStops = ['match', ['get', attribute]]
    
    for (const symbol of symbols) {
      colorStops.push(symbol.category || symbol.name)
      colorStops.push(symbol.style?.fill?.color || '#45B7D1')
    }
    
    // Default color
    colorStops.push('#BDC3C7')
    
    if (geometryType === 'Point' || geometryType === 'MultiPoint') {
      return {
        'circle-radius': 6,
        'circle-color': colorStops,
        'circle-opacity': 0.8,
        'circle-stroke-color': '#2c3e50',
        'circle-stroke-width': 1
      }
    } else if (geometryType === 'LineString' || geometryType === 'MultiLineString') {
      return {
        'line-color': colorStops,
        'line-width': 2,
        'line-opacity': 0.8
      }
    } else {
      return {
        'fill-color': colorStops,
        'fill-opacity': 0.5,
        'fill-outline-color': '#2c3e50'
      }
    }
  }

  // ============================================================
  // Utility Methods
  // ============================================================
  
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
        console.log(`[UnifiedOGC] ⚠️ Request attempt ${attempt} failed: ${error.message}`)
        
        if (attempt < this.serverConfig.maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }
    
    throw lastError || new Error('Request failed after all retries')
  }
  
  /**
   * Parse WFS GetCapabilities response
   */
  parseWFSCapabilities(capabilitiesXml) {
    const layers = []
    
    try {
      // Simple regex extraction for FeatureType names
      const featureTypeMatches = capabilitiesXml.match(/<Name>([^<]+)<\/Name>/g) || []
      
      for (const match of featureTypeMatches) {
        const name = match.replace(/<\/?Name>/g, '')
        if (name && !name.includes(':')) {
          layers.push({
            name,
            title: name
          })
        }
      }
    } catch (error) {
      console.log(`[UnifiedOGC] ⚠️ Error parsing WFS capabilities: ${error.message}`)
    }
    
    return layers
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
   * Detect geometry type from features
   */
  detectGeometryType(features) {
    if (!features || features.length === 0) return 'Point'
    
    const firstFeature = features[0]
    return firstFeature?.geometry?.type || 'Point'
  }
  
  /**
   * Test server connectivity
   */
  async testConnectivity() {
    const results = {
      wms: false,
      wfs: false,
      wmts: false,
      ogcApi: false
    }
    
    // Test WMS
    try {
      await this.wmsGetCapabilities()
      results.wms = true
    } catch (e) { /* ignore */ }
    
    // Test WFS
    try {
      await this.wfsGetCapabilities()
      results.wfs = true
    } catch (e) { /* ignore */ }
    
    // Test WMTS
    try {
      const params = { SERVICE: 'WMTS', REQUEST: 'GetCapabilities' }
      await this.makeRequest(this.endpoints.wmts, params)
      results.wmts = true
    } catch (e) { /* ignore */ }
    
    // Test OGC API
    try {
      await this.makeRequest(`${this.endpoints.ogcApiFeatures}/collections`, {})
      results.ogcApi = true
    } catch (e) { /* ignore */ }
    
    return {
      success: Object.values(results).some(v => v),
      services: results,
      server: this.serverConfig.baseUrl
    }
  }
  
  /**
   * Clear feature cache
   */
  clearCache() {
    this.featureCache.clear()
    super.clearCache && super.clearCache()
    console.log(`[UnifiedOGC] 🧹 Cache cleared`)
  }
}

module.exports = { UnifiedOGCBridge }
