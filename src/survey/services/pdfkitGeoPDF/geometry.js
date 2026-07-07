// Points to millimeters conversion
const PT_TO_MM = 0.352778;
const MM_TO_PT = 1 / PT_TO_MM;

export { PT_TO_MM, MM_TO_PT };

// ── Geometry helpers ─────────────────────────────────────────────────────────

export function calculateCentroid(coordinates) {
  let sumY = 0,
    sumX = 0;
  const points = coordinates
    .slice(0, -1)
    .map((coord) => normalizeCapeLoYX(coord?.[0], coord?.[1]))
    .filter(([y, x]) => Number.isFinite(y) && Number.isFinite(x));

  if (points.length === 0) {
    return { y: NaN, x: NaN };
  }

  points.forEach((coord) => {
    sumY += coord[0];
    sumX += coord[1];
  });

  return {
    y: sumY / points.length,
    x: sumX / points.length,
  };
}

export function isPointInPolygon(point, polygon) {
  const [y, x] = point;
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];

    const intersect =
      xi > x !== xj > x && y < ((yj - yi) * (x - xi)) / (xj - xi) + yi;

    if (intersect) inside = !inside;
  }

  return inside;
}

export function pointDistance(p1, p2) {
  const dy = p2[0] - p1[0];
  const dx = p2[1] - p1[1];
  return Math.sqrt(dy * dy + dx * dx);
}

export function pointToLineDistance(point, lineStart, lineEnd) {
  const [py, px] = point;
  const [y1, x1] = lineStart;
  const [y2, x2] = lineEnd;

  const dy = y2 - y1;
  const dx = x2 - x1;
  const lineLengthSquared = dy * dy + dx * dx;

  if (lineLengthSquared === 0) {
    return pointDistance(point, lineStart);
  }

  const t = Math.max(
    0,
    Math.min(1, ((py - y1) * dy + (px - x1) * dx) / lineLengthSquared)
  );

  const closestY = y1 + t * dy;
  const closestX = x1 + t * dx;

  const distY = py - closestY;
  const distX = px - closestX;
  return Math.sqrt(distY * distY + distX * distX);
}

export function isPointNearPolygon(point, polygon, bufferMeters) {
  if (isPointInPolygon(point, polygon)) {
    return true;
  }

  for (let i = 0; i < polygon.length - 1; i++) {
    const p1 = polygon[i];
    const p2 = polygon[i + 1];

    const distance = distanceToSegment(point, p1, p2);
    if (distance <= bufferMeters) {
      return true;
    }
  }

  return false;
}

export function hasBlockToBlockCollision(newBlock, placedBlocks, minSpacing = 15) {
  return placedBlocks.some((block) => {
    return rectanglesOverlap(newBlock, block, minSpacing);
  });
}

export function distanceToSegment(point, segStart, segEnd) {
  const [py, px] = point;
  const [sy, sx] = segStart;
  const [ey, ex] = segEnd;

  const dy = ey - sy;
  const dx = ex - sx;
  const lengthSquared = dy * dy + dx * dx;

  if (lengthSquared === 0) {
    return pointDistance(point, segStart);
  }

  let t = ((py - sy) * dy + (px - sx) * dx) / lengthSquared;
  t = Math.max(0, Math.min(1, t));

  const closestY = sy + t * dy;
  const closestX = sx + t * dx;

  return pointDistance(point, [closestY, closestX]);
}

