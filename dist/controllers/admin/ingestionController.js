"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IngestionController = void 0;
const fileUploadService_1 = require("../../services/admin/fileUploadService");
const AdminUser_1 = require("../../models/AdminUser");
const uuid_1 = require("uuid");
class IngestionController {
    fileUploadService;
    adminUserModel;
    pool;
    constructor(pool) {
        this.pool = pool;
        this.fileUploadService = new fileUploadService_1.FileUploadService();
        this.adminUserModel = new AdminUser_1.AdminUserModel(pool);
    }
    uploadFile = async (req, res) => {
        try {
            if (!req.user) {
                res.status(401).json({
                    error: 'Authentication required',
                    message: 'User must be authenticated to upload files'
                });
                return;
            }
            // Check permissions
            const hasPermission = await this.adminUserModel.hasPermission(req.user.sub, 'data.create');
            if (!hasPermission) {
                res.status(403).json({
                    error: 'Insufficient permissions',
                    message: 'You do not have permission to upload data'
                });
                return;
            }
            if (!req.file) {
                res.status(400).json({
                    error: 'No file uploaded',
                    message: 'Please select a file to upload'
                });
                return;
            }
            const { jobName, config } = req.body;
            // Validate configuration
            const ingestionConfig = this.parseConfig(config);
            if (!jobName || !ingestionConfig.tableName) {
                res.status(400).json({
                    error: 'Missing required fields',
                    message: 'Job name and target table are required'
                });
                return;
            }
            // Validate file based on type
            const validationResult = await this.validateFile(req.file.path, ingestionConfig.sourceType);
            if (!validationResult.valid) {
                // Clean up uploaded file
                await this.fileUploadService.deleteFile(req.file.path);
                res.status(400).json({
                    error: 'File validation failed',
                    message: 'Uploaded file failed validation',
                    errors: validationResult.errors
                });
                return;
            }
            // Create ingestion job
            const jobId = (0, uuid_1.v4)();
            const job = await this.createIngestionJob({
                id: jobId,
                admin_user_id: req.user.sub,
                job_name: jobName,
                status: 'pending',
                source_type: ingestionConfig.sourceType,
                source_file_path: req.file.path,
                target_table: ingestionConfig.tableName,
                configuration: ingestionConfig,
                statistics: {},
                created_at: new Date()
            });
            res.status(201).json({
                success: true,
                message: 'File uploaded successfully',
                data: {
                    job,
                    file: {
                        originalName: req.file.originalname,
                        filename: req.file.filename,
                        size: req.file.size,
                        mimetype: req.file.mimetype
                    }
                }
            });
        }
        catch (error) {
            console.error('Upload error:', error);
            // Clean up uploaded file if it exists
            if (req.file) {
                try {
                    await this.fileUploadService.deleteFile(req.file.path);
                }
                catch (cleanupError) {
                    console.error('Failed to cleanup file:', cleanupError);
                }
            }
            res.status(500).json({
                error: 'Upload failed',
                message: 'An error occurred during file upload'
            });
        }
    };
    getJobs = async (req, res) => {
        try {
            if (!req.user) {
                res.status(401).json({
                    error: 'Authentication required',
                    message: 'User must be authenticated'
                });
                return;
            }
            const hasPermission = await this.adminUserModel.hasPermission(req.user.sub, 'data.read');
            if (!hasPermission) {
                res.status(403).json({
                    error: 'Insufficient permissions',
                    message: 'You do not have permission to view jobs'
                });
                return;
            }
            const { status, page = 1, limit = 20 } = req.query;
            const offset = (Number(page) - 1) * Number(limit);
            let query = `
        SELECT ij.*, u.email as user_email, au.role as user_role
        FROM data_ingestion_jobs ij
        JOIN admin_users au ON ij.admin_user_id = au.id
        JOIN users u ON au.user_id = u.id
        WHERE 1=1
      `;
            const params = [];
            let paramIndex = 1;
            if (status) {
                query += ` AND ij.status = $${paramIndex++}`;
                params.push(status);
            }
            // Non-super admins can only see their own jobs
            if (req.user.role !== 'super_admin') {
                query += ` AND ij.admin_user_id = $${paramIndex++}`;
                params.push(req.user.sub);
            }
            query += ` ORDER BY ij.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
            params.push(Number(limit), offset);
            const result = await this.pool.query(query, params);
            // Get total count
            let countQuery = `
        SELECT COUNT(*) as total
        FROM data_ingestion_jobs ij
        WHERE 1=1
      `;
            const countParams = [];
            let countIndex = 1;
            if (status) {
                countQuery += ` AND ij.status = $${countIndex++}`;
                countParams.push(status);
            }
            if (req.user.role !== 'super_admin') {
                countQuery += ` AND ij.admin_user_id = $${countIndex++}`;
                countParams.push(req.user.sub);
            }
            const countResult = await this.pool.query(countQuery, countParams);
            const total = parseInt(countResult.rows[0].total);
            res.status(200).json({
                success: true,
                data: {
                    jobs: result.rows,
                    pagination: {
                        page: Number(page),
                        limit: Number(limit),
                        total,
                        pages: Math.ceil(total / Number(limit))
                    }
                }
            });
        }
        catch (error) {
            console.error('Get jobs error:', error);
            res.status(500).json({
                error: 'Failed to fetch jobs',
                message: 'An error occurred while fetching jobs'
            });
        }
    };
    getJob = async (req, res) => {
        try {
            if (!req.user) {
                res.status(401).json({
                    error: 'Authentication required',
                    message: 'User must be authenticated'
                });
                return;
            }
            const { id } = req.params;
            const hasPermission = await this.adminUserModel.hasPermission(req.user.sub, 'data.read');
            if (!hasPermission) {
                res.status(403).json({
                    error: 'Insufficient permissions',
                    message: 'You do not have permission to view jobs'
                });
                return;
            }
            const query = `
        SELECT ij.*, u.email as user_email, au.role as user_role
        FROM data_ingestion_jobs ij
        JOIN admin_users au ON ij.admin_user_id = au.id
        JOIN users u ON au.user_id = u.id
        WHERE ij.id = $1
      `;
            const result = await this.pool.query(query, [id]);
            if (result.rows.length === 0) {
                res.status(404).json({
                    error: 'Job not found',
                    message: 'Ingestion job not found'
                });
                return;
            }
            const job = result.rows[0];
            // Check if user has access to this job
            if (req.user.role !== 'super_admin' && job.admin_user_id !== req.user.sub) {
                res.status(403).json({
                    error: 'Access denied',
                    message: 'You do not have permission to view this job'
                });
                return;
            }
            res.status(200).json({
                success: true,
                data: { job }
            });
        }
        catch (error) {
            console.error('Get job error:', error);
            res.status(500).json({
                error: 'Failed to fetch job',
                message: 'An error occurred while fetching the job'
            });
        }
    };
    startJob = async (req, res) => {
        try {
            if (!req.user) {
                res.status(401).json({
                    error: 'Authentication required',
                    message: 'User must be authenticated'
                });
                return;
            }
            const { id } = req.params;
            const hasPermission = await this.adminUserModel.hasPermission(req.user.sub, 'data.update');
            if (!hasPermission) {
                res.status(403).json({
                    error: 'Insufficient permissions',
                    message: 'You do not have permission to start jobs'
                });
                return;
            }
            // Get job
            const jobResult = await this.pool.query('SELECT * FROM data_ingestion_jobs WHERE id = $1', [id]);
            if (jobResult.rows.length === 0) {
                res.status(404).json({
                    error: 'Job not found',
                    message: 'Ingestion job not found'
                });
                return;
            }
            const job = jobResult.rows[0];
            // Check if user has access to this job
            if (req.user.role !== 'super_admin' && job.admin_user_id !== req.user.sub) {
                res.status(403).json({
                    error: 'Access denied',
                    message: 'You do not have permission to start this job'
                });
                return;
            }
            // Check job status
            if (job.status !== 'pending') {
                res.status(400).json({
                    error: 'Invalid job status',
                    message: `Job cannot be started. Current status: ${job.status}`
                });
                return;
            }
            // Update job status
            await this.pool.query('UPDATE data_ingestion_jobs SET status = $1, started_at = NOW() WHERE id = $2', ['processing', id]);
            // TODO: Start actual processing in background
            // This would involve calling the data processing pipeline
            res.status(200).json({
                success: true,
                message: 'Job started successfully',
                data: { jobId: id }
            });
        }
        catch (error) {
            console.error('Start job error:', error);
            res.status(500).json({
                error: 'Failed to start job',
                message: 'An error occurred while starting the job'
            });
        }
    };
    cancelJob = async (req, res) => {
        try {
            if (!req.user) {
                res.status(401).json({
                    error: 'Authentication required',
                    message: 'User must be authenticated'
                });
                return;
            }
            const { id } = req.params;
            const hasPermission = await this.adminUserModel.hasPermission(req.user.sub, 'data.update');
            if (!hasPermission) {
                res.status(403).json({
                    error: 'Insufficient permissions',
                    message: 'You do not have permission to cancel jobs'
                });
                return;
            }
            // Get and validate job
            const jobResult = await this.pool.query('SELECT * FROM data_ingestion_jobs WHERE id = $1', [id]);
            if (jobResult.rows.length === 0) {
                res.status(404).json({
                    error: 'Job not found',
                    message: 'Ingestion job not found'
                });
                return;
            }
            const job = jobResult.rows[0];
            // Check access
            if (req.user.role !== 'super_admin' && job.admin_user_id !== req.user.sub) {
                res.status(403).json({
                    error: 'Access denied',
                    message: 'You do not have permission to cancel this job'
                });
                return;
            }
            // Check if job can be cancelled
            if (!['pending', 'processing'].includes(job.status)) {
                res.status(400).json({
                    error: 'Invalid job status',
                    message: `Job cannot be cancelled. Current status: ${job.status}`
                });
                return;
            }
            // Update job status
            await this.pool.query('UPDATE data_ingestion_jobs SET status = $1, completed_at = NOW() WHERE id = $2', ['cancelled', id]);
            // TODO: Stop any background processing
            res.status(200).json({
                success: true,
                message: 'Job cancelled successfully',
                data: { jobId: id }
            });
        }
        catch (error) {
            console.error('Cancel job error:', error);
            res.status(500).json({
                error: 'Failed to cancel job',
                message: 'An error occurred while cancelling the job'
            });
        }
    };
    async createIngestionJob(jobData) {
        const query = `
      INSERT INTO data_ingestion_jobs (
        id, admin_user_id, job_name, status, source_type, 
        source_file_path, target_table, configuration, 
        statistics, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
      )
      RETURNING *
    `;
        const values = [
            jobData.id,
            jobData.admin_user_id,
            jobData.job_name,
            jobData.status,
            jobData.source_type,
            jobData.source_file_path,
            jobData.target_table,
            JSON.stringify(jobData.configuration),
            JSON.stringify(jobData.statistics),
            jobData.created_at
        ];
        const result = await this.pool.query(query, values);
        return result.rows[0];
    }
    parseConfig(configString) {
        try {
            return JSON.parse(configString);
        }
        catch {
            throw new Error('Invalid configuration format');
        }
    }
    async validateFile(filePath, sourceType) {
        switch (sourceType) {
            case 'shapefile':
                return await this.fileUploadService.validateShapefile(filePath);
            case 'geopackage':
                return await this.fileUploadService.validateGeoPackage(filePath);
            case 'csv':
                return await this.fileUploadService.validateCSV(filePath);
            default:
                return { valid: true, errors: [] }; // TODO: Add validation for KML and GeoJSON
        }
    }
}
exports.IngestionController = IngestionController;
//# sourceMappingURL=ingestionController.js.map