import fs from 'fs'
import path from 'path'
import os from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

/**
 * Resolve working directory to absolute path
 */
function resolveWorkingDirectory(workingDirectory) {
  if (path.isAbsolute(workingDirectory)) {
    return workingDirectory
  }
  // Use USERPROFILE on Windows, HOME on Unix/Linux
  const homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir()
  return path.join(homeDir, workingDirectory)
}

export default async function documentRoutes(fastify, options) {
  // Save document to project folder
  fastify.post('/documents/save', async (request, reply) => {
    try {
      // Process multipart form data
      const parts = request.parts()
      let fileBuffer = null
      let fileName = null
      let filePath = null
      
      for await (const part of parts) {
        if (part.type === 'file') {
          // This is the file
          fileName = part.filename
          const chunks = []
          for await (const chunk of part.file) {
            chunks.push(chunk)
          }
          fileBuffer = Buffer.concat(chunks)
          fastify.log.info(`[SAVE] File received: ${fileName} (${fileBuffer.length} bytes)`)
        } else {
          // This is a field
          if (part.fieldname === 'filePath') {
            filePath = part.value
            fastify.log.info(`[SAVE] File path: ${filePath}`)
          }
        }
      }
      
      if (!fileBuffer) {
        fastify.log.error('[SAVE] No file provided in request')
        return reply.code(400).send({ ok: false, error: 'No file provided' })
      }
      
      if (!filePath) {
        fastify.log.error('[SAVE] No file path provided')
        return reply.code(400).send({ ok: false, error: 'No file path provided' })
      }

      // Resolve to absolute path
      const absolutePath = resolveWorkingDirectory(filePath)
      fastify.log.info(`[SAVE] Saving document to: ${absolutePath}`)

      // Ensure directory exists
      const dir = path.dirname(absolutePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
        fastify.log.info(`[SAVE] Created directory: ${dir}`)
      }

      // Write file
      fs.writeFileSync(absolutePath, fileBuffer)
      
      fastify.log.info(`[SAVE] ✅ Document saved: ${absolutePath} (${fileBuffer.length} bytes)`)

      return {
        ok: true,
        filePath: absolutePath,
        size: fileBuffer.length
      }
    } catch (error) {
      fastify.log.error('[SAVE] Error:', error)
      fastify.log.error('[SAVE] Error details:', {
        message: error.message,
        stack: error.stack,
        code: error.code
      })
      return reply.code(500).send({
        ok: false,
        error: 'Failed to save document',
        message: error.message,
        code: error.code
      })
    }
  })

  // List documents in project folder
  fastify.get('/documents/list', async (request, reply) => {
    try {
      const { workingDirectory } = request.query
      
      if (!workingDirectory) {
        return reply.code(400).send({ ok: false, error: 'Working directory required' })
      }

      const absolutePath = resolveWorkingDirectory(workingDirectory)
      
      if (!fs.existsSync(absolutePath)) {
        return { ok: true, documents: [] }
      }

      const documents = []
      
      // Scan output folder
      const outputDir = path.join(absolutePath, 'output')
      if (fs.existsSync(outputDir)) {
        const scanFolder = (folder, type) => {
          if (!fs.existsSync(folder)) return
          
          const files = fs.readdirSync(folder)
          files.forEach(file => {
            if (file.endsWith('.pdf')) {
              const filePath = path.join(folder, file)
              const stats = fs.statSync(filePath)
              documents.push({
                name: file,
                path: filePath,
                type,
                size: stats.size,
                modified: stats.mtime
              })
            }
          })
        }

        scanFolder(path.join(outputDir, 'field-book'), 'field-book')
        scanFolder(path.join(outputDir, 'calculations'), 'calculations')
        scanFolder(path.join(outputDir, 'coordinate-list'), 'coordinate-list')
        scanFolder(path.join(outputDir, 'complete-reports'), 'complete-reports')
        scanFolder(path.join(outputDir, 'reports'), 'reports')
        scanFolder(path.join(outputDir, 'certificates'), 'certificates')
      }

      return { ok: true, documents }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ ok: false, error: 'Failed to list documents' })
    }
  })

  // Save PDF from base64 string (for merged PDFs)
  fastify.post('/documents/save-pdf', async (request, reply) => {
    try {
      const { pdfBase64, filePath } = request.body
      
      if (!pdfBase64) {
        fastify.log.error('[SAVE-PDF] No PDF data provided')
        return reply.code(400).send({ 
          success: false, 
          message: 'No PDF data provided' 
        })
      }
      
      if (!filePath) {
        fastify.log.error('[SAVE-PDF] No file path provided')
        return reply.code(400).send({ 
          success: false, 
          message: 'No file path provided' 
        })
      }

      // Decode base64 to buffer
      const pdfBuffer = Buffer.from(pdfBase64, 'base64')
      fastify.log.info(`[SAVE-PDF] Decoded PDF: ${pdfBuffer.length} bytes`)

      // Resolve to absolute path
      const absolutePath = resolveWorkingDirectory(filePath)
      fastify.log.info(`[SAVE-PDF] Target path: ${absolutePath}`)

      // Ensure directory exists
      const dir = path.dirname(absolutePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
        fastify.log.info(`[SAVE-PDF] Created directory: ${dir}`)
      }

      // Write PDF file
      fs.writeFileSync(absolutePath, pdfBuffer)
      
      fastify.log.info(`[SAVE-PDF] ✅ PDF saved: ${absolutePath} (${pdfBuffer.length} bytes)`)

      return {
        success: true,
        filePath: absolutePath,
        size: pdfBuffer.length
      }
    } catch (error) {
      fastify.log.error('[SAVE-PDF] Error:', error)
      return reply.code(500).send({
        success: false,
        message: error.message || 'Failed to save PDF'
      })
    }
  })

  // Save ZIP archive from base64 string (for batch export)
  fastify.post('/documents/save-zip', async (request, reply) => {
    try {
      const { zipBase64, filePath } = request.body
      
      if (!zipBase64) {
        fastify.log.error('[SAVE-ZIP] No ZIP data provided')
        return reply.code(400).send({ 
          success: false, 
          message: 'No ZIP data provided' 
        })
      }
      
      if (!filePath) {
        fastify.log.error('[SAVE-ZIP] No file path provided')
        return reply.code(400).send({ 
          success: false, 
          message: 'No file path provided' 
        })
      }

      // Decode base64 to buffer
      const zipBuffer = Buffer.from(zipBase64, 'base64')
      fastify.log.info(`[SAVE-ZIP] Decoded ZIP: ${zipBuffer.length} bytes`)

      // Resolve to absolute path
      const absolutePath = resolveWorkingDirectory(filePath)
      fastify.log.info(`[SAVE-ZIP] Target path: ${absolutePath}`)

      // Ensure directory exists
      const dir = path.dirname(absolutePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
        fastify.log.info(`[SAVE-ZIP] Created directory: ${dir}`)
      }

      // Write ZIP file
      fs.writeFileSync(absolutePath, zipBuffer)
      
      fastify.log.info(`[SAVE-ZIP] ✅ ZIP saved: ${absolutePath} (${zipBuffer.length} bytes)`)

      return {
        success: true,
        filePath: absolutePath,
        size: zipBuffer.length
      }
    } catch (error) {
      fastify.log.error('[SAVE-ZIP] Error:', error)
      return reply.code(500).send({
        success: false,
        message: error.message || 'Failed to save ZIP'
      })
    }
  })

  // Open document in system default viewer
  fastify.post('/documents/open', async (request, reply) => {
    try {
      const { filePath } = request.body
      
      if (!filePath) {
        return reply.code(400).send({ ok: false, error: 'File path required' })
      }

      if (!fs.existsSync(filePath)) {
        return reply.code(404).send({ ok: false, error: 'File not found' })
      }

      // Open file with default application
      let command
      if (process.platform === 'win32') {
        command = `start "" "${filePath}"`
      } else if (process.platform === 'darwin') {
        command = `open "${filePath}"`
      } else {
        command = `xdg-open "${filePath}"`
      }

      await execAsync(command)
      fastify.log.info(`[OPEN] Opened document: ${filePath}`)

      return { ok: true }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ ok: false, error: 'Failed to open document' })
    }
  })
}
