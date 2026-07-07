// Adaptive Rendering System for Vector GeoPDF
// Provides scale-dependent text sizing and intelligent label placement

/**
 * Adaptive Renderer for Professional Cartographic Output
 * Handles scale-dependent rendering for optimal readability
 */
class AdaptiveRenderer {
  constructor() {
    this.minReadableSize = 4;  // Minimum font size in points
    this.maxReadableSize = 14; // Maximum font size in points
    this.labelSpacing = 2;    // Minimum spacing between labels in points
  }

  /**
   * Calculate optimal text size based on feature area and map scale
   */
  calculateOptimalTextSize(feature, mapScale, parcelArea) {
    // Base size calculation from parcel area
    let baseSize = Math.max(6, Math.min(12, Math.sqrt(parcelArea) / 8));
    
    // Scale adjustment factor
    const scaleFactor = this.calculateScaleFactor(mapScale);
    const adjustedSize = baseSize * scaleFactor;
    
    // Apply readability constraints
    const finalSize = Math.max(this.minReadableSize, 
                           Math.min(this.maxReadableSize, adjustedSize));
    
    console.log(`[AdaptiveRenderer] 📏 Text size: ${finalSize.toFixed(1)}pt (area: ${parcelArea.toFixed(0)}m², scale: 1:${mapScale})`);
    
    return finalSize;
  }

  /**
   * Calculate scale factor for text sizing
   */
  calculateScaleFactor(mapScale) {
    // Logarithmic scaling for better readability across scales
    if (mapScale <= 500) return 1.2;      // Large scale - slightly larger text
    if (mapScale <= 1000) return 1.0;     // Standard scale
    if (mapScale <= 2000) return 0.8;     // Smaller scale
    if (mapScale <= 5000) return 0.6;     // Much smaller scale
    return 0.4;                             // Very small scale
  }

  /**
   * Determine if label should be visible at current scale
   */
  shouldShowLabel(feature, mapScale) {
    const minScaleForLabel = this.calculateMinLabelScale(feature);
    return mapScale <= minScaleForLabel;
  }

  /**
   * Calculate minimum scale for label visibility based on feature characteristics
   */
  calculateMinLabelScale(feature) {
    const area = feature.properties.area_m2 || 0;
    const perimeter = feature.properties.perimeter_m || 0;
    const isCompact = this.isCompactFeature(area, perimeter);
    
    // Smaller or irregular features need larger scale
    if (area < 200) return 250;        // Very small parcels
    if (area < 500) return 500;        // Small parcels
    if (area < 2000) return 1000;      // Medium parcels
    if (area < 10000) return 2000;     // Large parcels
    if (area < 50000) return 3000;     // Very large parcels
    
    // Adjust for compactness
    if (isCompact && area < 10000) {
      return 1500; // Compact features need slightly larger scale
    }
    
    return 5000; // Default for very large parcels
  }

  /**
   * Determine if feature is compact (close to square)
   */
  isCompactFeature(area, perimeter) {
    if (!area || !perimeter) return false;
    
    // Calculate compactness ratio (perimeter² / 4π area)
    // Perfect circle = 1, square = π/4 ≈ 0.785
    const compactness = (perimeter * perimeter) / (4 * Math.PI * area);
    
    return compactness < 1.5; // Relatively compact
  }

  /**
   * Calculate optimal label position within feature
   */
  calculateOptimalLabelPosition(feature, mapBounds) {
    const geometry = feature.geometry;
    
    if (geometry.type === 'Polygon') {
      return this.calculatePolygonLabelPosition(geometry.coordinates[0], mapBounds);
    } else if (geometry.type === 'Point') {
      return this.calculatePointLabelPosition(geometry.coordinates, mapBounds);
    }
    
    return null;
  }

  /**
   * Calculate label position for polygon
   */
  calculatePolygonLabelPosition(exteriorRing, mapBounds) {
    // Calculate centroid
    const centroid = this.calculatePolygonCentroid(exteriorRing);
    
    // Check if centroid is suitable for label placement
    if (this.isGoodLabelPosition(centroid, exteriorRing)) {
      return centroid;
    }
    
    // Try alternative positions
    return this.findAlternativeLabelPosition(exteriorRing, mapBounds);
  }

