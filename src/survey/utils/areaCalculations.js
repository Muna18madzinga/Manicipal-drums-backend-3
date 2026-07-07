/**
 * Area Calculations using Shoelace Method
 * Zimbabwe Surveying Conventions:
 * - Y-coordinate (Westing) comes first
 * - X-coordinate (Southing) comes second
 * - Clockwise direction for area calculation
 * - Bearings in DMS format (e.g., 321:05:00)
 */

import proj4 from 'proj4';

// Define the projection (EPSG:22291 - Cape / Lo31).
// +axis=wsu intentionally omitted: axis convention is handled by explicit
// coordinate negation in callers, not by proj4's enforceAxis mechanism.
proj4.defs('EPSG:22291', '+proj=tmerc +lat_0=0 +lon_0=31 +k=1 +x_0=0 +y_0=0 +ellps=clrk80 +towgs84=-136,-108,-292,0,0,0,0 +units=m +no_defs');

/**
 * Calculate distance between two points
 */
function calculateDistance(y1, x1, y2, x2) {
  const dY = y2 - y1
  const dX = x2 - x1
  return Math.sqrt(dY * dY + dX * dX)
}

/**
 * Calculate bearing from point 1 to point 2 (Zimbabwe convention)
 * Returns bearing in decimal degrees (0-360)
 * 
 * CRITICAL: Gauss Lo (Cape Lo) is SOUTH-ORIENTED
 * Y = Westing, X = Southing
 * Bearings measured clockwise from South
 */
function calculateBearing(y1, x1, y2, x2) {
  const dY = y2 - y1  // Westing difference
  const dX = x2 - x1  // Southing difference
  
  // CRITICAL FIX: South-oriented bearing formula
  // For south-oriented coordinates: bearing = atan2(dY, dX)
  // This measures angle clockwise from South (positive X-axis)
  let bearing = Math.atan2(dY, dX) * (180 / Math.PI)
  
  // Normalize to 0-360
  if (bearing < 0) {
    bearing += 360
  }
  
  return bearing
}

/**
 * Convert decimal degrees to DMS format (e.g., 321:05:00)
 */
