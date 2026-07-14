// FORCE RELOAD: 2026-02-25-21:24 - re-enable retry + relaxed stacker scan - CACHE BUST
import { writeFile, unlink, mkdir } from "fs/promises";
import { createWriteStream } from "fs";
import { PassThrough } from "stream";
import PDFDocument from "pdfkit";
import {
  SI727_PRESCRIBED_SCALES,
  SI727_SHEET_SIZES,
  SI727_MARGINS,
} from "../utils/si727Constants.js";
import BLOCKS from "../../../app-shared/block-definitions.js";
import { computeScheduleColumnWidths, edgeDistanceMetres, classifyBeaconGroups, resolveLoSystem, snapScaleBarSegment } from "../../../app-shared/block-definitions.js";
import { SHEET_ORDER, MAX_SHEET_UP_ATTEMPTS, nextSheetUp } from '../../../app-shared/sheetEscalation.js';
import { extractScheduleRow } from './dxfScheduleHelpers.js';
import { analyzeSafeAreas } from "./analyzeSafeAreas.js";
import { getOutsideFigureVertices } from "./outsideFigureBeacons.js";
import { LabelingSystem } from "./pdfkitLabeling.js";
import { bankersRound, roundBearingSouth, degToDMS } from "../utils/zim-geo.js";
import { TrueGeoPDFGenerator, GeospatialFeature } from "./trueGeoPDF.js";
import { LayerManager } from "./layerManager.js";
import { AdaptiveRenderer } from "./adaptiveRenderer.js";
import { boxesIntersect, isRectWithinBounds } from "../utils/collisionPrimitives.js";
import { placeBlocks } from "./blockPlacementEngine.js";
import { findPoleOfInaccessibility } from '../utils/labelPlacer.js';
import { planSheetLayout } from './sheetLayoutPlanner.js';
import { buildPolygonForPlanner, buildPlannerObstacles } from './polygonForPlanner.js';
import {
  PT_TO_MM, MM_TO_PT,
  calculateCentroid, isPointInPolygon, pointDistance, pointToLineDistance,
  isPointNearPolygon, hasBlockToBlockCollision, distanceToSegment,
  analyzeParcelGeometry, calculateLocalParcelWidth, lineIntersection,
  isRectOutsidePolygons, tryTightFullBeaconLabelPosition,
  nudgeOutsideFullBeaconLabelTowardCircle, isLabelBoxInsideParcelPDF,
  isPointInPolygonSimple, calculatePolygonArea, findLargestInscribedCircle,
  normalizeCapeLoYX, transformCoords, calculateMapBounds,
  calculatePolygonPDFBounds, calculateDynamicMapOffset,
  isPointInsidePolygonPDF, isRectOverlappingPolygon, isRectClearOfPolygonBoundary,
  isPointInPolygonPDF, rectangleOverlapsPolygon, lineSegmentsIntersect,
  rectanglesOverlap
} from './pdfkitGeoPDF/geometry.js';
import { InsetManager } from './pdfkitGeoPDF/insetManager.js';

/**
 * PDFKit-based GeoPDF Generator with SI 727 Compliance
 * Generates professional cadastral survey plans per Zimbabwe SI 727 of 1979
 */

// SI 727 of 1979 Section 62 - Prescribed page sizes for general plans
// Original SI 727 Section 62(1) sizes: 500x400mm, 800x500mm, 1000x800mm
// Current practice (approved by Surveyor-General): ISO A-series landscape
//   ISO A2: 594mm x 420mm  |  ISO A1: 841mm x 594mm  |  ISO A0: 1189mm x 841mm
// Page size selection is handled by selectPageSize() using SI727_SHEET_SIZES from si727Constants.js

/**
 * Calculate optimal position for stand/parcel number label (at centroid)
 * Returns position inside parcel with appropriate font size
 */
function calculateStandLabelPosition(
  parcelCoords,
  standNumber,
  doc,
  extent,
  mapBounds
) {
  // Calculate centroid in Cape Lo coordinates
  const centroid = calculateCentroid(parcelCoords);

  // Check if centroid is inside polygon
  const centroidInside = isPointInPolygon(
    [centroid.y, centroid.x],
    parcelCoords
  );

  let labelPoint;
  if (centroidInside) {
    labelPoint = centroid;
  } else {
    // Fallback: use largest inscribed circle center
    labelPoint = findLargestInscribedCircle(parcelCoords);
  }

  // Transform to PDF coordinates
  const pdfPos = transformCoords(labelPoint.y, labelPoint.x, extent, mapBounds);

  // Convert parcel to PDF coordinates for bounds checking
  const pdfParcelCoords = parcelCoords.map((c) =>
    transformCoords(c[0], c[1], extent, mapBounds)
  );

  // Calculate parcel bounding box in PDF space
  const minX = Math.min(...pdfParcelCoords.map((p) => p.x));
  const maxX = Math.max(...pdfParcelCoords.map((p) => p.x));
  const minY = Math.min(...pdfParcelCoords.map((p) => p.y));
  const maxY = Math.max(...pdfParcelCoords.map((p) => p.y));
  const parcelWidth = maxX - minX;
  const parcelHeight = maxY - minY;

  // Adaptive stand label sizing: start at 14pt, scale down to fit parcel, minimum 8pt
  const area = calculatePolygonArea(parcelCoords);
  let fontSize = 14; // Base: matches reference survey plan

  if (area > 10000) {
    fontSize = 16; // Large parcel — slightly larger
  } else if (area > 2000) {
    fontSize = 14;
  } else if (area > 500) {
    fontSize = 12;
  } else if (area > 100) {
    fontSize = 10;
  } else {
    fontSize = 8; // Very small parcel
  }
  // Cartographic hierarchy: a stand number is a feature label and must not
  // out-rank the 14 pt (~5 mm) designation title. Cap at 10 pt (~3.5 mm); the
  // fit-to-parcel logic below may still shrink it further. Mirrors the DXF cap.
  fontSize = Math.min(fontSize, 10);

  // Reserve space for edge labels (distance + bearing stacked alongside each edge)
  const edgeLabelReserve = 25;
  const maxAllowedWidth = Math.max(15, parcelWidth - edgeLabelReserve * 2);
  const maxAllowedHeight = Math.max(10, parcelHeight - edgeLabelReserve * 2);
  const maxWidthRatio = maxAllowedWidth * 0.5;
  const maxHeightRatio = maxAllowedHeight * 0.5;

  // Iteratively reduce font size until label fits within constrained bounds
  let labelWidth = doc.widthOfString(standNumber, {
    font: "Helvetica-Bold",
    fontSize,
  });
  let labelHeight = fontSize * 1.2;

  while (
    (labelWidth > maxWidthRatio || labelHeight > maxHeightRatio) &&
    fontSize > 8
  ) {
    fontSize -= 1;
    labelWidth = doc.widthOfString(standNumber, {
      font: "Helvetica-Bold",
      fontSize,
    });
    labelHeight = fontSize * 1.2;
  }

  return {
    x: pdfPos.x - labelWidth / 2,
    y: pdfPos.y - labelHeight / 2,
    fontSize,
    width: labelWidth,
    height: labelHeight,
  };
}

/**
 * Calculate polygon area (simple method for sizing)
 */
/**
 * Calculate beacon label position inside parcel (toward centroid)
 */
/**
 * Calculate beacon label position along beacon-to-centroid direction
 * Ensures label is inside parcel, clear of beacon circle, and away from edges
 *
 * STRATEGY:
 * 1. Calculate direction vector from beacon center to parcel centroid
 * 2. Try multiple offset distances along this direction
 * 3. For each offset, validate label bounding box is fully inside parcel
 * 4. Ensure minimum clearance from beacon circle and parcel edges
 * 5. Return first valid position, or null if none found
 */
/**
 * ENHANCED: Multi-strategy beacon label positioning for all parcel geometries
 * Analyzes parcel shape and tries multiple search strategies to find valid positions
 * Particularly effective for narrow rectangular parcels where centroid-directed fails
 */
function calculateBeaconLabelPositionInsideParcel(
  beaconPos,
  parcelCoords,
  beaconName,
  doc,
  extent,
  mapBounds,
  labelText,
  fontSize,
  beaconRadius,
  logger,
  collisionDetector = null
) {
  if (!logger) {
    logger = console;
  }

  logger.info(
    `[LABEL-PLACEMENT] 🎯 Starting for beacon "${beaconName}", label "${labelText}"`
  );
  logger.info(
    `[LABEL-PLACEMENT] Beacon position: (${beaconPos.x.toFixed(
      2
    )}, ${beaconPos.y.toFixed(2)})`
  );

  // Calculate label dimensions
  const labelWidth = doc.widthOfString(labelText, { size: fontSize });
  const labelHeight = fontSize * 1.2;
  logger.info(
    `[LABEL-PLACEMENT] Label dimensions: ${labelWidth.toFixed(
      2
    )}pt × ${labelHeight.toFixed(2)}pt`
  );

  // STRATEGY 1: Analyze parcel geometry to determine optimal search directions
  const geometryAnalysis = analyzeParcelGeometryForLabeling(
    parcelCoords,
    beaconPos,
    logger
  );

  // STRATEGY 2: Generate comprehensive search directions based on geometry
  const searchDirections = generateSearchDirections(
    geometryAnalysis,
    beaconPos,
    parcelCoords,
    logger
  );

  // STRATEGY 3: Try each search direction with multiple offset distances
  const minOffset = beaconRadius + 0.5; // Minimum: 0.5pt clearance from beacon circle
  const maxOffset = beaconRadius * 8; // Maximum: 8× radius for wide search
  const steps = 15; // Try 15 positions along each direction

  logger.info(
    `[LABEL-PLACEMENT] Trying ${
      searchDirections.length
    } directions × ${steps} offsets = ${
      searchDirections.length * steps
    } positions`
  );

  let _firstValidFallback = null; // First parcel-valid position (collision tolerated)

  for (const direction of searchDirections) {
    for (let i = 0; i < steps; i++) {
      const offset = minOffset + (maxOffset - minOffset) * (i / (steps - 1));

      // Calculate label center position
      const centerX = beaconPos.x + direction.dx * offset;
      const centerY = beaconPos.y + direction.dy * offset;

      // Convert to top-left corner for rendering
      const labelX = centerX - labelWidth / 2;
      const labelY = centerY - labelHeight / 2;

      // Validate: Label must be fully inside parcel
      if (
        !isBeaconLabelInsideParcel(
          labelX,
          labelY,
          labelWidth,
          labelHeight,
          parcelCoords
        )
      ) {
        continue;
      }

      // Validate: Label must not overlap beacon circle
      const closestX = Math.max(
        labelX,
        Math.min(beaconPos.x, labelX + labelWidth)
      );
      const closestY = Math.max(
        labelY,
        Math.min(beaconPos.y, labelY + labelHeight)
      );
      const distToBeacon = Math.sqrt(
        Math.pow(closestX - beaconPos.x, 2) +
          Math.pow(closestY - beaconPos.y, 2)
      );

      if (distToBeacon < beaconRadius + 0.5) {
        continue;
      }

      // Validate: Check minimum distance from parcel edges (relaxed for suffix labels)
      let minEdgeDist = Infinity;
      const labelCorners = [
        { x: labelX, y: labelY },
        { x: labelX + labelWidth, y: labelY },
        { x: labelX, y: labelY + labelHeight },
        { x: labelX + labelWidth, y: labelY + labelHeight },
      ];

      for (const corner of labelCorners) {
        for (let j = 0; j < parcelCoords.length - 1; j++) {
          const dist = distanceFromPointToSegmentPDF(
            corner,
            parcelCoords[j],
            parcelCoords[j + 1]
          );
          minEdgeDist = Math.min(minEdgeDist, dist);
        }
      }

      // Accept if at least 0.5pt clearance from edges (relaxed from 1pt)
      if (minEdgeDist >= 0.5) {
        // Pass 1: prefer collision-free positions
        if (!collisionDetector || !collisionDetector.hasCollision(labelX, labelY, labelWidth, labelHeight, 1)) {
          logger.info(
            `[LABEL-PLACEMENT] ✅ VALID POSITION (collision-free): direction="${
              direction.name
            }", offset=${offset.toFixed(1)}pt, clearance=${minEdgeDist.toFixed(
              1
            )}pt`
          );
          return { x: labelX, y: labelY };
        }
        // Store first valid-but-colliding position as fallback
        if (!_firstValidFallback) {
          _firstValidFallback = { x: labelX, y: labelY };
        }
      }
    }
  }

  // Pass 2: return first parcel-valid position even if it collides
  if (_firstValidFallback) {
    logger.info(
      `[LABEL-PLACEMENT] ⚡ Using fallback position (collision tolerated) for "${beaconName}"`
    );
    return _firstValidFallback;
  }

  logger.info(
    `[LABEL-PLACEMENT] ❌ NO VALID POSITION FOUND after trying ${
      searchDirections.length * steps
    } positions`
  );
  return null;
}

/**
 * Analyze parcel geometry to determine shape characteristics
 * Returns: { centroid, isNarrow, longAxisAngle, shortAxisLength, aspectRatio }
 */
function analyzeParcelGeometryForLabeling(parcelCoords, beaconPos, logger) {
  // Calculate centroid
  const centroid = calculateCentroidFromPDFCoords(parcelCoords);

  // Calculate bounding box to determine aspect ratio
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const coord of parcelCoords) {
    minX = Math.min(minX, coord.x);
    maxX = Math.max(maxX, coord.x);
    minY = Math.min(minY, coord.y);
    maxY = Math.max(maxY, coord.y);
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const aspectRatio = Math.max(width, height) / Math.min(width, height);
  const isNarrow = aspectRatio > 2.5; // Narrow if aspect ratio > 2.5:1

  // Determine long axis angle (for narrow parcels)
  const longAxisAngle = width > height ? 0 : Math.PI / 2; // 0° for horizontal, 90° for vertical
  const shortAxisLength = Math.min(width, height);

  logger.info(
    `[GEOMETRY] Parcel analysis: ${width.toFixed(1)}×${height.toFixed(
      1
    )}pt, aspect=${aspectRatio.toFixed(1)}, narrow=${isNarrow}`
  );

  return { centroid, isNarrow, longAxisAngle, shortAxisLength, aspectRatio };
}

/**
 * Generate search directions based on parcel geometry
 * For narrow parcels: prioritize directions along long axis
 * For regular parcels: prioritize direction toward centroid
 */
function generateSearchDirections(geometry, beaconPos, parcelCoords, logger) {
  const directions = [];

  // PRIORITY 1: Direction toward centroid (always try this first)
  const toCentroidDx = geometry.centroid.x - beaconPos.x;
  const toCentroidDy = geometry.centroid.y - beaconPos.y;
  const toCentroidDist = Math.sqrt(
    toCentroidDx * toCentroidDx + toCentroidDy * toCentroidDy
  );

  if (toCentroidDist > 0) {
    directions.push({
      name: "toward-centroid",
      dx: toCentroidDx / toCentroidDist,
      dy: toCentroidDy / toCentroidDist,
      priority: 1,
    });
  }

  // PRIORITY 2: For narrow parcels, try directions along long axis
  if (geometry.isNarrow) {
    // Long axis directions (parallel to long edge)
    const longAxisDx = Math.cos(geometry.longAxisAngle);
    const longAxisDy = Math.sin(geometry.longAxisAngle);

    directions.push(
      {
        name: "along-long-axis-positive",
        dx: longAxisDx,
        dy: longAxisDy,
        priority: 2,
      },
      {
        name: "along-long-axis-negative",
        dx: -longAxisDx,
        dy: -longAxisDy,
        priority: 2,
      }
    );

    logger.info(
      `[GEOMETRY] Narrow parcel detected - adding long-axis search directions`
    );
  }

  // PRIORITY 3: Find nearest parcel edge and try perpendicular inward direction
  const nearestEdge = findNearestParcelEdge(beaconPos, parcelCoords);
  if (nearestEdge) {
    // Calculate perpendicular to edge, pointing inward
    const edgeDx = nearestEdge.end.x - nearestEdge.start.x;
    const edgeDy = nearestEdge.end.y - nearestEdge.start.y;
    const edgeLength = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);

    if (edgeLength > 0) {
      // Perpendicular vectors (rotate 90°)
      const perp1Dx = -edgeDy / edgeLength;
      const perp1Dy = edgeDx / edgeLength;
      const perp2Dx = edgeDy / edgeLength;
      const perp2Dy = -edgeDx / edgeLength;

      // Test which perpendicular points toward centroid (inward)
      const dot1 = perp1Dx * toCentroidDx + perp1Dy * toCentroidDy;
      const dot2 = perp2Dx * toCentroidDx + perp2Dy * toCentroidDy;

      if (dot1 > dot2) {
        directions.push({
          name: "perpendicular-to-edge",
          dx: perp1Dx,
          dy: perp1Dy,
          priority: 3,
        });
      } else {
        directions.push({
          name: "perpendicular-to-edge",
          dx: perp2Dx,
          dy: perp2Dy,
          priority: 3,
        });
      }
    }
  }

  // PRIORITY 4: Try 8 cardinal/diagonal directions as fallback
  const cardinalDirections = [
    { name: "east", dx: 1, dy: 0, priority: 4 },
    { name: "northeast", dx: 0.707, dy: -0.707, priority: 4 },
    { name: "north", dx: 0, dy: -1, priority: 4 },
    { name: "northwest", dx: -0.707, dy: -0.707, priority: 4 },
    { name: "west", dx: -1, dy: 0, priority: 4 },
    { name: "southwest", dx: -0.707, dy: 0.707, priority: 4 },
    { name: "south", dx: 0, dy: 1, priority: 4 },
    { name: "southeast", dx: 0.707, dy: 0.707, priority: 4 },
  ];

  directions.push(...cardinalDirections);

  // Sort by priority (lower number = higher priority)
  directions.sort((a, b) => a.priority - b.priority);

  logger.info(
    `[GEOMETRY] Generated ${
      directions.length
    } search directions, priorities: ${directions
      .map((d) => d.name)
      .join(", ")}`
  );

  return directions;
}

/**
 * Find the nearest parcel edge to the beacon position
 */
function findNearestParcelEdge(beaconPos, parcelCoords) {
  let minDist = Infinity;
  let nearestEdge = null;

  for (let i = 0; i < parcelCoords.length - 1; i++) {
    const start = parcelCoords[i];
    const end = parcelCoords[i + 1];
    const dist = distanceFromPointToSegmentPDF(beaconPos, start, end);

    if (dist < minDist) {
      minDist = dist;
      nearestEdge = { start, end, distance: dist };
    }
  }

  return nearestEdge;
}

function calculateSuffixBeaconLabelOnEdge(
  beaconPos,
  parcelPdfCoords,
  labelText,
  doc,
  scale,
  beaconRadius,
  fontSize,
  collisionDetector = null
) {
  if (!Array.isArray(parcelPdfCoords) || parcelPdfCoords.length < 3) return null;
  if (!labelText) return null;

  const nRaw = parcelPdfCoords.length;
  const last = parcelPdfCoords[nRaw - 1];
  const first = parcelPdfCoords[0];
  const isClosed =
    last &&
    first &&
    Math.abs(last.x - first.x) < 0.001 &&
    Math.abs(last.y - first.y) < 0.001;
  const n = isClosed ? nRaw - 1 : nRaw;
  if (n < 3) return null;

  let bestIdx = -1;
  let bestD2 = Infinity;
  for (let i = 0; i < n; i++) {
    const v = parcelPdfCoords[i];
    const dx = v.x - beaconPos.x;
    const dy = v.y - beaconPos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestIdx = i;
    }
  }

  const snapTol = Math.max(3, beaconRadius * 4);
  if (!Number.isFinite(bestD2) || bestD2 > snapTol * snapTol) return null;

  const labelWidth = doc.widthOfString(labelText, {
    font: "Helvetica-Bold",
    size: fontSize,
  });
  const labelHeight = fontSize * 1.2;

  const mmPerPoint = 0.352778;
  // Fixed 3mm clearance from edge line at print scale (same as edge labels)
  const distanceBaseOffset = 3 / mmPerPoint; // 3mm → pt ≈ 8.504pt

  const ring = parcelPdfCoords.slice(0, n);
  const polygon = ring.map((p) => [p.x, p.y]);
  const centroid = calculateCentroidFromPDFCoords(ring);

  const i = bestIdx;
  const forwardStart = ring[i];
  const forwardEnd = ring[(i + 1) % n];
  const backwardStart = ring[(i - 1 + n) % n];
  const backwardEnd = ring[i];

  const computeAngle = (start, end) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
    if (angle > 90 || angle < -90) angle += 180;
    return angle;
  };

  const forwardAngle = computeAngle(forwardStart, forwardEnd);

  const tryEdge = (start, end, angle) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (!Number.isFinite(len) || len < 1e-6) return null;
    const tx = dx / len;
    const ty = dy / len;

    let perpX = -ty;
    let perpY = tx;
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const toCentroidX = centroid.x - midX;
    const toCentroidY = centroid.y - midY;
    const dot = perpX * toCentroidX + perpY * toCentroidY;
    if (dot < 0) { perpX = -perpX; perpY = -perpY; }

    const along = beaconRadius + labelWidth / 2 + 0.8;
    // Collect polygon-valid candidates, prefer collision-free
    const _candidates = [];
    const _tryCandidate = (cx, cy) => {
      if (!isPointInPolygonSimple([cx, cy], polygon)) return;
      const lx = cx - labelWidth / 2, ly = cy - labelHeight / 2;
      const noCollision = !collisionDetector || !collisionDetector.hasCollision(lx, ly, labelWidth, labelHeight, 2);
      _candidates.push({ placed: true, x: lx, y: ly, angle, noCollision });
    };
    // Primary position (inward perp)
    _tryCandidate(start.x + tx * along + perpX * distanceBaseOffset, start.y + ty * along + perpY * distanceBaseOffset);
    // Reduced offset (half clearance)
    _tryCandidate(start.x + tx * along + perpX * (distanceBaseOffset * 0.5), start.y + ty * along + perpY * (distanceBaseOffset * 0.5));
    // Directly toward centroid from vertex
    const toCx = centroid.x - start.x;
    const toCy = centroid.y - start.y;
    const toCLen = Math.sqrt(toCx * toCx + toCy * toCy) || 1;
    _tryCandidate(start.x + (toCx / toCLen) * distanceBaseOffset, start.y + (toCy / toCLen) * distanceBaseOffset);
    // Return first collision-free, or first polygon-valid
    const best = _candidates.find(c => c.noCollision) || _candidates[0];
    return best || null;
  };

  return (
    tryEdge(forwardStart, forwardEnd, forwardAngle) ||
    tryEdge(backwardStart, backwardEnd, computeAngle(backwardStart, backwardEnd)) ||
    { placed: false, x: null, y: null, angle: forwardAngle }
  );
}

function findParcelsWithBeaconVertex(beaconCoords, parcels, tolerance = 0.01) {
  if (!beaconCoords || !parcels || !Array.isArray(parcels.features)) return [];
  const by = beaconCoords[0];
  const bx = beaconCoords[1];
  if (![by, bx].every(Number.isFinite)) return [];
  const tol2 = tolerance * tolerance;
  return parcels.features.filter((p) => {
    let coords = p?.geometry?.coordinates?.[0];
    if (!Array.isArray(coords) || coords.length < 2) return false;
    if (coords.length === 1 && Array.isArray(coords[0]) && Array.isArray(coords[0][0])) coords = coords[0];
    return coords.some((coord) => {
      const dy = coord[0] - by;
      const dx = coord[1] - bx;
      return dy * dy + dx * dx < tol2;
    });
  });
}

function calculateFullBeaconLabelOutsideOnEdge(
  beaconPos,
  parcelPdfCoordsList,
  labelText,
  doc,
  scale,
  beaconRadius,
  fontSize,
  fontFamily,
  collisionDetector
) {
  if (!Array.isArray(parcelPdfCoordsList) || parcelPdfCoordsList.length === 0)
    return null;
  if (!labelText) return null;

  const labelWidth = doc.widthOfString(labelText, {
    font: fontFamily,
    size: fontSize,
  });
  const labelHeight = fontSize * 1.2;

  const scaleValue = Number(scale?.value) || 500;
  const groundClearanceMeters = 1.5;
  const mmPerPoint = 0.352778;
  const clearanceOnPageMM = groundClearanceMeters * 1000 * (1 / scaleValue);
  const clearanceOnPagePt = clearanceOnPageMM / mmPerPoint;
  const distanceBaseOffset = Math.max(1.5, Math.min(6, clearanceOnPagePt));

  const snapTol = Math.max(3, beaconRadius * 4);
  const offsetMultipliers = [1, 1.25, 1.5, 1.8, 2.1];

  const parsed = [];
  for (const parcelPdfCoords of parcelPdfCoordsList) {
    if (!Array.isArray(parcelPdfCoords) || parcelPdfCoords.length < 3) continue;

    const nRaw = parcelPdfCoords.length;
    const last = parcelPdfCoords[nRaw - 1];
    const first = parcelPdfCoords[0];
    const isClosed =
      last &&
      first &&
      Math.abs(last.x - first.x) < 0.001 &&
      Math.abs(last.y - first.y) < 0.001;
    const n = isClosed ? nRaw - 1 : nRaw;
    if (n < 3) continue;

    const ring = parcelPdfCoords.slice(0, n);
    const polygon = ring.map((p) => [p.x, p.y]);
    const centroid = calculateCentroidFromPDFCoords(ring);
    parsed.push({ ring, polygon, centroid, n });
  }

  if (parsed.length === 0) return null;

  const isInsideAnyIncidentParcel = (x, y) => {
    for (const p of parsed) {
      if (isPointInPolygonSimple([x, y], p.polygon)) return true;
    }
    return false;
  };

  for (const p of parsed) {
    const ring = p.ring;
    const polygon = p.polygon;
    const centroid = p.centroid;
    const n = p.n;

    let bestIdx = -1;
    let bestD2 = Infinity;
    for (let i = 0; i < n; i++) {
      const v = ring[i];
      const dx = v.x - beaconPos.x;
      const dy = v.y - beaconPos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        bestIdx = i;
      }
    }
    if (!Number.isFinite(bestD2) || bestD2 > snapTol * snapTol) continue;

    const i = bestIdx;
    const forwardStart = ring[i];
    const forwardEnd = ring[(i + 1) % n];
    const backwardStart = ring[(i - 1 + n) % n];
    const backwardEnd = ring[i];

    const computeOutward = (start, end) => {
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (!Number.isFinite(len) || len < 1e-6) return null;
      const tx = dx / len;
      const ty = dy / len;
      let perpX = -ty;
      let perpY = tx;
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      const toCentroidX = centroid.x - midX;
      const toCentroidY = centroid.y - midY;
      const dot = perpX * toCentroidX + perpY * toCentroidY;
      if (dot > 0) {
        perpX = -perpX;
        perpY = -perpY;
      }
      return { dx: perpX, dy: perpY };
    };

    const outF = computeOutward(forwardStart, forwardEnd);
    const outB = computeOutward(backwardStart, backwardEnd);
    const directions = [];
    if (outF) directions.push(outF);
    if (outB) directions.push(outB);
    if (outF && outB) {
      const bx = outF.dx + outB.dx;
      const by = outF.dy + outB.dy;
      const bl = Math.sqrt(bx * bx + by * by);
      if (Number.isFinite(bl) && bl > 1e-6) {
        directions.push({ dx: bx / bl, dy: by / bl });
      }
    }

    for (const dir of directions) {
      for (const mult of offsetMultipliers) {
        const push =
          (beaconRadius + distanceBaseOffset + labelHeight * 0.5 + 0.8) * mult;
        const centerX = beaconPos.x + dir.dx * push;
        const centerY = beaconPos.y + dir.dy * push;
        if (isInsideAnyIncidentParcel(centerX, centerY)) continue;

        const x = centerX - labelWidth / 2;
        const y = centerY - labelHeight / 2;
        if (
          collisionDetector &&
          collisionDetector.hasCollision(x, y, labelWidth, labelHeight)
        ) {
          continue;
        }
        return { x, y };
      }
    }
  }

  return null;
}

/**
 * Validate label bounding box is fully inside parcel
 */
function isLabelInsideParcel(
  labelBox,
  parcelCoords,
  extent,
  mapBounds,
  buffer = 5
) {
  // Convert buffer from mm to Cape Lo meters
  const bufferMeters =
    (buffer * 0.001 * (extent.maxY - extent.minY)) / mapBounds.width;

  // Check all 4 corners of label bounding box
  const corners = [
    { x: labelBox.x, y: labelBox.y },
    { x: labelBox.x + labelBox.width, y: labelBox.y },
    { x: labelBox.x, y: labelBox.y + labelBox.height },
    { x: labelBox.x + labelBox.width, y: labelBox.y + labelBox.height },
  ];

  for (const corner of corners) {
    // Transform PDF coords back to Cape Lo
    const capeLoY =
      extent.minY +
      ((corner.x - mapBounds.x) / mapBounds.width) *
        (extent.maxY - extent.minY);
    const capeLoX =
      extent.maxX -
      ((corner.y - mapBounds.y) / mapBounds.height) *
        (extent.maxX - extent.minX);

    // Check if point is inside polygon with buffer
    let inside = false;
    const polygon = parcelCoords;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [yi, xi] = polygon[i];
      const [yj, xj] = polygon[j];

      const intersect =
        xi > capeLoX !== xj > capeLoX &&
        capeLoY < ((yj - yi) * (capeLoX - xi)) / (xj - xi) + yi;

      if (intersect) inside = !inside;
    }

    if (!inside) {
      return false;
    }
  }

  return true;
}

/**
 * Filter parcels to only those within Outside Figure boundary + buffer
 */
function filterParcelsInBoundary(
  parcels,
  outsideFigureBoundary,
  bufferMeters,
  logger
) {
  if (!outsideFigureBoundary || outsideFigureBoundary.length === 0) {
    logger.info(
      "[PDFKit] ⚠️  No Outside Figure boundary - including all parcels"
    );
    return parcels;
  }

  const filtered = parcels.features.filter((parcel) => {
    const coords = parcel?.geometry?.coordinates?.[0];
    if (!Array.isArray(coords) || coords.length < 3) return false;

    const centroid = calculateCentroid(coords);
    if (!Number.isFinite(centroid.y) || !Number.isFinite(centroid.x)) return false;

    return isPointNearPolygon(
      [centroid.y, centroid.x],
      outsideFigureBoundary,
      bufferMeters
    );
  });

  logger.info({
    msg: "[PDFKit] 🔍 Filtered parcels by Outside Figure + buffer",
    total: parcels.features.length,
    filtered: filtered.length,
    excluded: parcels.features.length - filtered.length,
    bufferMeters,
  });

  return {
    type: "FeatureCollection",
    features: filtered,
  };
}

/**
 * Filter beacons to only those within Outside Figure + buffer zone
 */
function filterBeaconsInBoundary(
  beacons,
  outsideFigureBoundary,
  bufferMeters,
  logger
) {
  if (!outsideFigureBoundary || outsideFigureBoundary.length === 0) {
    logger.info(
      "[PDFKit] ⚠️  No Outside Figure boundary - including all beacons"
    );
    return beacons;
  }

  const filtered = beacons.features.filter((beacon) => {
    const rawPoint = beacon?.geometry?.coordinates;
    if (!Array.isArray(rawPoint) || rawPoint.length < 2) return false;
    const point = normalizeCapeLoYX(rawPoint[0], rawPoint[1]); // [Y, X]
    return isPointNearPolygon(point, outsideFigureBoundary, bufferMeters);
  });

  logger.info({
    msg: "[PDFKit] 🔍 Filtered beacons by Outside Figure + buffer",
    total: beacons.features.length,
    filtered: filtered.length,
    excluded: beacons.features.length - filtered.length,
    bufferMeters,
  });

  return {
    type: "FeatureCollection",
    features: filtered,
  };
}

/**
 * Calculate extent from Outside Figure boundary with padding to ensure containment
 * Adds 5% padding to ensure polygon stays within figure bounds after centering
 */
function calculateExtentFromOutsideFigure(outsideFigureBoundary, logger) {
  if (!outsideFigureBoundary || outsideFigureBoundary.length === 0) {
    return null;
  }

  const yValues = outsideFigureBoundary.map((p) => p[0]);
  const xValues = outsideFigureBoundary.map((p) => p[1]);

  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);

  const width = Math.max(maxY - minY, maxX - minX);
  const height = Math.max(maxY - minY, maxX - minX);

  // Add 5% padding to ensure polygon stays within bounds after centering
  const paddingFactor = 0.05;
  const paddingY = width * paddingFactor;
  const paddingX = height * paddingFactor;

  const extent = {
    minY: Math.min(minY, minX) - paddingY,
    maxY: Math.max(maxY, maxX) + paddingY,
    minX: Math.min(minY, minX) - paddingX,
    maxX: Math.max(maxY, maxX) + paddingX,
  };

  logger.info({
    msg: "[PDFKit] 📐 Calculated extent from Outside Figure boundary (with 5% padding)",
    originalExtent: {
      minY: minY.toFixed(2),
      maxY: maxY.toFixed(2),
      minX: minX.toFixed(2),
      maxX: maxX.toFixed(2),
      width: width.toFixed(2),
      height: height.toFixed(2),
    },
    paddedExtent: extent,
    padding: {
      y: `${paddingY.toFixed(2)}m`,
      x: `${paddingX.toFixed(2)}m`,
    },
    finalSize: {
      width: `${(extent.maxY - extent.minY).toFixed(2)}m`,
      height: `${(extent.maxX - extent.minX).toFixed(2)}m`,
    },
  });

  return extent;
}

/**
 * Add GeoPDF metadata (ISO 32000 standard)
 */
function addGeoreferencingMetadata(doc, projection, extent) {
  // Add custom metadata for georeferencing
  // This follows Adobe's GeoPDF specification
  doc.info.Keywords = `GeoPDF, ${projection}, Survey Plan`;
  doc.info.Subject = `Georeferenced Survey Plan in ${projection}`;

  // Store extent in custom metadata
  doc.info.GeoPDF_Projection = projection;
  doc.info.GeoPDF_Extent = `${extent.minY},${extent.minX},${extent.maxY},${extent.maxX}`;
  doc.info.GeoPDF_Units = "meters";

  return doc;
}

/**
 * Draw map border
 */
function drawMapBorder(doc, bounds) {
  doc.save();
  doc
    .rect(bounds.x, bounds.y, bounds.width, bounds.height)
    .lineWidth(1.5)
    .strokeColor("#000000")
    .stroke();
  doc.restore();
}

/**
 * Verify polygon containment within map bounds and log status
 */
function verifyPolygonContainment(coordinates, extent, mapBounds, logger) {
  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;
  let violationCount = 0;

  // Calculate polygon bounds in PDF coordinates
  coordinates.forEach((vertex, index) => {
    const point = transformCoords(vertex[0], vertex[1], extent, mapBounds);
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);

    // Check if vertex is outside bounds
    const isOutside =
      point.x < mapBounds.x ||
      point.x > mapBounds.x + mapBounds.width ||
      point.y < mapBounds.y ||
      point.y > mapBounds.y + mapBounds.height;

    if (isOutside) {
      violationCount++;
      if (violationCount <= 3) {
        logger.warn({
          msg: `[PDFKit] ⚠️ Outside Figure vertex ${index} exceeds map boundary`,
          vertex: { y: vertex[0], x: vertex[1] },
          pdfPoint: { x: point.x.toFixed(2), y: point.y.toFixed(2) },
          violations: {
            left: point.x < mapBounds.x,
            right: point.x > mapBounds.x + mapBounds.width,
            top: point.y < mapBounds.y,
            bottom: point.y > mapBounds.y + mapBounds.height,
          },
        });
      }
    }
  });

  const polygonWidth = maxX - minX;
  const polygonHeight = maxY - minY;
  const boundaryWidth = mapBounds.width;
  const boundaryHeight = mapBounds.height;
  const isContained = violationCount === 0;

  logger.info({
    msg: "[PDFKit] 📐 Outside Figure polygon containment verification",
    contained: isContained,
    violations: violationCount,
    polygonBounds: {
      x: `${minX.toFixed(2)} - ${maxX.toFixed(2)} (${polygonWidth.toFixed(
        2
      )}pt)`,
      y: `${minY.toFixed(2)} - ${maxY.toFixed(2)} (${polygonHeight.toFixed(
        2
      )}pt)`,
    },
    mapBounds: {
      x: `${mapBounds.x.toFixed(2)} - ${(mapBounds.x + mapBounds.width).toFixed(
        2
      )} (${boundaryWidth.toFixed(2)}pt)`,
      y: `${mapBounds.y.toFixed(2)} - ${(
        mapBounds.y + mapBounds.height
      ).toFixed(2)} (${boundaryHeight.toFixed(2)}pt)`,
    },
    utilization: {
      width: `${((polygonWidth / boundaryWidth) * 100).toFixed(1)}%`,
      height: `${((polygonHeight / boundaryHeight) * 100).toFixed(1)}%`,
    },
  });

  return isContained;
}

/**
 * Render Outside Figure boundary polygon from normalized GeoJSON
 * Enforces containment within map boundary
 */
function renderOutsideFigureBoundary(
  doc,
  outsideFigure,
  extent,
  mapBounds,
  logger,
  scale = null
) {
  if (
    !outsideFigure ||
    !outsideFigure.features ||
    outsideFigure.features.length === 0
  ) {
    logger.info("[PDFKit] ⚠️ No Outside Figure boundary to render");
    return;
  }

  const feature = outsideFigure.features[0];
  if (!feature || feature.geometry.type !== "Polygon") {
    logger.warn("[PDFKit] ⚠️ Outside Figure is not a Polygon");
    return;
  }

  const coordinates = feature.geometry.coordinates[0]; // Outer ring
  logger.info(
    `[PDFKit] 🔷 Rendering Outside Figure boundary (${coordinates.length} vertices)...`
  );

  // Verify polygon containment (extent padding should ensure this)
  const isContained = verifyPolygonContainment(
    coordinates,
    extent,
    mapBounds,
    logger
  );

  if (!isContained) {
    logger.warn(
      "[PDFKit] ⚠️ Outside Figure polygon exceeds map boundary despite extent padding - may need larger padding factor"
    );
  }

  // Debug: Log first vertex transformation
  const firstVertex = coordinates[0];
  // COORDINATE ORDER FIX: GeoJSON coordinates are [Y, X] (Westing, Southing)
  // transformCoords expects (y, x) parameters
  const firstPoint = transformCoords(
    firstVertex[0],
    firstVertex[1],
    extent,
    mapBounds
  );
  logger.info({
    msg: "[PDFKit] 🔍 Outside Figure first vertex",
    normalized: { y: firstVertex[0], x: firstVertex[1] },
    pdf: { x: firstPoint.x, y: firstPoint.y },
    extent,
    mapBounds,
  });

  doc.save();

  // Start from first vertex [y, x] (Cape Lo coordinates)
  doc.moveTo(firstPoint.x, firstPoint.y);

  // Draw all vertices
  coordinates.slice(1).forEach((vertex) => {
    // GeoJSON format: [Y=Westing, X=Southing]
    const point = transformCoords(vertex[0], vertex[1], extent, mapBounds);
    doc.lineTo(point.x, point.y);
  });

  // Close the polygon
  doc.closePath();

  // Style: crisp 0.8pt boundary matching surveyed parcels
  doc
    .lineWidth(0.8)
    .strokeColor("#000000")
    .fillColor("#FFFFFF", 0.9)
    .fillAndStroke();

  doc.restore();

  // Draw beacon circles at each outside figure vertex (skip closing duplicate)
  // Log-scaled beacon sizing: matches renderBeacons for consistent appearance
  const _ofSv = Number(scale?.value) || 1000;
  const _ofPtPerMM = 72 / 25.4;
  const _ofScaleFactor = 1 + 0.15 * Math.log10(Math.max(500, _ofSv) / 500);
  let _ofRadius = 0.75 * _ofScaleFactor * _ofPtPerMM;
  _ofRadius = Math.max(1.8, Math.min(3.0, _ofRadius));
  const _ofLineWidth = 0.8; // Match boundary line width

  const ofCoords = coordinates;
  const ofUnique = ofCoords[0][0] === ofCoords[ofCoords.length - 1][0] &&
    ofCoords[0][1] === ofCoords[ofCoords.length - 1][1]
    ? ofCoords.slice(0, -1)
    : ofCoords;
  ofUnique.forEach((vertex) => {
    const pt = transformCoords(vertex[0], vertex[1], extent, mapBounds);
    doc
      .circle(pt.x, pt.y, _ofRadius)
      .lineWidth(_ofLineWidth)
      .fillColor("#FFFFFF")
      .strokeColor("#000000")
      .fillAndStroke();
  });

  logger.info(
    `[PDFKit] ✅ Outside Figure boundary rendered (extent-padded for containment)`
  );

  // Render vertex labels (beacon names) outside the polygon
  if (feature.properties && feature.properties.vertices) {
    renderOutsideFigureVertexLabels(
      doc,
      coordinates,
      feature.properties.vertices,
      extent,
      mapBounds,
      logger,
      scale
    );
  } else {
    logger.info(
      "[PDFKit] ℹ️ No vertex labels for Outside Figure (properties.vertices not found)"
    );
  }
}

/**
 * Check if a point is inside a polygon (ray casting algorithm)
 * @param {Object} point - {x, y} in PDF coordinates
 * @param {Array} polygon - Array of [y, x] coordinates in Cape Lo
 * @param {Object} extent - Cape Lo extent for coordinate transformation
 * @param {Object} mapBounds - PDF map bounds for coordinate transformation
 */
/**
 * Render beacon circles and name labels at each vertex of the Outside Figure polygon
 * Uses topologically-aware labeling: labels positioned outside polygon (no leader lines)
 * Integrates with the comprehensive labeling system's rendering order (Step 1)
 */
function renderOutsideFigureVertexLabels(
  doc,
  coordinates,
  vertices,
  extent,
  mapBounds,
  logger,
  scale = null
) {
  logger.info(
    `[PDFKit] 🏷️ [TOPOLOGICAL LABELING] Rendering ${vertices.length} vertex beacons and labels for Outside Figure...`
  );
  logger.info(
    `[PDFKit] 🔧 DEBUG: minOffset=30pt, maxOffset=80pt, BOUNDARY_BUFFER=10pt`
  );

  // FIELD READABILITY: Beacon label font size for arm's length reading
  const fontSize = 10; // Bold 10pt — readable without oversized leader lines
  // Log-scaled beacon circle sizing (matches renderBeacons)
  const _vlSv = Number(scale?.value) || 1000;
  const _vlPtMM = 72 / 25.4;
  const _vlScaleFactor = 1 + 0.15 * Math.log10(Math.max(500, _vlSv) / 500);
  let beaconRadius = 0.75 * _vlScaleFactor * _vlPtMM;
  beaconRadius = Math.max(1.8, Math.min(3.0, beaconRadius));
  const beaconLineWidth = 0.8; // Match boundary line width
  const minOffset = beaconRadius + 4; // Tight to circle — avoids excessively long leader lines
  const maxOffset = 60; // Maximum offset to try (points)
  const offsetStep = 3; // Step size for increasing offset (points)
  const BOUNDARY_BUFFER = 8; // Minimum clearance from polygon boundary (points)

  logger.info(
    `[PDFKit] 🔧 DEBUG: Actual values - minOffset=${minOffset}, maxOffset=${maxOffset}, BOUNDARY_BUFFER=${BOUNDARY_BUFFER}`
  );

  // Calculate polygon centroid to determine outward direction
  let sumY = 0,
    sumX = 0;
  coordinates.forEach((coord) => {
    sumY += coord[0];
    sumX += coord[1];
  });
  const centroidY = sumY / coordinates.length;
  const centroidX = sumX / coordinates.length;

  doc.save();

  // STEP 1: Draw beacon circles at each vertex
  logger.info(
    `[PDFKit] 🔴 Drawing beacon circles at ${vertices.length} vertices...`
  );
  doc.lineWidth(beaconLineWidth).strokeColor("#000000");

  vertices.forEach((vertex, index) => {
    if (!vertex.name || index >= coordinates.length) return;

    const coord = coordinates[index];
    const point = transformCoords(coord[0], coord[1], extent, mapBounds);

    // Draw beacon circle (hollow circle with black outline)
    doc
      .circle(point.x, point.y, beaconRadius)
      .fillColor("#FFFFFF")
      .fillAndStroke();
  });

  // STEP 2: Draw leader lines and labels positioned outside polygon
  logger.info(
    `[PDFKit] 🏷️ Positioning labels outside polygon with leader lines...`
  );
  doc.fontSize(fontSize).fillColor("#000000").font("Helvetica-Bold");

  vertices.forEach((vertex, index) => {
    if (!vertex.name || index >= coordinates.length) return;

    const coord = coordinates[index];
    const point = transformCoords(coord[0], coord[1], extent, mapBounds);

    // Calculate direction away from centroid (in Cape Lo space for accuracy)
    const dy = coord[0] - centroidY;
    const dx = coord[1] - centroidX;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance === 0) return; // Skip if vertex is at centroid (shouldn't happen)

    // Normalize direction
    const dirY = dy / distance;
    const dirX = dx / distance;

    // Measure text dimensions
    const textWidth = doc.widthOfString(vertex.name);
    const textHeight = fontSize;
    const padding = 2;
    const labelWidth = textWidth + padding * 2;
    const labelHeight = textHeight + padding * 2;

    // Try increasing offsets until label is completely outside polygon AND clear of beacon circle
    let labelX, labelY, labelRect;
    let currentOffset = minOffset;
    let foundValidPosition = false;
    let attempts = 0;
    const maxAttempts = Math.ceil((maxOffset - minOffset) / offsetStep) + 1;

    while (
      currentOffset <= maxOffset &&
      !foundValidPosition &&
      attempts < maxAttempts
    ) {
      attempts++;

      // Calculate offset in PDF space
      const offsetY = dirY * currentOffset;
      const offsetX = dirX * currentOffset;

      labelX = point.x + offsetX;
      labelY = point.y - offsetY; // Negative because PDF Y increases downward

      // Define label rectangle (top-left corner and dimensions)
      labelRect = {
        x: labelX - labelWidth / 2,
        y: labelY - labelHeight / 2,
        width: labelWidth,
        height: labelHeight,
      };

      // STRICT CHECK: Label must be completely outside polygon WITH buffer clearance
      const overlapsPolygon = isRectOverlappingPolygon(
        labelRect,
        coordinates,
        extent,
        mapBounds
      );

      // Additional check: Ensure minimum distance from polygon boundary
      const hasBufferClearance =
        !overlapsPolygon &&
        isRectClearOfPolygonBoundary(
          labelRect,
          coordinates,
          extent,
          mapBounds,
          BOUNDARY_BUFFER
        );

      if (hasBufferClearance) {
        foundValidPosition = true;
        logger.info(
          `[PDFKit] ✅ Vertex ${vertex.name}: positioned at offset ${currentOffset}pt (outside polygon with ${BOUNDARY_BUFFER}pt clearance)`
        );
      } else {
        currentOffset += offsetStep;
      }
    }

    // ENFORCE: If no valid position found, force label further out
    if (!foundValidPosition) {
      logger.warn(
        `[PDFKit] ⚠️ Vertex ${vertex.name}: could not find valid position in range ${minOffset}-${maxOffset}pt`
      );
      logger.warn(
        `[PDFKit] 🔄 Trying alternative strategy: testing all 8 cardinal directions`
      );

      // Try all 8 cardinal directions (N, NE, E, SE, S, SW, W, NW) to find one that works
      const directions = [
        { dirX: 0, dirY: 1, name: "N" }, // North
        { dirX: 1, dirY: 1, name: "NE" }, // Northeast
        { dirX: 1, dirY: 0, name: "E" }, // East
        { dirX: 1, dirY: -1, name: "SE" }, // Southeast
        { dirX: 0, dirY: -1, name: "S" }, // South
        { dirX: -1, dirY: -1, name: "SW" }, // Southwest
        { dirX: -1, dirY: 0, name: "W" }, // West
        { dirX: -1, dirY: 1, name: "NW" }, // Northwest
      ];

      let bestDirection = null;
      let bestOffset = maxOffset + 20; // Start with large offset

      for (const dir of directions) {
        // Normalize direction
        const len = Math.sqrt(dir.dirX * dir.dirX + dir.dirY * dir.dirY);
        const normDirX = dir.dirX / len;
        const normDirY = dir.dirY / len;

        // Try this direction at increasing offsets
        for (
          let testOffset = minOffset;
          testOffset <= maxOffset + 20;
          testOffset += offsetStep
        ) {
          const testOffsetY = normDirY * testOffset;
          const testOffsetX = normDirX * testOffset;
          const testLabelX = point.x + testOffsetX;
          const testLabelY = point.y - testOffsetY;

          const testRect = {
            x: testLabelX - labelWidth / 2,
            y: testLabelY - labelHeight / 2,
            width: labelWidth,
            height: labelHeight,
          };

          if (
            !isRectOverlappingPolygon(testRect, coordinates, extent, mapBounds)
          ) {
            // Found valid position in this direction
            if (testOffset < bestOffset) {
              bestOffset = testOffset;
              bestDirection = {
                ...dir,
                normDirX,
                normDirY,
                offset: testOffset,
              };
            }
            break; // Found valid position in this direction, try next direction
          }
        }
      }

      if (bestDirection) {
        logger.info(
          `[PDFKit] ✅ Vertex ${vertex.name}: found valid position in ${bestDirection.name} direction at ${bestDirection.offset}pt`
        );
        currentOffset = bestDirection.offset;
        const offsetY = bestDirection.normDirY * currentOffset;
        const offsetX = bestDirection.normDirX * currentOffset;
        labelX = point.x + offsetX;
        labelY = point.y - offsetY;
        labelRect = {
          x: labelX - labelWidth / 2,
          y: labelY - labelHeight / 2,
          width: labelWidth,
          height: labelHeight,
        };
      } else {
        // Last resort: force very far out in original direction
        logger.error(
          `[PDFKit] ❌ Vertex ${
            vertex.name
          }: NO valid position found in any direction! Forcing at ${
            maxOffset + 30
          }pt`
        );
        currentOffset = maxOffset + 30;
        const offsetY = dirY * currentOffset;
        const offsetX = dirX * currentOffset;
        labelX = point.x + offsetX;
        labelY = point.y - offsetY;
        labelRect = {
          x: labelX - labelWidth / 2,
          y: labelY - labelHeight / 2,
          width: labelWidth,
          height: labelHeight,
        };
      }
    }

    // Leader lines removed per user request - beacon proximity provides sufficient visual connection

    // White rect halo for crisp field contrast
    const _beaHaloPad = Math.max(1.2, Math.min(2.5, fontSize * 0.25));
    doc
      .rect(labelRect.x + padding - _beaHaloPad, labelRect.y + padding - _beaHaloPad,
            textWidth + _beaHaloPad * 2, fontSize + _beaHaloPad * 2)
      .fillColor("#FFFFFF")
      .fill();
    // Draw label text
    doc
      .fontSize(fontSize)
      .font("Helvetica-Bold")
      .fillColor("#000000")
      .text(vertex.name, labelRect.x + padding, labelRect.y + padding, {
        width: textWidth,
        align: "center",
        lineBreak: false,
      });
  });

  doc.restore();

  logger.info(
    `[PDFKit] ✅ Outside Figure vertex labels rendered with topological awareness`
  );
}

/**
 * Render Outside Figure edge labels (DISABLED)
 * Outside Figure edge labels are skipped - only individual parcel edges are labeled
 */
function renderOutsideFigureLabels(
  doc,
  outsideFigure,
  outsideFigureData,
  extent,
  mapBounds,
  scale,
  logger
) {
  logger.info(
    "[PDFKit] ⏭️  Skipping Outside Figure edge labels (only parcel edges are labeled)"
  );
  return;
}

/**
 * Calculate tick mark positions and bounds WITHOUT rendering
 * Used to reserve space for tick marks before placing other blocks
 * Returns array of tick mark bounds that other blocks should avoid
 */
function calculateTickMarkBounds(
  outsideFigure,
  extent,
  mapBounds,
  logger,
  titleBlockBounds = null
) {
  if (
    !outsideFigure ||
    !outsideFigure.features ||
    outsideFigure.features.length === 0
  ) {
    return [];
  }

  const feature = outsideFigure.features[0];
  if (!feature || feature.geometry.type !== "Polygon") {
    return [];
  }

  const coordinates = feature.geometry.coordinates[0];

  // Calculate Cape Lo extent of the Outside Figure polygon
  let minY = Infinity,
    maxY = -Infinity,
    minX = Infinity,
    maxX = -Infinity;
  coordinates.forEach((coord) => {
    const [y, x] = normalizeCapeLoYX(coord[0], coord[1]);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  });

  // Find grid coordinates (multiples of 50) - but keep actual polygon extent for tick placement
  const GRID_INTERVAL = 50;
  const gridY_min = Math.floor(minY / GRID_INTERVAL) * GRID_INTERVAL;
  const gridY_max = Math.ceil(maxY / GRID_INTERVAL) * GRID_INTERVAL;
  const gridX_min = Math.floor(minX / GRID_INTERVAL) * GRID_INTERVAL;
  const gridX_max = Math.ceil(maxX / GRID_INTERVAL) * GRID_INTERVAL;

  // Round Y (Westing) values to nearest multiple of 5 or 10 for clean cartographic labels
  // Use multiples of 10 when the range is large (>200m), multiples of 5 otherwise
  const _yRange = maxY - minY;
  const _ySnap  = _yRange > 200 ? 10 : 5;
  const actualY_min = Math.floor(minY / _ySnap) * _ySnap; // Round down to nearest snap
  const actualY_max = Math.ceil(maxY  / _ySnap) * _ySnap; // Round up to nearest snap
  // X (Southing) values: round to nearest multiple of 50 for clean cartographic labels
  const actualX_min = Math.floor(minX / GRID_INTERVAL) * GRID_INTERVAL; // Round down to nearest 50
  const actualX_max = Math.ceil(maxX  / GRID_INTERVAL) * GRID_INTERVAL; // Round up to nearest 50

  const TICK_LENGTH = 12; // Match renderOutsideFigureTickMarks()
  const MAP_EDGE_MARGIN = 30;
  const TITLE_BLOCK_CLEARANCE = 80;

  // Adjust top X for map bounds - use actual polygon extent
  let topX = actualX_min;
  let bottomX = actualX_max;

  const topPdfPoint = transformCoords(gridY_min, gridX_min, extent, mapBounds);
  if (topPdfPoint.y < mapBounds.y + MAP_EDGE_MARGIN) {
    let adjustedX = gridX_min;
    let adjustedPdfPoint = topPdfPoint;
    while (
      adjustedPdfPoint.y < mapBounds.y + MAP_EDGE_MARGIN &&
      adjustedX < gridX_max
    ) {
      adjustedX += GRID_INTERVAL;
      adjustedPdfPoint = transformCoords(
        gridY_min,
        adjustedX,
        extent,
        mapBounds
      );
    }
    topX = adjustedX;
  }

  // Adjust for title block
  if (titleBlockBounds) {
    const adjustedTopPdfPoint = transformCoords(
      gridY_min,
      topX,
      extent,
      mapBounds
    );
    if (
      adjustedTopPdfPoint.y <
      titleBlockBounds.y + titleBlockBounds.height + TITLE_BLOCK_CLEARANCE
    ) {
      let adjustedX = topX;
      let testPdfPoint = adjustedTopPdfPoint;
      while (
        testPdfPoint.y <
          titleBlockBounds.y +
            titleBlockBounds.height +
            TITLE_BLOCK_CLEARANCE &&
        adjustedX < gridX_max
      ) {
        adjustedX += GRID_INTERVAL;
        testPdfPoint = transformCoords(gridY_min, adjustedX, extent, mapBounds);
      }
      if (adjustedX < gridX_max) topX = adjustedX;
    }
  }

  // Adjust bottom X for map bounds
  const bottomPdfPoint = transformCoords(
    gridY_min,
    gridX_max,
    extent,
    mapBounds
  );
  if (bottomPdfPoint.y > mapBounds.y + mapBounds.height - MAP_EDGE_MARGIN) {
    const adjustedX = gridX_max - GRID_INTERVAL;
    const adjustedPdfPoint = transformCoords(
      gridY_min,
      adjustedX,
      extent,
      mapBounds
    );
    if (
      adjustedPdfPoint.y <=
      mapBounds.y + mapBounds.height - MAP_EDGE_MARGIN
    ) {
      bottomX = adjustedX;
    }
  }

  // Calculate bounds for all 4 tick marks at ROUNDED polygon corners
  const tickMarks = [
    { name: "top-left",     y: actualY_min, x: topX },    // NW corner (Y rounded down)
    { name: "top-right",    y: actualY_max, x: topX },    // NE corner (Y rounded up)
    { name: "bottom-left",  y: actualY_min, x: bottomX }, // SW corner (Y rounded down)
    { name: "bottom-right", y: actualY_max, x: bottomX }, // SE corner (Y rounded up)
  ];

  const tickMarkBounds = [];

  tickMarks.forEach((tick) => {
    const pdfPoint = transformCoords(tick.y, tick.x, extent, mapBounds);

    // Check if within map Y bounds only (X check excluded: ticks are at grid Y values
    // that may be outside the figure extent in X but are still valid tick positions)
    if (
      pdfPoint.y < mapBounds.y + MAP_EDGE_MARGIN ||
      pdfPoint.y > mapBounds.y + mapBounds.height - MAP_EDGE_MARGIN
    ) {
      return;
    }

    // Calculate ACTUAL tick mark bounds based on real rendering positions
    // MUST match the exact constants used in renderOutsideFigureTickMarks()
    const FONT_SIZE = 7; // Tick mark coordinate labels — MUST match renderOutsideFigureTickMarks()
    const LABEL_OFFSET = 4; // Tight coupling - MUST match renderOutsideFigureTickMarks()
    const LABEL_CLEARANCE = 3; // Clearance between label and tick arm

    // Format coordinate to get actual label text
    const formatCoord = (value) => {
      const absValue = Math.abs(value);
      const formatted = absValue.toLocaleString("en-US").replace(/,/g, " ");
      return value >= 0 ? `+${formatted}` : `-${formatted}`;
    };

    const yLabel = `Y = ${formatCoord(tick.y)}`; // e.g., "Y = +96 450"
    const xLabel = `X = ${formatCoord(tick.x)}`; // e.g., "X = +2 247 600"

    // Estimate text widths (7pt bold font, ~4.5pt per character average)
    const CHAR_WIDTH = 4.5;
    const yLabelWidth = yLabel.length * CHAR_WIDTH; // Rotated vertical, becomes height
    const xLabelWidth = xLabel.length * CHAR_WIDTH; // Horizontal text width

    // Calculate tick mark arm endpoints
    const tickTop = pdfPoint.y - TICK_LENGTH;
    const tickBottom = pdfPoint.y + TICK_LENGTH;
    const tickLeft = pdfPoint.x - TICK_LENGTH;
    const tickRight = pdfPoint.x + TICK_LENGTH;

    // Y label: Rotated 90°, primary position = above the vertical arm tip
    // Bounds cover the text block sitting above tickTop
    const yLabelHeight = FONT_SIZE + 2;
    const yLabelLeft   = pdfPoint.x - yLabelHeight / 2;
    const yLabelRight  = pdfPoint.x + yLabelHeight / 2;
    const yLabelTop    = tickTop - LABEL_OFFSET - yLabelWidth;
    const yLabelBottom = tickTop - LABEL_OFFSET;

    // X label: Horizontal, primary position = right of the horizontal arm tip
    const xLabelHeight = FONT_SIZE + 2;
    const xLabelLeft   = tickRight + LABEL_OFFSET;
    const xLabelRight  = xLabelLeft + xLabelWidth;
    const xLabelTop    = pdfPoint.y - xLabelHeight / 2;
    const xLabelBottom = pdfPoint.y + xLabelHeight / 2;

    // Calculate bounding box that encompasses BOTH labels AND the tick cross
    // Add 5pt safety margin for collision detection
    const bounds = {
      name: `tick-${tick.name}`,
      x: Math.min(tickLeft, yLabelLeft, xLabelLeft) - 5,
      y: Math.min(tickTop, yLabelTop, xLabelTop) - 5,
      width:
        Math.max(tickRight, yLabelRight, xLabelRight) -
        Math.min(tickLeft, yLabelLeft, xLabelLeft) +
        10,
      height:
        Math.max(tickBottom, yLabelBottom, xLabelBottom) -
        Math.min(tickTop, yLabelTop, xLabelTop) +
        10,
      centerX: pdfPoint.x,
      centerY: pdfPoint.y,
      capeLo: { y: tick.y, x: tick.x },
    };

    tickMarkBounds.push(bounds);
    logger.info(
      `[PDFKit] 📐 Tick mark ${tick.name} reserved bounds: (${bounds.x.toFixed(
        0
      )}, ${bounds.y.toFixed(0)}) ${bounds.width.toFixed(

        0
      )}x${bounds.height.toFixed(0)}`
    );
  });

  return tickMarkBounds;
}

/**
 * Render tick marks around the Outside Figure polygon
 * Tick marks are placed at grid coordinates (multiples of 50)
 * Four tick marks: 2 at top (left/right), 2 at bottom (left/right)
 * Each tick mark shows Y (Westing) and X (Southing) coordinate values
 * Top tick marks avoid title block, bottom tick marks stay within map bounds
 * Labels intelligently avoid collisions with all blocks
 */
function renderOutsideFigureTickMarks(
  doc,
  outsideFigure,
  extent,
  mapBounds,
  collisionDetector,
  logger,
  titleBlockBounds = null,
  blockPositions = null,
  polygonPdfPoints = []
) {
  // - Tight label coupling: 5pt offset (was 20pt)
  // - Professional font: 8pt (was 10pt)
  // - 4 placement options per label (perpendicular to tick arms)
  // - Enhanced collision detection with all map blocks
  logger.info(
    `[PDFKit] 🎯 renderOutsideFigureTickMarks called - blockPositions: ${
      blockPositions ? "PROVIDED" : "NULL"
    }`
  );

  if (
    !outsideFigure ||
    !outsideFigure.features ||
    outsideFigure.features.length === 0
  ) {
    logger.info("[PDFKit] ⏭️  No Outside Figure for tick marks");
    return [];
  }

  const feature = outsideFigure.features[0];
  if (!feature || feature.geometry.type !== "Polygon") {
    logger.warn("[PDFKit] ⚠️ Outside Figure is not a Polygon for tick marks");
    return [];
  }

  const coordinates = feature.geometry.coordinates[0];
  logger.info(
    `[PDFKit] 📐 Generating tick marks around Outside Figure (${coordinates.length} vertices)...`
  );

  // Calculate Cape Lo extent of the Outside Figure polygon
  let minY = Infinity,
    maxY = -Infinity,
    minX = Infinity,
    maxX = -Infinity;
  coordinates.forEach((coord) => {
    // coord = [Y=Westing, X=Southing]
    const [y, x] = normalizeCapeLoYX(coord[0], coord[1]);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  });

  logger.info(
    `[PDFKit] 📐 Outside Figure Cape Lo extent: Y=[${minY.toFixed(
      0
    )}, ${maxY.toFixed(0)}], X=[${minX.toFixed(0)}, ${maxX.toFixed(0)}]`
  );

  // Find grid coordinates (multiples of 50) near the polygon corners
  // Round to nearest 50 OUTSIDE the polygon bounds
  const GRID_INTERVAL = 50; // Use multiples of 50
  const gridY_min = Math.floor(minY / GRID_INTERVAL) * GRID_INTERVAL; // Left (smaller Y = more West)
  const gridY_max = Math.ceil(maxY / GRID_INTERVAL) * GRID_INTERVAL; // Right (larger Y = more East)
  const gridX_min = Math.floor(minX / GRID_INTERVAL) * GRID_INTERVAL; // Top (smaller X = more North)
  const gridX_max = Math.ceil(maxX / GRID_INTERVAL) * GRID_INTERVAL; // Bottom (larger X = more South)

  logger.info(
    `[PDFKit] 📐 Grid tick coordinates (50m intervals): Y=[${gridY_min}, ${gridY_max}], X=[${gridX_min}, ${gridX_max}]`
  );

  // Tick mark dimensions - FIELD READABLE at arm's length
  const TICK_LENGTH = 12; // Length of each arm of the cross (pt)
  const TICK_WIDTH = 1.5; // Line width (pt) - thicker for visibility
  const LABEL_OFFSET = 4; // Offset from tick to label (pt)
  const LABEL_CLEARANCE = 3; // Minimum clearance between label and tick mark arm (pt)
  const FONT_SIZE = 7; // Tick mark coordinate labels — crisp, field-readable at print scale
  const TITLE_BLOCK_CLEARANCE = 80; // Minimum clearance from title block (pt)
  const MAP_EDGE_MARGIN = 30; // Minimum margin from map edge (pt)

  // Round Y (Westing) values to nearest multiple of 5 or 10 for clean cartographic labels
  // Use multiples of 10 when the range is large (>200m), multiples of 5 otherwise
  // This ensures tick mark labels show clean round numbers (SI 727 cartographic standard)
  const _yRange = maxY - minY;
  const _ySnap  = _yRange > 200 ? 10 : 5;
  const actualY_min = Math.floor(minY / _ySnap) * _ySnap; // Round down to nearest snap
  const actualY_max = Math.ceil(maxY  / _ySnap) * _ySnap; // Round up to nearest snap
  // X (Southing) values: round to nearest multiple of 50 for clean cartographic labels
  const actualX_min = Math.floor(minX / GRID_INTERVAL) * GRID_INTERVAL; // Round down to nearest 50
  const actualX_max = Math.ceil(maxX  / GRID_INTERVAL) * GRID_INTERVAL; // Round up to nearest 50

  // Define 4 tick mark positions at ACTUAL polygon corners
  // For top ticks, move X inward (larger X = more South) to avoid title block
  // For bottom ticks, ensure they stay within map bounds
  let topX = actualX_min;
  let bottomX = actualX_max;

  // Adjust top X to ensure it's within map bounds and below title block
  // Title block is typically at the top center of the map
  const topPdfPoint = transformCoords(gridY_min, gridX_min, extent, mapBounds);
  logger.info(
    `[PDFKit] 📐 Top tick initial position: Cape Lo X=${gridX_min}, PDF y=${topPdfPoint.y.toFixed(
      1
    )}, mapBounds.y=${mapBounds.y.toFixed(1)}`
  );
  logger.info(
    `[PDFKit] 📐 Title block bounds: ${
      titleBlockBounds
        ? `y=${titleBlockBounds.y?.toFixed(
            1
          )}, height=${titleBlockBounds.height?.toFixed(1)}`
        : "NULL"
    }`
  );

  // First ensure top ticks are within map bounds
  if (topPdfPoint.y < mapBounds.y + MAP_EDGE_MARGIN) {
    // Top tick is outside map bounds - move down
    let adjustedX = gridX_min;
    let adjustedPdfPoint = topPdfPoint;
    while (
      adjustedPdfPoint.y < mapBounds.y + MAP_EDGE_MARGIN &&
      adjustedX < gridX_max
    ) {
      adjustedX += GRID_INTERVAL;
      adjustedPdfPoint = transformCoords(
        gridY_min,
        adjustedX,
        extent,
        mapBounds
      );
    }
    topX = adjustedX;
    logger.info(
      `[PDFKit] 📐 Adjusted top tick marks from X=${gridX_min} to X=${topX} to stay within map bounds`
    );
  }

  // Then check title block collision
  const adjustedTopPdfPoint = transformCoords(
    gridY_min,
    topX,
    extent,
    mapBounds
  );
  if (
    titleBlockBounds &&
    adjustedTopPdfPoint.y <
      titleBlockBounds.y + titleBlockBounds.height + TITLE_BLOCK_CLEARANCE
  ) {
    // Move top tick marks down (increase X = move South) to clear title block
    let adjustedX = topX;
    let testPdfPoint = adjustedTopPdfPoint;
    while (
      testPdfPoint.y <
        titleBlockBounds.y + titleBlockBounds.height + TITLE_BLOCK_CLEARANCE &&
      adjustedX < gridX_max
    ) {
      adjustedX += GRID_INTERVAL;
      testPdfPoint = transformCoords(gridY_min, adjustedX, extent, mapBounds);
    }
    if (adjustedX < gridX_max) {
      topX = adjustedX;
      logger.info(
        `[PDFKit] 📐 Adjusted top tick marks to X=${topX} to avoid title block`
      );
    }
  }

  // Ensure bottom tick marks stay within map bounds
  const bottomPdfPoint = transformCoords(
    gridY_min,
    gridX_max,
    extent,
    mapBounds
  );
  if (bottomPdfPoint.y > mapBounds.y + mapBounds.height - MAP_EDGE_MARGIN) {
    // Move bottom tick marks up (decrease X = move North) to stay within map
    const adjustedX = gridX_max - GRID_INTERVAL;
    const adjustedPdfPoint = transformCoords(
      gridY_min,
      adjustedX,
      extent,
      mapBounds
    );
    if (
      adjustedPdfPoint.y <=
      mapBounds.y + mapBounds.height - MAP_EDGE_MARGIN
    ) {
      bottomX = adjustedX;
      logger.info(
        `[PDFKit] 📐 Adjusted bottom tick marks from X=${gridX_max} to X=${bottomX} to stay within map bounds`
      );
    }
  }

  const tickMarks = [
    { name: "top-left", y: actualY_min, x: topX }, // Actual NW corner (adjusted for title block)
    { name: "top-right", y: actualY_max, x: topX }, // Actual NE corner (adjusted for title block)
    { name: "bottom-left", y: actualY_min, x: bottomX }, // Actual SW corner (adjusted for map bounds)
    { name: "bottom-right", y: actualY_max, x: bottomX }, // Actual SE corner (adjusted for map bounds)
  ];

  // Compute polygon centroid in PDF space for label direction heuristic
  let _polyCx = 0, _polyCy = 0;
  if (polygonPdfPoints.length > 0) {
    for (const pt of polygonPdfPoints) { _polyCx += pt.x; _polyCy += pt.y; }
    _polyCx /= polygonPdfPoints.length;
    _polyCy /= polygonPdfPoints.length;
    logger.info(`[PDFKit] 📐 Polygon centroid for tick label direction: (${_polyCx.toFixed(0)}, ${_polyCy.toFixed(0)})`);
  }

  const placedTickMarks = [];

  tickMarks.forEach((tick) => {
    // Transform Cape Lo coordinates to PDF coordinates
    const pdfPoint = transformCoords(tick.y, tick.x, extent, mapBounds);

    // Check if tick mark is within map bounds (Y-axis only: avoid title block top and bottom edge).
    // Tick marks are intentionally placed at grid-aligned Y values that may be outside the figure
    // extent in X, so no X-margin check is applied here.
    if (
      pdfPoint.y < mapBounds.y + MAP_EDGE_MARGIN ||
      pdfPoint.y > mapBounds.y + mapBounds.height - MAP_EDGE_MARGIN
    ) {
      logger.info(
        `[PDFKit] ⏭️  Tick mark ${tick.name} at (${tick.y}, ${tick.x}) is outside map Y bounds margin, skipping`
      );
      return;
    }

    // Log tick mark position for debugging
    const isTopTick = tick.name.includes("top");
    logger.info(
      `[PDFKit] 📍 Tick mark ${tick.name}: PDF y=${pdfPoint.y.toFixed(
        1
      )}, titleBlock=${
        titleBlockBounds
          ? `y=${titleBlockBounds.y?.toFixed(
              1
            )}, h=${titleBlockBounds.height?.toFixed(1)}, bottom=${(
              titleBlockBounds.y + titleBlockBounds.height
            ).toFixed(1)}`
          : "none"
      }`
    );

    // Top tick marks are positioned below the title block by adjustment logic

    // Check collision with existing elements
    const tickBounds = {
      x: pdfPoint.x - TICK_LENGTH - 50,
      y: pdfPoint.y - TICK_LENGTH - 20,
      width: TICK_LENGTH * 2 + 100,
      height: TICK_LENGTH * 2 + 40,
    };

    // ⭐ HARD BLOCK COLLISION CHECK: Skip tick mark entirely if it overlaps any placed block
    // This prevents tick crosses from rendering over data tables (e.g. Outside Figure Data)
    if (blockPositions) {
      const blocksToAvoid = [
        blockPositions.outsideFigureData,
        blockPositions.scheduleOfAreas,
        blockPositions.beaconDescription,
        blockPositions.surveyStatement,
        blockPositions.scaleBar,
        blockPositions.sgSignature,
        titleBlockBounds,
      ].filter(Boolean);

      const tickCross = {
        x: pdfPoint.x - TICK_LENGTH - 5,
        y: pdfPoint.y - TICK_LENGTH - 5,
        width: TICK_LENGTH * 2 + 10,
        height: TICK_LENGTH * 2 + 10,
      };

      // Log overlaps for diagnostics but do NOT skip the tick cross.
      // The cross is a small geodetic reference mark that must always render.
      // Labels have their own per-placement collision detection below.
      const overlapsBlock = blocksToAvoid.some(b =>
        b.width > 0 && b.height > 0 &&
        !(tickCross.x + tickCross.width < b.x ||
          tickCross.x > b.x + b.width ||
          tickCross.y + tickCross.height < b.y ||
          tickCross.y > b.y + b.height)
      );
      if (overlapsBlock) {
        logger.info(`[PDFKit] ℹ️ Tick mark ${tick.name} cross near a placed block — rendering cross, labels will be deflected`);
      }
    }

    if (
      collisionDetector &&
      collisionDetector.hasCollision(
        tickBounds.x,
        tickBounds.y,
        tickBounds.width,
        tickBounds.height
      )
    ) {
      logger.info(
        `[PDFKit] ⚠️ Tick mark ${tick.name} collision detected, will still render`
      );
    }

    // Draw the cross/tick mark
    doc.save();
    doc.lineWidth(TICK_WIDTH).strokeColor("#000000");

    // Vertical line (|)
    doc
      .moveTo(pdfPoint.x, pdfPoint.y - TICK_LENGTH)
      .lineTo(pdfPoint.x, pdfPoint.y + TICK_LENGTH)
      .stroke();

    // Horizontal line (-)
    doc
      .moveTo(pdfPoint.x - TICK_LENGTH, pdfPoint.y)
      .lineTo(pdfPoint.x + TICK_LENGTH, pdfPoint.y)
      .stroke();

    doc.restore();

    // Format coordinate labels
    // Y = Westing (e.g., "+96 900" or "Y +96 900")
    // X = Southing (e.g., "+2 247 600" or "X +2 247 600")
    const formatCoord = (value) => {
      const absValue = Math.abs(value);
      // Format with spaces for thousands (e.g., 2 247 600)
      const formatted = absValue.toLocaleString("en-US").replace(/,/g, " ");
      return value >= 0 ? `+${formatted}` : `-${formatted}`;
    };

    const yLabel = `Y = ${formatCoord(tick.y)}`;
    const xLabel = `X = ${formatCoord(tick.x)}`;

    // Estimate label dimensions for collision detection
    // Accurate calculation for 7pt Helvetica-Bold: ~4.5pt average character width
    const CHAR_WIDTH = 4.5;
    const xLabelWidth = Math.ceil(xLabel.length * CHAR_WIDTH);
    const xLabelHeight = FONT_SIZE + 2; // Minimal padding
    const yLabelWidth = Math.ceil(yLabel.length * CHAR_WIDTH); // When rotated, this becomes height
    const yLabelHeight = FONT_SIZE + 2; // When rotated, this becomes width

    // Helper function to check if label bounds collide with a block
    const checkBlockCollision = (labelX, labelY, labelW, labelH, block) => {
      if (!block || !block.x || !block.y || !block.width || !block.height)
        return false;
      return !(
        labelX + labelW < block.x ||
        labelX > block.x + block.width ||
        labelY + labelH < block.y ||
        labelY > block.y + block.height
      );
    };

    // ========== CARTOGRAPHIC STANDARD LABEL POSITIONING ==========
    // Calculate tick mark arm endpoints for clearance checking
    const tickTop = pdfPoint.y - TICK_LENGTH;
    const tickBottom = pdfPoint.y + TICK_LENGTH;
    const tickLeft = pdfPoint.x - TICK_LENGTH;
    const tickRight = pdfPoint.x + TICK_LENGTH;

    // Default Y label position: above the vertical arm tip (cartographic standard)
    // Shift by yLabelWidth/2 so the label's near edge — not its centre — sits at the arm tip
    let yLabelTranslateX = pdfPoint.x;
    let yLabelTranslateY = tickTop - LABEL_OFFSET - yLabelWidth / 2;
    let yLabelPlacement = "above-vertical-arm";

    // Default X label position: right of the horizontal arm tip (cartographic standard)
    let xLabelX = tickRight + LABEL_OFFSET;
    let xLabelY = pdfPoint.y - xLabelHeight / 2;
    let xLabelPlacement = "right-of-horizontal-arm";

    // Track whether collision-free placement was found (default true = render when no blocks to check)
    let foundClearYPlacement = true;
    let foundClearXPlacement = true;

    // Check collision with all blocks if blockPositions provided
    if (blockPositions) {
      // Log block positions for debugging
      logger.info(
        `[PDFKit] 🔍 Tick ${tick.name} at PDF (${pdfPoint.x.toFixed(
          1
        )}, ${pdfPoint.y.toFixed(1)}) - checking collisions with blocks:`
      );
      logger.info(
        `[PDFKit]   - scaleBar: ${
          blockPositions.scaleBar
            ? `(${blockPositions.scaleBar.x?.toFixed(
                1
              )}, ${blockPositions.scaleBar.y?.toFixed(
                1
              )}) ${blockPositions.scaleBar.width?.toFixed(
                1
              )}x${blockPositions.scaleBar.height?.toFixed(1)}`
            : "undefined"
        }`
      );
      logger.info(
        `[PDFKit]   - outsideFigureData: ${
          blockPositions.outsideFigureData
            ? `(${blockPositions.outsideFigureData.x?.toFixed(
                1
              )}, ${blockPositions.outsideFigureData.y?.toFixed(
                1
              )}) ${blockPositions.outsideFigureData.width?.toFixed(
                1
              )}x${blockPositions.outsideFigureData.height?.toFixed(1)}`
            : "undefined"
        }`
      );

      const blocksToCheck = [
        { name: "titleBlock", block: titleBlockBounds },
        { name: "outsideFigureData", block: blockPositions.outsideFigureData },
        { name: "scheduleOfAreas", block: blockPositions.scheduleOfAreas },
        { name: "beaconDescription", block: blockPositions.beaconDescription },
        { name: "surveyStatement", block: blockPositions.surveyStatement },
        { name: "scaleBar", block: blockPositions.scaleBar },
        { name: "northArrow", block: blockPositions.northArrow },
      ].filter((b) => b.block); // Only check blocks that exist

      // ========== Y LABEL COLLISION DETECTION (Rotated 90°) ==========
      // Y label positioned PERPENDICULAR to vertical tick arm (cartographic standard)
      // When rotated -90°, the label extends upward from the translation point
      // Width becomes height, height becomes width after rotation
      // ⭐ EXTENDED PLACEMENTS: Added larger offsets to escape big block collisions
      // ── CARTOGRAPHIC STANDARD: labels anchored to arm tips, never detached ──
      // Y label: rotated 90°, sits along the vertical arm.
      //   Primary   → above the top arm tip (text runs upward from arm end)
      //   Fallback  → below the bottom arm tip
      //   Last resort → left / right beside the arm (perpendicular)
      const _yAbove = {
          name: "above-vertical-arm",
          translateX: pdfPoint.x,
          // Shift centre up by yLabelWidth/2 so the near edge of the label sits at the arm tip
          translateY: tickTop - LABEL_OFFSET - yLabelWidth / 2,
          boundsX: pdfPoint.x - yLabelHeight / 2,
          boundsY: tickTop - LABEL_OFFSET - yLabelWidth,
          boundsW: yLabelHeight,
          boundsH: yLabelWidth,
      };
      const _yBelow = {
          name: "below-vertical-arm",
          translateX: pdfPoint.x,
          // Shift centre down by yLabelWidth/2 so the near edge of the label sits at the arm tip
          translateY: tickBottom + LABEL_OFFSET + yLabelWidth / 2,
          boundsX: pdfPoint.x - yLabelHeight / 2,
          boundsY: tickBottom + LABEL_OFFSET,
          boundsW: yLabelHeight,
          boundsH: yLabelWidth,
      };
      const _yLeft = {
          name: "left-of-vertical-arm",
          translateX: pdfPoint.x - LABEL_OFFSET - yLabelHeight,
          translateY: pdfPoint.y,
          boundsX: pdfPoint.x - LABEL_OFFSET - yLabelHeight,
          boundsY: pdfPoint.y - yLabelWidth / 2,
          boundsW: yLabelHeight,
          boundsH: yLabelWidth,
      };
      const _yRight = {
          name: "right-of-vertical-arm",
          translateX: pdfPoint.x + LABEL_OFFSET,
          translateY: pdfPoint.y,
          boundsX: pdfPoint.x + LABEL_OFFSET,
          boundsY: pdfPoint.y - yLabelWidth / 2,
          boundsW: yLabelHeight,
          boundsH: yLabelWidth,
      };

      // Prefer above/below (arm-tip-coupled), side positions only as last resort
      let yLabelPlacements;
      if (polygonPdfPoints.length > 0) {
        const tickIsAbovePoly = pdfPoint.y < _polyCy;
        // Prefer the arm tip pointing AWAY from the polygon interior
        yLabelPlacements = tickIsAbovePoly
          ? [_yAbove, _yBelow, _yLeft, _yRight]
          : [_yBelow, _yAbove, _yLeft, _yRight];
      } else {
        yLabelPlacements = [_yAbove, _yBelow, _yLeft, _yRight];
      }

      logger.info(
        `[PDFKit] 📏 Y label "${yLabel}" dimensions: ${yLabelWidth.toFixed(
          1
        )}w x ${yLabelHeight.toFixed(1)}h (rotated)`
      );

      foundClearYPlacement = false;
      for (const placement of yLabelPlacements) {
        let hasCollision = false;
        const labelBounds = {
          x: placement.boundsX,
          y: placement.boundsY,
          right: placement.boundsX + placement.boundsW,
          bottom: placement.boundsY + placement.boundsH,
        };

        logger.info(
          `[PDFKit] 🔍 Testing Y label placement '${
            placement.name
          }': (${labelBounds.x.toFixed(1)}, ${labelBounds.y.toFixed(
            1
          )}) to (${labelBounds.right.toFixed(1)}, ${labelBounds.bottom.toFixed(
            1
          )})`
        );

        // Check block collisions only (polygon check removed: tick crosses sit on the
        // polygon boundary by definition, so arm-tip positions always falsely fail it)
        if (!hasCollision) {
          for (const { name, block } of blocksToCheck) {
            if (
              checkBlockCollision(
                placement.boundsX,
                placement.boundsY,
                placement.boundsW,
                placement.boundsH,
                block
              )
            ) {
              hasCollision = true;
              logger.info(
                `[PDFKit] ⚠️  Y label at ${tick.name} placement '${
                  placement.name
                }' collides with ${name} at (${block.x?.toFixed(
                  1
                )}, ${block.y?.toFixed(1)}) ${block.width?.toFixed(
                  1
                )}x${block.height?.toFixed(1)}`
              );
              break;
            }
          }
        }

        if (!hasCollision) {
          yLabelTranslateX = placement.translateX;
          yLabelTranslateY = placement.translateY;
          yLabelPlacement = placement.name;
          foundClearYPlacement = true;
          logger.info(
            `[PDFKit] ✅ Y label at ${tick.name} using '${placement.name}' placement (collision-free)`
          );
          break;
        }
      }

      if (!foundClearYPlacement) {
        logger.warn(
          `[PDFKit] ⚠️  Y label at ${tick.name} has collisions in all placements — skipping label`
        );
      }

      // ========== X LABEL COLLISION DETECTION ==========
      // X label positioned PERPENDICULAR to horizontal tick arm (cartographic standard)
      // ── CARTOGRAPHIC STANDARD: X label anchored to horizontal arm tips ──
      // Primary   → right of right arm tip
      // Fallback  → left of left arm tip
      // Last resort → above / below the cross centre
      const _xRight = {
          name: "right-of-horizontal-arm",
          x: tickRight + LABEL_OFFSET,
          y: pdfPoint.y - xLabelHeight / 2,
      };
      const _xLeft = {
          name: "left-of-horizontal-arm",
          x: tickLeft - LABEL_OFFSET - xLabelWidth,
          y: pdfPoint.y - xLabelHeight / 2,
      };
      const _xAbove = {
          name: "above-horizontal-arm",
          x: pdfPoint.x - xLabelWidth / 2,
          y: tickTop - LABEL_OFFSET - xLabelHeight,
      };
      const _xBelow = {
          name: "below-horizontal-arm",
          x: pdfPoint.x - xLabelWidth / 2,
          y: tickBottom + LABEL_OFFSET,
      };

      // Prefer right/left (arm-tip-coupled), above/below only as last resort
      let xLabelPlacements;
      if (polygonPdfPoints.length > 0) {
        const tickIsLeftOfPoly = pdfPoint.x < _polyCx;
        // Prefer the arm tip pointing AWAY from the polygon interior
        xLabelPlacements = tickIsLeftOfPoly
          ? [_xLeft, _xRight, _xAbove, _xBelow]
          : [_xRight, _xLeft, _xAbove, _xBelow];
      } else {
        xLabelPlacements = [_xRight, _xLeft, _xAbove, _xBelow];
      }

      logger.info(
        `[PDFKit] 📏 X label "${xLabel}" dimensions: ${xLabelWidth.toFixed(
          1
        )}w x ${xLabelHeight.toFixed(1)}h`
      );

      foundClearXPlacement = false;
      for (const placement of xLabelPlacements) {
        let hasCollision = false;
        const labelBounds = {
          x: placement.x,
          y: placement.y,
          right: placement.x + xLabelWidth,
          bottom: placement.y + xLabelHeight,
        };

        logger.info(
          `[PDFKit] 🔍 Testing X label placement '${
            placement.name
          }': (${labelBounds.x.toFixed(1)}, ${labelBounds.y.toFixed(
            1
          )}) to (${labelBounds.right.toFixed(1)}, ${labelBounds.bottom.toFixed(
            1
          )})`
        );

        // Check block collisions only (polygon check removed: same reason as Y label)
        if (!hasCollision) {
          for (const { name, block } of blocksToCheck) {
            if (
              checkBlockCollision(
                placement.x,
                placement.y,
                xLabelWidth,
                xLabelHeight,
                block
              )
            ) {
              hasCollision = true;
              logger.info(
                `[PDFKit] ⚠️  X label at ${tick.name} placement '${
                  placement.name
                }' collides with ${name} at (${block.x?.toFixed(
                  1
                )}, ${block.y?.toFixed(1)}) ${block.width?.toFixed(
                  1
                )}x${block.height?.toFixed(1)}`
              );
              break;
            }
          }
        }

        if (!hasCollision) {
          xLabelX = placement.x;
          xLabelY = placement.y;
          xLabelPlacement = placement.name;
          foundClearXPlacement = true;
          logger.info(
            `[PDFKit] ✅ X label at ${tick.name} using '${placement.name}' placement (collision-free)`
          );
          break;
        }
      }

      if (!foundClearXPlacement) {
        logger.warn(
          `[PDFKit] ⚠️  X label at ${tick.name} has collisions in all placements — skipping label`
        );
      }
    }

    // Position labels based on tick location with collision avoidance
    // Only render labels that found a collision-free position
    doc.save();
    doc.fontSize(FONT_SIZE).fillColor("#000000").font("Helvetica-Bold");

    // Y label (Westing) - always render at best arm-tip position
    {
      doc.save();
      doc.translate(yLabelTranslateX, yLabelTranslateY);
      doc.rotate(-90);
      // White rect halo for field contrast
      const _yLw = doc.widthOfString(yLabel, { font: 'Helvetica-Bold', size: FONT_SIZE });
      const _yHp = 1.5;
      doc.rect(-_yLw / 2 - _yHp, -FONT_SIZE / 2 - _yHp, _yLw + _yHp * 2, FONT_SIZE + _yHp * 2)
        .fillColor('#FFFFFF').fill();
      doc.fillColor('#000000').text(yLabel, -_yLw / 2, -FONT_SIZE / 2, { lineBreak: false });
      doc.restore();
    }

    // X label (Southing) - always render at best arm-tip position
    {
      // White rect halo for field contrast
      const _xLw = doc.widthOfString(xLabel, { font: 'Helvetica-Bold', size: FONT_SIZE });
      const _xHp = 1.5;
      doc.rect(xLabelX - _xHp, xLabelY - FONT_SIZE / 2 - _xHp, _xLw + _xHp * 2, FONT_SIZE + _xHp * 2)
        .fillColor('#FFFFFF').fill();
      doc.fillColor('#000000').text(xLabel, xLabelX, xLabelY - FONT_SIZE / 2, { lineBreak: false });
    }

    doc.restore();

    // Register tick mark for collision detection
    if (collisionDetector) {
      collisionDetector.addRegion(
        tickBounds.x,
        tickBounds.y,
        tickBounds.width,
        tickBounds.height
      );

      collisionDetector.addRegion(
        yLabelTranslateX - yLabelHeight / 2,
        yLabelTranslateY - yLabelWidth / 2,
        yLabelHeight,
        yLabelWidth
      );
      collisionDetector.addRegion(
        xLabelX,
        xLabelY,
        xLabelWidth,
        xLabelHeight
      );
    }

    placedTickMarks.push({
      name: tick.name,
      capeLo: { y: tick.y, x: tick.x },
      pdf: { x: pdfPoint.x, y: pdfPoint.y },
      bounds: tickBounds,
    });

    logger.info(
      `[PDFKit] ✅ Tick mark ${tick.name}: Cape Lo (Y=${tick.y}, X=${
        tick.x
      }) → PDF (${pdfPoint.x.toFixed(1)}, ${pdfPoint.y.toFixed(1)})`
    );
  });

  logger.info(
    `[PDFKit] ✅ Rendered ${placedTickMarks.length} tick marks around Outside Figure`
  );
  return placedTickMarks;
}

/**
 * Render parcels with styling and smart orientation-aware labels
 * Uses shared label configuration for consistency
 * Smart labeling: horizontal by default, aligned with longest side if doesn't fit
 * 
 * ENHANCED: Uses LabelingSystem from pdfkitLabeling.js for unified
 * topology-aware parcel and edge label placement with collision detection
 */
function renderParcels(
  doc,
  parcels,
  extent,
  mapBounds,
  collisionDetector,
  scale,
  logger,
  insetManager = null,
  outsideFigureBoundary = null,
  planType = 'general-undeveloped'
) {
  logger.info(`[PDFKit] 📦 Rendering ${parcels.features.length} parcels...`);

  const labelConfig = BLOCKS.LABEL_CONFIG.parcels;

  // ── LabelingSystem: unified topology-aware edge + stand label placement ────────
  const labelingSystem = new LabelingSystem(
    doc, extent, mapBounds, scale, collisionDetector, logger, planType
  );
  labelingSystem.identifySharedEdges(parcels, outsideFigureBoundary);

  // Keep edgeOccurrences reference pointing at labelingSystem for backward compat
  const edgeOccurrences = labelingSystem.edgeOccurrences;
  // Keep labeledEdges reference for backward compat with any code below
  const labeledEdges = labelingSystem.labeledEdges;

  // SI 727: Filter edge labels to only show edges inside Outside Figure
  // DISABLED: Filtering is incorrectly removing ALL edge labels - needs investigation
  const hasOutsideFigureFilter = false; // outsideFigureBoundary && Array.isArray(outsideFigureBoundary) && outsideFigureBoundary.length > 0;
  if (hasOutsideFigureFilter) {
    logger.info(
      `[PDFKit] 🔍 Edge label filtering enabled - will only show edges inside Outside Figure`
    );
    const extent = {
      minY: Math.min(...outsideFigureBoundary.map((v) => v[0])),
      maxY: Math.max(...outsideFigureBoundary.map((v) => v[0])),
      minX: Math.min(...outsideFigureBoundary.map((v) => v[1])),
      maxX: Math.max(...outsideFigureBoundary.map((v) => v[1])),
    };
    logger.info(`[PDFKit] 🔍 Outside Figure boundary polygon:`, {
      vertices: outsideFigureBoundary.length,
      firstVertex: outsideFigureBoundary[0],
      lastVertex: outsideFigureBoundary[outsideFigureBoundary.length - 1],
      isClosed:
        outsideFigureBoundary[0][0] ===
          outsideFigureBoundary[outsideFigureBoundary.length - 1][0] &&
        outsideFigureBoundary[0][1] ===
          outsideFigureBoundary[outsideFigureBoundary.length - 1][1],
      extent,
    });

    // Test the isPointInPolygon function with the center point
    const centerY = (extent.minY + extent.maxY) / 2;
    const centerX = (extent.minX + extent.maxX) / 2;
    const centerPoint = [centerY, centerX];
    const centerIsInside = isPointInPolygon(centerPoint, outsideFigureBoundary);
    logger.info(
      `[PDFKit] 🔍 Testing isPointInPolygon with center point [${centerY.toFixed(
        2
      )}, ${centerX.toFixed(2)}]: ${centerIsInside}`
    );

    // If center point is not inside, the polygon might be inverted or malformed
    if (!centerIsInside) {
      logger.error(
        `[PDFKit] ⚠️ WARNING: Center point of Outside Figure boundary is NOT inside polygon - polygon may be inverted or malformed!`
      );
    }
  }

  parcels.features.forEach((parcel, index) => {
    const parcelStand = parcel.properties.stand || "unknown";
    const parcelDesignation = parcel.properties.designation || "";
    const parcelDescription = parcel.properties.description || "";

    // Skip Outside Figure parcel - it should not have edge labels
    // Check if stand, designation, or description contains "outside figure" (case-insensitive)
    // Also check properties.isOutsideFigure flag set by frontend
    const isOutsideFigure =
      (parcelStand &&
        typeof parcelStand === "string" &&
        parcelStand.toLowerCase().includes("outside figure")) ||
      (parcelDesignation &&
        typeof parcelDesignation === "string" &&
        parcelDesignation.toLowerCase().includes("outside figure")) ||
      (parcelDescription &&
        typeof parcelDescription === "string" &&
        parcelDescription.toLowerCase().includes("outside figure")) ||
      parcel.properties.metadata?.isOutsideFigure === true ||
      parcel.properties.isOutsideFigure === true;

    if (isOutsideFigure) {
      logger.info(
        `[PDFKit] ⏭️  Skipping Outside Figure parcel: ${
          parcelStand || parcelDesignation
        } (no edge labels for Outside Figure itself)`
      );
      return; // Skip this parcel entirely (no edge labels for Outside Figure)
    }

    // Guard: unwrap double-nested coordinates [[ring]] → [ring]
    let coords = parcel.geometry.coordinates[0];
    if (Array.isArray(coords) && coords.length === 1 && Array.isArray(coords[0]) && Array.isArray(coords[0][0])) {
      coords = coords[0];
    }

    // ⭐ SINGLE SOURCE OF TRUTH: Edges computed on-the-fly in geopdf-vector.js
    // Uses same computation logic as /compute/area endpoint via shared utility
    // No fallback needed - edges are ALWAYS computed before PDF generation

    if (
      !parcel.properties.edges ||
      !Array.isArray(parcel.properties.edges) ||
      parcel.properties.edges.length === 0
    ) {
      logger.warn(
        `[PDFKit] ⚠️  Parcel ${
          parcel.properties.stand || index
        } has no edges - SKIPPING edge labels`
      );
      parcel.properties.edges = []; // Empty array = no edge labels
    } else {
      // Edges already computed with banker's rounding - ready to use
      logger.info(
        `[PDFKit] ✅ Using ${
          parcel.properties.edges.length
        } pre-computed edges for parcel ${parcel.properties.stand || index}`
      );
    }

    // Helper: extract [rawY, rawX] from either array [y,x] or object {x,y}
    const coordYX = (c) => Array.isArray(c) ? [c[0], c[1]] : [c.y ?? c[1], c.x ?? c[0]];

    // Transform first point
    const [fy0, fx0] = coordYX(coords[0]);
    const firstPoint = transformCoords(fy0, fx0, extent, mapBounds);

    doc.save();
    doc.moveTo(firstPoint.x, firstPoint.y);

    // Draw polygon outline
    coords.slice(1).forEach((coord) => {
      const [cy, cx] = coordYX(coord);
      const point = transformCoords(cy, cx, extent, mapBounds);
      doc.lineTo(point.x, point.y);
    });

    doc.closePath();

    // Apply styling — 0.8pt line for crisp field-readable parcel boundaries
    doc
      .lineWidth(0.8)
      .strokeColor("#000000")
      .fillColor("#FFFFFF", 0.9)
      .fillAndStroke();

    doc.restore();

    // Draw beacon circles at each vertex (skip closing duplicate)
    // Log-scaled beacon sizing: matches renderBeacons for consistent appearance
    const _sv = Number(scale?.value) || 1000;
    const _ptPerMM = 72 / 25.4;
    const _vtxScaleFactor = 1 + 0.15 * Math.log10(Math.max(500, _sv) / 500);
    let _vtxRadius = 0.75 * _vtxScaleFactor * _ptPerMM;
    _vtxRadius = Math.max(1.8, Math.min(3.0, _vtxRadius));
    const _vtxLineWidth = 0.8; // Match boundary line width

    const [c0y, c0x] = coordYX(coords[0]);
    const [cLy, cLx] = coordYX(coords[coords.length - 1]);
    const uniqueCoords = c0y === cLy && c0x === cLx ? coords.slice(0, -1) : coords;
    uniqueCoords.forEach((coord) => {
      const [cy2, cx2] = coordYX(coord);
      const pt = transformCoords(cy2, cx2, extent, mapBounds);
      doc
        .circle(pt.x, pt.y, _vtxRadius)
        .lineWidth(_vtxLineWidth)
        .fillColor("#FFFFFF")
        .strokeColor("#000000")
        .fillAndStroke();
    });

    // Transform all coords to PDF space for measurements (used by both stand and edge labels)
    const pdfCoords = coords.map((coord) => {
      const [cy, cx] = coordYX(coord);
      return transformCoords(cy, cx, extent, mapBounds);
    });

    // PARCEL GEOMETRY ANALYSIS - Determine optimal font sizes and labeling strategy
    const parcelGeom = analyzeParcelGeometry(pdfCoords, doc);
    const {
      width: parcelWidth,
      height: parcelHeight,
      aspectRatio,
      minDimension,
      isNarrow,
      isVeryNarrow,
      isExtremelyNarrow,
      labelStrategy,
      longestEdge: longestEdgeInfo,
    } = parcelGeom;

    // ADAPTIVE STAND FONT SIZE: Based on parcel geometry
    const stand = parcel.properties.stand || parcel.properties.parcel_id || "";
    const labelText = String(stand);
    const standFontSize = parcelGeom.standFontSize; // Adaptive size based on parcel dimensions

    // Log parcel geometry analysis for debugging
    if (isNarrow) {
      logger.info({
        msg: `[PDFKit] 📐 Narrow parcel detected`,
        stand,
        aspectRatio: aspectRatio.toFixed(1),
        minDimension: minDimension.toFixed(1) + "pt",
        strategy: labelStrategy,
        standFont: standFontSize + "pt",
        edgeFont: parcelGeom.edgeFontSize + "pt",
      });
    }

    // DEFER STAND NUMBER RENDERING - Will be placed AFTER all edge labels
    // This allows stand numbers to find white space without colliding with edge labels
    // Store data needed for deferred rendering
    parcel._standLabelData = {
      stand,
      labelText,
      standFontSize,
      coords,
      pdfCoords,
      parcelGeom,
    };

    // RENDER EDGE LABELS - delegated to LabelingSystem (topology-aware, collision-free)
    {
      const elResult = labelingSystem.renderEdgeLabels(parcel, pdfCoords);
      logger.info(
        `[Edge Debug] Parcel ${parcel.properties.stand}: edges labeled=${elResult.labeled}/${elResult.totalEdges} skipped=${elResult.skipped}`
      );
    } // end RENDER EDGE LABELS block
  });

  // Second-pass: render bearing-only labels for shared edges (via LabelingSystem)
  const nonCommonDirectionsRendered = labelingSystem.renderSecondPassBearings();

  logger.info({
    msg: "[PDFKit] ✅ Rendered edge labels",
    parcels: parcels.features.length,
    scale: scale.label,
    nonCommonDirectionsRendered: nonCommonDirectionsRendered,
  });

  // =============================================================================
  // DEFERRED STAND NUMBER RENDERING - delegated to LabelingSystem
  // =============================================================================
  const standLabelsRendered = labelingSystem.renderDeferredStandLabels(parcels);
  logger.info(
    `[PDFKit] Rendered ${standLabelsRendered} stand numbers (via LabelingSystem, after edge labels)`
  );

  // Return label crowding info for paper/scale escalation
  return { labelCollisions: labelingSystem.labelCollisions };
}

/**
 * Reorder pre-calculated edges to start from northmost vertex in clockwise order
 * This ensures consistency with the standard survey convention used in Area/Consistency
 *
 * @param {Array} edges - Pre-calculated edges with from/to coordinates
 * @returns {Array} Reordered edges starting from northmost vertex, clockwise
 */
function reorderEdgesToNorthmostClockwise(edges) {
  if (!edges || edges.length < 3) return edges;

  // Find the edge that starts at the northmost vertex (smallest X in Cape Lo)
  // Cape Lo: X increases southward, so smallest X = northmost
  let northmostIndex = 0;
  let minX = Infinity;

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    // Get X coordinate from edge.from (x is southing in Cape Lo P system)
    const fromX = edge.from?.x ?? Infinity;
    if (fromX < minX) {
      minX = fromX;
      northmostIndex = i;
    }
  }

  // Check if edges are in clockwise order by computing signed area
  // Using the from coordinates of each edge
  let signedArea = 0;
  for (let i = 0; i < edges.length; i++) {
    const current = edges[i];
    const next = edges[(i + 1) % edges.length];
    const y1 = current.from?.y ?? 0;
    const x1 = current.from?.x ?? 0;
    const y2 = next.from?.y ?? 0;
    const x2 = next.from?.x ?? 0;
    signedArea += (x2 - x1) * (y2 + y1);
  }

  // If counterclockwise (positive area), reverse the edge order
  let orderedEdges = edges.slice();
  if (signedArea > 0) {
    // Reverse and recalculate northmost
    orderedEdges.reverse();
    northmostIndex = 0;
    minX = Infinity;
    for (let i = 0; i < orderedEdges.length; i++) {
      const fromX = orderedEdges[i].from?.x ?? Infinity;
      if (fromX < minX) {
        minX = fromX;
        northmostIndex = i;
      }
    }
  }

  // Reorder to start from northmost vertex
  const reordered = [
    ...orderedEdges.slice(northmostIndex),
    ...orderedEdges.slice(0, northmostIndex),
  ];

  return reordered;
}

// ⭐ REMOVED: calculateEdgesFromGeometry() function
// This fallback function is no longer needed because edges are now computed on-the-fly
// in geopdf-vector.js using the shared edge-computation.js utility.
// This ensures a single source of truth for edge calculations across the entire application.

/**
 * Create unique edge key for topology-aware labeling
 * Sorts coordinates to ensure same key regardless of edge direction
 * This allows detection of shared boundaries between adjacent parcels
 */
function createEdgeKey(coord1, coord2) {
  // Round to 2 decimal places (10mm precision) to handle coordinate variations
  // between parcels that share edges but have slightly different stored coordinates
  const y1 = Math.round(coord1[0] * 100) / 100;
  const x1 = Math.round(coord1[1] * 100) / 100;
  const y2 = Math.round(coord2[0] * 100) / 100;
  const x2 = Math.round(coord2[1] * 100) / 100;

  // Sort coordinates to ensure consistent key regardless of direction
  const coords = [
    [y1, x1],
    [y2, x2],
  ].sort((a, b) => {
    if (a[0] !== b[0]) return a[0] - b[0];
    return a[1] - b[1];
  });

  return `${coords[0][0]},${coords[0][1]}_${coords[1][0]},${coords[1][1]}`;
}

/**
 * Calculate field-readable font size based on map scale
 *
 * FIELD READABILITY STANDARD:
 * - ICA (International Cartographic Association): 3-4mm minimum for field maps
 * - USGS: 3.5mm minimum for topographic maps
 * - Ordnance Survey: 3mm minimum for outdoor maps
 * - At 60cm viewing distance, 3mm = comfortable reading
 *
 * Formula: fontSize = (targetMM * 72 / 25.4) * (scale / 1000)
 * - 72 points per inch
 * - 25.4mm per inch
 * - Normalized to 1:1000 base scale
 */
function calculateFieldReadableFontSize(scaleValue) {
  // ENHANCED: 3.5mm minimum for field readability at arm's length
  // This ensures text is readable in bright sunlight, at various angles, and with aging eyes
  const targetMM = 3.5; // Professional field-readable size (was 2.5mm)
  const pointsPerMM = 72 / 25.4; // Convert mm to points
  const baseScale = 1000; // Normalize to 1:1000

  // Calculate font size that produces targetMM at print scale
  let fontSize = targetMM * pointsPerMM * (scaleValue / baseScale);

  // ENHANCED: Increased minimum from 6pt to 8pt for better field readability
  // Maximum increased to 14pt for larger scales
  fontSize = Math.max(8, Math.min(14, fontSize));

  return Math.round(fontSize);
}

/**
 * Calculate smart label position to keep labels wholly inside parcel
 *
 * STRATEGY:
 * 1. Start at edge midpoint with 2pt offset from boundary
 * 2. Calculate perpendicular offset toward parcel interior
 * 3. Validate all label corners are inside parcel
 * 4. Increase offset if needed to ensure complete containment
 * 5. Use point-in-polygon test for all corners
 */
function calculateSmartLabelPosition(
  p1,
  p2,
  parcelCoords,
  edgeLength,
  labelHeight,
  angle
) {
  // Calculate edge midpoint
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;

  // Calculate perpendicular direction (inward to parcel)
  const edgeDx = p2.x - p1.x;
  const edgeDy = p2.y - p1.y;

  // Perpendicular vector (rotated 90° counterclockwise)
  const perpX = -edgeDy;
  const perpY = edgeDx;
  const perpLength = Math.sqrt(perpX * perpX + perpY * perpY);

  // Normalize perpendicular vector
  const perpNormX = perpX / perpLength;
  const perpNormY = perpY / perpLength;

  // Test both inward directions to find which is inside parcel
  const testOffset = 5; // Small offset for testing
  const testX1 = midX + perpNormX * testOffset;
  const testY1 = midY + perpNormY * testOffset;
  const testX2 = midX - perpNormX * testOffset;
  const testY2 = midY - perpNormY * testOffset;

  // Check which direction is inside parcel
  const inside1 = isPointInPolygonPDF({ x: testX1, y: testY1 }, parcelCoords);
  const inside2 = isPointInPolygonPDF({ x: testX2, y: testY2 }, parcelCoords);

  // Choose inward direction
  let offsetDir = 1;
  if (inside2 && !inside1) {
    offsetDir = -1;
  }

  // Start with minimum 2pt offset from boundary line
  // Increase offset progressively until label is wholly contained
  let labelOffset = 2;
  const maxOffset = labelHeight + 5; // Maximum offset to try
  let labelX, labelY;
  let isFullyInside = false;

  // Try increasing offsets until label is fully inside
  for (let offset = labelOffset; offset <= maxOffset; offset += 1) {
    labelX = midX + perpNormX * offsetDir * offset;
    labelY = midY + perpNormY * offsetDir * offset;

    // Check if label center and all corners are inside parcel
    // Label dimensions: labelHeight tall, estimate width as labelHeight * 2 for combined distance+bearing
    const labelWidth = labelHeight * 2;

    // Calculate label corners (accounting for rotation)
    const angleRad = angle * (Math.PI / 180);
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    // Check 4 corners of label bounding box
    const corners = [
      {
        x: labelX - (labelWidth / 2) * cos + (labelHeight / 2) * sin,
        y: labelY - (labelWidth / 2) * sin - (labelHeight / 2) * cos,
      },
      {
        x: labelX + (labelWidth / 2) * cos + (labelHeight / 2) * sin,
        y: labelY + (labelWidth / 2) * sin - (labelHeight / 2) * cos,
      },
      {
        x: labelX + (labelWidth / 2) * cos - (labelHeight / 2) * sin,
        y: labelY + (labelWidth / 2) * sin + (labelHeight / 2) * cos,
      },
      {
        x: labelX - (labelWidth / 2) * cos - (labelHeight / 2) * sin,
        y: labelY - (labelWidth / 2) * sin + (labelHeight / 2) * cos,
      },
    ];

    // Check if all corners are inside
    isFullyInside = corners.every((corner) =>
      isPointInPolygonPDF(corner, parcelCoords)
    );

    if (isFullyInside) {
      labelOffset = offset;
      break;
    }
  }

  // If no valid position found, use maximum offset (best effort)
  if (!isFullyInside) {
    labelOffset = maxOffset;
    labelX = midX + perpNormX * offsetDir * labelOffset;
    labelY = midY + perpNormY * offsetDir * labelOffset;
  }

  return {
    labelX,
    labelY,
    offset: -labelHeight / 2, // Vertical offset for text rendering
  };
}

/**
 * Point-in-polygon test for PDF coordinates
 */
/**
 * Format bearing for edge labels (simplified DMS)
 * Example: 300.3778° → "300°23'"
 */
function formatBearing(decimalDegrees) {
  if (typeof decimalDegrees !== "number") return "";

  const degrees = Math.floor(decimalDegrees);
  const minutesDecimal = (decimalDegrees - degrees) * 60;
  const minutes = Math.round(minutesDecimal);

  return `${degrees}°${minutes.toString().padStart(2, "0")}'`;
}

/**
 * Format bearing in DMS (Degrees Minutes Seconds) format
 * Example: 300.3778° → "300° 22' 40""
 */
function formatBearingDMS(decimalDegrees, distance) {
  const degrees = Math.floor(decimalDegrees);
  const minutesDecimal = (decimalDegrees - degrees) * 60;
  const minutes = Math.floor(minutesDecimal);
  const secondsDecimal = (minutesDecimal - minutes) * 60;

  // Round seconds based on distance (SI 727 standard)
  let seconds;
  if (distance < 6000) {
    seconds = Math.round(secondsDecimal / 10) * 10; // Nearest 10"
  } else {
    seconds = Math.round(secondsDecimal); // Nearest 1"
  }

  // Handle overflow
  if (seconds >= 60) {
    seconds = 0;
    minutes++;
    if (minutes >= 60) {
      degrees++;
      minutes = 0;
    }
  }

  return `${degrees}° ${minutes.toString().padStart(2, "0")}' ${seconds
    .toString()
    .padStart(2, "0")}"`;
}

/**
 * Draw constraint circle clipped to parcel boundary (debug visualization)
 * Shows only the segment of the 3× radius circle that falls within the parcel
 */
function drawClippedConstraintCircle(doc, beaconPos, radius, parcelCoords) {
  // Sample points around the circle
  const numSamples = 360; // One point per degree for smooth arc
  const circlePoints = [];

  for (let i = 0; i < numSamples; i++) {
    const angle = (i * Math.PI * 2) / numSamples;
    const x = beaconPos.x + radius * Math.cos(angle);
    const y = beaconPos.y + radius * Math.sin(angle);

    // Check if this point is inside the parcel
    if (isPointInPolygonPDF({ x, y }, parcelCoords)) {
      circlePoints.push({ x, y, angle });
    }
  }

  if (circlePoints.length === 0) return; // No intersection with parcel

  // Draw arc segments (connect consecutive points inside parcel)
  doc.save();
  doc.lineWidth(0.5).dash(2, { space: 2 }).strokeColor("#00ff00");

  let inSegment = false;
  for (let i = 0; i < circlePoints.length; i++) {
    const point = circlePoints[i];
    const nextPoint = circlePoints[(i + 1) % circlePoints.length];

    // Check if points are consecutive (angle difference < 5 degrees)
    const angleDiff = Math.abs(nextPoint.angle - point.angle);
    const isConsecutive =
      angleDiff < (5 * Math.PI) / 180 || angleDiff > (355 * Math.PI) / 180;

    if (!inSegment) {
      doc.moveTo(point.x, point.y);
      inSegment = true;
    }

    if (isConsecutive) {
      doc.lineTo(nextPoint.x, nextPoint.y);
    } else {
      // Gap detected, finish this segment
      doc.stroke();
      inSegment = false;
    }
  }

  if (inSegment) {
    doc.stroke();
  }

  doc.restore();
}

/**
 * Render beacons with smart prefix-aware labeling
 * Uses shared label configuration for consistency
 * Uses beaconLabels from UI for consistent beacon-to-parcel mapping
 * - If beacon is in beaconLabels: show suffix inside parcel, near beacon circle
 * - If beacon is not in beaconLabels: show full name outside parcel, horizontally
 * @param {Set<string>} excludeBeaconNames - Set of beacon names to exclude (e.g., Outside Figure vertices already labeled)
 */
function renderBeacons(
  doc,
  beacons,
  parcels,
  extent,
  mapBounds,
  collisionDetector,
  scale,
  beaconLabels,
  logger,
  excludeBeaconNames = new Set()
) {
  logger.info(
    "[PDFKit] 🔴 CODE CHANGE TEST - If you see this, changes are being picked up"
  );
  logger.info(`[PDFKit] 📍 Rendering ${beacons.features.length} beacons...`);

  // Filter out excluded beacons (e.g., Outside Figure vertices already labeled)
  if (excludeBeaconNames.size > 0) {
    const originalCount = beacons.features.length;
    beacons = {
      ...beacons,
      features: beacons.features.filter((b) => {
        const name = b.properties.name || b.properties.id;
        return !excludeBeaconNames.has(name);
      }),
    };
    logger.info(
      `[PDFKit] 🚫 Excluded ${
        originalCount - beacons.features.length
      } Outside Figure vertices, rendering ${beacons.features.length} beacons`
    );
  }

  // Check for duplicate beacon names in the received data
  const beaconNames = beacons.features.map(
    (b) => b.properties.name || b.properties.id
  );
  const uniqueNames = new Set(beaconNames);
  if (beaconNames.length !== uniqueNames.size) {
    const duplicates = beaconNames.filter(
      (name, index) => beaconNames.indexOf(name) !== index
    );
    logger.warn(
      `[PDFKit] ⚠️ DUPLICATE BEACONS IN RECEIVED DATA: ${JSON.stringify([
        ...new Set(duplicates),
      ])}`
    );
    logger.warn(
      `[PDFKit] Total beacons: ${beaconNames.length}, Unique: ${uniqueNames.size}`
    );
  } else {
    logger.info(
      `[PDFKit] ✅ No duplicate beacons in received data (${uniqueNames.size} unique)`
    );
  }

  const labelConfig = BLOCKS.LABEL_CONFIG.beacons;
  let suffixInsideCount = 0;
  let fullNameOutsideCount = 0;

  // Calculate aesthetically proportional beacon circle size
  // Logarithmic scaling: circles grow gently with scale, never dominating the map
  // Target: ~1.5mm diameter at 1:500, growing to ~1.7mm at 1:5000
  // This produces small, crisp markers consistent with professional cadastral plans
  const pointsPerMM = 72 / 25.4;
  const scaleValue = scale.value;
  const baseRadiusMM = 0.75; // 1.5mm diameter base
  const scaleFactor = 1 + 0.15 * Math.log10(Math.max(500, scaleValue) / 500);
  let beaconRadius = baseRadiusMM * scaleFactor * pointsPerMM;

  // Clamp: 1.8pt (≈1.3mm dia) floor for visibility, 3.0pt (≈2.1mm dia) ceiling for aesthetics
  beaconRadius = Math.max(1.8, Math.min(3.0, beaconRadius));

  // Line width matches parcel boundary lines (0.8pt) for visual harmony
  const beaconLineWidth = 0.8;

  logger.info({
    msg: "[PDFKit] 📏 Beacon sizing (log-scaled)",
    scale: scale.label,
    scaleValue,
    diameterMM: (beaconRadius / pointsPerMM * 2).toFixed(2) + "mm",
    beaconRadius: beaconRadius.toFixed(2) + "pt",
    beaconLineWidth: beaconLineWidth.toFixed(2) + "pt",
  });

  // Create a map of beacon names to their label info from UI
  const beaconLabelMap = new Map();
  if (beaconLabels && beaconLabels.length > 0) {
    logger.info(
      `[PDFKit] 🏷️ Received ${beaconLabels.length} beacon labels from UI`
    );
    logger.info(
      `[PDFKit] 📋 Sample labels: ${JSON.stringify(beaconLabels.slice(0, 5))}`
    );
    beaconLabels.forEach((label) => {
      beaconLabelMap.set(label.beaconName, label);
    });
    logger.info(`[PDFKit] 📊 BeaconLabelMap size: ${beaconLabelMap.size}`);
    logger.info(
      `[PDFKit] 🔑 BeaconLabelMap keys (first 10): ${Array.from(
        beaconLabelMap.keys()
      )
        .slice(0, 10)
        .join(", ")}`
    );
  } else {
    logger.info(`[PDFKit] ⚠️ No beacon labels received from UI`);
  }

  // SMART SPLAY POINT DETECTION: Identify beacons that are very close together
  // These need special handling to prevent label overlaps
  const beaconPositions = new Map();
  const splayGroups = new Map(); // Groups of close beacons

  beacons.features.forEach((beacon) => {
    const pos = transformCoords(
      beacon.geometry.coordinates[0],
      beacon.geometry.coordinates[1],
      extent,
      mapBounds
    );
    const beaconName = beacon.properties.name || beacon.properties.id || "B";
    beaconPositions.set(beaconName, pos);
  });

  // Find beacons within close proximity (splay detection)
  // Floor of 18pt ensures splay groups are still detected with smaller circles
  const proximityThreshold = Math.max(18, beaconRadius * 6);
  beaconPositions.forEach((pos1, name1) => {
    const closeBeacons = [];
    beaconPositions.forEach((pos2, name2) => {
      if (name1 !== name2) {
        const dist = Math.sqrt(
          Math.pow(pos2.x - pos1.x, 2) + Math.pow(pos2.y - pos1.y, 2)
        );
        if (dist < proximityThreshold) {
          closeBeacons.push({ name: name2, distance: dist, pos: pos2 });
        }
      }
    });
    if (closeBeacons.length > 0) {
      splayGroups.set(name1, closeBeacons);
    }
  });

  // Deferred circle buffer: beacon circles are drawn AFTER all labels so they
  // always sit on top of label text and white knockout rectangles.
  // Rendering order: boundary lines (renderParcels) → labels → circles.
  const deferredCircles = [];

  beacons.features.forEach((beacon) => {
    const pos = transformCoords(
      beacon.geometry.coordinates[0],
      beacon.geometry.coordinates[1],
      extent,
      mapBounds
    );

    // Defer beacon circle — drawn after all labels in this forEach
    deferredCircles.push({ x: pos.x, y: pos.y });

    const beaconName = beacon.properties.name || beacon.properties.id || "B";

    // PRIORITY 1: Use refined labels from UI if available
    // This ensures frontend and PDF use the same labeling logic
    const uiLabel = beaconLabelMap.get(beaconName);

    // DEBUG: Log first 5 beacon lookups to diagnose mismatch
    if (beacons.features.indexOf(beacon) < 5) {
      logger.info(
        `[PDFKit] 🔍 Looking up beacon "${beaconName}" in map (has ${
          beaconLabelMap.size
        } entries): ${uiLabel ? "FOUND" : "NOT FOUND"}`
      );
    }

    let displayLabel, config, labelPos, isInsideLabel;

    let suffixRotationAngle = 0;
    let suffixFontSize = null;
    let suffixLabelParcelCoords = null;
    let suffixNeedsLeader = false;
    let suffixLeaderPolygon = null;

    let fullOutsidePolygons = null;
    let fullOutsideForced = false;

    let fullNameFontSize = null;
    let incidentPdfCoordsList = null;

    if (uiLabel) {
      // Use label TEXT and METADATA from UI, but calculate position SERVER-SIDE
      // IGNORE frontend coordinates - they are in WGS84, we need Cape Lo positioning
      displayLabel = uiLabel.text;
      isInsideLabel = uiLabel.isInsideParcel;
      config = isInsideLabel
        ? labelConfig.insideParcel
        : labelConfig.outsideParcel;

      logger.info(
        `[PDFKit] 🎨 Using UI label for "${beaconName}": "${displayLabel}" (${
          isInsideLabel ? "inside" : "outside"
        }) - SERVER-SIDE POSITIONING`
      );
      logger.info(
        `[PDFKit] 🔍 Label metadata: isInsideLabel=${isInsideLabel}, displayInParcel="${uiLabel.displayInParcel}"`
      );

      if (isInsideLabel && uiLabel.displayInParcel) {
        // Find the parcel this label should be displayed in
        // Match against properties.id (database ID) or id field
        const displayParcel = parcels.features.find(
          (p) =>
            (p.properties && p.properties.id == uiLabel.displayInParcel) ||
            p.id == uiLabel.displayInParcel
        );
        logger.info(
          `[PDFKit] 🔍 Looking for parcel with id=${
            uiLabel.displayInParcel
          }, found: ${displayParcel ? "YES" : "NO"}`
        );
        if (displayParcel) {
          // Convert parcel coordinates to PDF space (unwrap double-nested [[ring]] → [ring])
          let _ring0 = displayParcel.geometry.coordinates[0];
          if (Array.isArray(_ring0) && _ring0.length === 1 && Array.isArray(_ring0[0]) && Array.isArray(_ring0[0][0])) _ring0 = _ring0[0];
          const pdfCoords = _ring0.map((coord) => {
            const _c = Array.isArray(coord) ? [coord[0], coord[1]] : [coord.y ?? coord[1], coord.x ?? coord[0]];
            return transformCoords(_c[0], _c[1], extent, mapBounds);
          });

          const scaleValue = scale.value;
          let scaleBasedBearingFont;
          if (scaleValue <= 500) {
            scaleBasedBearingFont = 6;
          } else if (scaleValue <= 1000) {
            scaleBasedBearingFont = 6.5;
          } else if (scaleValue <= 2000) {
            scaleBasedBearingFont = 7;
          } else {
            scaleBasedBearingFont = 7.5;
          }

          const parcelGeom = analyzeParcelGeometry(pdfCoords, doc);
          const baseEdgeFontSize = Math.max(
            parcelGeom.edgeFontSize,
            scaleBasedBearingFont
          );
          suffixFontSize = Math.max(8, baseEdgeFontSize * 0.95);
          suffixLabelParcelCoords = pdfCoords;

          // POI-directed placement (replaces edge-following + multi-strategy chain)
          const poiResult = placeSuffixLabelPOIDirected(
            pos, pdfCoords, displayLabel, doc, suffixFontSize, beaconRadius, collisionDetector
          );
          labelPos = { x: poiResult.x, y: poiResult.y };
          suffixNeedsLeader = poiResult.needsLeader;
          suffixLeaderPolygon = pdfCoords.map(p => [p.x, p.y]);
        } else {
          logger.error(
            `[PDFKit] ❌ Could not find parcel ${uiLabel.displayInParcel} for beacon "${beaconName}"`
          );
        }
      }

      // Fallback position for labels outside parcels (non-matching beacons)
      if (!labelPos) {
        const closeOffset = beaconRadius + 3;
        labelPos = {
          x: pos.x + closeOffset,
          y: pos.y - closeOffset,
        };
        logger.info(
          `[PDFKit] 📍 Outside parcel label for "${beaconName}" at default offset`
        );
      }

      if (isInsideLabel) {
        suffixInsideCount++;
      } else {
        fullNameOutsideCount++;
      }
    } else {
      // FALLBACK: Backend labeling logic (only if UI labels not provided)
      logger.info(
        `[PDFKit] ⚠️ No UI label for "${beaconName}", using backend logic`
      );

      const prefixMatch = beaconName.match(/^(\d+)([A-Z]+)$/);

      // Control/reference beacons (no numeric prefix) - always show full name
      if (!prefixMatch) {
        config = labelConfig.outsideParcel;
        displayLabel = beaconName;
        isInsideLabel = false;

        const closeOffset = beaconRadius + 3;
        labelPos = {
          x: pos.x + closeOffset,
          y: pos.y - closeOffset,
        };

        fullNameOutsideCount++;
        logger.info(
          `[PDFKit] 🎯 Control beacon "${beaconName}": showing full name`
        );
      } else {
        const beaconPrefix = prefixMatch[1];
        const beaconSuffix = prefixMatch[2];

        // PRIMARY: Find the display parcel directly by stand name.
        // The beacon name encodes the stand (e.g. "2475A" → stand "2475"), so
        // coordinate-proximity matching is unnecessary and fragile (floating-point
        // mismatches cause it to silently fall through to full-name rendering).
        const displayParcel = parcels.features.find(
          (p) => p.properties.stand?.toString() === beaconPrefix &&
                 !p.properties.isOutsideFigure
        );

        if (displayParcel) {
          config = labelConfig.insideParcel;
          displayLabel = beaconSuffix;
          isInsideLabel = true;

          logger.info(
            `[PDFKit] ✂️ Suffix match: "${beaconName}" → suffix "${beaconSuffix}" inside stand ${displayParcel.properties.stand}`
          );

          // Position near beacon circle, avoiding boundaries (unwrap double-nested [[ring]] → [ring])
          let _ring1 = displayParcel.geometry.coordinates[0];
          if (Array.isArray(_ring1) && _ring1.length === 1 && Array.isArray(_ring1[0]) && Array.isArray(_ring1[0][0])) _ring1 = _ring1[0];
          const pdfCoords = _ring1.map((coord) => {
            const _c = Array.isArray(coord) ? [coord[0], coord[1]] : [coord.y ?? coord[1], coord.x ?? coord[0]];
            return transformCoords(_c[0], _c[1], extent, mapBounds);
          });

          const scaleValue = scale.value;
          let scaleBasedBearingFont;
          if (scaleValue <= 500) {
            scaleBasedBearingFont = 6;
          } else if (scaleValue <= 1000) {
            scaleBasedBearingFont = 6.5;
          } else if (scaleValue <= 2000) {
            scaleBasedBearingFont = 7;
          } else {
            scaleBasedBearingFont = 7.5;
          }

          const parcelGeom = analyzeParcelGeometry(pdfCoords, doc);
          const baseEdgeFontSize = Math.max(
            parcelGeom.edgeFontSize,
            scaleBasedBearingFont
          );
          suffixFontSize = Math.max(8, baseEdgeFontSize * 0.95);
          suffixLabelParcelCoords = pdfCoords;

          // POI-directed placement
          const poiResult2 = placeSuffixLabelPOIDirected(
            pos, pdfCoords, displayLabel, doc, suffixFontSize, beaconRadius, collisionDetector
          );
          labelPos = { x: poiResult2.x, y: poiResult2.y };
          suffixNeedsLeader = poiResult2.needsLeader;
          suffixLeaderPolygon = pdfCoords.map(p => [p.x, p.y]);

          suffixInsideCount++;
        } else {
          // No parcel found with this stand prefix - show full name outside
          config = labelConfig.outsideParcel;
          displayLabel = beaconName;
          isInsideLabel = false;

          logger.info(
            `[PDFKit] ⚠️ No parcel with stand "${beaconPrefix}" found for beacon "${beaconName}": showing full name outside`
          );

          const closeOffset = beaconRadius + 3;
          labelPos = {
            x: pos.x + closeOffset,
            y: pos.y - closeOffset,
          };

          fullNameOutsideCount++;
        }
      }
    }

    if (!isInsideLabel && typeof displayLabel === "string") {
      const incidentParcels = findParcelsWithBeaconVertex(
        beacon.geometry.coordinates,
        parcels
      );
      if (incidentParcels.length > 0) {
        incidentPdfCoordsList = incidentParcels.map((p) => {
          let _ring2 = p.geometry.coordinates[0];
          if (Array.isArray(_ring2) && _ring2.length === 1 && Array.isArray(_ring2[0]) && Array.isArray(_ring2[0][0])) _ring2 = _ring2[0];
          return _ring2.map((coord) => {
            const _c = Array.isArray(coord) ? [coord[0], coord[1]] : [coord.y ?? coord[1], coord.x ?? coord[0]];
            return transformCoords(_c[0], _c[1], extent, mapBounds);
          });
        });
        fullOutsidePolygons = incidentPdfCoordsList.map((ring) =>
          Array.isArray(ring) ? ring.map((pt) => [pt.x, pt.y]) : null
        );

        const scaleValue = Number(scale?.value) || 500;
        let scaleBasedBearingFont;
        if (scaleValue <= 500) {
          scaleBasedBearingFont = 6;
        } else if (scaleValue <= 1000) {
          scaleBasedBearingFont = 6.5;
        } else if (scaleValue <= 2000) {
          scaleBasedBearingFont = 7;
        } else {
          scaleBasedBearingFont = 7.5;
        }

        let bestBaseEdgeFontSize = scaleBasedBearingFont;
        for (const pdfCoords of incidentPdfCoordsList) {
          const parcelGeom = analyzeParcelGeometry(pdfCoords, doc);
          const baseEdgeFontSize = Math.max(
            parcelGeom.edgeFontSize,
            scaleBasedBearingFont
          );
          bestBaseEdgeFontSize = Math.max(bestBaseEdgeFontSize, baseEdgeFontSize);
        }
        fullNameFontSize = Math.max(8, bestBaseEdgeFontSize * 0.95);
      }
    }

    const isSuffixLabel =
      isInsideLabel &&
      typeof displayLabel === "string" &&
      /^[A-Z]+$/.test(displayLabel) &&
      Number.isFinite(suffixFontSize) &&
      Array.isArray(suffixLabelParcelCoords);

    // CARTOGRAPHIC PRINCIPLE: Label size proportional to symbol size
    // Optimal ratio: label height = 70% of beacon diameter for visual harmony
    // This ensures labels are clearly readable relative to the beacon circles
    const beaconDiameter = beaconRadius * 2;
    const optimalLabelHeight = beaconDiameter * 0.7;

    // Convert label height to font size (font size ≈ label height / 1.2)
    // Range 8-11pt for field readability — minimum 8pt ensures legibility in field conditions
    const fontSize = isSuffixLabel
      ? suffixFontSize
      : Number.isFinite(fullNameFontSize)
        ? fullNameFontSize
        : Math.max(8, Math.min(11, optimalLabelHeight / 1.2));

    const fontFamily = isSuffixLabel ? "Helvetica-Bold" : config.font.family;

    const labelWidth = doc.widthOfString(displayLabel, {
      font: fontFamily,
      size: fontSize,
    });
    const labelHeight = fontSize * 1.2;

    const isOutsideFullLabel = !isInsideLabel && !isSuffixLabel;

    if (isOutsideFullLabel) {
      const paddingFromCircle = 0.8;
      const tight = tryTightFullBeaconLabelPosition(
        pos,
        labelWidth,
        labelHeight,
        beaconRadius,
        paddingFromCircle,
        fullOutsidePolygons,
        collisionDetector
      );
      if (tight) {
        labelPos = { x: tight.x, y: tight.y };
        fullOutsideForced = true;
      }
    }

    if (!isInsideLabel && !isSuffixLabel && Array.isArray(incidentPdfCoordsList)) {
      const edgeBase = calculateFullBeaconLabelOutsideOnEdge(
        pos,
        incidentPdfCoordsList,
        displayLabel,
        doc,
        scale,
        beaconRadius,
        fontSize,
        fontFamily,
        collisionDetector
      );
      if (edgeBase) {
        labelPos = edgeBase;
        fullOutsideForced = true;
      }
    }

    // For inside-parcel labels: check collision detector and try parcel-constrained nudges
    // For outside-parcel labels: use collision detector freely
    let finalPos;
    if (isInsideLabel) {
      finalPos = labelPos;  // placeSuffixLabelPOIDirected handles collision internally
    } else if (!isSuffixLabel && fullOutsideForced) {
      finalPos = labelPos;
    } else {
      const candidate = collisionDetector.findOptimalPosition(
        labelPos.x,
        labelPos.y,
        labelWidth,
        labelHeight,
        mapBounds
      );
      if (!candidate) {
        // All positions collide — render at original labelPos rather than skip
        finalPos = labelPos;
      } else if (
        !isSuffixLabel &&
        Array.isArray(fullOutsidePolygons) &&
        fullOutsidePolygons.length > 0
      ) {
        const rect = {
          x: candidate.x,
          y: candidate.y,
          width: labelWidth,
          height: labelHeight,
        };
        if (isRectOutsidePolygons(rect, fullOutsidePolygons)) {
          finalPos = candidate;
        } else {
          const centroids = fullOutsidePolygons
            .filter((poly) => Array.isArray(poly) && poly.length >= 3)
            .map((poly) => {
              const pts = poly.map(([x, y]) => ({ x, y }));
              return calculateCentroidFromPDFCoords(pts);
            })
            .filter((c) => c && Number.isFinite(c.x) && Number.isFinite(c.y));
          let cx = pos.x;
          let cy = pos.y;
          if (centroids.length > 0) {
            cx =
              centroids.reduce((acc, c) => acc + c.x, 0) / centroids.length;
            cy =
              centroids.reduce((acc, c) => acc + c.y, 0) / centroids.length;
          }
          let dx = pos.x - cx;
          let dy = pos.y - cy;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          dx /= len;
          dy /= len;

          const scaleValue = Number(scale?.value) || 500;
          const groundClearanceMeters = 1.5;
          const mmPerPoint = 0.352778;
          const clearanceOnPageMM =
            groundClearanceMeters * 1000 * (1 / scaleValue);
          const clearanceOnPagePt = clearanceOnPageMM / mmPerPoint;
          const distanceBaseOffset = Math.max(
            1.5,
            Math.min(6, clearanceOnPagePt)
          );
          const basePush = beaconRadius + distanceBaseOffset + labelHeight * 0.5 + 0.8;

          const multipliers = [1, 1.25, 1.5, 1.8, 2.1, 2.6, 3.2];
          let found = null;
          for (const m of multipliers) {
            const centerX = pos.x + dx * basePush * m;
            const centerY = pos.y + dy * basePush * m;
            const x = centerX - labelWidth / 2;
            const y = centerY - labelHeight / 2;
            const testRect = { x, y, width: labelWidth, height: labelHeight };
            if (!isRectOutsidePolygons(testRect, fullOutsidePolygons)) continue;
            if (!collisionDetector.hasCollision(x, y, labelWidth, labelHeight)) {
              found = { x, y };
              break;
            }
          }
          if (!found) {
            for (const m of multipliers) {
              const centerX = pos.x + dx * basePush * m;
              const centerY = pos.y + dy * basePush * m;
              const x = centerX - labelWidth / 2;
              const y = centerY - labelHeight / 2;
              const testRect = { x, y, width: labelWidth, height: labelHeight };
              if (!isRectOutsidePolygons(testRect, fullOutsidePolygons)) continue;
              // Second-pass: accept polygon-clear position even if it has a label collision,
              // but prefer a collision-free one when available.
              if (!found && collisionDetector && !collisionDetector.hasCollision(x, y, labelWidth, labelHeight)) {
                found = { x, y };
                break;
              }
              if (!found) {
                found = { x, y }; // polygon-clear fallback, collision tolerated
              }
            }
          }
          finalPos = found || candidate;
        }
      } else {
        finalPos = candidate;
      }
    }

    doc.save();

    if (isOutsideFullLabel && collisionDetector) {
      const nudged = nudgeOutsideFullBeaconLabelTowardCircle(
        pos,
        finalPos,
        labelWidth,
        labelHeight,
        beaconRadius,
        mapBounds,
        fullOutsidePolygons,
        collisionDetector
      );
      if (nudged) {
        finalPos = nudged;
      }
    }

    let verticalOffset = isSuffixLabel ? 0 : 2.5;
    if (isOutsideFullLabel) verticalOffset = 0;

    if (isSuffixLabel) {
      const centerX = finalPos.x + labelWidth / 2;
      const centerY = finalPos.y + verticalOffset + labelHeight / 2;

      doc.translate(centerX, centerY);
      // No rotation — Type 2 labels always render at 0° (east-west)
      doc
        .fontSize(fontSize)
        .font(fontFamily)
        .fillColor(config.color)
        .text(displayLabel, -labelWidth / 2, -labelHeight / 2, {
          lineBreak: false,
        });
    } else {
      doc
        .fontSize(fontSize)
        .font(fontFamily)
        .fillColor(config.color)
        .text(displayLabel, finalPos.x, finalPos.y + verticalOffset, {
          lineBreak: false,
        });
    }
    doc.restore();

    // Draw leader line if label was displaced far from its corner
    if (isSuffixLabel && suffixNeedsLeader && suffixLeaderPolygon) {
      drawBeaconLeaderLine(
        doc,
        finalPos,
        labelWidth,
        labelHeight,
        pos,          // beacon centre
        beaconRadius,
        suffixLeaderPolygon
      );
    }

    // Register ALL beacon labels with collision detector
    // This ensures distance/bearing labels and parcel labels avoid beacon labels
    if (isSuffixLabel) {
      const centerX = finalPos.x + labelWidth / 2;
      const centerY = finalPos.y + verticalOffset + labelHeight / 2;
      // Labels are always 0° — no rotation needed for AABB
      collisionDetector.addRegion(
        centerX - labelWidth / 2,
        centerY - labelHeight / 2,
        labelWidth,
        labelHeight
      );
    } else {
      collisionDetector.addRegion(
        finalPos.x,
        finalPos.y + verticalOffset,
        labelWidth,
        labelHeight
      );
    }
  });

  // Draw all deferred beacon circles on top of labels.
  // White fill knocks out anything underneath; black stroke stays crisp.
  for (const c of deferredCircles) {
    doc.save();
    doc
      .circle(c.x, c.y, beaconRadius)
      .lineWidth(beaconLineWidth)
      .fillColor('#FFFFFF')
      .strokeColor('#000000')
      .fillAndStroke();
    doc.restore();
  }

  logger.info({
    msg: "[PDFKit] ✅ Rendered beacons with prefix-aware labels",
    total: beacons.features.length,
    suffixInside: suffixInsideCount,
    fullNameOutside: fullNameOutsideCount,
    scale: scale.label,
  });
}

/**
 * Check if a beacon point is inside any parcel polygon
 */
function isBeaconInsideAnyParcel(beaconCoords, parcels) {
  if (!parcels || !parcels.features) return false;

  for (const parcel of parcels.features) {
    let coords = parcel.geometry.coordinates[0];
    if (Array.isArray(coords) && coords.length === 1 && Array.isArray(coords[0]) && Array.isArray(coords[0][0])) coords = coords[0];
    if (isPointInPolygon(beaconCoords, coords)) {
      return true;
    }
  }

  return false;
}

/**
 * Find parcel whose label matches the numeric prefix of the beacon name
 * Example: beacon "2474A" matches parcel "2474", beacon "2475C" matches parcel "2475"
 * Uses regex to extract numeric prefix from beacon name
 * Returns the matching parcel if beacon is inside it, null otherwise
 */
function findParcelWithBeaconPrefix(beaconName, beaconCoords, parcels) {
  if (!parcels || !parcels.features || !beaconName) return null;

  // Extract numeric prefix from beacon name (e.g., "2474A" -> "2474")
  const match = beaconName.match(/^(\d+)([A-Z]+)$/);
  if (!match) return null;

  const beaconStand = match[1]; // Numeric prefix

  for (const parcel of parcels.features) {
    const parcelLabel = parcel.properties.stand;
    if (!parcelLabel) continue;

    // Check if beacon's numeric prefix matches parcel label exactly
    if (beaconStand === parcelLabel) {
      // Verify beacon is actually inside this parcel
      let coords = parcel.geometry.coordinates[0];
      if (Array.isArray(coords) && coords.length === 1 && Array.isArray(coords[0]) && Array.isArray(coords[0][0])) coords = coords[0];
      if (isPointInPolygon(beaconCoords, coords)) {
        return parcel;
      }
    }
  }

  return null;
}

/**
 * Check if label bounding box is fully inside parcel polygon (PDF coordinate space)
 * Tests all 4 corners AND midpoints along edges to ensure complete containment
 * This prevents labels from extending outside boundaries even when corners are inside
 */
function isBeaconLabelInsideParcel(
  labelX,
  labelY,
  labelWidth,
  labelHeight,
  parcelCoords
) {
  // Check all 4 corners of the label
  const corners = [
    { x: labelX, y: labelY }, // Top-left
    { x: labelX + labelWidth, y: labelY }, // Top-right
    { x: labelX, y: labelY + labelHeight }, // Bottom-left
    { x: labelX + labelWidth, y: labelY + labelHeight }, // Bottom-right
  ];

  // All corners must be inside the polygon
  for (const corner of corners) {
    if (!isPointInPolygonPDF(corner, parcelCoords)) {
      return false;
    }
  }

  // CRITICAL: Also check midpoints along all 4 edges
  // This prevents labels from bulging outside even when corners are inside
  const edgeMidpoints = [
    { x: labelX + labelWidth / 2, y: labelY }, // Top edge midpoint
    { x: labelX + labelWidth / 2, y: labelY + labelHeight }, // Bottom edge midpoint
    { x: labelX, y: labelY + labelHeight / 2 }, // Left edge midpoint
    { x: labelX + labelWidth, y: labelY + labelHeight / 2 }, // Right edge midpoint
  ];

  // All edge midpoints must be inside the polygon
  for (const midpoint of edgeMidpoints) {
    if (!isPointInPolygonPDF(midpoint, parcelCoords)) {
      return false;
    }
  }

  return true;
}

/**
 * Calculate distance from a point to a line segment in PDF coordinates
 */
function distanceFromPointToSegmentPDF(point, segStart, segEnd) {
  const px = point.x;
  const py = point.y;
  const x1 = segStart.x;
  const y1 = segStart.y;
  const x2 = segEnd.x;
  const y2 = segEnd.y;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    // Segment is a point
    const dpx = px - x1;
    const dpy = py - y1;
    return Math.sqrt(dpx * dpx + dpy * dpy);
  }

  // Calculate projection parameter
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t)); // Clamp to segment

  // Calculate closest point on segment
  const closestX = x1 + t * dx;
  const closestY = y1 + t * dy;

  // Return distance to closest point
  const distX = px - closestX;
  const distY = py - closestY;
  return Math.sqrt(distX * distX + distY * distY);
}

/**
 * Smart beacon label positioning using cartographic best practices
 * Based on Imhof's placement rules and industry standards (ESRI, ICA, USGS)
 * Uses 8-position model with quality scoring for optimal placement
 */
function findOptimalBeaconLabelPosition(
  beaconPos,
  parcelCoords,
  labelText,
  config,
  doc,
  scale,
  beaconRadius,
  splayContext = null,
  logger = null
) {
  // ENHANCED: PROFESSIONAL CADASTRAL STANDARD for field readability at arm's length
  // SI 727 recommends 6-8pt minimum, but field conditions require larger sizes
  // Increased to 8-10pt for better readability in bright sunlight and at various angles
  const beaconDiameter = beaconRadius * 2;
  const optimalLabelHeight = beaconDiameter * 0.6; // Reduced from 0.7 for tighter fit
  let fontSize = Math.max(8, Math.min(10, optimalLabelHeight / 1.2)); // Increased from 6-8pt to 8-10pt

  // Calculate parcel centroid for directional placement
  const centroid = calculateCentroidFromPDFCoords(parcelCoords);

  // ENHANCED: Try progressively smaller font sizes to find valid position
  // Minimum 8pt for field readability (matches renderBeacons)
  const fontSizes = [
    fontSize,
    Math.max(8, fontSize - 1),
    Math.max(8, fontSize - 2),
  ];

  for (const tryFontSize of fontSizes) {
    const result = tryBeaconLabelPlacement(
      beaconPos,
      parcelCoords,
      labelText,
      config,
      doc,
      beaconRadius,
      tryFontSize,
      splayContext,
      scale,
      centroid,
      logger
    );
    if (result) {
      return result;
    }
  }

  // If all font sizes fail, return null to trigger fallback
  return null;
}

/**
 * Calculate centroid from PDF coordinates
 */
function calculateCentroidFromPDFCoords(pdfCoords) {
  let sumX = 0,
    sumY = 0;
  for (const coord of pdfCoords) {
    sumX += coord.x;
    sumY += coord.y;
  }
  return {
    x: sumX / pdfCoords.length,
    y: sumY / pdfCoords.length,
  };
}

/**
 * Place a beacon suffix label (Type 2) using POI-directed inward push.
 * Labels are always rendered at 0° (horizontal). The POI direction is
 * clamped to ±45° from horizontal.
 *
 * @param {{x:number,y:number}} beaconPos  - PDF coordinate of beacon centre
 * @param {Array<{x:number,y:number}>} parcelCoords - Parcel ring in PDF space (may include closing duplicate)
 * @param {string} labelText
 * @param {object} doc  - PDFKit document (for widthOfString)
 * @param {number} fontSize
 * @param {number} beaconRadius
 * @param {object|null} collisionDetector
 * @returns {{x:number, y:number, needsLeader:boolean}}
 */
/**
 * Place a beacon suffix label inside the parcel, pushed inward from the
 * beacon corner along the interior bisector of the two meeting edges.
 *
 * Convention (matches SI 727 reference plans): the suffix letter belongs
 * wholly within the land parcel whose number is the numeric prefix of the
 * beacon name (e.g. label "A" for beacon "1714A" lives inside parcel 1714).
 *
 * Algorithm:
 *  1. Locate the beacon as the closest vertex of the parcel ring.
 *  2. Compute the bisector of the two edges meeting at that vertex.
 *  3. Orient it toward the parcel interior (toward the centroid).
 *  4. Walk outward from dMin in steps, checking each candidate centre is
 *     inside the polygon and collision-free.
 *  5. Hard fallback: centroid, no leader.
 */
function placeSuffixLabelPOIDirected(
  beaconPos, parcelCoords, labelText, doc, fontSize, beaconRadius, collisionDetector
) {
  const lw = doc.widthOfString(labelText, { font: 'Helvetica-Bold', size: fontSize });
  const lh = fontSize * 1.2;

  // Deduplicate closing vertex
  const n = parcelCoords.length;
  const last = parcelCoords[n - 1];
  const firstPt = parcelCoords[0];
  const isClosed = last && firstPt &&
    Math.abs(last.x - firstPt.x) < 0.001 && Math.abs(last.y - firstPt.y) < 0.001;
  const ring = isClosed ? parcelCoords.slice(0, -1) : parcelCoords;
  const rn = ring.length;
  const polygon = ring.map(p => [p.x, p.y]);

  // --- Find the closest ring vertex to the beacon ---
  let beaconIdx = -1;
  let minDist = Infinity;
  for (let i = 0; i < rn; i++) {
    const d = Math.hypot(ring[i].x - beaconPos.x, ring[i].y - beaconPos.y);
    if (d < minDist) { minDist = d; beaconIdx = i; }
  }

  // --- Compute interior bisector at that corner ---
  let intX = 0, intY = 1; // fallback direction

  if (beaconIdx !== -1 && rn >= 3) {
    const B = ring[beaconIdx];
    const P = ring[(beaconIdx - 1 + rn) % rn];
    const N = ring[(beaconIdx + 1) % rn];

    const v1x = P.x - B.x, v1y = P.y - B.y;
    const v2x = N.x - B.x, v2y = N.y - B.y;
    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);

    if (len1 > 0.001 && len2 > 0.001) {
      const u1x = v1x / len1, u1y = v1y / len1;
      const u2x = v2x / len2, u2y = v2y / len2;

      let bx = u1x + u2x, by = u1y + u2y;
      const bLen = Math.hypot(bx, by);

      if (bLen < 0.001) {
        // 180° straight edge — use perpendicular
        bx = -u1y; by = u1x;
      } else {
        bx /= bLen; by /= bLen;
      }

      // Orient TOWARD interior: dot with (centroid − beacon) should be positive
      const centroid = calculateCentroidFromPDFCoords(ring);
      const toCentX = centroid.x - B.x;
      const toCentY = centroid.y - B.y;
      const dot = bx * toCentX + by * toCentY;

      intX = dot >= 0 ? bx : -bx;
      intY = dot >= 0 ? by : -by;
    }
  }

  // Minimum clearance: beacon circle + half label height + 1pt gap
  const dMin = beaconRadius + lh / 2 + 1;

  // Candidate check: centre must be inside polygon and collision-free
  const tryPos = (cx, cy) => {
    if (!isPointInPolygonSimple([cx, cy], polygon)) return false;
    if (collisionDetector?.hasCollision(cx - lw / 2, cy - lh / 2, lw, lh, 1)) return false;
    return true;
  };

  // Try increasing distances along interior bisector with small angle perturbations
  const distances = [dMin, dMin * 1.3, dMin * 1.7, dMin * 2.2, dMin * 3.0, dMin * 4.0];
  const perturbsDeg = [0, 10, -10, 20, -20, 30, -30, 45, -45];

  for (const dist of distances) {
    for (const pd of perturbsDeg) {
      const pRad = pd * Math.PI / 180;
      const cosP = Math.cos(pRad), sinP = Math.sin(pRad);
      const dx = intX * cosP - intY * sinP;
      const dy = intX * sinP + intY * cosP;
      const cx = beaconPos.x + dx * dist;
      const cy = beaconPos.y + dy * dist;
      if (tryPos(cx, cy)) {
        return { x: cx - lw / 2, y: cy - lh / 2, needsLeader: false };
      }
    }
  }

  // Hard fallback: centroid of the parcel, no leader
  const centroid = calculateCentroidFromPDFCoords(ring);
  return { x: centroid.x - lw / 2, y: centroid.y - lh / 2, needsLeader: false };
}

/**
 * Draw an adaptive bent leader line from a displaced suffix label to its beacon.
 * - Solid line at 75% of parcel boundary weight (0.8pt × 0.75 = 0.6pt)
 * - Arrowhead pointing at beacon, tip stopping 1pt short of circle edge
 * - Horizontal stub from label edge, then up to 2 bends, then diagonal to beacon
 * - No visual markers at bend nodes
 *
 * @param {object} doc            - PDFKit document
 * @param {{x:number,y:number}} labelPos    - Top-left of label bounding box
 * @param {number} labelWidth
 * @param {number} labelHeight
 * @param {{x:number,y:number}} beaconPos   - Centre of beacon circle
 * @param {number} beaconRadius
 * @param {Array<[number,number]>} polygon  - [[x,y]] parcel ring for path containment
 */
function drawBeaconLeaderLine(
  doc, labelPos, labelWidth, labelHeight, beaconPos, beaconRadius, polygon
) {
  const LEADER_WEIGHT = 0.8 * 0.75;   // 75% of 0.8pt boundary weight = 0.6pt
  const ARROW_LEN    = LEADER_WEIGHT * 5;
  const ARROW_HALF_W = LEADER_WEIGHT * 2;
  const STUB_LEN     = labelHeight;    // horizontal stub length = 1× label height

  // Label centre
  const lCx = labelPos.x + labelWidth / 2;
  const lCy = labelPos.y + labelHeight / 2;

  // Stub: horizontal, toward beacon
  const stubDir = beaconPos.x >= lCx ? 1 : -1;
  const stubX = stubDir > 0 ? labelPos.x + labelWidth + STUB_LEN : labelPos.x - STUB_LEN;
  const stubY = lCy;

  // Arrowhead tip: 1pt outside beacon circle on the line from stub to beacon
  const toBeaconAngle = Math.atan2(beaconPos.y - stubY, beaconPos.x - stubX);
  const tipX = beaconPos.x - (beaconRadius + 1) * Math.cos(toBeaconAngle);
  const tipY = beaconPos.y - (beaconRadius + 1) * Math.sin(toBeaconAngle);

  // --- Choose bend point ---
  // Try single bend: vertical from stub, then diagonal to tip.
  let bend1 = null;
  for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const bx = stubX;
    const by = stubY + t * (tipY - stubY);
    const m1x = (stubX + bx) / 2, m1y = (stubY + by) / 2;
    const m2x = (bx + tipX) / 2, m2y = (by + tipY) / 2;
    if (isPointInPolygonSimple([m1x, m1y], polygon) && isPointInPolygonSimple([m2x, m2y], polygon)) {
      bend1 = { x: bx, y: by };
      break;
    }
  }

  // If no single-bend path found, try 2 bends (Z-path)
  let bend2 = null;
  if (!bend1) {
    for (const t1 of [0.4, 0.6, 0.3, 0.7]) {
      for (const t2 of [0.7, 0.5, 0.9]) {
        const b1x = stubX, b1y = stubY + t1 * (tipY - stubY);
        const b2x = stubX + t2 * (tipX - stubX), b2y = b1y;
        const m1x = (stubX + b1x) / 2, m1y = (stubY + b1y) / 2;
        const m2x = (b1x + b2x) / 2, m2y = (b1y + b2y) / 2;
        const m3x = (b2x + tipX) / 2, m3y = (b2y + tipY) / 2;
        if (
          isPointInPolygonSimple([m1x, m1y], polygon) &&
          isPointInPolygonSimple([m2x, m2y], polygon) &&
          isPointInPolygonSimple([m3x, m3y], polygon)
        ) {
          bend1 = { x: b1x, y: b1y };
          bend2 = { x: b2x, y: b2y };
          break;
        }
      }
      if (bend1 && bend2) break;
    }
  }

  // Final fallback: straight stub → tip, ignore containment
  if (!bend1) {
    bend1 = { x: stubX, y: (stubY + tipY) / 2 };
  }

  // Draw line
  doc.save();
  doc.lineWidth(LEADER_WEIGHT).strokeColor('#000000');
  doc.moveTo(stubX, stubY);
  doc.lineTo(bend1.x, bend1.y);
  if (bend2) doc.lineTo(bend2.x, bend2.y);
  doc.lineTo(tipX, tipY);
  doc.stroke();

  // Filled arrowhead triangle
  const perpX = -Math.sin(toBeaconAngle);
  const perpY =  Math.cos(toBeaconAngle);
  const baseX = tipX - ARROW_LEN * Math.cos(toBeaconAngle);
  const baseY = tipY - ARROW_LEN * Math.sin(toBeaconAngle);
  doc.moveTo(tipX, tipY)
    .lineTo(baseX + perpX * ARROW_HALF_W, baseY + perpY * ARROW_HALF_W)
    .lineTo(baseX - perpX * ARROW_HALF_W, baseY - perpY * ARROW_HALF_W)
    .closePath()
    .fillColor('#000000').fill();

  doc.restore();
}

function tryBeaconLabelPlacement(
  beaconPos,
  parcelCoords,
  labelText,
  config,
  doc,
  beaconRadius,
  fontSize,
  splayContext,
  scale,
  centroid,
  logger = null
) {
  const labelWidth = doc.widthOfString(labelText, {
    font: config.font.family,
    size: fontSize,
  });
  const labelHeight = fontSize * 1.2;

  // CENTROID-BASED DIRECTIONAL PLACEMENT
  // Calculate angle from beacon to centroid (preferred direction)
  const toCentroidAngle = centroid
    ? Math.atan2(centroid.y - beaconPos.y, centroid.x - beaconPos.x) *
      (180 / Math.PI)
    : null;

  // SMART SPLAY POINT HANDLING: If this beacon is close to others, avoid those directions
  let avoidAngles = [];
  if (splayContext && splayContext.closeBeacons) {
    // Calculate angles to avoid (directions toward close beacons)
    avoidAngles = splayContext.closeBeacons.map((cb) => {
      const dx = cb.pos.x - beaconPos.x;
      const dy = cb.pos.y - beaconPos.y;
      const angle = Math.atan2(dy, dx) * (180 / Math.PI);
      return { angle: (angle + 360) % 360, distance: cb.distance };
    });
  }

  // CENTROID-PRIORITIZED 16-POSITION MODEL
  // Prioritize direction toward centroid, then try other angles
  let positions = [
    { angle: 45, name: "NE", priority: 1 },
    { angle: 135, name: "NW", priority: 2 },
    { angle: 315, name: "SE", priority: 3 },
    { angle: 225, name: "SW", priority: 4 },
    { angle: 0, name: "E", priority: 5 },
    { angle: 180, name: "W", priority: 6 },
    { angle: 270, name: "N", priority: 7 },
    { angle: 90, name: "S", priority: 8 },
    { angle: 22.5, name: "ENE", priority: 9 },
    { angle: 67.5, name: "ESE", priority: 10 },
    { angle: 112.5, name: "WNW", priority: 11 },
    { angle: 157.5, name: "WSW", priority: 12 },
    { angle: 202.5, name: "SSW", priority: 13 },
    { angle: 247.5, name: "SSE", priority: 14 },
    { angle: 292.5, name: "NNW", priority: 15 },
    { angle: 337.5, name: "NNE", priority: 16 },
  ];

  // PRIORITIZE CENTROID DIRECTION: Boost priority of angles toward centroid
  if (toCentroidAngle !== null) {
    const normalizedCentroidAngle = (toCentroidAngle + 360) % 360;
    positions = positions.map((pos) => {
      const angleDiff = Math.abs(pos.angle - normalizedCentroidAngle);
      const normalizedDiff = Math.min(angleDiff, 360 - angleDiff);

      // Boost priority for angles within 45° of centroid direction
      if (normalizedDiff < 45) {
        return { ...pos, priority: pos.priority - 10 }; // Higher priority (lower number)
      }
      return pos;
    });
  }

  // SPLAY POINT OPTIMIZATION: Deprioritize angles toward close beacons
  if (avoidAngles.length > 0) {
    positions = positions.map((pos) => {
      // Check if this position angle is close to any avoid angle
      const isNearAvoidAngle = avoidAngles.some((avoid) => {
        const angleDiff = Math.abs(pos.angle - avoid.angle);
        const normalizedDiff = Math.min(angleDiff, 360 - angleDiff);
        return normalizedDiff < 45; // Within 45° of a close beacon
      });

      if (isNearAvoidAngle) {
        // Heavily deprioritize this direction
        return { ...pos, priority: pos.priority + 20 };
      }
      return pos;
    });

    // Re-sort by priority
    positions.sort((a, b) => a.priority - b.priority);
  }

  // PROFESSIONAL CADASTRAL LABELING with 3mm PRINT-SCALE OFFSET
  // Calculate 3mm ground clearance from beacon circle edge
  const mmPerPoint = 0.352778; // 1 point = 0.352778mm
  const targetOffsetMM = 3; // 3mm at print scale
  const targetOffsetPt = targetOffsetMM / mmPerPoint; // Convert to points

  // Scale-responsive offset: 3mm at print translates to different page points at different scales
  const scaleValue = scale?.value || 1000;
  const groundToPageRatio = 1 / scaleValue;
  const offsetOnPageMM = targetOffsetMM; // 3mm on printed page
  const offsetOnPagePt = offsetOnPageMM / mmPerPoint; // ~8.5pt

  const minClearance = 0.5; // Minimum 0.5pt from circle edge (reduced from 1.0pt for tighter placement)
  const preferredOffset = beaconRadius + Math.max(minClearance, offsetOnPagePt); // 3mm from circle edge
  const maxDistance = beaconRadius * 4.0; // Maximum 4× radius for more flexibility (increased from 3×)

  // Re-sort positions by priority (after centroid boost)
  positions.sort((a, b) => a.priority - b.priority);

  // Try each position in priority order (centroid direction first)
  for (const position of positions) {
    // Try multiple offset distances, starting with preferred 3mm offset
    // ENHANCED: More offset variations for better coverage
    const offsets = [
      beaconRadius + minClearance, // Minimum: just outside circle (try first for tight placement)
      beaconRadius + minClearance + 1, // +1pt from circle
      beaconRadius + minClearance + 2, // +2pt from circle
      preferredOffset * 0.6, // 60% of preferred
      preferredOffset * 0.8, // 80% of preferred
      preferredOffset, // Preferred: 3mm from circle edge
      preferredOffset * 1.2, // 120% of preferred
      beaconRadius + minClearance + 4, // +4pt from circle
      preferredOffset * 1.5, // 150% of preferred
      preferredOffset * 2.0, // 200% of preferred
      maxDistance * 0.75, // 75% of maximum
      maxDistance, // Maximum: 4× radius
    ];

    for (const offset of offsets) {
      const radians = (position.angle * Math.PI) / 180;

      // Calculate label center position
      const centerX = beaconPos.x + offset * Math.cos(radians);
      const centerY = beaconPos.y + offset * Math.sin(radians);

      // Enforce maximum distance constraint (2× radius for professional appearance)
      const distanceFromBeacon = Math.sqrt(
        Math.pow(centerX - beaconPos.x, 2) + Math.pow(centerY - beaconPos.y, 2)
      );
      if (distanceFromBeacon > maxDistance) {
        continue; // Skip if outside constraint zone
      }

      // Convert to top-left corner for rendering
      const labelX = centerX - labelWidth / 2;
      const labelY = centerY - labelHeight / 2;

      // CRITICAL: Ensure NO part of label bounding box overlaps beacon circle
      // Use smart edge-based detection: find closest point on label box to beacon center
      const closestX = Math.max(
        labelX,
        Math.min(beaconPos.x, labelX + labelWidth)
      );
      const closestY = Math.max(
        labelY,
        Math.min(beaconPos.y, labelY + labelHeight)
      );
      const distToLabel = Math.sqrt(
        Math.pow(closestX - beaconPos.x, 2) +
          Math.pow(closestY - beaconPos.y, 2)
      );

      if (distToLabel < beaconRadius + minClearance) {
        continue; // Skip this position - label would overlap beacon circle
      }

      // SPLAY POINT SPACING: Check minimum distance from other close beacon labels
      let tooCloseToOtherLabel = false;
      if (splayContext && splayContext.closeBeacons) {
        const minLabelSpacing = 1.75; // 1.75pt minimum spacing between splay labels

        for (const closeBeacon of splayContext.closeBeacons) {
          // Estimate where the close beacon's label might be
          // (We don't know exact position yet, but we can check beacon proximity)
          const beaconDist = Math.sqrt(
            Math.pow(closeBeacon.pos.x - beaconPos.x, 2) +
              Math.pow(closeBeacon.pos.y - beaconPos.y, 2)
          );

          // Check if this label position is too close to the other beacon's likely label zone
          // The other beacon's label will be within 2.5× radius of its center
          const labelToOtherBeacon = Math.sqrt(
            Math.pow(centerX - closeBeacon.pos.x, 2) +
              Math.pow(centerY - closeBeacon.pos.y, 2)
          );

          // If our label center is within the other beacon's label zone + spacing buffer
          const otherBeaconLabelZone =
            beaconRadius * 2.5 + labelWidth / 2 + minLabelSpacing;
          if (labelToOtherBeacon < otherBeaconLabelZone) {
            tooCloseToOtherLabel = true;
            break;
          }
        }
      }

      if (tooCloseToOtherLabel) {
        continue; // Skip this position - too close to another splay beacon's label zone
      }

      // Validate position
      const insideParcel = isBeaconLabelInsideParcel(
        labelX,
        labelY,
        labelWidth,
        labelHeight,
        parcelCoords
      );
      if (insideParcel) {
        // Calculate quality score for this position
        const score = calculateLabelPositionQuality(
          { x: labelX, y: labelY },
          labelWidth,
          labelHeight,
          parcelCoords,
          beaconPos,
          position.priority
        );

        // Log successful placement with centroid direction info
        const isCentroidDirection =
          toCentroidAngle !== null &&
          Math.abs(position.angle - ((toCentroidAngle + 360) % 360)) < 45;

        // FIELD READABILITY: Accept position if quality meets threshold
        // CRITICAL: Prioritize containment over perfect positioning
        // For suffix labels (single letter), accept ANY position that's inside the correct parcel
        // This ensures beacons like 2474C and 2475C have their suffix wholly inside their stand
        const isShortLabel = labelText.length <= 2; // Suffix labels are typically 1-2 characters
        const acceptanceThreshold = isShortLabel ? 0.05 : 0.15; // Much lower threshold for suffix labels

        if (score > acceptanceThreshold) {
          if (logger) {
            logger.info(
              `[PDFKit] ✅ Beacon label "${labelText}" placed at ${
                position.name
              } (${position.angle}°), offset: ${offset.toFixed(
                1
              )}pt, centroid-dir: ${isCentroidDirection}, score: ${score.toFixed(
                2
              )}, threshold: ${acceptanceThreshold}`
            );
          }
          return { x: labelX, y: labelY };
        }
      }
    }
  }

  // No valid position found with this font size
  return null;
}

/**
 * Calculate quality score for a label position (0-1 scale)
 * Higher score = better position
 */
function calculateLabelPositionQuality(
  labelPos,
  labelWidth,
  labelHeight,
  parcelCoords,
  beaconPos,
  priority
) {
  let score = 1.0;

  // Factor 1: Position priority (Imhof's rules)
  // Priority 1 (NE) gets full score, priority 8 (S) gets reduced score
  const priorityScore = 1.0 - (priority - 1) * 0.08; // 0.08 reduction per priority level
  score *= priorityScore;

  // Factor 2: Distance from boundaries (CRITICAL for field readability)
  // Labels too close to boundaries are hard to read in field conditions
  // Calculate minimum distance from label edges to parcel boundaries
  let minBoundaryDist = Infinity;

  const labelCorners = [
    { x: labelPos.x, y: labelPos.y },
    { x: labelPos.x + labelWidth, y: labelPos.y },
    { x: labelPos.x, y: labelPos.y + labelHeight },
    { x: labelPos.x + labelWidth, y: labelPos.y + labelHeight },
  ];

  for (const corner of labelCorners) {
    for (let i = 0; i < parcelCoords.length - 1; i++) {
      const dist = distanceFromPointToSegmentPDF(
        corner,
        parcelCoords[i],
        parcelCoords[i + 1]
      );
      minBoundaryDist = Math.min(minBoundaryDist, dist);
    }
  }

  // ENHANCED: Boundary clearance requirement balanced for small parcels
  // Field readability: Labels should be separated from edges, but containment is priority
  // 12pt clearance = full score, 3pt clearance = 0.5 score, <1pt = penalty
  const minRequiredClearance = 1; // Minimum 1pt clearance (reduced from 3pt for small parcels)
  if (minBoundaryDist < minRequiredClearance) {
    score *= 0.3; // Moderate penalty for labels very close to edges
  } else {
    const boundaryScore = Math.min(
      1.0,
      (minBoundaryDist - minRequiredClearance) / 11
    );
    score *= 0.5 + boundaryScore * 0.5; // Weight: 50% (preference for clearance)
  }

  // Factor 3: Distance from beacon (CRITICAL for field readability)
  // At arm's length, labels must be clearly associated with their beacons
  // Too far = ambiguous association, too close = cramped appearance
  const labelCenterX = labelPos.x + labelWidth / 2;
  const labelCenterY = labelPos.y + labelHeight / 2;
  const distFromBeacon = Math.sqrt(
    Math.pow(labelCenterX - beaconPos.x, 2) +
      Math.pow(labelCenterY - beaconPos.y, 2)
  );

  // Field readability: Optimal range is 1.2× to 2.5× beacon radius
  // Within 35pt is ideal for clear association at arm's length
  const proximityScore = Math.max(0.6, 1.0 - distFromBeacon / 70);
  score *= 0.7 + proximityScore * 0.3; // Weight: 30%

  return score;
}

/**
 * Check if a label fits horizontally inside a parcel
 * Uses simple bounding box check with padding
 */
function checkLabelFitsInParcel(
  centerX,
  centerY,
  labelWidth,
  labelHeight,
  parcelCoords
) {
  // Calculate label corners
  const labelLeft = centerX - labelWidth / 2;
  const labelRight = centerX + labelWidth / 2;
  const labelTop = centerY - labelHeight / 2;
  const labelBottom = centerY + labelHeight / 2;

  // Get parcel bounding box
  const xs = parcelCoords.map((p) => p.x);
  const ys = parcelCoords.map((p) => p.y);
  const parcelLeft = Math.min(...xs);
  const parcelRight = Math.max(...xs);
  const parcelTop = Math.min(...ys);
  const parcelBottom = Math.max(...ys);

  // Add 5pt padding for safety
  const padding = 5;

  // Check if label fits within parcel bounds
  const fitsHorizontally =
    labelLeft >= parcelLeft + padding &&
    labelRight <= parcelRight - padding &&
    labelTop >= parcelTop + padding &&
    labelBottom <= parcelBottom - padding;

  return fitsHorizontally;
}

/**
 * Find the angle of the longest side of a polygon
 * Returns angle in degrees for text rotation
 */
function findLongestSideAngle(coords) {
  let maxLength = 0;
  let longestSideAngle = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];

    // Calculate side length
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const length = Math.sqrt(dx * dx + dy * dy);

    if (length > maxLength) {
      maxLength = length;
      // Calculate angle in degrees
      // atan2 returns angle in radians, convert to degrees
      const angleRad = Math.atan2(dy, dx);
      let angleDeg = angleRad * (180 / Math.PI);

      // Normalize angle to -90 to +90 range for text readability
      // (avoid upside-down text)
      if (angleDeg > 90) angleDeg -= 180;
      if (angleDeg < -90) angleDeg += 180;

      longestSideAngle = angleDeg;
    }
  }

  return longestSideAngle;
}

/**
 * Count stands wholly contained within the Outside Figure polygon.
 * Uses each parcel's centroid and a ray-casting point-in-polygon test.
 * Falls back to designation string parsing when parcel data is unavailable.
 *
 * @param {Array} parcels - Array of parcel objects with {vertices: [{x,y}]}
 * @param {Object} outsideFigureData - Outside figure data with {edges: [{y,x}]}
 * @param {string} designation - Fallback designation string
 * @returns {number} Count of stands inside the Outside Figure
 */
function countStandsInOutsideFigure(parcels, outsideFigureData, designation) {
  // Build Outside Figure polygon from edge start-points (Cape Lo {x,y})
  const polygon =
    outsideFigureData?.edges?.length > 0
      ? outsideFigureData.edges.map((e) => ({ x: e.x, y: e.y }))
      : null;

  // Normalise parcels to an array of centroid {x,y} points.
  // Supports two formats:
  //   1. Raw preview format: Array<{vertices: [{x,y}]}>
  //   2. GeoJSON FeatureCollection: {features: [{geometry:{type,coordinates}, properties}]}
  let centroids = null;
  if (polygon && polygon.length >= 3) {
    if (Array.isArray(parcels) && parcels.length > 0) {
      // Raw preview format
      centroids = parcels
        .filter((p) => p.vertices && p.vertices.length > 0)
        .map((p) => {
          let sumX = 0, sumY = 0;
          for (const v of p.vertices) { sumX += v.x; sumY += v.y; }
          return { x: sumX / p.vertices.length, y: sumY / p.vertices.length };
        });
    } else if (parcels?.features?.length > 0) {
      // GeoJSON FeatureCollection — coordinates are [CapeLoY (Westing), CapeLoX (Southing)]
      // The Outside Figure polygon uses { x: Southing, y: Westing } from edge data.
      // So: coord[0] = Westing = polygon.y, coord[1] = Southing = polygon.x
      centroids = parcels.features
        .filter((f) => f.geometry?.type === 'Polygon' && f.geometry.coordinates?.[0]?.length > 0)
        .map((f) => {
          let ring = f.geometry.coordinates[0];
          if (ring.length === 1 && Array.isArray(ring[0]) && Array.isArray(ring[0][0])) ring = ring[0];
          let sumWesting = 0, sumSouthing = 0;
          for (const coord of ring) { sumWesting += coord[0]; sumSouthing += coord[1]; }
          return { x: sumSouthing / ring.length, y: sumWesting / ring.length };
        });
    }
  }

  if (polygon && polygon.length >= 3 && centroids && centroids.length > 0) {
    let count = 0;
    for (const { x: cx, y: cy } of centroids) {
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        if ((yi > cy) !== (yj > cy) && cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      if (inside) count++;
    }
    return count;
  }

  // Fallback: parse designation string
  if (!designation) return 0;
  const ranges = designation.match(/(\d+)\s*-\s*(\d+)/g);
  const singles = designation.match(/(?<!\d-)\b(\d{4})\b(?!-\d)/g);
  let total = 0;
  if (ranges) {
    ranges.forEach((range) => {
      const [start, end] = range.split(/\s*-\s*/).map(Number);
      total += end - start + 1;
    });
  }
  if (singles) total += singles.length;
  return total;
}

/**
 * Compress an array of stand name strings into compact range notation.
 * Purely numeric stands are grouped into ranges (e.g. [131,133,134,135,136] → "131, 133 - 136").
 * Non-numeric stand names are appended individually after numeric ranges.
 * @param {string[]} standNames
 * @returns {string}
 */
function formatStandRanges(standNames) {
  if (!standNames || standNames.length === 0) return '';

  const numeric = [];
  const nonNumeric = [];

  for (const name of standNames) {
    const n = parseInt(name, 10);
    if (!isNaN(n) && String(n) === String(name).trim()) {
      numeric.push(n);
    } else {
      nonNumeric.push(name);
    }
  }

  numeric.sort((a, b) => a - b);

  const parts = [];
  let i = 0;
  while (i < numeric.length) {
    let j = i;
    while (j + 1 < numeric.length && numeric[j + 1] === numeric[j] + 1) j++;
    if (j === i) {
      parts.push(String(numeric[i]));
    } else {
      parts.push(`${numeric[i]} - ${numeric[j]}`);
    }
    i = j + 1;
  }

  for (const name of nonNumeric) parts.push(name);
  return parts.join(', ');
}

/**
 * Return the stand names of parcels whose centroids fall inside the Outside Figure polygon.
 * Falls back to all non-Outside-Figure parcel stand names when the geometric test yields nothing.
 * @param {Object} parcels - GeoJSON FeatureCollection or raw array
 * @param {Object} outsideFigureData - Outside figure data with edges
 * @returns {string[]} Array of stand name strings
 */
function getStandsInsideOutsideFigure(parcels, outsideFigureData) {
  const polygon =
    outsideFigureData?.edges?.length > 0
      ? outsideFigureData.edges.map((e) => ({ x: e.x, y: e.y }))
      : null;

  // Build list of {stand, cx, cy} entries from GeoJSON features
  let entries = [];
  if (polygon && polygon.length >= 3 && parcels?.features?.length > 0) {
    entries = parcels.features
      .filter((f) => f.geometry?.type === 'Polygon' && f.geometry.coordinates?.[0]?.length > 0)
      .map((f) => {
        let ring = f.geometry.coordinates[0];
        if (ring.length === 1 && Array.isArray(ring[0]) && Array.isArray(ring[0][0])) ring = ring[0];
        let sumWesting = 0, sumSouthing = 0;
        for (const coord of ring) { sumWesting += coord[0]; sumSouthing += coord[1]; }
        return {
          stand: f.properties?.stand || f.properties?.designation || '',
          x: sumSouthing / ring.length,
          y: sumWesting / ring.length,
        };
      });

    // Ray-casting containment test
    const inside = entries.filter(({ x: cx, y: cy }) => {
      let hit = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        if ((yi > cy) !== (yj > cy) && cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi) {
          hit = !hit;
        }
      }
      return hit;
    });

    if (inside.length > 0) {
      return inside
        .map((e) => e.stand)
        .filter((s) => s && !s.toLowerCase().includes('outside figure'));
    }
  }

  // Fallback: all non-Outside-Figure parcels
  if (parcels?.features?.length > 0) {
    return parcels.features
      .map((f) => f.properties?.stand || f.properties?.designation || '')
      .filter((s) => s && !s.toLowerCase().includes('outside figure'));
  }

  return [];
}

/**
 * Calculate title block width based on actual text content
 * @param {number} widthFactor - Width adjustment factor (0.75 to 1.25, default 1.0)
 */
/**
 * Single source of truth for the title block's textual content. Both
 * calculateTitleBlockHeight (to measure) and drawTitleBlock (to render) build
 * their lines from here so the reserved band height always matches what is
 * actually drawn (no drift → no figure overlap).
 *
 * Returns the ordered, ready-to-render strings:
 *   { designation, sheetText, figureText, videText, hasFigure }
 * Any field may be '' / null when not applicable.
 */
function _buildTitleBlockTexts(metadata, outsideFigureData, parcels, sheetInfo, logger = null) {
  const config = BLOCKS.TITLE_BLOCK;
  const isMultiSheet = !!(sheetInfo && sheetInfo.totalSheets > 1);
  const district = metadata.district || "";

  // ── Designation: "Stands 16 - 18 Maglas Township" ──
  const standsInside = getStandsInsideOutsideFigure(parcels, outsideFigureData);
  const dynamicStandList = formatStandRanges(standsInside);
  const rawSurveyOf = (metadata.surveyOf || metadata.township || "").trim();
  const withoutStandsPrefix = rawSurveyOf.replace(/^Stands?\s+[\d,\s\-–]+/i, "").trim();
  const townshipDescription = withoutStandsPrefix.replace(/\s+of\s+.+$/i, "").trim();
  let designation;
  if (dynamicStandList) {
    designation = townshipDescription
      ? `Stands ${dynamicStandList} ${townshipDescription}`
      : `Stands ${dynamicStandList}`;
  } else {
    const rawDesig = (metadata.designation || "").trim();
    designation = rawDesig.replace(/\s+of\s+.+$/i, "").trim();
  }

  const sheetText = isMultiSheet ? `SHEET ${sheetInfo.sheetNumber}` : "";

  // ── Figure description sentence + Vide line (only when there is a figure) ──
  const vertices = getOutsideFigureVertices(outsideFigureData, logger);
  const standCount = standsInside.length;
  const hasFigure = !!(designation && vertices.sequence && standCount > 0);

  let figureText = "";
  let videText = "";
  if (hasFigure) {
    const rawFullDesig = (metadata.surveyOf || metadata.designation || '').trim();
    const standRangeMatch = rawFullDesig.match(/Stands?\s+([\d]+)\s*[-–]\s*([\d]+)/i);
    let projectStandRange;
    if (standRangeMatch) {
      projectStandRange = `${parseInt(standRangeMatch[1], 10)}–${parseInt(standRangeMatch[2], 10)}`;
    } else {
      const sortedFallback = standsInside.map(s => parseInt(s, 10)).filter(n => !isNaN(n)).sort((a, b) => a - b);
      projectStandRange = sortedFallback.length > 1
        ? `${sortedFallback[0]}–${sortedFallback[sortedFallback.length - 1]}`
        : (sortedFallback[0] ?? standCount).toString();
    }

    const wholePortion = (metadata.wholePortion || 'the whole').trim();
    const toTitleCase = s => s.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    const township = toTitleCase(townshipDescription || (metadata.township || '').trim());
    const parentProp = toTitleCase((metadata.parentProperty || '').trim());
    const ofTarget = parentProp ? `${township} of ${parentProp}` : township;

    if (isMultiSheet) {
      const { sheetNumber, totalSheets } = sheetInfo;
      const otherNums = Array.from({ length: totalSheets }, (_, i) => i + 1).filter(n => n !== sheetNumber);
      const otherSheets = otherNums.length === 1
        ? `sheet ${otherNums[0]}`
        : otherNums.slice(0, -1).map(n => `sheet ${n}`).join(', ') + ` and sheet ${otherNums[otherNums.length - 1]}`;
      const projectStandRangeFormatted = formatStandRanges(standsInside.length > 0 ? standsInside : []) || projectStandRange;
      const figureLabel = sheetInfo.fullFigureLabel || vertices.sequence;
      figureText = config.figureDescription.multiSheetTemplate
        .replace('{figureLabel}',     figureLabel)
        .replace('{otherSheets}',     otherSheets)
        .replace('{township}',        township)
        .replace('{totalStandCount}', standsInside.length)
        .replace('{standRange}',      projectStandRangeFormatted)
        .replace('{wholePortion}',    wholePortion)
        .replace('{ofTarget}',        ofTarget)
        .replace('{district}',        district);
    } else {
      const tileStandRange = formatStandRanges(standsInside);
      figureText = config.figureDescription.template
        .replace('{beaconSequence}', vertices.sequence)
        .replace('{township}',       township)
        .replace('{standCount}',     standCount)
        .replace('{standRange}',     tileStandRange)
        .replace('{wholePortion}',   wholePortion)
        .replace('{ofTarget}',       ofTarget)
        .replace('{district}',       district);
    }
    videText = config.vide.template;
  }

  return { designation, sheetText, figureText, videText, hasFigure, isMultiSheet };
}

function calculateTitleBlockWidth(
  doc,
  metadata,
  outsideFigureData,
  mapBounds,
  widthFactor = 1.0,
  parcels = null
) {
  const config = BLOCKS.TITLE_BLOCK;
  const district = metadata.district || "";

  // Dynamic designation from parcels inside Outside Figure (mirrors drawTitleBlock logic)
  const standsInsideW = getStandsInsideOutsideFigure(parcels, outsideFigureData);
  const dynamicStandListW = formatStandRanges(standsInsideW);
  const rawSurveyOfW = (metadata.surveyOf || metadata.township || "").trim();
  const townshipDescW = rawSurveyOfW.replace(/^Stands?\s+[\d,\s\-–]+/i, "").trim();
  const designation = dynamicStandListW
    ? (townshipDescW ? `Stands ${dynamicStandListW} ${townshipDescW}` : `Stands ${dynamicStandListW}`)
    : (metadata.designation || "");

  doc.save();

  let maxWidth = 0;

  // Measure title text
  doc.fontSize(config.mainTitle.font.size).font(config.mainTitle.font.family);
  const titleWidth = doc.widthOfString(config.mainTitle.text);
  maxWidth = Math.max(maxWidth, titleWidth);

  // Measure designation text
  if (designation) {
    const surveyText = config.designation.template
      .replace("{designation}", designation);

    doc
      .fontSize(config.designation.font.size)
      .font(config.designation.font.family);
    const designationWidth = doc.widthOfString(surveyText);
    maxWidth = Math.max(maxWidth, designationWidth);

    // Measure figure description
    const vertices = getOutsideFigureVertices(outsideFigureData, null);
    const standCount = standsInsideW.length || countStandsInOutsideFigure(parcels, outsideFigureData, designation);

    if (vertices.sequence && standCount > 0) {
      const figureText = config.figureDescription.template
        .replace("{beaconSequence}", vertices.sequence)
        .replace("{standCount}", standCount)
        .replace("{district}", district);

      doc
        .fontSize(config.figureDescription.font.size)
        .font(config.figureDescription.font.family);
      const figureWidth = doc.widthOfString(figureText);
      maxWidth = Math.max(maxWidth, figureWidth);
    }
  }

  doc.restore();

  // Add padding and cap at reasonable maximum
  const paddedWidth = maxWidth + 40; // 20pt padding on each side
  const cappedWidth = Math.min(paddedWidth, mapBounds.width - 40); // Leave 20pt margin on each side
  const baseWidth = Math.max(300, cappedWidth); // Ensure minimum 300pt

  // Apply width factor (0.75 to 1.25 range)
  return baseWidth * widthFactor;
}

/**
 * Calculate actual title block height based on content
 * This ensures accurate positioning of blocks below the title block
 */
/**
 * Greedy word-wrap line count for `text` at `width`, using the doc's font
 * metrics (real PDFKit doc, or the measure-proxy used by the DXF planner —
 * both expose font/fontSize/widthOfString; save/restore are optional).
 */
function _wrapLineCount(doc, text, fontFamily, fontSize, width) {
  if (!text) return 0;
  doc.save?.();
  doc.font(fontFamily).fontSize(fontSize);
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) { doc.restore?.(); return 0; }
  let lines = 1, cur = words[0];
  for (let i = 1; i < words.length; i++) {
    const trial = `${cur} ${words[i]}`;
    if (doc.widthOfString(trial) <= width) cur = trial;
    else { lines++; cur = words[i]; }
  }
  doc.restore?.();
  return lines;
}

/**
 * Accurate height of the title block as a single cohesive block, covering ALL
 * its elements — GENERAL PLAN, "of", optional SHEET N, the designation, the
 * figure-description sentence, AND the Vide line — measured at the width they
 * are actually drawn (so the reserved band never under-shoots and the outside
 * figure, fitted below it, never overlaps the lower elements). Uses the shared
 * _buildTitleBlockTexts builder so render and measurement can't drift.
 */
function calculateTitleBlockHeight(doc, metadata, outsideFigureData, mapBounds, logger, parcels = null, sheetInfo = null) {
  const config = BLOCKS.TITLE_BLOCK;
  const { designation, figureText, videText, hasFigure, isMultiSheet } =
    _buildTitleBlockTexts(metadata, outsideFigureData, parcels, sheetInfo, logger);

  // Match drawTitleBlock's text column width (figure description + Vide wrap here).
  const MARGIN = 10;
  const actualTextWidth = Math.min(600, mapBounds.width - MARGIN * 2);

  let h = config.mainTitle.font.size;            // GENERAL PLAN
  h += config.spacing.afterMainTitle;
  h += config.ofText.font.size;                  // of
  h += config.spacing.afterOf;

  // Designation line(s). drawTitleBlock advances by (font.size + 6) for the
  // first line; wrapped lines add their own height.
  const desigLines = designation
    ? _wrapLineCount(doc, config.designation.template.replace('{designation}', designation),
        config.designation.font.family, config.designation.font.size, actualTextWidth)
    : 1;
  h += config.designation.font.size + 6
     + Math.max(0, desigLines - 1) * (config.designation.font.size + 2);

  // Optional SHEET N line (multi-sheet only).
  if (isMultiSheet) {
    h += config.sheetLabel.font.size + config.spacing.afterSheet;
  }

  // Figure description + Vide line (always drawn together for general plans).
  if (hasFigure) {
    h += config.spacing.afterDesignation;
    const figLines = _wrapLineCount(doc, figureText,
      config.figureDescription.font.family, config.figureDescription.font.size, actualTextWidth);
    h += figLines * (config.figureDescription.font.size + config.figureDescription.lineGap);
    h += 4; // videY = doc.y + 4
    const videLines = _wrapLineCount(doc, videText,
      config.vide.font.family, config.vide.font.size, actualTextWidth);
    h += videLines * (config.vide.font.size + config.vide.lineGap);
  }

  h += 8; // bottom padding
  return h;
}

/**
 * Draw title block using centrally calculated position.
 * @param {Object} sheetInfo  Optional { sheetNumber, totalSheets } for SI 727 multi-sheet plans.
 *                            When provided renders "SHEET N", inter-sheet description, and Vide line.
 */
function drawTitleBlock(
  doc,
  metadata,
  mapBounds,
  outsideFigureData,
  position,
  logger,
  parcels = null,
  sheetInfo = null
) {
  const config = BLOCKS.TITLE_BLOCK;
  const isMultiSheet = !!(sheetInfo && sheetInfo.totalSheets > 1);

  // Use dynamic width from collision detection (includes widthFactor adjustment)
  const titleWidth = position?.width || 300;
  const titleHeight = isMultiSheet ? 130 : 100; // always includes Vide line; multi-sheet adds SHEET N line

  // Use centrally calculated position (collision detection already done)
  // position.x is already the left edge of the centered block, calculate center from it
  const centerX = position?.x
    ? position.x + titleWidth / 2
    : mapBounds.x + mapBounds.width / 2;
  const titleY = position?.y || mapBounds.y + 10;

  doc.save();

  // Calculate safe text widths that stay within map bounds
  const MARGIN = 10; // 10pt margin from map edges
  const maxTextWidth = Math.min(600, mapBounds.width - MARGIN * 2);
  const titleTextWidth = Math.min(300, maxTextWidth / 2);
  const ofTextWidth = Math.min(100, maxTextWidth / 6);

  // Calculate safe X positions that keep text within bounds
  const safeLeftX = Math.max(mapBounds.x + MARGIN, centerX - maxTextWidth / 2);
  const safeRightX = Math.min(
    mapBounds.x + mapBounds.width - MARGIN,
    centerX + maxTextWidth / 2
  );
  const actualTextWidth = safeRightX - safeLeftX;

  // Main title: "GENERAL PLAN"
  const titleX = safeLeftX + (actualTextWidth - titleTextWidth) / 2;
  doc
    .fontSize(config.mainTitle.font.size)
    .fillColor("#000000")
    .font(config.mainTitle.font.family)
    .text(config.mainTitle.text, titleX, titleY, {
      width: titleTextWidth,
      align: config.mainTitle.alignment,
    });

  // "of" in italics
  const ofY = titleY + config.spacing.afterMainTitle;
  const ofX = safeLeftX + (actualTextWidth - ofTextWidth) / 2;
  doc
    .fontSize(config.ofText.font.size)
    .font(config.ofText.font.family)
    .text(config.ofText.text, ofX, ofY, {
      width: ofTextWidth,
      align: config.ofText.alignment,
    });

  // Survey of (designation), (District) District
  const district = metadata.district || "";

  // Build dynamic designation from stands inside the Outside Figure polygon.
  // Combines dynamic stand numbers with the immediate township name only (no "of ..." suffix).
  // Result: "Stands 16 - 18 Maglas Township"
  const standsInside = getStandsInsideOutsideFigure(parcels, outsideFigureData);
  const dynamicStandList = formatStandRanges(standsInside);
  // Strip any leading "Stands X - Y" / "Stand X" prefix from surveyOf, since
  // project.designation in the DB may store the full formatted string including stand numbers.
  // We only want the township description part (e.g. "Maglas Township of Shabani Mine Surface Rights A").
  const rawSurveyOf = (metadata.surveyOf || metadata.township || "").trim();
  // Remove any leading "Stands X - Y" prefix the DB may have stored
  const withoutStandsPrefix = rawSurveyOf
    .replace(/^Stands?\s+[\d,\s\-–]+/i, "")
    .trim();
  // Keep only the immediate township name — strip " of <anything>" suffix
  // e.g. "Maglas Township of Shabani Mine Surface Rights A" → "Maglas Township"
  const townshipDescription = withoutStandsPrefix
    .replace(/\s+of\s+.+$/i, "")
    .trim();
  let designation;
  if (dynamicStandList) {
    designation = townshipDescription
      ? `Stands ${dynamicStandList} ${townshipDescription}`
      : `Stands ${dynamicStandList}`;
  } else {
    // Fallback: use the full user-supplied designation as-is (also strip " of ..." suffix)
    const rawDesig = (metadata.designation || "").trim();
    designation = rawDesig.replace(/\s+of\s+.+$/i, "").trim();
  }

  if (logger) {
    logger.info({
      msg: "[PDFKit] 📋 Dynamic designation",
      standsInside: standsInside,
      townshipDescription: townshipDescription,
      designation: designation,
    });
  }

  // SI 727 Seventh Schedule (b) order:
  //   GENERAL PLAN / of / Stands 1–20 Widdicombe Township / SHEET 1 / <figure description>
  const designationY = ofY + config.spacing.afterOf;

  if (designation) {
    const surveyText = config.designation.template
      .replace("{designation}", designation);

    doc
      .fontSize(config.designation.font.size)
      .font(config.designation.font.family)
      .text(surveyText, safeLeftX, designationY, {
        width: actualTextWidth,
        align: config.designation.alignment,
        lineGap: 2,
      });

    // ── SI 727 Seventh Schedule (b): "SHEET N" line below designation ──
    let afterDesignationY = designationY + config.designation.font.size + 6;
    if (isMultiSheet) {
      const sheetLabelText = `SHEET ${sheetInfo.sheetNumber}`;
      const sheetLabelWidth = Math.min(200, actualTextWidth / 2);
      const sheetLabelX = safeLeftX + (actualTextWidth - sheetLabelWidth) / 2;
      doc
        .fontSize(config.sheetLabel.font.size)
        .font(config.sheetLabel.font.family)
        .fillColor('#000000')
        .text(sheetLabelText, sheetLabelX, afterDesignationY, {
          width: sheetLabelWidth,
          align: config.sheetLabel.alignment,
        });
      afterDesignationY = afterDesignationY + config.sheetLabel.font.size + config.spacing.afterSheet;
    }

    // Figure description with beacon sequence and stand count
    const vertices = getOutsideFigureVertices(outsideFigureData, logger);
    const standCount = standsInside.length;

    if (logger) {
      logger.info({
        msg: "[PDFKit] 📋 Title Block figure description check",
        hasSequence: !!vertices.sequence,
        sequence: vertices.sequence,
        standCount: standCount,
        isMultiSheet,
        willRender: !!(vertices.sequence && standCount > 0),
      });
    }

    const figureY = afterDesignationY + config.spacing.afterDesignation;

    if (vertices.sequence && standCount > 0) {
      let figureText;

      // ── Project-level stand totals (whole survey, not just this tile) ──
      // These come from the project's full designation stored in metadata.
      // Parse total stand count and range from metadata.surveyOf / metadata.designation,
      // e.g. "Stands 1 - 60 Maglas Township of Shabani Mine Surface Rights A" → 60, "1–60"
      const rawFullDesig = (metadata.surveyOf || metadata.designation || '').trim();
      const standRangeMatch = rawFullDesig.match(/Stands?\s+([\d]+)\s*[-–]\s*([\d]+)/i);
      let projectTotalStandCount;
      let projectStandRange;
      if (standRangeMatch) {
        const first = parseInt(standRangeMatch[1], 10);
        const last  = parseInt(standRangeMatch[2], 10);
        projectTotalStandCount = last - first + 1;
        projectStandRange = `${first}–${last}`;
      } else {
        // Fallback: use tile-clipped stand count
        projectTotalStandCount = standCount;
        const sortedFallback = standsInside.map(s => parseInt(s, 10)).filter(n => !isNaN(n)).sort((a, b) => a - b);
        projectStandRange = sortedFallback.length > 1
          ? `${sortedFallback[0]}–${sortedFallback[sortedFallback.length - 1]}`
          : (sortedFallback[0] ?? standCount).toString();
      }

      // wholePortion: from metadata (set in Project Setup), default "the whole"
      const wholePortion = (metadata.wholePortion || 'the whole').trim();

      // Convert ALL-CAPS stored values to title case (e.g. "MAGLAS TOWNSHIP" → "Maglas Township")
      const toTitleCase = s => s.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

      // Immediate township name (already stripped of " of ..." suffix)
      const township = toTitleCase(townshipDescription || (metadata.township || '').trim());

      // parentProperty: e.g. "Shabani Mine Surface Rights A"
      // ofTarget: "Maglas Township of Shabani Mine Surface Rights A" (or just township if no parent)
      const parentProp = toTitleCase((metadata.parentProperty || '').trim());
      const ofTarget = parentProp ? `${township} of ${parentProp}` : township;

      if (isMultiSheet) {
        // SI 727 Seventh Schedule (b): inter-sheet description
        const { sheetNumber, totalSheets } = sheetInfo;
        const otherNums = Array.from({ length: totalSheets }, (_, i) => i + 1)
          .filter(n => n !== sheetNumber);
        const otherSheets = otherNums.length === 1
          ? `sheet ${otherNums[0]}`
          : otherNums.slice(0, -1).map(n => `sheet ${n}`).join(', ') + ` and sheet ${otherNums[otherNums.length - 1]}`;

        // Use compressed range notation for multi-sheet stand range too
        const projectStandRangeFormatted = formatStandRanges(
          standsInside.length > 0 ? standsInside : []
        ) || projectStandRange;

        // Use the pre-computed full figure label (complete beacon sequence from unclipped
        // outsideFigureData) so every sheet shows the same closed notation, e.g.
        // "M4, M5, M6, M7, M8, M9, M4" — not just the beacons visible on this tile.
        const figureLabel = sheetInfo.fullFigureLabel || vertices.sequence;

        figureText = config.figureDescription.multiSheetTemplate
          .replace('{figureLabel}',     figureLabel)
          .replace('{otherSheets}',     otherSheets)
          .replace('{township}',        township)
          .replace('{totalStandCount}', standsInside.length)
          .replace('{standRange}',      projectStandRangeFormatted)
          .replace('{wholePortion}',    wholePortion)
          .replace('{ofTarget}',        ofTarget)
          .replace('{district}',        district);
      } else {
        // Single-sheet: use compressed range notation showing actual parcel numbers with gaps
        // e.g. "1213, 1687 - 1737, 1868, 1871 - 1989" instead of simple "1213–1989"
        const tileStandRange = formatStandRanges(standsInside);

        figureText = config.figureDescription.template
          .replace('{beaconSequence}', vertices.sequence)
          .replace('{township}',       township)
          .replace('{standCount}',     standCount)
          .replace('{standRange}',     tileStandRange)
          .replace('{wholePortion}',   wholePortion)
          .replace('{ofTarget}',       ofTarget)
          .replace('{district}',       district);
      }

      if (logger) logger.info({ msg: "[PDFKit] ✅ Rendering figure description", text: figureText, isMultiSheet });

      doc
        .fontSize(config.figureDescription.font.size)
        .font(config.figureDescription.font.family)
        .text(figureText, safeLeftX, figureY, {
          width: actualTextWidth,
          align: config.figureDescription.alignment,
          lineGap: config.figureDescription.lineGap,
        });

      // ── SI 727: "Vide diagram S.G. No. ..." line — present on every general plan ──
      const videY = doc.y + 4;
      doc
        .fontSize(config.vide.font.size)
        .font(config.vide.font.family)
        .text(config.vide.template, safeLeftX, videY, {
          width: actualTextWidth,
          align: config.vide.alignment,
          lineGap: config.vide.lineGap,
        });
    } else {
      if (logger) {
        logger.warn("[PDFKit] ⚠️  Figure description NOT rendered - missing sequence or standCount");
      }
    }
  } else {
    // Fallback if no designation
    doc
      .fontSize(config.designation.font.size)
      .font(config.designation.font.family)
      .text(`Survey of , ${district} District`, safeLeftX, designationY, {
        width: actualTextWidth,
        align: config.designation.alignment,
        lineGap: 2,
      });
  }

  doc.restore();

  // Return actual Title Block bounds for North Arrow positioning
  return {
    x: centerX - titleWidth / 2,
    y: titleY,
    width: titleWidth,
    height: titleHeight,
    centerX: centerX,
  };
}

/**
 * Draw SI 727 compliant scale bar using centrally calculated position
 * Features:
 * - Alternating black/white segments (SI 727 Section 63)
 * - Bold borders (0.5mm minimum per SI 727)
 * - Round graduation values (aesthetically pleasing, field-readable)
 * - "METRES" label and scale notation below
 * @param {Object} position - Centrally calculated collision-free position
 * @param {Object} figureBounds - Map figure bounds (scale bar must stay within this)
 */
function drawScaleBar(doc, extent, mapBounds, scale, position, figureBounds) {
  // Use figureBounds width for scale calculation (same logic as calculateBlockPositions)
  const _figW = figureBounds ? figureBounds.width : mapBounds.width;
  const mapWidthMeters = extent.maxY - extent.minY;
  const metersPerPoint = mapWidthMeters / _figW;

  // Extract scale denominator from scale.label (e.g., "1:500" → 500)
  let denominator = 1000; // Default fallback
  if (scale && scale.label) {
    const match = scale.label.match(/:(\d+)/);
    if (match) {
      denominator = parseInt(match[1], 10);
    }
  }

  // Calculate segment length to achieve consistent visual width (~40mm per segment for aesthetics)
  // Then round to nearest "nice" cartographic number for readability
  // Target ~40mm per segment at print scale for balanced aesthetics
  const TARGET_MM = 40;
  const POINTS_PER_MM = 2.835; // PDF points per mm (72pt / 25.4mm)
  const targetPoints = TARGET_MM * POINTS_PER_MM;

  // Calculate meters that fit in target width
  const rawSegmentMeters = targetPoints * metersPerPoint;

  // Round to the nearest "nice" cartographic number (shared with the DXF scale
  // bar so both formats graduate identically).
  const segmentLength = snapScaleBarSegment(rawSegmentMeters);

  const numSegments = 3; // 3 segments: 0 – 1× – 2× – 3× (clean, compact)

  const segmentLengthPoints = segmentLength / metersPerPoint;
  const totalLengthPoints = segmentLengthPoints * numSegments;

  const LABEL_FONT_SIZE = 9;   // graduation labels above bar
  const SCALE_FONT_SIZE = 9;   // "SCALE 1:XXXX" below bar
  const METRES_FONT_SIZE = 9;  // "METRES" beside bar

  // Geometry - REDUCED height for better aesthetics (was 18pt, now 9pt = 50% reduction)
  const barHeight   = 9;  // ~3.2mm - compact but visible
  const borderWidth = 2.0; // bold outline (was 1.5pt)
  const tickHeight  = 12;  // tick marks above bar (was 8pt)
  const labelGap    = 5;   // gap between tick top and label bottom (was 3pt)
  const barGap      = 10;  // gap between bar bottom and scale text (was 8pt)

  // Total height calculation with increased font sizes
  const scaleBarHeight = LABEL_FONT_SIZE + labelGap + tickHeight + barHeight + barGap + SCALE_FONT_SIZE + 10;
  const METRES_LABEL_WIDTH = 55;
  
  // Constrain scale bar to fit within figure bounds (with 20pt margin on each side)
  const _ref = figureBounds || mapBounds;
  const maxAllowedWidth = _ref.width - 40; // 20pt margin on left and right
  let scaleBarWidth = totalLengthPoints + METRES_LABEL_WIDTH;
  
  // If too wide, reduce number of segments
  if (scaleBarWidth > maxAllowedWidth && numSegments > 1) {
    const maxSegmentLengthPoints = (maxAllowedWidth - METRES_LABEL_WIDTH) / numSegments;
    const reducedSegments = Math.max(2, Math.floor((maxAllowedWidth - METRES_LABEL_WIDTH) / segmentLengthPoints));
    if (reducedSegments < numSegments) {
      numSegments = reducedSegments;
      totalLengthPoints = segmentLengthPoints * numSegments;
      scaleBarWidth = totalLengthPoints + METRES_LABEL_WIDTH;
    }
  }
  
  // Final safety clamp - ensure it fits
  if (scaleBarWidth > maxAllowedWidth) {
    scaleBarWidth = maxAllowedWidth;
    totalLengthPoints = scaleBarWidth - METRES_LABEL_WIDTH;
  }

  // Use centrally calculated position; fallback to bottom-right of figureBounds
  const scaleBarX = position?.x ?? (_ref.x + _ref.width - scaleBarWidth - 20);
  const scaleBarY = position?.y ?? (_ref.y + _ref.height - scaleBarHeight - 20);

  // barTop: leave room above for tick + label
  const barTop    = scaleBarY + LABEL_FONT_SIZE + labelGap + tickHeight;
  const barBottom = barTop + barHeight;

  doc.save();

  // --- Draw alternating black/white segments ---
  doc.lineWidth(borderWidth);
  for (let i = 0; i < numSegments; i++) {
    const x = scaleBarX + i * segmentLengthPoints;
    doc.rect(x, barTop, segmentLengthPoints, barHeight);
    if (i % 2 === 0) {
      doc.fillAndStroke("#000000", "#000000");
    } else {
      doc.fillAndStroke("#FFFFFF", "#000000");
    }
  }

  // --- Tick marks and graduation labels above bar ---
  doc.lineWidth(1.0).strokeColor("#000000");
  doc.fontSize(LABEL_FONT_SIZE).font("Helvetica-Bold").fillColor("#000000");

  for (let i = 0; i <= numSegments; i++) {
    const x = scaleBarX + i * segmentLengthPoints;
    const value = i * segmentLength;

    // Tick
    doc.moveTo(x, barTop).lineTo(x, barTop - tickHeight).stroke();

    // Label (centered on tick)
    const labelText = value.toString();
    const lw = doc.widthOfString(labelText);
    doc.text(labelText, x - lw / 2, scaleBarY, { lineBreak: false });
  }

  // --- "METRES" label beside bar (vertically centered on bar) ---
  doc
    .fontSize(METRES_FONT_SIZE)
    .font("Helvetica-Bold")
    .text("METRES", scaleBarX + totalLengthPoints + 8, barTop + barHeight / 2 - METRES_FONT_SIZE / 2, {
      lineBreak: false,
    });

  // --- Scale notation below bar (centered under bar) ---
  const scaleText = `SCALE ${scale.label}`;
  doc.fontSize(SCALE_FONT_SIZE).font("Helvetica-Bold");
  const scaleTextWidth = doc.widthOfString(scaleText);
  doc.text(
    scaleText,
    scaleBarX + totalLengthPoints / 2 - scaleTextWidth / 2,
    barBottom + barGap,
    { lineBreak: false }
  );

  doc.restore();

  return {
    x: scaleBarX,
    y: scaleBarY,
    width: scaleBarWidth,
    height: scaleBarHeight,
  };
}

/**
 * Calculate the bounding box of map features in PDF coordinates
 */
function calculateMapFeatureBounds(
  outsideFigureBoundary,
  extent,
  figureBounds
) {
  if (!outsideFigureBoundary || outsideFigureBoundary.length === 0) {
    return null;
  }

  // Transform all boundary vertices to PDF coordinates
  const pdfPoints = outsideFigureBoundary.map((vertex) =>
    transformCoords(vertex[0], vertex[1], extent, figureBounds)
  );

  // Calculate bounding box
  const minX = Math.min(...pdfPoints.map((p) => p.x));
  const maxX = Math.max(...pdfPoints.map((p) => p.x));
  const minY = Math.min(...pdfPoints.map((p) => p.y));
  const maxY = Math.max(...pdfPoints.map((p) => p.y));

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    right: maxX,
    bottom: maxY,
    pdfPoints, // Include actual polygon points for precise collision detection
  };
}

/**
 * Find best fallback position when no collision-free position exists
 * Prioritizes polygon avoidance over block collision
 * @returns {Object|null} Best candidate with score, or null if none found
 */
/**
 * Calculate minimum distance to move rect1 to avoid collision with rect2
 */
function calculateAvoidanceVector(rect1, rect2, spacing) {
  // Calculate overlap amounts in each direction
  const overlapLeft = rect1.x + rect1.width + spacing - rect2.x;
  const overlapRight = rect2.x + rect2.width + spacing - rect1.x;
  const overlapTop = rect1.y + rect1.height + spacing - rect2.y;
  const overlapBottom = rect2.y + rect2.height + spacing - rect1.y;

  // Find minimum overlap direction
  const minOverlap = Math.min(
    overlapLeft,
    overlapRight,
    overlapTop,
    overlapBottom
  );

  if (minOverlap === overlapLeft) {
    return { dx: -overlapLeft - spacing, dy: 0, distance: overlapLeft };
  } else if (minOverlap === overlapRight) {
    return { dx: overlapRight + spacing, dy: 0, distance: overlapRight };
  } else if (minOverlap === overlapTop) {
    return { dx: 0, dy: -overlapTop - spacing, distance: overlapTop };
  } else {
    return { dx: 0, dy: overlapBottom + spacing, distance: overlapBottom };
  }
}

function findBestFallbackPosition(
  candidates,
  blockWidth,
  blockHeight,
  mapFeatureBounds,
  placedBlocks,
  polygonBuffer,
  blockSpacing,
  logger,
  blockName,
  mapBounds   // REQUIRED: drawing area — blocks must never leave this boundary
) {
  logger.warn(
    `[PDFKit] ⚠️  No collision-free position found for ${blockName} - attempting iterative adjustment`
  );

  // Helper: clamp testRect so it never exits mapBounds
  const clampToBounds = (rect) => {
    if (!mapBounds) return; // safety: no-op if caller didn't pass mapBounds
    const minX = mapBounds.x;
    const minY = mapBounds.y;
    const maxX = mapBounds.x + mapBounds.width  - rect.width;
    const maxY = mapBounds.y + mapBounds.height - rect.height;
    rect.x = Math.max(minX, Math.min(rect.x, maxX));
    rect.y = Math.max(minY, Math.min(rect.y, maxY));
  };

  // Try each candidate and iteratively adjust to avoid collisions
  for (const candidate of candidates) {
    let testRect = {
      x: candidate.x,
      y: candidate.y,
      width: blockWidth,
      height: blockHeight,
    };

    // Skip candidates that start outside mapBounds
    if (mapBounds) {
      const outsideBounds =
        testRect.x < mapBounds.x ||
        testRect.y < mapBounds.y ||
        testRect.x + testRect.width  > mapBounds.x + mapBounds.width ||
        testRect.y + testRect.height > mapBounds.y + mapBounds.height;
      if (outsideBounds) continue;
    }

    let attempts = 0;
    const maxAttempts = 50;

    while (attempts < maxAttempts) {
      let overlapsPolygon = false;
      if (
        mapFeatureBounds &&
        mapFeatureBounds.pdfPoints &&
        mapFeatureBounds.pdfPoints.length > 0
      ) {
        overlapsPolygon = rectangleOverlapsPolygon(
          testRect,
          mapFeatureBounds.pdfPoints,
          polygonBuffer
        );
      }

      const collidingBlocks = placedBlocks.filter((block) =>
        rectanglesOverlap(testRect, block, blockSpacing)
      );

      // Success: no collisions and still within bounds
      if (!overlapsPolygon && collidingBlocks.length === 0) {
        logger.info(
          `[PDFKit] ✅ ${blockName} adjusted to collision-free position after ${attempts} attempts`
        );
        return {
          ...candidate,
          x: testRect.x,
          y: testRect.y,
          score: 3,
          overlapsBlock: false,
          overlapsPolygon: false,
        };
      }

      // Move away from collisions, then clamp back inside mapBounds
      if (collidingBlocks.length > 0) {
        const avoidance = calculateAvoidanceVector(
          testRect,
          collidingBlocks[0],
          blockSpacing
        );
        testRect.x += avoidance.dx;
        testRect.y += avoidance.dy;
        clampToBounds(testRect);
      } else if (overlapsPolygon) {
        testRect.y += 20;
        clampToBounds(testRect);
        if (
          testRect.y + testRect.height >
          mapFeatureBounds.bottom + polygonBuffer
        ) {
          testRect.y = candidate.y;
          testRect.x += 20;
          clampToBounds(testRect);
        }
      }

      attempts++;
    }
  }

  // If all iterative attempts failed, return best non-colliding position
  logger.error(
    `[PDFKit] ❌ ${blockName} - could not find collision-free position after all attempts`
  );

  // Last resort: find position that at least avoids polygon AND stays within bounds
  for (const candidate of candidates) {
    const testRect = {
      x: candidate.x,
      y: candidate.y,
      width: blockWidth,
      height: blockHeight,
    };

    // Must be within mapBounds
    if (mapBounds) {
      const outsideBounds =
        testRect.x < mapBounds.x ||
        testRect.y < mapBounds.y ||
        testRect.x + testRect.width  > mapBounds.x + mapBounds.width ||
        testRect.y + testRect.height > mapBounds.y + mapBounds.height;
      if (outsideBounds) continue;
    }

    let overlapsPolygon = false;
    if (
      mapFeatureBounds &&
      mapFeatureBounds.pdfPoints &&
      mapFeatureBounds.pdfPoints.length > 0
    ) {
      overlapsPolygon = rectangleOverlapsPolygon(
        testRect,
        mapFeatureBounds.pdfPoints,
        polygonBuffer
      );
    }

    if (!overlapsPolygon) {
      logger.warn(
        `[PDFKit] ⚠️  ${blockName} using polygon-free fallback (may overlap blocks)`
      );
      return {
        ...candidate,
        score: 2,
        overlapsBlock: true,
        overlapsPolygon: false,
      };
    }
  }

  // Absolute worst case: use first candidate that is within bounds
  const firstInBounds = mapBounds
    ? candidates.find(c =>
        c.x >= mapBounds.x &&
        c.y >= mapBounds.y &&
        c.x + blockWidth  <= mapBounds.x + mapBounds.width &&
        c.y + blockHeight <= mapBounds.y + mapBounds.height
      )
    : candidates[0];
  const fallback = firstInBounds || candidates[0];
  logger.error(
    `[PDFKit] ❌ ${blockName} using absolute fallback (may overlap everything)`
  );
  return {
    ...fallback,
    score: 0,
    overlapsBlock: true,
    overlapsPolygon: true,
  };
}

/**
 * Check if a rectangle overlaps with a polygon (with buffer)
 * Uses existing isPointInPolygon function defined earlier in the file
 */
/**
 * Generate candidate positions for block placement
 * Reserves top 25pt band exclusively for Title Block
 */
function generateCandidatePositions(
  mapBounds,
  blockWidth,
  blockHeight,
  reserveTopBand = true
) {
  const SPACING = 10;
  const TITLE_BLOCK_RESERVED_BAND = 25; // Top 25pt reserved for Title Block only
  const positions = [];

  // Calculate minimum Y position (below Title Block reserved band if applicable)
  const minY = reserveTopBand
    ? mapBounds.y + TITLE_BLOCK_RESERVED_BAND
    : mapBounds.y + SPACING;

  // Left side positions (top to bottom, respecting Title Block band)
  for (
    let y = minY;
    y < mapBounds.y + mapBounds.height - blockHeight - 50;
    y += 50
  ) {
    positions.push({
      x: mapBounds.x + SPACING,
      y: y,
      zone: "left",
      priority: 1,
    });
  }

  // Right side positions (top to bottom, respecting Title Block band)
  for (
    let y = minY;
    y < mapBounds.y + mapBounds.height - blockHeight - 50;
    y += 50
  ) {
    positions.push({
      x: mapBounds.x + mapBounds.width - blockWidth - SPACING,
      y: y,
      zone: "right",
      priority: 2,
    });
  }

  // Bottom positions (left to right, multiple Y levels for better distribution)
  // Generate 3 horizontal bands at different Y levels to prevent clustering
  const bottomYLevels = [
    mapBounds.y + mapBounds.height - blockHeight - 50, // Very bottom (priority 3)
    mapBounds.y + mapBounds.height - blockHeight - 120, // Mid-bottom (priority 4)
    mapBounds.y + mapBounds.height - blockHeight - 190, // Upper-bottom (priority 5)
  ];

  bottomYLevels.forEach((yLevel, levelIndex) => {
    // Finer X spacing (50pt instead of 100pt) for more position options
    for (
      let x = mapBounds.x + SPACING;
      x < mapBounds.x + mapBounds.width - blockWidth - 50;
      x += 50
    ) {
      positions.push({
        x: x,
        y: yLevel,
        zone: "bottom",
        priority: 3 + levelIndex, // Priority increases with distance from bottom
      });
    }
  });

  // Top positions only if not reserving top band (for Title Block itself)
  if (!reserveTopBand) {
    for (
      let x = mapBounds.x + SPACING;
      x < mapBounds.x + mapBounds.width - blockWidth - 50;
      x += 100
    ) {
      positions.push({
        x: x,
        y: mapBounds.y + SPACING,
        zone: "top",
        priority: 4,
      });
    }
  }

  return positions.sort((a, b) => a.priority - b.priority);
}

/**
 * Find optimal position for Title Block (special handling)
 * Title Block is constrained to top 25pt band, center-justified with 10pt offset from top
 * Dynamically adjusts horizontally to avoid outside figure polygon collision
 */
function findTitleBlockPosition(
  blockWidth,
  blockHeight,
  mapBounds,
  mapFeatureBounds,
  logger,
  scale
) {
  const TITLE_BLOCK_TOP_OFFSET = 10; // 10pt from top border
  const TITLE_BLOCK_RESERVED_BAND = 25; // Top 25pt band reserved
  const MARGIN = 10; // Minimum margin from map edges

  // Calculate buffer for polygon collision (20 meters)
  const BUFFER_METERS = 20;
  const BUFFER_MM = BUFFER_METERS * 1000;
  const BUFFER_PT = (BUFFER_MM / scale.value) * MM_TO_PT;

  const titleY = mapBounds.y + TITLE_BLOCK_TOP_OFFSET;

  // Try center position first (preferred)
  const centerX = mapBounds.x + mapBounds.width / 2 - blockWidth / 2;

  // Generate candidate X positions (center, then left-to-right sweep)
  const candidateXPositions = [centerX];

  // Add positions from center to right
  for (
    let x = centerX + 50;
    x <= mapBounds.x + mapBounds.width - blockWidth - MARGIN;
    x += 50
  ) {
    candidateXPositions.push(x);
  }

  // Add positions from center to left
  for (let x = centerX - 50; x >= mapBounds.x + MARGIN; x -= 50) {
    candidateXPositions.push(x);
  }

  // Test each position for polygon collision
  for (const testX of candidateXPositions) {
    const rect = {
      x: testX,
      y: titleY,
      width: blockWidth,
      height: blockHeight,
    };

    // Check if within bounds
    const isWithinBounds =
      testX >= mapBounds.x + MARGIN &&
      testX + blockWidth <= mapBounds.x + mapBounds.width - MARGIN;

    if (!isWithinBounds) {
      continue;
    }

    // Check collision with outside figure polygon
    let hasPolygonCollision = false;
    if (mapFeatureBounds && mapFeatureBounds.pdfPoints) {
      if (
        rectangleOverlapsPolygon(rect, mapFeatureBounds.pdfPoints, BUFFER_PT)
      ) {
        hasPolygonCollision = true;
        logger.info(
          `[PDFKit] ⚠️  Title Block position (${testX.toFixed(
            1
          )}, ${titleY.toFixed(1)}) collides with Outside Figure polygon`
        );
      }
    }

    if (!hasPolygonCollision) {
      const positionType =
        testX === centerX
          ? "center"
          : testX > centerX
          ? "right-shifted"
          : "left-shifted";
      logger.info(
        `[PDFKit] 📍 Title Block positioned at top ${positionType}: (${testX.toFixed(
          1
        )}, ${titleY.toFixed(1)})`
      );
      logger.info(
        `[PDFKit] 🎯 Title Block reserves top ${TITLE_BLOCK_RESERVED_BAND}pt band (y: ${
          mapBounds.y
        } to ${mapBounds.y + TITLE_BLOCK_RESERVED_BAND})`
      );

      return {
        x: testX,
        y: titleY,
        width: blockWidth,
        height: blockHeight,
        offsets: {
          top: 0,
          left: blockWidth / 2, // Centered text extends half-width left
          right: blockWidth / 2, // Centered text extends half-width right
          bottom: 0,
        },
      };
    }
  }

  // Fallback: use center position even if it collides (shouldn't happen)
  logger.warn(
    `[PDFKit] ⚠️  No collision-free position found for Title Block, using center position`
  );
  return {
    x: centerX,
    y: titleY,
    width: blockWidth,
    height: blockHeight,
    offsets: {
      top: 0,
      left: blockWidth / 2,
      right: blockWidth / 2,
      bottom: 0,
    },
  };
}

/**
 * Check if two rectangles overlap
 */
/**
 * Find optimal position for a block avoiding all obstacles
 * @param {number} topOffset - Optional offset for elements drawn above the position (e.g., title)
 * @param {number} leftOffset - Optional offset for elements drawn left of the position (e.g., compass rose)
 * @param {number} rightOffset - Optional offset for elements drawn right of the position (e.g., compass rose)
 * @param {number} bottomOffset - Optional offset for elements drawn below the position (e.g., label)
 */
function findOptimalPosition(
  blockWidth,
  blockHeight,
  mapBounds,
  mapFeatureBounds,
  placedBlocks,
  logger,
  blockName,
  scale,
  topOffset = 0,
  leftOffset = 0,
  rightOffset = 0,
  bottomOffset = 0
) {
  // Validate scale parameter
  if (!scale || !scale.value) {
    logger.error(
      `[PDFKit] ❌ Invalid scale parameter: ${JSON.stringify(scale)}`
    );
    throw new Error(
      "Scale parameter is required and must have a value property"
    );
  }

  // Convert 60 meters to PDF points based on scale (increased for maximum safety margin)
  // scale.value is the denominator (e.g., 2000 for 1:2000)
  // 60 meters = 60,000mm in real world
  // PDF points = (real_world_mm / scale) * MM_TO_PT
  const BUFFER_METERS = 60;
  const BUFFER_MM = BUFFER_METERS * 1000; // 60,000mm
  const BUFFER_PT = (BUFFER_MM / scale.value) * MM_TO_PT;

  // Reserve top band for Title Block (all other blocks stay 25pt+ from top)
  const TITLE_BLOCK_RESERVED_BAND = 25;
  const candidates = generateCandidatePositions(
    mapBounds,
    blockWidth,
    blockHeight,
    true
  );

  logger.info(
    `[PDFKit] 🔍 Finding position for ${blockName} (${blockWidth}x${blockHeight})`
  );
  logger.info(
    `[PDFKit] 🎯 Top ${TITLE_BLOCK_RESERVED_BAND}pt band reserved for Title Block - candidates start at y=${
      mapBounds.y + TITLE_BLOCK_RESERVED_BAND
    }`
  );
  logger.info(
    `[PDFKit] 📏 Buffer: ${BUFFER_METERS}m = ${BUFFER_PT.toFixed(
      1
    )}pt at scale ${scale.label}`
  );
  logger.info(`[PDFKit] 📊 Generated ${candidates.length} candidate positions`);
  if (candidates.length > 0) {
    logger.info(
      `[PDFKit] 📍 First candidate: (${candidates[0].x.toFixed(
        1
      )}, ${candidates[0].y.toFixed(1)}) in ${candidates[0].zone} zone`
    );
  }

  for (const candidate of candidates) {
    const rect = {
      x: candidate.x,
      y: candidate.y,
      width: blockWidth,
      height: blockHeight,
    };

    // Check if block is fully within map bounds with 10pt minimum margin
    // Account for elements drawn in all directions from the position
    const MARGIN = 10;
    const isWithinBounds =
      rect.x - leftOffset >= mapBounds.x + MARGIN && // Check left including offset
      rect.y - topOffset >= mapBounds.y + MARGIN && // Check top including offset
      rect.x + rect.width + rightOffset <=
        mapBounds.x + mapBounds.width - MARGIN && // Check right including offset
      rect.y + rect.height + bottomOffset <=
        mapBounds.y + mapBounds.height - MARGIN; // Check bottom including offset

    if (!isWithinBounds) {
      continue; // Skip positions that extend beyond boundaries
    }

    // Create expanded rect that includes all offsets for accurate collision detection
    // This MUST be created BEFORE polygon collision check
    const expandedRect = {
      x: rect.x - leftOffset,
      y: rect.y - topOffset,
      width: rect.width + leftOffset + rightOffset,
      height: rect.height + topOffset + bottomOffset,
    };

    // Check collision with map features (polygon) - use expandedRect to account for offsets
    if (mapFeatureBounds && mapFeatureBounds.pdfPoints) {
      if (
        rectangleOverlapsPolygon(
          expandedRect,
          mapFeatureBounds.pdfPoints,
          BUFFER_PT
        )
      ) {
        logger.info(
          `[PDFKit] ⚠️  ${blockName} position (${candidate.x.toFixed(
            1
          )}, ${candidate.y.toFixed(
            1
          )}) overlaps Outside Figure polygon (buffer: ${BUFFER_PT.toFixed(
            1
          )}pt)`
        );
        continue; // Skip this position
      }
    }

    // Check collision with already placed blocks (20pt minimum separation)

    let hasCollision = false;
    for (const placedBlock of placedBlocks) {
      // Expand placed block if it has offset metadata
      const placedExpandedRect = placedBlock.offsets
        ? {
            x: placedBlock.x - placedBlock.offsets.left,
            y: placedBlock.y - placedBlock.offsets.top,
            width:
              placedBlock.width +
              placedBlock.offsets.left +
              placedBlock.offsets.right,
            height:
              placedBlock.height +
              placedBlock.offsets.top +
              placedBlock.offsets.bottom,
          }
        : placedBlock;

      if (rectanglesOverlap(expandedRect, placedExpandedRect, 20)) {
        hasCollision = true;
        break;
      }
    }

    if (!hasCollision) {
      logger.info(
        `[PDFKit] ✅ Found position for ${blockName} at (${candidate.x.toFixed(
          1
        )}, ${candidate.y.toFixed(1)}) in ${candidate.zone} zone`
      );
      // Store position with offset metadata for accurate future collision checks
      return {
        x: candidate.x,
        y: candidate.y,
        width: blockWidth,
        height: blockHeight,
        offsets: {
          top: topOffset,
          left: leftOffset,
          right: rightOffset,
          bottom: bottomOffset,
        },
      };
    }
  }

  // Fallback: try safe zones at map edges if no position found
  logger.warn(
    `[PDFKit] ⚠️  No optimal position found for ${blockName}, trying safe zone fallbacks`
  );

  // Define safe zones at map edges (far from polygon center)
  const safeZones = [
    // Top-left corner
    {
      x: mapBounds.x + 10,
      y: mapBounds.y + TITLE_BLOCK_RESERVED_BAND + 10,
      zone: "top-left",
    },
    // Top-right corner
    {
      x: mapBounds.x + mapBounds.width - blockWidth - 10,
      y: mapBounds.y + TITLE_BLOCK_RESERVED_BAND + 10,
      zone: "top-right",
    },
    // Bottom-right corner (far from typical polygon extent)
    {
      x: mapBounds.x + mapBounds.width - blockWidth - 10,
      y: mapBounds.y + mapBounds.height - blockHeight - 10,
      zone: "bottom-right",
    },
    // Mid-right edge
    {
      x: mapBounds.x + mapBounds.width - blockWidth - 10,
      y: mapBounds.y + mapBounds.height / 2 - blockHeight / 2,
      zone: "mid-right",
    },
  ];

  // Try each safe zone
  for (const safeZone of safeZones) {
    const rect = {
      x: safeZone.x,
      y: safeZone.y,
      width: blockWidth,
      height: blockHeight,
    };

    const expandedRect = {
      x: rect.x - leftOffset,
      y: rect.y - topOffset,
      width: rect.width + leftOffset + rightOffset,
      height: rect.height + topOffset + bottomOffset,
    };

    // Check polygon collision for this safe zone
    let hasPolygonCollision = false;
    if (mapFeatureBounds && mapFeatureBounds.pdfPoints) {
      hasPolygonCollision = rectangleOverlapsPolygon(
        expandedRect,
        mapFeatureBounds.pdfPoints,
        BUFFER_PT
      );
    }

    if (!hasPolygonCollision) {
      logger.warn(
        `[PDFKit] 🆘 Using safe zone fallback for ${blockName} at ${
          safeZone.zone
        } (${safeZone.x.toFixed(1)}, ${safeZone.y.toFixed(1)})`
      );
      return {
        x: safeZone.x,
        y: safeZone.y,
        width: blockWidth,
        height: blockHeight,
        offsets: {
          top: topOffset,
          left: leftOffset,
          right: rightOffset,
          bottom: bottomOffset,
        },
      };
    }
  }

  // Ultimate fallback: top-right corner (least likely to have polygon)
  logger.error(
    `[PDFKit] ❌ All safe zones failed for ${blockName}, using ultimate fallback at top-right`
  );
  return {
    x: mapBounds.x + mapBounds.width - blockWidth - 10,
    y: mapBounds.y + TITLE_BLOCK_RESERVED_BAND + 10,
    width: blockWidth,
    height: blockHeight,
    offsets: {
      top: topOffset,
      left: leftOffset,
      right: rightOffset,
      bottom: bottomOffset,
    },
  };
}

/**
 * Calculate collision-free positions for ALL blocks with comprehensive smart placement
 * Includes: Schedule of Areas, Outside Figure Data, Beacon Description, Survey Statement, Scale Bar, North Arrow
 * @param {Array} tickMarkBounds - Array of tick mark reserved regions that blocks should avoid
 */
export function calculateBlockPositions(
  doc,
  metadata,
  parcels,
  outsideFigureData,
  beacons,
  mapBounds,
  mapFeatureBounds,
  logger,
  scale,
  extent,
  tickMarkBounds = [],
  zOrderCollisionRegistry = null,
  figureBounds = null,
  polyPts = [],
  scheduleColumnWidthsPt = null,   // NEW
) {
  // Validate scale parameter
  if (!scale || !scale.value || !scale.label) {
    logger.error({
      msg: "[PDFKit] ❌ Invalid scale parameter in calculateBlockPositions",
      scale: scale,
      scaleType: typeof scale,
    });
    throw new Error(
      "Scale parameter is required with value and label properties"
    );
  }

  // =========================================================================
  // STEP 1 — Compute all block dimensions from actual content.
  //           Zero hardcoded positions; every size is derived from data.
  // =========================================================================

  // --- Title Block ---
  const titleWidth  = 650;
  const titleHeight = calculateTitleBlockHeight(doc, metadata, outsideFigureData, mapBounds, logger, parcels);

  // --- Outside Figure Data ---
  // Column widths: col1 is DYNAMIC (matches drawOutsideFigureData logic)
  const _ofdCol2 = 40; // Metres
  const _ofdCol3 = 70; // DIRECTION (increased from 55pt for bearings)
  const _ofdCol4 = 55; // Constants — MUST match col4=55 in drawOutsideFigureData
  const _ofdCol5 = 65; // Y (increased from 55pt for coordinates)
  const _ofdCol6 = 70; // X (increased from 60pt for coordinates)
  // Measure col1 (SIDES) from actual content — same logic as drawOutsideFigureData
  let _ofdCol1 = 45; // minimum
  if (outsideFigureData?.edges?.length) {
    doc.fontSize(9).font("Helvetica");
    for (const edge of outsideFigureData.edges) {
      const w = doc.widthOfString(edge.side || "") + 8;
      if (w > _ofdCol1) _ofdCol1 = w;
    }
    _ofdCol1 = Math.max(45, Math.ceil(_ofdCol1));
  }
  const ofdWidth  = _ofdCol1 + _ofdCol2 + _ofdCol3 + _ofdCol4 + _ofdCol5 + _ofdCol6;
  const ofdRows   = outsideFigureData?.edges?.length ?? 0;
  // Exact values from drawOutsideFigureData: headerBoxHeight=40, rowHeight=12
  // pos.y = header top; tableY = pos.y + 40; rows start at pos.y + 40.
  const ofdHeight = 40 + 15 + ofdRows * 12; // headerBoxHeight(40) + columnHeader(15) + rows*rowHeight(12)

  // --- Schedule of Areas ---
  // Exact values from drawScheduleOfAreasSingleColumn:
  //   titleHeight=15, titleSpacing=15, headerHeight=25, rowHeight=15, bottomPadding=10
  // These are hardcoded in the draw function and MUST match here.
  const _sch = BLOCKS.SCHEDULE_OF_AREAS.singleColumn;
  const _schedSingleColWidth = Array.isArray(scheduleColumnWidthsPt) && scheduleColumnWidthsPt.length === 6
    ? scheduleColumnWidthsPt.reduce((s, w) => s + w, 0)
    : _sch.columns.reduce((s, c) => s + c.width, 0);
  const schedRows   = parcels?.features?.length ?? 0;
  const _SCHED_TITLE   = 15;
  const _SCHED_SPACING = 15;
  const _SCHED_HEADER  = 25;
  const _SCHED_ROW     = 15;
  const _SCHED_PAD     = 10;
  const _schedSingleColHeight = _SCHED_TITLE + _SCHED_SPACING + _SCHED_HEADER + schedRows * _SCHED_ROW + _SCHED_PAD;

  // Detect overflow: if a single column is taller than the available map height,
  // split into multiple side-by-side tables.
  const _schedAvailableHeight = mapBounds.height - 28; // 14pt margin top + bottom
  const _schedTableSpacing    = 10; // pt gap between side-by-side tables
  const _schedNeedsSplit      = _schedSingleColHeight > _schedAvailableHeight && schedRows > 0;
  let schedWidth, schedHeight, _schedNumCols, _schedRowsPerCol;
  if (_schedNeedsSplit) {
    // 3-v8 follow-up: side-by-side anchor lives at the right edge, so we no
    // longer need to keep the schedule under 60% of available height to fit in
    // a corner quadrant. Bump to 95% so each sub-table extends down the full
    // drawing space — minimises the number of columns (fewer wide blocks) at
    // the cost of using more vertical space (where there's no other claimant).
    const _schedTargetHeight  = _schedAvailableHeight * 0.95;
    const _schedRowsAtTarget  = Math.max(1, Math.floor(
      (_schedTargetHeight - _SCHED_TITLE - _SCHED_SPACING - _SCHED_HEADER - _SCHED_PAD) / _SCHED_ROW
    ));
    const _schedColsForTarget = Math.ceil(schedRows / _schedRowsAtTarget);
    // Cap so composite width never exceeds available map width
    const _schedMaxCols = Math.floor(
      (mapBounds.width + _schedTableSpacing) / (_schedSingleColWidth + _schedTableSpacing)
    );
    _schedNumCols    = Math.min(_schedColsForTarget, Math.max(2, _schedMaxCols));
    _schedRowsPerCol = Math.ceil(schedRows / _schedNumCols);
    schedHeight      = _SCHED_TITLE + _SCHED_SPACING + _SCHED_HEADER + _schedRowsPerCol * _SCHED_ROW + _SCHED_PAD;
    schedWidth       = _schedNumCols * _schedSingleColWidth + (_schedNumCols - 1) * _schedTableSpacing;
    const _schedHeightPct = ((schedHeight / _schedAvailableHeight) * 100).toFixed(0);
    logger.info(`[PDFKit] 📊 Schedule of Areas: ${schedRows} rows — ${_schedNumCols} columns × ${_schedRowsPerCol} rows (composite ${schedWidth.toFixed(0)}×${schedHeight.toFixed(0)}pt, ${_schedHeightPct}% of available height)`);
  } else {
    _schedNumCols    = 1;
    _schedRowsPerCol = schedRows;
    schedWidth       = _schedSingleColWidth;
    schedHeight      = _schedSingleColHeight;
  }

  // --- Beacon Description ---
  // Exact values from drawBeaconDescription:
  //   title renders at boxY (14pt line), tableY = boxY + 14
  //   each group renders at lineHeight=18 (from BLOCKS.BEACON_DESCRIPTION.groupFormat.lineHeight)
  // Beacon groups are classified by type (not by description property).
  const _beaconLineHeight = BLOCKS.BEACON_DESCRIPTION.groupFormat.lineHeight; // 18
  // Same shared grouping drawBeaconDescription uses, so the reserved height
  // matches the rendered block exactly.
  const beaconGroupCount = classifyBeaconGroups(beacons).length;
  const beaconWidth  = 400;
  const beaconHeight = beaconGroupCount > 0
    ? 14 + beaconGroupCount * _beaconLineHeight + 10  // title(14) + groups*lineHeight + padding
    : 0;

  // --- Survey Statement ---
  // statement(14) + sig space(30) + name(14) + title(12) + license(12) + padding(18)
  const ssWidth  = 300;
  const ssHeight = 110;

  // --- Scale Bar ---
  const _figW          = figureBounds ? figureBounds.width : mapBounds.width;
  const mapWidthMeters = extent.maxY - extent.minY;
  const metersPerPt    = mapWidthMeters / _figW;
  const rawSeg         = 40 * metersPerPt; // target 40pt per segment
  const roundTo        = rawSeg < 5 ? 1 : rawSeg < 20 ? 5 : rawSeg < 100 ? 10 : rawSeg < 500 ? 50 : 100;
  const segMeters      = Math.max(roundTo, Math.round(rawSeg / roundTo) * roundTo);
  const segPt          = segMeters / metersPerPt;
  const scaleBarWidth  = segPt * 4 + 55; // 4 segments + METRES label
  const scaleBarHeight = 85; // FIELD READABLE: increased for 14pt fonts (was 72)

  // --- North Arrow ---
  const northArrowWidth  = 70;
  const northArrowHeight = 85;

  // --- SG Signature ---
  const sgWidth  = 200;
  const sgHeight = 80;

  logger.info({
    msg: "[PDFKit] 📐 Dynamic block dimensions",
    title:        `${titleWidth.toFixed(0)}×${titleHeight.toFixed(0)}`,
    outsideFig:   `${ofdWidth}×${ofdHeight}`,
    schedule:     `${schedWidth}×${schedHeight}`,
    beacon:       `${beaconWidth}×${beaconHeight}`,
    surveyStmt:   `${ssWidth}×${ssHeight}`,
    scaleBar:     `${scaleBarWidth.toFixed(0)}×${scaleBarHeight}`,
    northArrow:   `${northArrowWidth}×${northArrowHeight}`,
    sgSignature:  `${sgWidth}×${sgHeight}`,
    mapBounds:    `(${mapBounds.x.toFixed(0)},${mapBounds.y.toFixed(0)}) ${mapBounds.width.toFixed(0)}×${mapBounds.height.toFixed(0)}`,
  });

  // =========================================================================
  // STEP 2 — Declare blocks in placement priority order.
  //           mandatory=false means a missing engine placement is not fatal;
  //           the deterministic stacker in STEP 4 handles any unplaced blocks.
  // =========================================================================

  // =========================================================================
  // Title Block: preferred at top-center, but avoid polygon collision.
  // Strategy:
  //   1. Try center position at the top.
  //   2. Sweep left then right along the same Y row.
  //   3. If no horizontal slot clears the polygon, step Y down in 20pt
  //      increments until a clear slot is found (stays within top-half).
  // The result is injected as a pre-occupied rect so all other blocks
  // automatically avoid it.
  // =========================================================================
  const _TITLE_EDGE = 14; // pt from top margin line
  const _TITLE_MARGIN = 10; // minimum margin from map edges
  const _titlePolyPts = mapFeatureBounds?.pdfPoints ?? [];

  function _findTitleSlot() {
    const centerX = mapBounds.x + (mapBounds.width - titleWidth) / 2;
    // scan Y rows from top downward (stop at mid-map so it stays a title block)
    const maxY = mapBounds.y + mapBounds.height / 2 - titleHeight;
    for (let ty = mapBounds.y + _TITLE_EDGE; ty <= maxY; ty += 20) {
      // build candidate X list: center first, then alternate left/right in 40pt steps
      const candidates = [centerX];
      for (let dx = 40; centerX - dx >= mapBounds.x + _TITLE_MARGIN || centerX + dx + titleWidth <= mapBounds.x + mapBounds.width - _TITLE_MARGIN; dx += 40) {
        if (centerX + dx + titleWidth <= mapBounds.x + mapBounds.width - _TITLE_MARGIN) candidates.push(centerX + dx);
        if (centerX - dx >= mapBounds.x + _TITLE_MARGIN) candidates.push(centerX - dx);
      }
      for (const tx of candidates) {
        if (tx < mapBounds.x + _TITLE_MARGIN || tx + titleWidth > mapBounds.x + mapBounds.width - _TITLE_MARGIN) continue;
        const rect = { x: tx, y: ty, width: titleWidth, height: titleHeight };
        if (_titlePolyPts.length === 0 || !rectangleOverlapsPolygon(rect, _titlePolyPts, 2)) {
          return { x: tx, y: ty };
        }
      }
    }
    // ultimate fallback: top-center even if it overlaps
    return { x: centerX, y: mapBounds.y + _TITLE_EDGE };
  }

  const _titleSlot = _findTitleSlot();
  const prePlacedTitleBlock = {
    name: "titleBlock",
    x: _titleSlot.x,
    y: _titleSlot.y,
    width: titleWidth,
    height: titleHeight,
  };
  logger.info(`[PDFKit] 📌 Title Block pre-placed at (${_titleSlot.x.toFixed(0)}, ${_titleSlot.y.toFixed(0)})`);

  // =========================================================================
  // STEP 2b — Polygon-coverage-aware zone assignment.
  //
  // Strategy:
  //   1. Compute the fraction of each quadrant's area covered by the polygon
  //      BOUNDING BOX (fast, conservative — real polygon is never larger).
  //   2. Rank the four quadrants by coverage ascending (least covered = best).
  //   3. Assign preferred zones to blocks in priority order using that ranking.
  //      Each block gets the NEXT least-covered quadrant so no two primary blocks
  //      compete for the same zone on the first scan pass.
  //   4. If overall polygon coverage > 60% (large polygon), log a warning and
  //      let the engine's full-map fallback handle placement — the zone hints
  //      still help spread blocks initially.
  // =========================================================================

  const _mapCx = mapBounds.x + mapBounds.width  / 2;
  const _mapCy = mapBounds.y + mapBounds.height / 2;

  // Sample each quadrant with a coarse grid using actual polygon vertices (_topoPolyPts).
  // This correctly handles diagonal polygons whose AABB covers the full map.
  const _SAMPLE_STEPS = 6;
  const _pipTest = (px, py, pts) => {
    if (!pts || pts.length < 3) return false;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  };
  const _sampleCoverage = (qx1, qy1, qx2, qy2) => {
    if (!polyPts || polyPts.length < 3) return 0;
    let inside = 0, total = 0;
    const dx = (qx2 - qx1) / _SAMPLE_STEPS, dy = (qy2 - qy1) / _SAMPLE_STEPS;
    for (let r = 0; r <= _SAMPLE_STEPS; r++) {
      for (let c = 0; c <= _SAMPLE_STEPS; c++) {
        total++;
        if (_pipTest(qx1 + c * dx, qy1 + r * dy, polyPts)) inside++;
      }
    }
    return total > 0 ? inside / total : 0;
  };

  const _quadrants = [
    { zone: 'topLeft',     x1: mapBounds.x,  y1: mapBounds.y,  x2: _mapCx,                        y2: _mapCy },
    { zone: 'topRight',    x1: _mapCx,        y1: mapBounds.y,  x2: mapBounds.x + mapBounds.width, y2: _mapCy },
    { zone: 'bottomLeft',  x1: mapBounds.x,  y1: _mapCy,       x2: _mapCx,                        y2: mapBounds.y + mapBounds.height },
    { zone: 'bottomRight', x1: _mapCx,        y1: _mapCy,       x2: mapBounds.x + mapBounds.width, y2: mapBounds.y + mapBounds.height },
  ].map(q => ({ ...q, coverage: _sampleCoverage(q.x1, q.y1, q.x2, q.y2) }))
   .sort((a, b) => a.coverage - b.coverage); // best (least polygon-covered) first

  const _overallCoverage = _sampleCoverage(mapBounds.x, mapBounds.y, mapBounds.x + mapBounds.width, mapBounds.y + mapBounds.height);

  logger.info({
    msg:             '[PDFKit] Polygon actual coverage by quadrant (point-sample)',
    overallCoverage: `${(_overallCoverage * 100).toFixed(1)}%`,
    quadrants:       _quadrants.map(q => `${q.zone}:${(q.coverage * 100).toFixed(1)}%`).join(' | '),
  });

  if (_overallCoverage > 0.60) {
    logger.warn(`[PDFKit] Polygon covers ${(_overallCoverage * 100).toFixed(1)}% of map — perimeter-biased placement active`);
  }

  // Assign one zone per block from the ranked list (least covered first)
  // Blocks that share a quadrant rank fall back to full-map scan automatically.
  let _zoneIdx = 0;
  const _nextZone = () => _quadrants[(_zoneIdx++) % _quadrants.length].zone;

  // Coordinate chain for all blocks:
  //   pos.y = top of the full rendered block (including any title/header)
  //   All height calculations below match their draw functions exactly.
  //   No separate offset constants needed — heights are self-contained.

  // Log the zone assignments for diagnostics
  // (reset _zoneIdx so we can log — zones are already consumed above; rebuild log separately)
  logger.info(`[PDFKit] 🎯 Zone assignments: OFD→${_quadrants[0]?.zone} Sched→${_quadrants[1]?.zone} Beacon→${_quadrants[2]?.zone} SurveyStmt→${_quadrants[3]?.zone}`);

  const blockDescriptors = [
    // Blocks listed in placement priority order (most important first).
    // preferredZone is dynamically assigned based on polygon coverage per quadrant.
    ...(ofdRows > 0 ? [{
      name: "outsideFigureData",
      width: ofdWidth,
      height: ofdHeight,
      mandatory: true,
      preferredZone: _nextZone(),
    }] : []),
    ...(schedRows > 0 ? [{
      name: "scheduleOfAreas",
      width: schedWidth,
      height: schedHeight,
      mandatory: true,
      preferredZone: _nextZone(),
    }] : []),
    ...(beaconHeight > 0 ? [{
      name: "beaconDescription",
      width: beaconWidth,
      height: beaconHeight,
      mandatory: false,
      preferredZone: _nextZone(),
    }] : []),
    {
      name: "surveyStatement",
      width: ssWidth,
      height: ssHeight,
      mandatory: true,
      preferredZone: _nextZone(),
    },
    {
      name: "sgSignature",
      width: sgWidth,
      height: sgHeight,
      mandatory: false,
      preferredZone: _nextZone(),
    },
  ];

  // =========================================================================
  // STEP 3 — Run the dynamic placement engine.
  // =========================================================================

  // Pre-place North Arrow at top-right so engine avoids it
  const prePlacedNorthArrow = {
    name: "northArrow",
    x: mapBounds.x + mapBounds.width - northArrowWidth - 14,
    y: mapBounds.y + 14,
    width: northArrowWidth,
    height: northArrowHeight,
  };
  logger.info(`[PDFKit] 📌 North Arrow pre-placed at top-right (${prePlacedNorthArrow.x.toFixed(0)}, ${prePlacedNorthArrow.y.toFixed(0)})`);

  // Scale Bar: prefer below title block, but only pre-place if it doesn't overlap the polygon.
  // If it overlaps, let the engine find a collision-free position dynamically.
  const _scaleBarPreferred = {
    name: "scaleBar",
    x: _titleSlot.x + (titleWidth - scaleBarWidth) / 2,
    y: _titleSlot.y + titleHeight + 8, // 8pt gap below title block
    width: scaleBarWidth,
    height: scaleBarHeight,
  };
  const _scaleBarOverlapsPolygon = mapFeatureBounds?.pdfPoints?.length > 0 &&
    rectangleOverlapsPolygon(_scaleBarPreferred, mapFeatureBounds.pdfPoints, 2);
  const prePlacedScaleBar = _scaleBarOverlapsPolygon ? null : _scaleBarPreferred;
  if (prePlacedScaleBar) {
    logger.info(`[PDFKit] 📌 Scale Bar pre-placed below title block (${prePlacedScaleBar.x.toFixed(0)}, ${prePlacedScaleBar.y.toFixed(0)})`);
  } else {
    logger.info(`[PDFKit] 🔄 Scale Bar overlaps polygon at preferred position — will be engine-placed`);
    blockDescriptors.push({
      name: "scaleBar",
      width: scaleBarWidth,
      height: scaleBarHeight,
      mandatory: true,
      preferredZone: _nextZone(),
    });
  }

  let { placements: _enginePlacements, unplaceable, needsScaleUp } = placeBlocks({
    mapBounds,
    mapFeatureBounds,
    blocks: blockDescriptors,
    tickMarkBounds,
    logger,
    rectangleOverlapsPolygon,
    preOccupied: [prePlacedTitleBlock, prePlacedNorthArrow, prePlacedScaleBar].filter(Boolean),
    parcelSegments: mapFeatureBounds?.parcelSegments ?? [],
  });

  // TOPOLOGY PRE-CHECK: Before propagating needsScaleUp for the schedule, verify whether
  // the actual whitespace around the polygon (derived from its boundary profile) can
  // accommodate the schedule. The placement engine uses a coarse grid and may underestimate
  // available space; render-time drawScheduleOfAreasMultiTable uses a finer 40 pt polygon
  // buffer and the topology-aware zone search, so it often succeeds where the engine failed.
  if (needsScaleUp && unplaceable.includes('scheduleOfAreas')) {
    const _topoCheckPts = mapFeatureBounds?.pdfPoints ?? [];
    const _topoZones = computeWhitespaceZones(_topoCheckPts, mapBounds, scale?.value, 40, 260);
    const _totalZoneArea = _topoZones.reduce((s, z) => s + z.area, 0);
    const _neededArea    = (schedWidth ?? 260) * (schedHeight ?? 100);
    if (_topoZones.length > 0 && _totalZoneArea >= _neededArea * 1.1) {
      logger.info(
        `[PDFKit] Topology pre-check: ${_topoZones.length} zone(s), ` +
        `${(_totalZoneArea / _neededArea).toFixed(1)}× schedule area — ` +
        `suppressing needsScaleUp, deferring schedule placement to render-time`
      );
      needsScaleUp = false;
      unplaceable  = unplaceable.filter(n => n !== 'scheduleOfAreas');
    } else {
      logger.warn(
        `[PDFKit] Topology pre-check: insufficient whitespace ` +
        `(${_topoZones.length} zones, ${(_totalZoneArea / _neededArea).toFixed(2)}× needed) — ` +
        `needsScaleUp stands`
      );
    }
  }

  // Merge ALL pre-placed blocks into engine placements (single source of truth)
  const placements = {
    titleBlock:  prePlacedTitleBlock,
    northArrow:  prePlacedNorthArrow,
    ...(prePlacedScaleBar ? { scaleBar: prePlacedScaleBar } : {}),
    ..._enginePlacements,
  };

  if (needsScaleUp) {
    logger.warn({
      msg: "[PDFKit] ⚠️  Some mandatory blocks could not be placed — map may need a larger scale",
      unplaceable,
    });
  } else {
    logger.info("[PDFKit] ✅ All blocks placed collision-free by dynamic engine");
  }

  // =========================================================================
  // STEP 4 — Resolve final positions for every block.
  //
  // Strategy (in order of preference):
  //   A. Use engine placement if the engine found a valid slot.
  //   B. Use 2D grid scan fallback (_stackScan2D) if the engine had no slot.
  //
  // 2D scan stacker: performs the same grid scan as the engine's _scanRegion —
  // hard-rejects polygon overlaps (with buffer) and block-to-block collisions,
  // scores by separation from placed blocks + edge alignment.
  // A cycling preferred quadrant (BL→BR→TR→TL) spreads successive stacker
  // blocks across different map regions.
  // =========================================================================

  const P = 14; // edge padding (matches EDGE_PADDING in engine)
  const GAP = 8; // gap between blocks (matches BLOCK_GAP in blockPlacementEngine.js)

  // All engine-placed rects (pre-placed + engine placements) that stacker must avoid.
  // Built lazily: includes pre-placed title/northArrow/scaleBar plus any block the
  // engine successfully placed before the stacker runs.
  const _enginePlacedRects = [
    prePlacedTitleBlock,
    prePlacedNorthArrow,
    prePlacedScaleBar,
    ...Object.values(placements),
  ].filter(Boolean);

  // All stacker-placed rects so far (for intra-stacker collision avoidance).
  const _stackerPlacedRects = [];

  // Polygon points for stacker overlap checks (same source as the engine).
  const _stackerPolyPts = mapFeatureBounds?.pdfPoints ?? [];
  const _STACKER_POLY_BUFFER = 2; // must match POLY_BUFFER in blockPlacementEngine.js

  // Parcel line segments for segment-clearance check (topology-aware placement).
  const _stackerSegments = mapFeatureBounds?.parcelSegments ?? [];
  const _SEG_BUF = 8; // clearance buffer around each segment

  // Topology scoring helper: minimum distance from rect corners to any parcel segment.
  const _stackerMinSegClearance = (rx, ry, rw, rh) => {
    if (_stackerSegments.length === 0) return 9999;
    const corners = [[rx, ry], [rx+rw, ry], [rx+rw, ry+rh], [rx, ry+rh]];
    let md = 9999;
    for (const s of _stackerSegments) {
      for (const [px, py] of corners) {
        const dx = s.x2-s.x1, dy = s.y2-s.y1, ll = dx*dx+dy*dy;
        const t = ll < 1e-10 ? 0 : Math.max(0, Math.min(1, ((px-s.x1)*dx+(py-s.y1)*dy)/ll));
        const d = Math.hypot(px-(s.x1+t*dx), py-(s.y1+t*dy));
        if (d < md) md = d;
      }
    }
    return md;
  };

  // Inline segment-rect intersection helper (mirrors _rectIntersectsSegments in blockPlacementEngine.js)
  const _stackerSegIntersects = (rect) => {
    if (_stackerSegments.length === 0) return false;
    const rx1 = rect.x - _SEG_BUF, ry1 = rect.y - _SEG_BUF;
    const rx2 = rect.x + rect.width + _SEG_BUF, ry2 = rect.y + rect.height + _SEG_BUF;
    const _cross = (ax, ay, bx, by, cx, cy, dx, dy) => {
      const d1x = bx-ax, d1y = by-ay, d2x = dx-cx, d2y = dy-cy;
      const cr = d1x*d2y - d1y*d2x;
      if (Math.abs(cr) < 1e-10) return false;
      const t = ((cx-ax)*d2y - (cy-ay)*d2x) / cr;
      const u = ((cx-ax)*d1y - (cy-ay)*d1x) / cr;
      return t>=0 && t<=1 && u>=0 && u<=1;
    };
    for (const s of _stackerSegments) {
      if (Math.min(s.x1,s.x2) > rx2 || Math.max(s.x1,s.x2) < rx1) continue;
      if (Math.min(s.y1,s.y2) > ry2 || Math.max(s.y1,s.y2) < ry1) continue;
      if (s.x1>=rx1&&s.x1<=rx2&&s.y1>=ry1&&s.y1<=ry2) return true;
      if (s.x2>=rx1&&s.x2<=rx2&&s.y2>=ry1&&s.y2<=ry2) return true;
      if (_cross(s.x1,s.y1,s.x2,s.y2, rx1,ry1,rx2,ry1)) return true;
      if (_cross(s.x1,s.y1,s.x2,s.y2, rx2,ry1,rx2,ry2)) return true;
      if (_cross(s.x1,s.y1,s.x2,s.y2, rx2,ry2,rx1,ry2)) return true;
      if (_cross(s.x1,s.y1,s.x2,s.y2, rx1,ry2,rx1,ry1)) return true;
    }
    return false;
  };

  // _overlapsAny: true if candidate overlaps any already-committed rect (engine or stacker)
  //               OR overlaps the outside figure polygon (with buffer)
  //               OR any parcel line segment passes within SEG_BUF pts of the rect.
  // This is a hard rejection — same behaviour as the engine's _scanRegion.
  const _overlapsAny = (rect) => {
    // 1. Block-to-block collision
    const allCommitted = [..._enginePlacedRects, ..._stackerPlacedRects];
    if (allCommitted.some(p =>
      !(rect.x + rect.width  + GAP <= p.x ||
        p.x + p.width  + GAP <= rect.x ||
        rect.y + rect.height + GAP <= p.y ||
        p.y + p.height + GAP <= rect.y)
    )) return true;

    // 2. Outside figure polygon overlap (hard reject — prevents blocks on survey figure)
    if (_stackerPolyPts.length > 0 &&
        rectangleOverlapsPolygon(rect, _stackerPolyPts, _STACKER_POLY_BUFFER)) {
      return true;
    }

    return false;
  };

  // Grid step for the 2D scan (matches blockPlacementEngine GRID_STEP)
  const _STACK_GRID = 8;

  // _stackScan2D: full 2D grid scan over the entire map area.
  // Hard-rejects: polygon overlap (with buffer), block collisions.
  // Scores candidates by separation from placed blocks, proximity to map edges,
  // AND distance from parcel line segments (topology-aware bonus).
  // preferredZone constrains the first-pass scan; full map is tried if no slot found.
  const _stackScan2D = (w, h, preferredZone) => {
    const xMin = mapBounds.x + P;
    const xMax = mapBounds.x + mapBounds.width  - w - P;
    const yMin = mapBounds.y + P;
    const yMax = mapBounds.y + mapBounds.height - h - P;
    if (xMax < xMin || yMax < yMin) return null;

    // Zone bounds helper (mirrors _zoneBounds in blockPlacementEngine)
    const mapCx = mapBounds.x + mapBounds.width  / 2;
    const mapCy = mapBounds.y + mapBounds.height / 2;
    const zoneMap = {
      topLeft:     { x1: xMin,  y1: yMin,  x2: Math.min(mapCx - w, xMax), y2: Math.min(mapCy - h, yMax) },
      topRight:    { x1: Math.max(mapCx, xMin), y1: yMin, x2: xMax, y2: Math.min(mapCy - h, yMax) },
      bottomLeft:  { x1: xMin,  y1: Math.max(mapCy, yMin), x2: Math.min(mapCx - w, xMax), y2: yMax },
      bottomRight: { x1: Math.max(mapCx, xMin), y1: Math.max(mapCy, yMin), x2: xMax, y2: yMax },
    };

    const _runScan = (sx1, sy1, sx2, sy2) => {
      if (sx2 < sx1 || sy2 < sy1) return null;
      let best = null, bestScore = -Infinity;
      const allPlaced = [..._enginePlacedRects, ..._stackerPlacedRects];
      const mapCxS = mapBounds.x + mapBounds.width  / 2;
      const mapCyS = mapBounds.y + mapBounds.height / 2;
      for (let y = sy1; y <= sy2; y += _STACK_GRID) {
        for (let x = sx1; x <= sx2; x += _STACK_GRID) {
          const rect = { x, y, width: w, height: h };
          // Hard rejects
          if (_stackerPolyPts.length > 0 &&
              rectangleOverlapsPolygon(rect, _stackerPolyPts, _STACKER_POLY_BUFFER)) continue;
          if (_overlapsAny(rect)) continue;
          // Score: maximise min-distance to all placed blocks
          let minDist = 9999;
          for (const p of allPlaced) {
            const dx = Math.max(0, Math.max(p.x - (x + w), x - (p.x + p.width)));
            const dy = Math.max(0, Math.max(p.y - (y + h), y - (p.y + p.height)));
            const d  = Math.sqrt(dx * dx + dy * dy);
            if (d < minDist) minDist = d;
          }
          // Edge-snap bonus: prefer slots near map boundary edges
          const edgeBonus =
            (Math.abs(x - xMin) < _STACK_GRID * 2 || Math.abs(x + w - (mapBounds.x + mapBounds.width  - P)) < _STACK_GRID * 2 ? 15 : 0) +
            (Math.abs(y - yMin) < _STACK_GRID * 2 || Math.abs(y + h - (mapBounds.y + mapBounds.height - P)) < _STACK_GRID * 2 ? 15 : 0);
          // Map-centre penalty: penalise slots near the map centre (where polygon likely is)
          const cx = x + w / 2, cy = y + h / 2;
          const distFromCentre = Math.sqrt((cx - mapCxS) ** 2 + (cy - mapCyS) ** 2);
          const centrePenalty = Math.max(0, 80 - distFromCentre * 0.15);
          // Topology bonus: prefer slots farthest from all parcel line segments
          const segClearance = _stackerMinSegClearance(x, y, w, h);
          const topoBonus = Math.min(segClearance, 200) * 0.5;
          const score = minDist + edgeBonus - centrePenalty + topoBonus;
          if (score > bestScore) { bestScore = score; best = rect; }
        }
      }
      return best;
    };

    // Pass 1: preferred zone
    if (preferredZone && zoneMap[preferredZone]) {
      const z = zoneMap[preferredZone];
      const result = _runScan(z.x1, z.y1, z.x2, z.y2);
      if (result) {
        logger.info(`[PDFKit] 🎯 [stacker] placed in preferred zone '${preferredZone}'`);
        return result;
      }
      logger.warn(`[PDFKit] ⚠️  [stacker] preferred zone '${preferredZone}' had no clear slot — full map scan`);
    }

    // Pass 2: full map
    return _runScan(xMin, yMin, xMax, yMax);
  };

  // _stackPlace: thin wrapper that calls _stackScan2D with a spread-biasing preferred zone.
  // Cycles through quadrants so successive stacker blocks land in different map regions.
  const _stackQuadrants = ['bottomLeft', 'bottomRight', 'topRight', 'topLeft'];
  let _stackQuadIdx = 0;

  // _stackRelaxedScan: like _stackScan2D full-map pass but polygon overlap is a soft
  // PENALTY instead of a hard reject.  Only block-to-block collisions remain hard.
  // This finds the "least-bad" position when no polygon-clear slot exists.
  const _stackRelaxedScan = (w, h) => {
    const xMin = mapBounds.x + P;
    const xMax = mapBounds.x + mapBounds.width  - w - P;
    const yMin = mapBounds.y + P;
    const yMax = mapBounds.y + mapBounds.height - h - P;
    if (xMax < xMin || yMax < yMin) return null;

    let best = null, bestScore = -Infinity;
    const allPlaced = [..._enginePlacedRects, ..._stackerPlacedRects];
    const mapCxR = mapBounds.x + mapBounds.width  / 2;
    const mapCyR = mapBounds.y + mapBounds.height / 2;

    for (let y = yMin; y <= yMax; y += _STACK_GRID) {
      for (let x = xMin; x <= xMax; x += _STACK_GRID) {
        const rect = { x, y, width: w, height: h };
        // Block-to-block collision is still a HARD reject
        const allCommitted = [..._enginePlacedRects, ..._stackerPlacedRects];
        if (allCommitted.some(p =>
          !(rect.x + rect.width  + GAP <= p.x ||
            p.x + p.width  + GAP <= rect.x ||
            rect.y + rect.height + GAP <= p.y ||
            p.y + p.height + GAP <= rect.y)
        )) continue;

        // Polygon overlap: very heavy PENALTY (not hard reject, but strongly discouraged)
        let polyPenalty = 0;
        if (_stackerPolyPts.length > 0 &&
            rectangleOverlapsPolygon(rect, _stackerPolyPts, _STACKER_POLY_BUFFER)) {
          polyPenalty = 2000;
        }

        // Score: prefer positions far from other blocks and polygon center
        let minDist = 9999;
        for (const p of allPlaced) {
          const dx = Math.max(0, Math.max(p.x - (x + w), x - (p.x + p.width)));
          const dy = Math.max(0, Math.max(p.y - (y + h), y - (p.y + p.height)));
          const d  = Math.sqrt(dx * dx + dy * dy);
          if (d < minDist) minDist = d;
        }
        // Edge-snap bonus
        const edgeBonus =
          (Math.abs(x - xMin) < _STACK_GRID * 2 || Math.abs(x + w - (mapBounds.x + mapBounds.width  - P)) < _STACK_GRID * 2 ? 20 : 0) +
          (Math.abs(y - yMin) < _STACK_GRID * 2 || Math.abs(y + h - (mapBounds.y + mapBounds.height - P)) < _STACK_GRID * 2 ? 20 : 0);
        // Centre penalty
        const cx = x + w / 2, cy = y + h / 2;
        const distFromCentre = Math.sqrt((cx - mapCxR) ** 2 + (cy - mapCyR) ** 2);
        const centrePenalty = Math.max(0, 80 - distFromCentre * 0.15);

        const score = minDist + edgeBonus - centrePenalty - polyPenalty;
        if (score > bestScore) { bestScore = score; best = rect; }
      }
    }
    return best;
  };

  const _stackPlace = (name, w, h) => {
    const zone = _stackQuadrants[_stackQuadIdx % _stackQuadrants.length];
    const placed = _stackScan2D(w, h, zone);
    if (placed) {
      _stackQuadIdx++;
      _stackerPlacedRects.push(placed);
      logger.info(`[PDFKit] 📦 ${name} stacked (2D scan, zone=${zone}) → (${placed.x.toFixed(0)},${placed.y.toFixed(0)})`);
      return placed;
    }
    // Pass 3: relaxed scan — polygon overlap as soft penalty, not hard reject
    const relaxed = _stackRelaxedScan(w, h);
    if (relaxed) {
      _stackQuadIdx++;
      _stackerPlacedRects.push(relaxed);
      logger.warn(`[PDFKit] 📦 ${name} stacked (RELAXED scan — may overlap polygon) → (${relaxed.x.toFixed(0)},${relaxed.y.toFixed(0)})`);
      return relaxed;
    }
    // Absolute last resort
    logger.warn(`[PDFKit] ⚠️  ${name} — no slot even with relaxed scan; using top-left fallback`);
    return { x: mapBounds.x + P, y: mapBounds.y + P, width: w, height: h };
  };

  // _pos: use engine result if available, otherwise deterministic stacker.
  const _pos = (name, w, h) => {
    const p = placements[name];
    if (p) {
      logger.info(`[PDFKit] ✅ ${name} engine-placed at (${p.x.toFixed(0)},${p.y.toFixed(0)})`);
      return p;
    }
    logger.warn(`[PDFKit] ⚠️  ${name} not engine-placed — using deterministic stacker`);
    return _stackPlace(name, w, h);
  };

  const titleBlockPos = _pos("titleBlock", titleWidth, titleHeight);

  // All block heights are exact rendered heights — no offsets needed.
  const outsideFigurePos = ofdRows > 0
    ? _pos("outsideFigureData", ofdWidth, ofdHeight)
    : { x: mapBounds.x + 14, y: mapBounds.y + 14, width: ofdWidth, height: 0 };

  const schedulePos = schedRows > 0
    ? _pos("scheduleOfAreas", schedWidth, schedHeight)
    : { x: mapBounds.x + 14, y: mapBounds.y + mapBounds.height - 14, width: schedWidth, height: 0 };

  const beaconPos = beaconHeight > 0
    ? _pos("beaconDescription", beaconWidth, beaconHeight)
    : { x: mapBounds.x + 14, y: mapBounds.y + mapBounds.height - 14, width: beaconWidth, height: 0 };

  // Place North Arrow at top-right of map area (preferred position)
  const northArrowPos = {
    x: mapBounds.x + mapBounds.width - northArrowWidth - 14,
    y: mapBounds.y + 14,
    width: northArrowWidth,
    height: northArrowHeight
  };

  // Scale Bar — use engine placement if pre-placed was null (polygon overlap), else use pre-placed
  const scaleBarPos = _pos("scaleBar", scaleBarWidth, scaleBarHeight);

  const surveyStatementPos = _pos("surveyStatement", ssWidth, ssHeight);

  const sgSignaturePos = _pos("sgSignature", sgWidth, sgHeight);

  // =========================================================================
  // Build authoritative allPlacedBlocks — includes EVERY block:
  //   • pre-placed fixed blocks (title, northArrow, scaleBar)
  //   • engine-placed blocks (outsideFigureData, scheduleOfAreas, etc.)
  //   • post-engine fixed blocks (surveyStatement, sgSignature)
  // This is the single source of truth for collision detection and registry.
  // For blocks with offsets (outsideFigureData, beaconDescription), expand
  // the rect to the full rendered bounds so downstream checks are accurate.
  // =========================================================================
  const _expandBlock = (name, pos) => {
    if (!pos) return null;
    const offsets = pos.offsets || { top: 0, left: 0, right: 0, bottom: 0 };
    return {
      name,
      x:      pos.x - offsets.left,
      y:      pos.y - offsets.top,
      width:  pos.width  + offsets.left + offsets.right,
      height: pos.height + offsets.top  + offsets.bottom,
    };
  };

  const allPlacedBlocks = [
    _expandBlock("titleBlock",        titleBlockPos),
    _expandBlock("northArrow",        northArrowPos),
    _expandBlock("scaleBar",          scaleBarPos),
    _expandBlock("outsideFigureData", outsideFigurePos),
    _expandBlock("scheduleOfAreas",   schedulePos),
    _expandBlock("beaconDescription", beaconPos),
    _expandBlock("surveyStatement",   surveyStatementPos),
    _expandBlock("sgSignature",       sgSignaturePos),
  ].filter(b => b && b.height > 0);

  // Legacy alias used by downstream callers
  const placedBlocks = allPlacedBlocks;

  // =========================================================================
  // STEP 5 — Register ALL placed blocks in the Z-order collision registry
  //           (Layer 6 — text overlays) so tick-mark pass 2 sees them.
  // =========================================================================
  if (zOrderCollisionRegistry) {
    for (const blk of allPlacedBlocks) {
      zOrderCollisionRegistry.register(6, blk, blk.name, "text-overlay");
    }
  }

  // =========================================================================
  // STEP 6 — Final collision validation log
  //           Checks: block↔block AND block↔polygon overlaps
  // =========================================================================
  let collisionCount = 0;

  // 6a. Block-to-block overlap check (all blocks against each other)
  for (let i = 0; i < allPlacedBlocks.length; i++) {
    for (let j = i + 1; j < allPlacedBlocks.length; j++) {
      if (rectanglesOverlap(allPlacedBlocks[i], allPlacedBlocks[j], 0)) {
        collisionCount++;
        logger.error({
          msg: "[PDFKit] ❌ Block↔Block collision",
          block1: allPlacedBlocks[i].name,
          block2: allPlacedBlocks[j].name,
          b1: `(${allPlacedBlocks[i].x.toFixed(0)},${allPlacedBlocks[i].y.toFixed(0)}) ${allPlacedBlocks[i].width.toFixed(0)}×${allPlacedBlocks[i].height.toFixed(0)}`,
          b2: `(${allPlacedBlocks[j].x.toFixed(0)},${allPlacedBlocks[j].y.toFixed(0)}) ${allPlacedBlocks[j].width.toFixed(0)}×${allPlacedBlocks[j].height.toFixed(0)}`,
        });
      }
    }
  }

  // 6b. Block-to-polygon overlap check (2pt buffer — tight check for actual overlap)
  // Mandatory blocks that overlap the polygon trigger paper-size escalation.
  const _mandatoryBlockNames = new Set(["outsideFigureData", "scheduleOfAreas", "scaleBar", "surveyStatement"]);
  let _polyCollisionOnMandatory = false;
  const _collisionPolyPts = mapFeatureBounds?.pdfPoints;
  if (_collisionPolyPts?.length > 0) {
    for (const blk of allPlacedBlocks) {
      if (blk.height === 0) continue;
      if (rectangleOverlapsPolygon(blk, _collisionPolyPts, 2)) {
        collisionCount++;
        const isMandatory = _mandatoryBlockNames.has(blk.name);
        // Multi-table schedules use a fluid white-space search at render time — the stacker
        // position used here is a hint, not the final rendered position. Escalating on it
        // causes 3× redundant generation passes while the fluid table always finds clear slots.
        const isScheduleWithFluidFallback = blk.name === 'scheduleOfAreas' && _schedNeedsSplit;
        if (isMandatory && !isScheduleWithFluidFallback) _polyCollisionOnMandatory = true;
        logger.error({
          msg: `[PDFKit] ❌ Block↔Polygon collision${isMandatory && !isScheduleWithFluidFallback ? ' (MANDATORY — triggers escalation)' : isMandatory ? ' (mandatory but fluid-table will reposition — no escalation)' : ''}`,
          block: blk.name,
          pos: `(${blk.x.toFixed(0)},${blk.y.toFixed(0)}) ${blk.width.toFixed(0)}×${blk.height.toFixed(0)}`,
        });
      }
    }
  }

  // Promote needsScaleUp if any mandatory block still overlaps the polygon
  if (_polyCollisionOnMandatory && !needsScaleUp) {
    needsScaleUp = true;
    logger.warn("[PDFKit] ⚠️  Mandatory block overlaps polygon after stacker — promoting needsScaleUp for paper-size escalation");
  }

  if (collisionCount === 0) {
    logger.info("[PDFKit] ✅ No collisions — all blocks placed clear of each other and the polygon");
  } else {
    logger.warn(`[PDFKit] ⚠️  ${collisionCount} collision(s) remain after dynamic placement`);
  }

  logger.info({
    msg: "[PDFKit] 📍 Final dynamic block positions",
    titleBlock:       `(${titleBlockPos.x.toFixed(0)},${titleBlockPos.y.toFixed(0)})`,
    outsideFigureData:`(${outsideFigurePos.x.toFixed(0)},${outsideFigurePos.y.toFixed(0)})`,
    scheduleOfAreas:  `(${schedulePos.x.toFixed(0)},${schedulePos.y.toFixed(0)})`,
    beaconDescription:`(${beaconPos.x.toFixed(0)},${beaconPos.y.toFixed(0)})`,
    scaleBar:         `(${scaleBarPos.x.toFixed(0)},${scaleBarPos.y.toFixed(0)})`,
    surveyStatement:  `(${surveyStatementPos.x.toFixed(0)},${surveyStatementPos.y.toFixed(0)})`,
    northArrow:       `(${northArrowPos.x.toFixed(0)},${northArrowPos.y.toFixed(0)})`,
    sgSignature:      `(${sgSignaturePos.x.toFixed(0)},${sgSignaturePos.y.toFixed(0)})`,
  });

  // 3-v8 follow-up: when the schedule splits into multiple sub-tables, the PDF
  // renderer previously ran its own polygon-aware search at draw-time. Both
  // formats now share the search by running it HERE (planner side) and storing
  // the chosen sub-table positions on blockPositions.scheduleOfAreas.placedTables.
  // - PDF renderer: drawScheduleOfAreasMultiTable is called with
  //   precomputedPlacedTables, so it skips its internal search.
  // - DXF emitter: reads placedTables and emits each sub-table at its
  //   (planner-pt → ground-metre converted) position.
  let scheduleOfAreasFinal = schedulePos;
  if (_schedNeedsSplit && parcels?.features?.length > 0 && schedulePos) {
    const _allForSched = {
      titleBlock:        titleBlockPos,
      outsideFigureData: outsideFigurePos,
      scheduleOfAreas:   schedulePos,
      beaconDescription: beaconPos,
      scaleBar:          scaleBarPos,
      surveyStatement:   surveyStatementPos,
      northArrow:        northArrowPos,
      sgSignature:       sgSignaturePos,
    };
    try {
      const _schedSearch = drawScheduleOfAreasMultiTable(
        null, parcels, schedulePos.x, schedulePos.y, mapBounds,
        _schedRowsPerCol, 10, logger, _allForSched, mapFeatureBounds,
        tickMarkBounds, scale?.value ?? 500, scheduleColumnWidthsPt,
        { searchOnly: true },
      );
      if (_schedSearch?.composite && Array.isArray(_schedSearch.placedTables) && _schedSearch.placedTables.length > 0) {
        scheduleOfAreasFinal = {
          x:      _schedSearch.composite.x,
          y:      _schedSearch.composite.y,
          width:  _schedSearch.composite.width,
          height: _schedSearch.composite.height,
          placedTables: _schedSearch.placedTables,
          standsPlaced:  _schedSearch.standsPlaced,
          missingStands: _schedSearch.missingStands,
        };
        logger.info(`[PDFKit] 📊 Planner-side schedule search: ${_schedSearch.placedTables.length} sub-tables at composite (${_schedSearch.composite.x.toFixed(0)}, ${_schedSearch.composite.y.toFixed(0)}) ${_schedSearch.composite.width.toFixed(0)}×${_schedSearch.composite.height.toFixed(0)} (${_schedSearch.standsPlaced}/${_schedSearch.standsPlaced + _schedSearch.missingStands} stands)`);
      } else {
        logger.warn('[PDFKit] 📊 Planner-side schedule search returned no placedTables — falling back to engine-placed schedulePos');
      }
    } catch (e) {
      logger.warn(`[PDFKit] 📊 Planner-side schedule search threw — keeping engine-placed schedulePos. err=${e?.message}`);
    }
  }

  // ── ① Schedule balancing is applied at DRAW time by each generator (via the
  // shared balanceScheduleTables helper), NOT here. The planner can't reach the
  // figure polygon on the PDF side (polyPts=[] and mapFeatureBounds.pdfPoints is
  // empty in the planner for dense plans), so the mirror is done where each
  // generator already knows its own figure centre + content edges in its own
  // coordinate frame. See dxfGenerator.js (ground-metres) and the PDF schedule
  // renderer (PDF points).

  return {
    titleBlock:        titleBlockPos,
    outsideFigureData: outsideFigurePos,
    scheduleOfAreas:   scheduleOfAreasFinal,
    beaconDescription: beaconPos,
    scaleBar:          scaleBarPos,
    surveyStatement:   surveyStatementPos,
    northArrow:        northArrowPos,
    sgSignature:       sgSignaturePos,
    placedBlocks,
    mapFeatureBounds,
    needsScaleUp,
    // Schedule of Areas split metadata — consumed by drawScheduleOfAreas at render time
    _schedNeedsSplit:  _schedNeedsSplit,
    _schedNumCols:     _schedNumCols,
    _schedRowsPerCol:  _schedRowsPerCol,
  };
}
/**
 * Calculate positions for inset boxes within map boundary with collision detection
 * Insets are treated as regular data blocks and positioned using the same system
 */
function calculateInsetPositions(
  insetManager,
  mapBounds,
  mapFeatureBounds,
  placedBlocks,
  logger
) {
  const insetDimensions = insetManager.getInsetDimensions();

  if (insetDimensions.length === 0) {
    return {};
  }

  logger.info(
    `[PDFKit] 📦 Positioning ${insetDimensions.length} inset boxes within map boundary...`
  );

  const SAFE_MARGIN = 5;
  const POLYGON_BUFFER = 30;
  const BLOCK_MIN_SPACING = 8;
  const insetPositions = {};

  insetDimensions.forEach((inset, index) => {
    const { id, width, height } = inset;

    // Generate candidate positions within map boundary
    // Try corners and edges first, then center positions
    const candidates = [
      // Top-right corner (preferred for insets)
      {
        x: mapBounds.x + mapBounds.width - width - SAFE_MARGIN,
        y: mapBounds.y + SAFE_MARGIN,
        zone: "top-right",
      },
      // Top-left corner
      {
        x: mapBounds.x + SAFE_MARGIN,
        y: mapBounds.y + SAFE_MARGIN,
        zone: "top-left",
      },
      // Bottom-right corner
      {
        x: mapBounds.x + mapBounds.width - width - SAFE_MARGIN,
        y: mapBounds.y + mapBounds.height - height - SAFE_MARGIN,
        zone: "bottom-right",
      },
      // Bottom-left corner
      {
        x: mapBounds.x + SAFE_MARGIN,
        y: mapBounds.y + mapBounds.height - height - SAFE_MARGIN,
        zone: "bottom-left",
      },
      // Right edge, stacked vertically
      {
        x: mapBounds.x + mapBounds.width - width - SAFE_MARGIN,
        y: mapBounds.y + 100,
        zone: "right-mid-1",
      },
      {
        x: mapBounds.x + mapBounds.width - width - SAFE_MARGIN,
        y: mapBounds.y + 200,
        zone: "right-mid-2",
      },
      {
        x: mapBounds.x + mapBounds.width - width - SAFE_MARGIN,
        y: mapBounds.y + 300,
        zone: "right-mid-3",
      },
      // Left edge, stacked vertically
      {
        x: mapBounds.x + SAFE_MARGIN,
        y: mapBounds.y + 100,
        zone: "left-mid-1",
      },
      {
        x: mapBounds.x + SAFE_MARGIN,
        y: mapBounds.y + 200,
        zone: "left-mid-2",
      },
      {
        x: mapBounds.x + SAFE_MARGIN,
        y: mapBounds.y + 300,
        zone: "left-mid-3",
      },
      // Center positions
      {
        x: mapBounds.x + mapBounds.width / 2 - width / 2,
        y: mapBounds.y + SAFE_MARGIN,
        zone: "top-center",
      },
      {
        x: mapBounds.x + mapBounds.width / 2 - width / 2,
        y: mapBounds.y + mapBounds.height - height - SAFE_MARGIN,
        zone: "bottom-center",
      },
    ];

    let positioned = false;

    for (const candidate of candidates) {
      const testRect = {
        x: candidate.x,
        y: candidate.y,
        width: width,
        height: height,
      };

      // Check if within map bounds
      const withinBounds =
        testRect.y >= mapBounds.y &&
        testRect.y + testRect.height <= mapBounds.y + mapBounds.height &&
        testRect.x >= mapBounds.x &&
        testRect.x + testRect.width <= mapBounds.x + mapBounds.width;

      if (!withinBounds) {
        continue;
      }

      // Check polygon collision
      let overlapsPolygon = false;
      if (
        mapFeatureBounds &&
        mapFeatureBounds.pdfPoints &&
        mapFeatureBounds.pdfPoints.length > 0
      ) {
        overlapsPolygon = rectangleOverlapsPolygon(
          testRect,
          mapFeatureBounds.pdfPoints,
          POLYGON_BUFFER
        );
      }

      // Check block-to-block collision
      const overlapsBlock = hasBlockToBlockCollision(
        testRect,
        placedBlocks,
        BLOCK_MIN_SPACING
      );

      if (!overlapsPolygon && !overlapsBlock) {
        insetPositions[id] = {
          x: testRect.x,
          y: testRect.y,
          width: width,
          height: height,
        };
        placedBlocks.push({ ...testRect, name: id });
        logger.info(
          `[PDFKit] ✅ ${id} placed at ${
            candidate.zone
          } (x=${testRect.x.toFixed(1)}, y=${testRect.y.toFixed(1)})`
        );
        positioned = true;
        break;
      }
    }

    if (!positioned) {
      // Fallback: place at top-right even if it overlaps
      const fallbackPos = {
        x: mapBounds.x + mapBounds.width - width - SAFE_MARGIN,
        y: mapBounds.y + SAFE_MARGIN + index * (height + 10),
      };
      insetPositions[id] = {
        x: fallbackPos.x,
        y: fallbackPos.y,
        width: width,
        height: height,
      };
      placedBlocks.push({ ...fallbackPos, width, height, name: id });
      logger.warn(`[PDFKit] ⚠️  ${id} using fallback position (may overlap)`);
    }
  });

  return insetPositions;
}

/**
 * Format area for Schedule of Areas (banker's rounding to whole numbers)
 * Uses shared block definitions for consistency
 */
const formatAreaSquareMetres = BLOCKS.formatAreaValue;

/**
 * Draw Schedule of Areas table (SI 727 full 6-column format)
 * Always uses full format: Stand No., Areas Square Metres, Diagram Number, Deed (Number/Date), Surveyor-General
 * Automatically splits into multiple side-by-side tables when the single-column height
 * would exceed the available map height (margin-to-margin).
 * @param {Array} tickMarkBounds - Tick mark regions to avoid
 * @param {Object} splitParams - Pre-computed split params from block dimension calculation
 *   { needsSplit: boolean, numCols: number, rowsPerCol: number }
 */
function drawScheduleOfAreas(
  doc,
  parcels,
  mapBounds,
  position,
  logger,
  allBlockPositions = {},
  mapFeatureBounds = null,
  tickMarkBounds = [],
  splitParams = null,
  scaleDenominator = 1000,
  scheduleColumnWidthsPt = null,   // 3-v7: caller-provided widths from planner
) {
  if (!parcels || parcels.features.length === 0) return;

  const standCount = parcels.features.length;

  // Use centrally calculated position
  const tableX = position?.x ?? mapBounds.x + 5;
  const tableY = position?.y ?? mapBounds.y + 100;

  // Shared dimension constants — must match drawScheduleOfAreasSingleColumn exactly
  const _SCHED_TITLE   = 15;
  const _SCHED_SPACING = 15;
  const _SCHED_HEADER  = 25;
  const _SCHED_ROW     = 15;
  const _SCHED_PAD     = 10;
  const _SCHED_SPACING_BETWEEN = 10; // gap between side-by-side tables
  // Column widths must match drawScheduleOfAreasSingleColumn exactly: 35+60+40+40+35+50=260
  const _schedSingleColWidth = 35 + 60 + 40 + 40 + 35 + 50;

  // Determine whether to split — use pre-computed params if provided,
  // otherwise re-derive from available height (fallback for direct callers).
  let needsSplit, numCols, rowsPerCol;
  if (splitParams) {
    needsSplit  = splitParams.needsSplit;
    numCols     = splitParams.numCols;
    rowsPerCol  = splitParams.rowsPerCol;
  } else {
    const availH  = mapBounds.height - 28;
    const singleH = _SCHED_TITLE + _SCHED_SPACING + _SCHED_HEADER + standCount * _SCHED_ROW + _SCHED_PAD;
    needsSplit = singleH > availH && standCount > 0;
    if (needsSplit) {
      // 3-v8 follow-up: match calculateBlockPositions — 95% target so the
      // schedule fills more vertical space (fewer, taller sub-tables) once
      // it lives at the right-edge anchor instead of a corner quadrant.
      const targetH      = availH * 0.95;
      const rowsAtTarget = Math.max(1, Math.floor(
        (targetH - _SCHED_TITLE - _SCHED_SPACING - _SCHED_HEADER - _SCHED_PAD) / _SCHED_ROW
      ));
      const colsForTarget = Math.ceil(standCount / rowsAtTarget);
      const maxCols = Math.floor(
        (mapBounds.width + _SCHED_SPACING_BETWEEN) / (_schedSingleColWidth + _SCHED_SPACING_BETWEEN)
      );
      numCols    = Math.min(colsForTarget, Math.max(2, maxCols));
      rowsPerCol = Math.ceil(standCount / numCols);
    } else {
      rowsPerCol = standCount;
      numCols    = 1;
    }
  }

  if (needsSplit && numCols > 1) {
    logger.info(`[PDFKit] 📊 Schedule of Areas: splitting ${standCount} stands into ${numCols} side-by-side tables (${rowsPerCol} rows each) at (${tableX.toFixed(0)},${tableY.toFixed(0)})`);
    // 3-v8 follow-up: when the planner stored placedTables on the schedule
    // block (single source — same list the DXF emitter will use), thread them
    // through as precomputedPlacedTables so the render path skips the redundant
    // search and emits at the planner-chosen positions verbatim.
    // NOTE: schedule balancing is NOT applied here yet. The PDF's planner
    // `placedTables` are arranged as a WIDE pool (spanning toward the content
    // centre) rather than the DXF's narrow side-strip, so mirroring them across
    // the content centre lands a table mid-page instead of in the opposite
    // strip. Balancing the PDF cleanly first needs the PDF↔DXF `placedTables`
    // reconciled (the divergence comes from PDFKit vs heuristic text widths).
    // The shared `balanceScheduleTables` helper is ready; wire it in once the
    // PDF schedule pools into a narrow strip like the DXF. See the plan.
    const _plannerPlacedTables = allBlockPositions?.scheduleOfAreas?.placedTables;
    // Temporarily remove the oversized pre-estimated scheduleOfAreas bounds from allBlockPositions
    // so that the multi-table placement engine does not treat its own estimated footprint as an
    // obstacle (circular self-collision that prevents any table from being placed).
    const _savedScheduleBounds = allBlockPositions ? allBlockPositions.scheduleOfAreas : undefined;
    if (allBlockPositions) delete allBlockPositions.scheduleOfAreas;
    const _multiTableBounds = drawScheduleOfAreasMultiTable(
      doc, parcels, tableX, tableY, mapBounds, rowsPerCol,
      _SCHED_SPACING_BETWEEN, logger,
      allBlockPositions,   // needed for block↔block collision avoidance
      mapFeatureBounds,    // needed for polygon overlap rejection
      tickMarkBounds,      // needed for tick mark avoidance
      scaleDenominator,
      scheduleColumnWidthsPt,   // 3-v7: caller-provided widths
      {
        precomputedPlacedTables: (Array.isArray(_plannerPlacedTables) && _plannerPlacedTables.length > 0)
          ? _plannerPlacedTables
          : null,
      },
    );
    // Patch blockPositions with the actual composite bounds so that tick mark label
    // collision checks (which run after this call) use the real rendered rect.
    if (allBlockPositions) {
      if (_multiTableBounds) {
        allBlockPositions.scheduleOfAreas = _multiTableBounds;
        logger.info(`[PDFKit] 📊 Patched blockPositions.scheduleOfAreas → actual composite (${_multiTableBounds.x.toFixed(0)},${_multiTableBounds.y.toFixed(0)}) ${_multiTableBounds.width.toFixed(0)}×${_multiTableBounds.height.toFixed(0)}`);
      } else {
        // No tables placed — restore original estimate so collision checks have something
        if (_savedScheduleBounds) allBlockPositions.scheduleOfAreas = _savedScheduleBounds;
        logger.warn(`[PDFKit] ⚠️  drawScheduleOfAreasMultiTable returned null — no tables placed`);
      }
    }
  } else {
    const totalHeight = _SCHED_TITLE + _SCHED_SPACING + _SCHED_HEADER + standCount * _SCHED_ROW + _SCHED_PAD;
    logger.info(`[PDFKit] 📊 Schedule of Areas: drawing ${standCount} stands at (${tableX.toFixed(0)},${tableY.toFixed(0)}), totalHeight=${totalHeight.toFixed(0)}pt`);
    drawScheduleOfAreasSingleColumn(doc, parcels, tableX, tableY, scheduleColumnWidthsPt);
    // Patch blockPositions with actual rendered bounds for single-column path too
    // 3-v7: width derived from caller-provided dynamic widths when available,
    // else falls back to the static 260pt sum.
    const _renderedSchedWidth =
      Array.isArray(scheduleColumnWidthsPt) && scheduleColumnWidthsPt.length === 6
        ? scheduleColumnWidthsPt.reduce((s, w) => s + w, 0)
        : _schedSingleColWidth;
    if (allBlockPositions) {
      allBlockPositions.scheduleOfAreas = { x: tableX, y: tableY, width: _renderedSchedWidth, height: totalHeight };
      logger.info(`[PDFKit] 📊 Patched blockPositions.scheduleOfAreas (single-col) → (${tableX.toFixed(0)},${tableY.toFixed(0)}) ${_renderedSchedWidth.toFixed(0)}×${totalHeight.toFixed(0)}`);
    }
  }
}

/**
 * Sample the polygon boundary at `step`-pt intervals to build directional profiles:
 *   rightAt[y]  = rightmost polygon x at scan-line y
 *   leftAt[y]   = leftmost  polygon x at scan-line y
 *   bottomAt[x] = lowest    polygon y at vertical scan x
 *   topAt[x]    = highest   polygon y at vertical scan x
 * These are used by computeWhitespaceZones() to find whitespace inside the polygon
 * bounding box (e.g. the open corner of an L-shaped parcel).
 */
function computePolygonProfile(pdfPoints, step = 20) {
  const rightAt = {}, leftAt = {}, bottomAt = {}, topAt = {};

  for (let i = 0; i < pdfPoints.length - 1; i++) {
    const p1 = pdfPoints[i], p2 = pdfPoints[i + 1];

    // Horizontal profiles (rightAt / leftAt) — sample at y intervals
    if (Math.abs(p2.y - p1.y) > 0.001) {
      const yMin = Math.min(p1.y, p2.y);
      const yMax = Math.max(p1.y, p2.y);
      for (let y = Math.ceil(yMin / step) * step; y <= yMax; y += step) {
        const t = (y - p1.y) / (p2.y - p1.y);
        const x = p1.x + t * (p2.x - p1.x);
        rightAt[y] = Math.max(rightAt[y] ?? -Infinity, x);
        leftAt[y]  = Math.min(leftAt[y]  ??  Infinity, x);
      }
    }

    // Vertical profiles (bottomAt / topAt) — sample at x intervals
    if (Math.abs(p2.x - p1.x) > 0.001) {
      const xMin = Math.min(p1.x, p2.x);
      const xMax = Math.max(p1.x, p2.x);
      for (let x = Math.ceil(xMin / step) * step; x <= xMax; x += step) {
        const t = (x - p1.x) / (p2.x - p1.x);
        const y = p1.y + t * (p2.y - p1.y);
        bottomAt[x] = Math.max(bottomAt[x] ?? -Infinity, y);
        topAt[x]    = Math.min(topAt[x]    ??  Infinity, y);
      }
    }
  }
  return { rightAt, leftAt, bottomAt, topAt };
}

/**
 * Derive rectangular whitespace zones from the actual polygon boundary profile.
 * For each directional strip (right / left / bottom / top), consecutive scan lines
 * where available width ≥ tableMinWidth are grouped into a conservative rectangle.
 *
 * Topology-aware: an L-shaped polygon exposes its open corner as a valid zone,
 * whereas a simple bounding-box approach would exclude that corner entirely.
 *
 * @param {Array}  pdfPoints      - Polygon vertices {x,y} in PDF coordinate space
 * @param {Object} mapBounds      - {x,y,width,height} of the usable map area
 * @param {number} scaleDenominator - e.g. 500 for 1:500 (used for groundWidthM annotation)
 * @param {number} bufferPt        - Min clear distance between zone edge and polygon
 * @param {number} tableMinWidth   - Minimum zone width to be considered usable (e.g. 260 pt)
 * @param {number} [scanStep=20]   - Scan resolution in PDF points
 * @returns {Array} zones sorted by preferred side (right first) then area descending
 */
function computeWhitespaceZones(
  pdfPoints, mapBounds, scaleDenominator, bufferPt, tableMinWidth, scanStep = 20
) {
  const MM_TO_PT = 1 / 0.352778;
  const mLeft   = mapBounds.x;
  const mRight  = mapBounds.x + mapBounds.width;
  const mTop    = mapBounds.y;
  const mBottom = mapBounds.y + mapBounds.height;

  const toGroundM = pts =>
    scaleDenominator ? (pts / MM_TO_PT / 1000) * scaleDenominator : null;

  if (!pdfPoints || pdfPoints.length < 3) {
    return [{ x: mLeft, y: mTop, width: mapBounds.width, height: mapBounds.height,
              side: 'full', area: mapBounds.width * mapBounds.height, groundWidthM: null }];
  }

  const profile = computePolygonProfile(pdfPoints, scanStep);
  const zones   = [];

  // Align scan starts to multiples of scanStep so they hit the same keys that
  // computePolygonProfile() wrote (which also samples at ceil(coord/step)*step).
  const yStart = Math.ceil(mTop / scanStep) * scanStep;
  const xStart = Math.ceil(mLeft / scanStep) * scanStep;

  // RIGHT strip — scan y top→bottom; available x = rightAt[y]+buf → mRight
  {
    let bandStart = null, bandMinRight = Infinity;
    const flush = (yEnd) => {
      if (bandStart === null) return;
      const x = bandMinRight + bufferPt;
      const w = mRight - x;
      if (w >= tableMinWidth)
        zones.push({ x, y: bandStart, width: w, height: yEnd - bandStart,
                     side: 'right', area: w * (yEnd - bandStart),
                     groundWidthM: toGroundM(w) });
      bandStart = null; bandMinRight = Infinity;
    };
    for (let y = yStart; y <= mBottom; y += scanStep) {
      const rx = profile.rightAt[y];
      if (rx == null || rx + bufferPt >= mRight - tableMinWidth) { flush(y); continue; }
      const avail = mRight - (rx + bufferPt);
      if (avail < tableMinWidth) { flush(y); continue; }
      if (bandStart === null) bandStart = y;
      bandMinRight = Math.min(bandMinRight, rx); // most conservative (rightmost) boundary
    }
    flush(mBottom);
  }

  // LEFT strip — scan y top→bottom; available x = mLeft → leftAt[y]-buf
  {
    let bandStart = null, bandMaxLeft = -Infinity;
    const flush = (yEnd) => {
      if (bandStart === null) return;
      const right = bandMaxLeft - bufferPt;
      const w = right - mLeft;
      if (w >= tableMinWidth)
        zones.push({ x: mLeft, y: bandStart, width: w, height: yEnd - bandStart,
                     side: 'left', area: w * (yEnd - bandStart),
                     groundWidthM: toGroundM(w) });
      bandStart = null; bandMaxLeft = -Infinity;
    };
    for (let y = yStart; y <= mBottom; y += scanStep) {
      const lx = profile.leftAt[y];
      if (lx == null || lx - bufferPt <= mLeft + tableMinWidth) { flush(y); continue; }
      const avail = (lx - bufferPt) - mLeft;
      if (avail < tableMinWidth) { flush(y); continue; }
      if (bandStart === null) bandStart = y;
      bandMaxLeft = Math.max(bandMaxLeft, lx); // most conservative (leftmost) boundary
    }
    flush(mBottom);
  }

  // BOTTOM strip — scan x left→right; available y = bottomAt[x]+buf → mBottom
  {
    let bandStart = null, bandMinBottom = Infinity;
    const flush = (xEnd) => {
      if (bandStart === null) return;
      const y = bandMinBottom + bufferPt;
      const h = mBottom - y;
      if (h >= tableMinWidth / 2 && xEnd - bandStart >= tableMinWidth)
        zones.push({ x: bandStart, y, width: xEnd - bandStart, height: h,
                     side: 'bottom', area: (xEnd - bandStart) * h,
                     groundWidthM: toGroundM(xEnd - bandStart) });
      bandStart = null; bandMinBottom = Infinity;
    };
    for (let x = xStart; x <= mRight; x += scanStep) {
      const by = profile.bottomAt[x];
      if (by == null || by + bufferPt >= mBottom) { flush(x); continue; }
      if (bandStart === null) bandStart = x;
      bandMinBottom = Math.min(bandMinBottom, by);
    }
    flush(mRight);
  }

  // TOP strip — scan x left→right; available y = mTop → topAt[x]-buf
  {
    let bandStart = null, bandMaxTop = -Infinity;
    const flush = (xEnd) => {
      if (bandStart === null) return;
      const bottom = bandMaxTop - bufferPt;
      const h = bottom - mTop;
      if (h >= tableMinWidth / 2 && xEnd - bandStart >= tableMinWidth)
        zones.push({ x: bandStart, y: mTop, width: xEnd - bandStart, height: h,
                     side: 'top', area: (xEnd - bandStart) * h,
                     groundWidthM: toGroundM(xEnd - bandStart) });
      bandStart = null; bandMaxTop = -Infinity;
    };
    for (let x = xStart; x <= mRight; x += scanStep) {
      const ty = profile.topAt[x];
      if (ty == null || ty - bufferPt <= mTop) { flush(x); continue; }
      if (bandStart === null) bandStart = x;
      bandMaxTop = Math.max(bandMaxTop, ty);
    }
    flush(mRight);
  }

  // Sort: right preferred (SI 727 natural block side), then by area descending
  const sideOrder = { right: 0, bottom: 1, left: 2, top: 3 };
  return zones
    .filter(z => z.width > 0 && z.height > 0)
    .sort((a, b) => {
      const d = (sideOrder[a.side] ?? 9) - (sideOrder[b.side] ?? 9);
      return d !== 0 ? d : b.area - a.area;
    });
}

/**
 * Draw Schedule of Areas - Multi-table layout (when single table exceeds available height)
 * Splits parcels into multiple side-by-side tables, each anchored at bottom and growing upwards
 * @param {Array} tickMarkBounds - Tick mark regions to avoid
 */
/**
 * 2026-06-06: PDF text-width measurer for computeScheduleColumnWidths.
 * Switches between Helvetica-Bold (headers) and Helvetica (body) based on
 * the supplied fontSize so doc.widthOfString returns metrics for the
 * correct font. Saves and restores the prior font/size so callers aren't
 * surprised by the side-effect.
 *
 * @param {PDFKit.PDFDocument} doc
 * @param {number} headerFontSize  - schedule header pt (typically 6)
 * @param {number} bodyFontSize    - schedule body pt   (typically 7)
 * @returns {(text:string, fontSize:number) => number}
 */
// 3-v8 follow-up: must match SCHEDULE_COLUMN_PAD_FACTOR in scheduleMeasurer.js
// so PDF (this measurer) and DXF (shared scheduleMeasurer) feed the planner
// identical scheduleColumnWidthsPt — otherwise the schedule's compositeW
// differs between formats and the side-by-side anchor lands at different x.
const _PDF_SCHEDULE_COLUMN_PAD_FACTOR = 1.15;

function buildPdfScheduleMeasurer(doc, headerFontSize, bodyFontSize) {
  return (text, fontSize) => {
    const prevFont = doc._font?.name || 'Helvetica'
    const prevSize = doc._fontSize || 10
    try {
      if (fontSize === headerFontSize) {
        doc.font('Helvetica-Bold').fontSize(fontSize)
      } else {
        doc.font('Helvetica').fontSize(fontSize)
      }
      return doc.widthOfString(String(text)) * _PDF_SCHEDULE_COLUMN_PAD_FACTOR
    } finally {
      doc.font(prevFont).fontSize(prevSize)
    }
  }
}

export function drawScheduleOfAreasMultiTable(
  doc,
  parcels,
  startX,
  startY,
  mapBounds,
  maxRowsPerTable,
  tableSpacingParam = 10,
  logger = console,
  allBlockPositions = {},
  mapFeatureBounds = null,
  tickMarkBounds = [],
  scaleDenominator = 1000,
  scheduleColumnWidthsPt = null,   // 3-v7: caller-provided widths from planner
  // 3-v8 follow-up: dual-mode support so the planner and the DXF generator can
  // share PDF's smart layout search ("one source").
  //   searchOnly=true  → run the search + per-table picking, return the chosen
  //                      placedTables without touching `doc`. doc may be null.
  //   precomputedPlacedTables → skip the search entirely and render at the
  //                      caller-supplied positions. Used by PDF render-time when
  //                      the planner has already chosen positions in searchOnly
  //                      mode.
  { searchOnly = false, precomputedPlacedTables = null } = {},
) {
  // Filter out Outside Figure parcels
  const surveyedParcels = parcels.features.filter((parcel) => {
    const stand = (parcel.properties.stand || "").toLowerCase();
    const designation = (parcel.properties.designation || "").toLowerCase();
    return (
      !stand.includes("outside figure") &&
      !designation.includes("outside figure")
    );
  });

  const standCount = surveyedParcels.length;

  // 3-v7: caller-provided widths take precedence over internal computation.
  // The planner (_generateGeoPDFInner) now computes widths once via
  // computeScheduleColumnWidths and threads them through. When absent
  // (omitted by caller), fall back to the static defaults — same values
  // the previous in-function try/catch used on font-measurer failure.
  const dynColWidths = Array.isArray(scheduleColumnWidthsPt) && scheduleColumnWidthsPt.length === 6
    ? scheduleColumnWidthsPt
    : [35, 60, 40, 40, 35, 50];
  const colStand      = dynColWidths[0];
  const colArea       = dynColWidths[1];
  const colDiagram    = dynColWidths[2];
  const colDeedNumber = dynColWidths[3];
  const colDeedDate   = dynColWidths[4];
  const colSurveyor   = dynColWidths[5];
  const tableWidth    = dynColWidths.reduce((s, w) => s + w, 0);
  const rowHeight = 15;
  const headerHeight = 25;
  const titleSpacing = 15;
  const tableSpacing = tableSpacingParam; // Space between tables horizontally
  const rowSpacing = 20; // Space between table rows vertically

  // Calculate table height
  let tableHeight =
    titleSpacing + headerHeight + maxRowsPerTable * rowHeight + 10;

  // Calculate how many tables needed
  let numTables = Math.ceil(standCount / maxRowsPerTable);
  let _maxRowsPerTable = maxRowsPerTable; // mutable local — may be increased during consolidation

  // Calculate map boundary constraints (match EDGE_PADDING = 14pt from placement engine)
  const mapLeftEdge = mapBounds.x + 14;
  const mapRightEdge = mapBounds.x + mapBounds.width - 14;
  const mapTopEdge = mapBounds.y + 14;
  const mapBottomEdge = mapBounds.y + mapBounds.height - 14;

  // Collect all OTHER block positions for collision avoidance
  // This prevents Schedule of Areas tables from overlapping with other blocks
  const otherBlocks = [];
  const blockSpacing = 10; // Minimum spacing between blocks

  if (allBlockPositions.titleBlock) {
    otherBlocks.push({ ...allBlockPositions.titleBlock, name: "titleBlock" });
  }
  if (allBlockPositions.outsideFigureData) {
    otherBlocks.push({
      ...allBlockPositions.outsideFigureData,
      name: "outsideFigureData",
    });
  }
  if (allBlockPositions.beaconDescription) {
    otherBlocks.push({
      ...allBlockPositions.beaconDescription,
      name: "beaconDescription",
    });
  }
  if (allBlockPositions.scaleBar) {
    otherBlocks.push({ ...allBlockPositions.scaleBar, name: "scaleBar" });
  }
  if (allBlockPositions.surveyStatement) {
    otherBlocks.push({
      ...allBlockPositions.surveyStatement,
      name: "surveyStatement",
    });
  }
  if (allBlockPositions.northArrow) {
    otherBlocks.push({ ...allBlockPositions.northArrow, name: "northArrow" });
  }
  if (allBlockPositions.sgSignature) {
    otherBlocks.push({ ...allBlockPositions.sgSignature, name: "sgSignature" });
  }

  logger.info(
    `[PDFKit] 📊 Schedule of Areas collision avoidance: tracking ${otherBlocks.length} other blocks`
  );

  // TOPOLOGICALLY-AWARE WHITE SPACE DETECTION
  // Test map corners to find which are OUTSIDE the polygon AND don't overlap other blocks
  const candidateZones = [];
  const polygonPoints = mapFeatureBounds?.pdfPoints || [];

  // Helper: Check if a point is inside the polygon
  const isInsidePolygon = (px, py) => {
    if (polygonPoints.length === 0) return false;
    return isPointInPolygon(
      [py, px],
      polygonPoints.map((p) => [p.y, p.x])
    );
  };

  // Helper: Check if a rectangle overlaps with any other block
  const overlapsOtherBlocks = (testX, testY, testW, testH) => {
    const spacing = 15; // 15pt spacing between blocks
    for (const block of otherBlocks) {
      if (!block.x || !block.y || !block.width || !block.height) continue;
      const overlap = !(
        testX + testW + spacing < block.x ||
        testX > block.x + block.width + spacing ||
        testY + testH + spacing < block.y ||
        testY > block.y + block.height + spacing
      );
      if (overlap) return block.name;
    }
    return null;
  };

  // Helper: Check if position overlaps with any tick mark
  const overlapsTickMarkLocal = (testX, testY, testW, testH) => {
    if (!tickMarkBounds || tickMarkBounds.length === 0) return null;
    const buffer = 10;
    for (const tick of tickMarkBounds) {
      const overlap = !(
        testX + testW + buffer < tick.x ||
        testX > tick.x + tick.width + buffer ||
        testY + testH + buffer < tick.y ||
        testY > tick.y + tick.height + buffer
      );
      if (overlap) return tick.name;
    }
    return null;
  };

  // Helper: Check if position is valid (outside polygon AND not overlapping blocks AND not overlapping tick marks)
  const isValidPosition = (x, y, w, h) => {
    // Check polygon overlap
    if (polygonPoints.length > 0) {
      const testRect = { x, y, width: w, height: h };
      if (rectangleOverlapsPolygon(testRect, polygonPoints, 40)) {
        return { valid: false, reason: "polygon" };
      }
    }
    // Check block overlap
    const blockOverlap = overlapsOtherBlocks(x, y, w, h);
    if (blockOverlap) {
      return { valid: false, reason: blockOverlap };
    }
    // Check tick mark overlap
    const tickOverlap = overlapsTickMarkLocal(x, y, w, h);
    if (tickOverlap) {
      return { valid: false, reason: `tick-${tickOverlap}` };
    }
    return { valid: true };
  };

  // Log other blocks and tick marks for debugging
  logger.info(
    `[PDFKit] 📊 Other blocks to avoid: ${otherBlocks
      .map((b) => `${b.name}(${b.x?.toFixed(0)},${b.y?.toFixed(0)})`)
      .join(", ")}`
  );
  logger.info(
    `[PDFKit] 📐 Tick marks to avoid: ${
      tickMarkBounds.length > 0
        ? tickMarkBounds
            .map((t) => `${t.name}(${t.x?.toFixed(0)},${t.y?.toFixed(0)})`)
            .join(", ")
        : "none"
    }`
  );

  // Add tick marks to otherBlocks for unified collision detection
  tickMarkBounds.forEach((tick) => {
    otherBlocks.push({ ...tick });
  });

  // PRIORITY 1 (TOPOLOGY): Derive candidate positions from actual polygon boundary profile.
  // This finds whitespace inside the polygon's bounding box (e.g. open corners of L-shaped
  // parcels) that a simple bounding-box strip approach would miss entirely.
  const gridStep = 20;
  const polygonBuffer = 40; // matches isValidPosition polygon buffer
  const topoZones = computeWhitespaceZones(
    polygonPoints, mapBounds, scaleDenominator, polygonBuffer, tableWidth, gridStep
  );

  if (topoZones.length > 0) {
    logger.info(
      `[PDFKit] Topology zones: ${topoZones.map(z =>
        `${z.side}(${z.width.toFixed(0)}×${z.height.toFixed(0)}pt` +
        (z.groundWidthM != null ? `, ~${z.groundWidthM.toFixed(0)}m` : '') + ')'
      ).join(', ')}`
    );
    for (const zone of topoZones) {
      // Allow the table's TOP to be anywhere within the zone; the table's bottom may
      // extend below the zone's banded y range (e.g. where leftAt drops near a polygon
      // vertex). isValidPosition() validates the full rectangle against the actual
      // polygon, so candidates whose bottoms overlap the polygon are filtered there.
      // This is critical: when the band height < tableHeight (common for large polygons
      // with a vertex near the bottom), the old `zone.height - tableHeight` constraint
      // produced zero candidates even when valid positions existed.
      const yEnd = Math.min(
        zone.y + zone.height,
        mapBottomEdge - tableHeight
      );
      for (let x = zone.x; x <= zone.x + zone.width - tableWidth; x += gridStep) {
        for (let y = zone.y; y <= yEnd; y += gridStep) {
          if (!isValidPosition(x, y, tableWidth, tableHeight).valid) continue;
          const dup = candidateZones.some(
            c => Math.abs(c.x - x) < gridStep && Math.abs(c.y - y) < gridStep
          );
          if (!dup) candidateZones.push({ x, y, zone: `${zone.side}-topo` });
        }
      }
    }
    logger.info(`[PDFKit] Topology scan added ${candidateZones.length} candidate positions`);
  }

  // PRIORITY 2 (FALLBACK): Full grid scan when topology scan finds nothing.
  // Retained for irregular polygons or edge cases where profile scan misses zones.
  if (candidateZones.length === 0) {
    logger.info(`[PDFKit] Topology scan found no candidates — falling back to full grid scan`);
    for (
      let x = mapRightEdge - tableWidth - 14;
      x >= mapLeftEdge + 14;
      x -= gridStep
    ) {
      for (
        let y = mapTopEdge + 14;
        y + tableHeight <= mapBottomEdge - 14;
        y += gridStep
      ) {
        const result = isValidPosition(x, y, tableWidth, tableHeight);
        if (result.valid) {
          const exists = candidateZones.some(
            (c) => Math.abs(c.x - x) < gridStep && Math.abs(c.y - y) < gridStep
          );
          if (!exists) {
            candidateZones.push({ x, y, zone: "grid-right-to-left" });
          }
        }
      }
    }
    for (
      let x = mapLeftEdge + 14;
      x + tableWidth <= mapRightEdge - 14;
      x += gridStep
    ) {
      for (
        let y = mapTopEdge + 14;
        y + tableHeight <= mapBottomEdge - 14;
        y += gridStep
      ) {
        const result = isValidPosition(x, y, tableWidth, tableHeight);
        if (result.valid) {
          const exists = candidateZones.some(
            (c) => Math.abs(c.x - x) < gridStep && Math.abs(c.y - y) < gridStep
          );
          if (!exists) {
            candidateZones.push({ x, y, zone: "grid-left-to-right" });
          }
        }
      }
    }
  }

  // PRIORITY 3: Original validated position — only if it passes all checks
  if (
    startX + tableWidth <= mapRightEdge &&
    startY + tableHeight <= mapBottomEdge &&
    isValidPosition(startX, startY, tableWidth, tableHeight).valid
  ) {
    candidateZones.push({ x: startX, y: startY, zone: "validated-original" });
  }

  // FLUID APPROACH: If not enough candidates found, try with SMALLER table heights
  // This allows tables to fit in smaller white space pockets
  if (candidateZones.length < numTables) {
    const smallerHeights = [
      tableHeight * 0.75, // 75% height
      tableHeight * 0.5, // 50% height
      tableHeight * 0.33, // 33% height
    ];

    for (const smallHeight of smallerHeights) {
      // Scan for positions that fit smaller tables - use isValidPosition
      for (
        let x = mapRightEdge - tableWidth - 14;
        x >= mapLeftEdge + 14;
        x -= gridStep
      ) {
        for (
          let y = mapTopEdge + 14;
          y + smallHeight <= mapBottomEdge - 14;
          y += gridStep
        ) {
          const result = isValidPosition(x, y, tableWidth, smallHeight);
          if (result.valid) {
            const exists = candidateZones.some(
              (c) =>
                Math.abs(c.x - x) < gridStep && Math.abs(c.y - y) < gridStep
            );
            if (!exists) {
              candidateZones.push({
                x,
                y,
                zone: "fluid-smaller",
                adaptedHeight: smallHeight,
              });
            }
          }
        }
      }
    }
    logger.info(
      `[PDFKit] 📊 Fluid scan added positions for smaller table heights`
    );
  }

  logger.info(
    `[PDFKit] 📊 Topological scan found ${candidateZones.length} candidate positions for Schedule of Areas`
  );
  logger.info(
    `[PDFKit] 📊 Splitting ${standCount} stands into ${numTables} tables (${_maxRowsPerTable} rows each)`
  );

  // Track placed tables to avoid overlaps
  const placedTables = [];

  // Helper to check if a position overlaps with placed tables, other blocks, OR the outside figure polygon
  const overlapsPlacedTable = (testX, testY, testWidth, testHeight) => {
    const testRect = {
      x: testX,
      y: testY,
      width: testWidth,
      height: testHeight,
    };

    // Check MAP BOUNDS - table must stay within map area
    if (
      testX < mapLeftEdge ||
      testX + testWidth > mapRightEdge ||
      testY < mapTopEdge ||
      testY + testHeight > mapBottomEdge
    ) {
      return true; // Silent rejection for bounds
    }

    // STRICT POLYGON CHECK with rectangle-polygon overlap detection
    if (polygonPoints.length > 0) {
      const polygonBuffer = 40; // 40pt buffer — matches isValidPosition and engine POLY_BUFFER
      if (rectangleOverlapsPolygon(testRect, polygonPoints, polygonBuffer)) {
        return true; // Reject any overlap with polygon
      }
    }

    // Check against placed Schedule of Areas tables
    for (const placed of placedTables) {
      const overlap = !(
        testX + testWidth + blockSpacing < placed.x ||
        testX > placed.x + placed.width + blockSpacing ||
        testY + testHeight + blockSpacing < placed.y ||
        testY > placed.y + placed.height + blockSpacing
      );
      if (overlap) return true;
    }

    // Check against OTHER blocks (Outside Figure Data, Beacon Description, etc.)
    for (const block of otherBlocks) {
      if (!block.x || !block.y || !block.width || !block.height) continue;
      const overlap = !(
        testX + testWidth + blockSpacing < block.x ||
        testX > block.x + block.width + blockSpacing ||
        testY + testHeight + blockSpacing < block.y ||
        testY > block.y + block.height + blockSpacing
      );
      if (overlap) {
        logger.info(
          `[PDFKit] ⚠️  Schedule table at (${testX.toFixed(0)}, ${testY.toFixed(
            0
          )}) overlaps ${block.name}`
        );
        return true;
      }
    }

    return false;
  };

  // PRE-FLIGHT: simulate placement to find how many non-overlapping tables actually fit.
  // The grid scan finds hundreds of candidate positions but only N distinct strips exist —
  // when a large polygon (e.g. developed plan at 1:500) fills most of the map, N may be
  // smaller than numTables. Pre-flight detects this and consolidates into fewer taller tables
  // that pack more rows per table, so all stands are placed.
  {
    let _dryIdx = 0, _feasible = 0;
    const _feasiblePos = [];

    for (let _t = 0; _t < numTables; _t++) {
      let _hit = false;
      while (_dryIdx < candidateZones.length) {
        const c = candidateZones[_dryIdx++];
        if (c.adaptedHeight) continue; // fluid-smaller positions use reduced heights — skip in pre-flight
        if (!overlapsPlacedTable(c.x, c.y, tableWidth, tableHeight)) {
          placedTables.push({ x: c.x, y: c.y, width: tableWidth, height: tableHeight });
          _feasiblePos.push({ x: c.x, y: c.y });
          _hit = true;
          break;
        }
      }
      if (!_hit) break;
      _feasible++;
    }

    // Reset the dry-run additions (placedTables was empty before this block)
    placedTables.length = 0;

    if (_feasible > 0 && _feasible < numTables) {
      // Re-validate positions for the consolidated (taller) table height.
      //
      // PASS 1: scan existing candidateZones for positions where the full consolidated
      //   height clears the polygon (40pt buffer) and map bounds.
      //   Checking all candidates (not just _feasiblePos) is critical: _feasiblePos
      //   was found at the original height and its y-offset may put the taller table
      //   bottom inside the polygon (rotated boundary extends into strips at lower y).
      //
      // PASS 2: fresh bounds-only grid scan — candidateZones was built for the original
      //   tableHeight, so it contains NO candidates where y + _h ≤ mapBottomEdge when
      //   _h > tableHeight (all grid positions at those small y-values were rejected by
      //   isValidPosition because the original table overlapped the polygon there).
      //   A fresh scan generates positions purely by bounds, ignoring polygon — the
      //   schedule is a mandatory SI 727 element and must show all stands even at the
      //   cost of the table overlapping polygon boundary lines in the margin strips.
      const _rows = Math.ceil(standCount / _feasible);
      const _h    = titleSpacing + headerHeight + _rows * rowHeight + 10;

      // --- Pass 1: scan existing candidateZones, polygon-aware, with adaptive heights ---
      // Positions where availH >= _h get a full-height slot.
      // Positions where availH < _h but >= minH get an adaptive slot — the main drawing
      // loop derives their row count from adaptedHeight, and greedy allocation distributes
      // all stands across variable-height tables without overlapping the north arrow strip.
      //
      // Polygon check uses tableHeight (the already-verified height from isValidPosition),
      // NOT the extended adaptive height. Extending beyond tableHeight may overlap the polygon
      // boundary in marginal areas — that is acceptable for a mandatory schedule element.
      const _findInCandidates = () => {
        const _found = [];
        const _minH = titleSpacing + headerHeight + rowHeight + 10; // at least 1 data row
        for (const cand of candidateZones) {
          if (cand.adaptedHeight) continue;
          if (cand.x < mapLeftEdge || cand.x + tableWidth > mapRightEdge) continue;
          if (cand.y < mapTopEdge  || cand.y >= mapBottomEdge) continue;
          // Cap available height at the nearest block boundary below this position
          // so consolidated heights never extend into annotation blocks.
          let _availH = mapBottomEdge - cand.y;
          for (const bl of otherBlocks) {
            if (!bl.x || !bl.y || !bl.width || !bl.height) continue;
            const _horizOverlap = cand.x + tableWidth + 15 >= bl.x && cand.x <= bl.x + bl.width + 15;
            if (_horizOverlap && bl.y > cand.y + _minH) {
              _availH = Math.min(_availH, bl.y - cand.y - 15);
            }
          }
          if (_availH < _minH) continue;
          let _self = false;
          for (const ok of _found) {
            const _okEff = Math.min(ok.availH, _h);
            const _myEff = Math.min(_availH, _h);
            if (!(cand.x + tableWidth + 10 < ok.x || cand.x > ok.x + tableWidth + 10 ||
                  cand.y + _myEff + 10 < ok.y      || cand.y > ok.y + _okEff + 10)) {
              _self = true; break;
            }
          }
          if (!_self) {
            _found.push({ x: cand.x, y: cand.y, availH: _availH, isFull: _availH >= _h });
            if (_found.length >= numTables) break;
          }
        }
        return _found;
      };

      // --- Pass 2: fresh grid scan, bottom-to-top y, skip polygon but honour critical blocks ---
      // Scans from the BOTTOM of the valid y-range upward so tables land below the header
      // zone (title, north arrow, scale bar) rather than at the top where blocks cluster.
      // Checks high-priority text blocks (survey statement, north arrow, title, etc.) to
      // avoid obscuring them; non-critical blocks (beaconDescription, outsideFigureData)
      // are skipped since polygon-area overlaps are visually tolerable for mandatory tables.
      const CRITICAL_BLOCK_NAMES = new Set([
        'titleBlock', 'northArrow', 'scaleBar', 'sgSignature', 'surveyStatement',
      ]);
      const criticalBlocks = otherBlocks.filter(b => CRITICAL_BLOCK_NAMES.has(b.name));
      const overlapsCritical = (bx, by, bw, bh) => {
        const sp = 15;
        for (const bl of criticalBlocks) {
          if (!bl.x || !bl.y || !bl.width || !bl.height) continue;
          const overlap = !(
            bx + bw + sp < bl.x || bx > bl.x + bl.width  + sp ||
            by + bh + sp < bl.y || by > bl.y + bl.height + sp
          );
          if (overlap) return bl.name;
        }
        return null;
      };

      const _findFreshSkipPolygon = () => {
        const _found = [];
        const step = 20;
        scanDone:
        for (let bx = mapRightEdge - tableWidth - 14; bx >= mapLeftEdge + 14; bx -= step) {
          // Scan y bottom-to-top so we prefer positions furthest from the header blocks
          for (let by = mapBottomEdge - 14 - _h; by >= mapTopEdge + 14; by -= step) {
            if (overlapsCritical(bx, by, tableWidth, _h)) continue;
            let _self = false;
            for (const ok of _found) {
              if (!(bx + tableWidth + 10 < ok.x || bx > ok.x + tableWidth + 10 ||
                    by + _h + 10 < ok.y          || by > ok.y + _h + 10)) {
                _self = true; break;
              }
            }
            if (!_self) {
              _found.push({ x: bx, y: by, boundsOnly: true });
              if (_found.length >= _feasible) break scanDone;
            }
          }
        }
        return _found;
      };

      // --- Pass 3: pure bounds-only, bottom-to-top (absolute last resort) ---
      const _findFreshBoundsOnly = () => {
        const _found = [];
        const step = 20;
        scanDone:
        for (let bx = mapRightEdge - tableWidth - 14; bx >= mapLeftEdge + 14; bx -= step) {
          for (let by = mapBottomEdge - 14 - _h; by >= mapTopEdge + 14; by -= step) {
            let _self = false;
            for (const ok of _found) {
              if (!(bx + tableWidth + 10 < ok.x || bx > ok.x + tableWidth + 10 ||
                    by + _h + 10 < ok.y          || by > ok.y + _h + 10)) {
                _self = true; break;
              }
            }
            if (!_self) {
              _found.push({ x: bx, y: by, boundsOnly: true });
              if (_found.length >= _feasible) break scanDone;
            }
          }
        }
        return _found;
      };

      // --- Pass 4: bounds-only scan at ORIGINAL tableHeight, numTables positions ---
      // Used when consolidation is impossible — either _h exceeds the page, or the
      // adaptive branch below finds positions whose combined capacity can't fit
      // standCount. Accepts polygon overlap since the schedule is mandatory.
      const _findBoundsOnlyOriginalHeight = () => {
        const _found = [];
        const step = 20;
        scanOrigHeight:
        for (let bx = mapRightEdge - tableWidth - 14; bx >= mapLeftEdge + 14; bx -= step) {
          for (let by = mapBottomEdge - 14 - tableHeight; by >= mapTopEdge + 14; by -= step) {
            if (overlapsCritical(bx, by, tableWidth, tableHeight)) continue;
            let _self = false;
            for (const ok of _found) {
              if (!(bx + tableWidth + 10 < ok.x || bx > ok.x + tableWidth + 10 ||
                    by + tableHeight + 10 < ok.y || by > ok.y + tableHeight + 10)) {
                _self = true; break;
              }
            }
            if (!_self) {
              _found.push({ x: bx, y: by, boundsOnly: true, origHeight: true });
              if (_found.length >= numTables) break scanOrigHeight;
            }
          }
        }
        return _found;
      };

      const _applyBoundsOnlyOrig = (positions, reason) => {
        // Distribute standCount rows across the found positions. Each position uses the
        // original tableHeight; if that height can't hold ceil(standCount/N) rows, the
        // main loop will truncate (all stands must still appear elsewhere — this is the
        // last-resort branch so truncation is the trade-off for mandatory placement).
        const _rowsPerTable = Math.ceil(standCount / positions.length);
        const _neededH = titleSpacing + headerHeight + _rowsPerTable * rowHeight + 10;
        const _pageH   = mapBottomEdge - mapTopEdge - 14 * 2;
        // Bump tableHeight up to fit required rows if it still fits on the page;
        // otherwise keep original and log the capacity shortfall.
        const _newTableHeight = Math.min(_neededH, _pageH);
        const _effRows = Math.floor((_newTableHeight - titleSpacing - headerHeight - 10) / rowHeight);
        logger.info(
          `[PDFKit] 📊 Pre-flight: bounds-only at original height (${reason}) found ${positions.length} positions ` +
          `— ${_effRows} rows/table × ${positions.length} tables = ${_effRows * positions.length} capacity ` +
          `(${standCount} stands), polygon overlap accepted for mandatory schedule`
        );
        candidateZones.length = 0;
        positions.forEach(p => candidateZones.push({
          x: p.x, y: p.y, zone: 'bounds-only-orig',
          skipBlockCheck: true,
          skipPolygonCheck: true,
        }));
        numTables        = positions.length;
        tableHeight      = _newTableHeight;
        _maxRowsPerTable = _effRows;
      };

      let _ok = _findInCandidates();
      if (_ok.length === 0) {
        logger.warn(
          `[PDFKit] 📊 Pre-flight: no polygon-clear candidates at ${_h.toFixed(0)}pt ` +
          `— fresh scan skipping polygon but honouring critical blocks`
        );
        _ok = _findFreshSkipPolygon();
      }
      if (_ok.length === 0) {
        logger.warn(
          `[PDFKit] 📊 Pre-flight: critical blocks also block all positions — pure bounds-only fallback`
        );
        _ok = _findFreshBoundsOnly();
      }
      // Final fallback: consolidated _h exceeds page height (happens when _feasible=1 and
      // standCount × rowHeight > available page height). Keep the ORIGINAL numTables at
      // the ORIGINAL tableHeight and do a bounds-only scan for numTables positions that
      // fit on the page, accepting polygon overlap.
      if (_ok.length === 0 && _h > mapBottomEdge - mapTopEdge - 14 * 2) {
        logger.warn(
          `[PDFKit] 📊 Pre-flight: consolidated _h=${_h.toFixed(0)}pt exceeds page — ` +
          `falling back to ${numTables}× original tableHeight=${tableHeight.toFixed(0)}pt bounds-only`
        );
        const _boundsOnlyOrig = _findBoundsOnlyOriginalHeight();
        if (_boundsOnlyOrig.length > 0) {
          _applyBoundsOnlyOrig(_boundsOnlyOrig, '_h exceeds page');
          _ok = []; // skip consolidation block — candidateZones already populated
        }
      }

      if (_ok.length > 0) {
        const _n = _ok.length;
        // fresh-scan positions (boundsOnly) have no isFull property — treat as full
        const _allFull = _ok.every(p => p.isFull !== false);

        if (_allFull) {
          // Uniform distribution — all positions fit the full consolidated height
          const _finalRows = Math.ceil(standCount / _n);
          const _finalH    = titleSpacing + headerHeight + _finalRows * rowHeight + 10;
          logger.info(
            `[PDFKit] 📊 Pre-flight: ${numTables} tables needed but only ${_feasible} non-overlapping ` +
            `positions fit — consolidating to ${_n} × ${_finalRows} rows (${_finalH.toFixed(0)}pt)` +
            (_ok.some(p => p.boundsOnly) ? ' [bounds-only — polygon overlap accepted for mandatory schedule]' : ' [polygon-clear]')
          );
          numTables        = _n;
          _maxRowsPerTable = _finalRows;
          tableHeight      = _finalH;
          candidateZones.length = 0;
          _ok.forEach(p => candidateZones.push({
            x: p.x, y: p.y, zone: 'consolidated',
            skipBlockCheck:  true,
            skipPolygonCheck: !!p.boundsOnly,
          }));
        } else {
          // Adaptive distribution — some positions have less than _h available.
          // Compute max rows per position from its available height, then allocate
          // rows greedily so all stands are shown without forcing tables into the
          // north arrow strip or other critical blocks.
          const _perPos = _ok.map(p => ({
            ...p,
            _maxRows: Math.floor((p.availH - titleSpacing - headerHeight - 10) / rowHeight)
          }));
          const _totalCap = _perPos.reduce((s, p) => s + p._maxRows, 0);

          if (_totalCap >= standCount) {
            let _remaining = standCount;
            const _adapted = _perPos.map(p => {
              const _r = Math.min(p._maxRows, _remaining);
              _remaining -= _r;
              return { ...p, _rows: _r, _adaptedH: titleSpacing + headerHeight + _r * rowHeight + 10 };
            }).filter(p => p._rows > 0);

            logger.info(
              `[PDFKit] 📊 Pre-flight: adaptive consolidation — ${_adapted.length} positions: ` +
              _adapted.map(p => `(${p.x.toFixed(0)},${p.y.toFixed(0)})=${p._rows}rows/${p._adaptedH.toFixed(0)}pt`).join(', ')
            );
            numTables        = _adapted.length;
            tableHeight      = Math.max(..._adapted.map(p => p._adaptedH)); // sentinel; main loop uses adaptedHeight
            _maxRowsPerTable = _adapted[0]._rows;                           // sentinel; main loop uses adaptedHeight
            candidateZones.length = 0;
            _adapted.forEach(p => candidateZones.push({
              x: p.x, y: p.y, zone: 'consolidated',
              skipBlockCheck:   true,
              skipPolygonCheck: false, // positions verified at originalTableHeight; adaptedH is <= originalH
              adaptedHeight:    p._adaptedH,
            }));
          } else {
            // Adaptive capacity insufficient — found positions collectively can't hold
            // all standCount rows. Try bounds-only scan at ORIGINAL tableHeight for
            // numTables positions, accepting polygon overlap. This gives more non-overlapping
            // slots than the taller _h scan (which forces tables to fit a height that leaves
            // no room for multiple non-overlapping positions when the polygon fills the page).
            logger.warn(
              `[PDFKit] 📊 Pre-flight: adaptive capacity ${_totalCap} < ${standCount} stands ` +
              `— falling back to ${numTables}× original tableHeight=${tableHeight.toFixed(0)}pt bounds-only`
            );
            const _boundsOnlyOrig = _findBoundsOnlyOriginalHeight();
            if (_boundsOnlyOrig.length > 0) {
              _applyBoundsOnlyOrig(_boundsOnlyOrig, 'adaptive capacity insufficient');
            } else {
              logger.warn(
                `[PDFKit] 📊 Pre-flight: bounds-only scan also empty — leaving candidateZones untouched`
              );
            }
          }
        }
      }
    }
  }

  // 3-v8 follow-up: split pick from render so searchOnly/precomputedPlacedTables
  // modes work without invoking doc.* calls. Each placedTables entry carries
  // everything the render pass needs (parcelsStartIndex, rowCount, isContinuation,
  // adaptedHeight), so the planner + DXF can consume the same list.
  if (precomputedPlacedTables) {
    placedTables.length = 0;
    for (const t of precomputedPlacedTables) placedTables.push({ ...t });
  } else {
    // SIDE-BY-SIDE layout: find a single anchor where the composite
    // (numTables sub-tables in a row) fits, then derive per-table positions
    // from that anchor. Prefer candidates where the composite clears the
    // polygon + other blocks; fall back to a bounds-only right-to-left scan
    // and ultimately to the planner-supplied startX/startY.
    const _spacingPt = tableSpacingParam;
    const _compositeW = numTables * tableWidth + (numTables - 1) * _spacingPt;
    let _anchor = null;
    for (const candidate of candidateZones) {
      if (_anchor) break;
      const _testH = candidate.adaptedHeight || tableHeight;
      if (candidate.x + _compositeW > mapRightEdge) continue;
      if (candidate.x < mapLeftEdge) continue;
      if (candidate.y < mapTopEdge || candidate.y + _testH > mapBottomEdge) continue;
      const _rect = { x: candidate.x, y: candidate.y, width: _compositeW, height: _testH };
      if (candidate.skipBlockCheck && candidate.skipPolygonCheck) {
        _anchor = candidate;
      } else {
        const _polyOK = candidate.skipPolygonCheck || polygonPoints.length === 0 ||
          !rectangleOverlapsPolygon(_rect, polygonPoints, 40);
        const _blockOK = candidate.skipBlockCheck ||
          !overlapsPlacedTable(candidate.x, candidate.y, _compositeW, _testH);
        if (_polyOK && _blockOK) _anchor = candidate;
      }
    }
    if (!_anchor) {
      logger.warn(`[PDFKit] 📊 Side-by-side: no topology candidate fits composite ${_compositeW.toFixed(0)}×${tableHeight.toFixed(0)}pt — bounds-only fallback`);
      const _step = 20;
      const _CRITICAL = new Set(['titleBlock', 'northArrow', 'scaleBar', 'sgSignature', 'surveyStatement']);
      const _hitsCritical = (bx, by, bw, bh) => {
        for (const bl of otherBlocks) {
          if (!_CRITICAL.has(bl.name)) continue;
          if (!bl.x || !bl.y || !bl.width || !bl.height) continue;
          const ov = !(bx + bw + 15 < bl.x || bx > bl.x + bl.width + 15 ||
                       by + bh + 15 < bl.y || by > bl.y + bl.height + 15);
          if (ov) return true;
        }
        return false;
      };
      boundsScan:
      for (let bx = mapRightEdge - _compositeW - 14; bx >= mapLeftEdge + 14; bx -= _step) {
        for (let by = mapTopEdge + 14; by + tableHeight <= mapBottomEdge - 14; by += _step) {
          if (!_hitsCritical(bx, by, _compositeW, tableHeight)) {
            _anchor = { x: bx, y: by, zone: 'sbs-bounds-only' };
            break boundsScan;
          }
        }
      }
    }
    if (!_anchor) {
      logger.warn(`[PDFKit] 📊 Side-by-side: bounds-only fallback empty — using engine startX/Y as anchor`);
      _anchor = { x: startX, y: startY, zone: 'sbs-planner-startxy' };
    }
    logger.info(`[PDFKit] 📊 Side-by-side schedule: anchor (${_anchor.x.toFixed(0)}, ${_anchor.y.toFixed(0)}) zone=${_anchor.zone || '?'} composite=${_compositeW.toFixed(0)}×${tableHeight.toFixed(0)}pt`);
    // Build placedTables side-by-side from the anchor.
    let _pIdx = 0;
    for (let tableNum = 0; tableNum < numTables; tableNum++) {
      const _rowsIn = Math.min(_maxRowsPerTable, standCount - _pIdx);
      if (_rowsIn === 0) break;
      placedTables.push({
        x: _anchor.x + tableNum * (tableWidth + _spacingPt),
        y: _anchor.y,
        width:  tableWidth,
        height: tableHeight,
        rowCount: _rowsIn,
        parcelsStartIndex: _pIdx,
        isContinuation: tableNum > 0,
        adaptedHeight: null,
      });
      _pIdx += _rowsIn;
    }
  }

  // searchOnly mode: return the chosen placedTables without invoking doc.* calls.
  // Used by the planner (to thread positions through blockPositions) and by the
  // DXF generator (to drive its own renderer at the same positions).
  if (searchOnly) {
    if (placedTables.length === 0) return null;
    const _cX = Math.min(...placedTables.map(t => t.x));
    const _cY = Math.min(...placedTables.map(t => t.y));
    const _cR = Math.max(...placedTables.map(t => t.x + t.width));
    const _cB = Math.max(...placedTables.map(t => t.y + t.height));
    const _placed = placedTables.reduce((s, t) => s + t.rowCount, 0);
    return {
      placedTables: placedTables.map(t => ({ ...t })),
      composite: { x: _cX, y: _cY, width: _cR - _cX, height: _cB - _cY },
      standsPlaced:  _placed,
      missingStands: standCount - _placed,
    };
  }

  // Render: iterate placedTables and draw each.
  let parcelIndex = 0;
  let tablesDrawn = 0;
  for (let tableNum = 0; tableNum < placedTables.length; tableNum++) {
    const _t = placedTables[tableNum];
    const currentTableX = _t.x;
    const currentTableY = _t.y;
    const effectiveHeight = _t.height;
    const rowsInThisTable = _t.rowCount;
    parcelIndex = _t.parcelsStartIndex;
    const parcelsForThisTable = surveyedParcels.slice(parcelIndex, parcelIndex + rowsInThisTable);

    if (_t.adaptedHeight) {
      logger.info(`[PDFKit] 📊 Using fluid table with ${rowsInThisTable} rows (adapted height: ${effectiveHeight.toFixed(0)}pt)`);
    }

    doc.save();

    // Title
    doc
      .fontSize(9)
      .font("Helvetica-Bold")
      .fillColor("#000000")
      .text(
        _t.isContinuation ? `SCHEDULE OF AREAS (cont'd)` : "SCHEDULE OF AREAS",
        currentTableX,
        currentTableY,
        {
          width: tableWidth,
          align: "center",
        }
      );

    // Header
    const headerY = currentTableY + titleSpacing;
    doc.lineWidth(0.5);
    doc.rect(currentTableX, headerY, tableWidth, headerHeight).stroke();

    // Sub-header separator Y for DEED merged cell
    const deedHeaderY = headerY + 12;
    const deedStartX = currentTableX + colStand + colArea + colDiagram;

    // Vertical lines
    // Note: the divider between DEED NUMBER and DEED DATE only starts at deedHeaderY
    // so that the DEED merged header spans both sub-columns without a line cutting through it.
    let currentX = currentTableX + colStand;
    doc
      .moveTo(currentX, headerY)
      .lineTo(currentX, headerY + headerHeight)
      .stroke();
    currentX += colArea;
    doc
      .moveTo(currentX, headerY)
      .lineTo(currentX, headerY + headerHeight)
      .stroke();
    currentX += colDiagram;
    doc
      .moveTo(currentX, headerY)
      .lineTo(currentX, headerY + headerHeight)
      .stroke();
    // DEED NUMBER | DATE divider — starts at sub-header row, not top of header
    currentX += colDeedNumber;
    doc
      .moveTo(currentX, deedHeaderY)
      .lineTo(currentX, headerY + headerHeight)
      .stroke();
    currentX += colDeedDate;
    doc
      .moveTo(currentX, headerY)
      .lineTo(currentX, headerY + headerHeight)
      .stroke();

    // Horizontal line separating DEED header from sub-headers
    doc
      .moveTo(deedStartX, deedHeaderY)
      .lineTo(deedStartX + colDeedNumber + colDeedDate, deedHeaderY)
      .stroke();

    // Header text — 6pt Bold, lineBreak:false to prevent wrapping within columns
    doc.fontSize(6).font("Helvetica-Bold");
    doc.text("STAND", currentTableX + 2, headerY + 5, {
      width: colStand - 4,
      align: "center",
      lineBreak: false,
    });
    doc.text("No.", currentTableX + 2, headerY + 12, {
      width: colStand - 4,
      align: "center",
      lineBreak: false,
    });
    doc.text("AREAS", currentTableX + colStand + 2, headerY + 2, {
      width: colArea - 4,
      align: "center",
      lineBreak: false,
    });
    doc.text("SQUARE", currentTableX + colStand + 2, headerY + 9, {
      width: colArea - 4,
      align: "center",
      lineBreak: false,
    });
    doc.text("METRES", currentTableX + colStand + 2, headerY + 16, {
      width: colArea - 4,
      align: "center",
      lineBreak: false,
    });
    doc.text("DIAGRAM", currentTableX + colStand + colArea + 2, headerY + 5, {
      width: colDiagram - 4,
      align: "center",
      lineBreak: false,
    });
    doc.text("NUMBER", currentTableX + colStand + colArea + 2, headerY + 12, {
      width: colDiagram - 4,
      align: "center",
      lineBreak: false,
    });
    doc.text("DEED", deedStartX + 2, headerY + 3, {
      width: colDeedNumber + colDeedDate - 4,
      align: "center",
      lineBreak: false,
    });
    doc.text("NUMBER", deedStartX + 2, deedHeaderY + 2, {
      width: colDeedNumber - 4,
      align: "center",
      lineBreak: false,
    });
    doc.text("DATE", deedStartX + colDeedNumber + 2, deedHeaderY + 2, {
      width: colDeedDate - 4,
      align: "center",
      lineBreak: false,
    });
    doc.text(
      "SURVEYOR-",
      currentTableX + tableWidth - colSurveyor + 2,
      headerY + 5,
      { width: colSurveyor - 4, align: "center", lineBreak: false }
    );
    doc.text(
      "GENERAL",
      currentTableX + tableWidth - colSurveyor + 2,
      headerY + 12,
      { width: colSurveyor - 4, align: "center", lineBreak: false }
    );

    // Rows
    let currentY = headerY + headerHeight;
    parcelsForThisTable.forEach((parcel, index) => {
      const stand = parcel.properties.stand || `P${parcelIndex + index + 1}`;
      const areaM2 = parcel.properties.area_m2 || 0;
      const areaFormatted = formatAreaSquareMetres(areaM2);

      doc.rect(currentTableX, currentY, tableWidth, rowHeight).stroke();

      currentX = currentTableX + colStand;
      doc
        .moveTo(currentX, currentY)
        .lineTo(currentX, currentY + rowHeight)
        .stroke();
      currentX += colArea;
      doc
        .moveTo(currentX, currentY)
        .lineTo(currentX, currentY + rowHeight)
        .stroke();
      currentX += colDiagram;
      doc
        .moveTo(currentX, currentY)
        .lineTo(currentX, currentY + rowHeight)
        .stroke();
      currentX += colDeedNumber;
      doc
        .moveTo(currentX, currentY)
        .lineTo(currentX, currentY + rowHeight)
        .stroke();
      currentX += colDeedDate;
      doc
        .moveTo(currentX, currentY)
        .lineTo(currentX, currentY + rowHeight)
        .stroke();

      doc.fontSize(7).font("Helvetica");
      doc.text(stand, currentTableX + 2, currentY + 4, {
        width: colStand - 4,
        align: "center",
        lineBreak: false,
      });
      doc.text(areaFormatted, currentTableX + colStand + 2, currentY + 4, {
        width: colArea - 4,
        align: "center",
        lineBreak: false,
      });

      currentY += rowHeight;
    });

    doc.restore();

    parcelIndex += rowsInThisTable;
    tablesDrawn++;
  }

  logger.info(
    `[PDFKit] ✅ Drew ${tablesDrawn} Schedule of Areas tables (${parcelIndex} of ${standCount} stands) using white space search`
  );

  // Return composite bounding box of all placed tables
  // Caller uses this to patch blockPositions.scheduleOfAreas with actual rendered bounds
  if (placedTables.length === 0) return null;
  const compositeX = Math.min(...placedTables.map(t => t.x));
  const compositeY = Math.min(...placedTables.map(t => t.y));
  const compositeRight  = Math.max(...placedTables.map(t => t.x + t.width));
  const compositeBottom = Math.max(...placedTables.map(t => t.y + t.height));
  return {
    x: compositeX,
    y: compositeY,
    width:  compositeRight  - compositeX,
    height: compositeBottom - compositeY,
  };
}

/**
 * Draw Schedule of Areas - Single column (for ≤50 stands)
 * Full SI 727 6-column format
 */
function drawScheduleOfAreasSingleColumn(doc, parcels, tableX, tableY, scheduleColumnWidthsPt = null) {
  // 3-v7: caller-provided widths take precedence; falls back to the legacy
  // static [35,60,40,40,35,50] (sum = 260pt) when absent.
  const widths = Array.isArray(scheduleColumnWidthsPt) && scheduleColumnWidthsPt.length === 6
    ? scheduleColumnWidthsPt
    : [35, 60, 40, 40, 35, 50];
  const colStand      = widths[0];
  const colArea       = widths[1];
  const colDiagram    = widths[2];
  const colDeedNumber = widths[3];
  const colDeedDate   = widths[4];
  const colSurveyor   = widths[5];
  const tableWidth =
    colStand + colArea + colDiagram + colDeedNumber + colDeedDate + colSurveyor;

  const rowHeight = 15;
  const headerHeight = 25;

  doc.save();

  // Title
  doc
    .fontSize(9)
    .font("Helvetica-Bold")
    .fillColor("#000000")
    .text("SCHEDULE OF AREAS", tableX, tableY, {
      width: tableWidth,
      align: "center",
    });

  // Table header - Row 1
  const headerY = tableY + 15;
  doc.lineWidth(0.5);

  // Draw outer border
  doc.rect(tableX, headerY, tableWidth, headerHeight).stroke();

  // Sub-header separator Y for DEED merged cell
  const deedHeaderY = headerY + 12;
  const deedStartX = tableX + colStand + colArea + colDiagram;

  // Draw vertical lines for columns
  // Note: the divider between DEED NUMBER and DEED DATE only starts at deedHeaderY
  // so that the DEED merged header spans both sub-columns without a line cutting through it.
  let currentX = tableX + colStand;
  doc
    .moveTo(currentX, headerY)
    .lineTo(currentX, headerY + headerHeight)
    .stroke();

  currentX += colArea;
  doc
    .moveTo(currentX, headerY)
    .lineTo(currentX, headerY + headerHeight)
    .stroke();

  currentX += colDiagram;
  doc
    .moveTo(currentX, headerY)
    .lineTo(currentX, headerY + headerHeight)
    .stroke();

  // DEED NUMBER | DATE divider — starts at sub-header row, not top of header
  currentX += colDeedNumber;
  doc
    .moveTo(currentX, deedHeaderY)
    .lineTo(currentX, headerY + headerHeight)
    .stroke();

  currentX += colDeedDate;
  doc
    .moveTo(currentX, headerY)
    .lineTo(currentX, headerY + headerHeight)
    .stroke();

  // Draw horizontal line separating DEED header from sub-headers
  doc
    .moveTo(deedStartX, deedHeaderY)
    .lineTo(deedStartX + colDeedNumber + colDeedDate, deedHeaderY)
    .stroke();

  // Header text — 6pt Bold, lineBreak:false to prevent any wrapping within columns
  doc.fontSize(6).font("Helvetica-Bold");

  // STAND No. (rowspan 2)
  doc.text("STAND", tableX + 2, headerY + 5, {
    width: colStand - 4,
    align: "center",
    lineBreak: false,
  });
  doc.text("No.", tableX + 2, headerY + 12, {
    width: colStand - 4,
    align: "center",
    lineBreak: false,
  });

  // AREAS SQUARE METRES (rowspan 2)
  doc.text("AREAS", tableX + colStand + 2, headerY + 2, {
    width: colArea - 4,
    align: "center",
    lineBreak: false,
  });
  doc.text("SQUARE", tableX + colStand + 2, headerY + 9, {
    width: colArea - 4,
    align: "center",
    lineBreak: false,
  });
  doc.text("METRES", tableX + colStand + 2, headerY + 16, {
    width: colArea - 4,
    align: "center",
    lineBreak: false,
  });

  // DIAGRAM NUMBER (rowspan 2)
  doc.text("DIAGRAM", tableX + colStand + colArea + 2, headerY + 5, {
    width: colDiagram - 4,
    align: "center",
    lineBreak: false,
  });
  doc.text("NUMBER", tableX + colStand + colArea + 2, headerY + 12, {
    width: colDiagram - 4,
    align: "center",
    lineBreak: false,
  });

  // DEED (colspan 2)
  doc.text("DEED", deedStartX + 2, headerY + 3, {
    width: colDeedNumber + colDeedDate - 4,
    align: "center",
    lineBreak: false,
  });

  // DEED sub-headers
  doc.text("NUMBER", deedStartX + 2, deedHeaderY + 2, {
    width: colDeedNumber - 4,
    align: "center",
    lineBreak: false,
  });
  doc.text("DATE", deedStartX + colDeedNumber + 2, deedHeaderY + 2, {
    width: colDeedDate - 4,
    align: "center",
    lineBreak: false,
  });

  // SURVEYOR-GENERAL (rowspan 2)
  doc.text("SURVEYOR-", tableX + tableWidth - colSurveyor + 2, headerY + 5, {
    width: colSurveyor - 4,
    align: "center",
    lineBreak: false,
  });
  doc.text("GENERAL", tableX + tableWidth - colSurveyor + 2, headerY + 12, {
    width: colSurveyor - 4,
    align: "center",
    lineBreak: false,
  });

  // Table rows
  let currentY = headerY + headerHeight;

  // Filter out Outside Figure parcels
  const surveyedParcels = parcels.features.filter((parcel) => {
    const stand = (parcel.properties.stand || "").toLowerCase();
    const designation = (parcel.properties.designation || "").toLowerCase();
    return (
      !stand.includes("outside figure") &&
      !designation.includes("outside figure")
    );
  });

  surveyedParcels.forEach((parcel, index) => {
    const stand = parcel.properties.stand || `P${index + 1}`;
    const areaM2 = parcel.properties.area_m2 || 0;
    const areaFormatted = formatAreaSquareMetres(areaM2);

    // Draw row border
    doc.rect(tableX, currentY, tableWidth, rowHeight).stroke();

    // Draw vertical lines
    currentX = tableX + colStand;
    doc
      .moveTo(currentX, currentY)
      .lineTo(currentX, currentY + rowHeight)
      .stroke();

    currentX += colArea;
    doc
      .moveTo(currentX, currentY)
      .lineTo(currentX, currentY + rowHeight)
      .stroke();

    currentX += colDiagram;
    doc
      .moveTo(currentX, currentY)
      .lineTo(currentX, currentY + rowHeight)
      .stroke();

    currentX += colDeedNumber;
    doc
      .moveTo(currentX, currentY)
      .lineTo(currentX, currentY + rowHeight)
      .stroke();

    currentX += colDeedDate;
    doc
      .moveTo(currentX, currentY)
      .lineTo(currentX, currentY + rowHeight)
      .stroke();

    // Row data — 7pt regular (≤ 6pt Bold headers)
    doc.fontSize(7).font("Helvetica");

    doc.text(stand, tableX + 2, currentY + 4, {
      width: colStand - 4,
      align: "center",
      lineBreak: false,
    });
    doc.text(areaFormatted, tableX + colStand + 2, currentY + 4, {
      width: colArea - 4,
      align: "center",
      lineBreak: false,
    });
    // Diagram Number, Deed Number, Deed Date, Surveyor-General left blank

    currentY += rowHeight;
  });

  doc.restore();
}

/**
 * Draw Schedule of Areas - Multi-column layout (for >50 stands)
 * Full SI 727 6-column format split into multiple vertical columns
 */
function drawScheduleOfAreasMultiColumn(
  doc,
  parcels,
  tableX,
  tableY,
  mapBounds
) {
  const standCount = parcels.features.length;

  // SI 727 full format column widths (smaller for multi-column)
  const colStand = 28;
  const colArea = 35;
  const colDiagram = 32;
  const colDeedNumber = 32;
  const colDeedDate = 28;
  const colSurveyor = 40;
  const columnWidth =
    colStand + colArea + colDiagram + colDeedNumber + colDeedDate + colSurveyor;
  const columnSpacing = 8;

  const rowHeight = 10; // Tighter spacing for large datasets
  const headerHeight = 22;
  const titleHeight = 12;

  // Calculate how many stands per column based on available vertical space
  const availableHeight = mapBounds.height - 100;
  const maxRowsPerColumn = Math.floor(
    (availableHeight - titleHeight - headerHeight) / rowHeight
  );

  // Calculate number of columns needed
  const numColumns = Math.ceil(standCount / maxRowsPerColumn);
  const standsPerColumn = Math.ceil(standCount / numColumns);

  doc.save();

  // Title (spans all columns)
  const totalWidth =
    columnWidth * numColumns + columnSpacing * (numColumns - 1);
  doc
    .fontSize(9)
    .font("Helvetica-Bold")
    .fillColor("#000000")
    .text("SCHEDULE OF AREAS", tableX, tableY, {
      width: totalWidth,
      align: "center",
    });

  // Draw each column
  for (let col = 0; col < numColumns; col++) {
    const colX = tableX + col * (columnWidth + columnSpacing);
    const startIndex = col * standsPerColumn;
    const endIndex = Math.min(startIndex + standsPerColumn, standCount);
    const columnParcels = parcels.features.slice(startIndex, endIndex);

    if (columnParcels.length === 0) continue;

    // Column header
    const headerY = tableY + titleHeight;
    doc.lineWidth(0.5);
    doc.rect(colX, headerY, columnWidth, headerHeight).stroke();

    // Draw vertical lines for columns
    let currentX = colX + colStand;
    doc
      .moveTo(currentX, headerY)
      .lineTo(currentX, headerY + headerHeight)
      .stroke();

    currentX += colArea;
    doc
      .moveTo(currentX, headerY)
      .lineTo(currentX, headerY + headerHeight)
      .stroke();

    currentX += colDiagram;
    doc
      .moveTo(currentX, headerY)
      .lineTo(currentX, headerY + headerHeight)
      .stroke();

    currentX += colDeedNumber;
    doc
      .moveTo(currentX, headerY)
      .lineTo(currentX, headerY + headerHeight)
      .stroke();

    currentX += colDeedDate;
    doc
      .moveTo(currentX, headerY)
      .lineTo(currentX, headerY + headerHeight)
      .stroke();

    // Draw horizontal line separating DEED header from sub-headers
    const deedHeaderY = headerY + 11;
    const deedStartX = colX + colStand + colArea + colDiagram;
    doc
      .moveTo(deedStartX, deedHeaderY)
      .lineTo(deedStartX + colDeedNumber + colDeedDate, deedHeaderY)
      .stroke();

    // Header text
    doc.fontSize(5.5).font("Helvetica-Bold");

    // STAND No.
    doc.text("STAND", colX + 1, headerY + 3, {
      width: colStand - 2,
      align: "center",
    });
    doc.text("No.", colX + 1, headerY + 9, {
      width: colStand - 2,
      align: "center",
    });

    // AREAS SQUARE METRES
    doc.text("AREAS", colX + colStand + 1, headerY + 2, {
      width: colArea - 2,
      align: "center",
    });
    doc.text("SQUARE", colX + colStand + 1, headerY + 7, {
      width: colArea - 2,
      align: "center",
    });
    doc.text("METRES", colX + colStand + 1, headerY + 12, {
      width: colArea - 2,
      align: "center",
    });

    // DIAGRAM NUMBER
    doc.text("DIAGRAM", colX + colStand + colArea + 1, headerY + 3, {
      width: colDiagram - 2,
      align: "center",
    });
    doc.text("NUMBER", colX + colStand + colArea + 1, headerY + 9, {
      width: colDiagram - 2,
      align: "center",
    });

    // DEED
    doc.text("DEED", deedStartX + 1, headerY + 2, {
      width: colDeedNumber + colDeedDate - 2,
      align: "center",
    });
    doc.text("NUMBER", deedStartX + 1, deedHeaderY + 2, {
      width: colDeedNumber - 2,
      align: "center",
    });
    doc.text("DATE", deedStartX + colDeedNumber + 1, deedHeaderY + 2, {
      width: colDeedDate - 2,
      align: "center",
    });

    // SURVEYOR-GENERAL
    doc.text("SURVEYOR-", colX + columnWidth - colSurveyor + 1, headerY + 3, {
      width: colSurveyor - 2,
      align: "center",
    });
    doc.text("GENERAL", colX + columnWidth - colSurveyor + 1, headerY + 9, {
      width: colSurveyor - 2,
      align: "center",
    });

    // Data rows
    let currentY = headerY + headerHeight;

    columnParcels.forEach((parcel, index) => {
      const stand = parcel.properties.stand || `P${startIndex + index + 1}`;
      const areaM2 = parcel.properties.area_m2 || 0;
      const areaFormatted = formatAreaSquareMetres(areaM2);

      // Draw row border
      doc.rect(colX, currentY, columnWidth, rowHeight).stroke();

      // Draw vertical lines
      currentX = colX + colStand;
      doc
        .moveTo(currentX, currentY)
        .lineTo(currentX, currentY + rowHeight)
        .stroke();

      currentX += colArea;
      doc
        .moveTo(currentX, currentY)
        .lineTo(currentX, currentY + rowHeight)
        .stroke();

      currentX += colDiagram;
      doc
        .moveTo(currentX, currentY)
        .lineTo(currentX, currentY + rowHeight)
        .stroke();

      currentX += colDeedNumber;
      doc
        .moveTo(currentX, currentY)
        .lineTo(currentX, currentY + rowHeight)
        .stroke();

      currentX += colDeedDate;
      doc
        .moveTo(currentX, currentY)
        .lineTo(currentX, currentY + rowHeight)
        .stroke();

      // Row data
      doc.fontSize(5.5).font("Helvetica");

      doc.text(stand, colX + 1, currentY + 3, {
        width: colStand - 2,
        align: "center",
        lineBreak: false,
      });
      doc.text(areaFormatted, colX + colStand + 1, currentY + 3, {
        width: colArea - 2,
        align: "center",
        lineBreak: false,
      });
      // Diagram Number, Deed Number, Deed Date, Surveyor-General left blank

      currentY += rowHeight;
    });
  }

  doc.restore();
}

/**
 * Draw Outside Figure Data table (left side of map, collision-aware)
 * Supports pagination for large datasets
 */
/**
 * Helper function to match coordinates to beacon names from beacon list
 * Single source of truth for beacon name resolution
 */
function findBeaconNameByCoordinates(y, x, beacons, tolerance = 1.0) {
  if (!beacons || !beacons.features) return null;

  for (const beacon of beacons.features) {
    if (!beacon.geometry || beacon.geometry.type !== "Point") continue;

    const beaconCoords = beacon.geometry.coordinates; // [Y, X] in Cape Lo
    const beaconY = beaconCoords[0];
    const beaconX = beaconCoords[1];

    // Calculate distance
    const dist = Math.sqrt(Math.pow(beaconY - y, 2) + Math.pow(beaconX - x, 2));

    if (dist < tolerance) {
      // Return beacon name from properties
      return beacon.properties?.name || beacon.properties?.id || null;
    }
  }

  return null;
}

function drawOutsideFigureData(
  doc,
  outsideFigureData,
  mapBounds,
  position,
  beacons = null,
  logger = console
) {
  if (
    !outsideFigureData ||
    !outsideFigureData.edges ||
    outsideFigureData.edges.length === 0
  )
    return;

  // Read dimensions from block-definitions (single source of truth shared
  // with the DXF generator). Values are in PDF points by convention.
  const OFD = BLOCKS.OUTSIDE_FIGURE_DATA;
  const rowHeight       = OFD.rowHeight;
  const headerHeight    = OFD.headerHeight;
  const headerBoxHeight = OFD.headerBoxHeight;

  // Page boundary detection
  const pageHeight = doc.page.height;
  const bottomMargin = 50 * MM_TO_PT; // 50mm bottom margin (SI 727)
  const maxY = pageHeight - bottomMargin;

  doc.save();

  // ⭐ DYNAMIC COLUMN WIDTHS - Calculate based on actual content to avoid wrapping
  doc.fontSize(9).font("Helvetica");
  let maxSidesWidth = 30; // minimum
  for (const edge of outsideFigureData.edges) {
    const sideLabel = edge.side || "";
    const measuredWidth = doc.widthOfString(sideLabel) + 8; // 8pt padding
    if (measuredWidth > maxSidesWidth) maxSidesWidth = measuredWidth;
  }

  // Column widths sourced from BLOCKS.OUTSIDE_FIGURE_DATA.columns (PDF pts).
  // col1 (SIDES) is the dynamic minimum — grows to fit longer side labels.
  const col1 = Math.max(OFD.columns[0].width, Math.ceil(maxSidesWidth));
  const col2 = OFD.columns[1].width; // Metres
  const col3 = OFD.columns[2].width; // DIRECTION
  const col4 = OFD.columns[3].width; // Constants
  const col5 = OFD.columns[4].width; // Y
  const col6 = OFD.columns[5].width; // X

  // Calculate total table width dynamically
  const tableWidth = col1 + col2 + col3 + col4 + col5 + col6;

  // Position is guaranteed in-bounds by the placement system — do NOT clamp.
  // Clamping would move the block away from its registered position, causing overlaps.
  const OFD_HEADER_HEIGHT = 40;
  const tableX = position?.x ?? mapBounds.x + 10;
  const tableY = (position?.y != null ? position.y + OFD_HEADER_HEIGHT : mapBounds.y + 100);

  // Calculate total table height
  const totalTableHeight =
    headerBoxHeight + outsideFigureData.edges.length * rowHeight;

  logger.info(
    `[PDFKit] 📊 Outside Figure Data positioned at (${tableX.toFixed(
      1
    )}, ${tableY.toFixed(1)}), size: ${tableWidth.toFixed(
      1
    )}x${totalTableHeight.toFixed(1)}pt`
  );

  // Calculate dimensions for header section
  const leftColumnsWidth = col1 + col2 + col3 + col4; // SIDES + Metres + DIRECTION + Constants
  const coordBoxWidth = col5 + col6; // Y + X columns

  // Helper function to draw table header
  const drawTableHeader = (isFirstPage = true) => {
    const titleBoxX = tableX;
    const coordBoxX = tableX + leftColumnsWidth;
    const headerBoxY = tableY - headerBoxHeight;

    if (isFirstPage) {
      // Draw unified header box border
      doc
        .lineWidth(0.5)
        .rect(titleBoxX, headerBoxY, tableWidth, headerBoxHeight)
        .stroke();

      // Draw vertical separator between title and coordinates sections
      doc
        .moveTo(coordBoxX, headerBoxY)
        .lineTo(coordBoxX, headerBoxY + headerBoxHeight)
        .stroke();

      // Title text (centered in left section - spans first 4 columns)
      doc
        .fontSize(9)
        .font("Helvetica-Bold")
        .fillColor("#000000")
        .text("OUTSIDE FIGURE DATA", titleBoxX, headerBoxY + 15, {
          width: leftColumnsWidth,
          align: "center",
        });

      // CO-ORDINATES box content (aligned with last 2 columns)
      const loSystem = resolveLoSystem(outsideFigureData);

      // Line 1: CO-ORDINATES (bold)
      doc
        .fontSize(9)
        .font("Helvetica-Bold")
        .text("CO-ORDINATES", coordBoxX, headerBoxY + 3, {
          width: coordBoxWidth,
          align: "center",
        });

      // Line 2: System : Lo 31°
      doc
        .fontSize(9)
        .font("Helvetica")
        .text(`System : ${loSystem}°`, coordBoxX, headerBoxY + 14, {
          width: coordBoxWidth,
          align: "center",
        });

      // Line 3: Y    Metres    X (with proper spacing)
      const yMetresXY = headerBoxY + 28; // Increased spacing for larger font
      doc
        .fontSize(9)
        .font("Helvetica")
        .text("Y", coordBoxX + 5, yMetresXY, { width: 20, align: "left" })
        .text("Metres", coordBoxX + 25, yMetresXY, {
          width: coordBoxWidth - 50,
          align: "center",
        })
        .text("X", coordBoxX + coordBoxWidth - 25, yMetresXY, {
          width: 20,
          align: "right",
        });
    } else {
      // Continuation page - simpler header
      doc
        .lineWidth(0.5)
        .rect(titleBoxX, headerBoxY, tableWidth, headerBoxHeight)
        .stroke();

      doc
        .moveTo(coordBoxX, headerBoxY)
        .lineTo(coordBoxX, headerBoxY + headerBoxHeight)
        .stroke();

      doc
        .fontSize(9)
        .font("Helvetica-Bold")
        .fillColor("#000000")
        .text("OUTSIDE FIGURE DATA", titleBoxX, headerBoxY + 8, {
          width: leftColumnsWidth,
          align: "center",
        })
        .fontSize(9)
        .font("Helvetica")
        .text("(Continued)", titleBoxX, headerBoxY + 26, {
          width: leftColumnsWidth,
          align: "center",
        });

      const loSystem = resolveLoSystem(outsideFigureData);

      doc
        .fontSize(9)
        .font("Helvetica-Bold")
        .text("CO-ORDINATES", coordBoxX, coordBoxY + 6, {
          width: coordBoxWidth,
          align: "center",
        })
        .font("Helvetica")
        .text(`System : ${loSystem}°`, coordBoxX, headerBoxY + 15, {
          width: coordBoxWidth,
          align: "center",
        });

      const yMetresXY = headerBoxY + 25;
      doc
        .text("Y", coordBoxX + 5, yMetresXY, { width: 20, align: "left" })
        .text("Metres", coordBoxX + 25, yMetresXY, {
          width: coordBoxWidth - 50,
          align: "center",
        })
        .text("X", coordBoxX + coordBoxWidth - 25, yMetresXY, {
          width: 20,
          align: "right",
        });
    }

    // Table column header
    doc.lineWidth(0.5).rect(tableX, tableY, tableWidth, headerHeight).stroke();

    // Header row - all center-justified
    doc
      .fontSize(9)
      .font("Helvetica-Bold")
      .text("SIDES", tableX, tableY + 4, { width: col1, align: "center" })
      .text("Metres", tableX + col1, tableY + 4, {
        width: col2,
        align: "center",
      })
      .text("DIRECTION", tableX + col1 + col2, tableY + 4, {
        width: col3,
        align: "center",
      })
      .text("Constants", tableX + col1 + col2 + col3, tableY + 4, {
        width: col4,
        align: "center",
      })
      .text("+ 0.00", tableX + col1 + col2 + col3 + col4, tableY + 4, {
        width: col5,
        align: "center",
      })
      .text("+ 0.00", tableX + col1 + col2 + col3 + col4 + col5, tableY + 4, {
        width: col6,
        align: "center",
      });

    // Vertical lines for columns
    let currentX = tableX + col1;
    doc
      .moveTo(currentX, tableY)
      .lineTo(currentX, tableY + headerHeight)
      .stroke();
    currentX += col2;
    doc
      .moveTo(currentX, tableY)
      .lineTo(currentX, tableY + headerHeight)
      .stroke();
    currentX += col3;
    doc
      .moveTo(currentX, tableY)
      .lineTo(currentX, tableY + headerHeight)
      .stroke();
    currentX += col4;
    doc
      .moveTo(currentX, tableY)
      .lineTo(currentX, tableY + headerHeight)
      .stroke();
    currentX += col5;
    doc
      .moveTo(currentX, tableY)
      .lineTo(currentX, tableY + headerHeight)
      .stroke();
  };

  // Draw initial header
  drawTableHeader(true);

  // Table rows - show ALL edges with pagination
  let currentY = tableY + headerHeight;
  const maxRows = outsideFigureData.edges.length;
  let isFirstPage = true;
  let pageCount = 1;

  for (let i = 0; i < maxRows; i++) {
    const edge = outsideFigureData.edges[i];

    // Check if we need a new page
    if (currentY + rowHeight > maxY) {
      logger.info(
        `[PDFKit] 📄 Outside Figure Data pagination: Adding page ${
          pageCount + 1
        } at row ${i + 1}/${maxRows}`
      );

      // Add new page
      doc.addPage({
        size: doc.page.size,
        margin: 0,
      });
      pageCount++;

      // Reset position for new page
      const topMargin = 50 * MM_TO_PT; // 50mm top margin (SI 727)
      tableY = topMargin + 20; // Start 20pt below top margin
      currentY = tableY + headerHeight;

      // Draw continuation header
      drawTableHeader(false);
      isFirstPage = false;
    }

    // Get edge properties (match frontend data structure)
    // ⭐ BANKER'S ROUNDING: Use pre-computed values from Area/Consistency (single source of truth)
    const sideLabel =
      edge.side ||
      `${String.fromCharCode(65 + i)}-${String.fromCharCode(
        65 + ((i + 1) % outsideFigureData.edges.length)
      )}`;
    // Distance is already banker's rounded from frontend - just format for display.
    // Accept `distance` or `metres` (shared helper) so the OFD Metres column is
    // never blank when the payload uses the alternate field name — and stays in
    // lockstep with the DXF OFD table + on-figure label.
    const distanceValue = edgeDistanceMetres(edge) ?? 0;
    const distance = distanceValue.toFixed(2); // Format only, value is already banker's rounded
    const direction = edge.direction || ""; // Frontend sends 'direction' (DMS format with banker's rounding)

    // ⭐ SINGLE SOURCE OF TRUTH: Use beacon names from frontend (already matched)
    let pointId = "";

    // Extract coordinates from edge structure
    // Cape Lo 31 convention: Y = Westing (~97K), X = Southing (~2.2M)
    // Frontend sends edge.y = Westing, edge.x = Southing (correct property names)
    // Display in table: Y column = Westing, X column = Southing
    const edgeY = edge.to?.y ?? edge.y; // Y column shows Westing values (~97K)
    const edgeX = edge.to?.x ?? edge.x; // X column shows Southing values (~2.2M)

    // Priority 1: Use edge.pointId from frontend (already matched to coordinate points)
    if (edge.pointId) {
      pointId = edge.pointId;
      logger.info(
        `[OutsideFigure] Edge ${i}: Using frontend beacon name: ${pointId}`
      );
    }
    // Priority 2: Try to match coordinates to actual beacon names
    else if (edgeY !== undefined && edgeX !== undefined && beacons) {
      logger.info(
        `[OutsideFigure] Edge ${i}: Attempting coordinate match for (${edgeY}, ${edgeX})`
      );
      const matchedName = findBeaconNameByCoordinates(
        edgeY,
        edgeX,
        beacons,
        2.0
      );
      if (matchedName) {
        pointId = matchedName;
        logger.info(
          `[OutsideFigure] ✅ Edge ${i} matched to beacon: ${matchedName}`
        );
      } else {
        logger.warn(
          `[OutsideFigure] ⚠️ Edge ${i} no match found for coords (${edgeY}, ${edgeX})`
        );
      }
    }

    // Final fallback to letter label
    if (!pointId) {
      pointId = String.fromCharCode(65 + i);
      logger.warn(
        `[OutsideFigure] ⚠️ Edge ${i} falling back to letter: ${pointId}`
      );
    }

    // Add +/- prefix to coordinates to match coordinate list format
    const y = edgeY
      ? edgeY >= 0
        ? `+${edgeY.toFixed(2)}`
        : edgeY.toFixed(2)
      : "";
    const x = edgeX
      ? edgeX >= 0
        ? `+${edgeX.toFixed(2)}`
        : edgeX.toFixed(2)
      : "";

    doc.rect(tableX, currentY, tableWidth, rowHeight).stroke();

    // Draw vertical lines
    let currentX = tableX + col1;
    doc
      .moveTo(currentX, currentY)
      .lineTo(currentX, currentY + rowHeight)
      .stroke();
    currentX += col2;
    doc
      .moveTo(currentX, currentY)
      .lineTo(currentX, currentY + rowHeight)
      .stroke();
    currentX += col3;
    doc
      .moveTo(currentX, currentY)
      .lineTo(currentX, currentY + rowHeight)
      .stroke();
    currentX += col4;
    doc
      .moveTo(currentX, currentY)
      .lineTo(currentX, currentY + rowHeight)
      .stroke();
    currentX += col5;
    doc
      .moveTo(currentX, currentY)
      .lineTo(currentX, currentY + rowHeight)
      .stroke();

    doc
      .fontSize(9)
      .font("Helvetica")
      .text(sideLabel, tableX, currentY + 4, { width: col1, align: "center" }) // SIDES: center
      .text(distance, tableX + col1, currentY + 3, {
        width: col2,
        align: "center",
      }) // Metres: center
      .text(direction, tableX + col1 + col2, currentY + 3, {
        width: col3 - 2.5 * MM_TO_PT,
        align: "right",
      }) // DIRECTION: right-aligned with 2.5mm spacing from right edge
      .text(pointId, tableX + col1 + col2 + col3, currentY + 3, {
        width: col4,
        align: "center",
      }) // Constants: center
      .text(y, tableX + col1 + col2 + col3 + col4, currentY + 3, {
        width: col5,
        align: "center",
      }) // Y: center
      .text(x, tableX + col1 + col2 + col3 + col4 + col5, currentY + 3, {
        width: col6,
        align: "center",
      }); // X: center

    currentY += rowHeight;
  }

  if (pageCount > 1) {
    logger.info(
      `[PDFKit] ✅ Outside Figure Data rendered across ${pageCount} pages (${maxRows} rows)`
    );
  }

  doc.restore();

  // Return actual bounds for collision detection with other elements
  const totalHeight = headerHeight + maxRows * rowHeight;
  return {
    x: tableX,
    y: tableY - 12, // Include title
    width: tableWidth,
    height: totalHeight + 12, // Include title space
  };
}

/**
 * Draw Beacon Description (grouped text format - SI 727 compliant)
 * Format: "M5, M6, M7, M8, M9      : Not beaconed"
 * Uses shared block definitions for consistency with UI
 * @param {Object} position - Centrally calculated collision-free position
 */
function drawBeaconDescription(doc, beacons, mapBounds, position) {
  if (!beacons || beacons.features.length === 0) return;

  const config = BLOCKS.BEACON_DESCRIPTION;
  const format = config.groupFormat;

  // Use centrally calculated position if provided, otherwise fallback.
  // position is the TOP-LEFT corner of the full bounding box (title included).
  const tableX = position?.x || mapBounds.x + 10;
  const boxY   = position?.y || mapBounds.y + mapBounds.height - 100;

  doc.save();

  // Title — rendered INSIDE the bounding box at the top
  doc
    .fontSize(config.titleFont.size)
    .font(config.titleFont.family)
    .fillColor("#000000")
    .text(config.title, tableX, boxY);

  // Content starts below the title (12pt title height + small gap)
  const tableY = boxY + 14;

  // Classify + group beacons via the shared helper (single source of truth so
  // the DXF and UI render identical groupings).
  const beaconGroups = classifyBeaconGroups(beacons);

  // Draw grouped text with proper spacing
  let currentY = tableY;

  beaconGroups.forEach(({ description, points }) => {
    const pointsText = points;

    // Measure text width to determine spacing
    doc
      .fontSize(format.beaconNamesFont.size)
      .font(format.beaconNamesFont.family);

    const textWidth = doc.widthOfString(pointsText);
    const colonX = tableX + textWidth + format.nameDescriptionSpacing;

    // Beacon names
    doc.text(pointsText, tableX + format.indent, currentY, {
      continued: false,
    });

    // Separator (colon) with spacing
    doc.text(format.separator, colonX, currentY, { continued: false });

    // Description
    doc
      .fontSize(format.descriptionFont.size)
      .font(format.descriptionFont.family)
      .text(description, colonX + format.colonDescriptionSpacing + 5, currentY);

    currentY += format.lineHeight;
  });

  doc.restore();
}

/**
 * Draw Survey Statement block using centrally calculated position
 * Format: "Surveyed in [Month] [Year] by me"
 * @param {Object} position - Centrally calculated collision-free position
 */
function drawSurveyStatement(doc, metadata, mapBounds, position) {
  // Survey Statement configuration (inline since BLOCKS constant doesn't exist here)
  const blockWidth = 300;
  const blockHeight = 100; // Approximate height including all text
  const alignment = "center";

  // Use centrally calculated collision-free position — trust it, do NOT clamp/override
  // Clamping would push the block back into other blocks that were already placed.
  const blockX = position?.x ?? mapBounds.x + mapBounds.width / 2 - blockWidth / 2;
  const blockY = position?.y ?? mapBounds.y + mapBounds.height - blockHeight - 5;

  doc.save();

  // Format survey statement with date from persistent project info
  let statementText = "Surveyed in [Month] [Year] by me";

  // Try to get survey date from metadata (passed from frontend projectInfo)
  const surveyDate = metadata.surveyDate || metadata.date;

  if (surveyDate) {
    try {
      const date = new Date(surveyDate);
      const month = date.toLocaleString("en-US", { month: "long" });
      const year = date.getFullYear();
      statementText = `Surveyed in ${month} ${year} by me`;
    } catch (error) {
      console.error("[PDFKit] Error formatting survey date:", error);
    }
  }

  // Statement text
  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#000000")
    .text(statementText, blockX, blockY, {
      width: blockWidth,
      align: alignment,
    });

  // Add signature space (30pt gap for manual signature)
  const signatureSpace = 30;
  const lineHeight = 14;
  const surveyorY = blockY + lineHeight + 5 + signatureSpace;

  // Surveyor name
  doc
    .fontSize(10)
    .font("Helvetica-Bold")
    .text(metadata.surveyor || "Land Surveyor", blockX, surveyorY, {
      width: blockWidth,
      align: alignment,
      continued: false,
    });

  // Surveyor title on next line
  const titleY = surveyorY + lineHeight;
  doc
    .fontSize(9)
    .font("Helvetica")
    .text("(Land Surveyor, Zim)", blockX, titleY, {
      width: blockWidth,
      align: alignment,
    });

  // License number (if available)
  if (metadata.licenseNumber) {
    const licenseY = titleY + lineHeight;
    doc
      .fontSize(9)
      .font("Helvetica")
      .text(`Lic. No: ${metadata.licenseNumber}`, blockX, licenseY, {
        width: blockWidth,
        align: alignment,
      });
  }

  doc.restore();
}

/**
 * Draw Surveyor-General's Signature block
 * Format: "Approved" title, signature line, "For Surveyor General", date field
 * @param {Object} position - Centrally calculated collision-free position
 */
function drawSurveyorGeneralSignature(doc, mapBounds, position) {
  // Dimensions sourced from BLOCKS.SURVEYOR_GENERAL_BOX (PDF pts).
  const SG = BLOCKS.SURVEYOR_GENERAL_BOX;
  const blockWidth  = SG.width;
  const blockHeight = SG.height;

  // Trust the collision-free position from calculateBlockPositions — do NOT clamp/override
  const blockX = position?.x ?? mapBounds.x + mapBounds.width - blockWidth - 5;
  const blockY = position?.y ?? mapBounds.y + mapBounds.height - blockHeight - 5;

  doc.save();

  // Draw border
  doc.rect(blockX, blockY, blockWidth, blockHeight).stroke();

  // "Approved" title
  const titleY = blockY + SG.titleYOffset;
  doc
    .fontSize(SG.titleFontSize)
    .font(SG.titleFont)
    .fillColor("#000000")
    .text("Approved", blockX, titleY, {
      width: blockWidth,
      align: "center",
    });

  // Signature line (dashed)
  const signatureY = blockY + SG.signatureLineYOffset;
  const lineMargin = SG.signatureLineInset;
  doc.save();
  doc.dash(SG.signatureLineDash.dash, { space: SG.signatureLineDash.space });
  doc
    .moveTo(blockX + lineMargin, signatureY)
    .lineTo(blockX + blockWidth - lineMargin, signatureY)
    .stroke();
  doc.undash();
  doc.restore();

  // "For Surveyor General" text
  const forTextY = blockY + SG.forSGYOffset;
  doc
    .fontSize(SG.bodyFontSize)
    .font(SG.bodyFont)
    .text("For Surveyor General", blockX, forTextY, {
      width: blockWidth,
      align: "center",
    });

  // "Date ......" field
  const dateY = blockY + SG.dateYOffset;
  doc
    .fontSize(SG.bodyFontSize)
    .font(SG.bodyFont)
    .text(SG.dateText, blockX + SG.dateXOffset, dateY, {
      width: blockWidth - SG.dateXOffset * 2,
      align: "left",
    });

  doc.restore();
}

/**
 * Draw Endorsement block (right margin, outside map area)
 */
function drawEndorsementBlock(doc, position) {
  // Position comes from planSheetLayout's endorsement slot (right-margin,
  // 150mm × 150mm). Previously computed inline; now consumed from the planner.
  const blockX = position.x;
  const blockY = position.y;
  const blockWidth = position.width;
  const blockHeight = position.height;

  doc.save();

  // Top border line (same width as map boundary)
  doc
    .lineWidth(1.5)
    .moveTo(blockX, blockY)
    .lineTo(blockX + blockWidth, blockY)
    .stroke();

  // Title
  doc
    .fontSize(10)
    .font("Helvetica-Bold")
    .fillColor("#000000")
    .text("ENDORSEMENTS", blockX + 5, blockY + 5, {
      width: blockWidth - 10,
      align: "center",
    });

  // Table header with proper column widths
  const headerY = blockY + 25;
  const colWidths = {
    no: 30, // Narrow column for "No."
    statement: blockWidth * 0.5, // Wide column for "STATEMENT"
    date: blockWidth * 0.2, // Medium column for "Date"
    sg: blockWidth * 0.3 - 30, // Medium column for "Surveyor-General"
  };

  // Horizontal line above header row (same width as map boundary)
  doc
    .lineWidth(1.5)
    .moveTo(blockX, headerY - 2)
    .lineTo(blockX + blockWidth, headerY - 2)
    .stroke();

  // Draw header row with vertical separators
  const headerRowHeight = 20; // Increased from 12pt to 20pt
  doc.fontSize(7).font("Helvetica-Bold");

  // Calculate vertical centering for header text
  const headerTextY = headerY + (headerRowHeight - 7) / 2;

  // Column 1: No.
  doc.text("No.", blockX + 2, headerTextY, {
    width: colWidths.no - 4,
    align: "center",
  });

  // Vertical line after No.
  doc
    .moveTo(blockX + colWidths.no, headerY - 2)
    .lineTo(blockX + colWidths.no, headerY + headerRowHeight)
    .stroke();

  // Column 2: STATEMENT
  doc.text("STATEMENT", blockX + colWidths.no + 5, headerTextY, {
    width: colWidths.statement - 10,
    align: "left",
  });

  // Vertical line after STATEMENT
  const col3X = blockX + colWidths.no + colWidths.statement;
  doc
    .moveTo(col3X, headerY - 2)
    .lineTo(col3X, headerY + headerRowHeight)
    .stroke();

  // Column 3: Date
  doc.text("Date", col3X + 5, headerTextY, {
    width: colWidths.date - 10,
    align: "center",
  });

  // Vertical line after Date
  const col4X = col3X + colWidths.date;
  doc
    .moveTo(col4X, headerY - 2)
    .lineTo(col4X, headerY + headerRowHeight)
    .stroke();

  // Column 4: Surveyor-General
  doc.text("Surveyor-General", col4X + 5, headerTextY, {
    width: colWidths.sg - 10,
    align: "center",
  });

  // Horizontal separator line below header (same width as map boundary)
  doc
    .lineWidth(1.5)
    .moveTo(blockX, headerY + headerRowHeight)
    .lineTo(blockX + blockWidth, headerY + headerRowHeight)
    .stroke();

  // Entry row with 100mm height at print scale
  const rowHeight = 100 * 2.835; // 100mm = 283.5pt
  const entryY = headerY + headerRowHeight; // Start right after header separator

  doc
    .fontSize(8) // Increased from 6pt to 8pt for field readability
    .font("Helvetica");

  // Position text at top of row with 5pt spacing from top
  const textY = entryY + 5;

  // Entry number in first column (at top)
  doc.text("1.", blockX + 2, textY, {
    width: colWidths.no - 4,
    align: "center",
  });

  // Entry text in second column (at top)
  doc.text(
    "Dispensation Certificate No. .................. relates to this General Plan",
    blockX + colWidths.no + 5,
    textY,
    {
      width: colWidths.statement - 10,
    }
  );

  // Bottom of entry row
  const entryBottomY = entryY + rowHeight;

  // Vertical line after No. column
  doc
    .moveTo(blockX + colWidths.no, headerY + headerRowHeight)
    .lineTo(blockX + colWidths.no, entryBottomY)
    .stroke();

  // Vertical line after STATEMENT column
  doc
    .moveTo(col3X, headerY + headerRowHeight)
    .lineTo(col3X, entryBottomY)
    .stroke();

  // Vertical line after Date column
  doc
    .moveTo(col4X, headerY + headerRowHeight)
    .lineTo(col4X, entryBottomY)
    .stroke();

  doc.restore();
}

/**
 * Draw North Arrow using centrally calculated position
 * @param {Object} position - Centrally calculated collision-free position
 */
function drawNorthArrow(doc, bounds, position) {
  // North Arrow bounding box (must match engine: northArrowWidth=70, northArrowHeight=85)
  const boxW = 70;
  const boxH = 85;

  // Trust the collision-free position from the placement engine — do NOT clamp/override.
  // position is the TOP-LEFT corner of the bounding box.
  const boxX = position?.x ?? (bounds.x + bounds.width - boxW - 14);
  const boxY = position?.y ?? (bounds.y + 14);

  doc.save();

  // Compass rose centre is at the horizontal middle of the box,
  // vertically offset so the full rose + "TN" label fits within boxH.
  // Rose extends mainLength(35) above and below centre; "TN" adds ~15pt below south tip.
  // Total: 35 + 35 + 15 = 85 → centre at boxY + 35.
  const centerX = boxX + boxW / 2;
  const centerY = boxY + 35;
  const mainLength = 35; // Length of main N-S axis
  const sideLength = 25; // Length of E-W and diagonal points
  const innerRadius = 8; // Inner circle radius

  doc.lineWidth(0.75);
  doc.strokeColor("#000000");
  doc.fillColor("#000000");

  // Draw 8 triangular points of the compass rose
  const points = [
    { angle: 0, length: mainLength, filled: true }, // North (main, filled)
    { angle: 45, length: sideLength, filled: false }, // NE
    { angle: 90, length: sideLength, filled: false }, // East
    { angle: 135, length: sideLength, filled: false }, // SE
    { angle: 180, length: mainLength, filled: true }, // South (main, filled)
    { angle: 225, length: sideLength, filled: false }, // SW
    { angle: 270, length: sideLength, filled: false }, // West
    { angle: 315, length: sideLength, filled: false }, // NW
  ];

  points.forEach((point) => {
    const angleRad = ((point.angle - 90) * Math.PI) / 180; // -90 to make 0° point north
    const outerX = centerX + Math.cos(angleRad) * point.length;
    const outerY = centerY + Math.sin(angleRad) * point.length;

    // Calculate perpendicular points for triangle base
    const perpAngle = angleRad + Math.PI / 2;
    const baseWidth = point.angle === 0 || point.angle === 180 ? 3 : 2.5;
    const leftX = centerX + Math.cos(perpAngle) * baseWidth;
    const leftY = centerY + Math.sin(perpAngle) * baseWidth;
    const rightX = centerX - Math.cos(perpAngle) * baseWidth;
    const rightY = centerY - Math.sin(perpAngle) * baseWidth;

    // Draw triangle
    doc
      .moveTo(outerX, outerY)
      .lineTo(leftX, leftY)
      .lineTo(rightX, rightY)
      .closePath();

    if (point.filled) {
      doc.fillAndStroke("#000000", "#000000");
    } else {
      doc.stroke();
    }
  });

  // Draw center circle
  doc.circle(centerX, centerY, innerRadius).fillAndStroke("#FFFFFF", "#000000");

  // Draw double lines for main N-S axis
  const lineOffset = 1.5;
  // North line (double)
  doc
    .moveTo(centerX - lineOffset, centerY - innerRadius)
    .lineTo(centerX - lineOffset, centerY - mainLength)
    .stroke();
  doc
    .moveTo(centerX + lineOffset, centerY - innerRadius)
    .lineTo(centerX + lineOffset, centerY - mainLength)
    .stroke();

  // South line (double)
  doc
    .moveTo(centerX - lineOffset, centerY + innerRadius)
    .lineTo(centerX - lineOffset, centerY + mainLength)
    .stroke();
  doc
    .moveTo(centerX + lineOffset, centerY + innerRadius)
    .lineTo(centerX + lineOffset, centerY + mainLength)
    .stroke();

  // Draw "TN" label below the south point
  doc
    .fontSize(10)
    .fillColor("#000000")
    .font("Helvetica-Bold")
    .text("T", centerX - 10, centerY + mainLength + 5)
    .text("N", centerX + 2, centerY + mainLength + 5);

  doc.restore();
}

/**
 * Check whether the outside figure fits within the 90% margin constraint.
 * The mapped figure (at the given scale) must be centred within ≤90% of the
 * drawing area so that no part or label extrudes into the margin zones.
 *
 * @param {number} extentWidth  - Ground width of the outside figure in metres
 * @param {number} extentHeight - Ground height of the outside figure in metres
 * @param {object} figureBounds - PDF drawing area in points { width, height }
 * @param {number} scaleDenom   - Scale denominator (e.g. 2000 for 1:2000)
 * @returns {{ fits: boolean, mappedWmm: number, mappedHmm: number, maxWmm: number, maxHmm: number }}
 */
function checkMarginConstraint(extentWidth, extentHeight, figureBounds, scaleDenom) {
  const MARGIN_FACTOR = 0.75; // outside figure must occupy ≤75% of drawing area, leaving 25% for blocks
  const drawingWmm = figureBounds.width / MM_TO_PT;
  const drawingHmm = figureBounds.height / MM_TO_PT;
  const maxWmm = drawingWmm * MARGIN_FACTOR;
  const maxHmm = drawingHmm * MARGIN_FACTOR;
  // Convert ground metres → paper millimetres at this scale
  const mappedWmm = (extentWidth / scaleDenom) * 1000;
  const mappedHmm = (extentHeight / scaleDenom) * 1000;
  return {
    fits: mappedWmm <= maxWmm && mappedHmm <= maxHmm,
    mappedWmm,
    mappedHmm,
    maxWmm,
    maxHmm,
  };
}

/**
 * Calculate optimal scale based on extent and available map area
 * SI 727 Section 32(2): Prescribed scales
 * Honours requestedScale from intelligentPreview when provided.
 * Applies a 90% margin constraint: the outside figure must fit within 90% of
 * the drawing area so that no part or label extrudes into the margin zones.
 * If the initial scale violates this constraint, the next larger scale
 * denominator is tried until the constraint is satisfied.
 */
/**
 * SI 727 Reg 32(3) maximum denominator per plan type.
 * Both township general plan types must not be plotted at a scale smaller than 1:500.
 * Extents too large to fit at 1:500 trigger multi-sheet tiling (needsTiling=true).
 */
// SI 727 Reg 32(3) scale rules by plan type:
//  • DEVELOPED-township general plan — mandated at EXACTLY 1:500 (no edge
//    distances/directions are shown). Capped here (≤500) and floored in the
//    enlarge step, so it resolves to exactly 1:500 (tiling if the figure is too
//    big to fit at 1:500).
//  • UNDEVELOPED-township general plan — NO fixed scale. It may take any
//    suitable scale that keeps stand numbers, beacon labels and edge
//    distances/directions legible (no overcrowding/overlap) at the print scale,
//    so it is intentionally NOT listed here (uncapped — enlarge to the best fit,
//    with label-crowding detection stepping finer when needed). This matches the
//    frontend, which only applies the ceiling for 'general-developed'.
const SI727_MAX_DENOMINATOR_BY_PLAN = {
  'general-developed':   500,
};

function calculateOptimalScale(extent, mapBounds, logger, requestedScale, forceMinDenominator = 0, planType = null) {
  const extentWidth = extent.maxY - extent.minY;   // metres (Y = Westing)
  const extentHeight = extent.maxX - extent.minX;  // metres (X = Southing)

  // --- Resolve initial candidate scale ---
  let candidateIndex = -1; // index into SI727_PRESCRIBED_SCALES

  if (requestedScale) {
    const match = String(requestedScale).match(/1\s*:\s*(\d+)/);
    if (match) {
      const denominator = parseInt(match[1], 10);
      candidateIndex = SI727_PRESCRIBED_SCALES.findIndex(s => s.value === denominator);
      if (candidateIndex === -1) {
        // Not in prescribed list — use as-is (no constraint stepping possible)
        logger.warn(`[PDFKit] ⚠️ Scale ${requestedScale} not in SI 727 prescribed list, using as-is`);
        const synth = { value: denominator, label: `1:${denominator}`, category: 'custom' };
        const check = checkMarginConstraint(extentWidth, extentHeight, mapBounds, denominator);
        if (!check.fits) {
          logger.warn(`[PDFKit] ⚠️ Custom scale ${requestedScale} violates 90% margin constraint (${check.mappedWmm.toFixed(1)}mm × ${check.mappedHmm.toFixed(1)}mm > ${check.maxWmm.toFixed(1)}mm × ${check.maxHmm.toFixed(1)}mm) but no prescribed alternative available`);
        }
        return synth;
      }
    }
  }

  if (candidateIndex === -1) {
    // Auto-calculate: find smallest SI 727 scale where the extent fits the drawing area
    const mapWidthMM = mapBounds.width / MM_TO_PT;
    const mapHeightMM = mapBounds.height / MM_TO_PT;
    const scaleForWidth = (extentWidth * 1000) / mapWidthMM;
    const scaleForHeight = (extentHeight * 1000) / mapHeightMM;
    const minRequiredScale = Math.max(scaleForWidth, scaleForHeight);

    candidateIndex = SI727_PRESCRIBED_SCALES.findIndex(s => s.value >= minRequiredScale);
    if (candidateIndex === -1) {
      candidateIndex = SI727_PRESCRIBED_SCALES.length - 1; // largest available
    }
  }

  // --- ENLARGE the figure to dominate the sheet (SI 727 General Plan) ---
  // The requested scale (from intelligentPreview) is often conservative, leaving
  // the figure small on a large sheet. Step DOWN to the smallest denominator
  // (largest figure) that still fits the drawing area, so the figure is the hero.
  // The 90% margin loop below + forceMinDenominator (block-placement retry)
  // reclaim room if the enlarged figure crowds the schedule/blocks. Skipped
  // during a block-placement retry (forceMinDenominator > 0) so we don't undo a
  // scale-up that was needed to fit the blocks.
  if (forceMinDenominator <= 0) {
    const _mapWmm = mapBounds.width / MM_TO_PT;
    const _mapHmm = mapBounds.height / MM_TO_PT;
    const _minFit = Math.max(
      (extentWidth * 1000) / _mapWmm,
      (extentHeight * 1000) / _mapHmm,
    );
    let _autoMaxIdx = SI727_PRESCRIBED_SCALES.findIndex(s => s.value >= _minFit);
    // SI 727 Reg 32(3): a DEVELOPED-township general plan is mandated at exactly
    // 1:500 → never enlarge it finer than 1:500 (the applyPlanTypeCeiling() cap
    // below prevents coarser, so it lands exactly on 1:500; if the figure is too
    // big to fit at 1:500 the cap flags needsTiling). An UNDEVELOPED-township
    // plan MAY use larger (finer) scales to accommodate the edge distances +
    // directions it must show, so it is NOT floored here — the ceiling still
    // caps it no coarser than 1:500.
    const _exactMandateDenom = planType === 'general-developed' ? 500 : 0;
    if (_exactMandateDenom > 0) {
      const _floorIdx = SI727_PRESCRIBED_SCALES.findIndex(s => s.value >= _exactMandateDenom);
      if (_floorIdx !== -1) _autoMaxIdx = Math.max(_autoMaxIdx, _floorIdx);
    }
    if (_autoMaxIdx !== -1 && _autoMaxIdx < candidateIndex) {
      logger.info(
        `[PDFKit] 📏 Enlarging figure: ${SI727_PRESCRIBED_SCALES[candidateIndex].label} → ` +
        `${SI727_PRESCRIBED_SCALES[_autoMaxIdx].label} (largest SI 727 scale that fills the drawing area` +
        `${_exactMandateDenom ? `, floored at the 1:${_exactMandateDenom} developed-township mandate` : ''})`,
      );
      candidateIndex = _autoMaxIdx;
    }
  }

  // --- Apply forceMinDenominator (block-placement scale-up) ---
  // If a previous placement attempt failed, caller passes the current denominator
  // so we start searching from the NEXT prescribed scale above it.
  if (forceMinDenominator > 0) {
    const forceIdx = SI727_PRESCRIBED_SCALES.findIndex(s => s.value > forceMinDenominator);
    if (forceIdx !== -1) {
      // Always step up to at least forceIdx — blocks were unplaceable at forceMinDenominator.
      // The > candidateIndex guard was removed because candidateIndex may already equal
      // forceIdx when the extent-fit logic picks the same scale, preventing the step-up.
      candidateIndex = Math.max(candidateIndex, forceIdx);
      logger.info(`[PDFKit] 📏 Block placement failed at denominator ${forceMinDenominator} — stepping to index ${candidateIndex} (${SI727_PRESCRIBED_SCALES[candidateIndex]?.label})`);
    }
  }

  // --- Apply 90% margin constraint ---
  // Step up through prescribed scales until the outside figure fits within 90%
  // of the drawing area, ensuring no part or label extrudes into the margins.
  let finalIndex = candidateIndex;
  while (finalIndex < SI727_PRESCRIBED_SCALES.length) {
    const candidate = SI727_PRESCRIBED_SCALES[finalIndex];
    const check = checkMarginConstraint(extentWidth, extentHeight, mapBounds, candidate.value);
    if (check.fits) {
      if (finalIndex > candidateIndex) {
        logger.info({
          msg: "[PDFKit] 📏 Scale stepped up to satisfy 90% margin constraint",
          from: SI727_PRESCRIBED_SCALES[candidateIndex].label,
          to: candidate.label,
          mappedSize: `${check.mappedWmm.toFixed(1)}mm × ${check.mappedHmm.toFixed(1)}mm`,
          maxAllowed: `${check.maxWmm.toFixed(1)}mm × ${check.maxHmm.toFixed(1)}mm`,
        });
      } else {
        logger.info({
          msg: "[PDFKit] 📏 Scale satisfies 90% margin constraint",
          scale: candidate.label,
          source: requestedScale ? "intelligentPreview" : "auto-calculated",
          mappedSize: `${check.mappedWmm.toFixed(1)}mm × ${check.mappedHmm.toFixed(1)}mm`,
          maxAllowed: `${check.maxWmm.toFixed(1)}mm × ${check.maxHmm.toFixed(1)}mm`,
        });
      }
      // Always apply the plan-type ceiling AFTER resolving the margin-fitting scale.
      // Previously only the exhausted-scales fallback called applyPlanTypeCeiling,
      // meaning large townships that resolved to e.g. 1:2000 bypassed the 1:500 ceiling entirely.
      return applyPlanTypeCeiling(candidate, extent, mapBounds, planType, logger);
    }
    logger.info(`[PDFKit] 📏 Scale ${candidate.label} violates 90% margin (${check.mappedWmm.toFixed(1)}mm × ${check.mappedHmm.toFixed(1)}mm > ${check.maxWmm.toFixed(1)}mm × ${check.maxHmm.toFixed(1)}mm), stepping up`);
    finalIndex++;
  }

  // Exhausted all scales — use largest and warn
  const largest = SI727_PRESCRIBED_SCALES[SI727_PRESCRIBED_SCALES.length - 1];
  logger.warn(`[PDFKit] ⚠️ No SI 727 scale satisfies 90% margin constraint; using ${largest.label}`);
  return applyPlanTypeCeiling(largest, extent, mapBounds, planType, logger);
}

/**
 * Clamp a resolved scale to the SI 727 Reg 32(3) maximum denominator for the
 * given plan type. If the outside figure doesn't fit at the capped denominator,
 * sets needsTiling=true on the returned scale object so the caller can
 * trigger multi-sheet tile generation.
 */
function applyPlanTypeCeiling(scale, extent, mapBounds, planType, logger) {
  const maxDenom = planType ? (SI727_MAX_DENOMINATOR_BY_PLAN[planType] ?? Infinity) : Infinity;
  if (maxDenom === Infinity || scale.value <= maxDenom) return scale;

  // Find the largest prescribed scale that is ≤ maxDenom
  const capped = [...SI727_PRESCRIBED_SCALES].reverse().find(s => s.value <= maxDenom);
  if (!capped) return scale; // shouldn't happen

  const extentWidth  = extent.maxY - extent.minY;
  const extentHeight = extent.maxX - extent.minX;
  const mapWidthMM   = mapBounds.width  / MM_TO_PT;
  const mapHeightMM  = mapBounds.height / MM_TO_PT;
  const mappedWmm = (extentWidth  / capped.value) * 1000;
  const mappedHmm = (extentHeight / capped.value) * 1000;
  const needsTiling = mappedWmm > mapWidthMM || mappedHmm > mapHeightMM;

  logger.warn(
    `[PDFKit] 🔒 SI 727 Reg 32(3) ceiling for '${planType}': capping scale from ` +
    `${scale.label} → ${capped.label} (max denominator = ${maxDenom})` +
    (needsTiling ? ` — MULTI-SHEET TILING REQUIRED (${mappedWmm.toFixed(0)}mm × ${mappedHmm.toFixed(0)}mm > plot window)` : '')
  );

  return { ...capped, needsTiling };
}

/**
 * Select appropriate page size based on survey extent
 * SI 727 Section 62(1) original sizes: 500×400mm, 800×500mm, 1000×800mm
 * Current Surveyor-General approved practice: ISO A-series landscape
 *   ISO A2: 594×420mm | ISO A1: 841×594mm | ISO A0: 1189×841mm
 * Uses next larger size for better label spacing and cleaner presentation
 */
function selectPageSize(extent, logger, requestedSheetSize, requestedScale) {
  // If a specific sheet size was requested (from intelligentPreview), use it directly
  if (requestedSheetSize) {
    const sheet = SI727_SHEET_SIZES.find(s => s.name === requestedSheetSize);
    if (sheet) {
      const pageSize = {
        size: [sheet.width * MM_TO_PT, sheet.height * MM_TO_PT],
        name: `${sheet.width}mm × ${sheet.height}mm (${sheet.code})`,
        code: sheet.code,
      };
      logger.info({
        msg: "[PDFKit] 📄 Page size from intelligentPreview",
        requested: requestedSheetSize,
        scale: requestedScale,
        size: pageSize.name,
      });
      return pageSize;
    }
    logger.warn(`[PDFKit] ⚠️ Requested sheet size '${requestedSheetSize}' not found, falling back to auto-select`);
  }

  const width = extent.maxY - extent.minY;
  const height = extent.maxX - extent.minX;

  let selectedIndex = -1;

  // Try each page size and check if extent fits with margins
  for (let i = 0; i < SI727_SHEET_SIZES.length; i++) {
    const sheet = SI727_SHEET_SIZES[i];
    const availableWidth =
      sheet.width - SI727_MARGINS.left - SI727_MARGINS.right;
    const availableHeight =
      sheet.height - SI727_MARGINS.top - SI727_MARGINS.bottom;

    // Calculate if extent fits at a reasonable scale (1:1000 to 1:5000)
    const scaleForWidth = (width * 1000) / availableWidth;
    const scaleForHeight = (height * 1000) / availableHeight;
    const requiredScale = Math.max(scaleForWidth, scaleForHeight);

    if (requiredScale <= 5000) {
      selectedIndex = i;
      break;
    }
  }

  // If no suitable size found, use largest
  if (selectedIndex < 0) {
    selectedIndex = SI727_SHEET_SIZES.length - 1;
  }

  const sheet = SI727_SHEET_SIZES[selectedIndex];
  const pageSize = {
    size: [sheet.width * MM_TO_PT, sheet.height * MM_TO_PT],
    name: `${sheet.width}mm × ${sheet.height}mm (${sheet.code})`,
    code: sheet.code,
  };

  logger.info({
    msg: "[PDFKit] 📄 Page size auto-selected",
    size: pageSize.name,
  });

  return pageSize;
}

/**
 * Collision detection for labels
 */
class LabelCollisionDetector {
  constructor() {
    this.occupiedRegions = [];
  }

  /**
   * Check if a region collides with existing labels
   */
  hasCollision(x, y, width, height, padding = 2) {
    const spacing = padding;
    const region = {
      x: x - spacing,
      y: y - spacing,
      width: width + spacing * 2,
      height: height + spacing * 2,
    };

    return this.occupiedRegions.some((occupied) =>
      this.regionsOverlap(region, occupied)
    );
  }

  /**
   * Register a label region as occupied
   */
  addRegion(x, y, width, height, padding = 2) {
    const spacing = padding;
    this.occupiedRegions.push({
      x: x - spacing,
      y: y - spacing,
      width: width + spacing * 2,
      height: height + spacing * 2,
    });
  }

  /**
   * Check if two regions overlap
   */
  regionsOverlap(r1, r2) {
    return boxesIntersect(r1, r2, 0);
  }

  /**
   * Find optimal label position with collision avoidance
   * Tries multiple positions around the point
   */
  findOptimalPosition(baseX, baseY, labelWidth, labelHeight, mapBounds) {
    // Try positions in order of preference: right, top-right, bottom-right, left, top-left, bottom-left, top, bottom
    const offsets = [
      { x: 5, y: -3, name: "right" }, // Right (default)
      { x: 5, y: -labelHeight - 3, name: "top-right" },
      { x: 5, y: 5, name: "bottom-right" },
      { x: -labelWidth - 5, y: -3, name: "left" },
      { x: -labelWidth - 5, y: -labelHeight - 3, name: "top-left" },
      { x: -labelWidth - 5, y: 5, name: "bottom-left" },
      { x: -labelWidth / 2, y: -labelHeight - 5, name: "top" },
      { x: -labelWidth / 2, y: 5, name: "bottom" },
    ];

    for (const offset of offsets) {
      const x = baseX + offset.x;
      const y = baseY + offset.y;

      // Check if within map bounds
      if (
        !isRectWithinBounds(
          { x, y, width: labelWidth, height: labelHeight },
          mapBounds,
          0
        )
      ) {
        continue;
      }

      // Check for collisions
      if (!this.hasCollision(x, y, labelWidth, labelHeight)) {
        return { x, y, position: offset.name };
      }
    }

    // If all positions collide, return null to skip rather than force-place
    return null;
  }
}

/**
 * Main GeoPDF generation function
 * MODIFIED: 2025-12-30 20:00 - File loading confirmed, investigating parcel rendering
 */
export async function generateGeoPDF(options, logger) {
  try {
    return await _generateGeoPDFInner(options, logger);
  } catch (topErr) {
    console.error(`TOP-LEVEL-ERROR: ${topErr?.message}\nSTACK: ${topErr?.stack?.slice(0, 1000)}`);
    throw topErr;
  }
}

async function _generateGeoPDFInner(options, logger) {
  const {
    parcels,
    beacons,
    annotations,
    outsideFigure, // Normalized Outside Figure boundary GeoJSON
    projection,
    extent,
    metadata,
    outputPath,
    outsideFigureData, // Full Outside Figure data with edges, constants, etc.
    beaconLabels, // UI's beacon-to-parcel mapping for consistent labeling
    scale,        // e.g. '1:2000' from intelligentPreview
    sheetSize,    // e.g. 'ISO_A2' from intelligentPreview
    planType = null, // SI 727 plan type: 'general-developed' | 'general-undeveloped' | etc.
    tileExtent = null, // When set, override extent recalculation with this tile window {minY,maxY,minX,maxX}
    tileLabel = null,  // e.g. "Sheet 2 of 6" — added to title block when tiling
    sheetInfo = null,  // SI 727 Seventh Schedule (b): { sheetNumber, totalSheets }
    _forceMinDenominator = 0, // Internal: force scale above this denominator (scale step-up retry)
    _scaleUpAttempt = 0,      // Internal: how many scale step-ups have been attempted
    _sheetSizeUpAttempt = 0,  // Internal: how many paper-size escalations have been attempted
    _labelEscalationAttempt = 0, // Internal: how many label-crowding escalations attempted
    // NEW: True GeoPDF options
    trueGeoPDF = false, // Enable true Vector GeoPDF capabilities
    interactive = false, // Enable interactive features
    enableLayers = false, // Enable layer management
    enableMeasurements = false, // Enable measurement tools
  } = options;

  // Resolve the OUTSIDE FIGURE DATA "System : Lo NN°" label once, from the
  // project's central meridian (metadata.centralMeridian) / projection, and
  // stash it on outsideFigureData.constants.loSystem. Shared resolveLoSystem()
  // is the single source of truth with the DXF — a Lo 29 project must read
  // Lo 29, not the bare default.
  if (outsideFigureData && !outsideFigureData.constants?.loSystem) {
    outsideFigureData.constants = {
      ...(outsideFigureData.constants || {}),
      loSystem: resolveLoSystem(outsideFigureData, metadata, projection),
    };
  }

  // 3-v7: structured warnings collection, mirroring DXF's warnings.summary shape.
  const warnings = {};

  logger.info("[PDFKit] 🎨 Starting GeoPDF generation...");
  logger.info("[PDFKit] 🔍 LabelingSystem import check:", {
    hasLabelingSystem: typeof LabelingSystem !== "undefined",
  });
  logger.info({
    msg: "[PDFKit] 📊 Input summary",
    parcels: parcels.features.length,
    beacons: beacons.features.length,
    annotations: annotations?.features?.length || 0,
    outsideFigure: outsideFigure?.features?.length || 0,
    projection,
    extent,
    hasOutsideFigureData: !!outsideFigureData,
    outsideFigureDataEdges: outsideFigureData?.edges?.length || 0,
  });

  if (beaconLabels && Array.isArray(beaconLabels)) {
    logger.info(
      `[PDFKit] 🏷️ Received ${beaconLabels.length} beacon labels from UI`
    );
    logger.info(
      `[PDFKit] 📋 Sample labels (first 3): ${JSON.stringify(
        beaconLabels.slice(0, 3)
      )}`
    );
  } else {
    logger.info(
      `[PDFKit] ⚠️ No beacon labels received from UI (beaconLabels is ${beaconLabels})`
    );
  }

  // Frontend already sends only the parcels/beacons relevant to this survey.
  // Spatial filtering via outsideFigureData.edges was incorrect — the edges array
  // contains traverse endpoint coords (not ordered polygon vertices), so the
  // reconstructed boundary failed point-in-polygon tests and removed everything.
  let filteredParcels = parcels;
  let filteredBeacons = beacons;
  let calculatedExtent = extent;

  // Build outsideFigureBoundary for tick mark rendering only (not for filtering)
  let outsideFigureBoundary = null;
  if (outsideFigureData?.edges?.length > 0) {
    try {
      outsideFigureBoundary = outsideFigureData.edges.map((edge) =>
        normalizeCapeLoYX(edge.y, edge.x)
      );
      const first = outsideFigureBoundary[0];
      const last = outsideFigureBoundary[outsideFigureBoundary.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        outsideFigureBoundary.push([...first]);
      }
    } catch (error) {
      logger.warn({ msg: "⚠️ Could not build outsideFigureBoundary for tick marks", error: error.message });
    }
  }

  // ── Filter beacons: only those inside the outside figure polygon + 2m buffer ──
  if (outsideFigure?.features?.[0]?.geometry?.type === 'Polygon') {
    const _ofRing = outsideFigure.features[0].geometry.coordinates[0];
    const BUFFER_M = 2; // 2 metre buffer zone outside polygon

    // Build polygon ring in Cape Lo {y, x} (metres)
    const _polyPts = _ofRing.map(c => {
      const [y, x] = normalizeCapeLoYX(c[0], c[1]);
      return { y, x };
    });

    // Point-to-segment distance in metres
    const _distPtSeg = (py, px, ay, ax, by, bx) => {
      const dy = by - ay, dx = bx - ax;
      const lenSq = dy * dy + dx * dx;
      if (lenSq === 0) return Math.sqrt((py - ay) ** 2 + (px - ax) ** 2);
      const t = Math.max(0, Math.min(1, ((py - ay) * dy + (px - ax) * dx) / lenSq));
      const projY = ay + t * dy, projX = ax + t * dx;
      return Math.sqrt((py - projY) ** 2 + (px - projX) ** 2);
    };

    const _origCount = filteredBeacons.features.length;
    filteredBeacons = {
      ...filteredBeacons,
      features: filteredBeacons.features.filter(beacon => {
        const [bY, bX] = normalizeCapeLoYX(
          beacon.geometry.coordinates[0],
          beacon.geometry.coordinates[1]
        );

        // 1. Ray-casting point-in-polygon
        let inside = false;
        for (let i = 0, j = _polyPts.length - 1; i < _polyPts.length; j = i++) {
          const yi = _polyPts[i].x, yj = _polyPts[j].x; // X = Southing used as "y" in test
          const xi = _polyPts[i].y, xj = _polyPts[j].y; // Y = Westing used as "x" in test
          if ((yi > bX) !== (yj > bX) &&
              bY < ((xj - xi) * (bX - yi)) / (yj - yi) + xi) {
            inside = !inside;
          }
        }
        if (inside) return true;

        // 2. Within BUFFER_M of any polygon edge
        let minDist = Infinity;
        for (let i = 0; i < _polyPts.length - 1; i++) {
          const d = _distPtSeg(bY, bX,
            _polyPts[i].y, _polyPts[i].x,
            _polyPts[i + 1].y, _polyPts[i + 1].x);
          if (d < minDist) minDist = d;
        }
        return minDist <= BUFFER_M;
      }),
    };
    logger.info(`[PDFKit] 🔍 Beacon filter: ${_origCount} → ${filteredBeacons.features.length} (inside polygon + ${BUFFER_M}m buffer)`);
  }

  logger.info({
    msg: "[PDFKit] 📊 Render data summary",
    parcels: filteredParcels.features.length,
    beacons: filteredBeacons.features.length,
    hasBoundary: !!outsideFigureBoundary,
  });

  // Recalculate extent from parcels AND Outside Figure (frontend extent may be incorrect)
  // Collect ALL normalized coordinates first, then detect outliers before computing extent
  const _allYs = [];
  const _allXs = [];
  const _coordSources = []; // track source for diagnostics

  // Diagnostic: expose first parcel coord format
  const _fp = filteredParcels.features[0];
  logger.info({
    msg: "[PDFKit] 🔍 First parcel coord diagnostic",
    geomType: _fp?.geometry?.type,
    coordsLength: _fp?.geometry?.coordinates?.[0]?.length,
    firstCoord: _fp?.geometry?.coordinates?.[0]?.[0],
    coordType: typeof _fp?.geometry?.coordinates?.[0]?.[0],
    isArray: Array.isArray(_fp?.geometry?.coordinates?.[0]?.[0]),
  });

  // Include parcels in extent
  filteredParcels.features.forEach((parcel) => {
    if (parcel.geometry.type === "Polygon" && parcel.geometry.coordinates[0]) {
      let ring = parcel.geometry.coordinates[0];
      if (Array.isArray(ring) && ring.length === 1 && Array.isArray(ring[0]) && Array.isArray(ring[0][0])) {
        ring = ring[0];
      }
      ring.forEach((coord) => {
        const rawY = Array.isArray(coord) ? coord[0] : coord.y ?? coord[1];
        const rawX = Array.isArray(coord) ? coord[1] : coord.x ?? coord[0];
        const [y, x] = normalizeCapeLoYX(rawY, rawX);
        if (Number.isFinite(y) && Number.isFinite(x)) {
          _allYs.push(y);
          _allXs.push(x);
          _coordSources.push(parcel.properties.stand || 'unknown');
        }
      });
    }
  });

  // Include Outside Figure in extent
  if (outsideFigure?.features?.length > 0) {
    outsideFigure.features.forEach((feature) => {
      if (
        feature.geometry.type === "Polygon" &&
        feature.geometry.coordinates[0]
      ) {
        let _ofRing = feature.geometry.coordinates[0];
        if (Array.isArray(_ofRing) && _ofRing.length === 1 && Array.isArray(_ofRing[0]) && Array.isArray(_ofRing[0][0])) _ofRing = _ofRing[0];
        _ofRing.forEach((coord) => {
          const rawY = Array.isArray(coord) ? coord[0] : coord.y ?? coord[1];
          const rawX = Array.isArray(coord) ? coord[1] : coord.x ?? coord[0];
          const [y, x] = normalizeCapeLoYX(rawY, rawX);
          if (Number.isFinite(y) && Number.isFinite(x)) {
            _allYs.push(y);
            _allXs.push(x);
            _coordSources.push('OutsideFigure');
          }
        });
      }
    });
  }

  // ── OUTLIER DETECTION ──────────────────────────────────────────────────
  // Use IQR-based method: exclude coordinates beyond 3× IQR from median.
  // This prevents a single bad parcel coordinate from blowing up the extent
  // (e.g. one vertex 238km away making all content microscopic).
  function filterOutliers(values, label) {
    if (values.length < 4) return values;
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;
    // Use 3× IQR fence, but minimum fence of 5000m to avoid over-filtering tight clusters
    const fence = Math.max(iqr * 3, 5000);
    const lo = q1 - fence;
    const hi = q3 + fence;
    const filtered = values.filter(v => v >= lo && v <= hi);
    const removed = values.length - filtered.length;
    if (removed > 0) {
      logger.warn({
        msg: `[PDFKit] ⚠️ Outlier detection removed ${removed} ${label} coordinates`,
        q1, q3, iqr, fence: fence.toFixed(0), lo: lo.toFixed(0), hi: hi.toFixed(0),
        totalCoords: values.length, kept: filtered.length, removed,
      });
    }
    return filtered.length >= 4 ? filtered : values; // fallback to unfiltered if too aggressive
  }

  const _cleanYs = filterOutliers(_allYs, 'Y');
  const _cleanXs = filterOutliers(_allXs, 'X');

  let minY = Math.min(..._cleanYs);
  let maxY = Math.max(..._cleanYs);
  let minX = Math.min(..._cleanXs);
  let maxX = Math.max(..._cleanXs);

  // Aspect ratio sanity check: if one dimension is > 50× the other, warn loudly
  const _rawWidth = maxY - minY;
  const _rawHeight = maxX - minX;
  const _aspectRatio = _rawWidth > 0 && _rawHeight > 0 ? Math.max(_rawWidth / _rawHeight, _rawHeight / _rawWidth) : 1;
  if (_aspectRatio > 50) {
    logger.error({
      msg: `[PDFKit] 🚨 EXTREME aspect ratio ${_aspectRatio.toFixed(0)}:1 — extent may still contain outliers`,
      yRange: `${minY.toFixed(0)} to ${maxY.toFixed(0)} (${_rawWidth.toFixed(0)}m)`,
      xRange: `${minX.toFixed(0)} to ${maxX.toFixed(0)} (${_rawHeight.toFixed(0)}m)`,
    });
  }

  calculatedExtent = { minY, maxY, minX, maxX };

  // When rendering a specific tile, override the full-township extent with
  // the tile's ground window so all transforms are clamped to that sheet.
  if (tileExtent) {
    calculatedExtent = {
      minY: tileExtent.minY,
      maxY: tileExtent.maxY,
      minX: tileExtent.minX,
      maxX: tileExtent.maxX,
    };
    logger.info({
      msg: '[PDFKit] 🗺️ Tile extent override applied',
      tileLabel,
      tileExtent: calculatedExtent,
    });
  }

  logger.info({
    msg: "[PDFKit] 📐 Recalculated extent from parcels + Outside Figure",
    extent: calculatedExtent,
    width: maxY - minY,
    height: maxX - minX,
    totalCoords: _allYs.length,
    aspectRatio: _aspectRatio.toFixed(1),
  });

  // Rebuild outsideFigureBoundary as the bounding-box rectangle of ALL parcel geometry.
  // The 4 OFD edge endpoints form a sparse polygon that doesn't cover the full drawn
  // parcel area — blocks placed "outside" those 4 points still land on top of parcel lines.
  // Using the full extent bbox as the exclusion polygon ensures the block placement engine
  // rejects any slot that overlaps the drawn map area.
  // The bbox is a closed 5-point rectangle in geographic coords [Y, X].
  if (Number.isFinite(minY) && Number.isFinite(maxY) && Number.isFinite(minX) && Number.isFinite(maxX)) {
    outsideFigureBoundary = [
      [minY, minX],
      [maxY, minX],
      [maxY, maxX],
      [minY, maxX],
      [minY, minX], // close
    ];
    const _bboxMsg = `outsideFigureBoundary bbox: Y:${minY.toFixed(1)}-${maxY.toFixed(1)}, X:${minX.toFixed(1)}-${maxX.toFixed(1)}, pts:${outsideFigureBoundary.length}`;
    logger.info({ msg: "[PDFKit] 📐 outsideFigureBoundary rebuilt as extent bbox", bbox: _bboxMsg });
  }

  // Select appropriate page size per SI 727 Section 62
  // Honour sheetSize/scale from intelligentPreview when provided
  const pageSize = selectPageSize(calculatedExtent, logger, sheetSize, scale);

  // Create PDF document
  const doc = new PDFDocument({
    size: pageSize.size,
    layout: "portrait",
    margin: 0,
    info: {
      Title: tileLabel
        ? `${metadata?.title || "Survey Plan"} — ${tileLabel}`
        : (metadata?.title || "Survey Plan"),
      Author: metadata?.surveyor || "Survey Task Manager",
      Creator: "Survey Task Manager v1.0 - PDFKit GeoPDF Generator (SI 727 Compliant)",
      Producer: "Survey Task Manager",
      Subject: `Survey Plan - ${pageSize.name}`,
      CreationDate: new Date(),
    },
  });

  // Add georeferencing metadata
  addGeoreferencingMetadata(doc, projection, calculatedExtent);

  // ENHANCEMENT: Initialize True GeoPDF capabilities if requested
  let trueGeoPDFGenerator = null;
  let layerManager = null;
  let adaptiveRenderer = null;

  if (trueGeoPDF) {
    logger.info("[PDFKit] 🚀 Initializing True GeoPDF capabilities...");

    // Initialize enhanced components
    trueGeoPDFGenerator = new TrueGeoPDFGenerator(
      doc,
      projection,
      calculatedExtent
    );
    layerManager = new LayerManager();
    adaptiveRenderer = new AdaptiveRenderer();

    // Add layers with interactive capabilities
    layerManager.addLayer(
      "parcels",
      filteredParcels.features.map(
        (parcel) =>
          new GeospatialFeature(parcel.geometry, parcel.properties, "parcels")
      ),
      {
        interactive: interactive,
        scaleDependent: true,
        zIndex: 10,
      }
    );

    layerManager.addLayer(
      "beacons",
      filteredBeacons.features.map(
        (beacon) =>
          new GeospatialFeature(beacon.geometry, beacon.properties, "beacons")
      ),
      {
        interactive: interactive,
        zIndex: 20,
      }
    );

    if (outsideFigure?.features?.length > 0) {
      layerManager.addLayer("outsideFigure", outsideFigure.features, {
        interactive: false,
        zIndex: 5,
      });
    }

    logger.info("[PDFKit] ✅ True GeoPDF layers initialized");
  }

  // Calculate map bounds (main for blocks, figure for map features)
  const pageWidth = pageSize.size[0];
  const pageHeight = pageSize.size[1];
  const boundaries = calculateMapBounds(pageWidth, pageHeight);
  const mapBounds = boundaries.main; // For blocks and tables
  let figureBounds = boundaries.figure; // For parcels, beacons, outside figure (will be adjusted)

  // ── Reserve a top band for the title block; fit the outside figure below it ──
  // The title block (GENERAL PLAN / of / SHEET / designation / figure description
  // / Vide) is a single cohesive block at top-center. Inset the figure's drawing
  // area below its measured height so the figure is scaled + positioned clear of
  // every title element (deterministic — no escalation churn). calculateOptimalScale
  // and transformCoords both fit the figure into figureBounds, so insetting here
  // drives both the scale and the on-page position.
  {
    const _titleBandH = calculateTitleBlockHeight(doc, metadata, outsideFigureData, mapBounds, logger, parcels, sheetInfo);
    const _TITLE_FIGURE_GAP = 12; // pt of clear space between title and figure
    const _band = Math.min(_titleBandH + _TITLE_FIGURE_GAP, figureBounds.height * 0.5);
    figureBounds = {
      x: figureBounds.x,
      y: figureBounds.y + _band,
      width: figureBounds.width,
      height: figureBounds.height - _band,
    };
    logger.info(`[PDFKit] 📐 Reserved ${_band.toFixed(0)}pt title band — figure fitted below (figureBounds.y=${figureBounds.y.toFixed(0)}, h=${figureBounds.height.toFixed(0)})`);
  }

  // DYNAMIC MAP POSITIONING OPTIMIZATION
  // Calculate polygon bounds in PDF space to determine optimal map position
  let polygonPDFBounds = null;
  let mapXOffset = 0;

  // Reuse outsideFigureBoundary from filtering section for map positioning
  if (outsideFigureBoundary && outsideFigureBoundary.length > 0) {
    // Calculate polygon bounds using initial figure bounds
    polygonPDFBounds = calculatePolygonPDFBounds(
      outsideFigureBoundary,
      calculatedExtent,
      figureBounds
    );

    // Calculate optimal X offset based on polygon position
    mapXOffset = calculateDynamicMapOffset(
      polygonPDFBounds,
      figureBounds,
      logger
    );

    // Apply offset to figure bounds, clamped so the figure never extends
    // past the right edge of mapBounds (i.e. never into the endorsement margin)
    if (mapXOffset !== 0) {
      const rawX = figureBounds.x + mapXOffset;
      const maxAllowedX = mapBounds.x + mapBounds.width - figureBounds.width;
      const clampedX = Math.min(rawX, maxAllowedX);
      const clampedXLeft = Math.max(clampedX, mapBounds.x);
      const actualOffset = clampedXLeft - figureBounds.x;
      figureBounds = {
        x: clampedXLeft,
        y: figureBounds.y,
        width: figureBounds.width,
        height: figureBounds.height,
      };
      logger.info(
        `[PDFKit] ✅ Applied ${actualOffset.toFixed(1)}pt X offset to figure bounds (requested ${mapXOffset}pt, clamped to stay within mapBounds right edge)`
      );
    }
  }


  // Calculate optimal scale based on extent and adjusted figure area.
  // _forceMinDenominator forces the scale above a given denominator (used when
  // a previous render reported needsScaleUp and the caller retries with a higher scale).
  const optimalScale = calculateOptimalScale(
    calculatedExtent,
    figureBounds,
    logger,
    scale,
    _forceMinDenominator,
    planType
  );

  // ── Expand extent proportionally when scale is stepped up ──
  // Without this, transformCoords maps the data extent to fill the figure bounds
  // regardless of scale, so the polygon is always the same size on the page.
  // When scale steps up (e.g. 1:2000 → 1:2500), expand the extent by the
  // step-up ratio so the data fills a proportionally smaller area of the page
  // (80% at 1:2500, 67% at 1:3000), creating whitespace for block placement.
  {
    const requestedDenom = parseInt(String(scale).match(/1\s*:\s*(\d+)/)?.[1] || '0', 10);
    if (requestedDenom > 0 && optimalScale.value > requestedDenom) {
      const stepRatio = optimalScale.value / requestedDenom; // e.g. 2500/2000 = 1.25
      const dataW = calculatedExtent.maxY - calculatedExtent.minY;
      const dataH = calculatedExtent.maxX - calculatedExtent.minX;
      const centreY = (calculatedExtent.minY + calculatedExtent.maxY) / 2;
      const centreX = (calculatedExtent.minX + calculatedExtent.maxX) / 2;
      const halfW = (dataW * stepRatio) / 2;
      const halfH = (dataH * stepRatio) / 2;
      calculatedExtent = {
        minY: centreY - halfW,
        maxY: centreY + halfW,
        minX: centreX - halfH,
        maxX: centreX + halfH,
      };
      logger.info({
        msg: '[PDFKit] 📐 Extent expanded for block placement',
        scale: optimalScale.label,
        requestedScale: `1:${requestedDenom}`,
        stepRatio: stepRatio.toFixed(2),
        fillRatio: `${(100 / stepRatio).toFixed(0)}%`,
        dataSize: `${dataW.toFixed(1)}m × ${dataH.toFixed(1)}m`,
      });
    }
  }

  // POLYGON ALIGNMENT OPTIMISATION
  // Determine horizontal alignment of the polygon within figureBounds.
  // When the polygon is narrower than the effective figure area, left-aligning
  // concentrates the remaining horizontal slack into a single contiguous right-side
  // strip — the preferred zone for schedule-of-areas placement (SI 727).
  {
    const extWm = calculatedExtent.maxY - calculatedExtent.minY; // easting range (m)
    const extHm = calculatedExtent.maxX - calculatedExtent.minX; // northing range (m)
    const effectiveW = figureBounds.width  * 0.90; // 5% inset each side
    const effectiveH = figureBounds.height * 0.90;
    const uScale     = Math.min(effectiveW / extWm, effectiveH / extHm);
    const renderedW  = extWm * uScale;
    const hSlack     = effectiveW - renderedW;
    figureBounds.alignX = hSlack > 40 ? 'left' : 'center';
    logger.info(`[PDFKit] Figure alignX=${figureBounds.alignX} (hSlack=${hSlack.toFixed(0)}pt, renderedW=${renderedW.toFixed(0)}pt, effectiveW=${effectiveW.toFixed(0)}pt)`);
  }

  logger.info({
    msg: "[PDFKit] 📐 Layout calculated",
    pageSize: pageSize.name,
    scale: optimalScale.label,
    mainBoundary: {
      width: `${(mapBounds.width / MM_TO_PT).toFixed(1)}mm`,
      height: `${(mapBounds.height / MM_TO_PT).toFixed(1)}mm`,
    },
    figureBoundary: {
      x: `${figureBounds.x.toFixed(1)}pt`,
      width: `${(figureBounds.width / MM_TO_PT).toFixed(1)}mm`,
      height: `${(figureBounds.height / MM_TO_PT).toFixed(1)}mm`,
      xOffset: `${mapXOffset}pt`,
    },
    extentSize: {
      width: `${(calculatedExtent.maxY - calculatedExtent.minY).toFixed(2)}m`,
      height: `${(calculatedExtent.maxX - calculatedExtent.minX).toFixed(2)}m`,
    },
    filteredData: {
      parcels: filteredParcels.features.length,
      beacons: filteredBeacons.features.length,
    },
  });

  // ============================================================================
  // UNIFIED Z-ORDER COLLISION REGISTRY
  // ============================================================================
  // Tracks ALL rendered elements across Z-order layers to prevent overlaps:
  // Layer 1: Outside Figure (boundary + vertex beacons + vertex labels)
  // Layer 2: Parcel boundaries (black lines)
  // Layer 3: Beacons (circles + labels inside parcels)
  // Layer 4: Stand numbers (large labels at centroids)
  // Layer 5: Tick marks (crosses + Y/X coordinate labels)
  // Layer 6: Text overlays (Title Block, Schedule, etc.)
  // Layer 7: Map insets (detail views)

  const zOrderCollisionRegistry = {
    layer1_outsideFigure: [],
    layer2_parcelBoundaries: [],
    layer3_beacons: [],
    layer4_standNumbers: [],
    layer5_tickMarks: [],
    layer6_textOverlays: [],
    layer7_insets: [],

    // Register element with bounds
    register: function (layer, bounds, name, type = "unknown") {
      const entry = {
        name: name,
        type: type,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        layer: layer,
        timestamp: Date.now(),
      };

      const layerName = this._getLayerName(layer);
      this[`layer${layer}_${layerName}`].push(entry);
      return entry;
    },

    _getLayerName: function (layer) {
      const names = {
        1: "outsideFigure",
        2: "parcelBoundaries",
        3: "beacons",
        4: "standNumbers",
        5: "tickMarks",
        6: "textOverlays",
        7: "insets",
      };
      return names[layer] || "unknown";
    },

    // Check collision against specific layers or all previous layers
    checkCollision: function (
      testRect,
      buffer = 5,
      checkLayers = "all-previous",
      currentLayer = 7
    ) {
      let layersToCheck = [];

      if (checkLayers === "all-previous") {
        // Check all layers rendered before current layer
        layersToCheck = Array.from(
          { length: currentLayer - 1 },
          (_, i) => i + 1
        );
      } else if (checkLayers === "all") {
        layersToCheck = [1, 2, 3, 4, 5, 6, 7];
      } else if (Array.isArray(checkLayers)) {
        layersToCheck = checkLayers;
      }

      for (const layerNum of layersToCheck) {
        const layerName = this._getLayerName(layerNum);
        const items = this[`layer${layerNum}_${layerName}`];

        for (const item of items) {
          const overlap = !(
            testRect.x + testRect.width + buffer < item.x ||
            testRect.x > item.x + item.width + buffer ||
            testRect.y + testRect.height + buffer < item.y ||
            testRect.y > item.y + item.height + buffer
          );

          if (overlap) {
            return {
              collision: true,
              with: item.name,
              layer: layerNum,
              layerName: layerName,
              type: item.type,
            };
          }
        }
      }

      return { collision: false };
    },

    // Get statistics
    getStats: function () {
      return {
        layer1_outsideFigure: this.layer1_outsideFigure.length,
        layer2_parcelBoundaries: this.layer2_parcelBoundaries.length,
        layer3_beacons: this.layer3_beacons.length,
        layer4_standNumbers: this.layer4_standNumbers.length,
        layer5_tickMarks: this.layer5_tickMarks.length,
        layer6_textOverlays: this.layer6_textOverlays.length,
        layer7_insets: this.layer7_insets.length,
        total:
          this.layer1_outsideFigure.length +
          this.layer2_parcelBoundaries.length +
          this.layer3_beacons.length +
          this.layer4_standNumbers.length +
          this.layer5_tickMarks.length +
          this.layer6_textOverlays.length +
          this.layer7_insets.length,
      };
    },
  };

  logger.info(
    "[PDFKit] 🎯 Initialized unified Z-order collision registry (7 layers)"
  );

  // Initialize collision detector for intelligent label placement
  const collisionDetector = new LabelCollisionDetector();

  // Draw main map border
  drawMapBorder(doc, mapBounds);

  // Draw figure boundary (optional visual guide - can be removed for production)
  // doc.save();
  // doc.strokeColor('#CCCCCC').lineWidth(0.5).rect(figureBounds.x, figureBounds.y, figureBounds.width, figureBounds.height).stroke();
  // doc.restore();

  // Initialize InsetManager for map insets (short edges, complex details)
  const insetManager = new InsetManager(logger);

  // RENDERING ORDER (Professional Cadastral Standard):
  // 1. Outside Figure polygon (background layer - red boundary + vertex beacons + vertex labels)
  // 2. Parcel boundaries (no labels)
  // 3. Stand/Parcel numbers (large, bold, at centroids)
  // 4. Beacons with labels (inside parcels, excluding Outside Figure vertices)
  // 5. Edge labels (distance + direction, rotated, with inset support)
  // 6. Map insets (rendered in margins at end)
  // 7. Text overlays (Title Block, Schedule, etc.) - rendered LAST to stay on top

  // Step 1: Render Outside Figure boundary FIRST (as background layer)
  // This includes: red boundary line, beacon circles at vertices, and vertex labels outside polygon
  renderOutsideFigureBoundary(
    doc,
    outsideFigure,
    calculatedExtent,
    figureBounds,
    logger,
    optimalScale
  );

  // Extract Outside Figure vertex names to exclude from beacon rendering (they're already labeled by vertex labels)
  const outsideFigureVertexNames = new Set();
  if (
    outsideFigure &&
    outsideFigure.features &&
    outsideFigure.features.length > 0
  ) {
    const feature = outsideFigure.features[0];
    if (feature.properties && feature.properties.vertices) {
      feature.properties.vertices.forEach((v) => {
        if (v.name && v.name !== "Unknown") {
          outsideFigureVertexNames.add(v.name);
        }
      });
      logger.info(
        `[PDFKit] 🚫 Excluding ${
          outsideFigureVertexNames.size
        } Outside Figure vertices from beacon rendering: ${Array.from(
          outsideFigureVertexNames
        ).join(", ")}`
      );
    }
  }

  // NOTE: Tick marks are rendered later (after block positions calculated) to avoid title block collision

  // Step 2: Render parcel boundaries with labels (registers short edges for insets)
  if (
    filteredParcels &&
    filteredParcels.features &&
    filteredParcels.features.length > 0
  ) {
    var parcelRenderResult = renderParcels(
      doc,
      filteredParcels,
      calculatedExtent,
      figureBounds,
      collisionDetector,
      optimalScale,
      logger,
      insetManager,
      outsideFigureBoundary,
      metadata?.planType || 'general-undeveloped'
    );
  }

  // Step 3: Render beacons with labels (collision detection enabled)
  // Exclude Outside Figure vertices since they're already labeled by the vertex labeling system
  console.log(
    `🔍 DEBUG: About to call renderBeacons with ${
      filteredBeacons?.features?.length || 0
    } beacons`
  );
  console.log(
    `🔍 DEBUG: beaconLabels type: ${typeof beaconLabels}, isArray: ${Array.isArray(
      beaconLabels
    )}, length: ${beaconLabels?.length || beaconLabels?.size || 0}`
  );
  console.log(
    `🔍 DEBUG: excludeBeaconNames size: ${outsideFigureVertexNames?.size || 0}`
  );
  logger.info(
    `[PDFKit] 🔍 DEBUG: About to call renderBeacons with ${
      filteredBeacons?.features?.length || 0
    } beacons`
  );
  logger.info(
    `[PDFKit] 🔍 DEBUG: beaconLabels has ${beaconLabels?.size || 0} entries`
  );
  logger.info(
    `[PDFKit] 🔍 DEBUG: excludeBeaconNames has ${
      outsideFigureVertexNames?.size || 0
    } entries`
  );
  renderBeacons(
    doc,
    filteredBeacons,
    filteredParcels,
    calculatedExtent,
    figureBounds,
    collisionDetector,
    optimalScale,
    beaconLabels,
    logger,
    outsideFigureVertexNames
  );

  // Edge labels are rendered in renderParcels() with topology-aware split labeling

  // Step 4: Render stand numbers with PROFESSIONAL ENHANCED labeling system
  const renderStandNumbers = false;
  if (renderStandNumbers) {
    logger.info(
      "[PDFKit] 🏷️ Rendering stand numbers with professional collision detection..."
    );

    let standLabelsRendered = 0;
    const labelRegistry = new Map();
    const labelPriorityQueue = [];

    const labelCandidates = [];

    filteredParcels.features.forEach((parcel, index) => {
      try {
        const standValue = parcel.properties.stand;
        const designation = parcel.properties.designation;
        const description = parcel.properties.description;

        const isOutsideFigure =
          (standValue &&
            typeof standValue === "string" &&
            standValue.toLowerCase().includes("outside figure")) ||
          (designation &&
            typeof designation === "string" &&
            designation.toLowerCase().includes("outside figure")) ||
          (description &&
            typeof description === "string" &&
            description.toLowerCase().includes("outside figure")) ||
          parcel.properties.metadata?.isOutsideFigure === true;

        if (isOutsideFigure) return;

        let coords = parcel.geometry.coordinates[0];
        if (Array.isArray(coords) && coords.length === 1 && Array.isArray(coords[0]) && Array.isArray(coords[0][0])) coords = coords[0];
        const stand =
          parcel.properties.stand || parcel.properties.parcel_id || "";

        if (!stand) return;

        const parcelArea = calculateParcelArea(coords);
        const optimalFontSize = calculateOptimalFontSize(
          parcelArea,
          optimalScale
        );

        let sumY = 0,
          sumX = 0;
        const n = coords.length - 1;
        for (let i = 0; i < n; i++) {
          sumY += coords[i][0];
          sumX += coords[i][1];
        }
        const centroidY = sumY / n;
        const centroidX = sumX / n;

        const easting = -centroidY;
        const northing = -centroidX;
        const xRatio =
          (easting - calculatedExtent.minY) /
          (calculatedExtent.maxY - calculatedExtent.minY);
        const yRatio =
          (northing - calculatedExtent.minX) /
          (calculatedExtent.maxX - calculatedExtent.minX);
        const labelX = figureBounds.x + xRatio * figureBounds.width;
        const labelY =
          figureBounds.y + figureBounds.height - yRatio * figureBounds.height;

        const parcelPdfPolygon = coords
          .map((c) => {
            const p = transformCoords(
              c[0],
              c[1],
              calculatedExtent,
              figureBounds
            );
            return [p.x, p.y];
          })
          .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));

        const labelText = String(stand);
        const labelWidth = labelText.length * optimalFontSize * 0.6;
        const labelHeight = optimalFontSize + 2;

        const labelPadding = Math.max(2, optimalFontSize * 0.3);

        const candidate = {
          id: `stand-${stand}`,
          stand: stand,
          parcelIndex: index,
          parcelArea: parcelArea,
          priority:
            parcelArea > 1000 ? "high" : parcelArea > 500 ? "medium" : "low",
          fontSize: optimalFontSize,
          centroid: { x: labelX, y: labelY },
          polygon: parcelPdfPolygon,
          padding: labelPadding,
          originalBounds: {
            x: labelX - labelWidth / 2 - labelPadding,
            y: labelY - labelHeight / 2 - labelPadding,
            width: labelWidth + labelPadding * 2,
            height: labelHeight + labelPadding * 2,
          },
          alternatives: [],
        };

        const minSpacing = Math.max(2, optimalFontSize * 0.5);

        const offsets = [
          { dx: 0, dy: -minSpacing * 2, name: "above" },
          { dx: minSpacing * 2, dy: 0, name: "right" },
          { dx: 0, dy: minSpacing * 2, name: "below" },
          { dx: -minSpacing * 2, dy: 0, name: "left" },
          { dx: minSpacing, dy: -minSpacing, name: "top-right" },
          { dx: -minSpacing, dy: -minSpacing, name: "top-left" },
          { dx: minSpacing, dy: minSpacing, name: "bottom-right" },
          { dx: -minSpacing, dy: minSpacing, name: "bottom-left" },
        ];

        offsets.forEach((offset) => {
          candidate.alternatives.push({
            x: candidate.originalBounds.x + offset.dx,
            y: candidate.originalBounds.y + offset.dy,
            width: candidate.originalBounds.width,
            height: candidate.originalBounds.height,
            name: offset.name,
          });
        });

        labelCandidates.push(candidate);
      } catch (err) {
        console.error("Error calculating label candidate:", err.message);
      }
    });

    labelCandidates.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });

    labelCandidates.forEach((candidate) => {
      let placed = false;
      let finalBounds = candidate.originalBounds;

      const isRectFullyInsideParcel = (rect) => {
        const polygon = candidate.polygon;
        if (!polygon || polygon.length < 3) return true;
        const corners = [
          [rect.x, rect.y],
          [rect.x + rect.width, rect.y],
          [rect.x + rect.width, rect.y + rect.height],
          [rect.x, rect.y + rect.height],
        ];
        return corners.every((corner) =>
          isPointInPolygonSimple(corner, polygon)
        );
      };

      const hasAnyCollision = (rect) => {
        if (!isRectFullyInsideParcel(rect)) return true;
        if (
          hasCollisionWithRegistry(
            rect,
            labelRegistry,
            candidate.fontSize * 0.5
          )
        ) {
          return true;
        }
        if (
          collisionDetector.hasCollision(
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            2
          )
        ) {
          return true;
        }
        return false;
      };

      if (!hasAnyCollision(finalBounds)) {
        placed = true;
        finalBounds = finalBounds;
      } else {
        for (const alt of candidate.alternatives) {
          if (!hasAnyCollision(alt)) {
            placed = true;
            finalBounds = alt;
            break;
          }
        }
      }

      if (!placed) {
        const polygon = candidate.polygon;
        if (polygon && polygon.length >= 3) {
          const polyBounds = polygon.reduce(
            (acc, p) => {
              acc.minX = Math.min(acc.minX, p[0]);
              acc.maxX = Math.max(acc.maxX, p[0]);
              acc.minY = Math.min(acc.minY, p[1]);
              acc.maxY = Math.max(acc.maxY, p[1]);
              return acc;
            },
            {
              minX: Infinity,
              maxX: -Infinity,
              minY: Infinity,
              maxY: -Infinity,
            }
          );

          const step = Math.max(
            4,
            Math.min(
              18,
              Math.round(
                Math.min(finalBounds.width, finalBounds.height) / 2
              )
            )
          );

          let bestCandidate = null;
          let bestDist2 = Infinity;

          for (let y = polyBounds.minY; y <= polyBounds.maxY; y += step) {
            for (let x = polyBounds.minX; x <= polyBounds.maxX; x += step) {
              if (!isPointInPolygonSimple([x, y], polygon)) continue;

              const rect = {
                x: x - finalBounds.width / 2,
                y: y - finalBounds.height / 2,
                width: finalBounds.width,
                height: finalBounds.height,
              };

              if (hasAnyCollision(rect)) continue;

              const dx = x - candidate.centroid.x;
              const dy = y - candidate.centroid.y;
              const dist2 = dx * dx + dy * dy;
              if (dist2 < bestDist2) {
                bestDist2 = dist2;
                bestCandidate = rect;
              }
            }
          }

          if (bestCandidate) {
            placed = true;
            finalBounds = bestCandidate;
          }
        }
      }

      if (placed) {
        doc.save();
        doc
          .fontSize(candidate.fontSize)
          .fillColor("#000000")
          .font("Helvetica-Bold")
          .text(
            candidate.stand,
            finalBounds.x + candidate.padding,
            finalBounds.y + candidate.padding,
            {
              lineBreak: false,
            }
          );
        doc.restore();

        labelRegistry.set(candidate.id, finalBounds);

        collisionDetector.addRegion(
          finalBounds.x,
          finalBounds.y,
          finalBounds.width,
          finalBounds.height,
          1
        );

        zOrderCollisionRegistry.register(
          4,
          finalBounds,
          candidate.id,
          "stand-number"
        );

        standLabelsRendered++;

        logger.info(
          `[PDFKit] 🏷️ Rendered stand "${candidate.stand}" (${
            candidate.priority
          } priority) - font: ${candidate.fontSize.toFixed(
            1
          )}mm - pos: ${finalBounds.x.toFixed(1)},${finalBounds.y.toFixed(1)}`
        );
      } else {
        logger.info(
          `[PDFKit] ⚠️ Skipped stand "${candidate.stand}" - no collision-free position available`
        );
      }
    });

    logger.info(
      `[PDFKit] 🏷️ Professional labeling: ${standLabelsRendered}/${labelCandidates.length} stand labels rendered`
    );
  }

  // Helper function to calculate parcel area
  function calculateParcelArea(coords) {
    let area = 0;
    const n = coords.length - 1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += coords[i][0] * coords[j][1];
      area -= coords[j][0] * coords[i][1];
    }
    return Math.abs(area / 2);
  }

  // Helper function to calculate optimal font size based on parcel area
  function calculateOptimalFontSize(parcelArea, mapScale) {
    // Validate inputs
    if (!parcelArea || parcelArea <= 0 || !mapScale || isNaN(mapScale)) {
      console.error("[PDFKit] ❌ calculateOptimalFontSize: Invalid inputs", {
        parcelArea,
        mapScale,
      });
      return 2.5; // Reduced default font size
    }

    // Handle both scale object and numeric value
    const scaleValue = typeof mapScale === "object" ? mapScale.value : mapScale;

    if (!scaleValue || isNaN(scaleValue)) {
      console.error(
        "[PDFKit] ❌ calculateOptimalFontSize: Invalid scaleValue",
        { mapScale }
      );
      return 2.5; // Reduced default font size
    }

    // Professional font size calculation based on SI 727 standards (FURTHER REDUCED SIZES)
    let baseSize;
    if (parcelArea > 1000) {
      baseSize = Math.min(3, Math.sqrt(parcelArea) * 0.06); // Large parcels: reduced from 4 to 3
    } else if (parcelArea > 500) {
      baseSize = Math.min(2.5, Math.sqrt(parcelArea) * 0.08); // Medium parcels: reduced from 3 to 2.5
    } else if (parcelArea > 200) {
      baseSize = Math.min(2, Math.sqrt(parcelArea) * 0.1); // Small parcels: reduced from 2.5 to 2
    } else {
      baseSize = Math.min(1.5, Math.sqrt(parcelArea) * 0.12); // Very small parcels: reduced from 2 to 1.5
    }

    // Scale adjustment for map zoom level (reduced factor)
    const scaleAdjusted = baseSize * (mapScale / 1500); // Reduced from 1000 to 1500

    // Ensure minimum and maximum sizes per SI 727 (tighter range)
    return Math.max(1.2, Math.min(5, scaleAdjusted)); // Reduced range: 1.2-5mm
  }

  // Helper function to check collision with existing labels
  function hasCollisionWithRegistry(testBounds, registry, minSpacing) {
    for (const [id, existingBounds] of registry) {
      if (checkLabelCollision(testBounds, existingBounds, minSpacing)) {
        return true;
      }
    }
    return false;
  }

  // Helper function to check label collision
  function checkLabelCollision(bounds1, bounds2, minSpacing) {
    return !(
      bounds1.x - minSpacing > bounds2.x + bounds2.width ||
      bounds2.x - minSpacing > bounds1.x + bounds1.width ||
      bounds1.y - minSpacing > bounds2.y + bounds2.height ||
      bounds2.y - minSpacing > bounds1.y + bounds1.height
    );
  }

  // =========================================================================
  // TOPOLOGY-AWARE BLOCK PLACEMENT
  // Build parcel line segments in PDF coords from all parcel polygon rings.
  // These segments represent the actual drawn lines — blocks placed in map
  // corners that are clear of ALL segments are guaranteed to not overlap any
  // drawn feature. Segments are passed to the engine/stacker for scoring;
  // the polygon hard-reject is NOT used (polygon covers too much of the map).
  // =========================================================================

  const _parcelSegments = []; // [{x1,y1,x2,y2}] in PDF coords

  const _addRingSegments = (ring) => {
    for (let i = 0; i < ring.length - 1; i++) {
      const c0 = ring[i],   c1 = ring[i + 1];
      const r0y = Array.isArray(c0) ? c0[0] : c0.y ?? c0[1];
      const r0x = Array.isArray(c0) ? c0[1] : c0.x ?? c0[0];
      const r1y = Array.isArray(c1) ? c1[0] : c1.y ?? c1[1];
      const r1x = Array.isArray(c1) ? c1[1] : c1.x ?? c1[0];
      if (!Number.isFinite(r0y) || !Number.isFinite(r0x) ||
          !Number.isFinite(r1y) || !Number.isFinite(r1x)) continue;
      const p0 = transformCoords(r0y, r0x, calculatedExtent, figureBounds);
      const p1 = transformCoords(r1y, r1x, calculatedExtent, figureBounds);
      _parcelSegments.push({ x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y });
    }
  };

  // Add all parcel ring segments
  for (const parcel of filteredParcels.features) {
    if (parcel.geometry?.type === 'Polygon' && parcel.geometry.coordinates?.[0]) {
      let ring = parcel.geometry.coordinates[0];
      if (Array.isArray(ring) && ring.length === 1 && Array.isArray(ring[0]) && Array.isArray(ring[0][0])) ring = ring[0];
      _addRingSegments(ring);
    }
  }

  // Add outside figure boundary segments
  if (outsideFigure?.features?.length > 0) {
    for (const feat of outsideFigure.features) {
      if (feat.geometry?.type === 'Polygon' && feat.geometry.coordinates?.[0]) {
        let ring = feat.geometry.coordinates[0];
        if (Array.isArray(ring) && ring.length === 1 && Array.isArray(ring[0]) && Array.isArray(ring[0][0])) ring = ring[0];
        _addRingSegments(ring);
      }
    }
  }

  // Compute segment bbox for mapFeatureBounds envelope (used by engine scoring, not hard-reject)
  let _segMinX = Infinity, _segMinY = Infinity, _segMaxX = -Infinity, _segMaxY = -Infinity;
  for (const s of _parcelSegments) {
    _segMinX = Math.min(_segMinX, s.x1, s.x2);
    _segMinY = Math.min(_segMinY, s.y1, s.y2);
    _segMaxX = Math.max(_segMaxX, s.x1, s.x2);
    _segMaxY = Math.max(_segMaxY, s.y1, s.y2);
  }

  // _topoPolyPts: extent-fitted polygon vertices used by tick-mark and label
  // collision avoidance below. Matches where the OF is actually drawn on the
  // PDF page, which depends on calculatedExtent (potentially larger than the
  // OF itself if outlier parcels exist). Do NOT reuse this for the planner —
  // see _polyForPlanner below.
  const _topoPolyPts = [];
  if (outsideFigure?.features?.length > 0) {
    const _ofFeat = outsideFigure.features[0];
    if (_ofFeat?.geometry?.type === 'Polygon' && _ofFeat.geometry.coordinates?.[0]) {
      let _ring = _ofFeat.geometry.coordinates[0];
      if (Array.isArray(_ring) && _ring.length === 1 && Array.isArray(_ring[0]) && Array.isArray(_ring[0][0])) _ring = _ring[0];
      for (const v of _ring) {
        const vy = Array.isArray(v) ? v[0] : (v.y ?? v[1]);
        const vx = Array.isArray(v) ? v[1] : (v.x ?? v[0]);
        if (Number.isFinite(vy) && Number.isFinite(vx)) {
          const pt = transformCoords(vy, vx, calculatedExtent, figureBounds);
          _topoPolyPts.push({ x: pt.x, y: pt.y });
        }
      }
    }
  }
  // mapFeatureBounds: pdfPoints = outside figure polygon vertices for hard-reject.
  // parcelSegments kept for topology scoring bonus.
  // Always build mapFeatureBounds with pdfPoints so polygon hard-reject fires
  // regardless of whether parcel segments exist.
  const _mfbBase = _parcelSegments.length > 0
    ? { x: _segMinX, y: _segMinY, width: _segMaxX - _segMinX, height: _segMaxY - _segMinY, right: _segMaxX, bottom: _segMaxY }
    : calculateMapFeatureBounds(outsideFigureBoundary, calculatedExtent, figureBounds);
  const mapFeatureBounds = {
    ..._mfbBase,
    pdfPoints:      _topoPolyPts.length > 0 ? _topoPolyPts : (_mfbBase.pdfPoints ?? []),
    parcelSegments: _parcelSegments,
  };

  logger.info({
    msg:            '[PDFKit] 🗺️  Topology-aware: parcel segments built',
    segmentCount:   _parcelSegments.length,
    segBbox:        `(${_segMinX.toFixed(0)},${_segMinY.toFixed(0)}) → (${_segMaxX.toFixed(0)},${_segMaxY.toFixed(0)})`,
    figureBounds:   `(${figureBounds.x.toFixed(0)},${figureBounds.y.toFixed(0)}) ${figureBounds.width.toFixed(0)}×${figureBounds.height.toFixed(0)}`,
    mapBounds:      `(${mapBounds.x.toFixed(0)},${mapBounds.y.toFixed(0)}) ${mapBounds.width.toFixed(0)}×${mapBounds.height.toFixed(0)}`,
  });

  // Step 5a: TWO-PASS TICK MARK SYSTEM
  // Pass 1: Calculate initial tick mark bounds (without title block) to reserve space
  // Use mapBounds (drawing margins) instead of figureBounds to allow ticks in margins
  const initialTickMarkBounds = calculateTickMarkBounds(
    outsideFigure,
    calculatedExtent,
    mapBounds,  // Use full drawing area within margins
    logger,
    null
  );
  logger.info(
    `[PDFKit] 📐 Pass 1: Calculated ${initialTickMarkBounds.length} initial tick mark reserved regions`
  );

  // =========================================================================
  // LABEL CROWDING ESCALATION
  // When edge labels can't find collision-free positions, escalate:
  //   1. FIRST try the next larger paper size (A2→A1→A0) at the SAME scale.
  //   2. ONLY if at A0, try the next smaller scale denominator (e.g. 1:2500→1:2000)
  //      so edges become longer on paper, giving more room for label text.
  // =========================================================================
  const MAX_LABEL_ESCALATION = 2;
  const labelCollisions = parcelRenderResult?.labelCollisions || 0;
  if (labelCollisions > 0 && _labelEscalationAttempt < MAX_LABEL_ESCALATION) {
    const LABEL_SHEET_ORDER = ['ISO_A2', 'ISO_A1', 'ISO_A0'];
    const currentSheet = sheetSize || 'ISO_A2';
    const sheetIdx = LABEL_SHEET_ORDER.indexOf(currentSheet);
    const canGoBiggerPaper = sheetIdx >= 0 && sheetIdx < LABEL_SHEET_ORDER.length - 1;

    if (canGoBiggerPaper) {
      // ── PAPER-SIZE ESCALATION for labels ──
      const nextSheet = LABEL_SHEET_ORDER[sheetIdx + 1];
      logger.warn(
        `[PDFKit] 🏷️ Label crowding detected (${labelCollisions} collisions) on ${currentSheet} at ${optimalScale.label} — ` +
        `escalating paper to ${nextSheet} (attempt ${_labelEscalationAttempt + 1}/${MAX_LABEL_ESCALATION})`
      );
      try {
        return await _generateGeoPDFInner({
          ...options,
          sheetSize: nextSheet,
          _sheetSizeUpAttempt: _sheetSizeUpAttempt + 1,
          _labelEscalationAttempt: _labelEscalationAttempt + 1,
        }, logger);
      } catch (retryErr) {
        logger.warn(`[PDFKit] ⚠️ Label paper escalation failed — continuing with ${labelCollisions} label collisions`);
      }
    } else {
      // ── SCALE STEP-DOWN for labels (smaller denominator = longer edges on paper) ──
      const curIdx = SI727_PRESCRIBED_SCALES.findIndex(s => s.value === optimalScale.value);
      const prevIdx = curIdx > 0 ? curIdx - 1 : -1;
      const prevScale = prevIdx >= 0 ? SI727_PRESCRIBED_SCALES[prevIdx] : null;
      if (prevScale) {
        logger.warn(
          `[PDFKit] 🏷️ Label crowding detected (${labelCollisions} collisions) at largest paper — ` +
          `stepping scale DOWN from ${optimalScale.label} to ${prevScale.label} for more label room`
        );
        try {
          return await _generateGeoPDFInner({
            ...options,
            scale: prevScale.label,
            _labelEscalationAttempt: _labelEscalationAttempt + 1,
          }, logger);
        } catch (retryErr) {
          logger.warn(`[PDFKit] ⚠️ Label scale step-down failed — continuing with ${labelCollisions} label collisions`);
        }
      } else {
        logger.warn(`[PDFKit] ⚠️ Label crowding (${labelCollisions} collisions) but already at smallest scale — accepting overlaps`);
      }
    }
  }

  // Pass 2: Calculate block positions via the shared sheet-layout planner.
  // Both PDF and DXF call planSheetLayout to guarantee identical block arrangement.
  // PDF passes its real PDFKit doc through measureText so the planner uses
  // PDFKit's widthOfString for text measurement (DXF passes its own 0.55 heuristic).
  const pdfKitMeasureText = (str, { family, size }) =>
    doc.font(family).fontSize(size).widthOfString(str);

  // 3-v7: Compute dynamic schedule column widths once and pass to the planner.
  // The schedule renderers will consume the same widths in Task 6.
  // Measurer signature matches block-definitions.js' computeScheduleColumnWidths
  // contract: (text, fontSize) => widthInPt. Headers render in Helvetica-Bold,
  // body in Helvetica, matching drawScheduleOfAreasSingleColumn.
  const _pdfScheduleMeasurer = buildPdfScheduleMeasurer(doc, 6, 7);
  const _scheduleColumnWidthsPt = (() => {
    try {
      // 3-v8 follow-up: exclude the Outside Figure parcel from the measurer
      // input. DXF already filters it (dxfGenerator.surveyedFeatures), and the
      // PDF schedule itself only ever renders stand rows — so the OF row was
      // inflating column 1 to ~91 pt ("OUTSIDE FIGURE M1686") without ever
      // being drawn, which caused the planner to see a wider schedule on PDF
      // than DXF and place it differently.
      const _scheduleRows = filteredParcels.features.filter(f => {
        const st = String(f.properties?.stand || '').toLowerCase();
        return !f.properties?.isOutsideFigure && !st.includes('outside figure');
      });
      return computeScheduleColumnWidths({
        dataRows: _scheduleRows.map(extractScheduleRow),
        headerFontSize: 6,   // matches drawScheduleOfAreasSingleColumn header font
        bodyFontSize:   7,   // matches drawScheduleOfAreasSingleColumn body font
        measureText:    _pdfScheduleMeasurer,
      });
    } catch (e) {
      logger.warn?.(`[PDFKit] computeScheduleColumnWidths fell back to static: ${e.message}`);
      return null;   // planner falls back to static via the Task 4 guard
    }
  })();

  // 3-v8: polygon-for-planner from the shared helper. DXF builds the same
  // polygon via the same helper, so planSheetLayout receives identical
  // polygon shape + mapBounds-relative position on both sides. Block
  // placements now agree across formats. _topoPolyPts is still used below
  // for tick-mark/label collision avoidance, which needs the extent-fitted
  // polygon matching the actually-drawn OF.
  // 3-v8 follow-up: build polygon AND parcel segments via the shared helper so
  // PDF and DXF feed the engine identical obstacle sets. Previously PDF built
  // parcelSegments via transformCoords (fit-to-extent) and DXF passed none,
  // which made the engine score placements differently and pinned the
  // schedule to opposite corners on the two formats.
  const { polyPts: _polyForPlanner, parcelSegments: _parcelSegmentsForPlanner } = buildPlannerObstacles({
    outsideFigure,
    parcels:    filteredParcels,
    scaleDenom: optimalScale?.value,
    mapBounds,
    closeRing:  false,
  });
  // mapFeatureBounds.pdfPoints feeds the planner's polygon obstacle list, so
  // it must use the planner polygon (not _topoPolyPts). parcelSegments
  // overrides the format-specific build above so both formats agree.
  const mapFeatureBoundsForPlanner = {
    ...mapFeatureBounds,
    pdfPoints:      _polyForPlanner.length > 0 ? _polyForPlanner : mapFeatureBounds.pdfPoints,
    parcelSegments: _parcelSegmentsForPlanner,
  };

  // ── 3-v7 diagnostic: log the planner inputs so PDF↔DXF discrepancies can be
  // traced from the same request.  Remove once polygon-handoff is verified.
  const _diagPolyBbox = (_polyForPlanner && _polyForPlanner.length)
    ? {
        minX: Math.min(..._polyForPlanner.map(p => p.x)),
        maxX: Math.max(..._polyForPlanner.map(p => p.x)),
        minY: Math.min(..._polyForPlanner.map(p => p.y)),
        maxY: Math.max(..._polyForPlanner.map(p => p.y)),
      }
    : null;
  logger.info({
    msg: '[PLANNER-INPUT] PDF → planSheetLayout',
    mapBounds: { x: mapBounds.x, y: mapBounds.y, width: mapBounds.width, height: mapBounds.height },
    polyVerts: _polyForPlanner?.length ?? 0,
    polyBbox: _diagPolyBbox,
    polyFirst3: _polyForPlanner?.slice(0, 3).map(p => ({ x: +p.x.toFixed(1), y: +p.y.toFixed(1) })),
    scheduleColumnWidthsPt: _scheduleColumnWidthsPt,
  });

  const blockPositions = planSheetLayout({
    metadata,
    parcels: filteredParcels,
    outsideFigureData,
    beacons: filteredBeacons,
    mapBounds,
    mapFeatureBounds: mapFeatureBoundsForPlanner,
    logger,
    scale: optimalScale,
    extent: calculatedExtent,
    // 3-v8 follow-up: pass [] so PDF and DXF feed the planner identical
    // obstacle sets. The 4 corner tick-mark reservations only existed on the
    // PDF side and caused the planner to pick different schedule/OFD/SG
    // anchor zones than DXF. PDF's tick-mark renderer already does its own
    // collision avoidance at draw time (per "Y label … has collisions in all
    // placements — skipping label" diagnostics), so dropping them here only
    // affects the planner's pre-render decisions, not the visible ticks.
    tickMarkBounds: [],
    zOrderCollisionRegistry,
    // 3-v8 follow-up: omit figureBounds so PDF's scale bar gets sized off
    // mapBounds.width — same calc DXF already uses. Previously PDF's scale
    // bar was 202pt and DXF's was 188pt, and that 14pt obstacle-size delta
    // (combined with surveyStatement's 8pt drift) tipped the relaxed-scan
    // stacker into picking a different anchor for scheduleOfAreas.
    // figureBounds: figureBounds,
    polyPts: _polyForPlanner,
    measureText: pdfKitMeasureText,
    scheduleColumnWidthsPt: _scheduleColumnWidthsPt,
  });

  // 3-v7 diagnostic: log returned block positions so the PDF↔DXF placement
  // divergence can be diagnosed from a single request.
  logger.info({
    msg: '[PLANNER-OUTPUT] PDF received block positions',
    titleBlock:        blockPositions.titleBlock        ? { x: +blockPositions.titleBlock.x.toFixed(1),        y: +blockPositions.titleBlock.y.toFixed(1) }        : null,
    scheduleOfAreas:   blockPositions.scheduleOfAreas   ? { x: +blockPositions.scheduleOfAreas.x.toFixed(1),   y: +blockPositions.scheduleOfAreas.y.toFixed(1) }   : null,
    outsideFigureData: blockPositions.outsideFigureData ? { x: +blockPositions.outsideFigureData.x.toFixed(1), y: +blockPositions.outsideFigureData.y.toFixed(1) } : null,
    surveyStatement:   blockPositions.surveyStatement   ? { x: +blockPositions.surveyStatement.x.toFixed(1),   y: +blockPositions.surveyStatement.y.toFixed(1) }   : null,
    sgSignature:       blockPositions.sgSignature       ? { x: +blockPositions.sgSignature.x.toFixed(1),       y: +blockPositions.sgSignature.y.toFixed(1) }       : null,
  });

  // =========================================================================
  // PAPER-SIZE ESCALATION (preferred) then SCALE STEP-UP (last resort)
  //
  // When mandatory blocks can't be placed without polygon overlap:
  //   1. FIRST try the next larger paper size (A2→A1→A0) at the SAME scale.
  //      This preserves legibility per SI 727 §32(2).
  //   2. ONLY if already at A0 (largest), try the next higher scale denominator.
  // =========================================================================
  const MAX_SCALE_UP_ATTEMPTS = 1;
  let suggestedScale = null;

  if (blockPositions.needsScaleUp) {
    // Determine current sheet size name
    const currentSheetName = sheetSize || 'ISO_A2';
    const canEscalateSheet = nextSheetUp(currentSheetName) !== null
      && _sheetSizeUpAttempt < MAX_SHEET_UP_ATTEMPTS;

    if (canEscalateSheet) {
      // ── PAPER-SIZE ESCALATION ──
      const nextSheet = nextSheetUp(currentSheetName);
      logger.warn(
        `[PDFKit] 📄 Blocks unplaceable on ${currentSheetName} at ${optimalScale.label} — ` +
        `escalating paper size to ${nextSheet} (attempt ${_sheetSizeUpAttempt + 1}/${MAX_SHEET_UP_ATTEMPTS})`
      );
      try {
        return await _generateGeoPDFInner({
          ...options,
          sheetSize: nextSheet,
          _sheetSizeUpAttempt: _sheetSizeUpAttempt + 1,
          _scaleUpAttempt: 0, // reset scale attempts for the new sheet
        }, logger);
      } catch (retryErr) {
        const errMsg = `SHEET-SIZE-RETRY-ERROR attempt=${_sheetSizeUpAttempt + 1} nextSheet=${nextSheet} err=${retryErr?.message} stack=${retryErr?.stack?.slice(0, 500)}`;
        console.error(errMsg);
        logger.warn(`[PDFKit] ⚠️ Paper-size escalation failed — continuing at ${currentSheetName} with stacker fallback`);
      }
    } else if (_scaleUpAttempt < MAX_SCALE_UP_ATTEMPTS) {
      // ── SCALE STEP-UP (only when at largest sheet or sheet escalation exhausted) ──
      const _curIdx = SI727_PRESCRIBED_SCALES.findIndex(s => s.value === optimalScale.value);
      const _nextIdx = _curIdx !== -1 ? _curIdx + 1 : -1;
      const nextScale = _nextIdx !== -1 && _nextIdx < SI727_PRESCRIBED_SCALES.length
        ? SI727_PRESCRIBED_SCALES[_nextIdx]
        : null;
      if (nextScale) {
        logger.warn(
          `[PDFKit] 📏 Already at largest sheet (${currentSheetName}) — ` +
          `stepping up scale from ${optimalScale.label} to ${nextScale.label}`
        );
        try {
          return await _generateGeoPDFInner({
            ...options,
            _forceMinDenominator: optimalScale.value,
            _scaleUpAttempt: _scaleUpAttempt + 1,
            _sheetSizeUpAttempt, // preserve sheet escalation count
          }, logger);
        } catch (retryErr) {
          const errMsg = `SCALE-RETRY-ERROR attempt=${_scaleUpAttempt + 1} nextScale=${nextScale.label} err=${retryErr?.message} stack=${retryErr?.stack?.slice(0, 500)}`;
          console.error(errMsg);
          logger.warn(`[PDFKit] ⚠️ Scale retry failed — continuing at ${optimalScale.label} with stacker fallback`);
        }
        suggestedScale = nextScale.label;
      }
    } else {
      logger.warn(`[PDFKit] ⚠️ Both paper-size escalation and scale step-up exhausted — using stacker fallback`);
    }
    // 3-v7: emit identical structured warning as DXF on escalation exhaustion.
    warnings.scheduleEscalationExhausted = {
      atSheetSize: sheetSize || 'ISO_A2',
      attempts: _sheetSizeUpAttempt,
      hint: 'Plan too dense for largest available paper size; some blocks may overlap the figure.',
    };
  }

  // Pass 3: Recalculate tick mark bounds with title block position for final adjustment
  // Use mapBounds (drawing margins) instead of figureBounds to allow ticks in margins
  const finalTickMarkBounds = calculateTickMarkBounds(
    outsideFigure,
    calculatedExtent,
    mapBounds,  // Use full drawing area within margins
    logger,
    blockPositions.titleBlock
  );
  logger.info(
    `[PDFKit] 📐 Pass 2: Recalculated ${finalTickMarkBounds.length} final tick mark positions (avoiding title block)`
  );

  // Register tick marks in Layer 5 collision registry
  finalTickMarkBounds.forEach((tick) => {
    zOrderCollisionRegistry.register(5, tick, tick.name, "tick-mark");
  });
  logger.info(
    `[PDFKit] 📐 Registered ${finalTickMarkBounds.length} tick marks in Layer 5 collision registry`
  );

  // Step 5b: Draw all data blocks BEFORE tick marks so that blockPositions reflects
  // the actual rendered positions when tick mark label collision checks run.
  // This prevents tick mark X/Y labels from landing on tables.
  logger.info(
    "[PDFKit] ℹ️ Step 5b: Drawing all data blocks (before tick marks)"
  );
  logger.info("[PDFKit] 🔧 BuildTag: stand-whitespace-v2");

  drawTitleBlock(
    doc,
    metadata,
    mapBounds,
    outsideFigureData,
    blockPositions.titleBlock,
    logger,
    filteredParcels,
    sheetInfo  // SI 727 Seventh Schedule (b) multi-sheet info
  );
  drawScheduleOfAreas(
    doc,
    filteredParcels,
    mapBounds,
    blockPositions.scheduleOfAreas,
    logger,
    blockPositions,
    mapFeatureBounds,
    finalTickMarkBounds,
    {
      needsSplit:  blockPositions._schedNeedsSplit  ?? false,
      numCols:     blockPositions._schedNumCols     ?? 1,
      rowsPerCol:  blockPositions._schedRowsPerCol  ?? (filteredParcels?.features?.length ?? 0),
    },
    optimalScale.value,
    _scheduleColumnWidthsPt,   // 3-v7: caller-provided widths from planner
  );
  drawOutsideFigureData(
    doc,
    outsideFigureData,
    mapBounds,
    blockPositions.outsideFigureData,
    filteredBeacons,
    logger
  );
  drawBeaconDescription(
    doc,
    filteredBeacons,
    mapBounds,
    blockPositions.beaconDescription
  );
  drawScaleBar(
    doc,
    calculatedExtent,
    mapBounds,
    optimalScale,
    blockPositions.scaleBar,
    figureBounds
  );
  drawSurveyStatement(doc, metadata, mapBounds, blockPositions.surveyStatement);
  drawNorthArrow(doc, mapBounds, blockPositions.northArrow);
  drawSurveyorGeneralSignature(doc, mapBounds, blockPositions.sgSignature);

  drawEndorsementBlock(doc, blockPositions.endorsement);

  // 3-v7: structured warnings for each surrounding block that overlaps the polygon.
  // Mirrors DXF's per-block OverlapsPolygon warnings (same category names).
  const _pdfPoly = mapFeatureBounds?.pdfPoints ?? [];
  function _pdfWarnIfOverlap(name, pos) {
    if (!_pdfPoly || _pdfPoly.length < 3) return;
    if (!pos) return;
    const rect = { x: pos.x, y: pos.y, width: pos.width, height: pos.height };
    if (rectangleOverlapsPolygon(rect, _pdfPoly, 0)) {
      warnings[`${name}OverlapsPolygon`] = {
        position: rect,
        hint: `${name} block rendered over the parcel figure.`,
      };
    }
  }

  _pdfWarnIfOverlap('outsideFigureData', blockPositions.outsideFigureData);
  _pdfWarnIfOverlap('scheduleOfAreas',   blockPositions.scheduleOfAreas);
  _pdfWarnIfOverlap('beaconDescription', blockPositions.beaconDescription);
  _pdfWarnIfOverlap('surveyStatement',   blockPositions.surveyStatement);
  _pdfWarnIfOverlap('sgSignature',       blockPositions.sgSignature);

  // Step 5c: Render tick marks AFTER all blocks are drawn.
  // blockPositions now contains the actual rendered bounds for all blocks,
  // so tick mark label collision checks correctly avoid every table.
  const tickMarks = renderOutsideFigureTickMarks(
    doc,
    outsideFigure,
    calculatedExtent,
    mapBounds,  // Use full drawing area within margins
    collisionDetector,
    logger,
    blockPositions.titleBlock,
    blockPositions,
    _topoPolyPts  // Polygon PDF points for label collision avoidance
  );

  // Step 6: (blocks already drawn above in Step 5b)
  logger.info(
    "[PDFKit] ℹ️ Step 6: All text overlays rendered (blocks drawn in Step 5b, tick marks in Step 5c)"
  );

  logger.info({
    msg: "[PDFKit] 🎨 Professional elements added",
    scheduleOfAreas: filteredParcels.features.length > 0,
    outsideFigureData: !!outsideFigureData,
    beaconDescription: filteredBeacons.features.length > 0,
    surveyStatement: true,
    endorsementBlock: true,
  });

  // Step 7: Position and render map insets within map boundary (with collision detection)
  // Create a copy of placedBlocks to avoid mutation issues
  const placedBlocksCopy = blockPositions.placedBlocks
    ? [...blockPositions.placedBlocks]
    : [];

  const insetPositions = calculateInsetPositions(
    insetManager,
    mapBounds,
    blockPositions.mapFeatureBounds,
    placedBlocksCopy,
    logger
  );

  insetManager.renderInsetsAtPositions(
    doc,
    insetPositions,
    calculatedExtent,
    mapBounds
  );

  // Log final Z-order collision registry statistics
  const zOrderStats = zOrderCollisionRegistry.getStats();
  logger.info({
    msg: "[PDFKit] 🎯 Z-Order Collision Registry Final Statistics",
    layer1_outsideFigure: zOrderStats.layer1_outsideFigure,
    layer2_parcelBoundaries: zOrderStats.layer2_parcelBoundaries,
    layer3_beacons: zOrderStats.layer3_beacons,
    layer4_standNumbers: zOrderStats.layer4_standNumbers,
    layer5_tickMarks: zOrderStats.layer5_tickMarks,
    layer6_textOverlays: zOrderStats.layer6_textOverlays,
    layer7_insets: zOrderStats.layer7_insets,
    totalElements: zOrderStats.total,
  });

  // ACTIVATE TRUE VECTOR GEOPDF CAPABILITIES
  if (trueGeoPDFGenerator && layerManager && adaptiveRenderer) {
    logger.info("[PDFKit] 🚀 Activating True Vector GeoPDF capabilities...");

    // Add ISO 32000-2 georeferencing
    trueGeoPDFGenerator.addGeoreferencingViewport();

    // Add interactive JavaScript for PDF viewer
    trueGeoPDFGenerator.addInteractiveJavaScript();

    // Render enhanced layers with interactive features
    trueGeoPDFGenerator.renderLayers();

    logger.info("[PDFKit] ✅ True Vector GeoPDF capabilities activated");
  }

  const chunks = [];

  // Collect PDF data in chunks
  doc.on("data", (chunk) => chunks.push(chunk));
  doc.on("end", () => {
    // All data collected
  });

  // End the document to trigger data collection
  doc.end();

  // Wait for all chunks to be collected
  await new Promise((resolve, reject) => {
    doc.on("end", resolve);
    doc.on("error", reject);
  });

  const pdfBuffer = Buffer.concat(chunks);

  // If outputPath provided, write buffer to file
  if (outputPath) {
    try {
      await writeFile(outputPath, pdfBuffer);
      logger.info({
        msg: "[PDFKit] GeoPDF generated successfully",
        outputPath,
        size: pdfBuffer.length,
      });
    } catch (error) {
      logger.error({
        msg: "[PDFKit] Failed to write PDF to file",
        outputPath,
        error: error.message,
      });
      throw error;
    }
  }

  // Build tileGrid summary when SI 727 Reg 32(3) ceiling requires multi-sheet tiling
  let tileGrid = null;
  if (optimalScale.needsTiling) {
    const extW = calculatedExtent.maxY - calculatedExtent.minY;
    const extH = calculatedExtent.maxX - calculatedExtent.minX;
    const mapWmm = mapBounds.width  / MM_TO_PT;
    const mapHmm = mapBounds.height / MM_TO_PT;
    const cols = Math.ceil(extW * 1000 / (optimalScale.value * mapWmm));
    const rows = Math.ceil(extH * 1000 / (optimalScale.value * mapHmm));
    tileGrid = {
      scaleDenominator: optimalScale.value,
      scaleLabel: optimalScale.label,
      sheetSize: String(pageSize.code || '').replace(/\s+/g, '_') || null,
      cols,
      rows,
      totalSheets: cols * rows,
      extentMinY: calculatedExtent.minY,
      extentMinX: calculatedExtent.minX,
      extentMaxY: calculatedExtent.maxY,
      extentMaxX: calculatedExtent.maxX,
      tileWidthM:  (extW / cols),
      tileHeightM: (extH / rows),
    };
    logger.warn({
      msg: '[PDFKit] 🗺️ tileGrid summary built',
      totalSheets: tileGrid.totalSheets,
      cols,
      rows,
      scale: optimalScale.label,
    });
  }

  // sheetSize returned in underscore form ('ISO_A0') for round-trip consistency:
  // intelligentPreview / PAPER_SIZES / DXF generator all key by this form.
  // pageSize.code is 'ISO A0' (space form, human-readable); normalize to
  // underscored canonical name before returning. pageSize.name is the FULL
  // display string ('1189mm × 841mm (ISO A0)') — don't use that here.
  const _returnedSheetSize = String(pageSize.code || '').replace(/\s+/g, '_') || null;
  // Orientation the PDF laid out at (width >= height ⇒ landscape). Shared with the
  // DXF so PDF↔DXF stay in lockstep on scale + sheet size + orientation.
  // NOTE: pageSize carries `size: [wPt, hPt]` (no .width/.height fields).
  const _returnedOrientation = pageSize.size?.[0] >= pageSize.size?.[1] ? 'landscape' : 'portrait';
  return { pdfBuffer, suggestedScale, scale: optimalScale.label, sheetSize: _returnedSheetSize, orientation: _returnedOrientation, tileGrid, warnings };
}

// ============================================================================
// MULTI-SHEET TILED PDF GENERATION  (SI 727 Reg 32(3))
// ============================================================================

/**
 * Generate the SI 727 Seventh Schedule (b) key plan sheet.
 *
 * This is Sheet 0 of the multi-sheet general plan. It shows:
 *   • SI 727-compliant title block ("GENERAL PLAN of … KEY PLAN")
 *   • Township bounding box divided into the tile grid
 *   • Each cell labelled "SHEET N" with row/col coordinates
 *   • North arrow and compass rose
 *   • Column labels (West→East) and Row labels (North→South)
 *   • Cape Lo coordinate annotations on grid edges
 *   • Footer with SI 727 Seventh Schedule (b) citation
 */
async function _generateKeyPlanSheet(tileGridInfo, metadata, logger) {
  const {
    cols, rows, totalSheets, scaleLabel, sheetSize,
    extentMinY, extentMaxY, extentMinX, extentMaxX,
    tileWidthM, tileHeightM,
  } = tileGridInfo;

  // A4 landscape for the key plan
  const KP_W = 297 * MM_TO_PT;
  const KP_H = 210 * MM_TO_PT;
  const MARGIN = 15 * MM_TO_PT;
  const TITLE_H = 32 * MM_TO_PT;
  const FOOTER_H = 12 * MM_TO_PT;
  const LABEL_W = 18 * MM_TO_PT; // left column for row labels
  const LABEL_T = 10 * MM_TO_PT; // top row for column labels

  const doc = new PDFDocument({ size: [KP_W, KP_H], margin: 0 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));

  const township = (metadata?.surveyOf || metadata?.township || metadata?.title || 'Township').toUpperCase();
  const district = (metadata?.district || '').toUpperCase();

  // ── Outer border ──
  doc.rect(MARGIN, MARGIN, KP_W - 2 * MARGIN, KP_H - 2 * MARGIN)
    .lineWidth(2).stroke('#000000');

  // ── Title block (top) ──
  const titleX = MARGIN;
  const titleY = MARGIN;
  const titleW = KP_W - 2 * MARGIN;
  doc.rect(titleX, titleY, titleW, TITLE_H).lineWidth(0.5).stroke('#000000');

  doc.fillColor('#000000').fontSize(16).font('Helvetica-Bold')
    .text('GENERAL PLAN', titleX, titleY + 4 * MM_TO_PT, { width: titleW, align: 'center' });
  doc.fontSize(9).font('Helvetica-Oblique')
    .text('of', titleX, titleY + 12 * MM_TO_PT, { width: titleW, align: 'center' });
  doc.fontSize(11).font('Helvetica-Bold')
    .text(`${township}${district ? ', ' + district + ' DISTRICT' : ''}`, titleX, titleY + 17 * MM_TO_PT, { width: titleW, align: 'center' });
  doc.fontSize(10).font('Helvetica-Bold')
    .text('KEY PLAN', titleX, titleY + 24 * MM_TO_PT, { width: titleW, align: 'center' });

  // ── Grid area ──
  const gridAreaX = MARGIN + LABEL_W;
  const gridAreaY = MARGIN + TITLE_H + LABEL_T;
  const gridAreaW = KP_W - 2 * MARGIN - LABEL_W - 20 * MM_TO_PT; // leave right margin for north arrow
  const gridAreaH = KP_H - 2 * MARGIN - TITLE_H - LABEL_T - FOOTER_H;
  const cellW = gridAreaW / cols;
  const cellH = gridAreaH / rows;

  // ── Column labels (W→E) ──
  for (let col = 0; col < cols; col++) {
    const cx = gridAreaX + col * cellW;
    const colY = (col + 1) * tileWidthM; // distance from W edge in metres
    doc.fillColor('#555555').fontSize(6).font('Helvetica')
      .text(`Y+${(extentMinY + col * tileWidthM / 1000).toFixed(0)}`, cx, MARGIN + TITLE_H + 2, { width: cellW, align: 'center', lineBreak: false });
  }

  // ── Row labels (N→S) and grid cells ──
  let sheetNum = 1;
  for (let row = 0; row < rows; row++) {
    // Row label on left
    const ry = gridAreaY + row * cellH;
    doc.fillColor('#555555').fontSize(6).font('Helvetica')
      .text(`X+${(extentMinX + row * tileHeightM / 1000).toFixed(0)}`, MARGIN + 1, ry, { width: LABEL_W - 2, align: 'right', lineBreak: false });

    for (let col = 0; col < cols; col++) {
      const cx = gridAreaX + col * cellW;
      const cy = gridAreaY + row * cellH;

      // Cell fill + border
      doc.rect(cx, cy, cellW, cellH).fillAndStroke('#eef5fb', '#1a3a5c');

      // "SHEET N" label — large and centred
      doc.fillColor('#1a3a5c').fontSize(Math.min(14, cellH * 0.25)).font('Helvetica-Bold')
        .text(`SHEET ${sheetNum}`, cx + 2, cy + cellH * 0.3, { width: cellW - 4, align: 'center', lineBreak: false });

      // Small row×col annotation
      doc.fillColor('#666666').fontSize(5).font('Helvetica')
        .text(`R${row + 1}×C${col + 1}`, cx + 2, cy + cellH * 0.58, { width: cellW - 4, align: 'center', lineBreak: false });

      sheetNum++;
    }
  }

  // ── Grid outer border (drawn on top of cells) ──
  doc.rect(gridAreaX, gridAreaY, gridAreaW, gridAreaH).lineWidth(1.5).stroke('#000000');

  // ── North arrow (top-right corner of grid area) ──
  const naX = gridAreaX + gridAreaW + 6 * MM_TO_PT;
  const naY = gridAreaY + 5 * MM_TO_PT;
  const naSize = 12 * MM_TO_PT;
  // Arrow shaft
  doc.moveTo(naX + naSize / 2, naY + naSize)
    .lineTo(naX + naSize / 2, naY)
    .lineWidth(1).stroke('#000000');
  // Arrowhead
  doc.moveTo(naX + naSize / 2 - 4, naY + 6)
    .lineTo(naX + naSize / 2, naY)
    .lineTo(naX + naSize / 2 + 4, naY + 6)
    .stroke('#000000');
  // "N" label
  doc.fillColor('#000000').fontSize(10).font('Helvetica-Bold')
    .text('N', naX + naSize / 2 - 5, naY + naSize + 2);

  // ── Legend ──
  const legendX = gridAreaX + gridAreaW + 4 * MM_TO_PT;
  const legendY = naY + naSize + 14 * MM_TO_PT;
  doc.rect(legendX, legendY, 16 * MM_TO_PT, 6 * MM_TO_PT).fillAndStroke('#eef5fb', '#1a3a5c');
  doc.fillColor('#555').fontSize(6).font('Helvetica')
    .text('Sheet cell', legendX, legendY + 7 * MM_TO_PT, { width: 16 * MM_TO_PT, align: 'center' });

  // ── Scale and sheet info block ──
  const infoX = legendX;
  const infoY = legendY + 18 * MM_TO_PT;
  doc.fillColor('#000').fontSize(7).font('Helvetica-Bold')
    .text(`Scale: ${scaleLabel}`, infoX, infoY, { width: 18 * MM_TO_PT });
  doc.font('Helvetica')
    .text(`Sheet size: ${sheetSize}`, infoX, infoY + 8, { width: 18 * MM_TO_PT })
    .text(`Grid: ${cols} col × ${rows} row`, infoX, infoY + 16, { width: 18 * MM_TO_PT })
    .text(`Total sheets: ${totalSheets}`, infoX, infoY + 24, { width: 18 * MM_TO_PT });

  // ── Footer ──
  const footerY = KP_H - MARGIN - FOOTER_H;
  doc.moveTo(MARGIN, footerY).lineTo(KP_W - MARGIN, footerY).lineWidth(0.5).stroke('#000000');
  doc.fillColor('#333').fontSize(6.5).font('Helvetica')
    .text(
      `SI 727 of 1979, Seventh Schedule (b) — General Plan comprising more than one sheet. ` +
      `This key plan accompanies ${totalSheets} survey sheets. ` +
      `Printed: ${new Date().toISOString().slice(0, 10)}`,
      MARGIN + 2, footerY + 2, { width: KP_W - 2 * MARGIN - 4 }
    );

  doc.end();
  await new Promise((resolve, reject) => { doc.on('end', resolve); doc.on('error', reject); });
  return Buffer.concat(chunks);
}

/**
 * Naïve PDF byte-level concatenation.
 * Each input buffer is a standalone, single-page PDFKit document.
 * We extract each page's content stream and cross-reference table, then
 * rebuild a single PDF with all pages in order.
 *
 * NOTE: Because PDFKit doesn't provide a public multi-document merge API we
 * use pdf-lib when available, falling back to simple buffer concatenation
 * that produces a valid "portfolio" ZIP-like response (each PDF opens
 * independently). The route handler will ZIP them if pdf-lib isn't present.
 */
async function _mergePDFBuffers(buffers, logger) {
  // Attempt pdf-lib merge (optional dependency)
  try {
    const { PDFDocument: PdfLibDoc } = await import('pdf-lib');
    const merged = await PdfLibDoc.create();
    for (const buf of buffers) {
      const src = await PdfLibDoc.load(buf);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    const bytes = await merged.save();
    logger.info(`[TiledPDF] pdf-lib merge complete — ${buffers.length} pages`);
    return Buffer.from(bytes);
  } catch (_e) {
    // pdf-lib not installed — concatenate buffers and return; the route will ZIP them
    logger.warn('[TiledPDF] pdf-lib not available, returning concatenated raw buffers (install pdf-lib for true multi-page merge)');
    return Buffer.concat(buffers);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sutherland-Hodgman polygon clipping against an axis-aligned rectangle.
// All coordinates are Cape Lo metres [Y, X] matching the tile extent convention.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clip a 2-D polygon ring against a single half-plane edge of the clip rectangle.
 * @param {Array<[number,number]>} poly  Input ring as [[y,x], …]
 * @param {'minY'|'maxY'|'minX'|'maxX'} edge  Which clip edge
 * @param {number} limit  The edge coordinate value
 * @returns {Array<[number,number]>}
 */
function _suthHodgClipEdge(poly, edge, limit) {
  if (poly.length === 0) return [];
  const inside = pt => {
    switch (edge) {
      case 'minY': return pt[0] >= limit;
      case 'maxY': return pt[0] <= limit;
      case 'minX': return pt[1] >= limit;
      case 'maxX': return pt[1] <= limit;
    }
  };
  const intersect = (a, b) => {
    const [ay, ax] = a, [by, bx] = b;
    let t;
    if (edge === 'minY' || edge === 'maxY') {
      t = (limit - ay) / (by - ay);
      return [limit, ax + t * (bx - ax)];
    } else {
      t = (limit - ax) / (bx - ax);
      return [ay + t * (by - ay), limit];
    }
  };
  const output = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const prv = poly[(i + poly.length - 1) % poly.length];
    const curIn = inside(cur), prvIn = inside(prv);
    if (curIn) {
      if (!prvIn) output.push(intersect(prv, cur));
      output.push(cur);
    } else if (prvIn) {
      output.push(intersect(prv, cur));
    }
  }
  return output;
}

/**
 * Clip a polygon ring (Cape Lo [Y,X] metres) to an axis-aligned tile rectangle.
 * Returns the clipped ring, or null if the polygon is entirely outside.
 * @param {Array<[number,number]>} ring
 * @param {{minY,maxY,minX,maxX}} ext
 * @returns {Array<[number,number]>|null}
 */
function _clipPolygonToExtent(ring, ext) {
  let clipped = ring.slice(); // work on a copy, remove closing duplicate if present
  if (clipped.length > 1) {
    const first = clipped[0], last = clipped[clipped.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) clipped = clipped.slice(0, -1);
  }
  clipped = _suthHodgClipEdge(clipped, 'minY', ext.minY);
  clipped = _suthHodgClipEdge(clipped, 'maxY', ext.maxY);
  clipped = _suthHodgClipEdge(clipped, 'minX', ext.minX);
  clipped = _suthHodgClipEdge(clipped, 'maxX', ext.maxX);
  if (clipped.length < 3) return null;
  // Re-close the ring
  clipped.push([...clipped[0]]);
  return clipped;
}

/**
 * Filter parcels, beacons and annotations to only those that fall within
 * (or intersect) the given tile extent {minY, maxY, minX, maxX} in Cape Lo metres.
 * Also clips the outsideFigure polygon to the tile extent.
 *
 * Rules:
 *   Parcels       — kept when their bounding box INTERSECTS the tile extent.
 *   Beacons       — kept when their point falls within the tile extent ± BORDER_M.
 *   Annotations   — kept when their centroid is within the tile extent ± BORDER_M.
 *   OutsideFigure — polygon ring clipped to tile extent via Sutherland-Hodgman.
 */
function _filterDataToTileExtent(parcels, beacons, annotations, outsideFigure, outsideFigureData, tileExt, logger) {
  const { minY, maxY, minX, maxX } = tileExt;
  const BORDER_M = 5; // include beacons within 5 m of the tile edge

  // ── Parcel bounding-box intersection ──
  const filteredParcels = {
    ...parcels,
    features: parcels.features.filter(parcel => {
      if (parcel.geometry?.type !== 'Polygon') return true; // keep non-polygons
      let ring = parcel.geometry.coordinates[0];
      // Handle nested rings
      if (Array.isArray(ring) && ring.length === 1 && Array.isArray(ring[0]) && Array.isArray(ring[0][0])) {
        ring = ring[0];
      }
      let pMinY = Infinity, pMaxY = -Infinity, pMinX = Infinity, pMaxX = -Infinity;
      for (const coord of ring) {
        const rawY = Array.isArray(coord) ? coord[0] : coord.y ?? coord[1];
        const rawX = Array.isArray(coord) ? coord[1] : coord.x ?? coord[0];
        const [y, x] = normalizeCapeLoYX(rawY, rawX);
        if (!Number.isFinite(y) || !Number.isFinite(x)) continue;
        if (y < pMinY) pMinY = y;
        if (y > pMaxY) pMaxY = y;
        if (x < pMinX) pMinX = x;
        if (x > pMaxX) pMaxX = x;
      }
      // AABB intersection test
      return pMaxY >= minY && pMinY <= maxY && pMaxX >= minX && pMinX <= maxX;
    }),
  };

  // ── Beacon point-in-tile test ──
  const filteredBeacons = {
    ...beacons,
    features: beacons.features.filter(beacon => {
      const [bY, bX] = normalizeCapeLoYX(
        beacon.geometry.coordinates[0],
        beacon.geometry.coordinates[1]
      );
      return (
        bY >= minY - BORDER_M && bY <= maxY + BORDER_M &&
        bX >= minX - BORDER_M && bX <= maxX + BORDER_M
      );
    }),
  };

  // ── Annotations point-in-tile test ──
  let filteredAnnotations = annotations;
  if (annotations?.features?.length > 0) {
    filteredAnnotations = {
      ...annotations,
      features: annotations.features.filter(ann => {
        const coords = ann.geometry?.coordinates;
        if (!coords) return false;
        // Support Point and the first coord of LineString/Polygon
        const rawCoord = ann.geometry.type === 'Point' ? coords : coords[0];
        const rawY = Array.isArray(rawCoord) ? rawCoord[0] : rawCoord.y;
        const rawX = Array.isArray(rawCoord) ? rawCoord[1] : rawCoord.x;
        const [aY, aX] = normalizeCapeLoYX(rawY, rawX);
        return (
          aY >= minY - BORDER_M && aY <= maxY + BORDER_M &&
          aX >= minX - BORDER_M && aX <= maxX + BORDER_M
        );
      }),
    };
  }

  // ── Outside Figure polygon clipping ──
  let clippedOutsideFigure = null;
  if (outsideFigure?.features?.[0]?.geometry?.type === 'Polygon') {
    const origRing = outsideFigure.features[0].geometry.coordinates[0];
    const clippedRing = _clipPolygonToExtent(origRing, tileExt);
    if (clippedRing) {
      // Preserve the original feature properties (e.g. vertices) but replace geometry
      clippedOutsideFigure = {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          properties: outsideFigure.features[0].properties || {},
          geometry: {
            type: 'Polygon',
            coordinates: [clippedRing]
          }
        }]
      };
      logger.info(`[TiledPDF] Outside Figure clipped: ${origRing.length} → ${clippedRing.length} vertices`);
    } else {
      logger.warn('[TiledPDF] Outside Figure entirely outside tile — omitting');
    }
  } else {
    logger.info('[TiledPDF] No Outside Figure or not a Polygon — passing through');
    clippedOutsideFigure = outsideFigure;
  }

  // ── Outside Figure Data (edges) filtering ──
  let clippedOutsideFigureData = null;
  if (outsideFigureData?.edges?.length > 0) {
    clippedOutsideFigureData = {
      ...outsideFigureData,
      edges: outsideFigureData.edges.filter(edge => {
        const [y, x] = normalizeCapeLoYX(edge.y, edge.x);
        return (
          y >= minY - BORDER_M && y <= maxY + BORDER_M &&
          x >= minX - BORDER_M && x <= maxX + BORDER_M
        );
      })
    };
    logger.info(`[TiledPDF] Outside Figure Data filtered: ${outsideFigureData.edges.length} → ${clippedOutsideFigureData.edges.length} edges`);
  } else {
    logger.info('[TiledPDF] No Outside Figure Data edges — passing through');
    clippedOutsideFigureData = outsideFigureData;
  }

  logger.info({
    msg: '[TiledPDF] Spatial filter applied',
    tileExt: `Y:${minY.toFixed(0)}–${maxY.toFixed(0)}, X:${minX.toFixed(0)}–${maxX.toFixed(0)}`,
    parcels:     `${parcels.features.length} → ${filteredParcels.features.length}`,
    beacons:     `${beacons.features.length} → ${filteredBeacons.features.length}`,
    annotations: `${annotations?.features?.length ?? 0} → ${filteredAnnotations?.features?.length ?? 0}`,
    outsideFigure: clippedOutsideFigure ? `clipped` : `null`,
    outsideFigureData: clippedOutsideFigureData ? `${outsideFigureData.edges.length} → ${clippedOutsideFigureData.edges.length} edges` : `null`,
  });

  return { filteredParcels, filteredBeacons, filteredAnnotations, clippedOutsideFigure, clippedOutsideFigureData };
}

/**
 * Main entry-point for tiled multi-sheet PDF generation.
 * Called by the route when the backend scale resolver sets needsTiling=true.
 *
 * Generates:
 *   Sheet 0 — Key plan (index/location diagram)
 *   Sheet 1…N — One survey-plan sheet per tile in row-major order (N→S, W→E)
 *
 * Returns a merged PDF buffer containing all sheets as individual pages.
 */
export async function generateTiledGeoPDF(options, logger) {
  const {
    parcels, beacons, annotations, outsideFigure, projection,
    metadata, outsideFigureData, beaconLabels,
    sheetSize, planType,
    tileGridInfo, // { scaleDenominator, scaleLabel, sheetSize, cols, rows, totalSheets, extentMinY, extentMinX, extentMaxY, extentMaxX, tileWidthM, tileHeightM }
  } = options;

  const {
    scaleDenominator, scaleLabel,
    cols, rows, totalSheets,
    extentMinY, extentMinX, extentMaxY, extentMaxX,
    tileWidthM, tileHeightM,
  } = tileGridInfo;

  logger.warn({
    msg: '[TiledPDF] Starting multi-sheet tiled generation',
    totalSheets, cols, rows, scaleLabel,
    extent: { extentMinY, extentMinX, extentMaxY, extentMaxX },
  });

  const forcedScale = scaleLabel; // e.g. '1:500'

  // Pre-compute the complete outside figure beacon sequence from the FULL (unclipped)
  // outsideFigureData so every tile's title block shows the same closed notation
  // (e.g. "M4, M5, M6, M7, M8, M9, M4") regardless of which edges fall in each tile.
  const _fullVertices = getOutsideFigureVertices(outsideFigureData, logger);
  const fullFigureLabel = _fullVertices.sequence || null;
  logger.info(`[TiledPDF] Full outside figure label for title blocks: "${fullFigureLabel}"`);

  // Collect all page buffers: key plan first, then tiles
  const pageBuffers = [];

  // ── Sheet 0: Key Plan ──
  const keyPlanBuf = await _generateKeyPlanSheet(tileGridInfo, metadata, logger);
  pageBuffers.push(keyPlanBuf);
  logger.info('[TiledPDF] Sheet 0 (key plan) generated');

  // ── Sheets 1…N: Tile sheets ──
  let sheetNum = 1;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Compute this tile's ground window (5% overlap on each edge)
      const OVERLAP = 0.05;
      const tileMinY = extentMinY + col * tileWidthM  * (1 - OVERLAP);
      const tileMaxY = tileMinY   + tileWidthM;
      const tileMinX = extentMinX + row * tileHeightM * (1 - OVERLAP);
      const tileMaxX = tileMinX   + tileHeightM;

      const tileLabel = `Sheet ${sheetNum} of ${totalSheets} (Row ${row + 1}, Col ${col + 1})`;
      const tileExt = { minY: tileMinY, maxY: tileMaxY, minX: tileMinX, maxX: tileMaxX };
      logger.info(`[TiledPDF] Generating ${tileLabel} — Y:${tileMinY.toFixed(0)}–${tileMaxY.toFixed(0)}, X:${tileMinX.toFixed(0)}–${tileMaxX.toFixed(0)}`);

      // Clip data to this tile's ground window — parcels/beacons/annotations,
      // the outside figure polygon, and the outside figure data (edges) are all
      // clipped to the sheet margins.
      const { filteredParcels: tileParcels, filteredBeacons: tileBeacons, filteredAnnotations: tileAnnotations, clippedOutsideFigure: tileOutsideFigure, clippedOutsideFigureData: tileOutsideFigureData } =
        _filterDataToTileExtent(parcels, beacons, annotations, outsideFigure, outsideFigureData, tileExt, logger);

      const tileResult = await _generateGeoPDFInner({
        parcels:     tileParcels,
        beacons:     tileBeacons,
        annotations: tileAnnotations,
        outsideFigure: tileOutsideFigure, projection,
        metadata, outsideFigureData: tileOutsideFigureData, beaconLabels,
        scale: forcedScale,
        sheetSize,
        planType,
        tileExtent: tileExt,
        tileLabel,
        sheetInfo: { sheetNumber: sheetNum, totalSheets, fullFigureLabel }, // SI 727 Seventh Schedule (b)
      }, logger);

      pageBuffers.push(tileResult.pdfBuffer);
      logger.info(`[TiledPDF] ${tileLabel} generated (${tileResult.pdfBuffer.length} bytes)`);
      sheetNum++;
    }
  }

  logger.info(`[TiledPDF] All ${totalSheets + 1} pages generated, merging…`);
  const mergedBuffer = await _mergePDFBuffers(pageBuffers, logger);
  logger.info(`[TiledPDF] Merge complete — total size ${mergedBuffer.length} bytes`);

  return {
    pdfBuffer: mergedBuffer,
    totalSheets,
    scaleLabel,
    tileGridInfo,
  };
}