export function analyzeParcelGeometry(pdfCoords, doc) {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  pdfCoords.forEach((p) => {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  });

  const width = maxX - minX;
  const height = maxY - minY;
  const aspectRatio = Math.max(width, height) / Math.min(width, height);
  const minDimension = Math.min(width, height);
  const maxDimension = Math.max(width, height);

  let area = 0;
  for (let i = 0; i < pdfCoords.length - 1; i++) {
    area +=
      pdfCoords[i].x * pdfCoords[i + 1].y - pdfCoords[i + 1].x * pdfCoords[i].y;
  }
  area = Math.abs(area) / 2;

  const edges = [];
  for (let i = 0; i < pdfCoords.length - 1; i++) {
    const dx = pdfCoords[i + 1].x - pdfCoords[i].x;
    const dy = pdfCoords[i + 1].y - pdfCoords[i].y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);
    edges.push({ index: i, length, angle, dx, dy });
  }
  edges.sort((a, b) => b.length - a.length);

  const isNarrow = aspectRatio > 2.5;
  const isVeryNarrow = aspectRatio > 4;
  const isExtremelyNarrow = aspectRatio > 6;

  const maxStandFontByWidth = minDimension * 0.6;

  let standFontSize, edgeFontSize;

  if (isExtremelyNarrow || minDimension < 15) {
    standFontSize = Math.max(7, Math.min(8, maxStandFontByWidth));
    edgeFontSize = 7;
  } else if (isVeryNarrow || minDimension < 25) {
    standFontSize = Math.max(8, Math.min(9, maxStandFontByWidth));
    edgeFontSize = 7;
  } else if (isNarrow || minDimension < 40) {
    standFontSize = Math.max(9, Math.min(10, maxStandFontByWidth));
    edgeFontSize = 8;
  } else {
    standFontSize = 11;
    edgeFontSize = 9;
  }

  let labelStrategy = "standard";
  if (isExtremelyNarrow) {
    labelStrategy = "minimal";
  } else if (isVeryNarrow) {
    labelStrategy = "compact";
  } else if (isNarrow) {
    labelStrategy = "reduced";
  }

  let sumX = 0,
    sumY = 0;
  const n = pdfCoords.length - 1;
  for (let i = 0; i < n; i++) {
    sumX += pdfCoords[i].x;
    sumY += pdfCoords[i].y;
  }
  const centroid = { x: sumX / n, y: sumY / n };

  return {
    width,
    height,
    aspectRatio,
    minDimension,
    maxDimension,
    area,
    isNarrow,
    isVeryNarrow,
    isExtremelyNarrow,
    standFontSize,
    edgeFontSize,
    labelStrategy,
    longestEdge: edges[0],
    secondLongestEdge: edges[1] || edges[0],
    edges,
    centroid,
    bounds: { minX, maxX, minY, maxY },
  };
}

export function calculateLocalParcelWidth(point, pdfCoords, perpAngle) {
  const rayLength = 1000;
  const angleRad = (perpAngle * Math.PI) / 180;

  const ray1End = {
    x: point.x + Math.cos(angleRad) * rayLength,
    y: point.y + Math.sin(angleRad) * rayLength,
  };
  const ray2End = {
    x: point.x - Math.cos(angleRad) * rayLength,
    y: point.y - Math.sin(angleRad) * rayLength,
  };

  let minDist1 = Infinity,
    minDist2 = Infinity;

  for (let i = 0; i < pdfCoords.length - 1; i++) {
    const p1 = pdfCoords[i];
    const p2 = pdfCoords[i + 1];

    const int1 = lineIntersection(point, ray1End, p1, p2);
    if (int1) {
      const dist = Math.sqrt((int1.x - point.x) ** 2 + (int1.y - point.y) ** 2);
      minDist1 = Math.min(minDist1, dist);
    }

    const int2 = lineIntersection(point, ray2End, p1, p2);
    if (int2) {
      const dist = Math.sqrt((int2.x - point.x) ** 2 + (int2.y - point.y) ** 2);
      minDist2 = Math.min(minDist2, dist);
    }
  }

  return minDist1 + minDist2;
}

export function lineIntersection(p1, p2, p3, p4) {
  const x1 = p1.x,
    y1 = p1.y,
    x2 = p2.x,
    y2 = p2.y;
  const x3 = p3.x,
    y3 = p3.y,
    x4 = p4.x,
    y4 = p4.y;

  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 0.0001) return null;

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return {
      x: x1 + t * (x2 - x1),
      y: y1 + t * (y2 - y1),
    };
  }
  return null;
}

export function isRectOutsidePolygons(rect, polygons) {
  if (!rect || !Array.isArray(polygons) || polygons.length === 0) return true;
  const x = rect.x;
  const y = rect.y;
  const w = rect.width;
  const h = rect.height;
  if (![x, y, w, h].every(Number.isFinite)) return false;
  const points = [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
    [x + w / 2, y],
    [x + w / 2, y + h],
    [x, y + h / 2],
    [x + w, y + h / 2],
  ];
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || polygon.length < 3) continue;
    for (const p of points) {
      if (isPointInPolygonSimple(p, polygon)) return false;
    }
  }
  return true;
}

