import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';

export interface FileUploadOptions {
  maxSize?: number;
  allowedTypes?: string[];
  destination?: string;
}

export interface UploadedFile {
  id: string;
  originalName: string;
  filename: string;
  mimetype: string;
  size: number;
  path: string;
  uploadedAt: Date;
}

export class FileUploadService {
  private readonly uploadDir: string;
  private readonly tempDir: string;
  private readonly processingDir: string;
  private readonly archivedDir: string;

  constructor() {
    this.uploadDir = process.env.UPLOAD_DIR || './uploads';
    this.tempDir = path.join(this.uploadDir, 'temp');
    this.processingDir = path.join(this.uploadDir, 'processing');
    this.archivedDir = path.join(this.uploadDir, 'archived');
    
    this.ensureDirectories();
  }

  private async ensureDirectories(): Promise<void> {
    const dirs = [this.uploadDir, this.tempDir, this.processingDir, this.archivedDir];
    
    for (const dir of dirs) {
      try {
        await fs.access(dir);
      } catch {
        await fs.mkdir(dir, { recursive: true });
      }
    }
  }

  createMulterStorage(options: FileUploadOptions = {}): multer.StorageEngine {
    const maxSize = options.maxSize || 100 * 1024 * 1024; // 100MB default
    const allowedTypes = options.allowedTypes || this.getDefaultAllowedTypes();
    const destination = options.destination || this.tempDir;

    return multer.diskStorage({
      destination: async (req, file, cb) => {
        try {
          await fs.access(destination);
        } catch {
          await fs.mkdir(destination, { recursive: true });
        }
        cb(null, destination);
      },
      filename: (req, file, cb) => {
        const uniqueId = uuidv4();
        const extension = path.extname(file.originalname);
        const filename = `${uniqueId}${extension}`;
        cb(null, filename);
      }
    });
  }

  createFileFilter(options: FileUploadOptions = {}): multer.FileFilter {
    const allowedTypes = options.allowedTypes || this.getDefaultAllowedTypes();

    return (req, file, cb) => {
      // Check file type
      if (!allowedTypes.includes(file.mimetype)) {
        const error = new Error(`File type ${file.mimetype} is not allowed`);
        (error as any).code = 'INVALID_FILE_TYPE';
        return cb(error);
      }

      // Check file extension
      const extension = path.extname(file.originalname).toLowerCase();
      const allowedExtensions = ['.zip', '.gpkg', '.csv', '.kml', '.geojson', '.json', '.shp'];
      
      if (!allowedExtensions.includes(extension)) {
        const error = new Error(`File extension ${extension} is not allowed`);
        (error as any).code = 'INVALID_EXTENSION';
        return cb(error);
      }

      cb(null, true);
    };
  }

  createMulterMiddleware(options: FileUploadOptions = {}): multer.Multer {
    const maxSize = options.maxSize || 100 * 1024 * 1024; // 100MB default

    return multer({
      storage: this.createMulterStorage(options),
      fileFilter: this.createFileFilter(options),
      limits: {
        fileSize: maxSize,
        files: 1 // Only one file at a time
      }
    });
  }

  async moveToProcessing(filePath: string, jobId: string): Promise<string> {
    const filename = path.basename(filePath);
    const processingPath = path.join(this.processingDir, `${jobId}_${filename}`);
    
    await fs.rename(filePath, processingPath);
    return processingPath;
  }

  async moveToArchive(filePath: string, archiveName?: string): Promise<string> {
    const filename = archiveName || path.basename(filePath);
    const archivePath = path.join(this.archivedDir, filename);
    
    await fs.rename(filePath, archivePath);
    return archivePath;
  }

