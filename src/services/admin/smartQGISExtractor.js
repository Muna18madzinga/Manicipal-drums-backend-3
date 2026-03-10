/**
 * Smart QGIS Style Extractor
 * Integrated approach for perfect QGIS-to-web symbology extraction
 */

const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const WFSLayerPublisher = require('../qgis/wfsPublisher')

class SmartQGISExtractor {
  constructor() {
    this.qmlParser = null // Will be initialized lazily
    this.svgExtractor = null // Will be initialized lazily
    this.qgisBridge = null // Will be initialized lazily
    this.wfsPublisher = new WFSLayerPublisher() // Auto-publishing service
    this.cache = new Map() // Cache extracted styles
  }

  /**
   * Main extraction method with intelligent fallbacks
   */
  async extractStyle(layerName, options = {}) {
    const cacheKey = `${layerName}_${JSON.stringify(options)}`
    
    // Return cached result if available
    if (this.cache.has(cacheKey)) {
      console.log(`[SmartQGIS] 🎯 Using cached style for ${layerName}`)
      return this.cache.get(cacheKey)
    }

    console.log(`[SmartQGIS] 🚀 Starting smart extraction for ${layerName}`)
    
    // Step 0: Auto-publish layer for WFS if needed (with graceful fallback)
    if (options.autoPublish !== false) {
      try {
        await this.autoPublishForWFS(layerName, options)
      } catch (publishError) {
        console.log(`[SmartQGIS] ⚠️ Auto-publishing failed for ${layerName}, using direct project parsing: ${publishError.message}`)
        // Continue with direct project parsing as fallback
      }
    }
    
    // Try methods in order of preference
    const extractionMethods = [
      {
        name: 'QGIS API Bridge',
        method: () => this.extractViaQGISAPI(layerName),
        priority: 1
      },
      {
        name: 'Enhanced QML Parser',
        method: () => this.extractViaQML(layerName),
        priority: 2
      },
      {
        name: 'SVG Extractor',
        method: () => this.extractViaSVG(layerName),
        priority: 3
      },
      {
        name: 'Project File Analysis',
        method: () => this.extractViaProjectFile(layerName),
        priority: 4
      }
    ]

    let lastError = null
    
    for (const { name, method, priority } of extractionMethods) {
      try {
        console.log(`[SmartQGIS] 🔍 Trying ${name} (priority ${priority})`)
        const result = await method()
        
        if (result && result.success) {
          const unifiedStyle = this.unifyStyle(result.data, layerName)
          this.cache.set(cacheKey, unifiedStyle)
          
          console.log(`[SmartQGIS] ✅ Success with ${name}!`)
          console.log(`[SmartQGIS] 📊 Extracted ${unifiedStyle.symbols.length} symbols`)
          
          return unifiedStyle
        }
      } catch (error) {
        console.log(`[SmartQGIS] ⚠️ ${name} failed: ${error.message}`)
        lastError = error
      }
    }

    // All methods failed
    const error = new Error(`All extraction methods failed for ${layerName}`)
    error.cause = lastError
    console.log(`[SmartQGIS] ❌ All methods failed for ${layerName}`)
    throw error
  }

