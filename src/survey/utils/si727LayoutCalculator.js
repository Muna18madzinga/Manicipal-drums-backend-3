/**
 * SI 727 Layout Calculator
 * Calculates compliant sheet layouts for general plans
 */

import { SI727_SHEET_SIZES, SI727_MARGINS, LAYOUT_COMPONENTS } from './si727Constants.js'

/**
 * Calculate SI 727 compliant sheet layout
 * @param {string} sheetSize - 'ISO_A2', 'ISO_A1', or 'ISO_A0'
 * @param {number} parcelCount - Number of parcels
 * @param {number} beaconExceptionCount - Number of beacon exceptions
 * @returns {Object} Complete layout specification
 */
export function calculateSI727Layout(sheetSize, parcelCount = 0, beaconExceptionCount = 0) {
  const sheet = SI727_SHEET_SIZES.find(s => s.name === sheetSize)
  if (!sheet) {
    throw new Error(`Invalid sheet size: ${sheetSize}. Must be 'ISO_A2', 'ISO_A1', or 'ISO_A0'`)
  }
  
  const margins = SI727_MARGINS
  
  // Title block height based on sheet size
  const titleBlockHeight = sheetSize === 'ISO_A0' 
    ? LAYOUT_COMPONENTS.titleBlock.heightLarge
    : sheetSize === 'ISO_A1'
    ? LAYOUT_COMPONENTS.titleBlock.heightMedium
    : LAYOUT_COMPONENTS.titleBlock.heightSmall
  
  // Beacon descriptions height (adaptive but capped)
  const beaconDescHeight = Math.min(
    LAYOUT_COMPONENTS.beaconDescriptions.minHeight + 
    (beaconExceptionCount * LAYOUT_COMPONENTS.beaconDescriptions.lineHeight),
    80  // Cap at 80mm
  )
  
  // Schedule height (adaptive but capped)
  const scheduleHeight = Math.min(
    LAYOUT_COMPONENTS.scheduleOfAreas.minHeight + 
    (Math.max(0, parcelCount - 2) * LAYOUT_COMPONENTS.scheduleOfAreas.rowHeight),
    100  // Cap at 100mm
  )
  
  // Title block
  const titleBlock = {
    x: margins.left,
    y: margins.top,
    width: sheet.width - margins.left - margins.right,
    height: titleBlockHeight
  }
  
  // Calculate total bottom components height
  const bottomComponentsHeight = beaconDescHeight + LAYOUT_COMPONENTS.scaleBar.height + scheduleHeight
  const spacing = 20  // Total spacing between components
  
  // Drawing area (largest possible)
  const drawingArea = {
    x: margins.left,
    y: margins.top + titleBlockHeight + 5,
    width: sheet.width - margins.left - margins.right,
    height: sheet.height - margins.top - margins.bottom - titleBlockHeight - bottomComponentsHeight - spacing
  }
  
  // Beacon descriptions
  const beaconDescriptions = {
    x: margins.left,
    y: drawingArea.y + drawingArea.height + 10,
    width: drawingArea.width,
    height: beaconDescHeight
  }
  
  // Scale bar
  const scaleBar = {
    x: margins.left,
    y: beaconDescriptions.y + beaconDescriptions.height + 10,
    width: LAYOUT_COMPONENTS.scaleBar.width,
    height: LAYOUT_COMPONENTS.scaleBar.height
  }
  
  // Schedule of areas
  const scheduleOfAreas = {
    x: margins.left,
    y: scaleBar.y + scaleBar.height + 10,
    width: LAYOUT_COMPONENTS.scheduleOfAreas.width,
    height: scheduleHeight
  }
  
  // North arrow
  const northArrow = {
    x: drawingArea.x + drawingArea.width - 50,
    y: drawingArea.y + 50,
    size: LAYOUT_COMPONENTS.northArrow.size
  }
  
  // Key plan inset (for multi-sheet)
  const keyPlanInset = {
    x: sheet.width - margins.right - LAYOUT_COMPONENTS.keyPlanInset.size - 10,
    y: beaconDescriptions.y,
    width: LAYOUT_COMPONENTS.keyPlanInset.size,
    height: LAYOUT_COMPONENTS.keyPlanInset.size
  }
  
  return {
    sheet: { width: sheet.width, height: sheet.height, name: sheet.name, code: sheet.code },
    margins: { ...margins },  // Return a copy, not reference
    titleBlock,
    drawingArea,
    beaconDescriptions,
    scaleBar,
    scheduleOfAreas,
    northArrow,
    keyPlanInset
  }
}

