import { findPoleOfInaccessibility } from '../utils/labelPlacer.js';

/**
 * Unified Labeling System - Single Source of Truth
 *
 * Consolidates all labeling logic for:
 * - Edge labels (distance + direction) with topology-aware split labeling,
 *   splay detection, ground-clearance offsets, collision-aware placement,
 *   parcel-boundary containment, and second-pass bearing rendering
 * - Stand/parcel number labels (deferred after edge labels)
 */

// ─── HELPER FUNCTIONS ────────────────────────────────────────────────────────

function transformCoords(y, x, extent, pdfBounds) {
  const easting = -y;
  const northing = -x;
  const xRatio = (easting - extent.minY) / (extent.maxY - extent.minY);
  const yRatio = (northing - extent.minX) / (extent.maxX - extent.minX);
  return {
    x: pdfBounds.x + xRatio * pdfBounds.width,
    y: pdfBounds.y + pdfBounds.height - yRatio * pdfBounds.height,
  };
}

function isPointInPolygonSimple(point, polygon) {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Returns true if ALL four corners of a rotated label bounding box lie inside
 * the polygon. The label is centred at (cx, cy), has half-extents (hw, hh) in
 * the label's local frame, and is rotated by `angleDeg` degrees.
 * shrink: inset each half-extent by this many points before testing (default 0).
 */
function isLabelBboxInsidePolygon(cx, cy, hw, hh, angleDeg, polygon, shrink = 0) {
  const rad = (angleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const shw = Math.max(0, hw - shrink);
  const shh = Math.max(0, hh - shrink);
  const corners = [
    [-shw, -shh], [ shw, -shh], [ shw,  shh], [-shw,  shh],
  ];
  for (const [lx, ly] of corners) {
    const wx = cx + lx * cosA - ly * sinA;
    const wy = cy + lx * sinA + ly * cosA;
    if (!isPointInPolygonSimple([wx, wy], polygon)) return false;
  }
  return true;
}

function createEdgeKey(coord1, coord2) {
  const y1 = Math.round(coord1[0] * 100) / 100;
  const x1 = Math.round(coord1[1] * 100) / 100;
  const y2 = Math.round(coord2[0] * 100) / 100;
  const x2 = Math.round(coord2[1] * 100) / 100;
  const pts = [[y1, x1], [y2, x2]].sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);
  return `${pts[0][0]},${pts[0][1]}_${pts[1][0]},${pts[1][1]}`;
}

function analyzeParcelGeom(pdfCoords) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  pdfCoords.forEach((p) => {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  });
  const width = maxX - minX;
  const height = maxY - minY;
  const minDim = Math.min(width, height);
  const aspectRatio = Math.max(width, height) / Math.max(minDim, 0.001);
  const isNarrow = aspectRatio > 2.5;
  const isVeryNarrow = aspectRatio > 4;
  const isExtremelyNarrow = aspectRatio > 6;
  const maxStandFont = minDim * 0.6;
  let standFontSize, edgeFontSize;
  if (isExtremelyNarrow || minDim < 15) {
    standFontSize = Math.max(7, Math.min(8, maxStandFont)); edgeFontSize = 7;
  } else if (isVeryNarrow || minDim < 25) {
    standFontSize = Math.max(8, Math.min(9, maxStandFont)); edgeFontSize = 7;
  } else if (isNarrow || minDim < 40) {
    standFontSize = Math.max(9, Math.min(10, maxStandFont)); edgeFontSize = 8;
  } else {
    standFontSize = 11; edgeFontSize = 9;
  }
  const n = pdfCoords.length - 1;
  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) { sumX += pdfCoords[i].x; sumY += pdfCoords[i].y; }
  const centroid = { x: sumX / n, y: sumY / n };
  return { width, height, minDim, aspectRatio, isNarrow, isVeryNarrow, isExtremelyNarrow, standFontSize, edgeFontSize, centroid };
}

// ─── LABELING SYSTEM CLASS ────────────────────────────────────────────────────

class LabelingSystem {
  constructor(doc, extent, mapBounds, scale, collisionDetector, logger, planType = 'general-undeveloped') {
    this.doc = doc;
    this.extent = extent;
    this.mapBounds = mapBounds;
    this.scale = scale;
    this.collisionDetector = collisionDetector;
    this.logger = logger;
    this.planType = planType;
    // Topology tracking
    this.labeledEdges = new Map();  // edgeKey → label info for second-pass
    this.sharedEdges = new Set();   // edgeKeys shared across >1 parcel
    this.edgeOccurrences = new Map();
    // Label crowding tracking — counts edges where collision-free placement failed
    this.labelCollisions = 0;
  }

  // ── Scale-based font limits (field-readable: min 8pt for any text) ──────────
  _scaleBasedFonts() {
    const sv = Number(this.scale?.value) || 1000;
    if (sv <= 500)  return { dist: 8, bearing: 8 };
    if (sv <= 1000) return { dist: 8, bearing: 8 };
    if (sv <= 2000) return { dist: 9, bearing: 8 };
    return { dist: 10, bearing: 9 };
  }

