/**
 * Survey Plan Generator
 * Generates General Plans, Diagrams, and Working Plans for cadastral surveys
 * 
 * Plan Types:
 * 1. General Plan - Shows subdivision layout with stand numbers and areas
 * 2. Diagram - Detailed survey diagram with all measurements
 * 3. Working Plan - Field reference plan with coordinate points
 */

import PDFDocument from 'pdfkit'
import fs from 'fs'
import path from 'path'

/**
 * Generate General Plan (Developed or Undeveloped Portion)
 * 
 * @param {Object} options
 * @param {Object} options.project - Project details
 * @param {Array} options.parcels - Land parcels with geometry
 * @param {Array} options.coordinatePoints - Coordinate points
 * @param {string} options.planType - 'developed' or 'undeveloped'
 * @param {string} options.outputPath - Output file path
 */
export async function generateGeneralPlan(options) {
  const {
    project,
    parcels,
    coordinatePoints,
    planType = 'undeveloped',
    outputPath,
    metadata = {}
  } = options

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A3',
        layout: 'landscape',
        margins: { top: 30, bottom: 30, left: 30, right: 30 }
      })

      const stream = fs.createWriteStream(outputPath)
      doc.pipe(stream)

      // Page setup
      const pageWidth = doc.page.width
      const pageHeight = doc.page.height
      const margin = 30

      // Title block (top right)
      drawTitleBlock(doc, {
        planType: planType === 'developed' ? 'GENERAL PLAN - DEVELOPED PORTION' : 'GENERAL PLAN - UNDEVELOPED PORTION',
        projectName: project.name || 'Survey Project',
        location: project.location || '',
        surveyorName: metadata.surveyorName || project.surveyor || '',
        licenseNumber: metadata.licenseNumber || '',
        date: metadata.surveyDate || new Date().toISOString().split('T')[0],
        scale: metadata.scale || '1:1000',
        sheetNumber: metadata.sheetNumber || '1 of 1'
      })

      // Draw survey plan
      const planArea = {
        x: margin + 50,
        y: margin + 120,
        width: pageWidth - 2 * margin - 100,
        height: pageHeight - 2 * margin - 200
      }

      drawSurveyPlan(doc, planArea, parcels, coordinatePoints, {
        showDimensions: true,
        showAreas: true,
        showStandNumbers: true,
        showCoordinatePoints: true
      })

      // Legend (bottom left)
      drawLegend(doc, {
        x: margin,
        y: pageHeight - margin - 80,
        width: 200
      })

      // Schedule of Areas (bottom right)
      drawScheduleOfAreas(doc, parcels, {
        x: pageWidth - margin - 250,
        y: pageHeight - margin - 150,
        width: 250
      })

      // Notes section
      if (metadata.notes && metadata.notes.length > 0) {
        drawNotes(doc, metadata.notes, {
          x: margin + 220,
          y: pageHeight - margin - 80,
          width: 400
        })
      }

      // Surveyor's certificate (bottom center)
      drawSurveyorCertificate(doc, {
        x: pageWidth / 2 - 150,
        y: pageHeight - margin - 60,
        width: 300,
        surveyorName: metadata.surveyorName || '',
        licenseNumber: metadata.licenseNumber || '',
        date: metadata.surveyDate || new Date().toISOString().split('T')[0]
      })

      doc.end()

      stream.on('finish', () => {
        resolve(outputPath)
      })

      stream.on('error', reject)

    } catch (error) {
      reject(error)
    }
  })
}

/**
 * Draw title block
 */
function drawTitleBlock(doc, info) {
  const x = doc.page.width - 330
  const y = 30
  const width = 300
  const height = 100

  // Border
  doc.rect(x, y, width, height).stroke()

  // Title
  doc.fontSize(14).font('Helvetica-Bold')
  doc.text(info.planType, x + 10, y + 10, { width: width - 20, align: 'center' })

  // Project details
  doc.fontSize(10).font('Helvetica')
  doc.text(`Project: ${info.projectName}`, x + 10, y + 35)
  doc.text(`Location: ${info.location}`, x + 10, y + 50)
  doc.text(`Scale: ${info.scale}`, x + 10, y + 65)
  doc.text(`Date: ${info.date}`, x + 10, y + 80)

  // Surveyor info
  doc.fontSize(8)
  doc.text(`Surveyor: ${info.surveyorName}`, x + 150, y + 65)
  doc.text(`License: ${info.licenseNumber}`, x + 150, y + 80)
}