export function tryTightFullBeaconLabelPosition(
  beaconPos,
  labelWidth,
  labelHeight,
  beaconRadius,
  paddingFromCircle,
  fullOutsidePolygons,
  collisionDetector
) {
  if (!beaconPos) return null;
  if (![labelWidth, labelHeight, beaconRadius, paddingFromCircle].every(Number.isFinite))
    return null;

  const baseY = beaconPos.y - labelHeight / 2;
  const candidates = [
    {
      name: "right",
      x: beaconPos.x + beaconRadius + paddingFromCircle,
      y: baseY,
    },
    {
      name: "left",
      x: beaconPos.x - beaconRadius - paddingFromCircle - labelWidth,
      y: baseY,
    },
  ];

  for (const c of candidates) {
    const rect = { x: c.x, y: c.y, width: labelWidth, height: labelHeight };
    if (
      Array.isArray(fullOutsidePolygons) &&
      fullOutsidePolygons.length > 0 &&
      !isRectOutsidePolygons(rect, fullOutsidePolygons)
    ) {
      continue;
    }
    if (
      collisionDetector &&
      collisionDetector.hasCollision(c.x, c.y, labelWidth, labelHeight)
    ) {
      continue;
    }
    return { x: c.x, y: c.y, position: c.name };
  }

  return null;
}

export function nudgeOutsideFullBeaconLabelTowardCircle(
  beaconPos,
  startPos,
  labelWidth,
  labelHeight,
  beaconRadius,
  mapBounds,
  fullOutsidePolygons,
  collisionDetector
) {
  if (!beaconPos || !startPos || !mapBounds || !collisionDetector) return null;
  if (![labelWidth, labelHeight, beaconRadius].every(Number.isFinite)) return null;

  const minClearance = 0.5;
  const startX = Number(startPos.x);
  const startY = Number(startPos.y);
  if (![startX, startY].every(Number.isFinite)) return null;

  const distToRect = (x, y) => {
    const closestX = Math.max(x, Math.min(beaconPos.x, x + labelWidth));
    const closestY = Math.max(y, Math.min(beaconPos.y, y + labelHeight));
    return Math.hypot(closestX - beaconPos.x, closestY - beaconPos.y);
  };

  const isValid = (x, y) => {
    if (
      x < mapBounds.x ||
      x + labelWidth > mapBounds.x + mapBounds.width ||
      y < mapBounds.y ||
      y + labelHeight > mapBounds.y + mapBounds.height
    ) {
      return false;
    }

    if (distToRect(x, y) < beaconRadius + minClearance) return false;

    if (
      Array.isArray(fullOutsidePolygons) &&
      fullOutsidePolygons.length > 0 &&
      !isRectOutsidePolygons({ x, y, width: labelWidth, height: labelHeight }, fullOutsidePolygons)
    ) {
      return false;
    }

    if (collisionDetector.hasCollision(x, y, labelWidth, labelHeight)) return false;

    return true;
  };

  let best = isValid(startX, startY) ? { x: startX, y: startY } : null;
  let bestDist = best ? distToRect(best.x, best.y) : Infinity;

  const step = 0.5;
  const maxShift = Math.max(2.5, Math.min(12, beaconRadius * 6));
  const directions = [
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
  ];

  for (const dir of directions) {
    for (let s = step; s <= maxShift + 1e-9; s += step) {
      const x = startX + dir.dx * s;
      const y = startY + dir.dy * s;
      if (!isValid(x, y)) continue;
      const d = distToRect(x, y);
      if (d + 1e-6 < bestDist) {
        bestDist = d;
        best = { x, y };
      }
    }
  }

  return best || { x: startX, y: startY };
}

export function isLabelBoxInsideParcelPDF(
  labelX,
  labelY,
  labelWidth,
  labelHeight,
  pdfCoords
) {
  const corners = [
    { x: labelX - labelWidth / 2, y: labelY - labelHeight / 2 },
    { x: labelX + labelWidth / 2, y: labelY - labelHeight / 2 },
    { x: labelX + labelWidth / 2, y: labelY + labelHeight / 2 },
    { x: labelX - labelWidth / 2, y: labelY + labelHeight / 2 },
  ];

  const polygon = pdfCoords.map((p) => [p.x, p.y]);

  for (const corner of corners) {
    if (!isPointInPolygonSimple([corner.x, corner.y], polygon)) {
      return false;
    }
  }
  return true;
}

export function isPointInPolygonSimple(point, polygon) {
  const [x, y] = point;
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];

    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

// ── Polygon area and circle ──────────────────────────────────────────────────

export function calculatePolygonArea(coords) {
  let area = 0;
  const points = coords.slice(0, -1);

  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i][0] * points[j][1];
    area -= points[j][0] * points[i][1];
  }

  return Math.abs(area / 2);
}

export function findLargestInscribedCircle(coords) {
  return calculateCentroid(coords);
}

// ── CRS / coordinate transforms ──────────────────────────────────────────────

