/**
 * Topology Builder
 * Builds topological data structures for survey plans
 * Handles shared beacons, parcel adjacency, and spatial relationships
 */

/**
 * Build topology from parcels and coordinate points
 * 
 * @param {Array} parcels - Array of parcels with geometry
 * @param {Array} coordinatePoints - Array of coordinate points
 * @returns {Object} Topology data structure
 */
export function buildTopology(parcels, coordinatePoints) {
  if (!Array.isArray(parcels) || parcels.length === 0) {
    throw new Error('Parcels must be a non-empty array')
  }
  
  if (!Array.isArray(coordinatePoints) || coordinatePoints.length === 0) {
    throw new Error('Coordinate points must be a non-empty array')
  }
  
  // Build beacon map (shared beacons)
  const beacons = buildBeaconMap(parcels, coordinatePoints)
  
  // Build parcel adjacency
  const adjacency = buildAdjacencyMap(parcels, beacons)
  
  // Build beacon-parcel relationships
  const beaconParcels = buildBeaconParcelMap(beacons, parcels)
  
  return {
    beacons,
    adjacency,
    beaconParcels,
    summary: generateTopologySummary(beacons, adjacency)
  }
}

/**
 * Build beacon map with shared beacon detection
 * 
 * @param {Array} parcels - Parcels
 * @param {Array} coordinatePoints - Coordinate points
 * @returns {Map} Beacon map
 */
export function buildBeaconMap(parcels, coordinatePoints) {
  const beaconMap = new Map()
  
  coordinatePoints.forEach(point => {
    if (!point.name || typeof point.x !== 'number' || typeof point.y !== 'number') {
      throw new Error('All coordinate points must have name, x, and y')
    }
    
    beaconMap.set(point.name, {
      name: point.name,
      x: point.x,
      y: point.y,
      parcels: [],  // Will be populated later
      shared: false,  // Will be determined later
      type: point.type || 'placed'
    })
  })
  
  return beaconMap
}

/**
 * Build adjacency map (which parcels share boundaries)
 * 
 * @param {Array} parcels - Parcels
 * @param {Map} beacons - Beacon map
 * @returns {Map} Adjacency map
 */
export function buildAdjacencyMap(parcels, beacons) {
  const adjacencyMap = new Map()
  const tolerance = 0.001  // Tolerance for coordinate matching (1mm)
  
  parcels.forEach(parcel => {
    if (!parcel.stand) {
      throw new Error('All parcels must have stand property')
    }
    adjacencyMap.set(parcel.stand, new Set())
  })
  
  // Build position-based beacon groups (beacons at same location)
  const positionGroups = new Map()
  
  beacons.forEach((beacon, beaconName) => {
    const key = `${Math.round(beacon.x / tolerance)},${Math.round(beacon.y / tolerance)}`
    
    if (!positionGroups.has(key)) {
      positionGroups.set(key, [])
    }
    positionGroups.get(key).push(beaconName)
  })
  
  // Find shared positions (beacons at same location)
  positionGroups.forEach((beaconNames, positionKey) => {
    // Find all parcels using any beacon at this position
    const parcelsAtPosition = new Set()
    
    beaconNames.forEach(beaconName => {
      parcels.forEach(parcel => {
        if (parcel.vertices && parcel.vertices.some(v => v.name === beaconName)) {
          parcelsAtPosition.add(parcel.stand)
        }
      })
    })
    
    const parcelsArray = Array.from(parcelsAtPosition)
    
    if (parcelsArray.length > 1) {
      // Multiple parcels share this position - mark beacons as shared
      beaconNames.forEach(beaconName => {
        const beacon = beacons.get(beaconName)
        beacon.shared = true
        beacon.parcels = parcelsArray
      })
      
      // Mark parcels as adjacent
      for (let i = 0; i < parcelsArray.length; i++) {
        for (let j = i + 1; j < parcelsArray.length; j++) {
          adjacencyMap.get(parcelsArray[i]).add(parcelsArray[j])
          adjacencyMap.get(parcelsArray[j]).add(parcelsArray[i])
        }
      }
    } else if (parcelsArray.length === 1) {
      // Only one parcel uses this position
      beaconNames.forEach(beaconName => {
        const beacon = beacons.get(beaconName)
        beacon.parcels = parcelsArray
      })
    }
  })
  
  return adjacencyMap
}

/**
 * Build beacon-parcel relationship map
 * 
 * @param {Map} beacons - Beacon map
 * @param {Array} parcels - Parcels
 * @returns {Map} Beacon-parcel map
 */
