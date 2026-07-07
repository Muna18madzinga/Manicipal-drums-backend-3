/**
 * Draw Schedule of Areas - Multi-table layout (when single table exceeds available height)
 * Splits parcels into multiple side-by-side tables, each anchored at bottom and growing upwards
 * 
 * @param {Object} doc - PDFKit document
 * @param {Object} parcels - GeoJSON parcels data
 * @param {number} startX - Starting X position for first table
 * @param {number} startY - Starting Y position (top of first table)
 * @param {Object} mapBounds - Map boundary dimensions
 * @param {number} maxRowsPerTable - Maximum rows that fit in one table
 */
function drawScheduleOfAreasMultiTable(doc, parcels, startX, startY, mapBounds, maxRowsPerTable) {
  const standCount = parcels.features.length;
  
  // Table dimensions
  const colStand = 35;
  const colArea = 60;
  const colDiagram = 40;
  const colDeedNumber = 40;
  const colDeedDate = 35;
  const colSurveyor = 50;
  const tableWidth = colStand + colArea + colDiagram + colDeedNumber + colDeedDate + colSurveyor; // 260pt
  const rowHeight = 15;
  const headerHeight = 25;
  const titleHeight = 15;
  const titleSpacing = 15;
  const tableSpacing = 10; // Space between tables horizontally
  
  // Calculate how many tables needed
  const numTables = Math.ceil(standCount / maxRowsPerTable);
  
  // Calculate available width for tables
  const availableWidth = mapBounds.width - (startX - mapBounds.x) - 5;
  const totalTablesWidth = (numTables * tableWidth) + ((numTables - 1) * tableSpacing);
  
  if (totalTablesWidth > availableWidth) {
    console.warn(`[PDFKit] ⚠️  ${numTables} tables (${totalTablesWidth}pt) exceed available width (${availableWidth}pt)`);
  }
  
  console.log(`[PDFKit] 📊 Splitting Schedule of Areas: ${standCount} stands into ${numTables} tables (${maxRowsPerTable} rows each)`);
  
  // Draw each table
  let currentTableX = startX;
  let parcelIndex = 0;
  
  for (let tableNum = 0; tableNum < numTables; tableNum++) {
    // Calculate how many rows in this table
    const rowsInThisTable = Math.min(maxRowsPerTable, standCount - parcelIndex);
    const parcelsForThisTable = parcels.features.slice(parcelIndex, parcelIndex + rowsInThisTable);
    
    // Draw table title
    doc.save();
    doc.fontSize(9)
       .font('Helvetica-Bold')
       .fillColor('#000000')
       .text(tableNum === 0 ? 'SCHEDULE OF AREAS' : `SCHEDULE OF AREAS (cont'd)`, currentTableX, startY, {
         width: tableWidth,
         align: 'center'
       });
    
    // Draw table header
    const headerY = startY + titleSpacing;
    doc.lineWidth(0.5);
    
    // Draw outer border
    doc.rect(currentTableX, headerY, tableWidth, headerHeight).stroke();
    
    // Draw vertical lines for columns
    let currentX = currentTableX + colStand;
    doc.moveTo(currentX, headerY).lineTo(currentX, headerY + headerHeight).stroke();
    
    currentX += colArea;
    doc.moveTo(currentX, headerY).lineTo(currentX, headerY + headerHeight).stroke();
    
    currentX += colDiagram;
    doc.moveTo(currentX, headerY).lineTo(currentX, headerY + headerHeight).stroke();
    
    currentX += colDeedNumber;
    doc.moveTo(currentX, headerY).lineTo(currentX, headerY + headerHeight).stroke();
    
    currentX += colDeedDate;
    doc.moveTo(currentX, headerY).lineTo(currentX, headerY + headerHeight).stroke();
    
    // Draw horizontal line separating DEED header from sub-headers
    const deedHeaderY = headerY + 12;
    const deedStartX = currentTableX + colStand + colArea + colDiagram;
    doc.moveTo(deedStartX, deedHeaderY).lineTo(deedStartX + colDeedNumber + colDeedDate, deedHeaderY).stroke();
    
    // Header text
    doc.fontSize(9).font('Helvetica-Bold');
    
    // STAND No.
    doc.text('STAND', currentTableX + 2, headerY + 4, { width: colStand - 4, align: 'center' });
    doc.text('No.', currentTableX + 2, headerY + 10, { width: colStand - 4, align: 'center' });
    
    // AREAS SQUARE METRES
    doc.text('AREAS', currentTableX + colStand + 2, headerY + 2, { width: colArea - 4, align: 'center' });
    doc.text('SQUARE', currentTableX + colStand + 2, headerY + 8, { width: colArea - 4, align: 'center' });
    doc.text('METRES', currentTableX + colStand + 2, headerY + 14, { width: colArea - 4, align: 'center' });
    
    // DIAGRAM NUMBER
    doc.text('DIAGRAM', currentTableX + colStand + colArea + 2, headerY + 4, { width: colDiagram - 4, align: 'center' });
    doc.text('NUMBER', currentTableX + colStand + colArea + 2, headerY + 10, { width: colDiagram - 4, align: 'center' });
    
    // DEED
    doc.text('DEED', deedStartX + 2, headerY + 2, { width: colDeedNumber + colDeedDate - 4, align: 'center' });
    doc.text('NUMBER', deedStartX + 2, deedHeaderY + 2, { width: colDeedNumber - 4, align: 'center' });
    doc.text('DATE', deedStartX + colDeedNumber + 2, deedHeaderY + 2, { width: colDeedDate - 4, align: 'center' });
    
    // SURVEYOR-GENERAL
    doc.text('SURVEYOR-', currentTableX + tableWidth - colSurveyor + 2, headerY + 4, { width: colSurveyor - 4, align: 'center' });
    doc.text('GENERAL', currentTableX + tableWidth - colSurveyor + 2, headerY + 10, { width: colSurveyor - 4, align: 'center' });
    
    // Draw rows
    let currentY = headerY + headerHeight;
    
    parcelsForThisTable.forEach((parcel, index) => {
      const stand = parcel.properties.stand || `P${parcelIndex + index + 1}`;
      const areaM2 = parcel.properties.area_m2 || 0;
      
      // Format area using banker's rounding (whole numbers)
      const areaFormatted = Math.round(areaM2).toString();
      
      // Draw row border
      doc.rect(currentTableX, currentY, tableWidth, rowHeight).stroke();
      
      // Draw vertical lines
      currentX = currentTableX + colStand;
      doc.moveTo(currentX, currentY).lineTo(currentX, currentY + rowHeight).stroke();
      
      currentX += colArea;
      doc.moveTo(currentX, currentY).lineTo(currentX, currentY + rowHeight).stroke();
      
      currentX += colDiagram;
      doc.moveTo(currentX, currentY).lineTo(currentX, currentY + rowHeight).stroke();
      
      currentX += colDeedNumber;
      doc.moveTo(currentX, currentY).lineTo(currentX, currentY + rowHeight).stroke();
      
      currentX += colDeedDate;
      doc.moveTo(currentX, currentY).lineTo(currentX, currentY + rowHeight).stroke();
      
      // Row data
      doc.fontSize(9).font('Helvetica');
      doc.text(stand, currentTableX + 2, currentY + 4, { width: colStand - 4, align: 'center', lineBreak: false });
      doc.text(areaFormatted, currentTableX + colStand + 2, currentY + 4, { width: colArea - 4, align: 'center', lineBreak: false });
      
      currentY += rowHeight;
    });
    
    doc.restore();
    
    // Move to next table position
    currentTableX += tableWidth + tableSpacing;
    parcelIndex += rowsInThisTable;
  }
  
  console.log(`[PDFKit] ✅ Drew ${numTables} Schedule of Areas tables`);
}

module.exports = { drawScheduleOfAreasMultiTable };
