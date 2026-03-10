/**
 * Advanced QGIS Style Extractor
 * =============================
 * 
 * Extracts complex QGIS styles including:
 * - Hatch patterns (diagonal, cross, dot, etc.)
 * - Gradient fills
 * - Line patterns (dashes, markers)
 * - Point symbols (SVG, markers)
 * - Categorized and graduated renderers
 * - Label positioning and formatting
 * 
 * Goal: What users see in QGIS = What users see in web app
 */

const fs = require('fs')
const path = require('path')
const { exec } = require('child_process')

class AdvancedQGISStyleExtractor {
  constructor() {
    this.cache = new Map()
    this.qmlParser = new QMLStyleParser()
    this.svgConverter = new SVGStyleConverter()
    this.patternGenerator = new PatternGenerator()
  }

  /**
   * Extract complete style information from QGIS project
   */
  async extractCompleteStyle(layerName, projectPath) {
    const cacheKey = `${layerName}_${projectPath}`
    
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)
    }

    console.log(`[Advanced Style] 🎨 Extracting complete style for ${layerName}`)

    try {
      // Step 1: Parse QGIS project file for layer symbology
      const projectStyle = await this.extractFromProjectFile(layerName, projectPath)
      
      // Step 2: Extract QML styling if available
      const qmlStyle = await this.extractFromQML(layerName, projectPath)
      
      // Step 3: Generate web-compatible styles
      const webStyle = this.convertToWebStyle(projectStyle, qmlStyle, layerName)
      
      // Step 4: Generate MapLibre GL JS compatible styles
      const maplibreStyle = this.generateMapLibreStyle(webStyle, layerName)
      
      const result = {
        success: true,
        layerName,
        qgisStyle: projectStyle,
        qmlStyle: qmlStyle,
        webStyle: webStyle,
        maplibreStyle: maplibreStyle,
        metadata: {
          extractedAt: new Date().toISOString(),
          hasComplexPatterns: webStyle.hasComplexPatterns,
          hasHatchPatterns: webStyle.hasHatchPatterns,
          hasGradients: webStyle.hasGradients,
          symbolCount: webStyle.symbols.length,
          rendererType: webStyle.rendererType
        }
      }

      this.cache.set(cacheKey, result)
      return result

    } catch (error) {
      console.error(`[Advanced Style] ❌ Extraction failed: ${error.message}`)
      throw error
    }
  }

  /**
   * Extract style from QGIS project file
   */
  async extractFromProjectFile(layerName, projectPath) {
    try {
      if (!fs.existsSync(projectPath)) {
        throw new Error(`Project file not found: ${projectPath}`)
      }

      const projectContent = fs.readFileSync(projectPath, 'utf-8')
      
      // Find layer definition
      const layerRegex = new RegExp(`<layer[^>]*name="${layerName}"[^>]*>.*?</layer>`, 's')
      const layerMatch = projectContent.match(layerRegex)
      
      if (!layerMatch) {
        throw new Error(`Layer ${layerName} not found in project`)
      }

      const layerXML = layerMatch[0]
      
      // Extract renderer information
      const rendererMatch = layerXML.match(/<renderer-v2[^>]*type="([^"]*)"[^>]*>(.*?)<\/renderer-v2>/s)
      
      if (!rendererMatch) {
        throw new Error(`No renderer found for layer ${layerName}`)
      }

      const rendererType = rendererMatch[1]
      const rendererXML = rendererMatch[2]

      // Parse based on renderer type
      let styleData = {
        rendererType,
        symbols: [],
        categories: [],
        ranges: []
      }

      switch (rendererType) {
        case 'categorizedSymbol':
          styleData = this.parseCategorizedRenderer(rendererXML)
          break
        case 'graduatedSymbol':
          styleData = this.parseGraduatedRenderer(rendererXML)
          break
        case 'singleSymbol':
          styleData = this.parseSingleRenderer(rendererXML)
          break
        case 'RuleRenderer':
          styleData = this.parseRuleBasedRenderer(rendererXML)
          break
        default:
          throw new Error(`Unsupported renderer type: ${rendererType}`)
      }

      // Extract labeling information
      const labelingMatch = layerXML.match(/<labeling[^>]*>(.*?)<\/labeling>/s)
      if (labelingMatch) {
        styleData.labeling = this.parseLabeling(labelingMatch[1])
      }

      return {
        success: true,
        rendererType,
        ...styleData,
        _rawXML: layerXML
      }

    } catch (error) {
      throw new Error(`Project file extraction failed: ${error.message}`)
    }
  }

  /**
   * Parse categorized renderer
   */
  parseCategorizedRenderer(rendererXML) {
    const symbols = []
    const categories = []

    // Extract symbols
    const symbolMatches = rendererXML.matchAll(/<symbol[^>]*type="([^"]*)"[^>]*name="([^"]*)"[^>]*>(.*?)<\/symbol>/gs)
    
    for (const match of symbolMatches) {
      const [, symbolType, symbolName, symbolContent] = match
      symbols.push({
        name: symbolName,
        type: symbolType,
        content: symbolContent,
        properties: this.parseSymbolProperties(symbolContent, symbolType)
      })
    }

    // Extract categories
    const categoryMatches = rendererXML.matchAll(/<category[^>]*value="([^"]*)"[^>]*symbol="([^"]*)"[^>]*label="([^"]*)"[^>]*\/>/gs)
    
    for (const match of categoryMatches) {
      const [, value, symbolName, label] = match
      const symbol = symbols.find(s => s.name === symbolName)
      
      if (symbol) {
        categories.push({
          value,
          label,
          symbol: symbol.properties,
          symbolName
        })
      }
    }

    return {
      symbols,
      categories,
      rendererType: 'categorized'
    }
  }

  /**
   * Parse symbol properties based on type
   */
  parseSymbolProperties(symbolContent, symbolType) {
    const properties = {}

    switch (symbolType) {
      case 'fill':
        properties.fill = this.extractFillProperties(symbolContent)
        properties.stroke = this.extractStrokeProperties(symbolContent)
        break
      case 'line':
        properties.stroke = this.extractStrokeProperties(symbolContent)
        properties.dashPattern = this.extractDashPattern(symbolContent)
        break
      case 'marker':
        properties.markers = this.extractMarkerProperties(symbolContent)
        break
    }

    return properties
  }

  /**
   * Extract fill properties including complex patterns
   */
  extractFillProperties(symbolContent) {
    const fill = {
      color: this.extractProperty(symbolContent, 'color', '#45B7D1'),
      opacity: parseFloat(this.extractProperty(symbolContent, 'color_opacity', '0.5')),
      style: 'solid'
    }

    // Check for hatch patterns
    const patternMatch = symbolContent.match(/<prop[^>]*k="style"[^>]*v="([^"]*)"/)
    if (patternMatch) {
      const patternType = patternMatch[1]
      
      switch (patternType) {
        case 'Diagonal1':
          fill.style = 'diagonal-lines'
          fill.pattern = this.generateDiagonalPattern('forward')
          break
        case 'Diagonal2':
          fill.style = 'diagonal-lines-reverse'
          fill.pattern = this.generateDiagonalPattern('backward')
          break
        case 'Cross':
          fill.style = 'cross-hatch'
          fill.pattern = this.generateCrossHatchPattern()
          break
        case 'Horizontal':
          fill.style = 'horizontal-lines'
          fill.pattern = this.generateHorizontalPattern()
          break
        case 'Vertical':
          fill.style = 'vertical-lines'
          fill.pattern = this.generateVerticalPattern()
          break
        case 'Dots':
          fill.style = 'dot-pattern'
          fill.pattern = this.generateDotPattern()
          break
        default:
          fill.style = patternType
      }
    }

    // Check for gradient fills
    const gradientMatch = symbolContent.match(/<gradient[^>]*>(.*?)<\/gradient>/s)
    if (gradientMatch) {
      fill.style = 'gradient'
      fill.gradient = this.parseGradient(gradientMatch[1])
    }

    return fill
  }

  /**
   * Extract stroke properties
   */
  extractStrokeProperties(symbolContent) {
    return {
      color: this.extractProperty(symbolContent, 'outline_color', '#2c3e50'),
      width: parseFloat(this.extractProperty(symbolContent, 'outline_width', '2')),
      opacity: parseFloat(this.extractProperty(symbolContent, 'outline_opacity', '1')),
      style: this.extractProperty(symbolContent, 'outline_style', 'solid')
    }
  }

  /**
   * Extract dash pattern for lines
   */
  extractDashPattern(symbolContent) {
    const style = this.extractProperty(symbolContent, 'style', 'solid')
    
    if (style === 'solid') return null
    
    // Convert QGIS dash patterns to web format
    const dashPatterns = {
      'dash': '5,5',
      'dot': '1,3',
      'dash dot': '8,3,1,3',
      'long dash': '10,5',
      'short dash': '3,3'
    }
    
    return dashPatterns[style] || style
  }

  /**
   * Generate diagonal line pattern for web
   */
  generateDiagonalPattern(direction = 'forward') {
    const angle = direction === 'forward' ? 45 : -45
    const spacing = 8
    
    return {
      type: 'pattern',
      pattern: {
        id: `diagonal-${direction}`,
        width: spacing * 2,
        height: spacing * 2,
        patternUnits: 'userSpaceOnUse',
        patternTransform: `rotate(${angle})`,
        children: [
          {
            type: 'line',
            attributes: {
              x1: 0,
              y1: 0,
              x2: spacing * 2,
              y2: 0,
              stroke: '#2c3e50',
              strokeWidth: 1,
              opacity: 0.8
            }
          }
        ]
      }
    }
  }

  /**
   * Generate cross hatch pattern
   */
  generateCrossHatchPattern() {
    const spacing = 10
    
    return {
      type: 'pattern',
      pattern: {
        id: 'cross-hatch',
        width: spacing,
        height: spacing,
        patternUnits: 'userSpaceOnUse',
        children: [
          {
            type: 'line',
            attributes: {
              x1: 0,
              y1: 0,
              x2: spacing,
              y2: spacing,
              stroke: '#2c3e50',
              strokeWidth: 1,
              opacity: 0.6
            }
          },
          {
            type: 'line',
            attributes: {
              x1: spacing,
              y1: 0,
              x2: 0,
              y2: spacing,
              stroke: '#2c3e50',
              strokeWidth: 1,
              opacity: 0.6
            }
          }
        ]
      }
    }
  }

  /**
   * Generate dot pattern
   */
  generateDotPattern() {
    const spacing = 8
    const radius = 1
    
    return {
      type: 'pattern',
      pattern: {
        id: 'dot-pattern',
        width: spacing,
        height: spacing,
        patternUnits: 'userSpaceOnUse',
        children: [
          {
            type: 'circle',
            attributes: {
              cx: spacing / 2,
              cy: spacing / 2,
              r: radius,
              fill: '#2c3e50',
              opacity: 0.8
            }
          }
        ]
      }
    }
  }

  /**
   * Parse gradient fill
   */
  parseGradient(gradientXML) {
    const gradient = {
      type: 'linear',
      stops: []
    }

    // Extract gradient type
    const typeMatch = gradientXML.match(/type="([^"]*)"/)
    if (typeMatch) {
      gradient.type = typeMatch[1] === 'radial' ? 'radial' : 'linear'
    }

    // Extract color stops
    const stopMatches = gradientXML.matchAll(/<stop[^>]*offset="([^"]*)"[^>]*color="([^"]*)"[^>]*\/>/g)
    
    for (const match of stopMatches) {
      const [, offset, color] = match
      gradient.stops.push({
        offset: parseFloat(offset),
        color: color
      })
    }

    return gradient
  }

  /**
   * Extract property from XML content
   */
  extractProperty(content, key, defaultValue = null) {
    const regex = new RegExp(`<prop[^>]*k="${key}"[^>]*v="([^"]*)"[^>]*\/>`)
    const match = content.match(regex)
    return match ? match[1] : defaultValue
  }

  /**
   * Convert QGIS style to web-compatible format
   */
  convertToWebStyle(qgisStyle, qmlStyle, layerName) {
    const webStyle = {
      layerName,
      rendererType: qgisStyle.rendererType,
      geometryType: this.detectGeometryType(qgisStyle),
      symbols: [],
      hasComplexPatterns: false,
      hasHatchPatterns: false,
      hasGradients: false
    }

    // Convert symbols based on renderer type
    if (qgisStyle.rendererType === 'categorized') {
      webStyle.symbols = qgisStyle.categories.map(cat => ({
        id: cat.value,
        name: cat.label,
        category: cat.value,
        geometry: {
          type: webStyle.geometryType,
          properties: this.convertSymbolToWeb(cat.symbol, webStyle.geometryType)
        }
      }))

      // Check for complex patterns
      webStyle.hasComplexPatterns = webStyle.symbols.some(s => 
        s.geometry.properties.fill?.style !== 'solid' ||
        s.geometry.properties.fill?.gradient
      )
      webStyle.hasHatchPatterns = webStyle.symbols.some(s => 
        s.geometry.properties.fill?.pattern
      )
      webStyle.hasGradients = webStyle.symbols.some(s => 
        s.geometry.properties.fill?.gradient
      )

    } else if (qgisStyle.rendererType === 'single') {
      const symbol = qgisStyle.symbols[0]
      if (symbol) {
        webStyle.symbols = [{
          id: 'default',
          name: 'Default',
          category: 'default',
          geometry: {
            type: webStyle.geometryType,
            properties: this.convertSymbolToWeb(symbol.properties, webStyle.geometryType)
          }
        }]
      }
    }

    return webStyle
  }

  /**
   * Convert individual symbol to web format
   */
  convertSymbolToWeb(symbolProperties, geometryType) {
    const webProperties = {}

    if (geometryType === 'polygon' || geometryType === 'multipolygon') {
      webProperties.fill = {
        color: symbolProperties.fill?.color || '#45B7D1',
        opacity: symbolProperties.fill?.opacity || 0.5,
        style: symbolProperties.fill?.style || 'solid'
      }

      // Add pattern if present
      if (symbolProperties.fill?.pattern) {
        webProperties.fill.pattern = symbolProperties.fill.pattern
        webProperties.fill.style = 'pattern'
      }

      // Add gradient if present
      if (symbolProperties.fill?.gradient) {
        webProperties.fill.gradient = symbolProperties.fill.gradient
        webProperties.fill.style = 'gradient'
      }

      webProperties.stroke = {
        color: symbolProperties.stroke?.color || '#2c3e50',
        width: symbolProperties.stroke?.width || 2,
        opacity: symbolProperties.stroke?.opacity || 1
      }

    } else if (geometryType === 'linestring' || geometryType === 'multilinestring') {
      webProperties.stroke = {
        color: symbolProperties.stroke?.color || '#45B7D1',
        width: symbolProperties.stroke?.width || 2,
        opacity: symbolProperties.stroke?.opacity || 0.8
      }

      if (symbolProperties.dashPattern) {
        webProperties.stroke.dashArray = symbolProperties.dashPattern
      }

    } else if (geometryType === 'point' || geometryType === 'multipoint') {
      webProperties.circle = {
        radius: 6,
        color: symbolProperties.fill?.color || '#45B7D1',
        opacity: symbolProperties.fill?.opacity || 0.8,
        stroke: {
          color: symbolProperties.stroke?.color || '#2c3e50',
          width: symbolProperties.stroke?.width || 1
        }
      }
    }

    return webProperties
  }

  /**
   * Generate MapLibre GL JS compatible style
   */
  generateMapLibreStyle(webStyle, layerName) {
    const maplibreStyle = {
      id: layerName,
      type: this.getLayerType(webStyle.geometryType),
      source: layerName,
      paint: {},
      metadata: {
        'qgis:renderer': webStyle.rendererType,
        'qgis:hasPatterns': webStyle.hasComplexPatterns,
        'qgis:hasHatches': webStyle.hasHatchPatterns
      }
    }

    // Handle categorized styling
    if (webStyle.rendererType === 'categorized' && webStyle.symbols.length > 1) {
      // Build data-driven style expression
      const attributeName = this.getAttributeName(webStyle.symbols)
      const colorExpression = this.buildColorExpression(webStyle.symbols, attributeName)
      
      if (webStyle.geometryType === 'polygon') {
        maplibreStyle.paint['fill-color'] = colorExpression
        maplibreStyle.paint['fill-opacity'] = this.buildOpacityExpression(webStyle.symbols, attributeName)
        maplibreStyle.paint['fill-outline-color'] = this.buildStrokeColorExpression(webStyle.symbols, attributeName)
      } else if (webStyle.geometryType === 'linestring') {
        maplibreStyle.paint['line-color'] = colorExpression
        maplibreStyle.paint['line-width'] = this.buildWidthExpression(webStyle.symbols, attributeName)
      } else {
        maplibreStyle.paint['circle-color'] = colorExpression
        maplibreStyle.paint['circle-radius'] = 6
      }
    } else {
      // Single symbol style
      const symbol = webStyle.symbols[0]
      if (symbol) {
        this.applySingleSymbolPaint(maplibreStyle, symbol.geometry.properties, webStyle.geometryType)
      }
    }

    return maplibreStyle
  }

  /**
   * Build color expression for categorized styling
   */
  buildColorExpression(symbols, attributeName) {
    const expression = ['match', ['get', attributeName]]
    
    for (const symbol of symbols) {
      expression.push(symbol.category)
      expression.push(symbol.geometry.properties.fill?.color || '#45B7D1')
    }
    
    // Default color
    expression.push('#BDC3C7')
    
    return expression
  }

  /**
   * Apply single symbol paint properties
   */
  applySingleSymbolPaint(maplibreStyle, properties, geometryType) {
    if (geometryType === 'polygon') {
      maplibreStyle.paint['fill-color'] = properties.fill?.color || '#45B7D1'
      maplibreStyle.paint['fill-opacity'] = properties.fill?.opacity || 0.5
      maplibreStyle.paint['fill-outline-color'] = properties.stroke?.color || '#2c3e50'
    } else if (geometryType === 'linestring') {
      maplibreStyle.paint['line-color'] = properties.stroke?.color || '#45B7D1'
      maplibreStyle.paint['line-width'] = properties.stroke?.width || 2
      if (properties.stroke?.dashArray) {
        maplibreStyle.paint['line-dasharray'] = properties.stroke.dashArray.split(',').map(Number)
      }
    } else if (geometryType === 'point') {
      maplibreStyle.paint['circle-color'] = properties.circle?.color || '#45B7D1'
      maplibreStyle.paint['circle-radius'] = properties.circle?.radius || 6
      maplibreStyle.paint['circle-stroke-color'] = properties.circle?.stroke?.color || '#2c3e50'
    }
  }

  /**
   * Get MapLibre layer type from geometry type
   */
  getLayerType(geometryType) {
    const typeMap = {
      'point': 'circle',
      'multipoint': 'circle',
      'linestring': 'line',
      'multilinestring': 'line',
      'polygon': 'fill',
      'multipolygon': 'fill'
    }
    return typeMap[geometryType] || 'circle'
  }

  /**
   * Detect geometry type from symbols
   */
  detectGeometryType(qgisStyle) {
    if (qgisStyle.symbols && qgisStyle.symbols.length > 0) {
      const firstSymbol = qgisStyle.symbols[0]
      if (firstSymbol.type === 'fill') return 'polygon'
      if (firstSymbol.type === 'line') return 'linestring'
      if (firstSymbol.type === 'marker') return 'point'
    }
    return 'polygon' // Default assumption
  }

  /**
   * Get attribute name for categorized styling
   */
  getAttributeName(symbols) {
    // Try to infer attribute name from categories
    if (symbols.length > 0 && symbols[0].category) {
      // This would need to be enhanced to actually extract the attribute name
      // from the QGIS project file or layer properties
      return 'type' // Default fallback
    }
    return 'type'
  }

  /**
   * Extract style from QML file (if available)
   */
  async extractFromQML(layerName, projectPath) {
    try {
      // Look for QML file alongside project
      const qmlPath = projectPath.replace('.qgs', `_${layerName}.qml`)
      
      if (fs.existsSync(qmlPath)) {
        const qmlContent = fs.readFileSync(qmlPath, 'utf-8')
        return this.qmlParser.parseQML(qmlContent)
      }
      
      return { success: false, message: 'No QML file found' }
    } catch (error) {
      return { success: false, error: error.message }
    }
  }
}

/**
 * QML Style Parser
 */
class QMLStyleParser {
  parseQML(qmlContent) {
    // Parse QML content for additional styling information
    return {
      success: true,
      content: qmlContent,
      metadata: {
        parsedAt: new Date().toISOString()
      }
    }
  }
}

/**
 * SVG Style Converter
 */
class SVGStyleConverter {
  convertSVGToWeb(svgContent) {
    // Convert SVG symbols to web-compatible format
    return {
      success: true,
      webFormat: svgContent
    }
  }
}

/**
 * Pattern Generator
 */
class PatternGenerator {
  generatePattern(type, options = {}) {
    // Generate various patterns for web use
    return {
      type,
      options,
      pattern: this.createPatternSVG(type, options)
    }
  }

  createPatternSVG(type, options) {
    // Create SVG patterns for complex fills
    return `<svg>${type}</svg>`
  }
}

module.exports = { AdvancedQGISStyleExtractor }
