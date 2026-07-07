import { exec } from 'child_process'
import { promisify } from 'util'
import { writeFile, unlink, mkdir, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const execAsync = promisify(exec)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Auto-detect GDAL installation in common QGIS locations
 * Returns the full path to gdal_translate or null if not found
 */
async function findGDAL() {
  const commonPaths = [
    // Standard PATH
    'gdal_translate',
    // QGIS 3.x installations (newest first)
    'C:\\Program Files\\QGIS 3.44.3\\bin\\gdal_translate.exe',
    'C:\\Program Files\\QGIS 3.36.3\\bin\\gdal_translate.exe',
    'C:\\Program Files\\QGIS 3.34\\bin\\gdal_translate.exe',
    'C:\\Program Files\\QGIS 3.32\\bin\\gdal_translate.exe',
    'C:\\Program Files\\QGIS 3.30\\bin\\gdal_translate.exe',
    'C:\\Program Files\\QGIS 3.28\\bin\\gdal_translate.exe',
    // OSGeo4W installations
    'C:\\OSGeo4W64\\bin\\gdal_translate.exe',
    'C:\\OSGeo4W\\bin\\gdal_translate.exe',
    // QGIS Long Term Release
    'C:\\Program Files\\QGIS 3.34 LTR\\bin\\gdal_translate.exe',
    'C:\\Program Files\\QGIS 3.28 LTR\\bin\\gdal_translate.exe',
    // Alternative QGIS locations
    'C:\\Program Files\\QGIS\\bin\\gdal_translate.exe',
    'C:\\QGIS\\bin\\gdal_translate.exe',
    // Linux/Mac paths (for cross-platform support)
    '/usr/bin/gdal_translate',
    '/usr/local/bin/gdal_translate',
    '/opt/homebrew/bin/gdal_translate'
  ]

  for (const gdalPath of commonPaths) {
    try {
      // For simple command names, test if they work
      if (!gdalPath.includes('\\') && !gdalPath.includes('/')) {
        try {
          await execAsync(`${gdalPath} --version`)
          return gdalPath
        } catch {
          continue
        }
      }
      
      // For full paths, check if file exists AND can execute
      if (existsSync(gdalPath)) {
        const quotedPath = `"${gdalPath}"`
        try {
          await execAsync(`${quotedPath} --version`)
          return quotedPath
        } catch {
          continue
        }
      }
    } catch (error) {
      // Continue checking other paths
    }
  }

  return null
}

// Cache the GDAL path on first lookup
let cachedGDALPath = null

async function getGDALCommand() {
  if (cachedGDALPath === null) {
    cachedGDALPath = await findGDAL()
  }
  return cachedGDALPath || 'gdal_translate' // Fallback to PATH
}

/**
 * Find ogr2ogr command (GDAL vector tool)
 */
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
    } catch (error) {
      // Continue checking
    }
  }
  return null
}

let cachedOGR2OGRPath = null

async function getOGR2OGRCommand() {
  if (cachedOGR2OGRPath === null) {
    cachedOGR2OGRPath = await findOGR2OGR()
  }
  return cachedOGR2OGRPath || 'ogr2ogr'
}

/**
 * GeoPDF Generation Routes
 * Creates vector GeoPDFs from GeoJSON using GDAL/OGR
 */
