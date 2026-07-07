/**
 * Survey Analyzer
 * Analyzes survey data to determine extent, density, and parcel statistics
 */

/**
 * Analyze survey data to extract key metrics
 * 
 * @param {Array} coordinatePoints - Array of coordinate points with x, y properties
 * @param {Array} parcels - Array of parcels with area_m2 property
 * @returns {Object} Analysis results
 */
export function analyzeSurvey(coordinatePoints, parcels = []) {
  if (!Array.isArray(coordinatePoints) || coordinatePoints.length === 0) {
    throw new Error('Coordinate points must be a non-empty array')
  }
  
  if (!Array.isArray(parcels)) {
    throw new Error('Parcels must be an array')
  }
  
  // Calculate extent
  const extent = calculateExtent(coordinatePoints)
  
  // Calculate point density
  const density = calculateDensity(coordinatePoints, extent)
  
  // Analyze parcels
  const parcelAnalysis = parcels.length > 0 
    ? analyzeParcels(parcels) 
    : null
  
  return {
    extent,
    density,
    parcels: parcelAnalysis,
    summary: generateSummary(extent, density, parcelAnalysis)
  }
}

/**
 * Calculate survey extent (bounding box)
 * 
 * @param {Array} points - Coordinate points
 * @returns {Object} Extent with min/max coordinates and dimensions
 */
export function calculateExtent(points) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error('Points must be a non-empty array')
  }
  
  const xs = points.map(p => {
    if (typeof p.x !== 'number' || isNaN(p.x)) {
      throw new Error('All points must have valid x coordinate')
    }
    return p.x
  })
  
  const ys = points.map(p => {
    if (typeof p.y !== 'number' || isNaN(p.y)) {
      throw new Error('All points must have valid y coordinate')
    }
    return p.y
  })
  
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  
  const width = maxX - minX
  const height = maxY - minY
  const area = width * height
  
  return {
    minX,
    maxX,
    minY,
    maxY,
    width,
    height,
    area,
    center: {
      x: (minX + maxX) / 2,
      y: (minY + maxY) / 2
    }
  }
}

/**
 * Calculate point density metrics
 * 
 * @param {Array} points - Coordinate points
 * @param {Object} extent - Survey extent
 * @returns {Object} Density metrics
 */
export function calculateDensity(points, extent) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error('Points must be a non-empty array')
  }
  
  if (!extent || typeof extent.area !== 'number') {
    throw new Error('Extent must have valid area')
  }
  
  const totalPoints = points.length
  const areaHectares = extent.area / 10000
  const pointsPerHectare = areaHectares > 0 ? totalPoints / areaHectares : 0
  const averageSpacing = extent.area > 0 ? Math.sqrt(extent.area / totalPoints) : 0
  
  // Categorize density
  let category
  if (pointsPerHectare > 100) {
    category = 'very-dense'
  } else if (pointsPerHectare > 50) {
    category = 'dense'
  } else if (pointsPerHectare > 20) {
    category = 'medium'
  } else {
    category = 'sparse'
  }
  
  return {
    totalPoints,
    pointsPerHectare: Math.round(pointsPerHectare * 100) / 100,
    averageSpacing: Math.round(averageSpacing * 100) / 100,
    category,
    description: getDensityDescription(category)
  }
}

/**
 * Analyze parcel statistics
 * 
 * @param {Array} parcels - Array of parcels
 * @returns {Object} Parcel statistics
 */
export function analyzeParcels(parcels) {
  if (!Array.isArray(parcels) || parcels.length === 0) {
    throw new Error('Parcels must be a non-empty array')
  }
  
  const areas = parcels.map(p => {
    if (typeof p.area_m2 !== 'number' || isNaN(p.area_m2) || p.area_m2 < 0) {
      throw new Error('All parcels must have valid area_m2')
    }
    return p.area_m2
  })
  
  const count = parcels.length
  const totalArea = areas.reduce((sum, a) => sum + a, 0)
  const averageArea = totalArea / count
  const smallestParcel = Math.min(...areas)
  const largestParcel = Math.max(...areas)
  
  // Calculate median
  const sortedAreas = [...areas].sort((a, b) => a - b)
  const median = count % 2 === 0
    ? (sortedAreas[count / 2 - 1] + sortedAreas[count / 2]) / 2
    : sortedAreas[Math.floor(count / 2)]
  
  return {
    count,
    totalArea,
    averageArea: Math.round(averageArea * 100) / 100,
    medianArea: Math.round(median * 100) / 100,
    smallestParcel: Math.round(smallestParcel * 100) / 100,
    largestParcel: Math.round(largestParcel * 100) / 100,
    range: Math.round((largestParcel - smallestParcel) * 100) / 100
  }
}

/**
 * Get density description
 * 
 * @param {string} category - Density category
 * @returns {string} Description
 */
function getDensityDescription(category) {
  const descriptions = {
    'very-dense': 'Very dense urban subdivision with many survey points',
    'dense': 'Dense subdivision typical of urban areas',
    'medium': 'Medium density typical of peri-urban areas',
    'sparse': 'Sparse distribution typical of rural areas'
  }
  return descriptions[category] || 'Unknown density'
}

/**
 * Generate summary text
 * 
 * @param {Object} extent - Survey extent
 * @param {Object} density - Point density
 * @param {Object} parcels - Parcel analysis
 * @returns {string} Summary text
 */
function generateSummary(extent, density, parcels) {
  const parts = []
  
  // Extent summary
  parts.push(`Survey extent: ${Math.round(extent.width)}m × ${Math.round(extent.height)}m`)
  parts.push(`Total area: ${(extent.area / 10000).toFixed(2)} ha`)
  
  // Density summary
  parts.push(`${density.totalPoints} survey points (${density.category})`)
  parts.push(`Density: ${density.pointsPerHectare} points/ha`)
  
  // Parcel summary
  if (parcels) {
    parts.push(`${parcels.count} parcels`)
    parts.push(`Average parcel size: ${(parcels.averageArea / 10000).toFixed(4)} ha`)
  }
  
  return parts.join(', ')
}