  /**
   * Calculate polygon centroid
   */
  calculatePolygonCentroid(coordinates) {
    let sumY = 0, sumX = 0;
    const points = coordinates.slice(0, -1); // Exclude closing point
    
    points.forEach(coord => {
      sumY += coord[0]; // Y (Westing)
      sumX += coord[1]; // X (Southing)
    });
    
    return {
      y: sumY / points.length,
      x: sumX / points.length
    };
  }

  /**
   * Check if position is good for label placement
   */
  isGoodLabelPosition(position, polygon) {
    // Check if position is inside polygon
    if (!this.isPointInPolygon(position, polygon)) {
      return false;
    }
    
    // Check minimum distance from edges
    const minDistance = this.getMinDistanceFromEdges(position, polygon);
    return minDistance >= 5; // 5 meters minimum from edges
  }

  /**
   * Point-in-polygon test using ray casting
   */
  isPointInPolygon(point, polygon) {
    const [y, x] = point;
    let inside = false;
    
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [yi, xi] = polygon[i];
      const [yj, xj] = polygon[j];
      
      const intersect = ((xi > x) !== (xj > x)) &&
        (y < (yj - yi) * (x - xi) / (xj - xi) + yi);
      
      if (intersect) inside = !inside;
    }
    
    return inside;
  }

  /**
   * Get minimum distance from point to polygon edges
   */
  getMinDistanceFromEdges(point, polygon) {
    let minDistance = Infinity;
    
    for (let i = 0; i < polygon.length - 1; i++) {
      const distance = this.pointToLineDistance(point, polygon[i], polygon[i + 1]);
      minDistance = Math.min(minDistance, distance);
    }
    
    return minDistance;
  }

  /**
   * Calculate distance from point to line segment
   */
  pointToLineDistance(point, lineStart, lineEnd) {
    const [py, px] = point;
    const [y1, x1] = lineStart;
    const [y2, x2] = lineEnd;
    
    // Vector from line start to end
    const dy = y2 - y1;
    const dx = x2 - x1;
    const lineLengthSquared = dy * dy + dx * dx;
    
    if (lineLengthSquared === 0) {
      // Line segment is a point
      return Math.sqrt((py - y1) ** 2 + (px - x1) ** 2);
    }
    
    // Calculate projection parameter
    let t = ((py - y1) * dy + (px - x1) * dx) / lineLengthSquared;
    t = Math.max(0, Math.min(1, t));
    
    // Find projection point
    const projY = y1 + t * dy;
    const projX = x1 + t * dx;
    
    // Calculate distance
    return Math.sqrt((py - projY) ** 2 + (px - projX) ** 2);
  }

  /**
   * Find alternative label position
   */
  findAlternativeLabelPosition(polygon, mapBounds) {
    // Try points along the polygon at regular intervals
    const numPoints = 8;
    const bestPositions = [];
    
    for (let i = 0; i < numPoints; i++) {
      const t = i / numPoints;
      const point = this.interpolateAlongPolygon(polygon, t);
      
      if (this.isGoodLabelPosition(point, polygon)) {
        bestPositions.push(point);
      }
    }
    
    // Return the best position (closest to centroid)
    if (bestPositions.length > 0) {
      const centroid = this.calculatePolygonCentroid(polygon);
      return bestPositions.reduce((best, current) => {
        const bestDist = this.distance(centroid, best);
        const currentDist = this.distance(centroid, current);
        return currentDist < bestDist ? current : best;
      });
    }
    
    // Fallback to centroid
    return this.calculatePolygonCentroid(polygon);
  }

  /**
   * Interpolate point along polygon perimeter
   */
  interpolateAlongPolygon(polygon, t) {
    const totalLength = this.calculatePolygonLength(polygon);
    const targetLength = totalLength * t;
    
    let currentLength = 0;
    for (let i = 0; i < polygon.length - 1; i++) {
      const segmentLength = this.distance(polygon[i], polygon[i + 1]);
      
      if (currentLength + segmentLength >= targetLength) {
        const segmentT = (targetLength - currentLength) / segmentLength;
        return [
          polygon[i][0] + segmentT * (polygon[i + 1][0] - polygon[i][0]),
          polygon[i][1] + segmentT * (polygon[i + 1][1] - polygon[i][1])
        ];
      }
      
      currentLength += segmentLength;
    }
    
    return polygon[0];
  }

  /**
   * Calculate polygon perimeter length
   */
  calculatePolygonLength(polygon) {
    let length = 0;
    for (let i = 0; i < polygon.length - 1; i++) {
      length += this.distance(polygon[i], polygon[i + 1]);
    }
    return length;
  }

  /**
   * Calculate distance between two points
   */
  distance(p1, p2) {
    const dy = p2[0] - p1[0];
    const dx = p2[1] - p1[1];
    return Math.sqrt(dy * dy + dx * dx);
  }

  /**
   * Calculate label positioning for point features
   */
  calculatePointLabelPosition(coordinates, mapBounds) {
    const offset = 10; // 10 meters offset from point
    
    return {
      y: coordinates[0] + offset,
      x: coordinates[1] + offset
    };
  }

  /**
   * Generate style object for text rendering
   */
  generateTextStyle(feature, mapScale) {
    const area = feature.properties.area_m2 || 0;
    const fontSize = this.calculateOptimalTextSize(feature, mapScale, area);
    
    const style = {
      font: 'Helvetica',
      fontSize,
      color: '#000000',
      backgroundColor: '#FFFFFF',
      backgroundOpacity: mapScale <= 2000 ? 0.8 : 0,
      padding: 1,
      haloColor: '#FFFFFF',
      haloWidth: mapScale <= 1000 ? 0.5 : 0,
      alignment: 'center'
    };

    console.log(`[AdaptiveRenderer] 🎨 Text style: ${fontSize.toFixed(1)}pt, background: ${style.backgroundOpacity > 0 ? 'yes' : 'no'}`);
    
    return style;
  }

  /**
   * Check for label collisions
   */
  checkLabelCollisions(newLabel, existingLabels) {
    const newBounds = this.getLabelBounds(newLabel);
    
    return existingLabels.some(existingLabel => {
      const existingBounds = this.getLabelBounds(existingLabel);
      return this.boundsOverlap(newBounds, existingBounds);
    });
  }

  /**
   * Get label bounding box
   */
  getLabelBounds(label) {
    const width = label.width || 50;  // Estimated width in points
    const height = label.fontSize || 8; // Height in points
    
    return {
      x: label.x - width / 2,
      y: label.y - height / 2,
      width,
      height
    };
  }

  /**
   * Check if two bounding boxes overlap
   */
  boundsOverlap(bounds1, bounds2) {
    const spacing = this.labelSpacing;
    
    return !(bounds1.x + bounds1.width + spacing < bounds2.x ||
             bounds2.x + bounds2.width + spacing < bounds1.x ||
             bounds1.y + bounds1.height + spacing < bounds2.y ||
             bounds2.y + bounds2.height + spacing < bounds1.y);
  }

  /**
   * Resolve label collisions by repositioning
   */
  resolveLabelCollisions(labels) {
    const resolvedLabels = [];
    const placedLabels = [];
    
    // Sort labels by priority (larger features first)
    labels.sort((a, b) => (b.properties.area_m2 || 0) - (a.properties.area_m2 || 0));
    
    for (const label of labels) {
      if (!this.checkLabelCollisions(label, placedLabels)) {
        resolvedLabels.push(label);
        placedLabels.push(label);
      } else {
        // Try to reposition
        const repositionedLabel = this.repositionLabel(label, placedLabels);
        if (repositionedLabel && !this.checkLabelCollisions(repositionedLabel, placedLabels)) {
          resolvedLabels.push(repositionedLabel);
          placedLabels.push(repositionedLabel);
        }
      }
    }
    
    console.log(`[AdaptiveRenderer] 🏷️ Resolved ${labels.length} labels, placed ${resolvedLabels.length}`);
    
    return resolvedLabels;
  }

  /**
   * Reposition label to avoid collisions
   */
  repositionLabel(label, placedLabels) {
    const offsets = [
      [0, 10],   // Above
      [10, 0],    // Right
      [0, -10],   // Below
      [-10, 0],   // Left
      [7, 7],     // Top-right
      [-7, 7],    // Top-left
      [7, -7],    // Bottom-right
      [-7, -7]    // Bottom-left
    ];
    
    for (const [dx, dy] of offsets) {
      const repositioned = {
        ...label,
        x: label.x + dx,
        y: label.y + dy
      };
      
      if (!this.checkLabelCollisions(repositioned, placedLabels)) {
        return repositioned;
      }
    }
    
    return null; // No suitable position found
  }
}

export { AdaptiveRenderer };
