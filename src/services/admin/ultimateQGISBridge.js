/**
 * Ultimate QGIS Server Bridge
 * Production-grade QGIS Server integration with intelligent fallbacks
 */

const axios = require('axios')
const { SmartQGISExtractor } = require('./smartQGISExtractor')

class UltimateQGISBridge extends SmartQGISExtractor {
  constructor(config = {}) {
    super()
    
    // QGIS Server configuration
    this.serverConfig = {
      baseUrl: config.baseUrl || process.env.QGIS_SERVER_URL || 'http://localhost:8080',
      version: config.version || '1.3.0',
      project: config.project || process.env.QGIS_PROJECT || '/vungu-project.qgs',
      timeout: config.timeout || 30000,
      maxRetries: config.maxRetries || 3,
      ...config
    }
    
    // Service endpoints
    this.endpoints = {
      wms: `${this.serverConfig.baseUrl}/wms`,
      wfs: `${this.serverConfig.baseUrl}/wfs`,
      wcs: `${this.serverConfig.baseUrl}/wcs`,
      oapi: `${this.serverConfig.baseUrl}/api/v1`
    }
    
    console.log(`[UltimateQGIS] 🚀 Initialized QGIS Server bridge`)
    console.log(`[UltimateQGIS] 🌐 Server: ${this.serverConfig.baseUrl}`)
    console.log(`[UltimateQGIS] 📁 Project: ${this.serverConfig.project}`)
  }
  
  /**
   * Ultimate extraction with QGIS Server priority
   */
  async extractStyle(layerName, options = {}) {
    const cacheKey = `server_${layerName}_${JSON.stringify(options)}`
    
    // Return cached result if available
    if (this.cache.has(cacheKey)) {
      console.log(`[UltimateQGIS] 🎯 Using cached server style for ${layerName}`)
      return this.cache.get(cacheKey)
    }
    
    console.log(`[UltimateQGIS] 🚀 Starting ultimate extraction for ${layerName}`)
    
    // Try methods in order of preference (QGIS Server first!)
    const extractionMethods = [
      {
        name: 'QGIS Server WMS GetLegendGraphic',
        method: () => this.extractViaWMSLegend(layerName),
        priority: 1
      },
      {
        name: 'QGIS Server WFS DescribeFeatureType',
        method: () => this.extractViaWFSDescribe(layerName),
        priority: 2
      },
      {
        name: 'QGIS Server OGC API Styles',
        method: () => this.extractViaOGCAPI(layerName),
        priority: 3
      },
      {
        name: 'QGIS Server Direct Style API',
        method: () => this.extractViaDirectAPI(layerName),
        priority: 4
      },
      {
        name: 'Fallback to Smart Extractor',
        method: () => super.extractStyle(layerName, options),
        priority: 5
      }
    ]
    
    let lastError = null
    
    for (const { name, method, priority } of extractionMethods) {
      try {
        console.log(`[UltimateQGIS] 🔍 Trying ${name} (priority ${priority})`)
        const result = await method()
        
        if (result && result.success) {
          const unifiedStyle = this.unifyServerStyle(result.data, layerName, name)
          this.cache.set(cacheKey, unifiedStyle)
          
          console.log(`[UltimateQGIS] ✅ Success with ${name}!`)
          console.log(`[UltimateQGIS] 📊 Extracted ${unifiedStyle.symbols.length} symbols`)
          console.log(`[UltimateQGIS] 🎨 SVG available: ${unifiedStyle.metadata.hasSVG}`)
          
          return unifiedStyle
        }
      } catch (error) {
        console.log(`[UltimateQGIS] ⚠️ ${name} failed: ${error.message}`)
        lastError = error
      }
    }
    
    // All methods failed
    const error = new Error(`All QGIS Server extraction methods failed for ${layerName}`)
    error.cause = lastError
    console.log(`[UltimateQGIS] ❌ All server methods failed for ${layerName}`)
    throw error
  }
  