export function normalizeCapeLoYX(y, x) {
  if (!Number.isFinite(y) || !Number.isFinite(x)) return [y, x];
  const ay = Math.abs(y);
  const ax = Math.abs(x);
  if ((ay > 1000000 && ax < 1000000) || ay > ax * 2) return [x, y];
  return [y, x];
}

export function transformCoords(y, x, extent, pdfBounds) {
  [y, x] = normalizeCapeLoYX(y, x);
  const easting = -y;
  const northing = -x;

  const eastingMin = -extent.maxY;
  const eastingMax = -extent.minY;
  const northingMin = -extent.maxX;
  const northingMax = -extent.minX;

  const width = eastingMax - eastingMin;
  const height = northingMax - northingMin;

  const INSET_FACTOR = 0.05;
  const insetX = pdfBounds.width * INSET_FACTOR;
  const insetY = pdfBounds.height * INSET_FACTOR;
  const effectiveBounds = {
    x: pdfBounds.x + insetX,
    y: pdfBounds.y + insetY,
    width: pdfBounds.width - 2 * insetX,
    height: pdfBounds.height - 2 * insetY,
  };

  const scaleX = effectiveBounds.width / width;
  const scaleY = effectiveBounds.height / height;

  const uniformScale = Math.min(scaleX, scaleY);

  const renderedWidth = width * uniformScale;
  const renderedHeight = height * uniformScale;

  const _availX = effectiveBounds.width - renderedWidth;
  const _alignX = pdfBounds.alignX || 'center';
  const offsetX = _alignX === 'left'  ? 0
                : _alignX === 'right' ? _availX
                : _availX / 2;
  const offsetY = (effectiveBounds.height - renderedHeight) / 2;

  const relativeX = easting - eastingMin;
  const relativeY = northing - northingMin;

  const pdfX = effectiveBounds.x + offsetX + relativeX * uniformScale;
  const pdfY =
    effectiveBounds.y + offsetY + renderedHeight - relativeY * uniformScale;

  return { x: pdfX, y: pdfY };
}

export function calculateMapBounds(pageWidth, pageHeight) {
  const leftMargin = 50 * MM_TO_PT;
  const rightMargin = 150 * MM_TO_PT;
  const topMargin = 50 * MM_TO_PT;
  const bottomMargin = 50 * MM_TO_PT;

  const mainBoundary = {
    x: leftMargin,
    y: topMargin,
    width: pageWidth - leftMargin - rightMargin,
    height: pageHeight - topMargin - bottomMargin,
  };

  const figureScale = 0.95;
  const figureWidth = mainBoundary.width * figureScale;
  const figureHeight = mainBoundary.height * figureScale;

  const figureBoundary = {
    x: mainBoundary.x + (mainBoundary.width - figureWidth) / 2,
    y: mainBoundary.y + (mainBoundary.height - figureHeight) / 2,
    width: figureWidth,
    height: figureHeight,
  };

  return {
    main: mainBoundary,
    figure: figureBoundary,
  };
}

