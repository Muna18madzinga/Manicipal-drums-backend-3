/**
 * Dynamic Block Placement Engine for Survey Plan PDF
 *
 * Zone-constrained two-pass placement:
 *   Pass 1 — Scan the block's preferredZone (half-map region) only.
 *             Each block gets a DIFFERENT zone so they spread across the map.
 *   Pass 2 — Full-map fallback if the preferred zone has no valid slot.
 *
 * Scoring hierarchy within each scan pass (most to least important):
 *   1. Spread diversity  — 8-octant penalty forces blocks into different regions
 *   2. Polygon clearance — farther from survey figure = better
 *   3. Block separation  — maximize distance from already-placed blocks
 *   4. Strip alignment   — mild bonus for clear perimeter strips
 *   5. Edge snapping     — bonus for aligning with map boundary edges
 */

// rectangleOverlapsPolygon is passed in via params.rectangleOverlapsPolygon
// (it lives in pdfkitGeoPDF.js and is not exported from analyzeSafeAreas)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Grid step for slot scanning (points).  Smaller = more precise, slower. */
const GRID_STEP = 8;

/** Minimum clear gap between any two placed blocks (points). ~3mm visual separation. */
const BLOCK_GAP = 8;

/** Buffer added around the outside figure polygon when testing clearance. */
const POLY_BUFFER = 2;

/** Clearance buffer around each parcel line segment (points). Blocks must stay this far from any drawn line. */
const SEG_BUFFER = 8;

/**
 * Minimum inset from every mapBounds edge before a block may be placed.
 * Prevents blocks from sitting flush against the drawn margin line.
 * 14pt ≈ 5mm — enough visual breathing room without wasting space.
 */
const EDGE_PADDING = 14;


// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Place all blocks dynamically.
 *
 * @param {object} params
 * @param {object}   params.mapBounds          - Drawing area {x,y,width,height}
 * @param {object}   params.mapFeatureBounds   - Outside figure polygon bounds + pdfPoints
 * @param {object[]} params.blocks             - Array of block descriptors (see below)
 * @param {object[]} params.tickMarkBounds     - Reserved tick-mark regions
 * @param {object}   params.logger
 *
 * Block descriptor:
 *   { name, width, height, mandatory: boolean,
 *     preferredZone?: 'topLeft'|'topRight'|'bottomLeft'|'bottomRight'|'top'|'bottom'|'left'|'right' }
 *
 * preferredZone constrains the FIRST scan pass to that map region.
 * If no valid slot is found there, a full-map fallback pass runs.
 *
 * @returns {{ placements: object, unplaceable: string[], needsScaleUp: boolean }}
 *   placements  — map of name → {x,y,width,height}
 *   unplaceable — names of blocks that could not be placed collision-free
 *   needsScaleUp — true when any mandatory block is unplaceable
 */
