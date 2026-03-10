import multer from 'multer';
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
export declare class FileUploadService {
    private readonly uploadDir;
    private readonly tempDir;
    private readonly processingDir;
    private readonly archivedDir;
    constructor();
    private ensureDirectories;
    createMulterStorage(options?: FileUploadOptions): multer.StorageEngine;
    createFileFilter(options?: FileUploadOptions): multer.FileFilter;
    createMulterMiddleware(options?: FileUploadOptions): multer.Multer;
    moveToProcessing(filePath: string, jobId: string): Promise<string>;
    moveToArchive(filePath: string, archiveName?: string): Promise<string>;
    deleteFile(filePath: string): Promise<void>;
    getFileInfo(filePath: string): Promise<UploadedFile | null>;
    validateShapefile(filePath: string): Promise<{
        valid: boolean;
        errors: string[];
    }>;
    validateGeoPackage(filePath: string): Promise<{
        valid: boolean;
        errors: string[];
    }>;
    validateCSV(filePath: string): Promise<{
        valid: boolean;
        errors: string[];
    }>;
    cleanupOldFiles(maxAge?: number): Promise<void>;
    private getDefaultAllowedTypes;
    private getMimeTypeFromExtension;
    getFileStats(): Promise<{
        tempFiles: number;
        processingFiles: number;
        archivedFiles: number;
        totalSize: number;
    }>;
}
//# sourceMappingURL=fileUploadService.d.ts.map