  async deleteFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      console.error(`Failed to delete file ${filePath}:`, error);
      throw new Error(`Failed to delete file: ${error}`);
    }
  }

  async getFileInfo(filePath: string): Promise<UploadedFile | null> {
    try {
      const stats = await fs.stat(filePath);
      const filename = path.basename(filePath);
      
      return {
        id: path.parse(filename).name,
        originalName: filename,
        filename,
        mimetype: this.getMimeTypeFromExtension(path.extname(filename)),
        size: stats.size,
        path: filePath,
        uploadedAt: stats.birthtime
      };
    } catch {
      return null;
    }
  }

  async validateShapefile(filePath: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    const filename = path.basename(filePath, '.zip');
    
    try {
      // Check if it's a zip file
      const stats = await fs.stat(filePath);
      if (!filename.endsWith('.zip')) {
        errors.push('Shapefile must be uploaded as a ZIP file');
      }

      // TODO: Add more sophisticated validation
      // - Check for required files (.shp, .shx, .dbf)
      // - Validate geometry types
      // - Check coordinate system

      return {
        valid: errors.length === 0,
        errors
      };
    } catch (error) {
      errors.push(`Failed to validate shapefile: ${error}`);
      return { valid: false, errors };
    }
  }

  async validateGeoPackage(filePath: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    
    try {
      // TODO: Add GeoPackage validation
      // - Check file format
      // - Validate spatial tables
      // - Check geometry columns

      return {
        valid: errors.length === 0,
        errors
      };
    } catch (error) {
      errors.push(`Failed to validate GeoPackage: ${error}`);
      return { valid: false, errors };
    }
  }

  async validateCSV(filePath: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      
      if (lines.length < 2) {
        errors.push('CSV file must have at least a header and one data row');
      }

      // TODO: Add more CSV validation
      // - Check for required columns (lat/lng or x/y)
      // - Validate data types
      // - Check coordinate format

      return {
        valid: errors.length === 0,
        errors
      };
    } catch (error) {
      errors.push(`Failed to validate CSV: ${error}`);
      return { valid: false, errors };
    }
  }

  async cleanupOldFiles(maxAge: number = 24 * 60 * 60 * 1000): Promise<void> {
    const dirs = [this.tempDir, this.processingDir];
    const now = Date.now();

    for (const dir of dirs) {
      try {
        const files = await fs.readdir(dir);
        
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stats = await fs.stat(filePath);
          
          if (now - stats.mtime.getTime() > maxAge) {
            await this.deleteFile(filePath);
            console.log(`Cleaned up old file: ${filePath}`);
          }
        }
      } catch (error) {
        console.error(`Failed to cleanup directory ${dir}:`, error);
      }
    }
  }

  private getDefaultAllowedTypes(): string[] {
    return [
      'application/zip',           // Shapefile
      'application/geopackage',    // GeoPackage
      'text/csv',                 // CSV
      'application/vnd.google-earth.kml+xml', // KML
      'application/geo+json',      // GeoJSON
      'application/json'           // JSON
    ];
  }

  private getMimeTypeFromExtension(extension: string): string {
    const mimeTypes: Record<string, string> = {
      '.zip': 'application/zip',
      '.gpkg': 'application/geopackage',
      '.csv': 'text/csv',
      '.kml': 'application/vnd.google-earth.kml+xml',
      '.geojson': 'application/geo+json',
      '.json': 'application/json',
      '.shp': 'application/octet-stream',
      '.shx': 'application/octet-stream',
      '.dbf': 'application/octet-stream'
    };

    return mimeTypes[extension] || 'application/octet-stream';
  }

  async getFileStats(): Promise<{
    tempFiles: number;
    processingFiles: number;
    archivedFiles: number;
    totalSize: number;
  }> {
    const getDirStats = async (dir: string): Promise<{ count: number; size: number }> => {
      try {
        const files = await fs.readdir(dir);
        let count = 0;
        let size = 0;

        for (const file of files) {
          const filePath = path.join(dir, file);
          const stats = await fs.stat(filePath);
          count++;
          size += stats.size;
        }

        return { count, size };
      } catch {
        return { count: 0, size: 0 };
      }
    };

    const tempStats = await getDirStats(this.tempDir);
    const processingStats = await getDirStats(this.processingDir);
    const archivedStats = await getDirStats(this.archivedDir);

    return {
      tempFiles: tempStats.count,
      processingFiles: processingStats.count,
      archivedFiles: archivedStats.count,
      totalSize: tempStats.size + processingStats.size + archivedStats.size
    };
  }
}