export function calculatePolygonPDFBounds(polygon, extent, mapBounds) {
  if (!polygon || polygon.length === 0) {
    return null;
  }

  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;

  for (const vertex of polygon) {
    const pdfPoint = transformCoords(vertex[0], vertex[1], extent, mapBounds);
    minX = Math.min(minX, pdfPoint.x);
    maxX = Math.max(maxX, pdfPoint.x);
    minY = Math.min(minY, pdfPoint.y);
    maxY = Math.max(maxY, pdfPoint.y);
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function calculateDynamicMapOffset(polygonBounds, mapBounds, logger) {
  if (!polygonBounds) {
    logger.info("[PDFKit] 📍 No polygon bounds - using centered map position");
    return 0;
  }

  const mapCenterX = mapBounds.x + mapBounds.width / 2;
  const polygonCenterX = polygonBounds.centerX;

  const polygonOnLeft = polygonCenterX < mapCenterX;

  const MAX_OFFSET = 100;

  let offset = 0;
  if (polygonOnLeft) {
    offset = -MAX_OFFSET;
    logger.info(
      "[PDFKit] 📍 Polygon on LEFT → shifting map LEFT by 100pt to create right-side space"
    );
  } else {
    offset = +MAX_OFFSET;
    logger.info(
      "[PDFKit] 📍 Polygon on RIGHT → shifting map RIGHT by 100pt to create left-side space"
    );
  }

  logger.info({
    msg: "[PDFKit] 🎯 Dynamic map positioning",
    polygonCenter: polygonCenterX.toFixed(1),
    mapCenter: mapCenterX.toFixed(1),
    polygonSide: polygonOnLeft ? "left" : "right",
    offset: offset,
    newMapX: (mapBounds.x + offset).toFixed(1),
  });

  return offset;
}

// ── PDF-coordinate helpers ───────────────────────────────────────────────────

export function isPointInsidePolygonPDF(point, polygon, extent, mapBounds) {
  const pdfPolygon = polygon.map((coord) =>
    transformCoords(coord[0], coord[1], extent, mapBounds)
  );

  let inside = false;
  for (let i = 0, j = pdfPolygon.length - 1; i < pdfPolygon.length; j = i++) {
    const xi = pdfPolygon[i].x,
      yi = pdfPolygon[i].y;
    const xj = pdfPolygon[j].x,
      yj = pdfPolygon[j].y;

    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function isRectOverlappingPolygon(rect, polygon, extent, mapBounds) {
  const testPoints = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x + rect.width / 2, y: rect.y },
    { x: rect.x + rect.width / 2, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height / 2 },
    { x: rect.x + rect.width, y: rect.y + rect.height / 2 },
    { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
  ];

  for (const point of testPoints) {
    if (isPointInsidePolygonPDF(point, polygon, extent, mapBounds)) {
      return true;
    }
  }
  return false;
}

export function isRectClearOfPolygonBoundary(
  rect,
  polygon,
  extent,
  mapBounds,
  bufferPt
) {
  const expandedRect = {
    x: rect.x - bufferPt,
    y: rect.y - bufferPt,
    width: rect.width + bufferPt * 2,
    height: rect.height + bufferPt * 2,
  };

  return !isRectOverlappingPolygon(expandedRect, polygon, extent, mapBounds);
}

export function isPointInPolygonPDF(point, polygon) {
  let inside = false;
  const x = point.x;
  const y = point.y;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

// ── Rectangle / polygon overlap ──────────────────────────────────────────────

export function rectangleOverlapsPolygon(rect, polygon, buffer = 0) {
  const expandedRect = {
    x: rect.x - buffer,
    y: rect.y - buffer,
    width: rect.width + 2 * buffer,
    height: rect.height + 2 * buffer,
  };

  const corners = [
    { x: expandedRect.x, y: expandedRect.y },
    { x: expandedRect.x + expandedRect.width, y: expandedRect.y },
    {
      x: expandedRect.x + expandedRect.width,
      y: expandedRect.y + expandedRect.height,
    },
    { x: expandedRect.x, y: expandedRect.y + expandedRect.height },
  ];

  for (const corner of corners) {
    if (
      isPointInPolygon(
        [corner.y, corner.x],
        polygon.map((p) => [p.y, p.x])
      )
    ) {
      return true;
    }
  }

  for (const vertex of polygon) {
    const vx = vertex.x;
    const vy = vertex.y;
    if (
      vx >= expandedRect.x &&
      vx <= expandedRect.x + expandedRect.width &&
      vy >= expandedRect.y &&
      vy <= expandedRect.y + expandedRect.height
    ) {
      return true;
    }
  }

  const rectEdges = [
    {
      x1: expandedRect.x,
      y1: expandedRect.y,
      x2: expandedRect.x + expandedRect.width,
      y2: expandedRect.y,
    },
    {
      x1: expandedRect.x + expandedRect.width,
      y1: expandedRect.y,
      x2: expandedRect.x + expandedRect.width,
      y2: expandedRect.y + expandedRect.height,
    },
    {
      x1: expandedRect.x + expandedRect.width,
      y1: expandedRect.y + expandedRect.height,
      x2: expandedRect.x,
      y2: expandedRect.y + expandedRect.height,
    },
    {
      x1: expandedRect.x,
      y1: expandedRect.y + expandedRect.height,
      x2: expandedRect.x,
      y2: expandedRect.y,
    },
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

export function lineSegmentsIntersect(seg1, seg2) {
  const { x1: x1, y1: y1, x2: x2, y2: y2 } = seg1;
  const { x1: x3, y1: y3, x2: x4, y2: y4 } = seg2;

  const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);

  if (Math.abs(denom) < 1e-10) {
    return false;
  }

  const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
  const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;

  return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
}

export function rectanglesOverlap(rect1, rect2, buffer = 10) {
  return !(
    rect1.x + rect1.width + buffer < rect2.x ||
    rect2.x + rect2.width + buffer < rect1.x ||
    rect1.y + rect1.height + buffer < rect2.y ||
    rect2.y + rect2.height + buffer < rect1.y
  );
}
