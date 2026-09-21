/**
 * One-click Council Map PDF — thematic summary from live catalogue status.
 * Not a QGIS print composer substitute; documents theme availability honestly.
 */
const PDFDocument = require('pdfkit')
const { getMasterThemeCatalogue } = require('../config/vunguMasterThemes')

function buildCouncilMapPdf({ subject = 'District overview', officer } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 40, bottom: 40, left: 40, right: 40 } })
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const themes = getMasterThemeCatalogue()
    const live = themes.filter((t) => t.status === 'live' || t.status === 'partial' || t.status === 'reference_osm')
    const missing = themes.filter((t) => t.status === 'unavailable' || t.status === 'schema_ready')

    doc.font('Helvetica-Bold').fontSize(16).fillColor('#0b3d3a').text('VUNGU RURAL DISTRICT COUNCIL')
    doc.font('Helvetica').fontSize(11).fillColor('#333').text('Council Map Pack — Spatial theme schedule')
    doc.moveDown(0.3)
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111').text(subject)
    doc.font('Helvetica').fontSize(9)
    doc.text(`Date: ${new Date().toISOString().slice(0, 10)}`)
    doc.text(`Prepared by: ${officer || '—'}`)
    doc.text('CRS for live layers: EPSG:4326 · Vector tiles via PostGIS')
    doc.moveDown(0.5)

    doc.font('Helvetica-Bold').fontSize(11).text('Live / reference themes (on the operational map)')
    doc.font('Helvetica').fontSize(8)
    live.forEach((t) => {
      doc.text(`• [${t.status}] ${t.theme} — ${t.layersPresent.join(', ') || 'see catalogue'}`)
    })

    doc.moveDown(0.5)
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#8a2b1a')
      .text('Not yet loaded (schema ready or unavailable — do not invent)')
    doc.font('Helvetica').fontSize(8).fillColor('#111')
    missing.forEach((t) => {
      doc.text(`• [${t.status}] ${t.theme} — ${t.note}`)
    })

    doc.moveDown(0.8)
    doc.font('Helvetica').fontSize(8).fillColor('#555')
      .text(
        'This schedule accompanies the interactive GIS Officer / Planner map. '
        + 'Cartographic print layouts from QGIS Server remain the format for sealed A1/A0 plans. '
        + 'OSM-derived layers are reference only and are not cadastral or legal title.',
      )
    doc.end()
  })
}

module.exports = { buildCouncilMapPdf }