export function placeBlocks({ mapBounds, mapFeatureBounds, blocks, tickMarkBounds = [], logger, rectangleOverlapsPolygon, preOccupied = [], parcelSegments = [] }) {
  // 1. Compute polygon geometry once
  const polyInfo = _computePolyInfo(mapBounds, mapFeatureBounds);

  // 2. Seed placedRects with any pre-occupied blocks (e.g. title block fixed at top).
  //    These are treated as immovable obstacles for all subsequent placements.
  const placedRects = [...preOccupied];   // [{x,y,width,height,name}]
  const placements  = {};
  const unplaceable = [];

  for (const block of blocks) {
    const result = _placeOneBlock({
      block,
      mapBounds,
      polyInfo,
      placedRects,
      tickMarkBounds,
      logger,
      rectangleOverlapsPolygon,
      parcelSegments,
    });

    if (result) {
      placements[block.name] = result;
      placedRects.push({ ...result, name: block.name });
      logger.info(`[Placement] ✅ ${block.name} → (${result.x.toFixed(0)},${result.y.toFixed(0)})`);
    } else {
      unplaceable.push(block.name);
      logger.warn(`[Placement] ⚠️  ${block.name} — no collision-free slot found`);
    }
  }

  const mandatoryUnplaceable = unplaceable.filter(
    n => blocks.find(b => b.name === n)?.mandatory !== false
  );

  // Log octant spread for diagnostics
  const mapCx = mapBounds.x + mapBounds.width  / 2;
  const mapCy = mapBounds.y + mapBounds.height / 2;
  const spreadLog = Object.entries(placements).map(([name, p]) => {
    const px = p.x + p.width  / 2;
    const py = p.y + p.height / 2;
    const qx = px < mapCx ? 'L' : 'R';
    const qy = py < mapCy ? 'T' : 'B';
    return `${name}:${qy}${qx}`;
  });
  logger.info(`[Placement] 📊 Octant spread: ${spreadLog.join(' | ')}`);

  return {
    placements,
    unplaceable,
    needsScaleUp: mandatoryUnplaceable.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute polygon bounding box and zone boundaries relative to mapBounds.
 */
function _computePolyInfo(mapBounds, mapFeatureBounds) {
  const hasPoly = mapFeatureBounds?.pdfPoints?.length > 0;
  const _emsg = `hasPoly=${hasPoly} pdfPoints=${mapFeatureBounds?.pdfPoints?.length ?? 'n/a'} keys=${Object.keys(mapFeatureBounds||{}).join(',')}`;
  console.error(`[ENGINE] _computePolyInfo ${_emsg}`);

  if (!hasPoly) {
    // No polygon — treat the whole drawing area as free
    return {
      hasPoly: false,
      minX: mapBounds.x,
      maxX: mapBounds.x + mapBounds.width,
      minY: mapBounds.y,
      maxY: mapBounds.y + mapBounds.height,
      cx: mapBounds.x + mapBounds.width  / 2,
      cy: mapBounds.y + mapBounds.height / 2,
      pdfPoints: [],
    };
  }

  const pts = mapFeatureBounds.pdfPoints;
  const minX = Math.min(...pts.map(p => p.x));
  const maxX = Math.max(...pts.map(p => p.x));
  const minY = Math.min(...pts.map(p => p.y));
  const maxY = Math.max(...pts.map(p => p.y));

  return {
    hasPoly: true,
    minX, maxX, minY, maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    pdfPoints: pts,
  };
}

/**
 * Compute the four perimeter strips around the polygon AABB.
 * Returns an array of {x,y,width,height} rectangles representing clear margins.
 * Blocks placed inside a strip are guaranteed to be outside the polygon zone.
 */
function _computeStrips(mapBounds, polyInfo) {
  const P  = EDGE_PADDING;
  const mx = mapBounds.x,  my = mapBounds.y;
  const mw = mapBounds.width, mh = mapBounds.height;

  if (!polyInfo.hasPoly) return [];

  const { minX, maxX, minY, maxY } = polyInfo;
  const buf = POLY_BUFFER;

  return [
    // Left strip: from map left edge to polygon left minus buffer
    { x: mx + P, y: my + P, width: Math.max(0, minX - buf - (mx + P)), height: mh - 2 * P, name: 'left' },
    // Right strip: from polygon right plus buffer to map right edge
    { x: maxX + buf, y: my + P, width: Math.max(0, (mx + mw - P) - (maxX + buf)), height: mh - 2 * P, name: 'right' },
    // Top strip: from map top to polygon top minus buffer
    { x: mx + P, y: my + P, width: mw - 2 * P, height: Math.max(0, minY - buf - (my + P)), name: 'top' },
    // Bottom strip: from polygon bottom plus buffer to map bottom
    { x: mx + P, y: maxY + buf, width: mw - 2 * P, height: Math.max(0, (my + mh - P) - (maxY + buf)), name: 'bottom' },
  ].filter(s => s.width > 0 && s.height > 0)
   .sort((a, b) => (b.width * b.height) - (a.width * a.height)); // largest strip first
}

/**
 * Spatial scoring — spread blocks across available white space.
 * Scoring hierarchy (weights calibrated so dominant concern always wins):
 *   1. Spread diversity   — 0–120 (DOMINANT: forces blocks into different map regions)
 *   2. Polygon clearance  — 0–80  (strong: stay away from survey figure)
 *   3. Block separation   — 0–60  (visual gap between blocks)
 *   4. Strip alignment    — +20   (mild bonus for clear perimeter strips)
 *   5. Edge alignment     — 0–10  (snap to margin edges for clean layout)
 *
 * The spread diversity score uses 8 octants (not 4 quadrants) for finer
 * granularity, and applies a hard penalty when an octant is already occupied.
 */
function _scoreSlot(rect, polyInfo, mapBounds, placedRects = [], strips = []) {
  const rx = rect.x + rect.width  / 2;
  const ry = rect.y + rect.height / 2;
  let score = 0;

  // --- 1. Spread diversity (0–120, DOMINANT) ---
  // Divide map into 8 octants and heavily penalise already-occupied ones.
  // This is the primary driver that forces blocks into different map regions.
  {
    const mapCx = mapBounds.x + mapBounds.width  / 2;
    const mapCy = mapBounds.y + mapBounds.height / 2;
    const mapW4 = mapBounds.width  / 4;
    const mapH4 = mapBounds.height / 4;

    // Octant: 0=TL-inner 1=TR-inner 2=BL-inner 3=BR-inner
    //         4=TL-outer 5=TR-outer 6=BL-outer 7=BR-outer
    const innerLeft  = rx < mapCx - mapW4;
    const innerRight = rx > mapCx + mapW4;
    const innerTop   = ry < mapCy - mapH4;
    const innerBot   = ry > mapCy + mapH4;
    const octX = rx < mapCx ? 0 : 1;
    const octY = ry < mapCy ? 0 : 2;
    const octDepth = (innerLeft || innerRight) && (innerTop || innerBot) ? 4 : 0;
    const octant = octX + octY + octDepth;

    const counts = new Array(8).fill(0);
    for (const p of placedRects) {
      const px = p.x + p.width  / 2;
      const py = p.y + p.height / 2;
      const pInnerLeft  = px < mapCx - mapW4;
      const pInnerRight = px > mapCx + mapW4;
      const pInnerTop   = py < mapCy - mapH4;
      const pInnerBot   = py > mapCy + mapH4;
      const pOctX  = px < mapCx ? 0 : 1;
      const pOctY  = py < mapCy ? 0 : 2;
      const pDepth = (pInnerLeft || pInnerRight) && (pInnerTop || pInnerBot) ? 4 : 0;
      counts[pOctX + pOctY + pDepth]++;
    }

    const occupied = counts[octant];
    if (occupied === 0) {
      score += 120; // unoccupied octant — maximum bonus
    } else {
      score += Math.max(0, 120 - occupied * 60); // heavy penalty per block in same octant
    }
  }

  // --- 2. Polygon clearance (0–80) ---
  if (polyInfo.hasPoly) {
    const outsideX = rx < polyInfo.minX ? polyInfo.minX - rx : rx > polyInfo.maxX ? rx - polyInfo.maxX : 0;
    const outsideY = ry < polyInfo.minY ? polyInfo.minY - ry : ry > polyInfo.maxY ? ry - polyInfo.maxY : 0;
    const polyDist = Math.sqrt(outsideX * outsideX + outsideY * outsideY);
    score += Math.min(80, polyDist * 0.4);
  }

  // --- 3. Block separation (0–60) ---
  if (placedRects.length > 0) {
    let minDist = Infinity;
    for (const p of placedRects) {
      const dx = Math.max(0, Math.max(p.x - (rect.x + rect.width), rect.x - (p.x + p.width)));
      const dy = Math.max(0, Math.max(p.y - (rect.y + rect.height), rect.y - (p.y + p.height)));
      const d  = Math.sqrt(dx * dx + dy * dy);
      if (d < minDist) minDist = d;
    }
    score += Math.min(60, minDist * 0.3);
  } else {
    score += 30; // first block baseline
  }

  // --- 4. Strip alignment bonus (+20) ---
  // Mild bonus — strip preference must not override spread diversity
  const inStrip = strips.some(s =>
    rx >= s.x && rx <= s.x + s.width &&
    ry >= s.y && ry <= s.y + s.height
  );
  if (inStrip) score += 20;

  // --- 5. Edge alignment snap bonus (0–10) ---
  {
    const L    = mapBounds.x + EDGE_PADDING;
    const R    = mapBounds.x + mapBounds.width  - EDGE_PADDING;
    const T    = mapBounds.y + EDGE_PADDING;
    const B    = mapBounds.y + mapBounds.height - EDGE_PADDING;
    const SNAP = GRID_STEP * 2;
    if (Math.abs(rect.x - L) < SNAP || Math.abs(rect.x + rect.width  - R) < SNAP) score += 5;
    if (Math.abs(rect.y - T) < SNAP || Math.abs(rect.y + rect.height - B) < SNAP) score += 5;
  }

  return score;
}

/**
 * Check whether a rectangle is fully inside mapBounds.
 */
function _withinBounds(rect, mapBounds) {
  return (
    rect.x >= mapBounds.x &&
    rect.y >= mapBounds.y &&
    rect.x + rect.width  <= mapBounds.x + mapBounds.width &&
    rect.y + rect.height <= mapBounds.y + mapBounds.height
  );
}

/**
 * Check whether a rectangle overlaps any already-placed block.
 */
function _overlapsPlaced(rect, placedRects) {
  return placedRects.some(p => {
    return !(
      rect.x + rect.width  + BLOCK_GAP <= p.x ||
      p.x + p.width  + BLOCK_GAP <= rect.x ||
      rect.y + rect.height + BLOCK_GAP <= p.y ||
      p.y + p.height + BLOCK_GAP <= rect.y
    );
  });
}

/**
 * Check whether a rectangle overlaps any tick-mark region.
 */
function _overlapsTickMarks(rect, tickMarkBounds) {
  if (!tickMarkBounds?.length) return false;
  const GAP = 15;
  return tickMarkBounds.some(t => !(
    rect.x + rect.width  + GAP <= t.x ||
    t.x + t.width  + GAP <= rect.x ||
    rect.y + rect.height + GAP <= t.y ||
    t.y + t.height + GAP <= rect.y
  ));
}

/**
 * Compute scan bounds for a named preferred zone within mapBounds.
 * Returns {minX, minY, maxX, maxY} clamped to valid scan range.
 */
function _zoneBounds(zone, mapBounds, width, height) {
  const P  = EDGE_PADDING;
  const mx = mapBounds.x,  my = mapBounds.y;
  const mw = mapBounds.width, mh = mapBounds.height;
  const cx = mx + mw / 2,  cy = my + mh / 2;

  // Each zone covers half the map in one or both axes
  const zones = {
    topLeft:     { x1: mx + P,  y1: my + P,  x2: cx,       y2: cy       },
    topRight:    { x1: cx,      y1: my + P,  x2: mx+mw-P,  y2: cy       },
    bottomLeft:  { x1: mx + P,  y1: cy,      x2: cx,       y2: my+mh-P  },
    bottomRight: { x1: cx,      y1: cy,      x2: mx+mw-P,  y2: my+mh-P  },
    top:         { x1: mx + P,  y1: my + P,  x2: mx+mw-P,  y2: cy       },
    bottom:      { x1: mx + P,  y1: cy,      x2: mx+mw-P,  y2: my+mh-P  },
    left:        { x1: mx + P,  y1: my + P,  x2: cx,       y2: my+mh-P  },
    right:       { x1: cx,      y1: my + P,  x2: mx+mw-P,  y2: my+mh-P  },
  };

  const z = zones[zone];
  if (!z) return null;
  return {
    minX: z.x1,
    minY: z.y1,
    maxX: z.x2 - width,
    maxY: z.y2 - height,
  };
}

/**
 * Returns minimum distance from any parcel segment to the rect boundary.
 * Returns a large value when segments array is empty.
 * Used to score slots by segment clearance (topology bonus).
 */
function _minSegmentClearance(rect, segments) {
  if (!segments || segments.length === 0) return 9999;
  const rx1 = rect.x, ry1 = rect.y;
  const rx2 = rect.x + rect.width, ry2 = rect.y + rect.height;
  // Point-to-segment distance helper
  const _ptSegDist = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-10) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  // Test 4 rect corners against each segment
  const corners = [[rx1, ry1], [rx2, ry1], [rx2, ry2], [rx1, ry2]];
  let minDist = 9999;
  for (const s of segments) {
    for (const [cx, cy] of corners) {
      const d = _ptSegDist(cx, cy, s.x1, s.y1, s.x2, s.y2);
      if (d < minDist) minDist = d;
    }
  }
  return minDist;
}

/**
 * Check whether a rectangle (expanded by SEG_BUFFER) intersects any parcel line segment.
 * Uses AABB pre-filter then segment-vs-rect edge intersection.
 */
function _rectIntersectsSegments(rect, segments) {
  if (!segments || segments.length === 0) return false;
  const ex = rect.x - SEG_BUFFER;
  const ey = rect.y - SEG_BUFFER;
  const ew = rect.width  + 2 * SEG_BUFFER;
  const eh = rect.height + 2 * SEG_BUFFER;
  const rx1 = ex, ry1 = ey, rx2 = ex + ew, ry2 = ey + eh;

  for (const s of segments) {
    // AABB pre-filter
    if (Math.min(s.x1, s.x2) > rx2 || Math.max(s.x1, s.x2) < rx1) continue;
    if (Math.min(s.y1, s.y2) > ry2 || Math.max(s.y1, s.y2) < ry1) continue;
    // Check if either endpoint is inside expanded rect
    if (s.x1 >= rx1 && s.x1 <= rx2 && s.y1 >= ry1 && s.y1 <= ry2) return true;
    if (s.x2 >= rx1 && s.x2 <= rx2 && s.y2 >= ry1 && s.y2 <= ry2) return true;
    // Check if segment crosses any of the 4 rect edges
    if (_segmentsIntersect(s.x1, s.y1, s.x2, s.y2, rx1, ry1, rx2, ry1)) return true;
    if (_segmentsIntersect(s.x1, s.y1, s.x2, s.y2, rx2, ry1, rx2, ry2)) return true;
    if (_segmentsIntersect(s.x1, s.y1, s.x2, s.y2, rx2, ry2, rx1, ry2)) return true;
    if (_segmentsIntersect(s.x1, s.y1, s.x2, s.y2, rx1, ry2, rx1, ry1)) return true;
  }
  return false;
}

/** 2D segment-segment intersection test. */
function _segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1x = bx - ax, d1y = by - ay;
  const d2x = dx - cx, d2y = dy - cy;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-10) return false; // parallel
  const t = ((cx - ax) * d2y - (cy - ay) * d2x) / cross;
  const u = ((cx - ax) * d1y - (cy - ay) * d1x) / cross;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * Scan a rectangular region for the best collision-free slot.
 * Returns the best {x,y,width,height} found, or null.
 */