  /**
   * Method 1: WMS GetLegendGraphic (highest priority)
   */
  async extractViaWMSLegend(layerName) {
    try {
      const params = {
        SERVICE: 'WMS',
        VERSION: this.serverConfig.version,
        REQUEST: 'GetLegendGraphic',
        LAYER: layerName,
        FORMAT: 'application/json',  // Try JSON first
        RULELABEL: 'true',
        RULE: 'true',
        SCALE: '1000000',
        WIDTH: '20',
        HEIGHT: '20'
      }
      
      console.log(`[UltimateQGIS] 🎨 Requesting WMS GetLegendGraphic for ${layerName}`)
      
      const response = await this.makeRequest(this.endpoints.wms, params)
      
      if (response.data) {
        return {
          success: true,
          data: {
            _source: 'wms-legend',
            _legendGraphic: response.data,
            _layerName: layerName,
            _format: 'json'
          },
          method: 'wms-legend',
          metadata: {
            layerName,
            extractionTime: Date.now(),
            hasSVG: false
          }
        }
      }
      
      throw new Error('No legend data received')
      
    } catch (error) {
      // Try PNG fallback
      try {
        const pngParams = {
          ...params,
          FORMAT: 'image/png'
        }
        
        const pngResponse = await this.makeRequest(this.endpoints.wms, pngParams)
        
        return {
          success: true,
          data: {
            _source: 'wms-legend-png',
            _legendGraphic: pngResponse.data,
            _layerName: layerName,
            _format: 'png'
          },
          method: 'wms-legend-png',
          metadata: {
            layerName,
            extractionTime: Date.now(),
            hasSVG: false
          }
        }
      } catch (pngError) {
        throw new Error(`WMS GetLegendGraphic failed: ${error.message}`)
      }
    }
  }
  
  /**
   * Method 2: WFS DescribeFeatureType
   */
  async extractViaWFSDescribe(layerName) {
    try {
      const params = {
        SERVICE: 'WFS',
        VERSION: '2.0.0',
        REQUEST: 'DescribeFeatureType',
        TYPENAME: layerName,
        OUTPUTFORMAT: 'application/json'
      }
      
      console.log(`[UltimateQGIS] 📋 Requesting WFS DescribeFeatureType for ${layerName}`)
      
      const response = await this.makeRequest(this.endpoints.wfs, params)
      
      if (response.data) {
        return {
          success: true,
          data: {
            _source: 'wfs-describe',
            _featureType: response.data,
            _layerName: layerName,
            _geometryType: this.extractGeometryType(response.data)
          },
          method: 'wfs-describe',
          metadata: {
            layerName,
            extractionTime: Date.now(),
            hasSVG: false
          }
        }
      }
      
      throw new Error('No feature type data received')
      
    } catch (error) {
      throw new Error(`WFS DescribeFeatureType failed: ${error.message}`)
    }
  }
  
  /**
   * Method 3: OGC API Styles
   */
  async extractViaOGCAPI(layerName) {
    try {
      const url = `${this.endpoints.oapi}/styles/${layerName}`
      
      console.log(`[UltimateQGIS] 🎯 Requesting OGC API styles for ${layerName}`)
      
      const response = await this.makeRequest(url, {}, 'GET')
      
      if (response.data) {
        return {
          success: true,
          data: {
            _source: 'ogc-api-styles',
            _styles: response.data,
            _layerName: layerName
          },
          method: 'ogc-api-styles',
          metadata: {
            layerName,
            extractionTime: Date.now(),
            hasSVG: true
          }
        }
      }
      
      throw new Error('No OGC API styles received')
      
    } catch (error) {
      throw new Error(`OGC API Styles failed: ${error.message}`)
    }
  }
  
  /**
   * Method 4: Direct Style API
   */
  async extractViaDirectAPI(layerName) {
    try {
      const url = `${this.serverConfig.baseUrl}/api/styles/${layerName}`
      
      console.log(`[UltimateQGIS] 🔧 Requesting direct style API for ${layerName}`)
      
      const response = await this.makeRequest(url, {}, 'GET')
      
      if (response.data) {
        return {
          success: true,
          data: {
            _source: 'direct-api',
            _style: response.data,
            _layerName: layerName
          },
          method: 'direct-api',
          metadata: {
            layerName,
            extractionTime: Date.now(),
            hasSVG: true
          }
        }
      }
      
      throw new Error('No direct API style received')
      
    } catch (error) {
      throw new Error(`Direct Style API failed: ${error.message}`)
    }
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
      responseType: 'arraybuffer' // Handle both JSON and binary data
    }
    
    let lastError = null
    