function decimalToDMS(decimal) {
  const degrees = Math.floor(decimal)
  const minutesDecimal = (decimal - degrees) * 60
  const minutes = Math.floor(minutesDecimal)
  const seconds = Math.round((minutesDecimal - minutes) * 60)
  
  return `${degrees}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * Calculate area using Shoelace method (Zimbabwe convention - clockwise)
 * @param {Array} coordinates - Array of {y, x} coordinates
 * @returns {number} Area in square meters
 */
/**
 * Calculate area using Shoelace method (Zimbabwe convention - clockwise)
 * @param {Array} coordinates - Array of {y, x} coordinates in EPSG:22291 (meters)
 * @returns {number} Area in square meters
 */
function calculateAreaShoelace(coordinates) {
  if (!coordinates || coordinates.length < 3) {
    throw new Error('At least 3 coordinates required for area calculation')
  }
  
  let sum = 0
  const n = coordinates.length
  
  // Shoelace formula: Area = 0.5 * |Σ(Yi * Xi+1 - Xi * Yi+1)|
  // For clockwise direction (Zimbabwe convention)
  for (let i = 0; i < n; i++) {
    const current = coordinates[i]
    const next = coordinates[(i + 1) % n]
    
    sum += (current.y * next.x) - (current.x * next.y)
  }
  
  // Take absolute value and divide by 2 to get area in square meters
  const area = Math.abs(sum) / 2
  
  return area
}

/**
 * Calculate centroid of polygon
 */
function calculateCentroid(coordinates) {
  if (!coordinates || coordinates.length === 0) {
    return { y: 0, x: 0 }
  }
  
  let sumY = 0
  let sumX = 0
  
  for (const coord of coordinates) {
    sumY += coord.y
    sumX += coord.x
  }
  
  return {
    y: sumY / coordinates.length,
    x: sumX / coordinates.length
  }
}

/**
 * Calculate residuals (closure errors)
 */
function calculateResiduals(coordinates) {
  let sumDY = 0
  let sumDX = 0
  
  const n = coordinates.length
  for (let i = 0; i < n; i++) {
    const current = coordinates[i]
    const next = coordinates[(i + 1) % n]
    
    sumDY += (next.y - current.y)
    sumDX += (next.x - current.x)
  }
  
  return {
    dY: sumDY,
    dX: sumDX,
    closureError: Math.sqrt(sumDY * sumDY + sumDX * sumDX)
  }
}

/**
 * Process parcel for area calculation
 * Returns detailed calculation data for PDF generation
 */
function processParcel(parcel, coordinatePoints) {
  console.log(`Processing parcel ${parcel.stand || 'unknown'}`);
  console.log('Parcel keys:', Object.keys(parcel));
  
  // Extract coordinates from geometry
  let coordinates = [];
  let geomData = null;
  
  // Log available geometry fields
  console.log('Available geometry fields:');
  ['geojson', 'geom', 'geometry'].forEach(field => {
    console.log(`- ${field}:`, parcel[field] ? 'exists' : 'missing');
  });
  
  // Handle different geometry formats - prefer geojson from view
  if (parcel.geojson) {
    console.log('Using geojson field');
    geomData = parcel.geojson;
  } else if (parcel.geom) {
    console.log('Using geom field');
    geomData = parcel.geom;
  } else if (parcel.geometry) {
    console.log('Using geometry field');
    geomData = parcel.geometry;
  } else {
    console.error('No geometry data found in parcel');
    throw new Error('No geometry data found in parcel. Available fields: ' + Object.keys(parcel).join(', '));
  }
  
  // Parse if it's a string (from database)
  if (typeof geomData === 'string') {
    try {
      console.log('Parsing geometry string');
      geomData = JSON.parse(geomData);
    } catch (e) {
      console.error('Failed to parse geometry:', e.message);
      console.log('Geometry string start:', geomData.substring(0, 100));
      throw new Error(`Failed to parse geometry: ${e.message}. String starts with: ${geomData.substring(0, 50)}...`);
    }
  }
  
  // Extract coordinates from GeoJSON
  if (geomData && geomData.type === 'Polygon' && geomData.coordinates) {
    console.log('Processing Polygon geometry');
    // GeoJSON format: coordinates[0] is outer ring
    const ring = geomData.coordinates[0];
    if (!ring || ring.length < 3) {
      throw new Error('Polygon must have at least 3 coordinates');
    }
    
    // Check if coordinates are already in EPSG:22291 (meters)
    // If coordinates are in degrees (WGS84), they'll be in range [-180, 180], [-90, 90]
    // If in EPSG:22291, they'll be in meters (e.g., 7-8 digits for Y, 6-7 digits for X in Zimbabwe)
    const firstCoord = ring[0];
    const isWGS84 = Math.abs(firstCoord[0]) <= 180 && Math.abs(firstCoord[1]) <= 90;
    
    if (isWGS84) {
      console.log('Detected WGS84 coordinates, transforming to EPSG:22291');
      // Transform from WGS84 (EPSG:4326) to Cape / Lo31 (EPSG:22291)
      // proj4 expects [longitude, latitude] for WGS84
      coordinates = ring.slice(0, -1).map(coord => {
        const [y, x] = proj4('EPSG:4326', 'EPSG:22291', [coord[0], coord[1]]);
        return { x, y };
      });
    } else {
      console.log('Using coordinates as-is (assumed to be in EPSG:22291)');
      // Use coordinates as-is (already in EPSG:22291)
      // GeoJSON format: [x, y] for EPSG:22291 (Southing, Westing)
      coordinates = ring.slice(0, -1).map(coord => ({
        x: coord[0],  // Southing (X-coordinate in Cape Lo)
        y: coord[1]   // Westing (Y-coordinate in Cape Lo)
      }));
    }
  } else if (geomData && geomData.type === 'Feature' && geomData.geometry && geomData.geometry.type === 'Polygon') {
    console.log('Processing Feature with Polygon geometry');
    const ring = geomData.geometry.coordinates[0];
    // GeoJSON format: [x, y] for EPSG:22291 (Southing, Westing)
    coordinates = ring.slice(0, -1).map(coord => ({
      x: coord[0],  // Southing (X-coordinate in Cape Lo)
      y: coord[1]   // Westing (Y-coordinate in Cape Lo)
    }));
  } else {
    console.error('Invalid geometry format:', {
      type: geomData?.type,
      hasCoordinates: !!(geomData?.coordinates),
      geomDataKeys: geomData ? Object.keys(geomData) : 'null'
    });
    throw new Error(`Invalid geometry format. Expected Polygon or Feature with Polygon, got: ${geomData ? geomData.type : 'null'}`);
  }
  
  console.log(`Extracted ${coordinates.length} coordinates`);
  
  // Match coordinates to point names
  const tolerance = 0.5 // 0.5m tolerance for matching beacon names
  const edges = []
  
  for (let i = 0; i < coordinates.length; i++) {
    const current = coordinates[i]
    const next = coordinates[(i + 1) % coordinates.length]
    
    // Find matching point names
    const currentPoint = coordinatePoints.find(pt => 
      Math.abs(pt.y - current.y) < tolerance && 
      Math.abs(pt.x - current.x) < tolerance
    )
    
    const nextPoint = coordinatePoints.find(pt => 
      Math.abs(pt.y - next.y) < tolerance && 
      Math.abs(pt.x - next.x) < tolerance
    )
    
    const distance = calculateDistance(current.y, current.x, next.y, next.x)
    const bearing = calculateBearing(current.y, current.x, next.y, next.x)
    const dY = next.y - current.y
    const dX = next.x - current.x
    
    edges.push({
      pointName: currentPoint ? currentPoint.name : `P${i + 1}`,
      y: current.y,
      x: current.x,
      distance: distance,
      direction: decimalToDMS(bearing),
      dY: dY,
      dX: dX
    })
  }
  
  // Calculate area
  const area = Math.abs(calculateAreaShoelace(coordinates));
  
  // Calculate perimeter
  let perimeter = 0;
  for (let i = 0; i < coordinates.length; i++) {
    const nextIndex = (i + 1) % coordinates.length;
    const dist = Math.sqrt(
      Math.pow(coordinates[nextIndex].x - coordinates[i].x, 2) + 
      Math.pow(coordinates[nextIndex].y - coordinates[i].y, 2)
    );
    perimeter += dist;
  }
  
  // Calculate centroid
  const centroid = calculateCentroid(coordinates);
  
  // Calculate residuals
  const residuals = calculateResiduals(coordinates);
  
  // Log coordinate details for debugging
  console.log('First 3 coordinates (EPSG:22291):', coordinates.slice(0, 3).map(c => ({x: c.x.toFixed(2), y: c.y.toFixed(2)})));
  console.log('Area (m²):', area);
  console.log('Perimeter (m):', perimeter);
  
  return {
    stand: parcel.stand,
    area: Math.max(0, Math.round(area)), // Ensure non-negative area
    centroid: {
      y: centroid.y.toFixed(2),
      x: centroid.x.toFixed(2)
    },
    residuals: {
      dY: residuals.dY.toFixed(2),
      dX: residuals.dX.toFixed(2),
      closureError: residuals.closureError.toFixed(3)
    },
    edges: edges
  }
}

export {
  calculateAreaShoelace,
  calculateDistance,
  calculateBearing,
  decimalToDMS,
  calculateCentroid,
  calculateResiduals,
  processParcel
}