/**
 * Draw survey plan with parcels and coordinate points
 */
function drawSurveyPlan(doc, area, parcels, coordinatePoints, options) {
  if (!parcels || parcels.length === 0) {
    doc.fontSize(12).text('No parcels to display', area.x + area.width / 2 - 50, area.y + area.height / 2)
    return
  }

  // Calculate bounding box of all features
  const bounds = calculateBounds([...parcels, ...coordinatePoints])
  
  // Calculate scale to fit in area
  const scaleX = area.width / (bounds.maxY - bounds.minY)
  const scaleY = area.height / (bounds.maxX - bounds.minX)
  const scale = Math.min(scaleX, scaleY) * 0.9 // 90% to leave margin

  // Transform function: Cape Lo 31 (Y, X) to PDF coordinates
  const transform = (y, x) => {
    return {
      x: area.x + (y - bounds.minY) * scale,
      y: area.y + area.height - (x - bounds.minX) * scale
    }
  }

  // Draw border
  doc.rect(area.x, area.y, area.width, area.height).stroke()

  // Draw parcels
  parcels.forEach(parcel => {
    if (!parcel.geom || !parcel.geom.coordinates) return

    const coords = parcel.geom.coordinates[0] // Outer ring
    
    // Draw polygon
    doc.save()
    doc.fillOpacity(0.1)
    doc.strokeOpacity(1)
    
    const firstPoint = transform(coords[0][0], coords[0][1])
    doc.moveTo(firstPoint.x, firstPoint.y)
    
    for (let i = 1; i < coords.length; i++) {
      const point = transform(coords[i][0], coords[i][1])
      doc.lineTo(point.x, point.y)
    }
    
    doc.fillAndStroke('#ffeecc', '#000000')
    doc.restore()

    // Draw stand number and area in center
    if (options.showStandNumbers || options.showAreas) {
      const centroid = calculatePolygonCentroid(coords)
      const centroidPdf = transform(centroid.y, centroid.x)
      
      doc.fontSize(10).font('Helvetica-Bold')
      if (options.showStandNumbers && parcel.stand) {
        doc.text(parcel.stand, centroidPdf.x - 20, centroidPdf.y - 10, { width: 40, align: 'center' })
      }
      
      if (options.showAreas && parcel.area_ha) {
        doc.fontSize(8).font('Helvetica')
        doc.text(`${parcel.area_ha.toFixed(4)} ha`, centroidPdf.x - 20, centroidPdf.y + 5, { width: 40, align: 'center' })
      }
    }
  })

  // Draw coordinate points
  if (options.showCoordinatePoints && coordinatePoints) {
    coordinatePoints.forEach(point => {
      const pdfPoint = transform(point.y, point.x)
      
      // Draw point marker
      doc.circle(pdfPoint.x, pdfPoint.y, 2).fill('#ff0000')
      
      // Draw point label
      doc.fontSize(7).font('Helvetica')
      doc.text(point.name, pdfPoint.x + 4, pdfPoint.y - 3)
    })
  }

  // Draw north arrow
  drawNorthArrow(doc, area.x + area.width - 40, area.y + 30)
}

/**
 * Calculate bounding box
 */
function calculateBounds(features) {
  let minY = Infinity, maxY = -Infinity
  let minX = Infinity, maxX = -Infinity

  features.forEach(feature => {
    if (feature.geom && feature.geom.coordinates) {
      // Parcel (polygon)
      const coords = feature.geom.coordinates[0]
      coords.forEach(coord => {
        minY = Math.min(minY, coord[0])
        maxY = Math.max(maxY, coord[0])
        minX = Math.min(minX, coord[1])
        maxX = Math.max(maxX, coord[1])
      })
    } else if (feature.y !== undefined && feature.x !== undefined) {
      // Coordinate point
      minY = Math.min(minY, feature.y)
      maxY = Math.max(maxY, feature.y)
      minX = Math.min(minX, feature.x)
      maxX = Math.max(maxX, feature.x)
    }
  })

  return { minY, maxY, minX, maxX }
}

/**
 * Calculate polygon centroid
 */
function calculatePolygonCentroid(coords) {
  let sumY = 0, sumX = 0
  const count = coords.length - 1 // Exclude closing point
  
  for (let i = 0; i < count; i++) {
    sumY += coords[i][0]
    sumX += coords[i][1]
  }
  
  return {
    y: sumY / count,
    x: sumX / count
  }
}

