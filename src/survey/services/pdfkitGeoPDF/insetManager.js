import { PT_TO_MM, MM_TO_PT } from './geometry.js';

/**
 * InsetManager - Manages map insets for short edges and complex details
 * Tracks global inset numbering and positioning
 */
export class InsetManager {
  constructor(logger) {
    this.insets = [];
    this.nextInsetNumber = 1;
    this.usedPositions = [];
    this.logger = logger;
  }

  createInset(edge, parcel, mainScale, reason = "short-edge") {
    const insetNumber = this.nextInsetNumber++;

    const insetScale = Math.floor(mainScale / 2.5);

    const buffer = edge.length * 1.5;
    const insetBounds = this.calculateInsetBounds(edge, buffer);

    const inset = {
      number: insetNumber,
      edge: edge,
      parcel: parcel,
      bounds: insetBounds,
      scale: insetScale,
      mainScale: mainScale,
      position: null,
      reason: reason,
      indicatorText: `Inset ${insetNumber}`,
    };

    this.insets.push(inset);

    this.logger.info({
      msg: `[Insets] Created Inset ${insetNumber}`,
      parcel: parcel.properties.stand,
      edgeLength: edge.length.toFixed(2) + "m",
      scale: `1:${insetScale}`,
      reason,
    });

    return inset;
  }

  calculateInsetBounds(edge, buffer) {
    const allPoints = [];

    if (edge.start && Array.isArray(edge.start) && edge.start.length >= 2) {
      allPoints.push(edge.start);
    }
    if (edge.end && Array.isArray(edge.end) && edge.end.length >= 2) {
      allPoints.push(edge.end);
    }

    if (edge.prevEdge) {
      if (
        edge.prevEdge.start &&
        Array.isArray(edge.prevEdge.start) &&
        edge.prevEdge.start.length >= 2
      ) {
        allPoints.push(edge.prevEdge.start);
      }
      if (
        edge.prevEdge.end &&
        Array.isArray(edge.prevEdge.end) &&
        edge.prevEdge.end.length >= 2
      ) {
        allPoints.push(edge.prevEdge.end);
      }
    }

    if (edge.nextEdge) {
      if (
        edge.nextEdge.start &&
        Array.isArray(edge.nextEdge.start) &&
        edge.nextEdge.start.length >= 2
      ) {
        allPoints.push(edge.nextEdge.start);
      }
      if (
        edge.nextEdge.end &&
        Array.isArray(edge.nextEdge.end) &&
        edge.nextEdge.end.length >= 2
      ) {
        allPoints.push(edge.nextEdge.end);
      }
    }

    if (allPoints.length < 2) {
      this.logger.error(
        "[Insets] Not enough valid points for bounds calculation",
        { edge }
      );
      return { minY: 0, maxY: buffer * 2, minX: 0, maxX: buffer * 2 };
    }

    const yCoords = allPoints.map((p) => p[0]).filter((v) => isFinite(v));
    const xCoords = allPoints.map((p) => p[1]).filter((v) => isFinite(v));

    if (yCoords.length === 0 || xCoords.length === 0) {
      this.logger.error(
        "[Insets] No valid coordinates for bounds calculation",
        { edge }
      );
      return { minY: 0, maxY: buffer * 2, minX: 0, maxX: buffer * 2 };
    }

    const minY = Math.min(...yCoords) - buffer;
    const maxY = Math.max(...yCoords) + buffer;
    const minX = Math.min(...xCoords) - buffer;
    const maxX = Math.max(...xCoords) + buffer;

    this.logger.info("[Insets] Calculated bounds for 3-edge context:", {
      points: allPoints.length,
      bounds: { minY, maxY, minX, maxX },
      rangeY: maxY - minY,
      rangeX: maxX - minX,
    });

    return { minY, maxY, minX, maxX };
  }

