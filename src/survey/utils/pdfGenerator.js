import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Generate a PDF report for land parcels
 * @param {Array} parcels - Array of land parcel objects
 * @param {Object} project - Project information
 * @returns {Promise<Buffer>} - PDF file as buffer
 */
export async function generateLandParcelReport(parcels, project = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const buffers = [];
      
      // Collect PDF chunks
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });

      // Set document metadata
      doc.info['Title'] = 'Land Parcel Areas Report';
      doc.info['Author'] = 'Survey Task Manager';
      doc.info['Subject'] = `Land Parcel Areas for ${project.name || 'Project'}`;

      // Add header
      doc.fontSize(20).text('Land Parcel Areas Report', { align: 'center' });
      doc.moveDown();
      
      // Add project info if available
      if (project.name) {
        doc.fontSize(12).text(`Project: ${project.name}`);
      }
      if (project.location) {
        doc.text(`Location: ${project.location}`);
      }
      doc.text(`Report Date: ${new Date().toLocaleDateString()}`);
      doc.moveDown();

      // Add summary
      const validParcels = parcels.filter(p => p.area_ha !== null);
      const totalArea = validParcels.reduce((sum, p) => sum + parseFloat(p.area_ha), 0);
      const avgArea = validParcels.length > 0 ? totalArea / validParcels.length : 0;
      
      doc.fontSize(14).text('Summary', { underline: true });
      doc.fontSize(12).text(`Total Parcels: ${parcels.length}`);
      doc.text(`Parcels with Area Calculated: ${validParcels.length} of ${parcels.length}`);
      
      if (validParcels.length > 0) {
        doc.text(`Total Area: ${totalArea.toFixed(4)} ha`);
        doc.text(`Average Area: ${avgArea.toFixed(4)} ha`);
      } else {
        doc.text('No parcels have area calculations yet.');
      }
      
      doc.moveDown();

      // Add table header
      doc.fontSize(12).text('Parcel Details', { underline: true });
      doc.moveDown(0.5);
      
      // Table header
      const startY = doc.y;
      let currentY = startY;
      const col1 = 50;
      const col2 = 150;
      const col3 = 250;
      const col4 = 350;
      
      // Draw table header
      doc.font('Helvetica-Bold')
         .fontSize(10)
         .text('Stand', col1, currentY)
         .text('Area (ha)', col2, currentY)
         .text('Area (m²)', col3, currentY)
         .text('Perimeter (m)', col4, currentY);
      
      currentY += 20;
      
      // Draw horizontal line
      doc.moveTo(50, currentY - 5).lineTo(550, currentY - 5).stroke();
      
      // Add table rows
      doc.font('Helvetica').fontSize(10);
      
      parcels.forEach(parcel => {
        const areaHa = parcel.area_ha !== null ? parseFloat(parcel.area_ha).toFixed(4) : 'N/A';
        const areaM2 = parcel.area_m2 !== null ? parseInt(parcel.area_m2).toLocaleString() : 'N/A';
        const perimeter = parcel.perimeter_m !== null ? parseFloat(parcel.perimeter_m).toFixed(2) : 'N/A';
        
        doc.text(parcel.stand || 'N/A', col1, currentY)
          .text(areaHa, col2, currentY)
          .text(areaM2, col3, currentY)
          .text(perimeter, col4, currentY);
        
        currentY += 20;
        
        // Add new page if we're near the bottom
        if (currentY > 750) {
          doc.addPage();
          currentY = 50;
        }
      });

      // Add footer
      const pageCount = doc.bufferedPageRange().count;
      for (let i = 0; i < pageCount; i++) {
        doc.switchToPage(i);
        doc.fontSize(8)
           .text(
             `Page ${i + 1} of ${pageCount} | Generated on ${new Date().toLocaleString()}`,
             50,
             800,
             { align: 'center' }
           );
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

export default {
  generateLandParcelReport
};
