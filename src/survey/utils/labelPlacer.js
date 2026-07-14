/**
 * Label Placer
 * Adaptive label placement for survey plans
 * Handles small parcels, concave shapes, collision detection
 */

/**
 * Calculate parcel centroid
 * 
 * @param {Array} vertices - Parcel vertices
 * @returns {Object} Centroid {x, y}
 */
export function calculateCentroid(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3) {
    throw new Error('Vertices must be an array with at least 3 points')
  }
  
  let sumX = 0
  let sumY = 0
  let area = 0
  
  for (let i = 0; i < vertices.length; i++) {
    const j = (i + 1) % vertices.length
    const xi = vertices[i].x
    const yi = vertices[i].y
    const xj = vertices[j].x
    const yj = vertices[j].y
    
    const cross = xi * yj - xj * yi
    area += cross
    sumX += (xi + xj) * cross
    sumY += (yi + yj) * cross
  }
  
  area = area / 2
  
  if (Math.abs(area) < 0.0001) {
    // Degenerate polygon, use simple average
    const avgX = vertices.reduce((sum, v) => sum + v.x, 0) / vertices.length
    const avgY = vertices.reduce((sum, v) => sum + v.y, 0) / vertices.length
    return { x: avgX, y: avgY }
  }
  
  return {
    x: sumX / (6 * area),
    y: sumY / (6 * area)
  }
}

/**
 * Check if point is inside polygon
 * 
 * @param {Object} point - Point {x, y}
 * @param {Array} vertices - Polygon vertices
 * @returns {boolean} True if inside
 */
export function isPointInPolygon(point, vertices) {
  if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
    throw new Error('Point must have x and y coordinates')
  }
  
  if (!Array.isArray(vertices) || vertices.length < 3) {
    return false
  }
  
  let inside = false
  
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].x
    const yi = vertices[i].y
    const xj = vertices[j].x
    const yj = vertices[j].y
    
    const intersect = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)
    
    if (intersect) inside = !inside
  }
  
  return inside
}

/**
 * Find optimal label position for parcel
 * 
 * @param {Object} parcel - Parcel with vertices
 * @param {Object} options - Placement options
 * @returns {Object} Label position and metadata
 */
export function findLabelPosition(parcel, options = {}) {
  if (!parcel || !parcel.vertices || parcel.vertices.length < 3) {
    throw new Error('Parcel must have at least 3 vertices')
  }
  
  const {
    minFontSize = 2.5,  // mm
    maxFontSize = 4.0,  // mm
    preferredFontSize = 3.0,  // mm
    padding = 1.0  // mm
  } = options
  
  // Calculate centroid
  const centroid = calculateCentroid(parcel.vertices)
  
  // Check if centroid is inside parcel
  const centroidInside = isPointInPolygon(centroid, parcel.vertices)
  
  // Calculate parcel dimensions
  const bounds = calculateBounds(parcel.vertices)
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const area = calculatePolygonArea(parcel.vertices)
  
  // Determine placement strategy based on parcel size
  let position, strategy, fontSize
  
  if (centroidInside && width > 10 && height > 10) {
    // Normal case: centroid inside, parcel large enough
    position = centroid
    strategy = 'centroid'
    fontSize = preferredFontSize
  } else if (centroidInside) {
    // Centroid inside but parcel small
    position = centroid
    strategy = 'centroid-small'
    fontSize = Math.max(minFontSize, Math.min(maxFontSize, width / 20))
  } else {
    // Concave parcel: centroid outside
    // Find pole of inaccessibility (point farthest from edges)
    position = findPoleOfInaccessibility(parcel.vertices)
    strategy = 'pole'
    fontSize = preferredFontSize
  }
  
  return {
    x: position.x,
    y: position.y,
    fontSize,
    strategy,
    rotation: 0,  // Could be enhanced for narrow parcels
    bounds,
    area,
    metadata: {
      centroid,
      centroidInside,
      width,
      height
    }
  }
}

/**
 * Calculate polygon bounds
 * 
 * @param {Array} vertices - Vertices
 * @returns {Object} Bounds {minX, maxX, minY, maxY}
 */
export function calculateBounds(vertices) {
  if (!Array.isArray(vertices) || vertices.length === 0) {
    throw new Error('Vertices must be a non-empty array')
  }
  
  const xs = vertices.map(v => v.x)
  const ys = vertices.map(v => v.y)
  
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys)
  }
}

/**
 * Calculate polygon area (signed)
 * 
 * @param {Array} vertices - Vertices
 * @returns {number} Area
 */
export function calculatePolygonArea(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3) {
    return 0
  }
  
  let area = 0
  
  for (let i = 0; i < vertices.length; i++) {
    const j = (i + 1) % vertices.length
    area += vertices[i].x * vertices[j].y
    area -= vertices[j].x * vertices[i].y
  }
  
  return Math.abs(area / 2)
}

/**
 * Signed distance from point (px, py) to polygon boundary.
 * Positive = inside, negative = outside.
 * @param {number} px
 * @param {number} py
 * @param {Array<{x:number,y:number}>} vertices
 * @returns {number}
 */