export default async function geoPDFRoutes(fastify, options) {
  
  /**
   * Check if GDAL/OGR is installed and available
   */
  fastify.get('/geopdf/check', async (request, reply) => {
    try {
      const gdalCommand = await getGDALCommand()
      const ogrCommand = await getOGR2OGRCommand()
      
      if (!gdalCommand && !ogrCommand) {
        throw new Error('GDAL/OGR not found in any common location')
      }
      
      const { stdout } = await execAsync(`${gdalCommand || ogrCommand} --version`)
      
      fastify.log.info(`[GeoPDF] ✅ GDAL found: ${gdalCommand}`)
      fastify.log.info(`[GeoPDF] Version: ${stdout.trim()}`)
      
      return {
        available: true,
        version: stdout.trim(),
        path: gdalCommand,
        message: 'GDAL is available'
      }
    } catch (error) {
      fastify.log.warn('[GeoPDF] ⚠️ GDAL not found in common locations')
      fastify.log.warn(`[GeoPDF] Error: ${error.message}`)
      return {
        available: false,
        version: null,
        path: null,
        message: 'GDAL not found. Install QGIS or standalone GDAL to enable GeoPDF export.',
        error: error.message
      }
    }
  })

  /**
   * Generate GeoPDF from map image
   * POST /api/geopdf/generate
   * 
   * Body:
   * - mapImage: base64 encoded PNG image
   * - extent: { minX, minY, maxX, maxY } in Cape Lo coordinates
   * - projection: EPSG code (e.g., "EPSG:22291" for Cape Lo 31)
   * - metadata: { title, surveyor, date, designation, etc. }
   */
  fastify.post('/geopdf/generate', async (request, reply) => {
    const tempDir = path.join(__dirname, '../../temp/geopdf')
    
    try {
      // Ensure temp directory exists
      if (!existsSync(tempDir)) {
        await mkdir(tempDir, { recursive: true })
      }

      const { mapImage, extent, projection, metadata } = request.body

      // Validate inputs
      if (!mapImage || !extent || !projection) {
        return reply.code(400).send({
          error: 'Missing required fields: mapImage, extent, projection'
        })
      }

      // Generate unique filenames
      const timestamp = Date.now()
      const inputPng = path.join(tempDir, `map-${timestamp}.png`)
      const outputPdf = path.join(tempDir, `geopdf-${timestamp}.pdf`)

      // Decode base64 image and save
      const base64Data = mapImage.replace(/^data:image\/png;base64,/, '')
      await writeFile(inputPng, base64Data, 'base64')

      // Check file size
      const fs = await import('fs')
      const stats = fs.statSync(inputPng)
      const fileSizeKB = (stats.size / 1024).toFixed(2)
      fastify.log.info(`[GeoPDF] 📸 Map image saved: ${inputPng}`)
      fastify.log.info(`[GeoPDF] 📊 Image file size: ${fileSizeKB} KB`)

      // Build GDAL command for georeferencing
      // Using ISO 32000 encoding for Adobe Reader compatibility
      const gdalCmd = await getGDALCommand()
      
      if (!gdalCmd) {
        throw new Error('GDAL command not found')
      }
      
      // GDAL PDF driver doesn't support raster images well
      // Solution: Create GeoTIFF first, then convert to PDF
      const tempTiff = path.join(tempDir, `temp-${timestamp}.tif`)
      
      // Step 1: Create GeoTIFF with georeferencing
      // Note: gdalCmd is already quoted, don't add extra quotes
      const tiffCommand = [
        gdalCmd,
        `-of GTiff`,
        `-a_srs ${projection}`,
        `-a_ullr ${extent.minX} ${extent.maxY} ${extent.maxX} ${extent.minY}`,
        `"${inputPng}"`,
        `"${tempTiff}"`
      ].join(' ')
      
      // Step 2: Convert GeoTIFF to GeoPDF
      const pdfCommand = [
        gdalCmd,
        `-of PDF`,
        `-co GEO_ENCODING=ISO32000`,
        `-co DPI=300`,
        `-co AUTHOR="${metadata?.surveyorName || 'Survey Task Manager'}"`,
        `-co TITLE="${metadata?.title || 'Survey Plan'}"`,
        `-co SUBJECT="${metadata?.designation || 'Cadastral Survey'}"`,
        `-co CREATOR="Survey Task Manager v1.0"`,
        `"${tempTiff}"`,
        `"${outputPdf}"`
      ].join(' ')

      fastify.log.info('[GeoPDF] 🔧 Running GDAL command...')
      fastify.log.info(`[GeoPDF] Command: ${tiffCommand}`)
      fastify.log.info(`[GeoPDF] Command: ${pdfCommand}`)
      fastify.log.info(`[GeoPDF] Extent: ${JSON.stringify(extent)}`)

      // Set PROJ_LIB to use QGIS's PROJ data instead of PostgreSQL's
      const qgisPath = gdalCmd.includes('QGIS') ? gdalCmd.match(/"([^"]+)"/)?.[1] || gdalCmd : null
      const projLib = qgisPath ? path.join(path.dirname(qgisPath), '..', 'share', 'proj') : null
      
      const env = { ...process.env }
      if (projLib && existsSync(projLib)) {
        env.PROJ_LIB = projLib
        fastify.log.info(`[GeoPDF] 📍 Setting PROJ_LIB: ${projLib}`)
      }

      // Execute Step 1: Create GeoTIFF
      fastify.log.info('[GeoPDF] Step 1: Creating GeoTIFF...')
      const { stdout: stdout1, stderr: stderr1 } = await execAsync(tiffCommand, { 
        shell: true,
        maxBuffer: 10 * 1024 * 1024,
        env
      })
      
      if (stderr1 && !stderr1.includes('Warning')) {
        fastify.log.warn('[GeoPDF] GeoTIFF stderr:', stderr1)
      }
      fastify.log.info('[GeoPDF] ✅ GeoTIFF created')
      
      // Execute Step 2: Convert to GeoPDF
      fastify.log.info('[GeoPDF] Step 2: Converting to GeoPDF...')
      const { stdout: stdout2, stderr: stderr2 } = await execAsync(pdfCommand, { 
        shell: true,
        maxBuffer: 10 * 1024 * 1024,
        env
      })
      
      if (stderr2 && !stderr2.includes('Warning')) {
        fastify.log.warn('[GeoPDF] PDF stderr:', stderr2)
      }

      fastify.log.info(`[GeoPDF] ✅ GeoPDF generated: ${outputPdf}`)

      // Read the generated PDF
      const pdfBuffer = await readFile(outputPdf)

      // TEMPORARILY DISABLED: Keep files for debugging
      // await unlink(inputPng).catch(err => fastify.log.warn('Failed to delete temp PNG:', err))
      // await unlink(outputPdf).catch(err => fastify.log.warn('Failed to delete temp PDF:', err))
      fastify.log.info(`[GeoPDF] 🔍 Files kept for debugging: ${inputPng}, ${outputPdf}`)

      // Send PDF as response
      reply
        .type('application/pdf')
        .header('Content-Disposition', `attachment; filename="survey-plan-geo-${timestamp}.pdf"`)
        .send(pdfBuffer)

    } catch (error) {
      fastify.log.error('[GeoPDF] ❌ Error generating GeoPDF:')
      fastify.log.error('[GeoPDF] Error message:', error.message)
      fastify.log.error('[GeoPDF] Error stack:', error.stack)
      if (error.stderr) fastify.log.error('[GeoPDF] STDERR:', error.stderr)
      if (error.stdout) fastify.log.error('[GeoPDF] STDOUT:', error.stdout)
      
      return reply.code(500).send({
        error: 'Failed to generate GeoPDF',
        message: error.message,
        stderr: error.stderr,
        stdout: error.stdout,
        stack: error.stack
      })
    }
  })

  /**
   * Get GeoPDF capabilities and system info
   */
  fastify.get('/geopdf/info', async (request, reply) => {
    try {
      const gdalCmd = await getGDALCommand()
      
      // Check GDAL version
      const { stdout: gdalVersion } = await execAsync(`${gdalCmd} --version`).catch(() => ({ stdout: 'Not installed' }))
      
      // Check supported formats
      const { stdout: formats } = await execAsync(`${gdalCmd} --formats`).catch(() => ({ stdout: '' }))
      const pdfSupported = formats.includes('PDF')

      return {
        gdal: {
          version: gdalVersion.trim(),
          installed: !gdalVersion.includes('Not installed')
        },
        formats: {
          pdf: pdfSupported,
          geoPdf: pdfSupported
        },
        projections: {
          supported: ['EPSG:22291', 'EPSG:22289', 'EPSG:4326'],
          default: 'EPSG:22291'
        },
        features: {
          coordinateDisplay: true,
          measurementTools: true,
          layerControl: false, // Phase 2
          attributeTables: false // Phase 2
        }
      }
    } catch (error) {
      return reply.code(500).send({
        error: 'Failed to get GeoPDF info',
        message: error.message
      })
    }
  })
}