  // ── Fixed 3mm offset from the edge line at print scale ──────────────────────
  _groundClearanceOffset() {
    return 3 / 0.352778; // 3mm → pt ≈ 8.504pt
  }

  // ── Splay-vertex detection ───────────────────────────────────────────────────
  _detectSplay(edges, vertexCount) {
    const dists = edges
      .slice(0, vertexCount)
      .map((e) => (typeof e?.distance === 'number' ? e.distance : parseFloat(e?.distance) || 0))
      .filter((d) => d > 0)
      .sort((a, b) => a - b);
    const median = dists.length ? dists[Math.floor(dists.length / 2)] : 0;
    const threshold = Math.min(10, Math.max(6, median > 0 ? median * 0.45 : 8));
    const splayVertex = new Array(vertexCount).fill(false);
    if (vertexCount >= 3 && edges.length >= vertexCount) {
      for (let v = 0; v < vertexCount; v++) {
        const prev = edges[(v - 1 + vertexCount) % vertexCount];
        const next = edges[v];
        const pd = typeof prev?.distance === 'number' ? prev.distance : parseFloat(prev?.distance) || 0;
        const nd = typeof next?.distance === 'number' ? next.distance : parseFloat(next?.distance) || 0;
        if (pd > 0 && nd > 0 && pd < threshold && nd < threshold) splayVertex[v] = true;
      }
    }
    return { splayVertex, threshold };
  }

  // ── Shared-edge identification ───────────────────────────────────────────────
  identifySharedEdges(parcels, outsideFigureBoundary = null) {
    // Build exclusion set from Outside Figure boundary edges
    const ofEdgeKeys = new Set();
    if (outsideFigureBoundary && Array.isArray(outsideFigureBoundary) && outsideFigureBoundary.length >= 3) {
      for (let i = 0; i < outsideFigureBoundary.length - 1; i++) {
        ofEdgeKeys.add(createEdgeKey(outsideFigureBoundary[i], outsideFigureBoundary[i + 1]));
      }
      this.logger.info(`[Labeling] Outside Figure has ${ofEdgeKeys.size} boundary edges (excluded from shared detection)`);
    }

    this.edgeOccurrences.clear();
    parcels.features.forEach((parcel) => {
      let coords = parcel.geometry?.coordinates?.[0];
      if (!Array.isArray(coords)) return;
      // Guard: unwrap double-nested [[ring]] → [ring]
      if (coords.length === 1 && Array.isArray(coords[0]) && Array.isArray(coords[0][0])) coords = coords[0];
      for (let i = 0; i < coords.length - 1; i++) {
        const key = createEdgeKey(coords[i], coords[i + 1]);
        // Skip edges that lie on the Outside Figure boundary
        if (ofEdgeKeys.has(key)) continue;
        this.edgeOccurrences.set(key, (this.edgeOccurrences.get(key) || 0) + 1);
      }
    });
    this.sharedEdges.clear();
    this.edgeOccurrences.forEach((count, key) => { if (count > 1) this.sharedEdges.add(key); });
    this.logger.info(`[Labeling] Shared edges: ${this.sharedEdges.size} (after excluding Outside Figure)`);
  }
  