  /**
   * Method 1: Direct QGIS API Bridge (highest priority)
   */
  async extractViaQGISAPI(layerName) {
    return new Promise((resolve, reject) => {
      try {
        const scriptPath = path.join(__dirname, '../../../vungu-integration/qgis_api_bridge.py')
        const command = `python "${scriptPath}" --layer "${layerName}" --method "api"`
        
        console.log(`[SmartQGIS] 🎯 Executing QGIS API bridge...`)
        
        exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`QGIS API bridge failed: ${stderr}`))
            return
          }
          
          try {
            const result = JSON.parse(stdout)
            resolve(result)
          } catch (parseError) {
            reject(new Error(`Failed to parse QGIS API output: ${parseError.message}`))
          }
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * Method 2: Enhanced QML Parser with SVG extraction
   */
  async extractViaQML(layerName) {
    try {
      // Import QML parser lazily
      const { QmlParserService } = require('./qmlParserService')
      if (!this.qmlParser) {
        this.qmlParser = new QmlParserService(null) // No pool needed for this method
      }

      // Get QML content from layer
      const qmlContent = await this.getQMLContent(layerName)
      
      // Parse with enhanced SVG extraction
      const parsedStyle = await this.qmlParser.parseQmlContent(qmlContent, layerName)
      
      return {
        success: true,
        data: parsedStyle,
        method: 'qml-parser',
        metadata: {
          layerName,
          extractionTime: Date.now(),
          hasSVG: !!(parsedStyle._categories?.some(cat => cat.svgPath || cat.svgDataUrl))
        }
      }
    } catch (error) {
      throw new Error(`QML extraction failed: ${error.message}`)
    }
  }

  /**
   * Method 3: SVG Extractor
   */
  async extractViaSVG(layerName) {
    return new Promise((resolve, reject) => {
      try {
        const scriptPath = path.join(__dirname, '../../../vungu-integration/extract_symbology.py')
        const command = `python "${scriptPath}" --layer "${layerName}" --method "svg"`
        
        console.log(`[SmartQGIS] 🎨 Executing SVG extractor...`)
        
        exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`SVG extractor failed: ${stderr}`))
            return
          }
          
          try {
            const result = JSON.parse(stdout)
            resolve(result)
          } catch (parseError) {
            reject(new Error(`Failed to parse SVG output: ${parseError.message}`))
          }
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * Method 4: Project File Analysis (last resort)
   */
  async extractViaProjectFile(layerName) {
    try {
      // Look for QGIS project file
      const projectPaths = [
        path.join(__dirname, '../../../vungu-integration/project.qgs'),
        path.join(__dirname, '../../../vungu-integration/*.qgs'),
        path.join(__dirname, '../../../data/*.qgs')
      ]
      
      let projectFile = null
      for (const projectPath of projectPaths) {
        if (fs.existsSync(projectPath.replace('*', ''))) {
          projectFile = projectPath
          break
        }
      }
      
      if (!projectFile) {
        throw new Error('No QGIS project file found')
      }
      
      console.log(`[SmartQGIS] 📁 Analyzing project file: ${projectFile}`)
      
      // Parse project file for layer symbology
      const projectContent = fs.readFileSync(projectFile, 'utf-8')
      const layerMatch = projectContent.match(new RegExp(`<layer[^>]*name="${layerName}"[^>]*>.*?</layer>`, 's'))
      
      if (!layerMatch) {
        throw new Error(`Layer ${layerName} not found in project file`)
      }
      
      // Extract symbology from layer XML
      const layerXML = layerMatch[0]
      const symbologyMatch = layerXML.match(/<renderer-v2[^>]*>.*?<\/renderer-v2>/s)
      
      if (!symbologyMatch) {
        throw new Error(`No symbology found for layer ${layerName}`)
      }
      
      return {
        success: true,
        data: {
          _rendererType: 'project-file',
          _rawXML: symbologyMatch[0],
          _source: 'project-file-analysis'
        },
        method: 'project-file',
        metadata: {
          layerName,
          extractionTime: Date.now(),
          source: projectFile
        }
      }
    } catch (error) {
      throw new Error(`Project file analysis failed: ${error.message}`)
    }
  }

  /**
   * Get QML content for a layer
   */
  async getQMLContent(layerName) {
    try {
      // Try to find QML file in common locations
      const qmlPaths = [
        path.join(__dirname, '../../../vungu-integration/styles/', `${layerName}.qml`),
        path.join(__dirname, '../../../data/styles/', `${layerName}.qml`),
        path.join(__dirname, '../../../temp/', `${layerName}.qml`)
      ]
      
      for (const qmlPath of qmlPaths) {
        if (fs.existsSync(qmlPath)) {
          return fs.readFileSync(qmlPath, 'utf-8')
        }
      }
      
      throw new Error(`No QML file found for layer ${layerName}`)
    } catch (error) {
      throw new Error(`Failed to get QML content: ${error.message}`)
    }
  }

  /**
   * Unify different extraction results into consistent format
   */
  unifyStyle(extractedData, layerName) {
    const unified = {
      layerName,
      extractionTime: Date.now(),
      geometryType: extractedData._geometryType || 'point',
      rendererType: extractedData._rendererType || 'single',
      symbols: [],
      labels: [],
      metadata: {
        source: extractedData._source || 'unknown',
        hasSVG: false,
        symbolCount: 0,
        categoryCount: 0
      }
    }

    // Handle categorized symbols
    if (extractedData._categories && Array.isArray(extractedData._categories)) {
      unified.symbols = extractedData._categories.map(cat => ({
        id: cat.value || cat.id,
        name: cat.label || cat.name,
        category: cat.value,
        geometry: {
          type: 'point',
          coordinates: [0, 0] // Placeholder
        },
        style: this.unifySymbolStyle(cat),
        svg: {
          path: cat.svgPath,
          dataUrl: cat.svgDataUrl,
          hasSVG: !!(cat.svgPath || cat.svgDataUrl)
        }
      }))
      
      unified.metadata.categoryCount = unified.symbols.length
      unified.metadata.hasSVG = unified.symbols.some(s => s.svg.hasSVG)
    }

    // Handle single symbol
    if (extractedData._style && !unified.symbols.length) {
      unified.symbols = [{
        id: 'default',
        name: 'Default',
        category: 'default',
        geometry: {
          type: extractedData._geometryType || 'point',
          coordinates: [0, 0]
        },
        style: this.unifySymbolStyle(extractedData),
        svg: {
          path: extractedData.svgPath,
          dataUrl: extractedData.svgDataUrl,
          hasSVG: !!(extractedData.svgPath || extractedData.svgDataUrl)
        }
      }]
    }

    unified.metadata.symbolCount = unified.symbols.length
    unified.metadata.hasSVG = unified.metadata.hasSVG || unified.symbols.some(s => s.svg.hasSVG)

    console.log(`[SmartQGIS] 🎯 Unified style: ${unified.symbols.length} symbols, SVG: ${unified.metadata.hasSVG}`)
    
    return unified
  }

  /**
   * Unify symbol style from different sources
   */
  unifySymbolStyle(source) {
    const style = {
      type: 'point',
      fill: {
        color: '#000000',
        opacity: 1
      },
      stroke: {
        color: '#2c3e50',
        width: 1,
        opacity: 1
      },
      size: 6,
      rotation: 0,
      opacity: 1,
      symbolLayers: []
    }

    // Extract from _style (QML parser format)
    if (source._style) {
      const qgisStyle = source._style
      style.fill.color = qgisStyle.color || style.fill.color
      style.stroke.color = qgisStyle.strokeColor || style.stroke.color
      style.stroke.width = qgisStyle.strokeWidth || style.stroke.width
      style.size = qgisStyle.radius || qgisStyle.size || style.size
      style.opacity = qgisStyle.opacity || style.opacity
      style.symbolLayers = qgisStyle.symbolLayer || []
    }

    // Extract from direct properties
    if (source.color) style.fill.color = source.color
    if (source.strokeColor) style.stroke.color = source.strokeColor
    if (source.strokeWidth) style.stroke.width = source.strokeWidth
    if (source.size || source.radius) style.size = source.size || source.radius
    if (source.opacity) style.opacity = source.opacity

    return style
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear()
    console.log(`[SmartQGIS] 🗑️ Cache cleared`)
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    }
  }

  /**
   * Auto-publish layer for WFS using PyQGIS script
   * @param {string} layerName - Name of the layer to publish
   * @param {Object} options - Publishing options
   */
  async autoPublishForWFS(layerName, options = {}) {
    try {
      console.log(`[SmartQGIS] 🔄 Auto-publishing ${layerName} for WFS...`)
      
      // Get project path from options or use default
      const projectPath = options.projectPath || path.join(__dirname, '../../../qgis-projects/vungu-master-plan-working.qgs')
      
      // Check if layer is already published (cache check)
      const publishCacheKey = `published_${layerName}_${projectPath}`
      if (this.cache.has(publishCacheKey)) {
        console.log(`[SmartQGIS] ✅ Layer ${layerName} already published for WFS`)
        return
      }
      
      // Publish the layer using PyQGIS script
      const publishResult = await this.wfsPublisher.publishLayers(
        projectPath, 
        [layerName], 
        {
          wfsUrl: options.wfsUrl || 'http://localhost:8080/wfs',
          save: true,
          verbose: true
        }
      )
      
      if (publishResult.success && publishResult.published.length > 0) {
        console.log(`[SmartQGIS] ✅ Successfully published ${layerName} for WFS`)
        
        // Cache the publishing result
        this.cache.set(publishCacheKey, {
          published: true,
          timestamp: Date.now(),
          result: publishResult
        })
        
        // Wait a moment for QGIS Server to recognize the changes
        await new Promise(resolve => setTimeout(resolve, 2000))
        
      } else {
        console.log(`[SmartQGIS] ⚠️ Could not publish ${layerName} for WFS, will use fallback methods`)
        console.log(`[SmartQGIS] Failed layers: ${publishResult.failed.join(', ')}`)
      }
      
    } catch (error) {
      console.log(`[SmartQGIS] ⚠️ Auto-publishing failed for ${layerName}: ${error.message}`)
      console.log(`[SmartQGIS] Will use fallback styling extraction methods`)
    }
  }

  /**
   * Get WFS publishing status
   * @param {string} layerName - Layer name to check
   * @param {string} projectPath - Project path
   * @returns {Object} Publishing status
   */
  getWFSPublishingStatus(layerName, projectPath) {
    const publishCacheKey = `published_${layerName}_${projectPath}`
    const cached = this.cache.get(publishCacheKey)
    
    return {
      isPublished: cached ? cached.published : false,
      timestamp: cached ? cached.timestamp : null,
      result: cached ? cached.result : null
    }
  }
}

module.exports = { SmartQGISExtractor }
