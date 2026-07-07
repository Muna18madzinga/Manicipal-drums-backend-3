/**
 * SI 727 of 1979 - Zimbabwe Land Survey Rules and Regulations
 * Constants for automated survey plan production
 */

// ISO A-series Sheet Sizes (Approved by Surveyor-General for survey plans)
// Landscape orientation by default (width > height)
export const SI727_SHEET_SIZES = [
  { code: 'ISO A2', name: 'ISO_A2', width: 594, height: 420, area: 249480 },
  { code: 'ISO A1', name: 'ISO_A1', width: 841, height: 594, area: 499554 },
  { code: 'ISO A0', name: 'ISO_A0', width: 1189, height: 841, area: 999949 }
]

// Regulation 63 - Margins
export const SI727_MARGINS = {
  left: 50,      // mm
  right: 150,    // mm (for Surveyor-General endorsements)
  top: 50,       // mm
  bottom: 50     // mm
}

// Regulation 32(2) - Prescribed Scales
// Base scales: 1:1000, 1:1250, 1:1500, 1:2000, 1:2500, 1:3000, 1:4000, 1:5000, 1:6000, 1:7500
// Plus any of these scales multiplied or divided by an integral power of 10
export const SI727_BASE_SCALES = [1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 7500]

export const SI727_PRESCRIBED_SCALES = [
  // Detailed scales (÷10)
  { value: 100, label: '1:100', category: 'detailed', power: -1 },
  { value: 125, label: '1:125', category: 'detailed', power: -1 },
  { value: 150, label: '1:150', category: 'detailed', power: -1 },
  { value: 200, label: '1:200', category: 'detailed', power: -1 },
  { value: 250, label: '1:250', category: 'detailed', power: -1 },
  { value: 300, label: '1:300', category: 'detailed', power: -1 },
  { value: 400, label: '1:400', category: 'detailed', power: -1 },
  { value: 500, label: '1:500', category: 'detailed', power: -1 },
  { value: 600, label: '1:600', category: 'detailed', power: -1 },
  { value: 750, label: '1:750', category: 'detailed', power: -1 },
  
  // Base scales (×1)
  { value: 1000, label: '1:1000', category: 'base', power: 0 },
  { value: 1250, label: '1:1250', category: 'base', power: 0 },
  { value: 1500, label: '1:1500', category: 'base', power: 0 },
  { value: 2000, label: '1:2000', category: 'base', power: 0 },
  { value: 2500, label: '1:2500', category: 'base', power: 0 },
  { value: 3000, label: '1:3000', category: 'base', power: 0 },
  { value: 4000, label: '1:4000', category: 'base', power: 0 },
  { value: 5000, label: '1:5000', category: 'base', power: 0 },
  { value: 6000, label: '1:6000', category: 'base', power: 0 },
  { value: 7500, label: '1:7500', category: 'base', power: 0 },
  
  // Regional scales (×10)
  { value: 10000, label: '1:10000', category: 'regional', power: 1 },
  { value: 12500, label: '1:12500', category: 'regional', power: 1 },
  { value: 15000, label: '1:15000', category: 'regional', power: 1 },
  { value: 20000, label: '1:20000', category: 'regional', power: 1 },
  { value: 25000, label: '1:25000', category: 'regional', power: 1 },
  { value: 30000, label: '1:30000', category: 'regional', power: 1 },
  { value: 40000, label: '1:40000', category: 'regional', power: 1 },
  { value: 50000, label: '1:50000', category: 'regional', power: 1 },
  { value: 60000, label: '1:60000', category: 'regional', power: 1 },
  { value: 75000, label: '1:75000', category: 'regional', power: 1 }
]

// Helper function to check if a scale is SI 727 compliant
export function isValidSI727Scale(scale) {
  return SI727_PRESCRIBED_SCALES.some(s => s.value === scale)
}

/**
 * Select the SI 727 scale that ENLARGES the figure to dominate the sheet —
 * the largest prescribed scale (smallest denominator) whose drawing still fits
 * the sheet's available drawing area. A declared scale is honoured only when it
 * also fits; otherwise the figure is enlarged (declared too small) or shrunk
 * (declared overflows) to the best-fitting prescribed scale.
 *
 * SHARED by both generators (pdfkitGeoPDF.js + dxfGenerator.js) so PDF and DXF
 * always resolve to the SAME scale → PDF↔DXF parity / lockstep. Deterministic:
 * identical inputs ⇒ identical output, regardless of which generator calls it.
 *
 * @param {Object}  p
 * @param {number}  p.drawWidthM    Figure width in ground metres
 * @param {number}  p.drawHeightM   Figure height in ground metres
 * @param {number}  p.paperWmm      Sheet width (mm)
 * @param {number}  p.paperHmm      Sheet height (mm)
 * @param {number} [p.declaredScale] Caller-requested denominator (honoured iff it fits)
 * @param {number} [p.reserveW=0.72] Fraction of content width available to the figure
 * @param {number} [p.reserveH=0.85] Fraction of content height available to the figure
 * @returns {{ S:number, minScaleToFit:number, fitScale:number, honoredDeclared:boolean }}
 */
export function selectFigureScale({
  drawWidthM, drawHeightM, paperWmm, paperHmm,
  declaredScale = null, reserveW = 0.72, reserveH = 0.85,
  minDenominator = 0,
}) {
  // SI 727 margins: 50 left, 150 right (SG endorsements), 50 top/bottom (mm).
  const contentW = paperWmm - 50 - 150;
  const contentH = paperHmm - 50 - 50;
  const availW = contentW * reserveW; // remainder reserved for schedule/co-ord blocks
  const availH = contentH * reserveH; // remainder reserved for the title strip
  const minScaleToFit = Math.max(
    (drawWidthM * 1000) / availW,
    (drawHeightM * 1000) / availH,
    1, // guard against zero-extent degenerate input
  );
  const ladder = SI727_PRESCRIBED_SCALES.map((s) => s.value).sort((a, b) => a - b);
  let fitScale = ladder.find((v) => v >= minScaleToFit) || ladder[ladder.length - 1];
  // SI 727 Reg 32(3) mandate floor: never ENLARGE finer than minDenominator
  // (e.g. 1:500 for developed/undeveloped general plans). A coarser fit (figure
  // too big for the mandated scale) is left untouched — the caller tiles.
  if (minDenominator > 0 && fitScale < minDenominator) fitScale = minDenominator;
  const honoredDeclared = !!(declaredScale && declaredScale >= minScaleToFit);
  return {
    S: honoredDeclared ? declaredScale : fitScale,
    minScaleToFit,
    fitScale,
    honoredDeclared,
  };
}

// Helper function to get the nearest valid SI 727 scale
export function getNearestValidScale(targetScale) {
  return SI727_PRESCRIBED_SCALES.reduce((nearest, current) => {
    const currentDiff = Math.abs(current.value - targetScale)
    const nearestDiff = Math.abs(nearest.value - targetScale)
    return currentDiff < nearestDiff ? current : nearest
  })
}

// Regulation 32(2) - Minimum figure size
export const MIN_FIGURE_SIZE_MM2 = 650

// Layout component dimensions
export const LAYOUT_COMPONENTS = {
  titleBlock: { heightSmall: 60, heightMedium: 80, heightLarge: 100 },
  beaconDescriptions: { minHeight: 40, lineHeight: 12, indent: 20 },
  scaleBar: { width: 300, height: 30 },
  scheduleOfAreas: { width: 300, minHeight: 70, rowHeight: 8 },
  keyPlanInset: { size: 120 },
  northArrow: { size: 40 }
}