  getInsetDimensions() {
    const INSET_SIZE = 60 * MM_TO_PT;
    return this.insets.map((inset, index) => ({
      id: `inset${inset.number}`,
      width: INSET_SIZE,
      height: INSET_SIZE,
      insetNumber: inset.number,
      insetData: inset,
    }));
  }

  renderInsetsAtPositions(doc, insetPositions, extent, mapBounds) {
    if (this.insets.length === 0) {
      this.logger.info("[Insets] No insets to render");
      return;
    }

    this.logger.info(
      `[Insets] Rendering ${this.insets.length} insets at calculated positions...`
    );

    const INSET_SIZE = 60 * MM_TO_PT;

    this.insets.forEach((inset, index) => {
      const positionKey = `inset${inset.number}`;
      const position = insetPositions[positionKey];

      if (!position) {
        this.logger.warn(`[Insets] No position found for ${positionKey}`);
        return;
      }

      inset.position = {
        x: position.x,
        y: position.y,
      };

      this.renderInset(doc, inset, INSET_SIZE, INSET_SIZE, extent, mapBounds);
    });

    this.logger.info(`[Insets] ✅ Rendered ${this.insets.length} insets`);
  }

  findOptimalInsetPosition(width, height, mapBounds, pageWidth, pageHeight) {
    const rightMarginX = mapBounds.x + mapBounds.width + 10;
    const topMarginY = mapBounds.y;
    const bottomMarginY = mapBounds.y + mapBounds.height - height;
    const mapCenterX = mapBounds.x + mapBounds.width / 2 - width / 2;

    const candidates = [
      { x: rightMarginX, y: topMarginY, region: "right-top" },
      { x: rightMarginX, y: topMarginY + 90, region: "right-mid" },
      { x: rightMarginX, y: topMarginY + 180, region: "right-bottom" },
      { x: mapCenterX, y: 50, region: "top-center" },
      { x: mapCenterX, y: pageHeight - height - 50, region: "bottom-center" },
    ];

    for (const candidate of candidates) {
      if (!this.overlapsExistingInset(candidate, width, height)) {
        this.usedPositions.push({ ...candidate, width, height });
        return candidate;
      }
    }

    if (this.usedPositions.length > 0) {
      const lastInset = this.usedPositions[this.usedPositions.length - 1];
      const position = {
        x: lastInset.x,
        y: lastInset.y + lastInset.height + 10,
        region: "stacked",
      };
      this.usedPositions.push({ ...position, width, height });
      return position;
    }

    return { x: rightMarginX, y: topMarginY, region: "fallback" };
  }

  overlapsExistingInset(candidate, width, height) {
    for (const used of this.usedPositions) {
      if (
        this.rectanglesOverlap(
          candidate.x,
          candidate.y,
          width,
          height,
          used.x,
          used.y,
          used.width,
          used.height
        )
      ) {
        return true;
      }
    }
    return false;
  }

  rectanglesOverlap(x1, y1, w1, h1, x2, y2, w2, h2) {
    return !(x1 + w1 < x2 || x2 + w2 < x1 || y1 + h1 < y2 || y2 + h2 < y1);
  }

  renderAllInsets(doc, extent, mapBounds, pageWidth, pageHeight) {
    if (this.insets.length === 0) {
      return;
    }

    this.logger.info(`[Insets] Rendering ${this.insets.length} insets...`);

    const insetWidth = 60 * MM_TO_PT;
    const insetHeight = 60 * MM_TO_PT;

    this.insets.forEach((inset) => {
      inset.position = this.findOptimalInsetPosition(
        insetWidth,
        insetHeight,
        mapBounds,
        pageWidth,
        pageHeight
      );

      this.renderInset(doc, inset, insetWidth, insetHeight, extent, mapBounds);
    });

    this.logger.info(`[Insets] ✅ Rendered ${this.insets.length} insets`);
  }