  // ── Collision-aware candidate placement (polygon-contained, full bbox check) ──
  // Two-tier: Tier 1 = midpoint at all font sizes, Tier 2 = small along-edge shifts.
  // A candidate is accepted only when ALL four rotated bbox corners lie inside the polygon.
  _placeLabel(text, baseOffset, pdfCoords, midX, midY, perpX, perpY, angle, fontSize, minFontSize, pg, hasSplayTouch, isDirection, edgeLenPt, minOffset = 0) {
    if (!text) return null;
    const polygon = pdfCoords.map((p) => [p.x, p.y]);
    const fontSizes = [];
    for (let fs = fontSize; fs >= 7; fs -= 0.5) fontSizes.push(fs);
    if (fontSizes[fontSizes.length - 1] > 7) fontSizes.push(7);
    const mults = isDirection ? [1.0, 1.05, 1.1, 1.15, 1.2, 1.3] : [1.0, 0.95, 1.05, 0.9, 1.1, 0.85, 1.2];
    const buf = hasSplayTouch && !isDirection ? 4 : 3;
    const tanX = -perpY, tanY = perpX;

    const _tryAt = (sx, sy, fs) => {
      const lw = this.doc.widthOfString(text, { font: 'Helvetica', size: fs });
      const hw = lw / 2;
      const hh = fs / 2;
      for (const mult of mults) {
        const offset = Math.max(minOffset, baseOffset * mult);
        const lx = sx + perpX * offset;
        const ly = sy + perpY * offset;
        // Full bbox containment: all four corners must be inside the polygon
        if (!isLabelBboxInsidePolygon(lx, ly, hw, hh, angle, polygon)) continue;
        if (!this.collisionDetector.hasCollision(lx - hw, ly - hh, lw, fs, buf)) {
          return { x: lx, y: ly, fontSize: fs, offset, width: lw };
        }
      }
      return null;
    };

    // Tier 1: exhaust all font sizes at midpoint (most aesthetic)
    for (const fs of fontSizes) {
      const r = _tryAt(midX, midY, fs);
      if (r) return r;
    }
    // Tier 2: small along-edge nudges (±4, ±8, ±12pt) at all font sizes
    const smallShifts = [4, -4, 8, -8, 12, -12];
    for (const fs of fontSizes) {
      for (const shift of smallShifts) {
        const r = _tryAt(midX + tanX * shift, midY + tanY * shift, fs);
        if (r) return r;
      }
    }
    // Tier 3: centroid direction — for narrow parcels where perp push exits polygon
    const toCxL = pg.centroid.x - midX, toCyL = pg.centroid.y - midY;
    const cLenL = Math.sqrt(toCxL * toCxL + toCyL * toCyL) || 1;
    const cDirXL = toCxL / cLenL, cDirYL = toCyL / cLenL;
    const centOffsets = [4, 8, 12, 16, 20, 28, 36].map(d => Math.min(d, cLenL * 0.9));
    for (const fs of fontSizes) {
      const lw = this.doc.widthOfString(text, { font: 'Helvetica', size: fs });
      const hw = lw / 2;
      const hh = fs / 2;
      for (const cd of centOffsets) {
        const lx = midX + cDirXL * cd;
        const ly = midY + cDirYL * cd;
        if (!isLabelBboxInsidePolygon(lx, ly, hw, hh, angle, polygon)) continue;
        if (!this.collisionDetector.hasCollision(lx - hw, ly - hh, lw, fs, buf)) {
          return { x: lx, y: ly, fontSize: fs, offset: cd, width: lw };
        }
      }
    }
    return null;
  }

  // ── Force-place inside polygon (full bbox preferred, centre-inside fallback) ──
  // startFs: starting font size for the sweep (pass distFontSize or dirFontSize).
  // Searches perpendicular direction AND toward-centroid direction so narrow parcels
  // where the perpendicular push exits the polygon can still find a valid position.
  _forcePlaceInsidePolygon(text, baseOffset, pdfCoords, midX, midY, perpX, perpY, angle, pg, edgeLenPt, isDirection = false, minOffset = 0, startFs = 9) {
    if (!text) return null;
    const polygon = pdfCoords.map((p) => [p.x, p.y]);
    const tanX = -perpY, tanY = perpX;
    const shifts = [0, 4, -4, 8, -8, 12, -12, 16, -16];
    const perpMults = isDirection
      ? [1.0, 1.1, 1.2, 1.3, 1.5, 1.7, 2.0, 2.5]
      : [1.0, 0.9, 1.1, 0.8, 1.2, 0.7, 1.4, 0.6, 1.6, 0.5, 2.0];

    // Centroid direction — used when perpendicular push exits polygon (narrow parcels)
    const toCx = pg.centroid.x - midX, toCy = pg.centroid.y - midY;
    const cLen = Math.sqrt(toCx * toCx + toCy * toCy) || 1;
    const cDirX = toCx / cLen, cDirY = toCy / cLen;
    // Sample offsets along centroid direction: 0 → 90% of centroid distance (deduplicated)
    const _rawCentOffsets = [0, 2, 4, 6, 8, 10, 12, 16, 20, 28, 36, 48].map(d => Math.min(d, cLen * 0.9));
    const centOffsets = [...new Set(_rawCentOffsets)];

    let firstBboxInsideFallback = null;
    let firstCentreInsideFallback = null;

    const _test = (lx, ly, hw, hh, fs, lw) => {
      const bboxOk = isLabelBboxInsidePolygon(lx, ly, hw, hh, angle, polygon);
      const centreOk = bboxOk || isPointInPolygonSimple([lx, ly], polygon);
      if (!centreOk) return false;
      if (bboxOk && !firstBboxInsideFallback) {
        firstBboxInsideFallback = { x: lx, y: ly, fontSize: fs, offset: 0, width: lw };
      }
      if (!firstCentreInsideFallback) {
        firstCentreInsideFallback = { x: lx, y: ly, fontSize: fs, offset: 0, width: lw };
      }
      return true;
    };

    // Full font-size sweep (largest → smallest)
    for (let fs = Math.max(7, startFs); fs >= 7; fs -= 0.5) {
      const lw = this.doc.widthOfString(text, { font: 'Helvetica', size: fs });
      const hw = lw / 2;
      const hh = fs / 2;

      // Pass A: perpendicular direction (standard placement)
      for (const shift of shifts) {
        const sx = midX + tanX * shift;
        const sy = midY + tanY * shift;
        for (const mult of perpMults) {
          const offset = Math.max(minOffset, baseOffset * mult);
          const lx = sx + perpX * offset;
          const ly = sy + perpY * offset;
          if (!_test(lx, ly, hw, hh, fs, lw)) continue;
          const bboxOk = isLabelBboxInsidePolygon(lx, ly, hw, hh, angle, polygon);
          if (bboxOk && !this.collisionDetector.hasCollision(lx - hw, ly - hh, lw, fs, 1)) {
            return { x: lx, y: ly, fontSize: fs, offset, width: lw };
          }
        }
      }

      // Pass B: centroid direction (for narrow parcels where perp push exits polygon)
      for (const shift of shifts) {
        const sx = midX + tanX * shift;
        const sy = midY + tanY * shift;
        for (const cd of centOffsets) {
          const lx = sx + cDirX * cd;
          const ly = sy + cDirY * cd;
          if (!_test(lx, ly, hw, hh, fs, lw)) continue;
          const bboxOk = isLabelBboxInsidePolygon(lx, ly, hw, hh, angle, polygon);
          if (bboxOk && !this.collisionDetector.hasCollision(lx - hw, ly - hh, lw, fs, 1)) {
            return { x: lx, y: ly, fontSize: fs, offset: cd, width: lw };
          }
        }
      }
    }

    // Pass 2: bbox fully inside but collision tolerated
    if (firstBboxInsideFallback) {
      this.labelCollisions++;
      return firstBboxInsideFallback;
    }
    // Pass 3: centre inside only (label may clip boundary slightly)
    if (firstCentreInsideFallback) {
      this.labelCollisions++;
      return firstCentreInsideFallback;
    }
    // Absolute last resort: place at centroid — label will render even if partially outside
    this.labelCollisions++;
    const lw = this.doc.widthOfString(text, { font: 'Helvetica', size: 7 });
    this.logger.warn(`[Labeling] FORCE-FALLBACK centroid for "${text}" midX=${midX.toFixed(1)} midY=${midY.toFixed(1)}`);
    return { x: pg.centroid.x, y: pg.centroid.y, fontSize: 7, offset: 0, width: lw };
  }