export function buildBeaconParcelMap(beacons, parcels) {
  const beaconParcelMap = new Map()
  
  beacons.forEach((beacon, beaconName) => {
    beaconParcelMap.set(beaconName, {
      beacon: beaconName,
      parcels: beacon.parcels,
      shared: beacon.shared,
      position: { x: beacon.x, y: beacon.y }
    })
  })
  
  return beaconParcelMap
}

/**
 * Find shared beacons between parcels
 * 
 * @param {Array} parcels - Parcels
 * @param {Map} beacons - Beacon map
 * @returns {Array} Shared beacons
 */
export function findSharedBeacons(parcels, beacons) {
  const shared = []
  
  beacons.forEach((beacon, beaconName) => {
    if (beacon.shared) {
      shared.push({
        name: beaconName,
        x: beacon.x,
        y: beacon.y,
        parcels: beacon.parcels,
        count: beacon.parcels.length
      })
    }
  })
  
  return shared.sort((a, b) => b.count - a.count)
}

/**
 * Get adjacent parcels for a given parcel
 * 
 * @param {string} stand - Stand number
 * @param {Map} adjacency - Adjacency map
 * @returns {Array} Adjacent stand numbers
 */
export function getAdjacentParcels(stand, adjacency) {
  if (!adjacency.has(stand)) {
    return []
  }
  
  return Array.from(adjacency.get(stand))
}

/**
 * Check if two parcels are adjacent
 * 
 * @param {string} stand1 - First stand
 * @param {string} stand2 - Second stand
 * @param {Map} adjacency - Adjacency map
 * @returns {boolean} True if adjacent
 */
export function areAdjacent(stand1, stand2, adjacency) {
  if (!adjacency.has(stand1)) {
    return false
  }
  
  return adjacency.get(stand1).has(stand2)
}

/**
 * Get beacons for a specific parcel
 * 
 * @param {string} stand - Stand number
 * @param {Object} parcel - Parcel object
 * @param {Map} beacons - Beacon map
 * @returns {Array} Beacons for this parcel
 */
export function getParcelBeacons(stand, parcel, beacons) {
  if (!parcel.vertices) {
    return []
  }
  
  return parcel.vertices.map(vertex => {
    const beacon = beacons.get(vertex.name)
    return {
      name: vertex.name,
      x: beacon ? beacon.x : vertex.x,
      y: beacon ? beacon.y : vertex.y,
      shared: beacon ? beacon.shared : false,
      parcels: beacon ? beacon.parcels : [stand]
    }
  })
}

/**
 * Extract beacon suffix from beacon name
 * 
 * @param {string} beaconName - Full beacon name (e.g., "2283A")
 * @param {string} stand - Stand number (e.g., "2283")
 * @returns {string} Suffix (e.g., "A")
 */
export function extractBeaconSuffix(beaconName, stand) {
  if (!beaconName || !stand) {
    return ''
  }
  
  // Remove stand number from beacon name to get suffix
  const suffix = beaconName.replace(stand, '')
  return suffix || ''
}

/**
 * Determine which parcel owns a shared beacon for labeling
 * 
 * @param {string} beaconName - Beacon name
 * @param {Map} beacons - Beacon map
 * @returns {string} Stand number that should label this beacon
 */
export function determineBeaconOwner(beaconName, beacons) {
  const beacon = beacons.get(beaconName)
  
  if (!beacon || !beacon.shared || beacon.parcels.length === 0) {
    return null
  }
  
  // Use the first parcel in the list (could be enhanced with spatial logic)
  return beacon.parcels[0]
}

/**
 * Generate topology summary
 * 
 * @param {Map} beacons - Beacon map
 * @param {Map} adjacency - Adjacency map
 * @returns {Object} Summary
 */
function generateTopologySummary(beacons, adjacency) {
  const totalBeacons = beacons.size
  const sharedBeacons = Array.from(beacons.values()).filter(b => b.shared).length
  const uniqueBeacons = totalBeacons - sharedBeacons
  
  const totalParcels = adjacency.size
  let totalAdjacencies = 0
  adjacency.forEach(neighbors => {
    totalAdjacencies += neighbors.size
  })
  // Divide by 2 because each adjacency is counted twice
  totalAdjacencies = totalAdjacencies / 2
  
  return {
    totalBeacons,
    sharedBeacons,
    uniqueBeacons,
    totalParcels,
    totalAdjacencies,
    averageAdjacenciesPerParcel: totalParcels > 0 ? (totalAdjacencies * 2) / totalParcels : 0
  }
}
