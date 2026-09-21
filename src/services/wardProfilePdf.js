/**
 * Ward Spatial Profile PDF — live counts from PostGIS where available.
 */
const PDFDocument = require('pdfkit')

async function fetchWardFacts(pg, wardName) {
  const facts = {
    wardName,
    areaHa: null,
    parcelCount: null,
    standCount: null,
    roadKm: null,
    waterwayCount: null,
    note: null,
  }
  try {
    const w = await pg.query(
      `SELECT name_en,
              ROUND((ST_Area(geom::geography) / 10000.0)::numeric, 2) AS area_ha
         FROM wards
        WHERE name_en ILIKE $1
        LIMIT 1`,
      [wardName],
    )
    if (w.rows[0]) {
      facts.wardName = w.rows[0].name_en
      facts.areaHa = Number(w.rows[0].area_ha)
    } else {
      facts.note = 'Ward polygon not found by that name in the wards layer.'
    }
  } catch (e) {
    facts.note = 'Ward query failed: ' + (e.message || 'error')
  }

  try {
    if (facts.areaHa != null) {
      const stands = await pg.query(
        `SELECT COUNT(*)::int AS n
           FROM stands s
           JOIN wards w ON ST_Intersects(s.geom, w.geom)
          WHERE w.name_en = $1`,
        [facts.wardName],
      )
      facts.standCount = stands.rows[0]?.n ?? 0
    }
  } catch { /* stands table shape may differ */ }

  try {
    const roads = await pg.query(
      `SELECT ROUND((SUM(ST_Length(r.geom::geography)) / 1000.0)::numeric, 2) AS km
         FROM roads r
         JOIN wards w ON ST_Intersects(ST_SetSRID(r.geom, 4326), w.geom)
        WHERE w.name_en = $1`,
      [facts.wardName],
    )
    facts.roadKm = roads.rows[0]?.km != null ? Number(roads.rows[0].km) : null
  } catch { /* ignore */ }

  try {
    const ww = await pg.query(
      `SELECT COUNT(*)::int AS n
         FROM waterways ww
         JOIN wards w ON ST_Intersects(ST_SetSRID(ww.geom, 4326), w.geom)
        WHERE w.name_en = $1`,
      [facts.wardName],
    )
    facts.waterwayCount = ww.rows[0]?.n ?? null
  } catch { /* ignore */ }

  return facts
}

function buildWardProfilePdf(facts, officer) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 48, left: 48, right: 48 } })
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.font('Helvetica-Bold').fontSize(14).fillColor('#0b3d3a').text('VUNGU RURAL DISTRICT COUNCIL')
    doc.font('Helvetica').fontSize(10).fillColor('#333').text('Ward Spatial Profile')
    doc.moveDown(0.5)
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111').text(facts.wardName || 'Ward')
    doc.font('Helvetica').fontSize(9)
    doc.text(`Generated: ${new Date().toISOString().slice(0, 10)}`)
    doc.text(`Officer: ${officer || '—'}`)
    doc.text('CRS: EPSG:4326')
    doc.moveDown(0.6)
    doc.font('Helvetica-Bold').text('Spatial summary (live PostGIS)')
    doc.font('Helvetica')
    doc.text(`Area: ${facts.areaHa != null ? facts.areaHa + ' ha' : '—'}`)
    doc.text(`Stands intersecting ward: ${facts.standCount ?? '—'}`)
    doc.text(`Road length (reference layer): ${facts.roadKm != null ? facts.roadKm + ' km' : '—'}`)
    doc.text(`Waterway segments: ${facts.waterwayCount ?? '—'}`)
    if (facts.note) {
      doc.moveDown(0.4)
      doc.fillColor('#8a2b1a').text(facts.note)
      doc.fillColor('#111')
    }
    doc.moveDown(0.8)
    doc.font('Helvetica').fontSize(8).fillColor('#555')
      .text(
        'Counts use intersecting operational layers. OSM-derived roads/waterways are reference. '
        + 'Population, schools and clinics appear only when authoritative registers are loaded — never invented.',
      )
    doc.end()
  })
}

module.exports = { fetchWardFacts, buildWardProfilePdf }