function _pointToPolygonDist(px, py, vertices) {
  let minDist = Infinity
  let inside = false
  const n = vertices.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = vertices[i].x, yi = vertices[i].y
    const xj = vertices[j].x, yj = vertices[j].y
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside
    }
    const dx = xj - xi, dy = yj - yi
    const lenSq = dx * dx + dy * dy
    const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - xi) * dx + (py - yi) * dy) / lenSq)) : 0
    const nearX = xi + t * dx, nearY = yi + t * dy
    const d = Math.sqrt((px - nearX) ** 2 + (py - nearY) ** 2)
    if (d < minDist) minDist = d
  }
  return inside ? minDist : -minDist
}

/**
 * Find pole of inaccessibility — the widest interior point, furthest from all polygon edges.
 * Uses iterative grid-refinement (Mapbox polylabel approach).
 *
 * @param {Array<{x:number,y:number}>} vertices - Open polygon ring (no closing duplicate)
 * @param {number} [precision=0.5] - Stop refining when cell half-size is below this value
 * @returns {{x:number, y:number}}
 */
export function findPoleOfInaccessibility(vertices, precision = 0.5) {
  if (!Array.isArray(vertices) || vertices.length < 3) {
    throw new Error('Vertices must be an array with at least 3 points')
  }

  // Bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const v of vertices) {
    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x
    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y
  }
  const w = maxX - minX, h = maxY - minY
  if (w === 0 && h === 0) return { x: minX, y: minY }

  const cellH = Math.min(w, h)

  // Seed with centroid as initial best
  const cx0 = vertices.reduce((s, v) => s + v.x, 0) / vertices.length
  const cy0 = vertices.reduce((s, v) => s + v.y, 0) / vertices.length
  let best = { x: cx0, y: cy0, d: _pointToPolygonDist(cx0, cy0, vertices) }

  // Initial grid — covers bounding box
  const cells = []
  for (let x = minX + cellH / 2; x < maxX; x += cellH) {
    for (let y = minY + cellH / 2; y < maxY; y += cellH) {
      const d = _pointToPolygonDist(x, y, vertices)
      cells.push({ x, y, h: cellH, d })
      if (d > best.d) best = { x, y, d }
    }
  }

  // Iterative refinement — split most-promising cells
  cells.sort((a, b) => b.d - a.d)
  for (let iter = 0; iter < 200 && cells.length > 0; iter++) {
    const cell = cells.shift()
    if (cell.d > best.d) best = { x: cell.x, y: cell.y, d: cell.d }
    if (cell.h / 2 < precision) continue
    // Prune: max possible improvement from this cell
    if (cell.d + cell.h * 0.7072 <= best.d) continue
    const h2 = cell.h / 2
    for (const [ox, oy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const nx = cell.x + ox * h2 / 2
      const ny = cell.y + oy * h2 / 2
      const nd = _pointToPolygonDist(nx, ny, vertices)
      cells.push({ x: nx, y: ny, h: h2, d: nd })
    }
    cells.sort((a, b) => b.d - a.d)
  }

  return { x: best.x, y: best.y }
}

/**
 * Check if two labels collide
 * 
 * @param {Object} label1 - First label
 * @param {Object} label2 - Second label
 * @param {number} padding - Padding in mm
 * @returns {boolean} True if collision
 */
export function checkLabelCollision(label1, label2, padding = 1.0) {
  if (!label1 || !label2) {
    return false
  }
  
  // Estimate label dimensions based on font size
  const width1 = (label1.text?.length || 4) * (label1.fontSize || 3) * 0.6
  const height1 = (label1.fontSize || 3) * 1.2
  
  const width2 = (label2.text?.length || 4) * (label2.fontSize || 3) * 0.6
  const height2 = (label2.fontSize || 3) * 1.2
  
  // Check bounding box collision with padding
  const box1 = {
    minX: label1.x - width1 / 2 - padding,
    maxX: label1.x + width1 / 2 + padding,
    minY: label1.y - height1 / 2 - padding,
    maxY: label1.y + height1 / 2 + padding
  }
  
  const box2 = {
    minX: label2.x - width2 / 2 - padding,
    maxX: label2.x + width2 / 2 + padding,
    minY: label2.y - height2 / 2 - padding,
    maxY: label2.y + height2 / 2 + padding
  }
  
  return !(box1.maxX < box2.minX || 
           box1.minX > box2.maxX || 
           box1.maxY < box2.minY || 
           box1.minY > box2.maxY)
}

/**
 * Place labels for multiple parcels with collision avoidance
 * 
 * @param {Array} parcels - Parcels
 * @param {Object} options - Options
 * @returns {Array} Label placements
 */
export function placeLabels(parcels, options = {}) {
  if (!Array.isArray(parcels)) {
    throw new Error('Parcels must be an array')
  }
  
  const labels = []
  
  parcels.forEach(parcel => {
    const label = findLabelPosition(parcel, options)
    label.text = parcel.stand || parcel.name || ''
    label.parcel = parcel.stand || parcel.name
    
    // Check for collisions with existing labels
    let hasCollision = false
    for (const existingLabel of labels) {
      if (checkLabelCollision(label, existingLabel, options.padding)) {
        hasCollision = true
        break
      }
    }
    
    label.hasCollision = hasCollision
    labels.push(label)
  })
  
  return labels
}
