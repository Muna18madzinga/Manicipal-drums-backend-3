/**
 * Shared sheet-layout planner for SI 727 survey plans.
 *
 * Consumed by both pdfkitGeoPDF.js (PDF) and dxfGenerator.js (DXF).
 * Returns block-position metadata; format-specific drawers/emitters render
 * entities at those positions.
 *
 * Spec: docs/superpowers/specs/2026-06-12-shared-layout-planner-design.md
 *
 * Thin wrapper around pdfkitGeoPDF.calculateBlockPositions: builds a
 * measureText-backed fake doc proxy and delegates. The wrapper exists so
 * both PDF and DXF call the same arrangement algorithm with their own
 * text-measurement strategies (PDFKit's widthOfString for PDF; the 0.55
 * width-factor heuristic for DXF).
 */

import { calculateBlockPositions } from './pdfkitGeoPDF.js';

/**
 * Build a fake PDFKit-doc-like object whose widthOfString delegates to the
 * injected measureText. The lifted calculateBlockPositions body uses
 * doc.font(F).fontSize(S).widthOfString(text); this proxy preserves that
 * chained-call API.
 */
function makeMeasureProxy(measureText) {
  let family = 'Helvetica';
  let size = 10;
  return {
    font(f) { family = f; return this; },
    fontSize(s) { size = s; return this; },
    widthOfString(text) { return measureText(String(text), { family, size }); },
  };
}

/**
 * Plan the surrounding-block layout for one survey-plan sheet.
 *
 * @param {object}   args
 * @param {object}   args.metadata
 * @param {object}   args.parcels             - GeoJSON FeatureCollection
 * @param {object}   args.outsideFigureData   - { edges, coordinates }
 * @param {object}   args.beacons             - GeoJSON FeatureCollection
 * @param {object}   args.mapBounds           - { x, y, width, height } in PDF points
 * @param {object}   args.mapFeatureBounds    - polygon bbox in PDF points
 * @param {object}   args.scale               - { value, label }
 * @param {object}   args.extent              - ground extent
 * @param {Array}    [args.tickMarkBounds=[]] - pre-seeded obstacle bboxes
 * @param {object}   [args.figureBounds=null] - figure bbox in PDF points
 * @param {Array}    [args.polyPts=[]]        - closed polygon vertices in PDF points
 * @param {Function} args.measureText         - (str, { family, size }) => width in pt
 * @param {object}   args.logger              - { info, warn, error }
 * @returns {object} blockPositions
 */
export function planSheetLayout(args) {
  const {
    metadata, parcels, outsideFigureData, beacons,
    mapBounds, mapFeatureBounds, logger, scale, extent,
    tickMarkBounds = [], figureBounds = null, polyPts = [],
    zOrderCollisionRegistry = null,
    measureText,
    scheduleColumnWidthsPt = null,   // NEW
  } = args;

  if (!scale || !scale.value || !scale.label) {
    throw new Error('Scale parameter is required with value and label properties');
  }

  // Ensure the polygon is explicitly closed before edge-walk validation.
  // An open polygon (last vertex ≠ first) causes rectangleOverlapsPolygon to
  // silently miss the closing edge, producing spurious whitespace zones at the
  // open boundary. Reference: 3-v3 sweep memory + dxfScheduleEmitter Pass 2.
  let polyPtsClosed = polyPts;
  if (polyPts && polyPts.length >= 3) {
    const first = polyPts[0], last = polyPts[polyPts.length - 1];
    if (first.x !== last.x || first.y !== last.y) {
      polyPtsClosed = [...polyPts, { x: first.x, y: first.y }];
    }
  }

  const doc = makeMeasureProxy(measureText);
  const blockPositions = calculateBlockPositions(
    doc, metadata, parcels, outsideFigureData, beacons,
    mapBounds, mapFeatureBounds, logger, scale, extent,
    tickMarkBounds, zOrderCollisionRegistry,
    figureBounds, polyPtsClosed,
    scheduleColumnWidthsPt,        // NEW 15th positional arg
  );

  // Endorsement block — fixed right-margin position. Mirrors the inline
  // computation in drawEndorsementBlock (which is now rewired to consume
  // this slot in Task 5). 150 mm × 150 mm at top-right of the map area.
  blockPositions.endorsement = {
    x: mapBounds.x + mapBounds.width,
    y: mapBounds.y,
    width: 150 * 2.835,  // 150 mm → PDF points
    height: 150,
  };

  return blockPositions;
}
