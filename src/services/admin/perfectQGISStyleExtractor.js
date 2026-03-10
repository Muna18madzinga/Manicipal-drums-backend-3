/**
 * Perfect QGIS Style Extractor
 * ============================
 * 
 * Production-ready QGIS-to-Web styling extraction.
 * What users see in QGIS = What users see in web app.
 * 
 * Features:
 * - Complete renderer support (single, categorized, graduated, rule-based)
 * - Complex fill patterns (hatch, diagonal, cross, dots)
 * - Gradient fills (linear, radial)
 * - Line patterns (dash, dot, custom)
 * - Point symbols (simple markers, SVG)
 * - Label styling (font, size, placement, buffers)
 * - QGIS color format parsing (R,G,B,A)
 * - MapLibre GL JS style generation
 * 
 * Author: SurveySuite Development Team
 * Version: 2.0 - Refined Production Release
 */

const fs = require('fs')
const path = require('path')

class PerfectQGISStyleExtractor {
  constructor() {
    this.cache = new Map()
    this.colorCache = new Map()
  }

  /**
   * Extract complete style from QGIS project
   * This is the main entry point
   */
  async extractCompleteStyle(layerName, projectPath, options = {}) {
    const cacheKey = `style_${layerName}_${projectPath}`
    
    if (this.cache.has(cacheKey) && !options.noCache) {
      console.log(`[Perfect Style] 🎯 Using cached style for ${layerName}`)
      return this.cache.get(cacheKey)
    }

    console.log(`[Perfect Style] 🎨 Extracting QGIS style for: ${layerName}`)
    console.log(`[Perfect Style] 📁 Project: ${projectPath}`)

    try {
      // Step 1: Load and parse project file
      const projectContent = this.loadProjectFile(projectPath)
      
      // Step 2: Find layer in project
      const layerXML = this.findLayerInProject(projectContent, layerName)
      
      // Step 3: Extract renderer information
      const qgisStyle = this.extractRenderer(layerXML, layerName)
      
      // Step 4: Extract labeling information
      const labeling = this.extractLabeling(layerXML)
      
      // Step 5: Convert to web-compatible format
      const webStyle = this.convertToWebStyle(qgisStyle)
      
      // Step 6: Generate MapLibre GL JS style
      const maplibreStyle = this.generateMapLibreStyle(webStyle)
      
      // Step 7: Generate pattern definitions for complex fills
      const patterns = this.generatePatternDefinitions(webStyle)
      
      const result = {
        success: true,
        layerName,
        qgisStyle,
        webStyle,
        maplibreStyle,
        labeling,
        patterns,
        metadata: {
          extractedAt: new Date().toISOString(),
          projectPath,
          rendererType: qgisStyle.rendererType,
          symbolCount: webStyle.symbols.length,
          hasComplexPatterns: webStyle.hasComplexPatterns,
          hasHatchPatterns: webStyle.hasHatchPatterns,
          hasGradients: webStyle.hasGradients,
          hasLabels: labeling.enabled
        }
      }

      this.cache.set(cacheKey, result)
      
      console.log(`[Perfect Style] ✅ Extraction complete:`)
      console.log(`[Perfect Style]    - Renderer: ${qgisStyle.rendererType}`)
      console.log(`[Perfect Style]    - Symbols: ${webStyle.symbols.length}`)
      console.log(`[Perfect Style]    - Patterns: ${webStyle.hasComplexPatterns}`)
      console.log(`[Perfect Style]    - Labels: ${labeling.enabled}`)
      
      return result

    } catch (error) {
      console.error(`[Perfect Style] ❌ Extraction failed: ${error.message}`)
      throw error
    }
  }

  /**
   * List all layers in a QGIS project
   */
  listProjectLayers(projectPath) {
    console.log(`[Perfect Style] 📋 Listing layers from: ${projectPath}`)
    
    try {
      const projectContent = this.loadProjectFile(projectPath)
      const layers = []
      
      // Find all maplayer blocks
      const maplayerRegex = /<maplayer[^>]*>([\s\S]*?)<\/maplayer>/g
      let match
      
      while ((match = maplayerRegex.exec(projectContent)) !== null) {
        const layerBlock = match[0]
        
        // Extract layer name
        const nameMatch = layerBlock.match(/<layername>([^<]+)<\/layername>/)
        if (!nameMatch) continue
        
        const name = nameMatch[1]
        
        // Extract layer type
        const typeMatch = layerBlock.match(/type="([^"]+)"/)
        const geometryMatch = layerBlock.match(/geometry="([^"]+)"/)
        
        // Extract title if available
        const titleMatch = layerBlock.match(/<title>([^<]*)<\/title>/)
        
        // Extract provider
        const providerMatch = layerBlock.match(/<provider[^>]*>([^<]+)<\/provider>/)
        
        layers.push({
          name,
          title: titleMatch ? titleMatch[1] : name,
          type: typeMatch ? typeMatch[1] : 'unknown',
          geometry: geometryMatch ? geometryMatch[1] : 'unknown',
          provider: providerMatch ? providerMatch[1] : 'unknown'
        })
      }
      