function _scanRegion({ minX, minY, maxX, maxY, width, height, mapBounds, polyInfo, placedRects, tickMarkBounds, strips, rectangleOverlapsPolygon, parcelSegments }) {
  if (maxX < minX || maxY < minY) return null;

  let bestScore = -Infinity;
  let bestSlot  = null;

  for (let y = minY; y <= maxY + 0.5; y += GRID_STEP) {
    const cy = Math.min(y, maxY);
    for (let x = minX; x <= maxX + 0.5; x += GRID_STEP) {
      const cx   = Math.min(x, maxX);
      const rect = { x: cx, y: cy, width, height };

      if (!_withinBounds(rect, mapBounds)) continue;
      if (polyInfo.hasPoly && rectangleOverlapsPolygon(rect, polyInfo.pdfPoints, POLY_BUFFER)) continue;
      if (_overlapsPlaced(rect, placedRects)) continue;
      if (_overlapsTickMarks(rect, tickMarkBounds)) continue;

      // Score slot — includes segment-clearance bonus
      const baseScore = _scoreSlot(rect, polyInfo, mapBounds, placedRects, strips);
      // Topology bonus: prefer slots far from all parcel line segments
      const segClearance = _minSegmentClearance(rect, parcelSegments);
      const topoBonus = segClearance * 0.5; // 0.5pt bonus per pt of clearance
      const score = baseScore + topoBonus;
      if (score > bestScore) {
        bestScore = score;
        bestSlot  = { x: cx, y: cy, width, height };
      }
    }
  }

  return bestSlot;
}