  renderInset(doc, inset, width, height, extent, mapBounds) {
    const { position, bounds, scale, number, parcel, edge } = inset;

    doc.save();

    doc
      .rect(position.x, position.y, width, height)
      .lineWidth(0.5)
      .strokeColor("#000000")
      .stroke();

    doc
      .fontSize(12)
      .font("Helvetica-Bold")
      .fillColor("#000000")
      .text(
        `Inset ${number} - Stand ${parcel.properties.stand} (1:${scale})`,
        position.x + 2,
        position.y + 2,
        { width: width - 4 }
      );

    const insetMapArea = {
      x: position.x + 5,
      y: position.y + 12,
      width: width - 10,
      height: height - 20,
    };

    const insetExtent = {
      minY: bounds.minY,
      maxY: bounds.maxY,
      minX: bounds.minX,
      maxX: bounds.maxX,
    };

    this.logger.info(`[Insets] Rendering inset ${number}:`, {
      bounds: insetExtent,
      mapArea: insetMapArea,
      edgeLength: edge.length ? edge.length.toFixed(2) + "m" : "N/A",
      edgeDistance: edge.distance ? edge.distance.toFixed(2) + "m" : "N/A",
      edgeDirection: edge.direction || "N/A",
      hasPrevEdge: !!edge.prevEdge,
      hasNextEdge: !!edge.nextEdge,
    });

    this.renderParcelInInset(doc, parcel, insetExtent, insetMapArea);
    this.renderEdgeInInset(doc, edge, insetExtent, insetMapArea);

    this.drawSmallNorthArrow(
      doc,
      position.x + width - 12,
      position.y + height - 12
    );

    this.drawSmallScaleBar(
      doc,
      position.x + 5,
      position.y + height - 8,
      20,
      scale
    );

    doc.restore();
  }

  renderParcelInInset(doc, parcel, extent, mapArea) {
    let coords = parcel.geometry.coordinates[0];
    if (Array.isArray(coords) && coords.length === 1 && Array.isArray(coords[0]) && Array.isArray(coords[0][0])) coords = coords[0];
    const pdfCoords = coords.map((coord) => {
      return this.transformCoordsForInset(coord[0], coord[1], extent, mapArea);
    });

    const visibleCoords = pdfCoords.filter(
      (coord) =>
        coord.x >= mapArea.x &&
        coord.x <= mapArea.x + mapArea.width &&
        coord.y >= mapArea.y &&
        coord.y <= mapArea.y + mapArea.height
    );

    if (visibleCoords.length < 2) {
      this.logger.warn(
        "[Insets] Not enough visible coordinates to draw parcel in inset"
      );
      return;
    }

    doc.save();
    doc.moveTo(visibleCoords[0].x, visibleCoords[0].y);
    for (let i = 1; i < visibleCoords.length; i++) {
      doc.lineTo(visibleCoords[i].x, visibleCoords[i].y);
    }
    doc.lineWidth(0.5).strokeColor("#000000").stroke();
    doc.restore();
  }

