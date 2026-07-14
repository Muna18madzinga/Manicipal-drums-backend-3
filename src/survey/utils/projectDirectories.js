import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Resolve working directory to absolute path
 * @param {string} workingDirectory - The working directory path (relative or absolute)
 * @returns {string} Absolute path
 */
function resolveWorkingDirectory(workingDirectory) {
  // If already absolute, return as-is
  if (path.isAbsolute(workingDirectory)) {
    return workingDirectory
  }
  
  // If relative, resolve from user's home directory
  // Use USERPROFILE on Windows, HOME on Unix/Linux
  const homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir()
  console.log(`[resolveWorkingDirectory] Using home directory: ${homeDir}`)
  return path.join(homeDir, workingDirectory)
}

/**
 * Create the standard directory structure for a survey project
 * @param {string} workingDirectory - The working directory path for the project
 * @returns {Promise<{success: boolean, message: string, directories?: string[], absolutePath?: string}>}
 */
export async function createProjectDirectories(workingDirectory) {
  if (!workingDirectory) {
    return { success: false, message: 'Working directory path is required' }
  }

  try {
    // Resolve to absolute path
    const absolutePath = resolveWorkingDirectory(workingDirectory)
    console.log(`[createProjectDirectories] Resolved path: ${workingDirectory} -> ${absolutePath}`)
    
    // Define the standard directory structure
    const directories = [
      absolutePath,
      path.join(absolutePath, 'input'),
      path.join(absolutePath, 'output'),
      path.join(absolutePath, 'output', 'field-book'),
      path.join(absolutePath, 'output', 'calculations'),
      path.join(absolutePath, 'output', 'coordinate-list'),
      path.join(absolutePath, 'output', 'reports'),
      path.join(absolutePath, 'output', 'certificates')
    ]

    // Create each directory if it doesn't exist
    const createdDirs = []
    for (const dir of directories) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
        createdDirs.push(dir)
        console.log(`Created directory: ${dir}`)
      }
    }

    // Create a README file in the working directory
    const readmePath = path.join(absolutePath, 'README.txt')
    if (!fs.existsSync(readmePath)) {
      const readmeContent = `Survey Project Directory Structure
=====================================

This directory contains all files for this survey project.

Directory Structure:
- input/              : CSV files, control points (CSV files, control points)
- output/             : Generated documents
  - field-book/       : Electronic Field Book PDFs
  - calculations/     : Calculations Part 1 & 2 PDFs
  - coordinate-list/  : Coordinate List PDFs
  - reports/          : Report on Survey PDFs
  - certificates/     : DSG Certificate PDFs

Generated: ${new Date().toISOString()}
`
      fs.writeFileSync(readmePath, readmeContent, 'utf8')
      console.log(`Created README: ${readmePath}`)
    }

    return {
      success: true,
      message: createdDirs.length > 0 
        ? `Created ${createdDirs.length} directories at ${absolutePath}` 
        : `All directories already exist at ${absolutePath}`,
      directories: createdDirs,
      absolutePath
    }
  } catch (error) {
    console.error('Error creating project directories:', error)
    return {
      success: false,
      message: `Failed to create directories: ${error.message}`
    }
  }
}

/**
 * Verify that a project directory structure exists
 * @param {string} workingDirectory - The working directory path to verify
 * @returns {boolean}
 */
export function verifyProjectDirectories(workingDirectory) {
  if (!workingDirectory) return false

  const requiredDirs = [
    workingDirectory,
    path.join(workingDirectory, 'input'),
    path.join(workingDirectory, 'output')
  ]

  return requiredDirs.every(dir => fs.existsSync(dir))
}

/**
 * Recursively delete a directory and all its contents
 * @param {string} dirPath - Path to directory to delete
 */
function deleteDirRecursive(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return
  }

  // Read all files/subdirectories
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name)
    
    if (entry.isDirectory()) {
      // Recursively delete subdirectory
      deleteDirRecursive(fullPath)
    } else {
      // Delete file
      fs.unlinkSync(fullPath)
    }
  }

  // Delete the now-empty directory
  fs.rmdirSync(dirPath)
}

/**
 * Delete project directory and all its contents
 * @param {string} workingDirectory - The working directory path to delete
 * @returns {Promise<{success: boolean, message: string, deletedPath?: string}>}
 */
export async function deleteProjectDirectory(workingDirectory) {
  if (!workingDirectory) {
    return { success: false, message: 'Working directory path is required' }
  }

  try {
    // Resolve to absolute path
    const absolutePath = resolveWorkingDirectory(workingDirectory)
    console.log(`[deleteProjectDirectory] Attempting to delete: ${absolutePath}`)

    // Safety check: ensure path is within expected project directories
    const homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir()
    const documentsPath = path.join(homeDir, 'Documents', 'Survey Task Manager', 'Projects')
    
    if (!absolutePath.startsWith(documentsPath) && !absolutePath.startsWith(homeDir)) {
      console.warn(`[deleteProjectDirectory] Safety check failed: Path ${absolutePath} is outside expected directories`)
      return {
        success: false,
        message: 'Cannot delete directory outside of user project folders (safety check)'
      }
    }

    // Check if directory exists
    if (!fs.existsSync(absolutePath)) {
      console.log(`[deleteProjectDirectory] Directory does not exist: ${absolutePath}`)
      return {
        success: true,
        message: 'Directory does not exist (already deleted or never created)',
        deletedPath: absolutePath
      }
    }

    // Delete the directory and all contents
    deleteDirRecursive(absolutePath)
    console.log(`[deleteProjectDirectory] Successfully deleted: ${absolutePath}`)

    return {
      success: true,
      message: `Successfully deleted project directory: ${absolutePath}`,
      deletedPath: absolutePath
    }
  } catch (error) {
    console.error('[deleteProjectDirectory] Error:', error)
    return {
      success: false,
      message: `Failed to delete directory: ${error.message}`
    }
  }
}
