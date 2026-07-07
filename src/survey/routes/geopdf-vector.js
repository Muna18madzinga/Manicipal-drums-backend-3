// Vector GeoPDF Generation Routes
import { exec } from 'child_process'
import { promisify } from 'util'
import { writeFile, unlink, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import LandParcel from '../models/landParcel.js'
import { computeAreaConsistency } from '../utils/area-computation.js'
import { authenticateWithSchema } from '../utils/schemaAuth.js'
import { getCapeLoSRID } from '../utils/capeLoSRID.js'

const execAsync = promisify(exec)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let cachedOGR2OGRPath = null

async function findOGR2OGR() {
  const commonPaths = [
    'ogr2ogr',
    'C:\\Program Files\\QGIS 3.44.3\\bin\\ogr2ogr.exe',
    'C:\\Program Files\\QGIS 3.36.3\\bin\\ogr2ogr.exe',
    'C:\\Program Files\\QGIS 3.34\\bin\\ogr2ogr.exe',
    'C:\\OSGeo4W64\\bin\\ogr2ogr.exe',
    'C:\\OSGeo4W\\bin\\ogr2ogr.exe',
    '/usr/bin/ogr2ogr',
    '/usr/local/bin/ogr2ogr',
    '/opt/homebrew/bin/ogr2ogr'
  ]

  for (const ogrPath of commonPaths) {
    try {
      if (!ogrPath.includes('\\') && !ogrPath.includes('/')) {
        try {
          await execAsync(`${ogrPath} --version`)
          return ogrPath
        } catch {
          continue
        }
      }

      if (existsSync(ogrPath)) {
        const quotedPath = `"${ogrPath}"`
        try {
          await execAsync(`${quotedPath} --version`)
          return quotedPath
        } catch {
          continue
        }
      }
    } catch {
      continue
    }
  }

  return null
}

async function getOGR2OGRCommand() {
  if (cachedOGR2OGRPath === null) {
    cachedOGR2OGRPath = await findOGR2OGR()
  }
  return cachedOGR2OGRPath || 'ogr2ogr'
}

async function getGDALVersion(cmd) {
  const { stdout } = await execAsync(`${cmd} --version`).catch(() => ({ stdout: null }))
  return stdout?.trim() || null
}

function swapYxToXyGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') return geometry
  const { type, coordinates } = geometry
  if (!type || coordinates == null) return geometry

  const swapPair = (c) => (Array.isArray(c) && c.length >= 2 ? [c[1], c[0], ...c.slice(2)] : c)

  if (type === 'Point') {
    return { ...geometry, coordinates: swapPair(coordinates) }
  }
  if (type === 'LineString' || type === 'MultiPoint') {
    return { ...geometry, coordinates: coordinates.map(swapPair) }
  }
  if (type === 'Polygon' || type === 'MultiLineString') {
    return { ...geometry, coordinates: coordinates.map((ring) => ring.map(swapPair)) }
  }
  if (type === 'MultiPolygon') {
    return { ...geometry, coordinates: coordinates.map((poly) => poly.map((ring) => ring.map(swapPair))) }
  }
  return geometry
}

function swapYxToXyFeatureCollection(fc) {
  if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return fc
  return {
    ...fc,
    features: fc.features.map((f) => ({
      ...f,
      geometry: swapYxToXyGeometry(f.geometry)
    }))
  }
}

/**
 * Generate Vector GeoPDF from GeoJSON
 * POST /api/geopdf/vector
 * 
 * Body:
 * - parcels: GeoJSON FeatureCollection of parcel polygons
 * - beacons: GeoJSON FeatureCollection of beacon points
 * - projection: EPSG code (e.g., "EPSG:22291" for Cape Lo 31)
 * - metadata: { title, surveyor, date, designation, etc. }
 */