  // ── Draw one edge label and register collision region ─────────────────────────
  _renderEdgeLabelAt(text, pos, fontSize, angle, hasSplayTouch, isDirection) {
    if (!text || !pos) return;
    const lw = pos.width;
    const pad = 1.25;
    this.doc.save();
    this.doc.translate(pos.x, pos.y).rotate(angle, { origin: [0, 0] });
    this.doc.fontSize(fontSize).font('Helvetica')
      .fillColor('#000000')
      .text(text, -lw / 2, -fontSize / 2, { lineBreak: false });
    this.doc.restore();
    const angleRad = (angle * Math.PI) / 180;
    const cos = Math.abs(Math.cos(angleRad));
    const sin = Math.abs(Math.sin(angleRad));
    const pw = lw + pad * 2;
    const ph = fontSize + pad * 2;
    const rw = pw * cos + ph * sin;
    const rh = pw * sin + ph * cos;
    const buf = hasSplayTouch && !isDirection ? 5 : 4;
    this.collisionDetector.addRegion(pos.x - rw / 2 - buf, pos.y - rh / 2 - buf, rw + buf * 2, rh + buf * 2, 1);
  }

  // ── Main edge-label renderer for one parcel ───────────────────────────────────
  // pdfCoords must be pre-computed by the caller using the correct transformCoords
  renderEdgeLabels(parcel, pdfCoords) {
    // Guard: unwrap double-nested coordinates [[ring]] → [ring]
    let coords = parcel.geometry.coordinates[0];
    if (Array.isArray(coords) && coords.length === 1 && Array.isArray(coords[0]) && Array.isArray(coords[0][0])) {
      coords = coords[0];
    }
    const props = parcel.properties;
    const edges = props.edges;
    if (!edges || !Array.isArray(edges)) return { totalEdges: 0, labeled: 0, skipped: 0 };
    if (!Array.isArray(pdfCoords) || pdfCoords.length < 3) return { totalEdges: 0, labeled: 0, skipped: 0 };

    const pg = analyzeParcelGeom(pdfCoords);
    const sf = this._scaleBasedFonts();
    const distFontSize = Math.max(7, Math.min(sf.dist, Number(pg.edgeFontSize) || 8));
    const dirFontSize = Math.max(7, Math.min(sf.bearing, Number(pg.edgeFontSize) || 8));
    const minEF = 7;
    const distBaseOffset = this._groundClearanceOffset();
    const labelGap = 0.8;
    const vertexCount = Math.max(0, coords.length - 1);
    const { splayVertex, threshold: splayThreshold } = this._detectSplay(edges, vertexCount);

    const isDeveloped = this.planType === 'general-developed';

    let labeled = 0;
    let skipped = 0;

    for (let i = 0; i < coords.length - 1; i++) {
      const edge = edges[i];
      if (!edge) continue;

      const edDistM = typeof edge.distance === 'number' ? edge.distance : parseFloat(edge.distance) || 0;
      const isSplayEdge = edDistM > 0 && edDistM < splayThreshold;
      const hasSplayTouch = isSplayEdge || (splayVertex[i] || splayVertex[(i + 1) % vertexCount]);
      const splayBoost = hasSplayTouch ? 1.8 : 1; // Preferred offset multiplier for splay-adjacent edges

      const edgeKey = createEdgeKey(coords[i], coords[i + 1]);
      const edgeInfo = this.labeledEdges.get(edgeKey);
      const isShared = (this.edgeOccurrences.get(edgeKey) || 0) > 1;

      let labelMode = 'both';
      if (edgeInfo !== undefined) {
        if (edgeInfo.distance && edgeInfo.bearing) { skipped++; continue; }
        else if (edgeInfo.distance && !edgeInfo.bearing) labelMode = 'bearing-only';
        else if (!edgeInfo.distance && edgeInfo.bearing) labelMode = 'distance-only';
      } else if (isShared) {
        labelMode = 'distance-only'; // Shared: distance in first parcel, bearing in adjacent
      }

      const p1 = pdfCoords[i];
      const p2 = pdfCoords[i + 1];
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const edgeLenPt = Math.sqrt(dx * dx + dy * dy);
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;

      let perpX = -dy / Math.sqrt(dx * dx + dy * dy);
      let perpY =  dx / Math.sqrt(dx * dx + dy * dy);
      const toCx = pg.centroid.x - midX;
      const toCy = pg.centroid.y - midY;
      if (perpX * toCx + perpY * toCy < 0) { perpX = -perpX; perpY = -perpY; }

      let angle = Math.atan2(dy, dx) * (180 / Math.PI);
      if (angle > 90 || angle < -90) angle += 180;

      const distText = (typeof (edge.distanceRounded ?? edge.distance) === 'number'
        ? (edge.distanceRounded ?? edge.distance)
        : parseFloat(edge.distance) || 0).toFixed(2);
      const bearDeg = typeof edge.bearing === 'number' ? edge.bearing
        : typeof edge.bearingDeg === 'number' ? edge.bearingDeg
        : parseFloat(edge.bearing) || 0;
      const dirText = edge.directionDMS || (() => {
        const d = Math.floor(bearDeg);
        const rm = (bearDeg - d) * 60;
        const m = Math.floor(rm);
        const s = Math.round((rm - m) * 60);
        return `${d}\u00b0${String(m).padStart(2,'0')}'${String(s).padStart(2,'0')}"`;
      })();

      const effDistOffset = distBaseOffset * splayBoost; // preferred starting offset
      // minOffset is always the 3mm floor regardless of splay, so narrow-parcel splay edges
      // can still find a valid bbox-inside position without being pushed outside the polygon.

      // ── Place distance + bearing as a locked tight pair ──────────────────────
      // Both labels are anchored at the same perpendicular offset from the edge,
      // with bearing placed further inward than distance.
      // pairGap = extra clear space between label halos. Set to 0 for compact layout:
      // separation = distFs/2 + distStroke + 0 + bearStroke + dirFs/2
      // The stroke widths (~2pt each) provide ~1.4mm natural visual gap between text edges.
      const pairGap = 2; // 2pt ≈ 0.7mm — compact but prevents halo overlap between stacked labels

      if (isDeveloped) {
        // Developed Township General Plan: do not render edge distances or directions on parcel edges.
        // Still track topology so stand numbers and collision detection remain unaffected.
        if (!edgeInfo) {
          this.labeledEdges.set(edgeKey, {
            distance: false, bearing: false, dirText, midX, midY, perpX, perpY, angle,
            distFontSize, dirFontSize, distOffset: effDistOffset,
            bearOffset: effDistOffset,
            splay: hasSplayTouch, pdfCoords, edgeLenPt,
          });
        }
        labeled++;
        continue;
      }

      if (labelMode === 'both' || labelMode === 'distance-only') {
        // minOffset = 3mm floor — distance labels must never be closer than 3mm from the edge
        let distPos = this._placeLabel(distText, effDistOffset, pdfCoords, midX, midY, perpX, perpY, angle, distFontSize, minEF, pg, hasSplayTouch, false, edgeLenPt, distBaseOffset);
        // Try force-place if no collision-free bbox-inside position found
        if (!distPos) {
          distPos = this._forcePlaceInsidePolygon(distText, effDistOffset, pdfCoords, midX, midY, perpX, perpY, angle, pg, edgeLenPt, false, distBaseOffset, distFontSize);
        }
        // Safety guard — should never be null since _forcePlaceInsidePolygon has centroid fallback
        if (!distPos) {
          this.logger.warn(`[Labeling] SKIP dist label edge ${i} "${distText}" parcel=${props.stand || props.name || '?'}`);
          skipped++; continue;
        }

        this._renderEdgeLabelAt(distText, distPos, distPos.fontSize, angle, hasSplayTouch, false);

        // Bearing anchored directly below distance — same x/y base + one line-height down
        const chosenDistOffset = distPos.offset;
        const chosenDistFs = distPos.fontSize;
        const _distStroke = Math.max(1.2, Math.min(2.5, chosenDistFs * 0.25));
        const _bearStroke = Math.max(1.2, Math.min(2.5, dirFontSize * 0.25));
        const bearAnchorOffset = chosenDistOffset + chosenDistFs / 2 + _distStroke + pairGap + _bearStroke + dirFontSize / 2;

        if (!edgeInfo) {
          this.labeledEdges.set(edgeKey, {
            distance: true, bearing: false, dirText, midX, midY, perpX, perpY, angle,
            distFontSize, dirFontSize, distOffset: chosenDistOffset,
            bearOffset: bearAnchorOffset,
            splay: hasSplayTouch, pdfCoords, edgeLenPt,
          });
        } else { edgeInfo.distance = true; }

        // If rendering both, stack bearing below distance — with bbox containment enforcement.
        if ((labelMode === 'both') && !edgeInfo?.bearing) {
          const polygon = pdfCoords.map((p) => [p.x, p.y]);
          const distStroke = Math.max(1.2, Math.min(2.5, chosenDistFs * 0.25));
          const bearStroke = Math.max(1.2, Math.min(2.5, dirFontSize * 0.25));
          const baseSep = chosenDistFs / 2 + distStroke + pairGap + bearStroke + dirFontSize / 2;
          const dirLw = this.doc.widthOfString(dirText, { font: 'Helvetica', size: dirFontSize });
          const dirHw = dirLw / 2;
          const dirHh = dirFontSize / 2;

          // Try increasing separations until bbox fits inside polygon, cap at centroid distance.
          const centDist = Math.sqrt(
            (pg.centroid.x - distPos.x) ** 2 + (pg.centroid.y - distPos.y) ** 2
          );
          const maxSep = Math.max(baseSep, centDist * 0.9);
          let bearPos = null;
          for (let sep = baseSep; sep <= maxSep + 1; sep += 1) {
            const bx = distPos.x + perpX * sep;
            const by = distPos.y + perpY * sep;
            if (isLabelBboxInsidePolygon(bx, by, dirHw, dirHh, angle, polygon)) {
              bearPos = { x: bx, y: by, fontSize: dirFontSize, offset: distPos.offset + sep, width: dirLw };
              break;
            }
          }
          // Fallback: force-place with full search if stacking still can't fit bbox
          if (!bearPos) {
            bearPos = this._forcePlaceInsidePolygon(
              dirText, bearAnchorOffset, pdfCoords, midX, midY, perpX, perpY, angle,
              pg, edgeLenPt, true, distBaseOffset, dirFontSize
            );
          }
          if (bearPos) {
            this.logger.info(`[LABEL-STACK-V2] edge=${distText}/${dirText} sep=${baseSep.toFixed(1)}pt distPos=(${distPos.x.toFixed(1)},${distPos.y.toFixed(1)}) bearPos=(${bearPos.x.toFixed(1)},${bearPos.y.toFixed(1)}) pairGap=${pairGap} distFs=${chosenDistFs} dirFs=${dirFontSize}`);
            this._renderEdgeLabelAt(dirText, bearPos, bearPos.fontSize, angle, hasSplayTouch, true);
            const stored = this.labeledEdges.get(edgeKey);
            if (stored) stored.bearing = true;
          }
        }
      }

      if (labelMode === 'bearing-only') {
        // Shared edge: bearing placed inside THIS (second) parcel at 3mm min offset from edge.
        let bearPos = this._placeLabel(dirText, effDistOffset, pdfCoords, midX, midY, perpX, perpY, angle, dirFontSize, minEF, pg, hasSplayTouch, true, edgeLenPt, distBaseOffset);
        if (!bearPos) {
          bearPos = this._forcePlaceInsidePolygon(dirText, effDistOffset, pdfCoords, midX, midY, perpX, perpY, angle, pg, edgeLenPt, true, distBaseOffset, dirFontSize);
        }
        // Safety guard — _forcePlaceInsidePolygon always returns a position now
        if (!bearPos) { skipped++; continue; }

        this._renderEdgeLabelAt(dirText, bearPos, bearPos.fontSize, angle, hasSplayTouch, true);
        if (edgeInfo) edgeInfo.bearing = true;
      }

      labeled++;
    }
    return { totalEdges: coords.length - 1, labeled, skipped, labelCollisions: this.labelCollisions };
  }

