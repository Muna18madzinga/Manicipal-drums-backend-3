const { XMLParser } = require('fast-xml-parser')
const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')

class QmlParserService {
  constructor(pool) {
    this.pool = pool
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      textNodeName: '#text',
      parseAttributeValue: true,
      parseTagValue: true,
      trimValues: true
    })
  }

  /**
   * Parse QML content using QGIS plugin for full SVG extraction
   */
  async parseQmlContent(qmlContent, layerName = null) {
    try {
      console.log('[QML Parser] 🎯 Attempting QGIS plugin extraction first...')
      
      // Try QGIS plugin extraction first
      const qgisResult = await this.extractWithQGISPlugin(qmlContent, layerName)
      if (qgisResult && qgisResult.success) {
        console.log('[QML Parser] ✅ QGIS plugin extraction successful!')
        return qgisResult.data
      }
      
      console.log('[QML Parser] ⚠️ QGIS plugin failed, falling back to basic parser...')
      
      // Fallback to basic XML parsing
      return await this.parseQmlContentBasic(qmlContent)
      
    } catch (error) {
      console.log('[QML Parser] ❌ All methods failed, using basic parser...')
      return await this.parseQmlContentBasic(qmlContent)
    }
  }

  /**
   * Extract symbology using QGIS plugin
   */
  async extractWithQGISPlugin(qmlContent, layerName) {
    return new Promise((resolve) => {
      try {
        // Create temporary QML file
        const tempQmlPath = path.join(__dirname, '../../../temp', `temp_${Date.now()}.qml`)
        const tempDir = path.dirname(tempQmlPath)
        
        // Ensure temp directory exists
        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true })
        }
        
        // Write QML content to temp file
        fs.writeFileSync(tempQmlPath, qmlContent)
        
        // Path to QGIS plugin script
        const pluginScript = path.join(__dirname, '../../../vungu-integration/extract_symbology.py')
        
        // Command to run QGIS plugin
        const command = `python "${pluginScript}" --qml "${tempQmlPath}" --layer "${layerName || 'unknown'}"`
        
        console.log('[QML Parser] 🚀 Running QGIS plugin extraction...')
        console.log('[QML Parser] Command:', command)
        
        exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
          // Clean up temp file
          try {
            fs.unlinkSync(tempQmlPath)
          } catch (cleanupError) {
            console.log('[QML Parser] ⚠️ Could not clean up temp file:', cleanupError.message)
          }
          
          if (error) {
            console.log('[QML Parser] ❌ QGIS plugin execution failed:', error.message)
            console.log('[QML Parser] stderr:', stderr)
            resolve({ success: false, error: error.message })
            return
          }
          
          try {
            console.log('[QML Parser] 📄 QGIS plugin stdout:', stdout)
            
            // Parse the JSON output from QGIS plugin
            const result = JSON.parse(stdout)
            
            if (result.success) {
              console.log('[QML Parser] ✅ QGIS plugin extraction successful!')
              console.log('[QML Parser] 📊 Extracted categories:', result.data._categories?.length || 0)
              resolve({ success: true, data: result.data })
            } else {
              console.log('[QML Parser] ⚠️ QGIS plugin reported failure:', result.error)
              resolve({ success: false, error: result.error })
            }
            
          } catch (parseError) {
            console.log('[QML Parser] ❌ Failed to parse QGIS plugin output:', parseError.message)
            resolve({ success: false, error: parseError.message })
          }
        })
        
      } catch (error) {
        console.log('[QML Parser] ❌ QGIS plugin setup failed:', error.message)
        resolve({ success: false, error: error.message })
      }
    })
  }

  /**
   * Basic QML parsing fallback
   */
  async parseQmlContentBasic(qmlContent) {
    try {
      // Debug: Log the raw QML content
      console.log('[QML Parser] Raw QML content:', qmlContent)
      
      const parsed = this.xmlParser.parse(qmlContent);
      console.log('[QML Parser] Parsed XML:', JSON.stringify(parsed, null, 2))
      
      const renderer = parsed.qml?.['renderer-v2'];
      console.log('[QML Parser] Renderer found:', renderer)
      
      if (!renderer) {
        throw new Error('Invalid QML format: missing renderer-v2 element');
      }

      const symbols = renderer.symbols?.symbol || renderer.symbol || [];
      console.log('[QML Parser] Raw symbols:', symbols)
      
      // Handle case where symbols is a string reference to the symbol property
      let symbolArray = [];
      console.log('[QML Parser] symbols type:', typeof symbols)
      console.log('[QML Parser] symbols value:', symbols)
      console.log('[QML Parser] renderer.symbols:', renderer.symbols)
      console.log('[QML Parser] renderer.symbol exists:', !!renderer.symbol)
      
      if (typeof symbols === 'string' && renderer[symbols]) {
        symbolArray = [renderer[symbols]];
        console.log('[QML Parser] Using string reference path')
      } else if (Array.isArray(symbols)) {
        symbolArray = symbols;
        console.log('[QML Parser] Using array symbols')
      } else if (symbols && typeof symbols === 'object') {
        symbolArray = [symbols];
        console.log('[QML Parser] Using object symbols')
      } else if (renderer.symbol) {
        symbolArray = [renderer.symbol];
        console.log('[QML Parser] Using renderer.symbol fallback')
      }
      
      console.log('[QML Parser] Symbol array:', symbolArray)
      
      const parsedConfig = {
        rendererType: renderer.type || 'singleSymbol',
        symbols: [],
        layers: [],
        labels: [],
        legend: {},
        properties: {}
      }

      // Parse symbols
      for (const symbol of symbolArray) {
        if (!symbol) continue
        
        const symbolConfig = this.parseSymbol(symbol)
        parsedConfig.symbols.push(symbolConfig)
        
        // For categorized renderer, create categories for frontend
        if (renderer.type === 'categorized' && symbolConfig.layers && symbolConfig.layers.length > 0) {
          const layer = symbolConfig.layers[0]
          const category = {
            value: symbol.name || 'default',
            label: symbol.name || 'Default',
            style: {
              color: this.rgbToHex(layer.properties.color || '255,0,0,255'),
              radius: parseFloat(layer.properties.size) || 6
            }
          }
          parsedConfig._categories = parsedConfig._categories || []
          parsedConfig._categories.push(category)
        }
      }

      // Parse rotation and scale if present
      if (renderer.rotation) {
        parsedConfig.properties.rotation = renderer.rotation
      }
      
      if (renderer.sizescale) {
        parsedConfig.properties.scale = renderer.sizescale
      }

      // Parse data-defined properties
      if (symbolArray[0]?.layer?.['data_defined_properties']) {
        parsedConfig.dataDefinedProperties = this.parseDataDefinedProperties(
          symbolArray[0].layer['data_defined_properties']
        )
      }

      return parsedConfig
      
    } catch (error) {
      throw new Error(`QML parsing failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Create a new QML style template
   */
  async createQmlTemplate(
    name,
    description,
    qmlContent,
    styleType,
    createdBy
  ) {
    // Parse QML content
    const parsedConfig = await this.parseQmlContent(qmlContent)

    const query = `
      INSERT INTO qml_style_templates (name, description, qml_content, parsed_config, style_type, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `
    
    const values = [name, description, qmlContent, parsedConfig, styleType, createdBy]
    const result = await this.pool.query(query, values)
    
    return result.rows[0]
  }

  /**
   * Convert RGB color string to hex
   */
  rgbToHex(colorStr) {
    if (!colorStr) return '#FF0000'
    
    // Handle "r,g,b,a" format
    if (colorStr.includes(',')) {
      const parts = colorStr.split(',')
      const r = parseInt(parts[0]) || 255
      const g = parseInt(parts[1]) || 0
      const b = parseInt(parts[2]) || 0
      return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
    }
    
    // Handle hex format
    if (colorStr.startsWith('#')) {
      return colorStr
    }
    
    return '#FF0000'
  }

  /**
   * Parse individual symbol configuration
   */
  parseSymbol(symbol) {
    const layers = symbol.layer || []
    const layerArray = Array.isArray(layers) ? layers : [layers]
    
    const symbolConfig = {
      type: symbol.type || 'marker',
      name: symbol.name || '',
      layers: [],
      properties: {}
    }

    // Parse layers
    for (const layer of layerArray) {
      if (!layer) continue
      
      const layerConfig = this.parseSymbolLayer(layer)
      symbolConfig.layers.push(layerConfig)
    }

    // Parse symbol properties
    if (symbol.locked) {
      symbolConfig.properties.locked = symbol.locked === '1'
    }

    return symbolConfig
  }

  /**
   * Parse symbol layer configuration
   */
  parseSymbolLayer(layer) {
    const layerConfig = {
      type: layer.type || 'SimpleMarker',
      properties: {},
      stroke: {},
      fill: {}
    }

    // Parse common properties
    if (layer.pass) {
      layerConfig.properties.pass = parseInt(layer.pass)
    }

    if (layer.enabled) {
      layerConfig.properties.enabled = layer.enabled === '1'
    }

    // Parse based on layer type
    switch (layer.type) {
      case 'SimpleMarker':
        return this.parseSimpleMarkerLayer(layer, layerConfig)
      case 'SimpleLine':
        return this.parseSimpleLineLayer(layer, layerConfig)
      case 'SimpleFill':
        return this.parseSimpleFillLayer(layer, layerConfig)
      default:
        return layerConfig
    }
  }

  /**
   * Parse simple marker layer
   */
  parseSimpleMarkerLayer(layer, layerConfig) {
    // Parse prop elements for QML properties
    const props = layer.prop || []
    const propArray = Array.isArray(props) ? props : [props]
    
    // Create a lookup object for properties
    const propMap = {}
    for (const prop of propArray) {
      if (prop && prop.k) {
        propMap[prop.k] = prop.v
      }
    }
    
    // Stroke properties
    if (propMap.outline_color) {
      layerConfig.stroke.color = this.parseColor(propMap.outline_color)
    }
    if (propMap.outline_width) {
      layerConfig.stroke.width = parseFloat(propMap.outline_width)
    }
    if (propMap.outline_style) {
      layerConfig.stroke.style = this.parseLineStyle(propMap.outline_style)
    }

    // Fill properties
    if (propMap.color) {
      layerConfig.fill.color = this.parseColor(propMap.color)
      layerConfig.properties.color = propMap.color
    }
    if (propMap.style) {
      layerConfig.fill.style = this.parseFillStyle(propMap.style)
    }

    // Marker properties
    if (propMap.size) {
      layerConfig.size = parseFloat(propMap.size)
      layerConfig.properties.size = propMap.size
    }
    if (propMap.angle) {
      layerConfig.angle = parseFloat(propMap.angle)
      layerConfig.properties.angle = propMap.angle
    }
    if (propMap.name) {
      layerConfig.symbolType = this.parseSymbolType(propMap.name)
      layerConfig.properties.name = propMap.name
    }

    return layerConfig
  }

  /**
   * Parse simple line layer
   */
  parseSimpleLineLayer(layer, layerConfig) {
    if (layer.stroke_color) {
      layerConfig.stroke.color = this.parseColor(layer.stroke_color)
    }
    if (layer.stroke_width) {
      layerConfig.stroke.width = parseFloat(layer.stroke_width)
    }
    if (layer.stroke_style) {
      layerConfig.stroke.style = this.parseLineStyle(layer.stroke_style)
    }
    if (layer.capstyle) {
      layerConfig.stroke.capStyle = this.parseCapStyle(layer.capstyle)
    }
    if (layer.joinstyle) {
      layerConfig.stroke.joinStyle = this.parseJoinStyle(layer.joinstyle)
    }

    return layerConfig
  }

  /**
   * Parse simple fill layer
   */
  parseSimpleFillLayer(layer, layerConfig) {
    // Stroke properties
    if (layer.stroke_color) {
      layerConfig.stroke.color = this.parseColor(layer.stroke_color)
    }
    if (layer.stroke_width) {
      layerConfig.stroke.width = parseFloat(layer.stroke_width)
    }
    if (layer.stroke_style) {
      layerConfig.stroke.style = this.parseLineStyle(layer.stroke_style)
    }

    // Fill properties
    if (layer.color) {
      layerConfig.fill.color = this.parseColor(layer.color)
    }
    if (layer.style) {
      layerConfig.fill.style = this.parseFillStyle(layer.style)
    }

    return layerConfig
  }

  /**
   * Parse color string to rgba object
   */
  parseColor(colorStr) {
    if (!colorStr) return { r: 0, g: 0, b: 0, a: 255 }
    
    // Handle hex colors
    if (colorStr.startsWith('#')) {
      const hex = colorStr.slice(1)
      if (hex.length === 6) {
        return {
          r: parseInt(hex.slice(0, 2), 16),
          g: parseInt(hex.slice(2, 4), 16),
          b: parseInt(hex.slice(4, 6), 16),
          a: 255
        }
      }
    }
    
    // Handle rgb/rgba strings
    if (colorStr.startsWith('rgb')) {
      const matches = colorStr.match(/\d+/g)
      if (matches) {
        return {
          r: parseInt(matches[0]) || 0,
          g: parseInt(matches[1]) || 0,
          b: parseInt(matches[2]) || 0,
          a: parseInt(matches[3]) || 255
        }
      }
    }
    
    return { r: 0, g: 0, b: 0, a: 255 }
  }

  /**
   * Parse line style
   */
  parseLineStyle(styleStr) {
    const styles = {
      'solid': 'solid',
      'dash': 'dash',
      'dot': 'dot',
      'dashdot': 'dashdot',
      'dashdotdot': 'dashdotdot'
    }
    return styles[styleStr] || 'solid'
  }

  /**
   * Parse fill style
   */
  parseFillStyle(styleStr) {
    const styles = {
      'solid': 'solid',
      'no': 'none',
      'horizontal': 'horizontal',
      'vertical': 'vertical',
      'cross': 'cross',
      'b_diagonal': 'backward_diagonal',
      'f_diagonal': 'forward_diagonal',
      'diagonal_x': 'diagonal_cross'
    }
    return styles[styleStr] || 'solid'
  }

  /**
   * Parse line cap style
   */
  parseCapStyle(capStr) {
    const styles = {
      'square': 'square',
      'flat': 'butt',
      'round': 'round'
    }
    return styles[capStr] || 'round'
  }

  /**
   * Parse line join style
   */
  parseJoinStyle(joinStr) {
    const styles = {
      'round': 'round',
      'miter': 'miter',
      'bevel': 'bevel'
    }
    return styles[joinStr] || 'round'
  }

  /**
   * Parse symbol type
   */
  parseSymbolType(symbolStr) {
    const types = {
      '0': 'circle',
      '1': 'rectangle',
      '2': 'diamond',
      '3': 'pentagon',
      '4': 'triangle',
      '5': 'equilateral_triangle',
      '6': 'star',
      '7': 'regular_star',
      '8': 'cross',
      '9': 'cross2',
      '10': 'x',
      '11': 'arrow',
      '12': 'filled_arrowhead',
      '13': 'line'
    }
    return types[symbolStr] || 'circle'
  }

  /**
   * Parse data-defined properties
   */
  parseDataDefinedProperties(dataDefined) {
    const properties = {}
    
    if (dataDefined?.Property) {
      const propertyArray = Array.isArray(dataDefined.Property) ? dataDefined.Property : [dataDefined.Property]
      
      for (const prop of propertyArray) {
        if (prop && prop.key) {
          properties[prop.key] = {
            active: prop.active === '1',
            expression: prop.expr || '',
            type: prop.type || '0'
          }
        }
      }
    }
    
    return properties
  }

  /**
   * Get QML template by ID
   */
  async getQmlTemplate(id) {
    const query = 'SELECT * FROM qml_style_templates WHERE id = $1'
    const result = await this.pool.query(query, [id])
    
    if (result.rows.length === 0) {
      throw new Error('QML template not found')
    }
    
    return result.rows[0]
  }

  /**
   * Get all QML templates
   */
  async getAllQmlTemplates() {
    const query = 'SELECT * FROM qml_style_templates ORDER BY created_at DESC'
    const result = await this.pool.query(query)
    return result.rows
  }

  /**
   * Update QML template
   */
  async updateQmlTemplate(id, updates) {
    const fields = []
    const values = []
    let paramIndex = 1

    for (const [key, value] of Object.entries(updates)) {
      if (key !== 'id' && key !== 'created_at') {
        fields.push(`${key} = $${paramIndex}`)
        values.push(value)
        paramIndex++
      }
    }

    if (fields.length === 0) {
      throw new Error('No valid fields to update')
    }

    fields.push(`updated_at = NOW()`)
    values.push(id)

    const query = `
      UPDATE qml_style_templates 
      SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `
    
    const result = await this.pool.query(query, values)
    
    if (result.rows.length === 0) {
      throw new Error('QML template not found')
    }
    
    return result.rows[0]
  }

  /**
   * Delete QML template
   */
  async deleteQmlTemplate(id) {
    const query = 'DELETE FROM qml_style_templates WHERE id = $1 RETURNING *'
    const result = await this.pool.query(query, [id])
    
    if (result.rows.length === 0) {
      throw new Error('QML template not found')
    }
    
    return result.rows[0]
  }

  /**
   * Apply QML style to layer
   */
  async applyQmlStyleToLayer(layerId, qmlTemplateId) {
    // Get QML template
    const template = await this.getQmlTemplate(qmlTemplateId)
    
    // Update layer style
    const updateQuery = `
      UPDATE spatial_layers 
      SET style_config = $1, updated_at = NOW()
      WHERE table_name = $2
      RETURNING *
    `
    
    const result = await this.pool.query(updateQuery, [template.parsed_config, layerId])
    
    if (result.rows.length === 0) {
      throw new Error('Layer not found')
    }
    
    return result.rows[0]
  }

  /**
   * Export QML template as JSON
   */
  async exportQmlTemplate(id) {
    const template = await this.getQmlTemplate(id)
    
    return {
      id: template.id,
      name: template.name,
      description: template.description,
      style_type: template.style_type,
      parsed_config: template.parsed_config,
      created_at: template.created_at,
      created_by: template.created_by
    }
  }

  /**
   * Import QML template from JSON
   */
  async importQmlTemplate(templateData, createdBy) {
    const {
      name,
      description,
      qml_content,
      style_type
    } = templateData
    
    if (!name || !qml_content || !style_type) {
      throw new Error('Missing required fields: name, qml_content, style_type')
    }
    
    return await this.createQmlTemplate(name, description, qml_content, style_type, createdBy)
  }
}

module.exports = { QmlParserService }