  renderEdgeInInset(doc, edge, extent, mapArea) {
    doc.save();

    const drawEdge = (
      edgeData,
      color,
      lineWidth,
      showLabels = true,
      isMainEdge = false
    ) => {
      const p1 = this.transformCoordsForInset(
        edgeData.start[0],
        edgeData.start[1],
        extent,
        mapArea
      );
      const p2 = this.transformCoordsForInset(
        edgeData.end[0],
        edgeData.end[1],
        extent,
        mapArea
      );

      doc
        .moveTo(p1.x, p1.y)
        .lineTo(p2.x, p2.y)
        .lineWidth(lineWidth)
        .strokeColor(color)
        .stroke();

      const beaconRadius = isMainEdge ? 3 : 2;
      doc.circle(p1.x, p1.y, beaconRadius).fillColor("#0000FF").fill();
      doc.circle(p2.x, p2.y, beaconRadius).fillColor("#0000FF").fill();

      if (showLabels) {
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;

        const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        let angleDeg = (angle * 180) / Math.PI;

        if (angleDeg > 90 || angleDeg < -90) {
          angleDeg += 180;
        }

        const perpAngle = ((angleDeg - 90) * Math.PI) / 180;
        const labelOffset = 8;
        const offsetX = Math.cos(perpAngle) * labelOffset;
        const offsetY = Math.sin(perpAngle) * labelOffset;

        doc.save();
        doc.translate(midX + offsetX, midY + offsetY);
        doc.rotate(angleDeg);
        const _distText = (edgeData.distance || 0).toFixed(2) + "m";
        const _dirText = edgeData.direction || "?";
        const _fs = 7;
        const _dw = doc.widthOfString(_distText, { font: 'Helvetica', size: _fs });
        const _bw = doc.widthOfString(_dirText, { font: 'Helvetica', size: _fs });
        const _hp = 1.2;
        doc.rect(-_dw / 2 - _hp, -_fs / 2 - 4 - _hp, _dw + _hp * 2, _fs + _hp * 2).fillColor('#FFFFFF').fill();
        doc.rect(-_bw / 2 - _hp, -_fs / 2 + 6 - _hp, _bw + _hp * 2, _fs + _hp * 2).fillColor('#FFFFFF').fill();
        doc
          .fontSize(_fs)
          .font("Helvetica")
          .fillColor("#000000")
          .text(_distText, -_dw / 2, -_fs / 2 - 4, { lineBreak: false });
        doc
          .fontSize(_fs)
          .font("Helvetica")
          .fillColor("#333333")
          .text(_dirText, -_bw / 2, -_fs / 2 + 6, { lineBreak: false });
        doc.restore();
      }

      return { p1, p2 };
    };

    if (edge.prevEdge) {
      drawEdge(edge.prevEdge, "#888888", 0.75, false, false);
    }

    const shortEdge = {
      start: edge.start,
      end: edge.end,
      distance: edge.distance || edge.length || 0,
      direction: edge.direction || "?",
    };
    drawEdge(shortEdge, "#FF0000", 2.0, true, true);

    if (edge.nextEdge) {
      drawEdge(edge.nextEdge, "#888888", 0.75, false, false);
    }

    doc.restore();
  }

  transformCoordsForInset(y, x, extent, mapArea) {
    const rangeY = extent.maxY - extent.minY;
    const rangeX = extent.maxX - extent.minX;

    if (
      rangeY === 0 ||
      rangeX === 0 ||
      !isFinite(rangeY) ||
      !isFinite(rangeX)
    ) {
      this.logger.warn(
        "[Insets] Invalid extent range for coordinate transformation",
        { rangeY, rangeX, extent }
      );
      return {
        x: mapArea.x + mapArea.width / 2,
        y: mapArea.y + mapArea.height / 2,
      };
    }

    const normalizedY = (y - extent.minY) / rangeY;
    const normalizedX = (x - extent.minX) / rangeX;

    return {
      x: mapArea.x + normalizedY * mapArea.width,
      y: mapArea.y + (1 - normalizedX) * mapArea.height,
    };
  }

  drawSmallNorthArrow(doc, x, y) {
    doc.save();
    const size = 8;
    doc
      .moveTo(x, y - size)
      .lineTo(x - size / 3, y)
      .lineTo(x, y - size / 2)
      .lineTo(x + size / 3, y)
      .lineTo(x, y - size)
      .lineWidth(0.3)
      .strokeColor("#000000")
      .stroke();
    doc
      .fontSize(12)
      .font("Helvetica-Bold")
      .text("N", x - 4, y - size - 10);
    doc.restore();
  }

  drawSmallScaleBar(doc, x, y, length, scale) {
    doc.save();
    doc
      .rect(x, y - 2, length, 2)
      .lineWidth(0.3)
      .strokeColor("#000000")
      .stroke();
    const distanceM = ((length * PT_TO_MM) / 1000) * scale;
    doc
      .fontSize(4)
      .font("Helvetica")
      .text("0", x - 2, y + 1)
      .text(distanceM.toFixed(0) + "m", x + length - 5, y + 1);
    doc.restore();
  }
}