/**
 * Draw north arrow
 */
function drawNorthArrow(doc, x, y) {
  doc.save()
  
  // Arrow
  doc.moveTo(x, y + 20)
  doc.lineTo(x, y)
  doc.lineTo(x - 5, y + 10)
  doc.moveTo(x, y)
  doc.lineTo(x + 5, y + 10)
  doc.stroke()
  
  // N label
  doc.fontSize(10).font('Helvetica-Bold')
  doc.text('N', x - 3, y - 15)
  
  doc.restore()
}

/**
 * Draw legend
 */
function drawLegend(doc, area) {
  doc.fontSize(10).font('Helvetica-Bold')
  doc.text('LEGEND', area.x, area.y)
  
  doc.fontSize(8).font('Helvetica')
  let yPos = area.y + 15
  
  // Parcel boundary
  doc.rect(area.x, yPos, 15, 10).stroke()
  doc.text('Parcel Boundary', area.x + 20, yPos + 2)
  yPos += 15
  
  // Coordinate point
  doc.circle(area.x + 7, yPos + 5, 2).fill('#ff0000')
  doc.text('Coordinate Point', area.x + 20, yPos + 2)
}

/**
 * Draw schedule of areas
 */
function drawScheduleOfAreas(doc, parcels, area) {
  doc.fontSize(10).font('Helvetica-Bold')
  doc.text('SCHEDULE OF AREAS', area.x, area.y)
  
  // Table header
  doc.fontSize(8).font('Helvetica-Bold')
  let yPos = area.y + 15
  doc.text('Stand', area.x, yPos)
  doc.text('Area (ha)', area.x + 100, yPos)
  doc.text('Area (m²)', area.x + 160, yPos)
  
  // Underline
  doc.moveTo(area.x, yPos + 12).lineTo(area.x + area.width, yPos + 12).stroke()
  yPos += 18
  
  // Table rows
  doc.font('Helvetica')
  let totalArea = 0
  
  parcels.forEach(parcel => {
    if (yPos > area.y + 120) return // Prevent overflow
    
    doc.text(parcel.stand || '-', area.x, yPos)
    doc.text((parcel.area_ha || 0).toFixed(4), area.x + 100, yPos)
    doc.text((parcel.area_m2 || 0).toFixed(2), area.x + 160, yPos)
    
    totalArea += parcel.area_ha || 0
    yPos += 12
  })
  
  // Total
  doc.moveTo(area.x, yPos).lineTo(area.x + area.width, yPos).stroke()
  yPos += 5
  doc.font('Helvetica-Bold')
  doc.text('TOTAL', area.x, yPos)
  doc.text(totalArea.toFixed(4), area.x + 100, yPos)
  doc.text((totalArea * 10000).toFixed(2), area.x + 160, yPos)
}

/**
 * Draw notes section
 */
function drawNotes(doc, notes, area) {
  doc.fontSize(10).font('Helvetica-Bold')
  doc.text('NOTES', area.x, area.y)
  
  doc.fontSize(8).font('Helvetica')
  let yPos = area.y + 15
  
  notes.forEach((note, index) => {
    doc.text(`${index + 1}. ${note}`, area.x, yPos, { width: area.width })
    yPos += 12
  })
}

/**
 * Draw surveyor's certificate
 */
function drawSurveyorCertificate(doc, area) {
  doc.rect(area.x, area.y, area.width, 50).stroke()
  
  doc.fontSize(8).font('Helvetica')
  doc.text('I certify that this plan is correct and was prepared by me.', area.x + 10, area.y + 10, { width: area.width - 20, align: 'center' })
  
  doc.text('_____________________', area.x + 10, area.y + 30)
  doc.text('Signature', area.x + 10, area.y + 42)
  
  doc.text(`${area.surveyorName}`, area.x + 150, area.y + 30)
  doc.text(`License No: ${area.licenseNumber}`, area.x + 150, area.y + 42)
}

/**
 * Generate Diagram (detailed survey diagram)
 */
export async function generateDiagram(options) {
  // TODO: Implement detailed diagram with all measurements, bearings, distances
  throw new Error('Diagram generation not yet implemented')
}

/**
 * Generate Working Plan
 */
export async function generateWorkingPlan(options) {
  // TODO: Implement working plan for field reference
  throw new Error('Working Plan generation not yet implemented')
}

export default {
  generateGeneralPlan,
  generateDiagram,
  generateWorkingPlan
}
