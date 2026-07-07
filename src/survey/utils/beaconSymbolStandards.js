/**
 * Professional Beacon Symbol Standards
 * Based on surveying and cartographic best practices
 * 
 * References:
 * - SI 727 of 1979 (Zimbabwe Land Survey Regulations)
 * - ISO 19117:2012 (Portrayal - Geographic Information)
 * - ICSM Cadastral Survey Guidelines (Australia)
 * - UK Ordnance Survey Symbol Specifications
 * - ASPRS Cartographic Standards
 */

/**
 * PROFESSIONAL SURVEYING STANDARDS FOR BEACON SYMBOLS
 * 
 * Key Principles:
 * 1. Symbols must be clearly visible at all standard scales
 * 2. Symbol size should be scale-dependent but maintain minimum legibility
 * 3. Different beacon types must be instantly distinguishable
 * 4. Symbols must not obscure detail when clustered
 * 5. Print output must be crisp and professional
 * 6. Digital display must be clear at various zoom levels
 */

/**
 * Beacon Symbol Specifications
 * 
 * PLACED BEACONS (New/Proposed): Open Circle ○
 * - Represents newly placed survey marks
 * - Hollow circle to indicate "not yet found"
 * - Clear distinction from existing marks
 * 
 * FOUND BEACONS (Existing): Circle with Dot ⊙
 * - Represents existing/recovered survey marks
 * - Filled center indicates "confirmed found"
 * - Standard cadastral convention
 */

/**
 * Calculate optimal beacon symbol size based on scale and sheet size
 * 
 * Professional Standards:
 * - At 1:1000 scale: 2.0mm diameter (represents 2m on ground)
 * - At 1:500 scale: 1.5mm diameter (represents 0.75m on ground)
 * - At 1:2500 scale: 2.5mm diameter (represents 6.25m on ground)
 * - Minimum size: 1.2mm (for legibility)
 * - Maximum size: 4.0mm (to avoid obscuring detail)
 * 
 * @param {number} scale - Map scale (e.g., 1000 for 1:1000)
 * @param {string} sheetSize - 'Small', 'Medium', or 'Large'
 * @param {string} outputFormat - 'screen', 'pdf', 'print'
 * @returns {Object} Symbol specifications in mm
 */
export function calculateBeaconSymbolSize(scale, sheetSize = 'Medium', outputFormat = 'screen') {
  // Base size calculation: scale-dependent
  // Formula: baseDiameter = 2.0mm at 1:1000, scales proportionally
  const baseScale = 1000
  const baseDiameter = 2.0 // mm at 1:1000
  
  // Calculate scale-dependent diameter
  let diameter = baseDiameter * Math.sqrt(scale / baseScale)
  
  // Apply sheet size factor (larger sheets can use slightly larger symbols)
  const sheetFactor = {
    'Small': 0.9,
    'Medium': 1.0,
    'Large': 1.1
  }[sheetSize] || 1.0
  
  diameter *= sheetFactor
  
  // Apply output format factor
  const formatFactor = {
    'screen': 1.0,      // Screen display
    'pdf': 1.0,         // PDF export
    'print': 1.1,       // Print output (slightly larger for clarity)
    'dwg': 1.0,         // AutoCAD DWG
    'svg': 1.0          // SVG vector
  }[outputFormat] || 1.0
  
  diameter *= formatFactor
  
  // Clamp to professional limits
  const minDiameter = 1.2  // Minimum for legibility
  const maxDiameter = 4.0  // Maximum to avoid obscuring detail
  diameter = Math.max(minDiameter, Math.min(maxDiameter, diameter))
  
  // Calculate derived dimensions
  const outerDiameter = diameter
  const strokeWidth = Math.max(0.15, diameter * 0.075) // 7.5% of diameter, min 0.15mm
  const innerDotDiameter = diameter * 0.35 // 35% of outer diameter for found beacons
  
  return {
    outerDiameter,      // Outer circle diameter (mm)
    strokeWidth,        // Line width for circle (mm)
    innerDotDiameter,   // Inner dot diameter for found beacons (mm)
    scale,              // Reference scale
    sheetSize,          // Reference sheet size
    outputFormat        // Reference output format
  }
}

/**
 * Calculate beacon label size based on scale and sheet size
 * 
 * Professional Standards:
 * - Labels must be readable but not dominate the plan
 * - Font size should scale with map scale
 * - Minimum: 2.0mm (7pt) for legibility
 * - Maximum: 5.0mm (14pt) to avoid clutter
 * 
 * @param {number} scale - Map scale
 * @param {string} sheetSize - Sheet size
 * @param {string} outputFormat - Output format
 * @returns {Object} Label specifications
 */