/**
 * Calculate real-world dimensions at scale
 * @param {Object} layout - Layout from calculateSI727Layout
 * @param {number} scale - Scale denominator (e.g., 1000 for 1:1000)
 * @returns {Object} Real-world dimensions
 */
export function calculateRealWorldDimensions(layout, scale) {
  const { drawingArea } = layout
  
  return {
    widthMeters: (drawingArea.width / 1000) * scale,
    heightMeters: (drawingArea.height / 1000) * scale,
    areaHectares: ((drawingArea.width / 1000) * scale * (drawingArea.height / 1000) * scale) / 10000
  }
}

/**
 * Determine optimal sheet size for survey extent
 * @param {Object} extent - Survey extent { width, height } in meters
 * @param {number} scale - Scale denominator
 * @param {number} parcelCount - Number of parcels
 * @returns {Object} Recommended sheet size and analysis
 */
export function determineOptimalSheetSize(extent, scale, parcelCount = 0, beaconCount = 0) {
  const requiredWidthMM = (extent.width / scale) * 1000
  const requiredHeightMM = (extent.height / scale) * 1000
  
  const results = []
  
  // PREMIUM QUALITY: Evaluate A2, A1, A0 in order of preference
  for (const sheetSize of ['ISO_A2', 'ISO_A1', 'ISO_A0']) {
    const layout = calculateSI727Layout(sheetSize, parcelCount, 0)
    const { drawingArea } = layout
    
    const fitsWidth = requiredWidthMM <= drawingArea.width
    const fitsHeight = requiredHeightMM <= drawingArea.height
    const fits = fitsWidth && fitsHeight
    
    const utilization = Math.max(
      (requiredWidthMM / drawingArea.width) * 100,
      (requiredHeightMM / drawingArea.height) * 100
    )
    
    results.push({
      sheetSize,
      fits,
      utilization: Math.min(100, utilization),
      drawingArea: { width: drawingArea.width, height: drawingArea.height },
      required: { width: requiredWidthMM, height: requiredHeightMM }
    })
  }
  
  // Pick the smallest sheet whose drawing area geometrically fits the mapped extent.
  // The `fits` flag already accounts for scale, so raw ground-distance or beacon-count
  // heuristics are not needed and cause incorrect A0 selection for moderate extents.
  const fitting = results.filter(r => r.fits)

  let recommended
  if (fitting.length === 0) {
    // Mapped extent exceeds even A0 - use A0 (largest available)
    recommended = results[results.length - 1]
  } else {
    // Pick smallest fitting sheet (results are ordered A2 → A1 → A0)
    recommended = fitting[0]
  }
  
  return {
    recommended: recommended.sheetSize,
    requiresMultiSheet: !recommended.fits,
    analysis: results,
    utilization: recommended.utilization
  }
}

/**
 * Validate layout against SI 727 requirements
 * @param {Object} layout - Layout from calculateSI727Layout
 * @returns {Object} Validation result
 */
export function validateSI727Layout(layout) {
  const errors = []
  const warnings = []
  
  // Check margins (Regulation 63)
  if (layout.margins.left !== 50) errors.push(`Left margin must be 50mm`)
  if (layout.margins.right !== 150) errors.push(`Right margin must be 150mm`)
  if (layout.margins.top !== 50) errors.push(`Top margin must be 50mm`)
  if (layout.margins.bottom !== 50) errors.push(`Bottom margin must be 50mm`)
  
  // Check sheet size (Regulation 62)
  const validSizes = SI727_SHEET_SIZES.map(s => `${s.width}x${s.height}`)
  const currentSize = `${layout.sheet.width}x${layout.sheet.height}`
  if (!validSizes.includes(currentSize)) {
    errors.push(`Invalid sheet size ${currentSize}`)
  }
  
  // Check drawing area
  if (layout.drawingArea.width <= 0 || layout.drawingArea.height <= 0) {
    errors.push(`Invalid drawing area dimensions`)
  }
  
  // Warnings
  if (layout.drawingArea.width < 200) warnings.push(`Drawing area width very small`)
  if (layout.drawingArea.height < 200) warnings.push(`Drawing area height very small`)
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    compliance: {
      regulation62: validSizes.includes(currentSize),
      regulation63: layout.margins.left === 50 && layout.margins.right === 150
    }
  }
}
