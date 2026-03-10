"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatchProcessingController = void 0;
const batchProcessingService_1 = require("../../services/admin/batchProcessingService");
class BatchProcessingController {
    batchProcessingService;
    constructor(pool) {
        this.batchProcessingService = new batchProcessingService_1.BatchProcessingService(pool);
    }
    /**
     * Create a new batch job
     */
    createBatchJob = async (request, reply) => {
        try {
            const { name, description, job_type, config, priority, scheduled_at } = request.body;
            const userId = request.user?.id || 1;
            // Validate input
            if (!name || !job_type) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Missing required fields: name, job_type'
                });
                return;
            }
            const validTypes = ['data_cleaning', 'style_application', 'bulk_import', 'bulk_export'];
            if (!validTypes.includes(job_type)) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: `Invalid job type. Must be one of: ${validTypes.join(', ')}`
                });
                return;
            }
            const scheduledDate = scheduled_at ? new Date(scheduled_at) : undefined;
            const batchJob = await this.batchProcessingService.createBatchJob(name, description || '', job_type, config || {}, priority || 1, scheduledDate, userId);
            reply.status(201).send({
                data: batchJob,
                message: 'Batch job created successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to create batch job'
            });
        }
    };
    /**
     * Add items to a batch job
     */
    addBatchJobItems = async (request, reply) => {
        try {
            const { jobId } = request.params;
            const { items } = request.body;
            if (!items || !Array.isArray(items)) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Missing required field: items (must be an array)'
                });
                return;
            }
            const batchJobItems = await this.batchProcessingService.addBatchJobItems(parseInt(jobId), items);
            reply.status(201).send({
                data: batchJobItems,
                message: 'Batch job items added successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to add batch job items'
            });
        }
    };
    /**
     * Get batch job by ID
     */
    getBatchJob = async (request, reply) => {
        try {
            const { jobId } = request.params;
            const batchJob = await this.batchProcessingService.getBatchJob(parseInt(jobId));
            if (!batchJob) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'Batch job not found'
                });
                return;
            }
            // Get job items
            const items = await this.batchProcessingService.getBatchJobItems(parseInt(jobId));
            reply.send({
                data: {
                    ...batchJob,
                    items
                }
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to get batch job'
            });
        }
    };
    /**
     * Get all batch jobs
     */
    getBatchJobs = async (request, reply) => {
        try {
            const { status, job_type, limit = 50, offset = 0 } = request.query;
            const batchJobs = await this.batchProcessingService.getBatchJobs(status, job_type, parseInt(limit), parseInt(offset));
            reply.send({
                data: batchJobs,
                pagination: {
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                    total: batchJobs.length
                }
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to get batch jobs'
            });
        }
    };
    /**
     * Start batch job
     */
    startBatchJob = async (request, reply) => {
        try {
            const { jobId } = request.params;
            const batchJob = await this.batchProcessingService.getBatchJob(parseInt(jobId));
            if (!batchJob) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'Batch job not found'
                });
                return;
            }
            await this.batchProcessingService.startBatchJob(parseInt(jobId));
            reply.send({
                message: 'Batch job started successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to start batch job'
            });
        }
    };
    /**
     * Cancel batch job
     */
    cancelBatchJob = async (request, reply) => {
        try {
            const { jobId } = request.params;
            const batchJob = await this.batchProcessingService.getBatchJob(parseInt(jobId));
            if (!batchJob) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'Batch job not found'
                });
                return;
            }
            await this.batchProcessingService.cancelBatchJob(parseInt(jobId));
            reply.send({
                message: 'Batch job cancelled successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to cancel batch job'
            });
        }
    };
    /**
     * Pause batch job
     */
    pauseBatchJob = async (request, reply) => {
        try {
            const { jobId } = request.params;
            const batchJob = await this.batchProcessingService.getBatchJob(parseInt(jobId));
            if (!batchJob) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'Batch job not found'
                });
                return;
            }
            await this.batchProcessingService.pauseBatchJob(parseInt(jobId));
            reply.send({
                message: 'Batch job paused successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to pause batch job'
            });
        }
    };
    /**
     * Resume batch job
     */
    resumeBatchJob = async (request, reply) => {
        try {
            const { jobId } = request.params;
            const batchJob = await this.batchProcessingService.getBatchJob(parseInt(jobId));
            if (!batchJob) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'Batch job not found'
                });
                return;
            }
            await this.batchProcessingService.resumeBatchJob(parseInt(jobId));
            reply.send({
                message: 'Batch job resumed successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to resume batch job'
            });
        }
    };
    /**
     * Retry failed batch job items
     */
    retryFailedItems = async (request, reply) => {
        try {
            const { jobId } = request.params;
            const batchJob = await this.batchProcessingService.getBatchJob(parseInt(jobId));
            if (!batchJob) {
                reply.status(404).send({
                    error: 'Not Found',
                    message: 'Batch job not found'
                });
                return;
            }
            const retriedCount = await this.batchProcessingService.retryFailedItems(parseInt(jobId));
            reply.send({
                message: `${retriedCount} failed items retried successfully`,
                retried_count: retriedCount
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to retry failed items'
            });
        }
    };
    /**
     * Get batch job items
     */
    getBatchJobItems = async (request, reply) => {
        try {
            const { jobId } = request.params;
            const { status, limit = 100, offset = 0 } = request.query;
            const items = await this.batchProcessingService.getBatchJobItems(parseInt(jobId), status, parseInt(limit), parseInt(offset));
            reply.send({
                data: items,
                pagination: {
                    limit: parseInt(limit),
                    offset: parseInt(offset),
                    total: items.length
                }
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to get batch job items'
            });
        }
    };
    /**
     * Get batch processing statistics
     */
    getBatchStatistics = async (request, reply) => {
        try {
            const statistics = await this.batchProcessingService.getBatchStatistics();
            reply.send({
                data: statistics
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to get batch statistics'
            });
        }
    };
    /**
     * Create bulk import job
     */
    createBulkImportJob = async (request, reply) => {
        try {
            const { name, description, files, config } = request.body;
            const userId = request.user?.id || 1;
            if (!name || !files || !Array.isArray(files)) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Missing required fields: name, files (must be an array)'
                });
                return;
            }
            // Create batch job
            const batchJob = await this.batchProcessingService.createBatchJob(name, description || '', 'bulk_import', config || {}, 1, // priority
            undefined, // scheduled_at
            userId);
            // Add file items
            const items = files.map((file) => ({
                item_type: 'file',
                item_id: file.id || file.name,
                item_data: {
                    file_path: file.path,
                    file_name: file.name,
                    file_size: file.size,
                    mime_type: file.type
                }
            }));
            await this.batchProcessingService.addBatchJobItems(batchJob.id, items);
            reply.status(201).send({
                data: batchJob,
                message: 'Bulk import job created successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to create bulk import job'
            });
        }
    };
    /**
     * Create bulk export job
     */
    createBulkExportJob = async (request, reply) => {
        try {
            const { name, description, layers, format, config } = request.body;
            const userId = request.user?.id || 1;
            if (!name || !layers || !Array.isArray(layers)) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Missing required fields: name, layers (must be an array)'
                });
                return;
            }
            // Create batch job
            const batchJob = await this.batchProcessingService.createBatchJob(name, description || '', 'bulk_export', { format, layers, ...config }, 1, // priority
            undefined, // scheduled_at
            userId);
            // Add layer items
            const items = layers.map((layer) => ({
                item_type: 'record',
                item_id: layer.id,
                item_data: {
                    layer_name: layer.name,
                    layer_type: layer.type,
                    export_format: format,
                    filters: layer.filters || {}
                }
            }));
            await this.batchProcessingService.addBatchJobItems(batchJob.id, items);
            reply.status(201).send({
                data: batchJob,
                message: 'Bulk export job created successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to create bulk export job'
            });
        }
    };
    /**
     * Create data cleaning job
     */
    createDataCleaningJob = async (request, reply) => {
        try {
            const { name, description, layer_id, cleaning_operations, config } = request.body;
            const userId = request.user?.id || 1;
            if (!name || !layer_id || !cleaning_operations) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Missing required fields: name, layer_id, cleaning_operations'
                });
                return;
            }
            // Create batch job
            const batchJob = await this.batchProcessingService.createBatchJob(name, description || '', 'data_cleaning', { layer_id, cleaning_operations, ...config }, 2, // higher priority for data cleaning
            undefined, // scheduled_at
            userId);
            // Add cleaning operation items
            const items = cleaning_operations.map((operation, index) => ({
                item_type: 'task',
                item_id: `cleaning_op_${index}`,
                item_data: {
                    operation_type: operation.type,
                    parameters: operation.parameters,
                    layer_id
                }
            }));
            await this.batchProcessingService.addBatchJobItems(batchJob.id, items);
            reply.status(201).send({
                data: batchJob,
                message: 'Data cleaning job created successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to create data cleaning job'
            });
        }
    };
    /**
     * Create style application job
     */
    createStyleApplicationJob = async (request, reply) => {
        try {
            const { name, description, template_id, layers, config } = request.body;
            const userId = request.user?.id || 1;
            if (!name || !template_id || !layers || !Array.isArray(layers)) {
                reply.status(400).send({
                    error: 'Bad Request',
                    message: 'Missing required fields: name, template_id, layers (must be an array)'
                });
                return;
            }
            // Create batch job
            const batchJob = await this.batchProcessingService.createBatchJob(name, description || '', 'style_application', { template_id, layers, ...config }, 1, // priority
            undefined, // scheduled_at
            userId);
            // Add layer items
            const items = layers.map((layer) => ({
                item_type: 'record',
                item_id: layer.id,
                item_data: {
                    layer_name: layer.name,
                    template_id,
                    style_config: layer.style_config || {}
                }
            }));
            await this.batchProcessingService.addBatchJobItems(batchJob.id, items);
            reply.status(201).send({
                data: batchJob,
                message: 'Style application job created successfully'
            });
        }
        catch (error) {
            reply.status(500).send({
                error: 'Internal Server Error',
                message: 'Failed to create style application job'
            });
        }
    };
}
exports.BatchProcessingController = BatchProcessingController;
//# sourceMappingURL=batchProcessingController.js.map