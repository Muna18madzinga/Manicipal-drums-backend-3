/**
 * Survey Plan Preview API
 * Provides data for MapLibre visualization
 */

import { analyzeSurvey } from '../utils/surveyAnalyzer.js'
import { determineOptimalScale } from '../utils/scaleSelector.js'
import { determineOptimalSheetSize, calculateSI727Layout } from '../utils/si727LayoutCalculator.js'
import { buildTopology } from '../utils/topologyBuilder.js'
import { placeLabels } from '../utils/labelPlacer.js'
import { formatArea } from '../utils/formatters.js'
import { calculateBeaconSymbolSize, calculateBeaconLabelSize } from '../utils/beaconSymbolStandards.js'
import { authenticateWithSchema } from '../utils/schemaAuth.js'
import { SI727_PRESCRIBED_SCALES } from '../utils/si727Constants.js'

/**
 * Survey Plan Preview Routes
 */
export default async function surveyPlanPreviewRoutes(fastify, options) {
  
  /**
   * GET /api/survey-plan/preview/:projectId
   * Get complete preview data for survey plan
   */
  fastify.get('/preview/:projectId', {
    preHandler: [fastify.authenticate, authenticateWithSchema]
  }, async (request, reply) => {
    const { projectId } = request.params
    const { scale, sheetSize, areaType, planType } = request.query

    // SI 727 Reg 32(3): developed township → max denominator 500
    const SI727_MAX_DENOM_BY_PLAN = { 'general-developed': 500 }
    const maxDenominator = planType ? (SI727_MAX_DENOM_BY_PLAN[planType] ?? Infinity) : Infinity
    
    try {
      // 1. Use database connection with surveyor schema (set by authenticateWithSchema middleware)
      const db = request.db
      
      // 2. Fetch coordinate points from surveyor schema
      // FIX: ST_X returns X (Southing), ST_Y returns Y (Westing)
      // Cape Lo convention: Y=Southing, X=Westing, so swap the assignment
      const pointsResult = await db.query(
        `SELECT name, ST_Y(geom) as y, ST_X(geom) as x, description
         FROM coordinate_points 
         WHERE project_id = $1
         ORDER BY name`,
        [projectId]
      )
      
      if (pointsResult.rows.length === 0) {
        return reply.code(404).send({ 
          error: 'No coordinate points found for this project' 
        })
      }
      
      const coordinatePoints = pointsResult.rows
      
      // 3. Fetch parcels with valid geometry from surveyor schema
      // Note: ST_IsValid removed — Cape Lo projected coords can fail PostGIS validity checks
      const parcelsResult = await db.query(
        `SELECT 
          stand,
          ST_Area(geom) as area_m2,
          ST_AsGeoJSON(geom)::json as geometry
         FROM land_parcels 
         WHERE project_id = $1
           AND geom IS NOT NULL
         ORDER BY stand`,
        [projectId]
      )
      
      if (parcelsResult.rows.length === 0) {
        return reply.code(404).send({ 
          error: 'No parcels found for this project' 
        })
      }
      
      // 4. Convert parcels to format with vertices
      console.log('[SurveyPlanPreview] 🔍 Raw parcels from DB:', parcelsResult.rows.length, 'rows')
      if (parcelsResult.rows.length > 0) {
        const r = parcelsResult.rows[0]
        console.log('[SurveyPlanPreview] 🔍 First row geom type:', typeof r.geometry, 'value:', JSON.stringify(r.geometry)?.slice(0, 200))
      }
      const skippedGeom = parcelsResult.rows.filter(p => !(p.geometry?.type === 'Polygon' && Array.isArray(p.geometry?.coordinates?.[0])))
      if (skippedGeom.length > 0) {
        console.warn('[SurveyPlanPreview] ⚠️ Skipped parcels (non-Polygon geom):', skippedGeom.length,
          skippedGeom.slice(0, 3).map(p => ({ stand: p.stand, geomType: p.geometry?.type, geom: JSON.stringify(p.geometry)?.slice(0, 80) })))
      }
      const parcels = parcelsResult.rows
        .filter(p => p.geometry?.type === 'Polygon' && Array.isArray(p.geometry?.coordinates?.[0]))
        .map(p => {
        const coords = p.geometry.coordinates[0] // Polygon exterior ring
        const vertices = coords.slice(0, -1).map((coord, idx) => {
          // ST_AsGeoJSON emits [X, Y] = [Southing, Westing] for Cape Lo.
          // coordinatePoints rows: cp.x = Southing (ST_X), cp.y = Westing (ST_Y).
          // So coord[0] == cp.x (Southing) and coord[1] == cp.y (Westing).
          const coordSouthing = coord[0]  // X axis in Cape Lo (Southing ~2246xxx)
          const coordWesting  = coord[1]  // Y axis in Cape Lo (Westing  ~97xxx)
          const point = coordinatePoints.find(cp =>
            Math.abs(cp.x - coordSouthing) < 0.5 &&
            Math.abs(cp.y - coordWesting)  < 0.5
          )

          return {
            name: point ? point.name : `${p.stand}_${idx}`,
            x: coordSouthing,  // Southing
            y: coordWesting    // Westing
          }
        })
        
          return {
            stand: p.stand,
            area_m2: parseFloat(p.area_m2),
            vertices,
            geometry: p.geometry
          }
        })

      if (parcels.length === 0) {
        return reply.code(422).send({
          error: 'No valid parcel geometries found for this project'
        })
      }
      
      // 5. Analyze survey
      const analysis = analyzeSurvey(coordinatePoints, parcels)
      
      // 5.5. Calculate Outside Figure extent (union of all parcels)
      // This is the primary constraint for cadastral survey plans
      // Uses IQR-based outlier detection to exclude corrupted coordinates
      let outsideFigureExtent = null
      if (parcels.length > 0) {
        const allXs = []
        const allYs = []
        const vertexSources = [] // track which parcel each vertex belongs to
        
        parcels.forEach(parcel => {
          parcel.vertices.forEach(v => {
            if (Number.isFinite(v.x) && Number.isFinite(v.y)) {
              allXs.push(v.x)
              allYs.push(v.y)
              vertexSources.push(parcel.stand)
            }
          })
        })
        
        // IQR-based outlier filter (same as pdfkitGeoPDF.js)
        function filterOutliers(values, label) {
          if (values.length < 4) return { filtered: values, removedCount: 0 }
          const sorted = [...values].sort((a, b) => a - b)
          const q1 = sorted[Math.floor(sorted.length * 0.25)]
          const q3 = sorted[Math.floor(sorted.length * 0.75)]
          const iqr = q3 - q1
          const fence = Math.max(iqr * 3, 5000) // 5km minimum fence
          const lo = q1 - fence
          const hi = q3 + fence
          const filtered = values.filter(v => v >= lo && v <= hi)
          const removedCount = values.length - filtered.length
          if (removedCount > 0) {
            console.warn(`[SurveyPlanPreview] ⚠️ Outlier detection removed ${removedCount} ${label} coordinates (fence=${fence.toFixed(0)}m, range=[${lo.toFixed(0)}, ${hi.toFixed(0)}])`)
          }
          return { filtered: filtered.length >= 4 ? filtered : values, removedCount }
        }
        
        const xResult = filterOutliers(allXs, 'X')
        const yResult = filterOutliers(allYs, 'Y')
        
        // Log which parcels have outlier vertices
        if (xResult.removedCount > 0 || yResult.removedCount > 0) {
          const xSorted = [...allXs].sort((a, b) => a - b)
          const xQ1 = xSorted[Math.floor(xSorted.length * 0.25)]
          const xQ3 = xSorted[Math.floor(xSorted.length * 0.75)]
          const xFence = Math.max((xQ3 - xQ1) * 3, 5000)
          const xLo = xQ1 - xFence
          const xHi = xQ3 + xFence
          
          const badParcels = new Set()
          allXs.forEach((x, i) => {
            if (x < xLo || x > xHi) badParcels.add(vertexSources[i])
          })
          allYs.forEach((y, i) => {
            const ySorted = [...allYs].sort((a, b) => a - b)
            const yQ1 = ySorted[Math.floor(ySorted.length * 0.25)]
            const yQ3 = ySorted[Math.floor(ySorted.length * 0.75)]
            const yFence = Math.max((yQ3 - yQ1) * 3, 5000)
            if (y < yQ1 - yFence || y > yQ3 + yFence) badParcels.add(vertexSources[i])
          })
          console.error(`[SurveyPlanPreview] 🚨 PARCELS WITH OUTLIER COORDINATES: ${[...badParcels].join(', ')}`)
        }
        
        const minX = Math.min(...xResult.filtered)
        const maxX = Math.max(...xResult.filtered)
        const minY = Math.min(...yResult.filtered)
        const maxY = Math.max(...yResult.filtered)
        
        outsideFigureExtent = {
          width: maxX - minX,
          height: maxY - minY,
          area: (maxX - minX) * (maxY - minY)
        }
        
        console.log('[SurveyPlanPreview] 📐 Outside Figure Extent:', {
          width: `${outsideFigureExtent.width.toFixed(1)}m`,
          height: `${outsideFigureExtent.height.toFixed(1)}m`,
          area: `${outsideFigureExtent.area.toFixed(0)}m²`,
          totalVertices: allXs.length,
          outlierXRemoved: xResult.removedCount,
          outlierYRemoved: yResult.removedCount
        })
      }
      
      // 5.6. Derive boundary beacon set: unique parcel vertices matched to coordinate points.
      // Using all CSV points (working stations, control points, etc.) inflates density
      // and produces absurdly large scale recommendations. Only boundary beacons matter.
      const boundaryBeaconNames = new Set()
      parcels.forEach(parcel => {
        parcel.vertices.forEach(v => {
          if (v.name && !v.name.includes('_')) boundaryBeaconNames.add(v.name)
        })
      })
      const boundaryBeacons = coordinatePoints.filter(cp => boundaryBeaconNames.has(cp.name))
      // Fall back to all points only if no matches found (e.g. name matching failed)
      const beaconsForDensity = boundaryBeacons.length > 0 ? boundaryBeacons : coordinatePoints

      console.log('[SurveyPlanPreview] 🔵 Boundary beacons:', {
        total: coordinatePoints.length,
        boundary: beaconsForDensity.length,
        note: boundaryBeacons.length > 0 ? 'using boundary beacons only' : 'fallback: using all points'
      })

      // 6 & 7. Joint scale + sheet optimization (smallest sheet at smallest valid scale)
      let selectedScale
      let selectedSheetSize
      let layout

      if (scale && sheetSize) {
        // Both explicitly provided
        selectedScale = { value: parseInt(scale), label: `1:${scale}` }
        selectedSheetSize = sheetSize
        layout = calculateSI727Layout(sheetSize, parcels.length, 0)
      } else if (scale) {
        // Scale provided, pick smallest fitting sheet
        selectedScale = { value: parseInt(scale), label: `1:${scale}` }
        const extentForSheet = outsideFigureExtent || analysis.extent
        const sheetResult = determineOptimalSheetSize(extentForSheet, selectedScale.value, parcels.length, beaconsForDensity.length)
        selectedSheetSize = sheetResult.recommended
        layout = calculateSI727Layout(selectedSheetSize, parcels.length, 0)
      } else {
        // Joint optimization: find smallest sheet + smallest SI 727 scale combination
        const extentForOpt = outsideFigureExtent || analysis.extent

        // Calculate minimum scale from legibility constraint (boundary beacons only)
        const beaconDensityForScale = {
          ...analysis.density,
          totalPoints: beaconsForDensity.length,
          averageSpacing: extentForOpt.area > 0
            ? Math.sqrt(extentForOpt.area / beaconsForDensity.length)
            : analysis.density.averageSpacing
        }
        const scaleResult = determineOptimalScale(
          { ...analysis, extent: extentForOpt, density: beaconDensityForScale },
          areaType || 'urban'
        )
        // Use the LEGIBILITY minimum as the candidate floor (not the combined
        // minScale). determineOptimalScale.minScale now also folds in the figure-
        // size denominator, which as a lower bound would force the figure toward
        // the 650mm² minimum (tiny). The joint optimisation enlarges to fill the
        // sheet, so it must floor on legibility only — its documented intent.
        const minScaleDenominator = scaleResult.minScaleForLegibility || scaleResult.recommended.value

        // Try sheets from smallest to largest; for each sheet find smallest SI 727 scale that fits
        const sheetOrder = ['ISO_A2', 'ISO_A1', 'ISO_A0']
        let bestCombo = null

        for (const sheet of sheetOrder) {
          const sheetLayout = calculateSI727Layout(sheet, parcels.length, 0)
          const { drawingArea } = sheetLayout

          // SI 727 Reg 32(3) may cap the denominator below the legibility minimum.
          // When that happens the intersection of [minLegibility, maxDenominator] is empty,
          // meaning the plan will require multi-sheet tiling at the ceiling scale.
          // Handle both cases cleanly:
          //   A) Normal: ceiling ≥ legibility → filter for best single-sheet fit
          //   B) Ceiling < legibility → jump straight to ceiling, mark as tiling needed

          const ceilingBelowLegibility =
            maxDenominator !== Infinity && maxDenominator < minScaleDenominator

          if (ceilingBelowLegibility) {
            // Use the ceiling denominator directly — multi-sheet tiling will be required.
            const ceilingScale =
              SI727_PRESCRIBED_SCALES.find(s => s.value === maxDenominator) ||
              { value: maxDenominator, label: `1:${maxDenominator}` }
            bestCombo = { sheet, scale: ceilingScale, layout: sheetLayout, needsTiling: true }
            break // ISO_A2 at ceiling is as good as any — front-end tile grid picks sheet size
          }

          const candidateScales = SI727_PRESCRIBED_SCALES
            .filter(s => s.value >= minScaleDenominator && s.value <= maxDenominator)
            .sort((a, b) => a.value - b.value) // smallest denominator first (largest map)

          for (const candidate of candidateScales) {
            const mappedW = (extentForOpt.width / candidate.value) * 1000
            const mappedH = (extentForOpt.height / candidate.value) * 1000
            if (mappedW <= drawingArea.width && mappedH <= drawingArea.height) {
              bestCombo = { sheet, scale: candidate, layout: sheetLayout }
              break
            }
            // At the ceiling denominator and it still doesn't fit → multi-sheet needed
            if (maxDenominator !== Infinity && candidate.value === maxDenominator) {
              bestCombo = { sheet, scale: candidate, layout: sheetLayout, needsTiling: true }
              break
            }
          }

          if (bestCombo) break // stop at smallest fitting sheet
        }

        if (bestCombo) {
          selectedSheetSize = bestCombo.sheet
          selectedScale = bestCombo.scale
          layout = bestCombo.layout
        } else {
          // Fallback: A0 at recommended scale
          selectedSheetSize = 'ISO_A0'
          selectedScale = scaleResult.recommended
          layout = calculateSI727Layout('ISO_A0', parcels.length, 0)
        }

        const needsTilingFlag = bestCombo?.needsTiling
        console.log('[SurveyPlanPreview] 📄 Joint Scale+Sheet Selection:', {
          extent: `${extentForOpt.width.toFixed(1)}m × ${extentForOpt.height.toFixed(1)}m`,
          minLegibilityScale: `1:${Math.round(minScaleDenominator)}`,
          si727Ceiling: maxDenominator !== Infinity ? `1:${maxDenominator}` : 'none',
          selectedSheet: selectedSheetSize,
          selectedScale: selectedScale.label,
          multiSheet: needsTilingFlag ? 'yes (tile grid will be computed client-side)' : 'no',
          mappedSize: `${((extentForOpt.width / selectedScale.value) * 1000).toFixed(1)}mm × ${((extentForOpt.height / selectedScale.value) * 1000).toFixed(1)}mm`,
          drawingArea: `${layout.drawingArea.width.toFixed(1)}mm × ${layout.drawingArea.height.toFixed(1)}mm`
        })
      }
      
      // 8. Build topology
      const topology = buildTopology(parcels, coordinatePoints)
      
      // 8.5. Analyze parcel geometry for label placement feasibility
      // This validates if beacon labels can fit at the current scale
      function analyzeParcelGeometry(parcel) {
        const vertices = parcel.vertices
        if (vertices.length < 3) return null
        
        // Calculate minimum width (narrowest dimension)
        // Previous implementation used the minimum distance from ANY vertex to ANY edge.
        // That can incorrectly produce ~0 for valid parcels when vertices are collinear along an edge.
        // Instead, compute polygon "thickness": for each edge, take the MAX perpendicular distance
        // from that edge to any other vertex; then take the MIN of those maxima.
        let minWidth = Infinity
        const EPS = 1e-9
        for (let i = 0; i < vertices.length; i++) {
          const j = (i + 1) % vertices.length
          const dx = vertices[j].x - vertices[i].x
          const dy = vertices[j].y - vertices[i].y
          const edgeLength = Math.sqrt(dx * dx + dy * dy)
          if (!Number.isFinite(edgeLength) || edgeLength < EPS) continue
          
          let maxPerpDist = 0
          for (let k = 0; k < vertices.length; k++) {
            if (k === i || k === j) continue
            const A = vertices[k].x - vertices[i].x
            const B = vertices[k].y - vertices[i].y
            const perpDist = Math.abs(A * dy - B * dx) / edgeLength
            if (Number.isFinite(perpDist)) {
              maxPerpDist = Math.max(maxPerpDist, perpDist)
            }
          }
          if (maxPerpDist > 0) {
            minWidth = Math.min(minWidth, maxPerpDist)
          }
        }
        if (!Number.isFinite(minWidth)) return null
        
        // Calculate area using shoelace formula
        let area = 0
        for (let i = 0; i < vertices.length; i++) {
          const j = (i + 1) % vertices.length
          area += vertices[i].x * vertices[j].y
          area -= vertices[j].x * vertices[i].y
        }
        area = Math.abs(area) / 2
        
        return {
          minWidth,
          area,
          vertexCount: vertices.length
        }
      }
      
      // Analyze all parcels to find constraints
      const parcelGeometries = parcels.map(p => ({
        stand: p.stand,
        geometry: analyzeParcelGeometry(p),
        beaconCount: p.vertices.length
      })).filter(p => p.geometry !== null)
      
      // Find the most constraining parcel (narrowest)
      const narrowestParcel = parcelGeometries.reduce((min, p) => 
        p.geometry.minWidth < (min?.geometry.minWidth || Infinity) ? p : min
      , null)
      
      // Calculate minimum scale needed for label placement
      const minLabelSizeOnPaperMM = 3 // Minimum readable size
      
      let scaleValidation = {
        isValid: true,
        narrowestParcel: narrowestParcel?.stand,
        narrowestWidth: narrowestParcel?.geometry.minWidth,
        recommendedScale: null,
        reason: null
      }
      
      if (narrowestParcel && Number.isFinite(narrowestParcel.geometry?.minWidth) && selectedScale?.value) {
        const minWidthMeters = narrowestParcel.geometry.minWidth

        // When SI 727 Reg 32(3) forces a ceiling denominator (e.g. 500), validate at that
        // ceiling — not at the legibility-recommended scale which may be much larger.
        // At 1:500, a 13 m parcel = 26 mm on paper: well above the 3 mm minimum.
        const validationDenominator = maxDenominator !== Infinity
          ? Math.min(selectedScale.value, maxDenominator)
          : selectedScale.value

        const widthOnPaperMM = (minWidthMeters / validationDenominator) * 1000

        if (widthOnPaperMM < minLabelSizeOnPaperMM) {
          // Genuinely too narrow even at the enforced scale — report it
          const maxAllowedScale = Math.floor((minWidthMeters * 1000) / minLabelSizeOnPaperMM)
          const cadastralScales = SI727_PRESCRIBED_SCALES.map(s => s.value).sort((a, b) => a - b)
          const recommendedScale = cadastralScales.filter(v => v <= maxAllowedScale).pop() ?? cadastralScales[0]

          if (recommendedScale < validationDenominator) {
            scaleValidation = {
              isValid: false,
              narrowestParcel: narrowestParcel.stand,
              narrowestWidth: Number(minWidthMeters.toFixed(2)),
              recommendedScale,
              currentScale: validationDenominator,
              reason: `Parcel ${narrowestParcel.stand} is too narrow (${minWidthMeters.toFixed(1)}m) for beacon labels at 1:${validationDenominator}. Labels may overlap boundaries.`
            }
            console.log(`[SurveyPlanPreview] ⚠️ Scale validation failed:`, scaleValidation)
          }
        } else if (validationDenominator !== selectedScale.value) {
          // Ceiling is active and everything is fine at the enforced scale
          console.log(
            `[SurveyPlanPreview] ✅ Scale validation at SI 727 ceiling 1:${validationDenominator}: ` +
            `narrowest parcel "${narrowestParcel.stand}" = ${(widthOnPaperMM).toFixed(1)}mm on paper (≥ ${minLabelSizeOnPaperMM}mm required)`
          )
        }
      }
      
      // 9. Create beacon labels by parsing existing beacon names
      // Extract suffix (letter) from beacon names and place within correct parcel
      const beaconLabels = []
      
      // Helper function to check if point is inside polygon
      function isPointInPolygon(point, vertices) {
        let inside = false
        for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
          const xi = vertices[i].x, yi = vertices[i].y
          const xj = vertices[j].x, yj = vertices[j].y
          
          const intersect = ((yi > point.y) !== (yj > point.y)) &&
            (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)
          
          if (intersect) inside = !inside
        }
        return inside
      }
      
      // Helper function to calculate minimum distance from point to polygon edges
      function distanceToPolygonEdge(point, vertices) {
        let minDistance = Infinity
        
        for (let i = 0; i < vertices.length; i++) {
          const j = (i + 1) % vertices.length
          const x1 = vertices[i].x, y1 = vertices[i].y
          const x2 = vertices[j].x, y2 = vertices[j].y
          
          // Calculate distance from point to line segment
          const A = point.x - x1
          const B = point.y - y1
          const C = x2 - x1
          const D = y2 - y1
          
          const dot = A * C + B * D
          const lenSq = C * C + D * D
          let param = -1
          
          if (lenSq !== 0) {
            param = dot / lenSq
          }
          
          let xx, yy
          
          if (param < 0) {
            xx = x1
            yy = y1
          } else if (param > 1) {
            xx = x2
            yy = y2
          } else {
            xx = x1 + param * C
            yy = y1 + param * D
          }
          
          const dx = point.x - xx
          const dy = point.y - yy
          const distance = Math.sqrt(dx * dx + dy * dy)
          
          minDistance = Math.min(minDistance, distance)
        }
        
        return minDistance
      }
      
      // Helper function to calculate polygon centroid
      function calculateCentroid(vertices) {
        let sumX = 0, sumY = 0
        for (const v of vertices) {
          sumX += v.x
          sumY += v.y
        }
        return { x: sumX / vertices.length, y: sumY / vertices.length }
      }
      
      // Helper function to calculate adaptive font size based on parcel geometry
      // Ensures label doesn't exceed 50% of parcel white space
      function calculateAdaptiveFontSize(parcelVertices, labelText, minFontSize = 1.5, maxFontSize = 4.0) {
        // Calculate parcel area using shoelace formula
        let area = 0
        for (let i = 0; i < parcelVertices.length; i++) {
          const j = (i + 1) % parcelVertices.length
          area += parcelVertices[i].x * parcelVertices[j].y
          area -= parcelVertices[j].x * parcelVertices[i].y
        }
        area = Math.abs(area) / 2
        
        // Calculate minimum width (narrowest dimension)
        let minWidth = Infinity
        for (let i = 0; i < parcelVertices.length; i++) {
          const j = (i + 1) % parcelVertices.length
          const dx = parcelVertices[j].x - parcelVertices[i].x
          const dy = parcelVertices[j].y - parcelVertices[i].y
          const edgeLength = Math.sqrt(dx * dx + dy * dy)
          
          for (let k = 0; k < parcelVertices.length; k++) {
            if (k === i || k === j) continue
            const A = parcelVertices[k].x - parcelVertices[i].x
            const B = parcelVertices[k].y - parcelVertices[i].y
            const perpDist = Math.abs(A * dy - B * dx) / edgeLength
            minWidth = Math.min(minWidth, perpDist)
          }
        }
        
        // Font size constraints based on geometry
        // 1. Label shouldn't exceed 50% of parcel area
        const maxLabelArea = area * 0.5
        // Estimate: label area ≈ (charWidth * length) * height
        // charWidth = 0.7 * fontSize, height = 1.5 * fontSize
        // labelArea = (0.7 * fontSize * textLength) * (1.5 * fontSize)
        const textLength = labelText.length
        const fontSizeFromArea = Math.sqrt(maxLabelArea / (0.7 * textLength * 1.5))
        
        // 2. Label width shouldn't exceed 70% of minimum parcel width
        const maxLabelWidth = minWidth * 0.7
        const fontSizeFromWidth = maxLabelWidth / (0.7 * textLength)
        
        // Use the more restrictive constraint
        let fontSize = Math.min(fontSizeFromArea, fontSizeFromWidth)
        
        // Clamp to min/max bounds
        fontSize = Math.max(minFontSize, Math.min(maxFontSize, fontSize))
        
        return fontSize
      }
      
      // Helper function to estimate label dimensions based on text length and font size
      function estimateLabelDimensions(text, fontSize) {
        // More accurate character width: 0.7 * fontSize
        const charWidth = 0.7 * fontSize
        const width = text.length * charWidth
        // Height: 1.5 * fontSize
        const height = 1.5 * fontSize
        return { width, height }
      }
      
      // Helper function to check if label bounding box is wholly within polygon
      function isLabelBoundingBoxInPolygon(centerX, centerY, labelWidth, labelHeight, vertices) {
        // Check all four corners of the label bounding box
        const halfWidth = labelWidth / 2
        const halfHeight = labelHeight / 2
        
        const corners = [
          { x: centerX - halfWidth, y: centerY - halfHeight }, // Top-left
          { x: centerX + halfWidth, y: centerY - halfHeight }, // Top-right
          { x: centerX - halfWidth, y: centerY + halfHeight }, // Bottom-left
          { x: centerX + halfWidth, y: centerY + halfHeight }  // Bottom-right
        ]
        
        // All corners must be inside the polygon
        for (const corner of corners) {
          if (!isPointInPolygon(corner, vertices)) {
            return false
          }
        }
        
        return true
      }
      
      // Helper function to get minimum distance from label bounding box to polygon edges
      function getLabelBoundingBoxClearance(centerX, centerY, labelWidth, labelHeight, vertices) {
        const halfWidth = labelWidth / 2
        const halfHeight = labelHeight / 2
        
        const corners = [
          { x: centerX - halfWidth, y: centerY - halfHeight },
          { x: centerX + halfWidth, y: centerY - halfHeight },
          { x: centerX - halfWidth, y: centerY + halfHeight },
          { x: centerX + halfWidth, y: centerY + halfHeight }
        ]
        
        let minClearance = Infinity
        for (const corner of corners) {
          const clearance = distanceToPolygonEdge(corner, vertices)
          minClearance = Math.min(minClearance, clearance)
        }
        
        return minClearance
      }
      
      // Helper function to find optimal label position near beacon but inside polygon
      /**
       * ENHANCED: Multi-strategy beacon label positioning for all parcel geometries
       * Analyzes parcel shape and tries multiple search strategies to find valid positions
       * Particularly effective for narrow rectangular parcels where centroid-directed fails
       */
      function findLabelPositionInPolygon(beaconX, beaconY, vertices, labelText = 'A') {
        // Calculate adaptive font size for this parcel
        const fontSize = calculateAdaptiveFontSize(vertices, labelText)
        
        // Estimate label dimensions with adaptive font size
        const labelDims = estimateLabelDimensions(labelText, fontSize)
        
        // STRATEGY 1: Analyze parcel geometry
        const geometry = analyzeParcelGeometryForLabeling(vertices, beaconX, beaconY)
        
        // STRATEGY 2: Generate search directions based on geometry
        const searchDirections = generateSearchDirectionsForLabeling(geometry, beaconX, beaconY, vertices)
        
        // STRATEGY 3: Try each direction with multiple offsets
        const minOffset = 0.5 // 0.5m minimum clearance from beacon
        const maxOffset = 8.0 // 8m maximum search distance
        const steps = 15 // Try 15 positions along each direction
        
        for (const direction of searchDirections) {
          for (let i = 0; i < steps; i++) {
            const offset = minOffset + (maxOffset - minOffset) * (i / (steps - 1))
            
            const labelX = beaconX + direction.dx * offset
            const labelY = beaconY + direction.dy * offset
            
            // Validate: Label must be fully inside parcel
            if (!isLabelBoundingBoxInPolygon(labelX, labelY, labelDims.width, labelDims.height, vertices)) {
              continue
            }
            
            // Validate: Check clearance from edges
            const clearance = getLabelBoundingBoxClearance(labelX, labelY, labelDims.width, labelDims.height, vertices)
            
            // Accept if at least 0.5m clearance (relaxed for suffix labels)
            if (clearance >= 0.5) {
              return { x: labelX, y: labelY, offset: offset, clearance: clearance, fontSize: fontSize }
            }
          }
        }
        
        // Last resort: return best position found (even with 0 clearance)
        let bestPos = { x: beaconX, y: beaconY, offset: 0, clearance: 0, fontSize: fontSize }
        let maxClearance = 0
        
        for (const direction of searchDirections) {
          for (let i = 0; i < steps; i++) {
            const offset = minOffset + (maxOffset - minOffset) * (i / (steps - 1))
            const labelX = beaconX + direction.dx * offset
            const labelY = beaconY + direction.dy * offset
            
            if (isLabelBoundingBoxInPolygon(labelX, labelY, labelDims.width, labelDims.height, vertices)) {
              const clearance = getLabelBoundingBoxClearance(labelX, labelY, labelDims.width, labelDims.height, vertices)
              if (clearance > maxClearance) {
                maxClearance = clearance
                bestPos = { x: labelX, y: labelY, offset: offset, clearance: clearance, fontSize: fontSize }
              }
            }
          }
        }
        
        return bestPos
      }
      
      /**
       * Analyze parcel geometry to determine shape characteristics
       */
      function analyzeParcelGeometryForLabeling(vertices, beaconX, beaconY) {
        // Calculate centroid
        const centroid = calculateCentroid(vertices)
        
        // Calculate bounding box
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
        for (const v of vertices) {
          minX = Math.min(minX, v.x)
          maxX = Math.max(maxX, v.x)
          minY = Math.min(minY, v.y)
          maxY = Math.max(maxY, v.y)
        }
        
        const width = maxX - minX
        const height = maxY - minY
        const aspectRatio = Math.max(width, height) / Math.min(width, height)
        const isNarrow = aspectRatio > 2.5
        
        // Determine long axis angle
        const longAxisAngle = width > height ? 0 : Math.PI / 2
        
        return { centroid, isNarrow, longAxisAngle, aspectRatio, width, height }
      }
      
      /**
       * Generate search directions based on parcel geometry
       */
      function generateSearchDirectionsForLabeling(geometry, beaconX, beaconY, vertices) {
        const directions = []
        
        // PRIORITY 1: Direction toward centroid
        const toCentroidDx = geometry.centroid.x - beaconX
        const toCentroidDy = geometry.centroid.y - beaconY
        const toCentroidDist = Math.sqrt(toCentroidDx * toCentroidDx + toCentroidDy * toCentroidDy)
        
        if (toCentroidDist > 0) {
          directions.push({
            name: 'toward-centroid',
            dx: toCentroidDx / toCentroidDist,
            dy: toCentroidDy / toCentroidDist,
            priority: 1
          })
        }
        
        // PRIORITY 2: For narrow parcels, try directions along long axis
        if (geometry.isNarrow) {
          const longAxisDx = Math.cos(geometry.longAxisAngle)
          const longAxisDy = Math.sin(geometry.longAxisAngle)
          
          directions.push(
            { name: 'along-long-axis-positive', dx: longAxisDx, dy: longAxisDy, priority: 2 },
            { name: 'along-long-axis-negative', dx: -longAxisDx, dy: -longAxisDy, priority: 2 }
          )
        }
        
        // PRIORITY 3: Find nearest edge and try perpendicular inward
        const nearestEdge = findNearestEdgeForLabeling(beaconX, beaconY, vertices)
        if (nearestEdge) {
          const edgeDx = nearestEdge.end.x - nearestEdge.start.x
          const edgeDy = nearestEdge.end.y - nearestEdge.start.y
          const edgeLength = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy)
          
          if (edgeLength > 0) {
            const perp1Dx = -edgeDy / edgeLength
            const perp1Dy = edgeDx / edgeLength
            const perp2Dx = edgeDy / edgeLength
            const perp2Dy = -edgeDx / edgeLength
            
            const dot1 = perp1Dx * toCentroidDx + perp1Dy * toCentroidDy
            const dot2 = perp2Dx * toCentroidDx + perp2Dy * toCentroidDy
            
            if (dot1 > dot2) {
              directions.push({ name: 'perpendicular-to-edge', dx: perp1Dx, dy: perp1Dy, priority: 3 })
            } else {
              directions.push({ name: 'perpendicular-to-edge', dx: perp2Dx, dy: perp2Dy, priority: 3 })
            }
          }
        }
        
        // PRIORITY 4: Cardinal directions as fallback
        directions.push(
          { name: 'east', dx: 1, dy: 0, priority: 4 },
          { name: 'northeast', dx: 0.707, dy: -0.707, priority: 4 },
          { name: 'north', dx: 0, dy: -1, priority: 4 },
          { name: 'northwest', dx: -0.707, dy: -0.707, priority: 4 },
          { name: 'west', dx: -1, dy: 0, priority: 4 },
          { name: 'southwest', dx: -0.707, dy: 0.707, priority: 4 },
          { name: 'south', dx: 0, dy: 1, priority: 4 },
          { name: 'southeast', dx: 0.707, dy: 0.707, priority: 4 }
        )
        
        directions.sort((a, b) => a.priority - b.priority)
        return directions
      }
      
      /**
       * Find nearest parcel edge to beacon
       */
      function findNearestEdgeForLabeling(beaconX, beaconY, vertices) {
        let minDist = Infinity
        let nearestEdge = null
        
        for (let i = 0; i < vertices.length; i++) {
          const start = vertices[i]
          const end = vertices[(i + 1) % vertices.length]
          const dist = distanceToPolygonEdge({ x: beaconX, y: beaconY }, start, end)
          
          if (dist < minDist) {
            minDist = dist
            nearestEdge = { start, end, distance: dist }
          }
        }
        
        return nearestEdge
      }
      
      // Track which beacons have already been labeled (topologically-aware labeling)
      const labeledBeacons = new Set()
      
      // TOPOLOGICALLY-AWARE LABELING: Each beacon is labeled only once
      // Strategy:
      // 1. For standard beacons (e.g., "1464A", "1464An"): Label in parent parcel (matching prefix)
      // 2. For non-standard beacons: Label in first parcel encountered
      
      parcels.forEach(parcel => {
        parcel.vertices.forEach(vertex => {
          const beaconName = vertex.name
          
          // CRITICAL: Skip if this beacon has already been labeled
          if (labeledBeacons.has(beaconName)) {
            return // Topologically-aware: no duplicate labels
          }
          
          // Parse beacon name to extract stand number and suffix (supports multi-character suffixes)
          // Examples: "1464A" → ["1464", "A"], "1464An" → ["1464", "An"]
          const match = beaconName.match(/^(\d+)([A-Z][a-z]*)$/)
          
          if (match) {
            // STANDARD BEACON NAMING (e.g., "1464A", "1464An")
            const beaconStand = match[1]
            const suffix = match[2]
            
            // TOPOLOGICAL RULE: Only label beacon in its parent parcel (matching prefix)
            if (beaconStand !== parcel.stand) {
              return // This is not the parent parcel, skip
            }
            
            // This is the parent parcel - label with suffix only
            const labelPos = findLabelPositionInPolygon(vertex.x, vertex.y, parcel.vertices, suffix)
            
            console.log(`[SurveyPlanPreview] 🎯 Beacon ${beaconName} in parcel ${parcel.stand}: fontSize=${labelPos.fontSize.toFixed(2)}m, clearance=${labelPos.clearance.toFixed(2)}m`)
            
            beaconLabels.push({
              beaconName: beaconName,
              displayLabel: suffix, // Show only suffix in parent parcel
              stand: parcel.stand,
              beaconX: vertex.x,
              beaconY: vertex.y,
              x: labelPos.x,
              y: labelPos.y,
              offset: labelPos.offset,
              clearance: labelPos.clearance,
              fontSize: labelPos.fontSize, // Adaptive font size for this parcel
              parcelId: parcel.stand
            })
            
            labeledBeacons.add(beaconName)
          } else {
            // NON-STANDARD BEACON NAMING (e.g., "A", "B", "TRIG1")
            // Label in first parcel encountered (topologically-aware: label once)
            const labelPos = findLabelPositionInPolygon(vertex.x, vertex.y, parcel.vertices, beaconName)
            
            beaconLabels.push({
              beaconName: beaconName,
              displayLabel: beaconName, // Show full name for non-standard beacons
              stand: parcel.stand,
              beaconX: vertex.x,
              beaconY: vertex.y,
              x: labelPos.x,
              y: labelPos.y,
              offset: labelPos.offset,
              clearance: labelPos.clearance,
              fontSize: labelPos.fontSize, // Adaptive font size for this parcel
              parcelId: parcel.stand
            })
            
            labeledBeacons.add(beaconName)
          }
        })
      })
      
      // 10. Place labels
      const labels = placeLabels(parcels, {
        preferredFontSize: 3.0,
        minFontSize: 2.0,
        maxFontSize: 4.0,
        padding: 1.0
      })
      
      // 11. Format parcel areas
      const parcelsWithFormatted = parcels.map(p => ({
        ...p,
        areaFormatted: formatArea(p.area_m2)
      }))
      
      // 12. Return complete preview data
      return {
        project: {
          id: projectId
        },
        coordinatePoints,
        parcels: parcelsWithFormatted,
        analysis: {
          extent: analysis.extent,
          density: analysis.density,
          parcels: analysis.parcels,
          summary: analysis.summary
        },
        scale: selectedScale,
        sheetSize: selectedSheetSize,
        layout,
        topology: {
          beacons: Array.from(topology.beacons.entries()).map(([name, beacon]) => ({
            name,
            ...beacon
          })),
          adjacency: Array.from(topology.adjacency.entries()).map(([stand, neighbors]) => ({
            stand,
            neighbors: Array.from(neighbors)
          })),
          summary: topology.summary
        },
        beaconLabels,  // Beacon labels with parcel-specific suffixes
        labels,        // Parcel stand labels
        symbolSpecs: {
          beacon: calculateBeaconSymbolSize(selectedScale.value, selectedSheetSize, 'screen'),
          label: calculateBeaconLabelSize(selectedScale.value, selectedSheetSize, 'screen')
        },
        metadata: {
          totalPoints: beaconsForDensity.length,
          totalParcels: parcels.length,
          totalBeaconLabels: beaconLabels.length,
          sharedBeacons: topology.summary.sharedBeacons,
          labelCollisions: labels.filter(l => l.hasCollision).length,
          generatedAt: new Date().toISOString()
        },
        scaleValidation  // Include scale validation results for frontend warnings
      }
      
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ 
        error: 'Failed to generate preview',
        message: error.message 
      })
    }
  })
}