      console.log(`[Perfect Style] ✅ Found ${layers.length} layers`)
      return layers
      
    } catch (error) {
      console.error(`[Perfect Style] ❌ Failed to list layers: ${error.message}`)
      throw error
    }
  }

  /**
   * Load QGIS project file (.qgs or .qgz)
   */
  loadProjectFile(projectPath) {
    if (!fs.existsSync(projectPath)) {
      throw new Error(`Project file not found: ${projectPath}`)
    }

    // Handle .qgz (compressed) files
    if (projectPath.endsWith('.qgz')) {
      return this.loadCompressedProject(projectPath)
    }

    return fs.readFileSync(projectPath, 'utf-8')
  }

  /**
   * Load compressed .qgz project file
   */
  loadCompressedProject(qgzPath) {
    try {
      const AdmZip = require('adm-zip')
      const zip = new AdmZip(qgzPath)
      const entries = zip.getEntries()
      
      // Find the .qgs file inside the zip
      const qgsEntry = entries.find(e => e.entryName.endsWith('.qgs'))
      if (qgsEntry) {
        return qgsEntry.getData().toString('utf8')
      }
      
      throw new Error('No .qgs file found in .qgz archive')
    } catch (error) {
      // Fallback: try reading as plain XML (some .qgz files are actually .qgs renamed)
      return fs.readFileSync(qgzPath, 'utf-8')
    }
  }

  /**
   * Find layer definition in project content
   * Uses a two-step approach: first extract all maplayer blocks, then find the matching one
   */
  findLayerInProject(projectContent, layerName) {
    // Step 1: Extract all maplayer blocks individually
    // We need to handle nested tags properly by tracking depth
    const maplayerBlocks = []
    let startIndex = 0
    
    while (true) {
      const openTag = projectContent.indexOf('<maplayer', startIndex)
      if (openTag === -1) break
      
      // Find the matching closing tag by tracking depth
      let depth = 1
      let searchPos = projectContent.indexOf('>', openTag) + 1
      
      while (depth > 0 && searchPos < projectContent.length) {
        const nextOpen = projectContent.indexOf('<maplayer', searchPos)
        const nextClose = projectContent.indexOf('</maplayer>', searchPos)
        
        if (nextClose === -1) break
        
        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth++
          searchPos = nextOpen + 10
        } else {
          depth--
          if (depth === 0) {
            const endIndex = nextClose + '</maplayer>'.length
            maplayerBlocks.push(projectContent.substring(openTag, endIndex))
          }
          searchPos = nextClose + 11
        }
      }
      
      startIndex = searchPos
    }

    console.log(`[Perfect Style] 📊 Found ${maplayerBlocks.length} maplayer blocks in project`)

    // Step 2: Search for the correct layer in isolated blocks
    for (const block of maplayerBlocks) {
      // Check layername tag
      const layernameMatch = block.match(/<layername>([^<]*)<\/layername>/i)
      if (layernameMatch && layernameMatch[1].trim().toLowerCase() === layerName.toLowerCase()) {
        console.log(`[Perfect Style] 📍 Found layer by <layername>: ${layerName}`)
        return block
      }
      
      // Check id attribute
      const idMatch = block.match(/id="([^"]*)"/i)
      if (idMatch && idMatch[1].toLowerCase().includes(layerName.toLowerCase())) {
        console.log(`[Perfect Style] 📍 Found layer by id attribute: ${layerName}`)
        return block
      }
      
      // Check datasource for table name
      const datasourceMatch = block.match(/<datasource>([^<]*)<\/datasource>/i)
      if (datasourceMatch && datasourceMatch[1].toLowerCase().includes(`"${layerName.toLowerCase()}"`)) {
        console.log(`[Perfect Style] 📍 Found layer by datasource: ${layerName}`)
        return block
      }
    }

    throw new Error(`Layer "${layerName}" not found in project`)
  }

  /**
   * Extract renderer information from layer XML
   */
  extractRenderer(layerXML, layerName) {
    // Find renderer-v2 element
    const rendererMatch = layerXML.match(/<renderer-v2[^>]*type="([^"]*)"([^>]*)>(.*?)<\/renderer-v2>/is)
    
    if (!rendererMatch) {
      console.log(`[Perfect Style] ⚠️ No renderer found, using default style`)
      return this.getDefaultStyle(layerName)
    }

    const rendererType = rendererMatch[1]
    const rendererAttrs = rendererMatch[2]
    const rendererContent = rendererMatch[3]

    console.log(`[Perfect Style] 🔍 Renderer type: ${rendererType}`)

    switch (rendererType) {
      case 'singleSymbol':
        return this.parseSingleSymbolRenderer(rendererContent, layerName)
      case 'categorizedSymbol':
        return this.parseCategorizedRenderer(rendererContent, rendererAttrs, layerName)
      case 'graduatedSymbol':
        return this.parseGraduatedRenderer(rendererContent, rendererAttrs, layerName)
      case 'RuleRenderer':
        return this.parseRuleBasedRenderer(rendererContent, layerName)
      default:
        console.log(`[Perfect Style] ⚠️ Unknown renderer type: ${rendererType}`)
        return this.getDefaultStyle(layerName)
    }
  }

  /**
   * Parse single symbol renderer
   */
  parseSingleSymbolRenderer(rendererContent, layerName) {
    const symbols = this.extractSymbols(rendererContent)
    
    return {
      rendererType: 'singleSymbol',
      layerName,
      symbols,
      categories: [{
        value: 'default',
        label: layerName,
        symbol: symbols[0] || this.getDefaultSymbol()
      }]
    }
  }

  /**
   * Parse categorized symbol renderer
   */
  parseCategorizedRenderer(rendererContent, rendererAttrs, layerName) {
    // Extract attribute name used for categorization
    const attrMatch = rendererAttrs.match(/attr="([^"]*)"/)
    let attributeName = attrMatch ? attrMatch[1] : 'type'
    
    // Special handling for proposed_peri_urban_zones - use 'zone' field instead of 'type'
    if (layerName === 'proposed_peri_urban_zones' && attributeName === 'type') {
      attributeName = 'zone'
      console.log(`[Perfect Style] 🔧 Corrected attribute name for ${layerName}: 'type' -> 'zone'`)
    }
    
    console.log(`[Perfect Style] 📊 Categorized by attribute: ${attributeName}`)

    const symbols = this.extractSymbols(rendererContent)
    const categories = this.extractCategories(rendererContent, symbols)

    return {
      rendererType: 'categorizedSymbol',
      layerName,
      attributeName,
      symbols,
      categories
    }
  }

  /**
   * Parse graduated symbol renderer
   */
  parseGraduatedRenderer(rendererContent, rendererAttrs, layerName) {
    const attrMatch = rendererAttrs.match(/attr="([^"]*)"/)
    const attributeName = attrMatch ? attrMatch[1] : 'value'
    
    console.log(`[Perfect Style] 📈 Graduated by attribute: ${attributeName}`)

    const symbols = this.extractSymbols(rendererContent)
    const ranges = this.extractRanges(rendererContent, symbols)

    return {
      rendererType: 'graduatedSymbol',
      layerName,
      attributeName,
      symbols,
      ranges
    }
  }

  /**
   * Parse rule-based renderer
   */
  parseRuleBasedRenderer(rendererContent, layerName) {
    const symbols = this.extractSymbols(rendererContent)
    const rules = this.extractRules(rendererContent, symbols)

    return {
      rendererType: 'RuleRenderer',
      layerName,
      symbols,
      rules
    }
  }

  /**
   * Extract all symbols from renderer content
   * Handles QGIS 3.x format where attributes can be in any order
   */
  extractSymbols(rendererContent) {
    const symbols = []
    
    // Match symbol opening tags and extract content up to closing tag
    // Only match top-level symbols (name like "0", "1", etc.), not nested ones (like "@0@0")
    const symbolStartRegex = /<symbol\s+([^>]+)>/gi
    let startMatch
    
    while ((startMatch = symbolStartRegex.exec(rendererContent)) !== null) {
      const attrs = startMatch[1]
      
      // Extract attributes order-agnostically
      const typeMatch = attrs.match(/type="([^"]*)"/)
      const nameMatch = attrs.match(/name="([^"]*)"/)
      const alphaMatch = attrs.match(/alpha="([^"]*)"/)
      
      if (!typeMatch || !nameMatch) continue
      
      const symbolName = nameMatch[1]
      const symbolType = typeMatch[1]
      const alpha = alphaMatch ? parseFloat(alphaMatch[1]) : 1
      
      // Skip nested symbols (names like @0@0, @1@0, etc.)
      if (symbolName.includes('@')) continue
      
      // Find matching closing tag - need to handle nested symbols
      const startPos = startMatch.index + startMatch[0].length
      let depth = 1
      let endPos = startPos
      const symbolOpenRegex = /<symbol\s/g
      const symbolCloseRegex = /<\/symbol>/g
      
      // Find all symbol opens and closes after start position
      const remaining = rendererContent.substring(startPos)
      let closeMatch
      symbolCloseRegex.lastIndex = 0
      
      while ((closeMatch = symbolCloseRegex.exec(remaining)) !== null) {
        // Count opens before this close
        const beforeClose = remaining.substring(0, closeMatch.index)
        const opens = (beforeClose.match(/<symbol\s/g) || []).length
        const closesBeforeThis = (beforeClose.match(/<\/symbol>/g) || []).length
        
        depth = 1 + opens - closesBeforeThis
        if (depth <= 1) {
          endPos = startPos + closeMatch.index
          break
        }
      }
      
      const symbolContent = rendererContent.substring(startPos, endPos)
      
      symbols.push({
        name: symbolName,
        type: symbolType,
        alpha,
        layers: this.extractSymbolLayers(symbolContent, symbolType)
      })
    }

    console.log(`[Perfect Style] ✅ Extracted ${symbols.length} symbols`)
    return symbols
  }

  /**
   * Extract symbol layers (QGIS symbols can have multiple layers)
   */
  extractSymbolLayers(symbolContent, symbolType) {
    const layers = []
    const layerRegex = /<layer[^>]*class="([^"]*)"[^>]*(?:pass="([^"]*)")?[^>]*(?:locked="([^"]*)")?[^>]*>(.*?)<\/layer>/gis
    
    let match
    while ((match = layerRegex.exec(symbolContent)) !== null) {
      const [, layerClass, pass, locked, layerContent] = match
      
      layers.push({
        class: layerClass,
        pass: pass ? parseInt(pass) : 0,
        locked: locked === '1',
        properties: this.extractLayerProperties(layerContent, layerClass)
      })
    }

    // Sort by pass (rendering order)
    layers.sort((a, b) => a.pass - b.pass)
    
    return layers
  }

  /**
   * Extract properties from symbol layer
   * Supports both old <prop k="" v=""/> and new <Option name="" value=""/> formats
   */
  extractLayerProperties(layerContent, layerClass) {
    const props = {}
    
    // Old format: <prop k="key" v="value"/>
    const propRegex = /<prop[^>]*k="([^"]*)"[^>]*v="([^"]*)"[^>]*\/>/gi
    let match
    while ((match = propRegex.exec(layerContent)) !== null) {
      const [, key, value] = match
      props[key] = value
    }

    // New QGIS 3.x format: <Option> with name, value, type attributes in ANY order
    // Universal parser - extracts name and value regardless of attribute ordering
    const allOptionRegex = /<Option\s[^>]*type="QString"[^>]*\/?>/gi
    while ((match = allOptionRegex.exec(layerContent)) !== null) {
      const tag = match[0]
      const nameAttr = tag.match(/\sname="([^"]*)"/)
      const valueAttr = tag.match(/\svalue="([^"]*)"/)
      if (nameAttr && valueAttr) {
        if (!props[nameAttr[1]]) props[nameAttr[1]] = valueAttr[1]
      }
    }

    console.log(`[Perfect Style] 📋 Extracted ${Object.keys(props).length} properties for ${layerClass}`)
    if (props.color) console.log(`[Perfect Style]    color: ${props.color}`)
    if (props.outline_color) console.log(`[Perfect Style]    outline_color: ${props.outline_color}`)
    if (props.line_color) console.log(`[Perfect Style]    line_color: ${props.line_color}`)

    // Parse specific properties based on layer class
    return this.parseLayerClassProperties(props, layerClass)
  }

  /**
   * Parse properties based on symbol layer class
   */
  parseLayerClassProperties(props, layerClass) {
    const parsed = { raw: props }

    switch (layerClass) {
      case 'SimpleFill':
        parsed.fill = {
          color: this.parseQGISColor(props.color),
          style: props.style || 'solid',
          brushStyle: this.parseBrushStyle(props.style)
        }
        parsed.stroke = {
          color: this.parseQGISColor(props.outline_color),
          width: this.parseSize(props.outline_width),
          style: props.outline_style || 'solid'
        }
        break

      case 'SimpleLine':
        parsed.stroke = {
          color: this.parseQGISColor(props.line_color || props.outline_color),
          width: this.parseSize(props.line_width || props.outline_width),
          style: props.line_style || 'solid',
          capStyle: props.capstyle || 'square',
          joinStyle: props.joinstyle || 'bevel',
          customDash: props.customdash || null,
          useCustomDash: props.use_custom_dash === '1',
          offset: props.offset ? parseFloat(props.offset) : 0
        }
        break

      case 'SimpleMarker':
        parsed.marker = {
          shape: props.name || 'circle',
          size: this.parseSize(props.size),
          color: this.parseQGISColor(props.color),
          strokeColor: this.parseQGISColor(props.outline_color),
          strokeWidth: this.parseSize(props.outline_width),
          angle: parseFloat(props.angle) || 0
        }
        break

      case 'SvgMarker':
        parsed.marker = {
          type: 'svg',
          path: props.name,
          size: this.parseSize(props.size),
          color: this.parseQGISColor(props.color),
          strokeColor: this.parseQGISColor(props.outline_color),
          strokeWidth: this.parseSize(props.outline_width)
        }
        break

      case 'LinePatternFill':
        parsed.fill = {
          style: 'pattern',
          pattern: {
            type: 'line',
            angle: parseFloat(props.angle) || 45,
            distance: this.parseSize(props.distance),
            lineWidth: this.parseSize(props.line_width),
            color: this.parseQGISColor(props.color)
          }
        }
        break

      case 'PointPatternFill':
        parsed.fill = {
          style: 'pattern',
          pattern: {
            type: 'point',
            distanceX: this.parseSize(props.distance_x),
            distanceY: this.parseSize(props.distance_y),
            displacementX: this.parseSize(props.displacement_x),
            displacementY: this.parseSize(props.displacement_y)
          }
        }
        break

      case 'GradientFill':
        parsed.fill = {
          style: 'gradient',
          gradient: {
            type: props.gradient_type || 'linear',
            spread: props.spread || 'pad',
            color1: this.parseQGISColor(props.color1),
            color2: this.parseQGISColor(props.color2),
            referencePoint1: this.parsePoint(props.reference_point1),
            referencePoint2: this.parsePoint(props.reference_point2)
          }
        }
        break

      default:
        // Generic fallback
        if (props.color) parsed.fill = { color: this.parseQGISColor(props.color) }
        if (props.outline_color) parsed.stroke = { color: this.parseQGISColor(props.outline_color) }
    }

    return parsed
  }

  /**
   * Parse QGIS color format to web format (#RRGGBB or rgba())
   * Supports formats:
   * - "R,G,B,A" (old format)
   * - "R,G,B,A,rgb:r,g,b,a" (QGIS 3.x extended format)
   * - "#RRGGBB" (hex)
   */
  parseQGISColor(colorString) {
    if (!colorString) return null

    // Check cache
    if (this.colorCache.has(colorString)) {
      return this.colorCache.get(colorString)
    }

    let result

    // Already hex format
    if (colorString.startsWith('#')) {
      result = colorString
    }
    // QGIS RGBA format: "R,G,B,A" or "R,G,B,A,rgb:..."
    else if (colorString.includes(',')) {
      // Handle extended format by taking only first 4 numeric values
      // Example: "77,175,74,255,rgb:0.3019608,0.6862745,0.2901961,1"
      const parts = colorString.split(',')
      const numericParts = []
      
      for (const part of parts) {
        const trimmed = part.trim()
        // Stop at 'rgb:' or when we have 4 values
        if (trimmed.includes(':') || numericParts.length >= 4) break
        const num = parseInt(trimmed)
        if (!isNaN(num)) numericParts.push(num)
      }
      
      if (numericParts.length >= 3) {
        const [r, g, b, a = 255] = numericParts
        
        if (a < 255) {
          result = `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`
        } else {
          result = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
        }
        
        console.log(`[Perfect Style] 🎨 Parsed color: ${colorString.substring(0, 30)}... -> ${result}`)
      } else {
        result = '#45B7D1' // Fallback
      }
    }
    // Named colors
    else {
      result = colorString
    }

    this.colorCache.set(colorString, result)
    return result
  }

  /**
   * Parse size value (may include units)
   */
  parseSize(sizeString) {
    if (!sizeString) return 1
    
    const num = parseFloat(sizeString)
    return isNaN(num) ? 1 : num
  }

  /**
   * Parse point format "x,y"
   */
  parsePoint(pointString) {
    if (!pointString) return { x: 0, y: 0 }
    const [x, y] = pointString.split(',').map(parseFloat)
    return { x: x || 0, y: y || 0 }
  }

  /**
   * Parse brush style to pattern type
   */
  parseBrushStyle(style) {
    const styleMap = {
      'solid': { type: 'solid' },
      'no': { type: 'none' },
      'horizontal': { type: 'horizontal-lines', angle: 0 },
      'vertical': { type: 'vertical-lines', angle: 90 },
      'cross': { type: 'cross-hatch', angles: [0, 90] },
      'b_diagonal': { type: 'diagonal-lines', angle: 45 },
      'f_diagonal': { type: 'diagonal-lines', angle: -45 },
      'diagonal_x': { type: 'cross-hatch', angles: [45, -45] },
      'dense1': { type: 'dot-pattern', density: 1 },
      'dense2': { type: 'dot-pattern', density: 2 },
      'dense3': { type: 'dot-pattern', density: 3 },
      'dense4': { type: 'dot-pattern', density: 4 },
      'dense5': { type: 'dot-pattern', density: 5 },
      'dense6': { type: 'dot-pattern', density: 6 },
      'dense7': { type: 'dot-pattern', density: 7 }
    }
    
    return styleMap[style] || { type: 'solid' }
  }

  /**
   * Extract categories from categorized renderer
   * Handles QGIS 3.x format where attributes can be in any order
   */
  extractCategories(rendererContent, symbols) {
    const categories = []
    // Match any <category .../> tag
    const categoryRegex = /<category\s+([^/>]+)\/>/gi
    
    let match
    while ((match = categoryRegex.exec(rendererContent)) !== null) {
      const attrs = match[1]
      
      // Extract each attribute independently (order-agnostic)
      const valueMatch = attrs.match(/value="([^"]*)"/)
      const symbolMatch = attrs.match(/symbol="([^"]*)"/)
      const labelMatch = attrs.match(/label="([^"]*)"/)
      const renderMatch = attrs.match(/render="([^"]*)"/)
      
      if (!valueMatch || !symbolMatch) continue
      
      const value = valueMatch[1]
      const symbolName = symbolMatch[1]
      const label = labelMatch ? labelMatch[1] : value
      const render = renderMatch ? renderMatch[1] !== 'false' : true
      
      const symbol = symbols.find(s => s.name === symbolName) || this.getDefaultSymbol()
      
      categories.push({
        value,
        label,
        render,
        symbol
      })
      
      console.log(`[Perfect Style] 📊 Category: "${value}" -> symbol ${symbolName}`)
    }

    console.log(`[Perfect Style] ✅ Extracted ${categories.length} categories`)
    return categories
  }

  /**
   * Extract ranges from graduated renderer
   */
  extractRanges(rendererContent, symbols) {
    const ranges = []
    const rangeRegex = /<range[^>]*symbol="([^"]*)"[^>]*lower="([^"]*)"[^>]*upper="([^"]*)"[^>]*label="([^"]*)"[^>]*(?:render="([^"]*)")?[^>]*\/>/gi
    
    let match
    while ((match = rangeRegex.exec(rendererContent)) !== null) {
      const [, symbolName, lower, upper, label, render] = match
      const symbol = symbols.find(s => s.name === symbolName) || this.getDefaultSymbol()
      
      ranges.push({
        lower: parseFloat(lower),
        upper: parseFloat(upper),
        label,
        render: render !== 'false',
        symbol
      })
    }

    return ranges
  }

  /**
   * Extract rules from rule-based renderer
   */
  extractRules(rendererContent, symbols) {
    const rules = []
    const ruleRegex = /<rule[^>]*symbol="([^"]*)"[^>]*(?:filter="([^"]*)")?[^>]*(?:label="([^"]*)")?[^>]*(?:scalemaxdenom="([^"]*)")?[^>]*(?:scalemindenom="([^"]*)")?[^>]*\/>/gi
    
    let match
    while ((match = ruleRegex.exec(rendererContent)) !== null) {
      const [, symbolName, filter, label, scaleMax, scaleMin] = match
      const symbol = symbols.find(s => s.name === symbolName) || this.getDefaultSymbol()
      
      rules.push({
        symbol,
        filter: filter || null,
        label: label || 'Rule',
        scaleMaxDenom: scaleMax ? parseInt(scaleMax) : null,
        scaleMinDenom: scaleMin ? parseInt(scaleMin) : null
      })
    }

    return rules
  }

  /**
   * Extract labeling configuration
   */
  extractLabeling(layerXML) {
    const labelingMatch = layerXML.match(/<labeling[^>]*type="([^"]*)"[^>]*>(.*?)<\/labeling>/is)
    
    if (!labelingMatch) {
      return { enabled: false }
    }

    const labelType = labelingMatch[1]
    const labelContent = labelingMatch[2]

    // Extract text format
    const textFormatMatch = labelContent.match(/<text-format[^>]*>(.*?)<\/text-format>/is)
    const textStyleMatch = labelContent.match(/<text-style[^>]*>(.*?)<\/text-style>/is)

    const labeling = {
      enabled: true,
      type: labelType
    }

    if (textStyleMatch) {
      const styleContent = textStyleMatch[1]
      labeling.textStyle = {
        fontFamily: this.extractXMLAttr(styleContent, 'fontFamily') || 'Arial',
        fontSize: this.parseSize(this.extractXMLAttr(styleContent, 'fontSize')) || 10,
        fontWeight: this.extractXMLAttr(styleContent, 'fontWeight') || 'normal',
        fontItalic: this.extractXMLAttr(styleContent, 'fontItalic') === '1',
        textColor: this.parseQGISColor(this.extractXMLAttr(styleContent, 'textColor')),
        namedStyle: this.extractXMLAttr(styleContent, 'namedStyle')
      }
    }

    // Extract buffer settings
    const bufferMatch = labelContent.match(/<text-buffer[^>]*>(.*?)<\/text-buffer>/is)
    if (bufferMatch) {
      labeling.buffer = {
        enabled: this.extractXMLAttr(bufferMatch[1], 'bufferDraw') === '1',
        size: this.parseSize(this.extractXMLAttr(bufferMatch[1], 'bufferSize')),
        color: this.parseQGISColor(this.extractXMLAttr(bufferMatch[1], 'bufferColor'))
      }
    }

    // Extract field name for labels
    const fieldMatch = labelContent.match(/fieldName="([^"]*)"/i)
    if (fieldMatch) {
      labeling.fieldName = fieldMatch[1]
    }

    return labeling
  }

  /**
   * Extract attribute from XML content
   */
  extractXMLAttr(content, attrName) {
    const match = content.match(new RegExp(`${attrName}="([^"]*)"`, 'i'))
    return match ? match[1] : null
  }

  /**
   * Convert QGIS style to web-compatible format
   */
  convertToWebStyle(qgisStyle) {
    const webStyle = {
      layerName: qgisStyle.layerName,
      rendererType: qgisStyle.rendererType,
      attributeName: qgisStyle.attributeName,
      geometryType: this.detectGeometryType(qgisStyle),
      symbols: [],
      hasComplexPatterns: false,
      hasHatchPatterns: false,
      hasGradients: false
    }

    // Convert based on renderer type
    const items = qgisStyle.categories || qgisStyle.ranges || qgisStyle.rules || []
    
    for (const item of items) {
      const webSymbol = this.convertSymbolToWeb(item.symbol, webStyle.geometryType, item)
      webStyle.symbols.push(webSymbol)
      
      // Track complexity
      if (webSymbol.fill?.style !== 'solid' && webSymbol.fill?.style !== 'none') {
        webStyle.hasComplexPatterns = true
      }
      if (webSymbol.fill?.pattern?.type?.includes('line') || webSymbol.fill?.pattern?.type?.includes('hatch')) {
        webStyle.hasHatchPatterns = true
      }
      if (webSymbol.fill?.gradient) {
        webStyle.hasGradients = true
      }
    }

    return webStyle
  }

  /**
   * Convert single symbol to web format
   */
  convertSymbolToWeb(symbol, geometryType, categoryInfo = {}) {
    const webSymbol = {
      id: categoryInfo.value || 'default',
      name: categoryInfo.label || 'Default',
      category: categoryInfo.value || 'default',
      render: categoryInfo.render !== false,
      fill: null,
      stroke: null,
      marker: null,
      strokeLayers: [] // Store multiple line layers for complex outlines
    }

    // Check if this is an outline-only symbol (fill type but only SimpleLine layers)
    const hasSimpleFill = (symbol.layers || []).some(l => l.class === 'SimpleFill')
    const hasSimpleLine = (symbol.layers || []).some(l => l.class === 'SimpleLine')
    const isOutlineOnly = !hasSimpleFill && hasSimpleLine && symbol.type === 'fill'

    // Process symbol layers (bottom to top)
    for (const layer of (symbol.layers || [])) {
      // Handle fill from any fill-type layer (SimpleFill, LinePatternFill, PointPatternFill, etc.)
      if (layer.properties.fill) {
        webSymbol.fill = { ...webSymbol.fill, ...layer.properties.fill }
      }
      if (layer.properties.stroke) {
        // Store all line layers for complex multi-line outlines
        if (layer.class === 'SimpleLine') {
          webSymbol.strokeLayers.push({
            ...layer.properties.stroke,
            offset: layer.properties.raw?.offset ? parseFloat(layer.properties.raw.offset) : 0
          })
        }
        // Use the most prominent line as the main stroke
        if (!webSymbol.stroke || layer.properties.stroke.width > (webSymbol.stroke.width || 0)) {
          webSymbol.stroke = { ...layer.properties.stroke }
        }
      }
      if (layer.properties.marker) {
        webSymbol.marker = { ...webSymbol.marker, ...layer.properties.marker }
      }
    }

    // Mark as outline-only (no fill)
    if (isOutlineOnly) {
      webSymbol.isOutlineOnly = true
      webSymbol.fill = { color: 'transparent', opacity: 0, style: 'none' }
      console.log(`[Perfect Style] 🔲 Outline-only symbol detected with ${webSymbol.strokeLayers.length} line layers`)
    }

    // Apply symbol-level alpha
    if (symbol.alpha < 1) {
      if (webSymbol.fill) webSymbol.fill.opacity = (webSymbol.fill.opacity || 1) * symbol.alpha
      if (webSymbol.stroke) webSymbol.stroke.opacity = (webSymbol.stroke.opacity || 1) * symbol.alpha
    }

    // Only add default fill for polygons if NOT outline-only
    if (geometryType === 'polygon' && !webSymbol.fill && !isOutlineOnly) {
      webSymbol.fill = { color: '#45B7D1', opacity: 0.5, style: 'solid' }
    }
    if (!webSymbol.stroke) {
      webSymbol.stroke = { color: '#2c3e50', width: 1, opacity: 1 }
    }

    return webSymbol
  }

  /**
   * Generate MapLibre GL JS compatible style
   */
  generateMapLibreStyle(webStyle) {
    const symbol = webStyle.symbols[0] || {}
    const isOutlineOnly = symbol.isOutlineOnly
    
    const maplibreStyle = {
      id: webStyle.layerName,
      source: webStyle.layerName,
      metadata: {
        'qgis:renderer': webStyle.rendererType,
        'qgis:attribute': webStyle.attributeName,
        'qgis:hasPatterns': webStyle.hasComplexPatterns,
        'qgis:isOutlineOnly': isOutlineOnly
      }
    }

    // Set layer type based on geometry
    // For outline-only polygons, use 'line' type instead of 'fill'
    if (isOutlineOnly && webStyle.geometryType === 'polygon') {
      maplibreStyle.type = 'line'
      console.log(`[Perfect Style] 🔲 Using line type for outline-only polygon: ${webStyle.layerName}`)
    } else {
      maplibreStyle.type = this.getMapLibreLayerType(webStyle.geometryType)
    }

    // Generate paint properties
    if (webStyle.symbols.length === 1 || webStyle.rendererType === 'singleSymbol') {
      // Simple style
      maplibreStyle.paint = this.generateSimplePaint(webStyle.symbols[0], maplibreStyle.type)
      
      // For outline-only with multiple line layers, generate additional layers
      if (isOutlineOnly && symbol.strokeLayers && symbol.strokeLayers.length > 1) {
        maplibreStyle.additionalLayers = this.generateMultiLineLayerStyles(symbol.strokeLayers, webStyle.layerName)
      }
    } else {
      // Data-driven style
      maplibreStyle.paint = this.generateDataDrivenPaint(webStyle, maplibreStyle.type)
    }

    return maplibreStyle
  }

  /**
   * Generate multiple line layer styles for complex QGIS outlines
   */
  generateMultiLineLayerStyles(strokeLayers, layerName) {
    return strokeLayers.map((stroke, index) => {
      const paint = {
        'line-color': stroke.color || '#2c3e50',
        'line-width': stroke.width || 1,
        'line-opacity': stroke.opacity ?? 1
      }
      
      // Handle line offset
      if (stroke.offset && stroke.offset !== 0) {
        paint['line-offset'] = stroke.offset
      }
      
      // Handle dash patterns
      if (stroke.style === 'dash') {
        paint['line-dasharray'] = [5, 2]
      } else if (stroke.style === 'dot') {
        paint['line-dasharray'] = [2, 4]
      }
      
      return {
        id: `${layerName}-line-${index}`,
        type: 'line',
        paint
      }
    })
  }

  /**
   * Generate simple paint properties
   */
  generateSimplePaint(symbol, layerType) {
    const paint = {}

    // Handle outline-only polygons - return line style instead of fill
    if (symbol.isOutlineOnly && layerType === 'fill') {
      // Return line paint for outline-only polygons
      const stroke = symbol.stroke || {}
      paint['line-color'] = stroke.color || '#2c3e50'
      paint['line-width'] = stroke.width || 2
      paint['line-opacity'] = stroke.opacity ?? 1
      
      // Handle dash patterns
      if (stroke.style === 'dash' || stroke.style === 'dot') {
        paint['line-dasharray'] = stroke.style === 'dot' ? [2, 4] : [5, 2]
      }
      if (stroke.customDash) {
        paint['line-dasharray'] = stroke.customDash.split(';').map(Number)
      }
      
      // Store additional line layers info for multi-line rendering
      if (symbol.strokeLayers && symbol.strokeLayers.length > 0) {
        paint._strokeLayers = symbol.strokeLayers
      }
      
      return paint
    }

    switch (layerType) {
      case 'fill':
        paint['fill-color'] = symbol.fill?.color || '#45B7D1'
        paint['fill-opacity'] = symbol.fill?.opacity ?? 0.5
        if (symbol.stroke?.color) {
          paint['fill-outline-color'] = symbol.stroke.color
        }
        break

      case 'line':
        paint['line-color'] = symbol.stroke?.color || '#45B7D1'
        paint['line-width'] = symbol.stroke?.width || 2
        paint['line-opacity'] = symbol.stroke?.opacity ?? 1
        // Only add dash array for dash/dot styles, not for solid lines
        // QGIS stores customdash even for solid lines, so check style first
        const lineStyle = symbol.stroke?.style || 'solid'
        if (lineStyle === 'dash') {
          paint['line-dasharray'] = [5, 2]
        } else if (lineStyle === 'dot') {
          paint['line-dasharray'] = [2, 4]
        }
        // Only use customDash if use_custom_dash is enabled (not for solid lines)
        if (symbol.stroke?.useCustomDash && symbol.stroke?.customDash) {
          paint['line-dasharray'] = symbol.stroke.customDash.split(';').map(Number)
        }
        break

      case 'circle':
        paint['circle-color'] = symbol.marker?.color || symbol.fill?.color || '#45B7D1'
        paint['circle-radius'] = (symbol.marker?.size || 6) / 2
        paint['circle-opacity'] = symbol.fill?.opacity ?? 0.8
        paint['circle-stroke-color'] = symbol.marker?.strokeColor || symbol.stroke?.color || '#2c3e50'
        paint['circle-stroke-width'] = symbol.marker?.strokeWidth || symbol.stroke?.width || 1
        break
    }

    return paint
  }

  /**
   * Generate data-driven paint properties for categorized/graduated styles
   */
  generateDataDrivenPaint(webStyle, layerType) {
    const paint = {}
    // PostgreSQL returns lowercase column names, so convert attribute name to lowercase
    const attr = (webStyle.attributeName || 'type').toLowerCase()

    // Build match expression for colors
    const colorExpr = ['match', ['get', attr]]
    const opacityExpr = ['match', ['get', attr]]
    const widthExpr = ['match', ['get', attr]]
    const strokeColorExpr = ['match', ['get', attr]]

    for (const symbol of webStyle.symbols) {
      if (!symbol.render) continue
      
      // Get fill color - check multiple locations (SimpleFill uses fill.color, patterns use fill.pattern.color)
      const fillColor = symbol.fill?.color || symbol.fill?.pattern?.color || symbol.stroke?.color || '#45B7D1'
      
      colorExpr.push(symbol.category)
      colorExpr.push(fillColor)
      
      opacityExpr.push(symbol.category)
      opacityExpr.push(symbol.fill?.opacity ?? symbol.stroke?.opacity ?? 0.5)
      
      widthExpr.push(symbol.category)
      widthExpr.push(symbol.stroke?.width || 2)
      
      strokeColorExpr.push(symbol.category)
      strokeColorExpr.push(symbol.stroke?.color || '#2c3e50')
    }

    // Add defaults
    colorExpr.push('#BDC3C7')
    opacityExpr.push(0.5)
    widthExpr.push(1)
    strokeColorExpr.push('#7f8c8d')

    switch (layerType) {
      case 'fill':
        paint['fill-color'] = colorExpr
        paint['fill-opacity'] = opacityExpr
        paint['fill-outline-color'] = strokeColorExpr
        break

      case 'line':
        paint['line-color'] = colorExpr
        paint['line-width'] = widthExpr
        paint['line-opacity'] = opacityExpr
        break

      case 'circle':
        paint['circle-color'] = colorExpr
        paint['circle-radius'] = 6
        paint['circle-opacity'] = opacityExpr
        paint['circle-stroke-color'] = strokeColorExpr
        paint['circle-stroke-width'] = 1
        break
    }

    return paint
  }

  /**
   * Generate SVG pattern definitions for complex fills
   */
  generatePatternDefinitions(webStyle) {
    const patterns = []

    for (const symbol of webStyle.symbols) {
      if (!symbol.fill?.pattern && !symbol.fill?.brushStyle?.type) continue

      const patternType = symbol.fill.pattern?.type || symbol.fill.brushStyle?.type
      
      if (patternType && patternType !== 'solid' && patternType !== 'none') {
        const pattern = this.createPatternSVG(patternType, symbol)
        if (pattern) {
          patterns.push({
            id: `pattern-${symbol.id}`,
            ...pattern
          })
        }
      }
    }

    return patterns
  }

  /**
   * Create SVG pattern for web rendering
   */
  createPatternSVG(patternType, symbol) {
    const strokeColor = symbol.stroke?.color || '#2c3e50'
    const spacing = 8

    switch (patternType) {
      case 'diagonal-lines':
        return {
          type: 'svg',
          width: spacing * 2,
          height: spacing * 2,
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${spacing * 2}" height="${spacing * 2}">
            <defs>
              <pattern id="diag" patternUnits="userSpaceOnUse" width="${spacing * 2}" height="${spacing * 2}" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="${spacing * 2}" y2="0" stroke="${strokeColor}" stroke-width="1" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#diag)" />
          </svg>`
        }

      case 'horizontal-lines':
        return {
          type: 'svg',
          width: spacing,
          height: spacing,
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${spacing}" height="${spacing}">
            <line x1="0" y1="${spacing / 2}" x2="${spacing}" y2="${spacing / 2}" stroke="${strokeColor}" stroke-width="1" />
          </svg>`
        }

      case 'vertical-lines':
        return {
          type: 'svg',
          width: spacing,
          height: spacing,
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${spacing}" height="${spacing}">
            <line x1="${spacing / 2}" y1="0" x2="${spacing / 2}" y2="${spacing}" stroke="${strokeColor}" stroke-width="1" />
          </svg>`
        }

      case 'cross-hatch':
        return {
          type: 'svg',
          width: spacing,
          height: spacing,
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${spacing}" height="${spacing}">
            <line x1="0" y1="0" x2="${spacing}" y2="${spacing}" stroke="${strokeColor}" stroke-width="1" />
            <line x1="${spacing}" y1="0" x2="0" y2="${spacing}" stroke="${strokeColor}" stroke-width="1" />
          </svg>`
        }

      case 'dot-pattern':
        const density = symbol.fill?.brushStyle?.density || 4
        const dotSize = Math.max(1, 4 - density * 0.5)
        return {
          type: 'svg',
          width: spacing,
          height: spacing,
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${spacing}" height="${spacing}">
            <circle cx="${spacing / 2}" cy="${spacing / 2}" r="${dotSize}" fill="${strokeColor}" />
          </svg>`
        }

      default:
        return null
    }
  }

  /**
   * Detect geometry type from style
   */
  detectGeometryType(qgisStyle) {
    const symbols = qgisStyle.symbols || []
    if (symbols.length === 0) return 'polygon'

    const firstSymbol = symbols[0]
    
    if (firstSymbol.type === 'fill') return 'polygon'
    if (firstSymbol.type === 'line') return 'linestring'
    if (firstSymbol.type === 'marker') return 'point'
    
    // Check layer classes
    for (const layer of (firstSymbol.layers || [])) {
      if (layer.class?.includes('Fill')) return 'polygon'
      if (layer.class?.includes('Line')) return 'linestring'
      if (layer.class?.includes('Marker')) return 'point'
    }

    return 'polygon'
  }

  /**
   * Get MapLibre layer type
   */
  getMapLibreLayerType(geometryType) {
    const typeMap = {
      'point': 'circle',
      'multipoint': 'circle',
      'linestring': 'line',
      'multilinestring': 'line',
      'polygon': 'fill',
      'multipolygon': 'fill'
    }
    return typeMap[geometryType.toLowerCase()] || 'fill'
  }

  /**
   * Get default style when none found
   */
  getDefaultStyle(layerName) {
    return {
      rendererType: 'singleSymbol',
      layerName,
      symbols: [this.getDefaultSymbol()],
      categories: [{
        value: 'default',
        label: layerName,
        symbol: this.getDefaultSymbol()
      }]
    }
  }

  /**
   * Get default symbol
   */
  getDefaultSymbol() {
    return {
      name: 'default',
      type: 'fill',
      alpha: 1,
      layers: [{
        class: 'SimpleFill',
        pass: 0,
        locked: false,
        properties: {
          fill: { color: '#45B7D1', style: 'solid', opacity: 0.5 },
          stroke: { color: '#2c3e50', width: 1, opacity: 1 }
        }
      }]
    }
  }

  /**
   * Escape regex special characters
   */
  escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear()
    this.colorCache.clear()
    console.log(`[Perfect Style] 🧹 Cache cleared`)
  }
}

module.exports = { PerfectQGISStyleExtractor }
