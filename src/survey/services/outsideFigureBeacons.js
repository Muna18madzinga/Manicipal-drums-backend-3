// app-backend/src/services/outsideFigureBeacons.js
//
// Single source of truth for the outside-figure beacon sequence used in the SI 727
// figure-description sentence. Imported by BOTH the PDF (pdfkitGeoPDF.js) and DXF
// (dxfGenerator.js) generators so their beacon sequences are identical by
// construction on every project — real or fixture.

/**
 * Extract beacon sequence from outside figure data.
 * Returns first beacon, last beacon, and the full closed dot-joined sequence.
 *
 * Beacon-name resolution per edge (in priority order):
 *   edge.from.name → edge.from.id → edge.pointId → edge.constant → edge.label
 *   → leading token of edge.side ("fromBeacon-toBeacon").
 * The loop is closed by appending a closing beacon (last edge's `to` beacon, else
 * the first beacon). Dot-separated, e.g. "M4.M5.M6.M7.M8.M9.M4".
 */
export function getOutsideFigureVertices(outsideFigureData, logger) {
  if (
    !outsideFigureData ||
    !outsideFigureData.edges ||
    outsideFigureData.edges.length === 0
  ) {
    if (logger)
      logger.warn("[PDFKit] ⚠️  No outside figure data for beacon sequence");
    return { first: null, last: null, sequence: null };
  }

  const edges = outsideFigureData.edges;

  // ⭐ CRITICAL FIX: Helper to detect generic fallback names
  const isGenericFallbackName = (name) => {
    if (!name) return true;
    const genericPatterns = [
      /^PEGGING[A-Z]$/,           // PEGGINGA, PEGGINGB, etc.
      /^[A-Z]+[A-Z]$/,            // STANDA, STANDB, etc.
      /^P\d+$/,                   // P1, P2, etc.
      /^[A-Z]$/,                  // Single letters A, B, C...
      /^POINT\d+$/,               // POINT1, POINT2...
      /^BEACON\d+$/               // BEACON1, BEACON2...
    ];
    return genericPatterns.some(pattern => pattern.test(name));
  };

  // Extract all unique beacon names in order
  const beacons = [];
  edges.forEach((edge, index) => {
    // ⭐ CRITICAL FIX: Try multiple sources for beacon name
    // Priority: edge.from.name/id -> edge.pointId -> edge.constant -> edge.label -> parse from edge.side
    let beaconName = null;

    // First try edge.from fields (these should have actual beacon names from spatial matching)
    if (edge.from) {
      beaconName = edge.from.name || edge.from.id || null;
    }

    // Fall back to other fields if from.name/id not available
    if (!beaconName) {
      beaconName = edge.pointId || edge.constant || edge.label || null;
    }

    // Last resort: parse from edge.side ("fromBeacon-toBeacon")
    if (!beaconName && edge.side) {
      const sideFrom = edge.side.split('-')[0].trim();
      beaconName = sideFrom;
    }

    // ⭐ CRITICAL FIX: Detect and warn about generic fallback names
    if (beaconName && isGenericFallbackName(beaconName)) {
      if (logger) {
        logger.warn(`[PDFKit] ⚠️ Generic beacon name detected for edge ${index}: "${beaconName}" - expected actual beacon name like "M8" or "2836B"`);
      }
    }

    if (beaconName && !beacons.includes(beaconName)) {
      beacons.push(beaconName);
    }
  });

  // Add the closing beacon (same as first to close the figure)
  // Try to get it from the last edge's to-side or fall back to first beacon
  if (beacons.length > 0 && edges.length > 0) {
    const lastEdge = edges[edges.length - 1];
    let closingBeacon = null;

    // ⭐ CRITICAL FIX: Try last edge's to.name/id first
    if (lastEdge.to) {
      closingBeacon = lastEdge.to.name || lastEdge.to.id || null;
    }

    // Fall back to other methods
    if (!closingBeacon && lastEdge.side) {
      const sideParts = lastEdge.side.split('-');
      if (sideParts.length > 1) {
        closingBeacon = sideParts.slice(1).join('-').trim();
      }
    }

    if (lastEdge.toBeacon) {
      closingBeacon = lastEdge.toBeacon;
    }

    // Default to first beacon if nothing else found
    if (!closingBeacon) {
      closingBeacon = beacons[0];
    }

    // Always append the closing beacon to close the loop (e.g. M4, M5, …, M9, M4)
    // The duplicate check is intentionally omitted — the first point must repeat at the end
    if (closingBeacon) {
      beacons.push(closingBeacon);
    }
  }

  const first = beacons[0] || "A";
  const last = beacons[beacons.length - 1] || "Z";

  // Create sequence: "M4.M5.M6.….M9.M4" — closed-loop notation, dot-separated
  // to match the ideal General Plan (and keep PDF↔DXF figure descriptions in lockstep).
  const sequence = beacons.join(".");

  if (logger) {
    logger.info({
      msg: "[PDFKit] 📍 Extracted beacon sequence",
      beacons: beacons,
      sequence: sequence,
      edgeCount: edges.length,
      genericNamesFound: beacons.filter(isGenericFallbackName),
    });
  }

  return { first, last, sequence };
}
