/**
 * Scale Selector
 * Intelligently recommends optimal scale based on survey analysis
 */

import { SI727_PRESCRIBED_SCALES, MIN_FIGURE_SIZE_MM2 } from './si727Constants.js'

/**
 * Determine optimal scale for survey
 * 
 * @param {Object} analysis - Survey analysis from surveyAnalyzer
 * @param {string} areaType - 'urban', 'peri-urban', or 'rural'
 * @returns {Object} Scale recommendation
 */
export function determineOptimalScale(analysis, areaType = 'urban') {
  if (!analysis || !analysis.extent) {
    throw new Error('Analysis must include extent data')
  }
  
  const validAreaTypes = ['urban', 'peri-urban', 'rural']
  if (!validAreaTypes.includes(areaType)) {
    throw new Error(`Area type must be one of: ${validAreaTypes.join(', ')}`)
  }
  
  const { extent, density } = analysis
  
  // Step 1: Calculate minimum scale for SI 727 figure size (650mm²)
  const minScaleForSize = calculateMinimumScaleForFigureSize(extent)
  
  // Step 2: Calculate minimum scale for legibility
  const minScaleForLegibility = calculateMinimumScaleForLegibility(density)
  
  // Step 3: Overall minimum scale must satisfy BOTH the SI 727 minimum figure
  // size (650mm²) and the legibility constraint — take the more restrictive
  // (larger) denominator so neither is violated.
  const minScale = Math.max(minScaleForSize, minScaleForLegibility)

  console.log('[ScaleSelector] 📊 Scale calculation:', {
    minScaleForSize: minScaleForSize.toFixed(0),
    minScaleForLegibility: minScaleForLegibility.toFixed(0),
    minScaleUsed: minScale.toFixed(0),
    note: 'Using the larger of figure-size and legibility constraints'
  })
  
  // Step 4: Filter all SI 727 scales that satisfy the minimum
  const validScales = SI727_PRESCRIBED_SCALES.filter(s => s.value >= minScale)
  
  if (validScales.length === 0) {
    // minScale exceeds every prescribed scale — use the largest available
    const largest = SI727_PRESCRIBED_SCALES[SI727_PRESCRIBED_SCALES.length - 1]
    return {
      recommended: largest,
      alternatives: [],
      requiresMultiSheet: true,
      reasoning: `Survey requires scale larger than ${largest.label}. A multi-sheet plan is recommended.`,
      minScale,
      minScaleForSize,
      minScaleForLegibility
    }
  }
  
  // Step 5: Select based on area type preferences
  const recommended = selectByAreaType(validScales, areaType)
  
  // Step 6: Provide alternatives
  const alternatives = validScales
    .filter(s => s.value !== recommended.value)
    .slice(0, 3)
  
  return {
    recommended,
    alternatives,
    requiresMultiSheet: false,
    reasoning: generateReasoning(recommended, extent, density, areaType),
    minScale,
    minScaleForSize,
    minScaleForLegibility
  }
}

/**
 * Calculate minimum scale to meet SI 727 minimum figure size
 * 
 * @param {Object} extent - Survey extent
 * @returns {number} Minimum scale denominator
 */
export function calculateMinimumScaleForFigureSize(extent) {
  if (!extent || typeof extent.width !== 'number' || typeof extent.height !== 'number') {
    throw new Error('Extent must have valid width and height')
  }
  
  // Minimum dimension on paper to achieve 650mm² area
  const minDimension = Math.sqrt(MIN_FIGURE_SIZE_MM2)  // ~25.5mm
  
  // Calculate scale needed for each dimension
  const scaleForWidth = (extent.width * 1000) / minDimension
  const scaleForHeight = (extent.height * 1000) / minDimension
  
  // Use the larger (more restrictive) scale
  return Math.max(scaleForWidth, scaleForHeight)
}

/**
 * Calculate minimum scale for legibility based on point density
 * 
 * @param {Object} density - Point density analysis
 * @returns {number} Minimum scale denominator
 */