export default async function vectorGeoPDFRoutes(fastify, options) {
  
  /**
   * Get GeoPDF generation capabilities
   * GET /api/geopdf/capabilities
   */
  fastify.get('/capabilities', async (request, reply) => {
    try {
      const ogrCmd = await getOGR2OGRCommand()
      
      const capabilities = {
        features: {
          gdalVector: {
            description: 'GDAL/ogr2ogr Vector Generation',
            supported: !!ogrCmd,
            capabilities: ogrCmd ? ['OGC GeoPDF', 'ISO 32000', 'Vector layers', 'Georeferencing'] : []
          },
          trueGeoPDF: {
            description: 'Custom True GeoPDF Generation',
            supported: true,
            capabilities: ['Vector rendering', 'Interactive features', 'Measurements', 'Layer management']
          },
          georeferencing: {
            description: 'GDAL Georeferencing',
            supported: !!ogrCmd && ogrCmd.includes('gdal'),
            capabilities: ogrCmd ? ['EPSG:22291', 'Cape Lo support', 'ISO 32000 encoding'] : []
          }
        },
        gdalVersion: ogrCmd ? await getGDALVersion(ogrCmd) : null,
        ogrCommand: ogrCmd
      }

      reply.send(capabilities)
    } catch (error) {
      fastify.log.error('Error getting capabilities:', error)
      reply.code(500).send({ error: 'Failed to get capabilities', message: error.message })
    }
  })

  /**
   * Generate DXF (AutoCAD) file from GeoJSON
   * POST /api/geopdf/dxf
   * Accepts the same payload as /vector but returns a DXF file
   */
  fastify.post('/dxf', {
    preHandler: [fastify.authenticate, authenticateWithSchema]
  }, async (request, reply) => {
    try {
      fastify.log.info('[DXF] DXF generation started')

      const {
        parcels,
        beacons,
        projection,
        metadata,
        outsideFigureData,
        scale,
        sheetSize,
        orientation,
        planType,
        beaconLabels,
      } = request.body

      if (!parcels || !beacons) {
        return reply.code(400).send({ error: 'Missing required fields: parcels, beacons' })
      }

      fastify.log.info(`[DXF] Request planType=${JSON.stringify(planType)} beaconLabels=${Array.isArray(beaconLabels) ? beaconLabels.length : 'none'}`)

      const { generateDXF } = await import('../services/dxfGenerator.js')

      const { buffer, warnings } = generateDXF(
        { parcels, beacons, outsideFigureData, metadata, projection, scale, sheetSize, orientation, planType, beaconLabels, beaconGroups: request.body.beaconGroups },
        fastify.log
      )

      const filename = `survey-plan-${Date.now()}.dxf`
      reply
        .type('application/dxf')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('X-DXF-Warning-Count', String(warnings.count))
      if (warnings.count > 0) {
        reply.header('X-DXF-Warnings', JSON.stringify(warnings.summary))
      }
      reply.send(buffer)

    } catch (error) {
      fastify.log.error('[DXF] Generation failed:', error)
      reply.code(500).send({ error: 'DXF generation failed', message: error.message })
    }
  })

  /**
   * Generate Vector GeoPDF from GeoJSON
   * POST /api/geopdf/vector
   */
  fastify.post('/vector', {
    preHandler: [fastify.authenticate, authenticateWithSchema]
  }, async (request, reply) => {
    console.log('========================================')
    console.log('[GeoPDF ROUTE] 🚀 ROUTE HANDLER EXECUTING - VERSION 2026-01-06-18:05')
    console.log('========================================')
    
    const tempDir = path.join(__dirname, '../../temp/geopdf')
    
    let vectorPdfCreated = false
    
    try {
      fastify.log.info('[GeoPDF] 🚀 Vector GeoPDF generation started - CODE VERSION 2026-01-06-18:30')
      
      // Ensure temp directory exists
      if (!existsSync(tempDir)) {
        await mkdir(tempDir, { recursive: true })
      }

      const {
        parcels,
        beacons,
        annotations,
        projection,
        metadata,
        extent,
        outsideFigureData,
        beaconLabels,
        projectId,
        renderEngine = 'gdal',
        scale,
        sheetSize,
        planType = null  // SI 727 plan type — 'general-developed' enforces 1:500 ceiling
      } = request.body
      
      // 🔥 DIAGNOSTIC: Log ALL request body keys to see what's actually being sent
      fastify.log.info(`[GeoPDF] 🔥 Request body keys: ${Object.keys(request.body).join(', ')}`)
      fastify.log.info(`[GeoPDF] 🔥 beaconLabels type: ${typeof beaconLabels}`)
      fastify.log.info(`[GeoPDF] 🔥 beaconLabels value: ${JSON.stringify(beaconLabels)}`)
      
      fastify.log.info(`[GeoPDF] 📊 Request data: projectId=${projectId}, parcels=${parcels?.features?.length || 0}, beacons=${beacons?.features?.length || 0}`)

      // Validate inputs
      if (!parcels || !beacons || !projection) {
        return reply.code(400).send({
          error: 'Missing required fields: parcels, beacons, projection'
        })
      }

      // Query Outside Figure parcel from database if projectId provided
      let outsideFigure = null
      if (projectId) {
        const dbConnection = request.db || request.surveyorPool || request.server.surveyPg
        const outsideFigureParcel = await LandParcel.findOutsideFigure(dbConnection, projectId)
        
        if (outsideFigureParcel && outsideFigureParcel.geom) {
          outsideFigure = {
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              properties: {
                stand: outsideFigureParcel.stand,
                designation: outsideFigureParcel.designation,
                area_m2: outsideFigureParcel.area_m2,
                isOutsideFigure: true
              },
              geometry: outsideFigureParcel.geom
            }]
          }
          outsideFigure = swapYxToXyFeatureCollection(outsideFigure)
        }
      }

      // Extent is optional (used previously for GDAL georeferencing)
      const safeExtent = extent || null
      
      // ⭐ COMPUTE AREA/CONSISTENCY ON-THE-FLY: Complete automation
      // This ensures consistent data using same computation logic as /compute/area
      // Computes: area, centroid, edges, residuals, closure error, closure ratio
      fastify.log.info('[GeoPDF] Computing area/consistency data on-the-fly for all parcels...')
      
      // Load coordinate points once for beacon name matching
      let coordinatePointsList = []
      if (projectId) {
        try {
          const dbConnection = request.db || request.surveyorPool || request.server.surveyPg
          // Geometry is stored in project's native CRS — read directly, no transform needed
          const coordinatePoints = await dbConnection.query(
            `SELECT name, ST_Y(geom) as y, ST_X(geom) as x FROM coordinate_points WHERE project_id = $1`,
            [projectId]
          )
          const projRow = await dbConnection.query('SELECT central_meridian FROM survey_projects WHERE id = $1', [projectId])
          const nativeSrid = projRow.rows.length > 0 ? getCapeLoSRID(projRow.rows[0].central_meridian) : 22291
          coordinatePointsList = coordinatePoints.rows
          fastify.log.info(`[GeoPDF] 📍 Loaded ${coordinatePoints.rows.length} coordinate points (nativeSrid=${nativeSrid}) for beacon name matching`)
        } catch (coordError) {
          fastify.log.warn(`[GeoPDF] ⚠️ Failed to load coordinate points: ${coordError.message}`)
        }
      } else {
        fastify.log.warn('[GeoPDF] ⚠️ No projectId provided - beacon names will be generic')
      }
      
      // Helper function to find beacon name by coordinates with tolerance
      function findBeaconName(y, x, tolerance = 0.01) {
        for (const pt of coordinatePointsList) {
          const dy = Math.abs(pt.y - y)
          const dx = Math.abs(pt.x - x)
          if (dy < tolerance && dx < tolerance) {
            return pt.name
          }
        }
        return null
      }
      
      const parcelsWithComputedData = {
        ...parcels,
        features: parcels.features.map((parcel, index) => {
          try {
            // Skip Outside Figure parcel (no area computation needed)
            const isOutsideFigure = 
              parcel.properties.stand?.toLowerCase().includes('outside figure') ||
              parcel.properties.designation?.toLowerCase().includes('outside figure') ||
              parcel.properties.metadata?.isOutsideFigure === true ||
              parcel.properties.isOutsideFigure === true
            
            if (isOutsideFigure) {
              fastify.log.info(`[GeoPDF] Skipping area computation for Outside Figure parcel`)
              return parcel
            }
            
            // Extract coordinates from GeoJSON geometry (unwrap double-nested [[ring]] → [ring])
            let coords = parcel.geometry.coordinates[0]
            if (Array.isArray(coords) && coords.length === 1 && Array.isArray(coords[0]) && Array.isArray(coords[0][0])) {
              coords = coords[0]
            }
            
            // Convert GeoJSON coords to Cape Lo {y, x} format with beacon names
            // GeoJSON from capeLoPointToGeoJson: [0] = Southing (Cape Lo X), [1] = Westing (Cape Lo Y)
            // Cape Lo convention: y = Westing, x = Southing
            const points = coords.slice(0, -1).map((coord, idx) => {
              const y = coord[1]  // Westing (Cape Lo Y)
              const x = coord[0]  // Southing (Cape Lo X)
              // findBeaconName uses SQL naming: pt.y=ST_Y(geom)=Southing, pt.x=ST_X(geom)=Westing
              // Pass (x=Southing, y=Westing) to match SQL column aliases
              const name = findBeaconName(x, y) || `Point${idx}`
              return { y, x, id: name, name }
            })
            
            // Compute complete area/consistency data using SAME logic as /compute/area endpoint
            const areaData = computeAreaConsistency(points, {
              hectaresThreshold: 10000,
              roundMetersDecimals: 2,
              roundHectaresDecimals: 4,
              includeResiduals: true
            })
            
            // Attach computed data to parcel properties
            return {
              ...parcel,
              properties: {
                ...parcel.properties,
                // Edge data for labels
                edges: areaData.edges.map(edge => ({
                  bearing: edge.bearingDeg,
                  distance: edge.distance,
                  distanceRounded: edge.distanceRounded,
                  directionDMS: edge.directionDMS,
                  from: edge.from,
                  to: edge.to
                })),
                // Area data for Schedule of Areas
                area_m2: areaData.area.abs_m2,
                area_ha: areaData.area.hectares_rounded,
                area_display: areaData.area.display,
                // Centroid for reference
                centroid_y: areaData.centroid.y,
                centroid_x: areaData.centroid.x,
                // Closure data for quality indicators
                closure_error_m: areaData.residuals.closureError,
                closure_error_formatted: areaData.residuals.closureErrorFormatted,
                closure_ratio: areaData.closure.ratio,
                closure_ratio_formatted: areaData.closure.ratioFormatted,
                perimeter_m: areaData.closure.perimeter
              }
            }
          } catch (error) {
            fastify.log.warn(`[GeoPDF] Failed to compute area/consistency for parcel ${parcel.properties.stand || parcel.properties.id}: ${error.message}`)
            return parcel // Return original parcel without computed data
          }
        })
      }
      
      fastify.log.info(`[GeoPDF] ✅ Computed area/consistency for ${parcelsWithComputedData.features.length} parcels`)
      
      // ⭐ PERSIST COMPUTED DATA: Save edges and closure data back to parcel metadata
      // This ensures data is available for Comprehensive_Latest.pdf generation later
      if (projectId) {
        fastify.log.info('[GeoPDF] 💾 Saving computed edges/closure data to parcel metadata...')
        
        const dbConnection = request.db || request.surveyorPool || request.server.surveyPg
        
        for (const parcel of parcelsWithComputedData.features) {
          try {
            const stand = parcel.properties.stand
            if (!stand) continue
            
            // Find parcel in database by stand number
            const dbParcel = await LandParcel.findByStand(dbConnection, projectId, stand)
            if (!dbParcel) {
              fastify.log.warn(`[GeoPDF] Parcel ${stand} not found in database - skipping metadata save`)
              continue
            }
            
            // Log first edge to verify beacon names are included
            if (parcel.properties.edges && parcel.properties.edges.length > 0) {
              const firstEdge = parcel.properties.edges[0]
              fastify.log.info(`[GeoPDF] Sample edge for ${stand}: from=${JSON.stringify(firstEdge.from)}, to=${JSON.stringify(firstEdge.to)}`)
            }
            
            // Prepare metadata with computed data
            const updatedMetadata = {
              ...(dbParcel.metadata || {}),
              residuals: {
                edges: parcel.properties.edges || [],
                sumDy: parcel.properties.edges?.reduce((sum, e) => sum + (e.dy || 0), 0) || 0,
                sumDx: parcel.properties.edges?.reduce((sum, e) => sum + (e.dx || 0), 0) || 0,
                closureError: parcel.properties.closure_error_m,
                closureErrorFormatted: parcel.properties.closure_error_formatted,
              },
              closure: {
                perimeter: parcel.properties.perimeter_m,
                error: parcel.properties.closure_error_m,
                ratio: parcel.properties.closure_ratio,
                ratioFormatted: parcel.properties.closure_ratio_formatted,
              },
              last_computed: new Date().toISOString()
            }
            
            // Update parcel metadata in database
            await LandParcel.update(dbConnection, dbParcel.id, { metadata: updatedMetadata })
            fastify.log.info(`[GeoPDF] ✅ Saved metadata for parcel ${stand} (${parcel.properties.edges?.length || 0} edges)`)
          } catch (saveError) {
            fastify.log.warn(`[GeoPDF] Failed to save metadata for parcel ${parcel.properties.stand}: ${saveError.message}`)
          }
        }
        
        fastify.log.info('[GeoPDF] ✅ Metadata save complete')
      }

      if (renderEngine === 'pdfkit') {
        fastify.log.info('[GeoPDF] 🎨 Using PDFKit professional renderer (SI 727 layout + labels)')

        const {
          generateGeoPDF: generatePDFKitGeoPDF,
          generateTiledGeoPDF,
        } = await import('../services/pdfkitGeoPDF.js')

        fastify.log.info(`[GeoPDF] 📐 Forwarding scale=${scale}, sheetSize=${sheetSize} to PDFKit renderer`)

        // First-pass render — detects whether multi-sheet tiling is required
        const firstPass = await generatePDFKitGeoPDF(
          {
            parcels: parcelsWithComputedData,
            beacons,
            annotations,
            outsideFigure,
            projection,
            extent: safeExtent,
            metadata,
            outsideFigureData,
            beaconLabels,
            scale,
            sheetSize,
            planType
          },
          fastify.log
        )

        const suggestedScale  = firstPass?.suggestedScale ?? null
        const usedScale       = firstPass?.scale ?? scale
        const usedSheetSize   = firstPass?.sheetSize ?? sheetSize ?? null
        const tileGrid        = firstPass?.tileGrid ?? null

        let finalPdfBuffer
        let isTiled = false

        if (tileGrid) {
          // Multi-sheet: generate all tile sheets + key plan, merge into one PDF
          fastify.log.warn(
            `[GeoPDF] 🗺️ SI 727 Reg 32(3): multi-sheet plan required — ` +
            `${tileGrid.totalSheets} sheets (${tileGrid.cols}×${tileGrid.rows}) at ${tileGrid.scaleLabel}`
          )
          const tiledResult = await generateTiledGeoPDF(
            {
              parcels: parcelsWithComputedData,
              beacons,
              annotations,
              outsideFigure,
              projection,
              metadata,
              outsideFigureData,
              beaconLabels,
              sheetSize: tileGrid.sheetSize,
              planType,
              tileGridInfo: tileGrid,
            },
            fastify.log
          )
          finalPdfBuffer = tiledResult.pdfBuffer
          isTiled = true
        } else {
          finalPdfBuffer = firstPass?.pdfBuffer ?? firstPass
        }

        const ts = Date.now()
        const replyHeaders = {
          'Content-Disposition': isTiled
            ? `attachment; filename="general-plan-multisheet-${ts}.pdf"`
            : `attachment; filename="survey-plan-professional-${ts}.pdf"`,
          'X-Used-Scale':      usedScale,
          'X-Used-Sheet-Size': usedSheetSize,
        }
        if (suggestedScale) {
          replyHeaders['X-Suggested-Scale'] = suggestedScale
          fastify.log.warn(`[GeoPDF] 📏 Suggested scale for next render: ${suggestedScale}`)
        }
        if (tileGrid) {
          replyHeaders['X-Tile-Grid'] = JSON.stringify({
            totalSheets: tileGrid.totalSheets,
            cols: tileGrid.cols,
            rows: tileGrid.rows,
            scaleDenominator: tileGrid.scaleDenominator,
            scaleLabel: tileGrid.scaleLabel,
            sheetSize: tileGrid.sheetSize
          })
        }

        reply
          .type('application/pdf')
          .headers(replyHeaders)
          .send(finalPdfBuffer)

        return
      }
      
      // Generate unique filenames
      const timestamp = Date.now()
      const parcelsGeoJSON = path.join(tempDir, `parcels-${timestamp}.geojson`)
      const beaconsGeoJSON = path.join(tempDir, `beacons-${timestamp}.geojson`)
      const annotationsGeoJSON = annotations ? path.join(tempDir, `annotations-${timestamp}.geojson`) : null
      const outputPdf = path.join(tempDir, `vector-geopdf-${timestamp}.pdf`)
      
      // Track temp files for cleanup
      const tempFiles = [parcelsGeoJSON, beaconsGeoJSON, outputPdf]
      
      // Write parcels to GeoJSON file
      const parcelsForGdal = swapYxToXyFeatureCollection(parcelsWithComputedData)
      await writeFile(parcelsGeoJSON, JSON.stringify(parcelsForGdal, null, 2))
      
      // Write beacons to GeoJSON file
      const beaconsForGdal = swapYxToXyFeatureCollection(beacons)
      await writeFile(beaconsGeoJSON, JSON.stringify(beaconsForGdal, null, 2))
      
      // Write annotations to GeoJSON file if provided
      if (annotationsGeoJSON) {
        const annotationsForGdal = swapYxToXyFeatureCollection(annotations)
        await writeFile(annotationsGeoJSON, JSON.stringify(annotationsForGdal, null, 2))
      }

      // STEP 1: Use GDAL/ogr2ogr with Acrobat Reader compatibility settings
      try {
        // Get ogr2ogr command
        const ogrCmd = await getOGR2OGRCommand()
        if (!ogrCmd) {
          throw new Error('ogr2ogr command not found. Install QGIS or GDAL.')
        }

        // Create initial PDF with parcels
        const qgisOgrPath = ogrCmd.includes('QGIS') ? (ogrCmd.match(/"([^"]+)"/)?.[1] || ogrCmd.replaceAll('"', '')) : null
        const projLib = qgisOgrPath ? path.join(path.dirname(qgisOgrPath), '..', 'share', 'proj') : null
        const env = { ...process.env }
        if (projLib && existsSync(projLib)) {
          env.PROJ_LIB = projLib
          fastify.log.info(`[GeoPDF] 📍 Setting PROJ_LIB: ${projLib}`)
        }

        // ogr2ogr syntax: ogr2ogr [options] dst_datasource src_datasource
        const parcelsCommand = `${ogrCmd} -f PDF -lco GEOREFERENCE=true -lco GEO_ENCODING=ISO32000 -lco COMPATIBILITY=ACROBAT_9 -s_srs ${projection} -a_srs ${projection} "${outputPdf}" "${parcelsGeoJSON}"`
        const { stdout: parcelsStdout, stderr: parcelsStderr } = await execAsync(parcelsCommand, {
          shell: true,
          maxBuffer: 10 * 1024 * 1024,
          env
        })
        if (parcelsStderr && !parcelsStderr.includes('Warning')) {
          fastify.log.warn(`[GeoPDF] ogr2ogr parcels stderr: ${parcelsStderr.substring(0, 2000)}`)
        }
        
        // Add beacons as points layer
        const beaconsCommand = `${ogrCmd} -f PDF -update -append -lco GEOREFERENCE=true -lco GEO_ENCODING=ISO32000 -lco COMPATIBILITY=ACROBAT_9 -s_srs ${projection} -a_srs ${projection} "${outputPdf}" "${beaconsGeoJSON}"`
        const { stdout: beaconsStdout, stderr: beaconsStderr } = await execAsync(beaconsCommand, {
          shell: true,
          maxBuffer: 10 * 1024 * 1024,
          env
        })
        if (beaconsStderr && !beaconsStderr.includes('Warning')) {
          fastify.log.warn(`[GeoPDF] ogr2ogr beacons stderr: ${beaconsStderr.substring(0, 2000)}`)
        }
        
        vectorPdfCreated = true
        fastify.log.info('[GeoPDF] ✅ GDAL vector PDF created successfully (Acrobat Reader compatible)')
      
      } catch (ogrError) {
        fastify.log.error({
          msg: '[GeoPDF] ❌ GDAL vector generation failed',
          error: ogrError?.message,
          stack: ogrError?.stack,
          stderr: ogrError?.stderr,
          stdout: ogrError?.stdout
        })
      }
      
      if (!vectorPdfCreated || !existsSync(outputPdf)) {
        return reply.code(500).send({
          error: 'Failed to generate vector GeoPDF',
          message: 'ogr2ogr did not produce an output PDF. Check server logs for GDAL errors.'
        })
      }

      // Read final PDF
      const pdfBuffer = await readFile(outputPdf)

      // Send PDF as response
      reply
        .type('application/pdf')
        .header('Content-Disposition', `attachment; filename="survey-plan-vector-geo-${timestamp}.pdf"`)
        .send(pdfBuffer)

    } catch (error) {
      // Structured error logging
      fastify.log.error({
        msg: 'Error generating vector GeoPDF',
        error: error.message,
        stack: error.stack,
        stderr: error.stderr,
        stdout: error.stdout,
        projection: request.body.projection,
        parcelCount: request.body.parcels?.features?.length,
        beaconCount: request.body.beacons?.features?.length
      })

      // Cleanup temp files on error
      const timestamp = Date.now()
      const cleanupFiles = [
        path.join(tempDir, `parcels-${timestamp}.geojson`),
        path.join(tempDir, `beacons-${timestamp}.geojson`),
        path.join(tempDir, `annotations-${timestamp}.geojson`),
        path.join(tempDir, `vector-geopdf-${timestamp}.pdf`)
      ]

      await Promise.all(
        cleanupFiles.map(file => 
          unlink(file).catch(() => {
            // Ignore cleanup errors
          })
        )
      )

      return reply.code(500).send({
        error: 'Failed to generate vector GeoPDF',
        message: error.message,
        suggestion: error.message.includes('ogr2ogr') 
          ? 'Check GDAL/QGIS installation and PROJ_LIB environment variable'
          : 'Check server logs for details',
        stderr: error.stderr?.substring(0, 500), // Limit error output
        timestamp: new Date().toISOString()
      })
    }
  })
  
  fastify.log.info('POST /geopdf/vector route registration COMPLETE')
}
