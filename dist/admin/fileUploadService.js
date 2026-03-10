"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileUploadService = void 0;
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const promises_1 = __importDefault(require("fs/promises"));
const uuid_1 = require("uuid");
class FileUploadService {
    uploadDir;
    tempDir;
    processingDir;
    archivedDir;
    constructor() {
        this.uploadDir = process.env.UPLOAD_DIR || './uploads';
        this.tempDir = path_1.default.join(this.uploadDir, 'temp');
        this.processingDir = path_1.default.join(this.uploadDir, 'processing');
        this.archivedDir = path_1.default.join(this.uploadDir, 'archived');
        this.ensureDirectories();
    }
    async ensureDirectories() {
        const dirs = [this.uploadDir, this.tempDir, this.processingDir, this.archivedDir];
        for (const dir of dirs) {
            try {
                await promises_1.default.access(dir);
            }
            catch {
                await promises_1.default.mkdir(dir, { recursive: true });
            }
        }
    }
    createMulterStorage(options = {}) {
        const maxSize = options.maxSize || 100 * 1024 * 1024; // 100MB default
        const allowedTypes = options.allowedTypes || this.getDefaultAllowedTypes();
        const destination = options.destination || this.tempDir;
        return multer_1.default.diskStorage({
            destination: async (req, file, cb) => {
                try {
                    await promises_1.default.access(destination);
                }
                catch {
                    await promises_1.default.mkdir(destination, { recursive: true });
                }
                cb(null, destination);
            },
            filename: (req, file, cb) => {
                const uniqueId = (0, uuid_1.v4)();
                const extension = path_1.default.extname(file.originalname);
                const filename = `${uniqueId}${extension}`;
                cb(null, filename);
            }
        });
    }
    createFileFilter(options = {}) {
        const allowedTypes = options.allowedTypes || this.getDefaultAllowedTypes();
        return (req, file, cb) => {
            // Check file type
            if (!allowedTypes.includes(file.mimetype)) {
                const error = new Error(`File type ${file.mimetype} is not allowed`);
                error.code = 'INVALID_FILE_TYPE';
                return cb(error);
            }
            // Check file extension
            const extension = path_1.default.extname(file.originalname).toLowerCase();
            const allowedExtensions = ['.zip', '.gpkg', '.csv', '.kml', '.geojson', '.json', '.shp'];
            if (!allowedExtensions.includes(extension)) {
                const error = new Error(`File extension ${extension} is not allowed`);
                error.code = 'INVALID_EXTENSION';
                return cb(error);
            }
            cb(null, true);
        };
    }
    createMulterMiddleware(options = {}) {
        const maxSize = options.maxSize || 100 * 1024 * 1024; // 100MB default
        return (0, multer_1.default)({
            storage: this.createMulterStorage(options),
            fileFilter: this.createFileFilter(options),
            limits: {
                fileSize: maxSize,
                files: 1 // Only one file at a time
            }
        });
    }
    async moveToProcessing(filePath, jobId) {
        const filename = path_1.default.basename(filePath);
        const processingPath = path_1.default.join(this.processingDir, `${jobId}_${filename}`);
        await promises_1.default.rename(filePath, processingPath);
        return processingPath;
    }
    async moveToArchive(filePath, archiveName) {
        const filename = archiveName || path_1.default.basename(filePath);
        const archivePath = path_1.default.join(this.archivedDir, filename);
        await promises_1.default.rename(filePath, archivePath);
        return archivePath;
    }
    async deleteFile(filePath) {
        try {
            await promises_1.default.unlink(filePath);
        }
        catch (error) {
            console.error(`Failed to delete file ${filePath}:`, error);
            throw new Error(`Failed to delete file: ${error}`);
        }
    }
    async getFileInfo(filePath) {
        try {
            const stats = await promises_1.default.stat(filePath);
            const filename = path_1.default.basename(filePath);
            return {
                id: path_1.default.parse(filename).name,
                originalName: filename,
                filename,
                mimetype: this.getMimeTypeFromExtension(path_1.default.extname(filename)),
                size: stats.size,
                path: filePath,
                uploadedAt: stats.birthtime
            };
        }
        catch {
            return null;
        }
    }
    async validateShapefile(filePath) {
        const errors = [];
        const filename = path_1.default.basename(filePath, '.zip');
        try {
            // Check if it's a zip file
            const stats = await promises_1.default.stat(filePath);
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
        }
        catch (error) {
            errors.push(`Failed to validate shapefile: ${error}`);
            return { valid: false, errors };
        }
    }
    async validateGeoPackage(filePath) {
        const errors = [];
        try {
            // TODO: Add GeoPackage validation
            // - Check file format
            // - Validate spatial tables
            // - Check geometry columns
            return {
                valid: errors.length === 0,
                errors
            };
        }
        catch (error) {
            errors.push(`Failed to validate GeoPackage: ${error}`);
            return { valid: false, errors };
        }
    }
    async validateCSV(filePath) {
        const errors = [];
        try {
            const content = await promises_1.default.readFile(filePath, 'utf-8');
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
        }
        catch (error) {
            errors.push(`Failed to validate CSV: ${error}`);
            return { valid: false, errors };
        }
    }
    async cleanupOldFiles(maxAge = 24 * 60 * 60 * 1000) {
        const dirs = [this.tempDir, this.processingDir];
        const now = Date.now();
        for (const dir of dirs) {
            try {
                const files = await promises_1.default.readdir(dir);
                for (const file of files) {
                    const filePath = path_1.default.join(dir, file);
                    const stats = await promises_1.default.stat(filePath);
                    if (now - stats.mtime.getTime() > maxAge) {
                        await this.deleteFile(filePath);
                        console.log(`Cleaned up old file: ${filePath}`);
                    }
                }
            }
            catch (error) {
                console.error(`Failed to cleanup directory ${dir}:`, error);
            }
        }
    }
    getDefaultAllowedTypes() {
        return [
            'application/zip', // Shapefile
            'application/geopackage', // GeoPackage
            'text/csv', // CSV
            'application/vnd.google-earth.kml+xml', // KML
            'application/geo+json', // GeoJSON
            'application/json' // JSON
        ];
    }
    getMimeTypeFromExtension(extension) {
        const mimeTypes = {
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
    async getFileStats() {
        const getDirStats = async (dir) => {
            try {
                const files = await promises_1.default.readdir(dir);
                let count = 0;
                let size = 0;
                for (const file of files) {
                    const filePath = path_1.default.join(dir, file);
                    const stats = await promises_1.default.stat(filePath);
                    count++;
                    size += stats.size;
                }
                return { count, size };
            }
            catch {
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
exports.FileUploadService = FileUploadService;
//# sourceMappingURL=fileUploadService.js.map