    for (let attempt = 1; attempt <= this.serverConfig.maxRetries; attempt++) {
      try {
        console.log(`[UltimateQGIS] 📡 Request attempt ${attempt}/${this.serverConfig.maxRetries}: ${url}`)
        
        const response = await axios(config)
        
        // Handle different response types
        let data = response.data
        
        // If it's binary data (PNG), convert to base64
        if (response.headers['content-type']?.includes('image/')) {
          data = Buffer.from(response.data).toString('base64')
          data = `data:${response.headers['content-type']};base64,${data}`
        }
        // If it's supposed to be JSON but is string, parse it
        else if (typeof data === 'string' && data.startsWith('{')) {
          try {
            data = JSON.parse(data)
          } catch (parseError) {
            // Keep as string if not valid JSON
          }
        }
        
        console.log(`[UltimateQGIS] ✅ Request successful: ${response.status}`)
        return { data, headers: response.headers }
        
      } catch (error) {
        lastError = error
        console.log(`[UltimateQGIS] ⚠️ Request attempt ${attempt} failed: ${error.message}`)
        
        if (attempt < this.serverConfig.maxRetries) {
          // Exponential backoff
          const delay = Math.pow(2, attempt - 1) * 1000
          console.log(`[UltimateQGIS] ⏳ Retrying in ${delay}ms...`)
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }
    
    throw lastError || new Error('Request failed after all retries')
  }
  
  /**
   * Extract geometry type from WFS response
   */
  extractGeometryType(featureTypeData) {
    try {
      // Parse GML or JSON to find geometry type
      if (typeof featureTypeData === 'object') {
        // Look for geometry type in the response
        const geometryTypes = ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon']
        
        for (const geomType of geometryTypes) {
          if (JSON.stringify(featureTypeData).includes(geomType)) {
            return geomType.toLowerCase().replace('multimulti', 'multi').replace('multi', '').toLowerCase()
          }
        }
      }
      
      return 'unknown'
    } catch (error) {
      console.log(`[UltimateQGIS] ⚠️ Could not extract geometry type: ${error.message}`)
      return 'unknown'
    }
  }
  
  /**
   * Unify server style data into consistent format
   */
  unifyServerStyle(serverData, layerName, sourceMethod) {
    const unified = {
      layerName,
      extractionTime: Date.now(),
      geometryType: serverData._geometryType || 'point',
      rendererType: serverData._rendererType || 'single',
      symbols: [],
      labels: [],
      metadata: {
        source: sourceMethod,
        hasSVG: false,
        symbolCount: 0,
        categoryCount: 0,
        serverBased: true
      }
    }
    
    // Handle different server response formats
    if (serverData._legendGraphic) {
      unified.symbols = this.parseLegendGraphic(serverData._legendGraphic, layerName)
    } else if (serverData._styles) {
      unified.symbols = this.parseOGCStyles(serverData._styles, layerName)
    } else if (serverData._style) {
      unified.symbols = this.parseDirectStyle(serverData._style, layerName)
    }
    
    unified.metadata.symbolCount = unified.symbols.length
    unified.metadata.categoryCount = unified.symbols.length
    unified.metadata.hasSVG = unified.symbols.some(s => s.svg.hasSVG)
    
    console.log(`[UltimateQGIS] 🎯 Unified server style: ${unified.symbols.length} symbols, SVG: ${unified.metadata.hasSVG}`)
    
    return unified
  }
  
  /**
   * Parse WMS GetLegendGraphic response
   */
  parseLegendGraphic(legendData, layerName) {
    const symbols = []
    
    try {
      if (typeof legendData === 'string' && legendData.startsWith('data:')) {
        // It's a base64 image (PNG)
        symbols.push({
          id: 'default',
          name: 'Default',
          category: 'default',
          geometry: {
            type: 'point',
            coordinates: [0, 0]
          },
          style: {
            type: 'point',
            fill: { color: '#45B7D1', opacity: 1 },
            stroke: { color: '#2c3e50', width: 1, opacity: 1 },
            size: 6,
            rotation: 0,
            opacity: 1
          },
          svg: {
            path: legendData,
            dataUrl: legendData,
            hasSVG: true
          }
        })
      } else if (typeof legendData === 'object') {
        // It's JSON legend data
        if (legendData.legends) {
          for (const legend of legendData.legends) {
            symbols.push({
              id: legend.title || 'default',
              name: legend.title || 'Default',
              category: legend.title || 'default',
              geometry: {
                type: 'point',
                coordinates: [0, 0]
              },
              style: this.extractStyleFromLegend(legend),
              svg: {
                path: legend.symbolPath,
                dataUrl: legend.symbolDataUrl,
                hasSVG: !!(legend.symbolPath || legend.symbolDataUrl)
              }
            })
          }
        }
      }
    } catch (error) {
      console.log(`[UltimateQGIS] ⚠️ Error parsing legend graphic: ${error.message}`)
    }
    
    return symbols
  }
  
  /**
   * Parse OGC API Styles response
   */
  parseOGCStyles(stylesData, layerName) {
    const symbols = []
    
    try {
      if (stylesData.styles) {
        for (const style of stylesData.styles) {
          symbols.push({
            id: style.id || 'default',
            name: style.title || 'Default',
            category: style.title || 'default',
            geometry: {
              type: 'point',
              coordinates: [0, 0]
            },
            style: this.extractStyleFromOGC(style),
            svg: {
              path: style.svgPath,
              dataUrl: style.svgDataUrl,
              hasSVG: !!(style.svgPath || style.svgDataUrl)
            }
          })
        }
      }
    } catch (error) {
      console.log(`[UltimateQGIS] ⚠️ Error parsing OGC styles: ${error.message}`)
    }
    
    return symbols
  }
  
  /**
   * Parse Direct API Style response
   */
  parseDirectStyle(styleData, layerName) {
    const symbols = []
    
    try {
      symbols.push({
        id: styleData.id || 'default',
        name: styleData.name || 'Default',
        category: styleData.name || 'default',
        geometry: {
          type: 'point',
          coordinates: [0, 0]
        },
        style: this.extractStyleFromDirect(styleData),
        svg: {
          path: styleData.svgPath,
          dataUrl: styleData.svgDataUrl,
          hasSVG: !!(styleData.svgPath || styleData.svgDataUrl)
        }
      })
    } catch (error) {
      console.log(`[UltimateQGIS] ⚠️ Error parsing direct style: ${error.message}`)
    }
    
    return symbols
  }
  
  /**
   * Extract style from legend data
   */
  extractStyleFromLegend(legend) {
    return {
      type: 'point',
      fill: { 
        color: legend.fillColor || '#45B7D1', 
        opacity: legend.fillOpacity || 1 
      },
      stroke: { 
        color: legend.strokeColor || '#2c3e50', 
        width: legend.strokeWidth || 1, 
        opacity: legend.strokeOpacity || 1 
      },
      size: legend.size || 6,
      rotation: legend.rotation || 0,
      opacity: legend.opacity || 1
    }
  }
  
  /**
   * Extract style from OGC API data
   */
  extractStyleFromOGC(style) {
    return {
      type: 'point',
      fill: { 
        color: style.fill?.color || '#45B7D1', 
        opacity: style.fill?.opacity || 1 
      },
      stroke: { 
        color: style.stroke?.color || '#2c3e50', 
        width: style.stroke?.width || 1, 
        opacity: style.stroke?.opacity || 1 
      },
      size: style.size || 6,
      rotation: style.rotation || 0,
      opacity: style.opacity || 1
    }
  }
  
  /**
   * Extract style from direct API data
   */
  extractStyleFromDirect(style) {
    return {
      type: 'point',
      fill: { 
        color: style.color || '#45B7D1', 
        opacity: style.opacity || 1 
      },
      stroke: { 
        color: style.strokeColor || '#2c3e50', 
        width: style.strokeWidth || 1, 
        opacity: 1 
      },
      size: style.size || 6,
      rotation: style.rotation || 0,
      opacity: style.opacity || 1
    }
  }
  
  /**
   * Test QGIS Server connectivity
   */
  async testConnectivity() {
    try {
      const params = {
        SERVICE: 'WMS',
        VERSION: this.serverConfig.version,
        REQUEST: 'GetCapabilities'
      }
      
      const response = await this.makeRequest(this.endpoints.wms, params)
      
      return {
        success: true,
        message: 'QGIS Server is reachable',
        server: this.serverConfig.baseUrl,
        responseTime: Date.now()
      }
    } catch (error) {
      return {
        success: false,
        message: 'QGIS Server is not reachable',
        server: this.serverConfig.baseUrl,
        error: error.message
      }
    }
  }
  
  /**
   * Get server capabilities
   */
  async getServerCapabilities() {
    try {
      const params = {
        SERVICE: 'WMS',
        VERSION: this.serverConfig.version,
        REQUEST: 'GetCapabilities'
      }
      
      const response = await this.makeRequest(this.endpoints.wms, params)
      
      return {
        success: true,
        data: response.data,
        server: this.serverConfig.baseUrl
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
        server: this.serverConfig.baseUrl
      }
    }
  }
}

module.exports = { UltimateQGISBridge }