export function calculateBeaconLabelSize(scale, sheetSize = 'Medium', outputFormat = 'screen') {
  // Base size: 2.5mm at 1:1000
  const baseScale = 1000
  const baseHeight = 2.5 // mm
  
  // Scale-dependent height
  let height = baseHeight * Math.sqrt(scale / baseScale)
  
  // Sheet size factor
  const sheetFactor = {
    'Small': 0.9,
    'Medium': 1.0,
    'Large': 1.1
  }[sheetSize] || 1.0
  
  height *= sheetFactor
  
  // Output format factor
  const formatFactor = {
    'screen': 1.0,
    'pdf': 1.0,
    'print': 1.05,
    'dwg': 1.0,
    'svg': 1.0
  }[outputFormat] || 1.0
  
  height *= formatFactor
  
  // Clamp to professional limits
  const minHeight = 2.0  // 7pt
  const maxHeight = 5.0  // 14pt
  height = Math.max(minHeight, Math.min(maxHeight, height))
  
  return {
    height,             // Text height (mm)
    weight: 'bold',     // Font weight
    haloWidth: height * 0.15, // White halo for readability
    scale,
    sheetSize,
    outputFormat
  }
}

/**
 * Get beacon symbol specifications for common scales
 * Pre-calculated for quick reference
 */
export const BEACON_SYMBOL_PRESETS = {
  // Detailed scales (1:100 - 1:500)
  detailed: {
    scales: [100, 125, 150, 200, 250, 300, 400, 500],
    symbol: { outerDiameter: 1.2, strokeWidth: 0.15, innerDotDiameter: 0.42 },
    label: { height: 2.0, weight: 'bold', haloWidth: 0.3 }
  },
  
  // Base scales (1:1000 - 1:2500)
  base: {
    scales: [1000, 1250, 1500, 2000, 2500],
    symbol: { outerDiameter: 2.0, strokeWidth: 0.15, innerDotDiameter: 0.7 },
    label: { height: 2.5, weight: 'bold', haloWidth: 0.375 }
  },
  
  // Medium scales (1:3000 - 1:7500)
  medium: {
    scales: [3000, 4000, 5000, 6000, 7500],
    symbol: { outerDiameter: 2.8, strokeWidth: 0.21, innerDotDiameter: 0.98 },
    label: { height: 3.2, weight: 'bold', haloWidth: 0.48 }
  },
  
  // Regional scales (1:10000+)
  regional: {
    scales: [10000, 12500, 15000, 20000, 25000],
    symbol: { outerDiameter: 3.5, strokeWidth: 0.26, innerDotDiameter: 1.225 },
    label: { height: 4.0, weight: 'bold', haloWidth: 0.6 }
  }
}

/**
 * Convert mm to pixels for screen display
 * Assumes standard 96 DPI (CSS pixels)
 * 
 * @param {number} mm - Size in millimeters
 * @param {number} dpi - Dots per inch (default: 96)
 * @returns {number} Size in pixels
 */
export function mmToPixels(mm, dpi = 96) {
  const mmPerInch = 25.4
  return (mm / mmPerInch) * dpi
}

/**
 * Convert mm to points for PDF/print
 * 1 point = 1/72 inch
 * 
 * @param {number} mm - Size in millimeters
 * @returns {number} Size in points
 */
export function mmToPoints(mm) {
  const mmPerInch = 25.4
  const pointsPerInch = 72
  return (mm / mmPerInch) * pointsPerInch
}

/**
 * Get MapLibre GL zoom-based symbol sizing
 * Adapts symbol size based on zoom level for optimal display
 * 
 * @param {Object} symbolSpec - Symbol specifications in mm
 * @param {number} mapScale - Current map scale
 * @returns {Array} MapLibre GL interpolation expression
 */
export function getMapLibreSymbolSizing(symbolSpec, mapScale) {
  // Convert mm to pixels at standard zoom levels
  const basePixels = mmToPixels(symbolSpec.outerDiameter)
  
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    12, basePixels * 0.6,   // Zoomed out: smaller
    14, basePixels * 0.8,
    16, basePixels * 1.0,   // Base size
    18, basePixels * 1.2,
    20, basePixels * 1.5    // Zoomed in: larger
  ]
}

/**
 * Professional color specifications for beacon symbols
 */
export const BEACON_COLORS = {
  placed: {
    stroke: '#000000',      // Black outline
    fill: 'transparent',    // Hollow
    label: '#1e293b'        // Dark gray label
  },
  found: {
    stroke: '#000000',      // Black outline
    fill: '#000000',        // Black center dot
    label: '#1e293b'        // Dark gray label
  }
}

/**
 * Export format recommendations
 */
export const EXPORT_RECOMMENDATIONS = {
  pdf: {
    description: 'Professional PDF for printing and archival',
    symbolFormat: 'vector',
    minResolution: 300, // DPI
    colorSpace: 'CMYK',
    embedFonts: true
  },
  dwg: {
    description: 'AutoCAD DWG for CAD workflows',
    symbolFormat: 'block',
    layerNaming: 'BEACON-PLACED, BEACON-FOUND',
    units: 'millimeters'
  },
  svg: {
    description: 'Scalable Vector Graphics for web/print',
    symbolFormat: 'path',
    precision: 3, // decimal places
    embedStyles: true
  },
  png: {
    description: 'Raster image for presentations',
    symbolFormat: 'raster',
    minResolution: 300, // DPI
    antialiasing: true
  }
}
