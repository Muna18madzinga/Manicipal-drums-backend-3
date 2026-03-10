/**
 * WFS Layer Publisher Service
 * 
 * Integrates with PyQGIS script to automatically publish layers for WFS service.
 * This service handles the automation of WFS publishing for novice users.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../../utils/logger');

class WFSLayerPublisher {
  constructor() {
    this.scriptPath = path.join(__dirname, '../../scripts/publish_wfs_layers.py');
    this.pythonPath = this.getPythonPath();
    this.publishingCache = new Map(); // Cache to avoid re-publishing
  }

  /**
   * Get the Python path for QGIS environment
   */
  getPythonPath() {
    // Use QGIS Python batch file for proper environment setup
    const possiblePaths = [
      { pythonPath: '"C:\\Program Files\\QGIS 3.44.3\\bin\\python-qgis.bat"' },
      'C:/Program Files/QGIS 3.44/bin/python-qgis.bat',
      'C:/Program Files/QGIS 3.44.3/bin/python3.exe',
      'C:/Program Files/QGIS 3.44.3/bin/python.exe',
      'python3',
      'python'
    ];

    return possiblePaths[0]; // Use QGIS batch file first
  }

  /**
   * Publish layers for WFS using PyQGIS script
   * @param {string} projectPath - Path to QGIS project file
   * @param {Array} layerNames - Array of layer names to publish
   * @param {Object} options - Publishing options
   * @returns {Promise<Object>} Publishing results
   */
  async publishLayers(projectPath, layerNames = [], options = {}) {
    try {
      logger.info(`[WFS Publisher] 🚀 Starting WFS layer publishing for project: ${projectPath}`);
      
      // Check cache to avoid re-publishing
      const cacheKey = `${projectPath}:${layerNames.join(',')}`;
      if (this.publishingCache.has(cacheKey)) {
        logger.info(`[WFS Publisher] 📋 Using cached publishing result for ${cacheKey}`);
        return this.publishingCache.get(cacheKey);
      }

      // Validate inputs
      await this.validateInputs(projectPath, layerNames);

      // Build command arguments
      const args = this.buildCommandArgs(projectPath, layerNames, options);

      // Execute PyQGIS script
      const result = await this.executePyQGISScript(args);

      // Cache successful results
      if (result.success) {
        this.publishingCache.set(cacheKey, result);
      }

      logger.info(`[WFS Publisher] ✅ Publishing completed: ${result.published.length} layers published`);
      
      return result;

    } catch (error) {
      logger.error(`[WFS Publisher] ❌ Publishing failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Publish all vector layers in a project
   * @param {string} projectPath - Path to QGIS project file
   * @param {Object} options - Publishing options
   * @returns {Promise<Object>} Publishing results
   */
  async publishAllLayers(projectPath, options = {}) {
    return this.publishLayers(projectPath, [], { ...options, publishAll: true });
  }

  /**
   * Validate inputs before publishing
   * @param {string} projectPath - Path to QGIS project file
   * @param {Array} layerNames - Array of layer names
   */
  async validateInputs(projectPath, layerNames) {
    // Check if project file exists
    try {
      await fs.access(projectPath);
    } catch (error) {
      throw new Error(`Project file not found: ${projectPath}`);
    }

    // Check if PyQGIS script exists
    try {
      await fs.access(this.scriptPath);
    } catch (error) {
      throw new Error(`PyQGIS script not found: ${this.scriptPath}`);
    }

    // Validate project file extension
    if (!projectPath.endsWith('.qgs') && !projectPath.endsWith('.qgz')) {
      throw new Error('Invalid project file extension. Must be .qgs or .qgz');
    }
  }

  /**
   * Build command arguments for PyQGIS script
   * @param {string} projectPath - Path to QGIS project file
   * @param {Array} layerNames - Array of layer names
   * @param {Object} options - Publishing options
   * @returns {Array} Command arguments
   */
  buildCommandArgs(projectPath, layerNames, options) {
    const args = [
      this.scriptPath,
      '--project', projectPath,
      '--verbose'
    ];

    // Add layer names or publish all
    if (options.publishAll) {
      args.push('--all-layers');
    } else if (layerNames.length > 0) {
      args.push('--layers', layerNames.join(','));
    } else {
      throw new Error('Either layerNames or publishAll option must be specified');
    }

    // Add WFS URL if specified
    if (options.wfsUrl) {
      args.push('--wfs-url', options.wfsUrl);
    }

    // Add save option (default: true)
    if (options.save !== false) {
      args.push('--save');
    }

    return args;
  }

  /**
   * Execute PyQGIS script with proper error handling
   * @param {Array} args - Command arguments
   * @returns {Promise<Object>} Script execution results
   */
  async executePyQGISScript(args) {
    return new Promise((resolve, reject) => {
      logger.info(`[WFS Publisher] 🐍 Executing PyQGIS script: ${this.pythonPath} ${args.join(' ')}`);

      // For Windows, use cmd.exe to properly execute batch files with environment
      const isWindows = process.platform === 'win32';
      let command, commandArgs;
      
      if (isWindows && this.pythonPath.endsWith('.bat')) {
        // Use cmd.exe to execute batch file with proper environment
        command = 'cmd.exe';
        commandArgs = ['/c', this.pythonPath, ...args];
      } else {
        // Use direct execution for Linux/Mac or .exe files
        command = this.pythonPath;
        commandArgs = args;
      }

      const childProcess = spawn(command, commandArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONPATH: this.getQGISPythonPath(),
          QGIS_PREFIX_PATH: this.getQGISPrefixPath()
        },
        cwd: path.dirname(this.scriptPath)
      });

      let stdout = '';
      let stderr = '';

      childProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      childProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      childProcess.on('close', (code) => {
        logger.info(`[WFS Publisher] 📤 PyQGIS script exited with code: ${code}`);

        if (code === 0) {
          // Parse successful output
          const result = this.parseScriptOutput(stdout);
          resolve(result);
        } else {
          // Handle error
          const error = this.parseScriptError(stderr);
          reject(new Error(`PyQGIS script failed: ${error.message}`));
        }
      });

      childProcess.on('error', (error) => {
        logger.error(`[WFS Publisher] ❌ Process error: ${error.message}`);
        reject(new Error(`Failed to execute PyQGIS script: ${error.message}`));
      });

      // Set timeout
      const timeout = setTimeout(() => {
        childProcess.kill();
        reject(new Error('PyQGIS script execution timeout'));
      }, 60000); // 60 seconds

      childProcess.on('close', () => {
        clearTimeout(timeout);
      });
    });
  }

  /**
   * Parse successful script output
   * @param {string} output - Script stdout
   * @returns {Object} Parsed results
   */
  parseScriptOutput(output) {
    const result = {
      success: true,
      published: [],
      failed: [],
      totalAttempted: 0,
      successRate: 0,
      details: output
    };

    // Parse published layers
    const publishedMatch = output.match(/Successfully published: (\d+)/);
    if (publishedMatch) {
      result.totalAttempted = parseInt(publishedMatch[1]);
    }

    // Extract layer names from output
    const publishedLines = output.match(/✅ Published layers:[\s\S]*?(?=\n\n|\n❌|$)/);
    if (publishedLines) {
      const layerMatches = publishedLines[0].match(/- (.+)/g);
      if (layerMatches) {
        result.published = layerMatches.map(line => line.replace('- ', '').trim());
      }
    }

    const failedLines = output.match(/❌ Failed layers:[\s\S]*?(?=\n\n|$)/);
    if (failedLines) {
      const layerMatches = failedLines[0].match(/- (.+)/g);
      if (layerMatches) {
        result.failed = layerMatches.map(line => line.replace('- ', '').trim());
      }
    }

    // Calculate success rate
    result.successRate = result.totalAttempted > 0 
      ? (result.published.length / result.totalAttempted) * 100 
      : 0;

    return result;
  }

  /**
   * Parse script error output
   * @param {string} error - Script stderr
   * @returns {Object} Parsed error
   */
  parseScriptError(error) {
    // Common error patterns
    if (error.includes('QGIS libraries not found')) {
      return {
        type: 'QGIS_NOT_FOUND',
        message: 'QGIS libraries not found. Please install QGIS or check Python environment.',
        details: error
      };
    }

    if (error.includes('Project file not found')) {
      return {
        type: 'PROJECT_NOT_FOUND',
        message: 'QGIS project file not found.',
        details: error
      };
    }

    if (error.includes('Layer not found')) {
      return {
        type: 'LAYER_NOT_FOUND',
        message: 'One or more specified layers not found in the project.',
        details: error
      };
    }

    return {
      type: 'UNKNOWN_ERROR',
      message: 'Unknown error occurred during WFS publishing.',
      details: error
    };
  }

  /**
   * Get QGIS Python path
   * @returns {string} Python path for QGIS
   */
  getQGISPythonPath() {
    // QGIS Python paths for Windows
    const possiblePaths = [
      'C:/Program Files/QGIS 3.44.3/python',
      'C:/Program Files/QGIS 3.44/python',
      'C:/Program Files/QGIS 3.44.3/apps/qgis/python',
      'C:/OSGeo4W64/apps/qgis/python',
      'C:/OSGeo4W/apps/qgis/python'
    ];

    return possiblePaths.join(';'); // Windows-style path separator
  }

  /**
   * Get QGIS prefix path
   * @returns {string} QGIS prefix path
   */
  getQGISPrefixPath() {
    const possiblePaths = [
      'C:/Program Files/QGIS 3.44.3',
      'C:/Program Files/QGIS 3.44',
      'C:/OSGeo4W64/apps/qgis',
      'C:/OSGeo4W/apps/qgis'
    ];

    return possiblePaths[0]; // Use QGIS 3.44.3
  }

  /**
   * Clear publishing cache
   */
  clearCache() {
    this.publishingCache.clear();
    logger.info('[WFS Publisher] 🗑️ Cache cleared');
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache stats
   */
  getCacheStats() {
    return {
      size: this.publishingCache.size,
      keys: Array.from(this.publishingCache.keys())
    };
  }
}

module.exports = WFSLayerPublisher;