export function calculateMinimumScaleForLegibility(density) {
  if (!density || typeof density.averageSpacing !== 'number') {
    throw new Error('Density must have valid averageSpacing')
  }
  
  // Minimum label size and spacing on paper
  const minLabelSizeMM = 2.5
  const minLabelSpacingMM = 5
  const totalRequiredMM = minLabelSizeMM + minLabelSpacingMM  // 7.5mm
  
  // Calculate scale needed for average spacing
  const baseScale = (density.averageSpacing * 1000) / totalRequiredMM
  
  // Apply density-based adjustment factors
  let adjustmentFactor
  if (density.category === 'very-dense') {
    adjustmentFactor = 0.7  // Need larger scale (smaller denominator)
  } else if (density.category === 'dense') {
    adjustmentFactor = 1.0
  } else if (density.category === 'medium') {
    adjustmentFactor = 1.3
  } else {
    adjustmentFactor = 1.5
  }
  
  return baseScale * adjustmentFactor
}

/**
 * Select scale based on area type preferences
 * PREMIUM QUALITY: Prioritize larger scales (smaller denominators) for cadastral plans
 * 
 * @param {Array} validScales - Valid SI 727 scales
 * @param {string} areaType - Area type
 * @returns {Object} Selected scale
 */
function selectByAreaType(validScales, areaType) {
  // Preferred scale ranges for cadastral plans by area type
  const preferences = {
    urban: { min: 500, max: 1000, premium: 500 },
    'peri-urban': { min: 1000, max: 2000, premium: 1000 },
    rural: { min: 2000, max: 5000, premium: 2500 }
  }
  
  const pref = preferences[areaType] || preferences['urban']
  
  // First, try the premium scale
  const premiumScale = validScales.find(s => s.value === pref.premium)
  if (premiumScale) return premiumScale
  
  // Second, find scale within preferred range
  const preferred = validScales.find(s => s.value >= pref.min && s.value <= pref.max)
  if (preferred) return preferred
  
  // Fallback: use the smallest valid scale (largest map, most detail)
  return validScales[0]
}

/**
 * Generate reasoning text for scale recommendation
 * 
 * @param {Object} scale - Recommended scale
 * @param {Object} extent - Survey extent
 * @param {Object} density - Point density
 * @param {string} areaType - Area type
 * @returns {string} Reasoning text
 */
function generateReasoning(scale, extent, density, areaType) {
  const parts = []
  
  // Extent
  const extentHa = (extent.area / 10000).toFixed(2)
  parts.push(`Survey extent: ${Math.round(extent.width)}m × ${Math.round(extent.height)}m (${extentHa} ha)`)
  
  // Density
  parts.push(`${density.category} density with ${density.totalPoints} points`)
  
  // Area type
  parts.push(`${areaType} area`)
  
  // Scale selection
  parts.push(`Scale ${scale.label} ensures minimum figure size of 650mm² and adequate label spacing`)
  
  return parts.join('. ') + '.'
}

/**
 * Get all valid scales for a survey
 * 
 * @param {Object} analysis - Survey analysis
 * @returns {Array} Valid scales with metadata
 */
export function getValidScales(analysis) {
  if (!analysis || !analysis.extent || !analysis.density) {
    throw new Error('Analysis must include extent and density data')
  }
  
  // A scale is valid iff the figure it produces meets the SI 727 minimum size
  // (650mm²). This is a per-scale figure-size test — distinct from the legibility
  // constraint used by determineOptimalScale.
  return SI727_PRESCRIBED_SCALES.map(scale => {
    const figureSize = calculateFigureSize(analysis.extent, scale.value)
    const valid = figureSize >= MIN_FIGURE_SIZE_MM2
    return {
      ...scale,
      valid,
      figureSize,
      reason: valid
        ? 'Meets all requirements'
        : `Figure size would be ${figureSize.toFixed(0)}mm² (< 650mm² minimum)`
    }
  })
}

/**
 * Calculate figure size on paper at given scale
 * 
 * @param {Object} extent - Survey extent
 * @param {number} scale - Scale denominator
 * @returns {number} Figure size in mm²
 */
function calculateFigureSize(extent, scale) {
  const widthMM = (extent.width / scale) * 1000
  const heightMM = (extent.height / scale) * 1000
  return widthMM * heightMM
}
