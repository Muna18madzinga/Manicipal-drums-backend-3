/**
 * s74 Material Particulars certificate (PDF) — advisory evidence pack.
 * Not a Deeds registry instrument.
 */
const PDFDocument = require('pdfkit')

function buildEvidenceCertificatePdf({ subject, targetId, particulars = {}, officer }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 48, left: 48, right: 48 } })
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const ref = `VRDC-S74-${Date.now().toString(36).toUpperCase()}`
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#0b3d3a')
      .text('VUNGU RURAL DISTRICT COUNCIL')
    doc.font('Helvetica').fontSize(10).fillColor('#333')
      .text('Spatial Operations & Planning Platform')
    doc.moveDown(0.5)
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#111')
      .text('CERTIFICATE OF MATERIAL PARTICULARS')
    doc.font('Helvetica').fontSize(8).fillColor('#555')
      .text('Regional Town and Country Planning Act [Ch. 29:12] — s.74 (prima facie evidence).')
    doc.moveDown(0.6)
    doc.font('Helvetica').fontSize(9).fillColor('#111')
    doc.text(`Certificate reference: ${ref}`)
    doc.text(`Date: ${new Date().toISOString().slice(0, 10)}`)
    doc.text(`Subject type: ${subject || '—'}`)
    doc.text(`Target / case id: ${targetId || '—'}`)
    doc.text(`Prepared by: ${officer || '—'}`)
    doc.moveDown(0.5)
    doc.font('Helvetica-Bold').text('Particulars')
    doc.font('Helvetica')
    const entries = Object.entries(particulars || {})
    if (!entries.length) {
      doc.text('No additional particulars supplied.')
    } else {
      for (const [k, v] of entries) {
        doc.text(`• ${k}: ${v}`)
      }
    }
    doc.moveDown(0.8)
    doc.font('Helvetica').fontSize(8).fillColor('#444')
      .text(
        'This certificate is generated from Council operational records for use in '
        + 'planning and development-control proceedings. It is not a title deed, survey '
        + 'diagram or Deeds Registry endorsement. Verify against source registers before relying on it in court.',
        { align: 'justify' },
      )
    doc.end()
  })
}

module.exports = { buildEvidenceCertificatePdf }
