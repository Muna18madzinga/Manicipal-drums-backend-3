/**
 * Server-side Site Planning Screening Report (PDF).
 * Built from live PostGIS site-context — never invents parcels or constraints.
 * Advisory only: the planner retains determination authority.
 */
const PDFDocument = require('pdfkit')

function line(doc, label, value) {
  const v = value == null || value === '' ? '—' : String(value)
  doc.font('Helvetica-Bold').fontSize(9).text(`${label}: `, { continued: true })
  doc.font('Helvetica').text(v)
}

function section(doc, title) {
  doc.moveDown(0.6)
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0b3d3a').text(title)
  doc.fillColor('#111')
  doc.moveDown(0.25)
  doc.moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor('#c5cdd6').lineWidth(0.5).stroke()
  doc.moveDown(0.35)
}

/**
 * @param {object} opts
 * @param {object} opts.siteContext  from buildSiteContext
 * @param {object} [opts.summary]    optional client/server summary
 * @param {object} [opts.meta]       case / officer metadata
 * @returns {Promise<Buffer>}
 */
function buildSiteAssessmentPdf({ siteContext, summary, meta = {} }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 48, bottom: 48, left: 48, right: 48 },
      info: {
        Title: 'Vungu RDC — Site Planning Screening Report',
        Author: 'Vungu RDC Spatial Operations Platform',
        Subject: 'GIS screening (advisory)',
      },
    })
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const p = siteContext?.parcel || {}
    const water = siteContext?.water || { streams: [], waterAreas: [] }
    const roads = siteContext?.roads || []
    const protectedAreas = siteContext?.protected || []
    const landuse = siteContext?.landuse || []
    const settlements = siteContext?.settlements || []
    const amenities = siteContext?.amenities || { schools: [], health: [] }
    const buildings = siteContext?.buildings || { count: 0 }

    // Header
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#0b3d3a')
      .text('VUNGU RURAL DISTRICT COUNCIL')
    doc.font('Helvetica').fontSize(10).fillColor('#333')
      .text('Spatial Operations & Planning Platform')
    doc.moveDown(0.4)
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111')
      .text('SITE PLANNING SCREENING REPORT')
    doc.font('Helvetica').fontSize(8).fillColor('#555')
      .text('Advisory GIS screening only — does not approve or refuse development.')
    doc.moveDown(0.3)
    line(doc, 'Document date', new Date().toISOString().slice(0, 10))
    line(doc, 'Prepared for', meta.preparedFor || 'Town Planning')
    line(doc, 'Officer', meta.officer || '—')
    line(doc, 'Application ref', meta.applicationRef || '—')
    line(doc, 'CRS', 'EPSG:4326 (WGS 84)')

    section(doc, '1. Site identification')
    line(doc, 'Layer', p.layer)
    line(doc, 'Feature ID', p.fid)
    line(doc, 'Name / label', p.name)
    line(doc, 'Area (ha)', p.areaHa != null ? Number(p.areaHa).toFixed(3) : null)
    line(doc, 'Perimeter (m)', p.perimeterM != null ? Math.round(p.perimeterM) : null)
    line(doc, 'Centroid', Array.isArray(p.centroid) ? `${p.centroid[0]?.toFixed?.(5)}, ${p.centroid[1]?.toFixed?.(5)}` : null)
    line(doc, 'Geometry valid', p.rawValid === false ? 'No — review required' : 'Yes / assumed valid')
    line(doc, 'Developable (ha)', siteContext?.developableHa != null ? Number(siteContext.developableHa).toFixed(3) : null)

    section(doc, '2. Land use & built form')
    if (!landuse.length) {
      doc.font('Helvetica').fontSize(9).text('No intersecting land-use polygons in the operational catalogue.')
    } else {
      landuse.slice(0, 12).forEach((lu) => {
        doc.font('Helvetica').fontSize(9)
          .text(`• ${lu.fclass || 'unclassified'} — ${lu.areaHa != null ? Number(lu.areaHa).toFixed(2) + ' ha' : 'area n/a'}`)
      })
    }
    line(doc, 'Buildings on parcel', `${buildings.count || 0} (total footprint ≈ ${buildings.totalAreaSqm != null ? Math.round(buildings.totalAreaSqm) + ' m²' : 'n/a'})`)

    section(doc, '3. Access & infrastructure')
    if (!roads.length) {
      doc.font('Helvetica').fontSize(9).text('No road features intersecting this parcel in the roads layer.')
    } else {
      roads.slice(0, 10).forEach((r) => {
        doc.font('Helvetica').fontSize(9)
          .text(`• ${r.name || 'Unnamed'} (${r.fclass || 'class n/a'}${r.ref ? `, ref ${r.ref}` : ''})`)
      })
    }

    section(doc, '4. Water, environment & constraints')
    line(doc, 'Streams / waterways intersecting', water.streams?.length || 0)
    line(doc, 'Water areas / wetlands', water.waterAreas?.length || 0)
    line(doc, 'Protected area overlays', protectedAreas.length)
    if (summary?.constraints?.length) {
      doc.moveDown(0.2)
      doc.font('Helvetica-Bold').fontSize(9).text('Screening flags')
      summary.constraints.forEach((c) => {
        doc.font('Helvetica').fontSize(9)
          .fillColor(c.ok ? '#1a5c56' : '#8a2b1a')
          .text(`${c.ok ? '✓' : '!'} ${c.label}`)
      })
      doc.fillColor('#111')
    }
    doc.moveDown(0.2)
    doc.font('Helvetica').fontSize(8).fillColor('#555')
      .text('Stream-bank / wetland distances use the platform’s statutory 30 m review buffer where configured. Other distances are council review aids, not automatic refusals.')
    doc.fillColor('#111')

    section(doc, '5. Settlement & social facilities (nearby)')
    line(doc, 'Settlements identified', settlements.length)
    settlements.slice(0, 8).forEach((s) => {
      doc.font('Helvetica').fontSize(9)
        .text(`• ${s.name || 'Unnamed'} (${s.fclass || 'n/a'})${s.distKm != null ? ` — ${Number(s.distKm).toFixed(1)} km` : ''}`)
    })
    line(doc, 'Schools (catalogue)', Array.isArray(amenities.schools) ? amenities.schools.length : 0)
    line(doc, 'Health facilities (catalogue)', Array.isArray(amenities.health) ? amenities.health.length : 0)

    section(doc, '6. Referrals suggested by screening')
    const refs = summary?.requiredReferrals || ['Engineering', 'Fire']
    doc.font('Helvetica').fontSize(9).text(refs.join(', '))

    section(doc, '7. Disclaimer & data notes')
    doc.font('Helvetica').fontSize(8).fillColor('#444')
      .text(
        'This report is generated from the operational PostGIS catalogue for Vungu RDC. '
        + 'OpenStreetMap-derived layers are reference context and are not cadastral or legal title. '
        + 'Missing themes are omitted rather than fabricated. The planner / Local Planning Authority '
        + 'retains full determination authority under the Regional Town and Country Planning Act.',
        { align: 'justify' },
      )
    doc.moveDown(0.8)
    doc.fillColor('#111')
    line(doc, 'Data source', 'Vungu RDC Spatial Operations Platform / PostGIS')
    line(doc, 'Report id', `VRDC-SCR-${Date.now().toString(36).toUpperCase()}`)

    doc.end()
  })
}

module.exports = { buildSiteAssessmentPdf }