  // ── Second-pass: render bearing-only labels for shared edges ──────────────────
  renderSecondPassBearings() {
    // Developed Township General Plan: no edge directions/distances on parcel edges
    if (this.planType === 'general-developed') {
      this.logger.info('[Labeling] ✅ Second-pass bearings skipped (developed plan - no edge directions on parcels)');
      return 0;
    }
    let rendered = 0;
    this.labeledEdges.forEach((info) => {
      if (info?.bearing) return;
      const dirText = info?.dirText;
      if (!dirText) return;
      const { midX, midY, perpX, perpY, angle, dirFontSize, distOffset, pdfCoords, edgeLenPt } = info;
      if (![midX, midY, perpX, perpY].every(Number.isFinite)) return;
      if (!Array.isArray(pdfCoords) || pdfCoords.length < 3) return;
      // Use opposite perpendicular (into neighboring parcel) at 3mm offset
      const oppPerpX = -perpX, oppPerpY = -perpY;
      const min3mm = 3 / 0.352778; // 3mm floor in pt
      const useOffset = distOffset || min3mm;
      const pg = analyzeParcelGeom(pdfCoords);
      // Force inside polygon with adaptive font — 3mm minimum offset from edge
      const pos = this._forcePlaceInsidePolygon(dirText, useOffset, pdfCoords, midX, midY, oppPerpX, oppPerpY, angle, pg, edgeLenPt, true, min3mm, info.dirFontSize || 8);
      if (pos) {
        this._renderEdgeLabelAt(dirText, pos, pos.fontSize, angle, false, true);
        info.bearing = true;
        rendered++;
      }
    });
    this.logger.info(`[Labeling] ✅ Second-pass bearings rendered: ${rendered}`);
    return rendered;
  }
  
