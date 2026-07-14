/**
 * Shared schedule-column measurer: gives PDF and DXF identical inputs
 * to computeScheduleColumnWidths so the sheet planner sees identical
 * schedule block dimensions and makes identical placement decisions.
 *
 * 3-v8 follow-up: previously DXF measured with `length * size * 1.0`
 * (chosen so headers fit even in CAD viewers that ignore the STYLE
 * width factor), while PDF measured with PDFKit's widthOfString against
 * real Helvetica AFM metrics. The ~17% width gap caused the planner to
 * choose different anchor sides for the schedule on each format.
 *
 * This helper uses PDFKit (already a backend dependency) to measure
 * against Helvetica AFM metrics, but does NOT render anything — the
 * singleton document is never written. Both formats import this and
 * pass headerFontSize=6, bodyFontSize=7 so columnWidthsPt are bit-exact.
 *
 * Trade-off: DXF still renders sub-headers at hBody (7pt) while these
 * widths assume 6pt Helvetica-Bold headers. Bold-6 ≈ regular-7 in width,
 * so the overflow is small; CAD viewers that honor STYLE width factor
 * 0.55 see crisp fit. Non-compliant viewers (width factor 1.0) may see
 * minor overflow in the column-header row — accepted to gain block
 * placement parity with PDF.
 */

import PDFDocument from 'pdfkit';

let _doc = null;
function getDoc() {
  if (!_doc) {
    _doc = new PDFDocument({ size: 'A4', autoFirstPage: false });
  }
  return _doc;
}

/**
 * 3-v8 follow-up: PDF-Helvetica widths underestimate the space CAD viewers
 * need for the same text rendered with a DXF font (different metrics, fixed
 * STYLE width factor, etc.), so DXF schedule cells overflow on render.
 * Both formats share this measurer (single source for column widths feeds the
 * planner → identical PDF/DXF composite width), so the padding has to be
 * applied here. PDF gets slightly looser columns; DXF text comfortably
 * clears the column dividers.
 */
const SCHEDULE_COLUMN_PAD_FACTOR = 1.15;

/**
 * Build a (text, fontSize) => widthInPt measurer.
 *
 * @param {number} headerFontSize  pt size used for column headers
 * @param {number} bodyFontSize    pt size used for data cells
 * @returns {(text: string, fontSize: number) => number}
 */
export function buildScheduleMeasurer(headerFontSize, bodyFontSize) {
  const doc = getDoc();
  return (text, fontSize) => {
    if (fontSize === headerFontSize) {
      doc.font('Helvetica-Bold').fontSize(fontSize);
    } else {
      doc.font('Helvetica').fontSize(fontSize);
    }
    return doc.widthOfString(String(text)) * SCHEDULE_COLUMN_PAD_FACTOR;
  };
}
