/**
 * Analyze which areas of the map are safe (polygon-free) for block placement
 * Returns an object indicating which quadrants/zones are safe
 */
function analyzeSafeAreas(mapBounds, mapFeatureBounds, buffer, logger) {
  // If no polygon data, all areas are safe
  if (!mapFeatureBounds || !mapFeatureBounds.pdfPoints || mapFeatureBounds.pdfPoints.length === 0) {
    logger.warn('[PDFKit] ⚠️  No polygon data - assuming all areas safe');
    return {
      topLeft: true,
      topCenter: true,
      topRight: true,
      midLeft: true,
      midRight: true,
      bottomLeft: true,
      bottomCenter: true,
      bottomRight: true
    };
  } 

  const polygon = mapFeatureBounds.pdfPoints;
  
  // Define test rectangles for each zone (small representative areas)
  const testSize = 100; // Small test rectangle size
  const zones = {
    topLeft: {
      x: mapBounds.x + 20,
      y: mapBounds.y + 100,
      width: testSize,
      height: testSize
    },
    topCenter: {
      x: mapBounds.x + (mapBounds.width / 2) - (testSize / 2),
      y: mapBounds.y + 20,
      width: testSize,
      height: testSize
    },
    topRight: {
      x: mapBounds.x + mapBounds.width - testSize - 20,
      y: mapBounds.y + 100,
      width: testSize,
      height: testSize
    },
    midLeft: {
      x: mapBounds.x + 20,
      y: mapBounds.y + (mapBounds.height / 2) - (testSize / 2),
      width: testSize,
      height: testSize
    },
    midRight: {
      x: mapBounds.x + mapBounds.width - testSize - 20,
      y: mapBounds.y + (mapBounds.height / 2) - (testSize / 2),
      width: testSize,
      height: testSize
    },
    bottomLeft: {
      x: mapBounds.x + 20,
      y: mapBounds.y + mapBounds.height - testSize - 120,
      width: testSize,
      height: testSize
    },
    bottomCenter: {
      x: mapBounds.x + (mapBounds.width / 2) - (testSize / 2),
      y: mapBounds.y + mapBounds.height - testSize - 20,
      width: testSize,
      height: testSize
    },
    bottomRight: {
      x: mapBounds.x + mapBounds.width - testSize - 20,
      y: mapBounds.y + mapBounds.height - testSize - 120,
      width: testSize,
      height: testSize
    }
  };

  // Check each zone for polygon overlap
  const safeAreas = {};
  
  for (const [zoneName, rect] of Object.entries(zones)) {
    const isSafe = !rectangleOverlapsPolygon(rect, polygon, buffer);
    safeAreas[zoneName] = isSafe;
    
    logger.info(`[PDFKit] 🔍 Zone ${zoneName}: ${isSafe ? '✅ SAFE' : '❌ OVERLAPS POLYGON'}`);
  }

  return safeAreas;
}

/**
 * Check if a rectangle overlaps with a polygon (with buffer)
 * Improved algorithm with multiple collision detection methods
 */
function rectangleOverlapsPolygon(rect, polygon, buffer = 0) {
  // Expand rectangle by buffer
  const expandedRect = {
    x: rect.x - buffer,
    y: rect.y - buffer,
    width: rect.width + 2 * buffer,
    height: rect.height + 2 * buffer
  };
  
  // Check 1: Rectangle center point inside polygon (quick rejection test)
  const centerX = expandedRect.x + expandedRect.width / 2;
  const centerY = expandedRect.y + expandedRect.height / 2;
  if (isPointInPolygon([centerY, centerX], polygon.map(p => [p.y, p.x]))) {
    return true;
  }
  
  // Check 2: Any corner of the rectangle inside the polygon
  const corners = [
    { x: expandedRect.x, y: expandedRect.y },
    { x: expandedRect.x + expandedRect.width, y: expandedRect.y },
    { x: expandedRect.x + expandedRect.width, y: expandedRect.y + expandedRect.height },
    { x: expandedRect.x, y: expandedRect.y + expandedRect.height }
  ];
  
  for (const corner of corners) {
    if (isPointInPolygon([corner.y, corner.x], polygon.map(p => [p.y, p.x]))) {
      return true;
    }
  }
  
  // Check 3: Mid-points of rectangle edges inside polygon
  const midPoints = [
    { x: expandedRect.x + expandedRect.width / 2, y: expandedRect.y }, // top mid
    { x: expandedRect.x + expandedRect.width, y: expandedRect.y + expandedRect.height / 2 }, // right mid
    { x: expandedRect.x + expandedRect.width / 2, y: expandedRect.y + expandedRect.height }, // bottom mid
    { x: expandedRect.x, y: expandedRect.y + expandedRect.height / 2 } // left mid
  ];
  
  for (const midPoint of midPoints) {
    if (isPointInPolygon([midPoint.y, midPoint.x], polygon.map(p => [p.y, p.x]))) {
      return true;
    }
  }
  
  // Check 4: Any polygon vertex inside the rectangle
  for (const vertex of polygon) {
    const vx = vertex.x;
    const vy = vertex.y;
    if (vx >= expandedRect.x && vx <= expandedRect.x + expandedRect.width &&
        vy >= expandedRect.y && vy <= expandedRect.y + expandedRect.height) {
      return true;
    }
  }
  
  // Check 3: Any polygon edge intersects rectangle edges
  const rectEdges = [
    { x1: expandedRect.x, y1: expandedRect.y, x2: expandedRect.x + expandedRect.width, y2: expandedRect.y },
    { x1: expandedRect.x + expandedRect.width, y1: expandedRect.y, x2: expandedRect.x + expandedRect.width, y2: expandedRect.y + expandedRect.height },
    { x1: expandedRect.x + expandedRect.width, y1: expandedRect.y + expandedRect.height, x2: expandedRect.x, y2: expandedRect.y + expandedRect.height },
    { x1: expandedRect.x, y1: expandedRect.y + expandedRect.height, x2: expandedRect.x, y2: expandedRect.y }
  ];
  
  for (let i = 0; i < polygon.length; i++) {
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % polygon.length];
    const polyEdge = { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    
    for (const rectEdge of rectEdges) {
      if (lineSegmentsIntersect(polyEdge, rectEdge)) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Check if two line segments intersect
 */
function lineSegmentsIntersect(seg1, seg2) {
  const { x1, y1, x2, y2 } = seg1;
  const { x1: x3, y1: y3, x2: x4, y2: y4 } = seg2;
  
  const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
  if (denom === 0) return false;
  
  const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
  const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;
  
  return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
}

/**
 * Check if a point is inside a polygon using ray casting algorithm
 */
function isPointInPolygon(point, polygon) {
  const [y, x] = point;
  let inside = false;
  
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    
    const intersect = ((yi > y) !== (yj > y)) &&
                     (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  
  return inside;
}

export { analyzeSafeAreas };