  // ── Deferred stand-number rendering (after all edge labels placed) ────────────
  renderDeferredStandLabels(parcels) {
    this.logger.info('[Labeling] 🏷️  Rendering deferred stand numbers...');
    let rendered = 0;

    parcels.features.forEach((parcel) => {
      const data = parcel._standLabelData;
      if (!data || !data.stand) return;

      const { stand, labelText, standFontSize, pdfCoords } = data;
      if (!Array.isArray(pdfCoords) || pdfCoords.length < 3) return;

      // Deduplicate closing vertex
      let pts = pdfCoords;
      const first = pts[0], last = pts[pts.length - 1];
      if (first && last && Math.hypot(last.x - first.x, last.y - first.y) < 1e-6) pts = pts.slice(0, -1);

      // Compute POI — widest interior point
      const poi = (() => {
        try {
          return findPoleOfInaccessibility(pts.map(p => ({ x: p.x, y: p.y })));
        } catch {
          let sx = 0, sy = 0;
          pts.forEach(p => { sx += p.x; sy += p.y; });
          return { x: sx / pts.length, y: sy / pts.length };
        }
      })();
      if (!Number.isFinite(poi.x) || !Number.isFinite(poi.y)) return;

      // Centroid (shoelace) — kept as drift-fallback target only
      let centroid;
      {
        let twiceArea = 0, cx = 0, cy = 0;
        for (let i = 0; i < pts.length; i++) {
          const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
          const cross = p0.x * p1.y - p1.x * p0.y;
          twiceArea += cross; cx += (p0.x + p1.x) * cross; cy += (p0.y + p1.y) * cross;
        }
        if (Math.abs(twiceArea) > 1e-6) {
          centroid = { x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) };
        } else {
          let sx = 0, sy = 0;
          pts.forEach(p => { sx += p.x; sy += p.y; });
          centroid = { x: sx / pts.length, y: sy / pts.length };
        }
        if (!Number.isFinite(centroid.x) || !Number.isFinite(centroid.y)) centroid = poi;
      }

      // Find longest edge angle — CLAMPED to ±45° from horizontal
      let longestLen = 0, longestAngle = 0;
      for (let i = 0; i < pdfCoords.length - 1; i++) {
        const dx = pdfCoords[i + 1].x - pdfCoords[i].x;
        const dy = pdfCoords[i + 1].y - pdfCoords[i].y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > longestLen) { longestLen = len; longestAngle = Math.atan2(dy, dx) * (180 / Math.PI); }
      }
      // Normalise to keep text upright
      if (longestAngle > 90) longestAngle -= 180;
      if (longestAngle < -90) longestAngle += 180;
      // Clamp: never more than ±25° from horizontal — keeps labels legible
      longestAngle = Math.max(-25, Math.min(25, longestAngle));

      const polygon = pdfCoords.map((p) => [p.x, p.y]);
      const { width: pgW, height: pgH } = (() => {
        let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity;
        pdfCoords.forEach((p) => { mnX = Math.min(mnX, p.x); mxX = Math.max(mxX, p.x); mnY = Math.min(mnY, p.y); mxY = Math.max(mxY, p.y); });
        return { width: mxX - mnX, height: mxY - mnY, minX: mnX, minY: mnY };
      })();

      // Stand numbers identify the parcel — highest-priority label.
      //
      // Strategy:
      //   Phase 1: Place at POI at largest font where the rotated bbox fits INSIDE
      //            the polygon. POI is the widest interior point so this naturally
      //            avoids narrow ends. No collision check — edge/beacon labels
      //            work around stand numbers, not the other way round.
      //   Phase 2: Slide along the long axis through the POI (both directions) to
      //            find a position where the bbox fits. Covers concave parcels where
      //            the POI vertex itself is on a boundary.
      //   Phase 3: Absolute fallback — centroid, minimum font, bbox check dropped.
      const fontSizes = [standFontSize, Math.max(7, standFontSize - 1), Math.max(7, standFontSize - 2), 7];

      const drawStandLabel = (cx, cy, angle, fs) => {
        const lw = this.doc.widthOfString(labelText, { font: 'Helvetica-Bold', size: fs });
        const lh = fs;
        const aRad = (angle * Math.PI) / 180;
        const rw = lw * Math.abs(Math.cos(aRad)) + lh * Math.abs(Math.sin(aRad));
        const rh = lw * Math.abs(Math.sin(aRad)) + lh * Math.abs(Math.cos(aRad));
        this.doc.save();
        this.doc.translate(cx, cy).rotate(angle, { origin: [0, 0] });
        this.doc.fontSize(fs).fillColor('#000000').font('Helvetica-Bold')
          .text(labelText, -lw / 2, -lh / 2, { lineBreak: false });
        this.doc.restore();
        this.collisionDetector.addRegion(cx - rw / 2, cy - rh / 2, rw, rh, 1);
        rendered++;
      };

      // Check whether a rotated label bbox fits wholly inside the polygon.
      // Uses the same corner-check as isLabelBboxInsidePolygon but inline
      // to avoid an extra import.
      const labelFitsAt = (cx, cy, angle, fs) => {
        const lw = this.doc.widthOfString(labelText, { font: 'Helvetica-Bold', size: fs });
        const lh = fs;
        const aRad = (angle * Math.PI) / 180;
        const cosA = Math.cos(aRad), sinA = Math.sin(aRad);
        const hw = lw / 2, hh = lh / 2;
        // Four rotated corners
        for (const [lx, ly] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
          const wx = cx + lx * cosA - ly * sinA;
          const wy = cy + lx * sinA + ly * cosA;
          if (!isPointInPolygonSimple([wx, wy], polygon)) return false;
        }
        return true;
      };

      // Placement priority mirrors the reference plan style:
      //   1. Horizontal at POI, largest → smallest font   (preferred — labels read naturally)
      //   2. Horizontal sliding along long axis from POI  (narrow parcel, different cross-section)
      //   3. Rotated (longestAngle) at POI, largest → smallest font (last resort for tight parcels)
      //   4. Rotated sliding along long axis              (very narrow diagonal strips)
      //   5. Absolute fallback — horizontal at POI, centre-inside only, minimum font
      //
      // Rotation cap: ±25° — keeps labels legible and close to horizontal.
      const cappedAngle = Math.max(-25, Math.min(25, longestAngle));
      const aRad = cappedAngle * Math.PI / 180;
      const axDx = Math.cos(aRad), axDy = Math.sin(aRad);
      const maxSlide = Math.max(pgW, pgH);

      let placed = false;

      // Phase 1: Horizontal at POI
      for (const fs of fontSizes) {
        if (labelFitsAt(poi.x, poi.y, 0, fs)) {
          drawStandLabel(poi.x, poi.y, 0, fs);
          placed = true;
          break;
        }
      }

      // Phase 2: Horizontal — slide along long axis through POI
      if (!placed) {
        outer: for (const fs of fontSizes) {
          for (let t = 0.05; t <= 1; t += 0.05) {
            for (const sign of [1, -1]) {
              const cx = poi.x + sign * t * maxSlide * axDx;
              const cy = poi.y + sign * t * maxSlide * axDy;
              if (labelFitsAt(cx, cy, 0, fs)) {
                drawStandLabel(cx, cy, 0, fs);
                placed = true;
                break outer;
              }
            }
          }
        }
      }

      // Phase 3: Rotated at POI (for parcels too narrow to fit horizontal text)
      if (!placed) {
        for (const fs of fontSizes) {
          if (labelFitsAt(poi.x, poi.y, cappedAngle, fs)) {
            drawStandLabel(poi.x, poi.y, cappedAngle, fs);
            placed = true;
            break;
          }
        }
      }

      // Phase 4: Rotated — slide along long axis
      if (!placed) {
        outer2: for (const fs of fontSizes) {
          for (let t = 0.05; t <= 1; t += 0.05) {
            for (const sign of [1, -1]) {
              const cx = poi.x + sign * t * maxSlide * axDx;
              const cy = poi.y + sign * t * maxSlide * axDy;
              if (labelFitsAt(cx, cy, cappedAngle, fs)) {
                drawStandLabel(cx, cy, cappedAngle, fs);
                placed = true;
                break outer2;
              }
            }
          }
        }
      }

      // Phase 5: Absolute fallback — centre-inside only, minimum font, horizontal
      if (!placed) {
        const fs = Math.max(7, standFontSize - 2);
        const origin = isPointInPolygonSimple([poi.x, poi.y], polygon) ? poi : centroid;
        drawStandLabel(origin.x, origin.y, 0, fs);
        if (origin === centroid) this.logger.info(`[Labeling] ⚡ centroid fallback for stand label: ${stand}`);
      }
    });

    this.logger.info(`[Labeling] ✅ Stand labels rendered: ${rendered}`);
    return rendered;
  }
}

export { LabelingSystem, createEdgeKey };