/**
 * Find the best placement slot for a single block.
 *
 * Strategy (two-pass zone-constrained):
 *   Pass 1 — If block has a preferredZone, scan ONLY that zone.
 *             This guarantees blocks land in different map regions.
 *   Pass 2 — Full-map fallback scan if preferred zone yielded nothing.
 */
function _placeOneBlock({ block, mapBounds, polyInfo, placedRects, tickMarkBounds, logger, rectangleOverlapsPolygon, parcelSegments }) {
  const { width, height, preferredZone } = block;
  const strips = _computeStrips(mapBounds, polyInfo);

  const fullScan = {
    minX: mapBounds.x + EDGE_PADDING,
    minY: mapBounds.y + EDGE_PADDING,
    maxX: mapBounds.x + mapBounds.width  - width  - EDGE_PADDING,
    maxY: mapBounds.y + mapBounds.height - height - EDGE_PADDING,
  };

  const scanArgs = { width, height, mapBounds, polyInfo, placedRects, tickMarkBounds, strips, rectangleOverlapsPolygon, parcelSegments };

  // Pass 1: preferred zone scan
  if (preferredZone) {
    const zb = _zoneBounds(preferredZone, mapBounds, width, height);
    if (zb && zb.maxX >= zb.minX && zb.maxY >= zb.minY) {
      const result = _scanRegion({ ...scanArgs, ...zb });
      if (result) {
        logger.info(`[Placement] 🎯 ${block.name} placed in preferred zone '${preferredZone}'`);
        return result;
      }
      logger.warn(`[Placement] ⚠️  ${block.name} preferred zone '${preferredZone}' had no valid slot — falling back to full map`);
    }
  }

  // Pass 2: full-map fallback
  return _scanRegion({ ...scanArgs, ...fullScan });
}
