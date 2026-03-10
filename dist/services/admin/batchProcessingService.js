"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatchProcessingService = void 0;
const events_1 = require("events");
class BatchProcessingService extends events_1.EventEmitter {
    pool;
    activeJobs = new Map();
    jobQueue = [];
    maxConcurrentJobs = 3;
    processingInterval = 5000; // 5 seconds
    constructor(pool) {
        super();
        this.pool = pool;
        this.startProcessing();
    }
    /**
     * Create a new batch job
     */
    async createBatchJob(name, description, jobType, config, priority = 1, scheduledAt, createdBy) {
        const query = `
      INSERT INTO batch_jobs (name, description, job_type, priority, config, scheduled_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;
        const values = [
            name,
            description,
            jobType,
            priority,
            config,
            scheduledAt || null,
            createdBy || null
        ];
        const result = await this.pool.query(query, values);
        const job = result.rows[0];
        // Add to queue if not scheduled for future
        if (!scheduledAt || scheduledAt <= new Date()) {
            this.jobQueue.push(job.id);
            this.sortQueueByPriority();
        }
        this.emit('jobCreated', job);
        return job;
    }
    /**
     * Add items to a batch job
     */
    async addBatchJobItems(jobId, items) {
        const query = `
      INSERT INTO batch_job_items (batch_job_id, item_type, item_id, item_data)
      VALUES ${items.map((_, index) => `($1, $${index * 3 + 2}, $${index * 3 + 3}, $${index * 3 + 4})`).join(', ')}
      RETURNING *
    `;
        const values = [jobId, ...items.flatMap(item => [item.item_type, item.item_id, item.item_data])];
        const result = await this.pool.query(query, values);
        this.emit('itemsAdded', jobId, result.rows);
        return result.rows;
    }
    /**
     * Start batch job processing
     */
    async startBatchJob(jobId) {
        const job = await this.getBatchJob(jobId);
        if (!job) {
            throw new Error('Batch job not found');
        }
        if (job.status !== 'pending' && job.status !== 'queued') {
            throw new Error(`Cannot start job with status: ${job.status}`);
        }
        await this.updateJobStatus(jobId, 'running');
        this.activeJobs.set(jobId, { startedAt: new Date() });
        this.emit('jobStarted', job);
    }
    /**
     * Process batch job items
     */
    async processBatchJob(jobId) {
        const job = await this.getBatchJob(jobId);
        if (!job)
            return;
        const items = await this.getBatchJobItems(jobId, 'pending');
        const totalItems = items.length;
        let processedItems = 0;
        let failedItems = 0;
        // Update progress
        await this.updateJobProgress(jobId, {
            percentage: 0,
            current_step: 'Starting batch processing',
            total_steps: totalItems,
            completed_steps: 0
        });
        for (const item of items) {
            try {
                await this.processBatchJobItem(jobId, item);
                processedItems++;
                // Update progress
                const percentage = Math.round((processedItems / totalItems) * 100);
                await this.updateJobProgress(jobId, {
                    percentage,
                    current_step: `Processing item ${processedItems} of ${totalItems}`,
                    total_steps: totalItems,
                    completed_steps: processedItems
                });
                this.emit('itemProcessed', jobId, item);
            }
            catch (error) {
                failedItems++;
                await this.updateItemStatus(item.id, 'failed', error instanceof Error ? error.message : String(error));
                this.emit('itemFailed', jobId, item, error);
            }
        }
        // Complete the job
        const finalStatus = failedItems === 0 ? 'completed' : 'completed_with_errors';
        await this.completeBatchJob(jobId, {
            total_items: totalItems,
            processed_items: processedItems,
            failed_items: failedItems,
            success_rate: ((processedItems / totalItems) * 100).toFixed(2)
        });
        this.activeJobs.delete(jobId);
        this.emit('jobCompleted', jobId, finalStatus);
    }
    /**
     * Process individual batch job item
     */
    async processBatchJobItem(jobId, item) {
        await this.updateItemStatus(item.id, 'processing');
        const job = await this.getBatchJob(jobId);
        if (!job)
            throw new Error('Job not found');
        switch (job.job_type) {
            case 'data_cleaning':
                await this.processDataCleaningItem(jobId, item);
                break;
            case 'style_application':
                await this.processStyleApplicationItem(jobId, item);
                break;
            case 'bulk_import':
                await this.processBulkImportItem(jobId, item);
                break;
            case 'bulk_export':
                await this.processBulkExportItem(jobId, item);
                break;
            default:
                throw new Error(`Unknown job type: ${job.job_type}`);
        }
        await this.updateItemStatus(item.id, 'completed');
    }
    /**
     * Process data cleaning item
     */
    async processDataCleaningItem(jobId, item) {
        // Simulate data cleaning processing
        await new Promise(resolve => setTimeout(resolve, 1000));
        // Example: Clean feature data
        const result = {
            cleaned_fields: ['name', 'description'],
            removed_duplicates: 0,
            validated_geometry: true
        };
        await this.updateItemResult(item.id, result);
    }
    /**
     * Process style application item
     */
    async processStyleApplicationItem(jobId, item) {
        // Simulate style application
        await new Promise(resolve => setTimeout(resolve, 500));
        const result = {
            style_applied: true,
            features_updated: 1
        };
        await this.updateItemResult(item.id, result);
    }
    /**
     * Process bulk import item
     */
    async processBulkImportItem(jobId, item) {
        // Simulate bulk import
        await new Promise(resolve => setTimeout(resolve, 2000));
        const result = {
            records_imported: 1,
            file_processed: item.item_data.file_path || 'unknown'
        };
        await this.updateItemResult(item.id, result);
    }
    /**
     * Process bulk export item
     */
    async processBulkExportItem(jobId, item) {
        // Simulate bulk export
        await new Promise(resolve => setTimeout(resolve, 1500));
        const result = {
            records_exported: 1,
            export_file: `export_${item.id}.geojson`
        };
        await this.updateItemResult(item.id, result);
    }
    /**
     * Complete batch job
     */
    async completeBatchJob(jobId, results) {
        const query = `
      UPDATE batch_jobs 
      SET status = $1, results = $2, completed_at = NOW()
      WHERE id = $3
    `;
        await this.pool.query(query, ['completed', results, jobId]);
    }
    /**
     * Fail batch job
     */
    async failBatchJob(jobId, errors) {
        const query = `
      UPDATE batch_jobs 
      SET status = $1, errors = $2, completed_at = NOW()
      WHERE id = $3
    `;
        await this.pool.query(query, ['failed', errors, jobId]);
        this.activeJobs.delete(jobId);
        this.emit('jobFailed', jobId, errors);
    }
    /**
     * Cancel batch job
     */
    async cancelBatchJob(jobId) {
        const job = await this.getBatchJob(jobId);
        if (!job)
            throw new Error('Batch job not found');
        if (!['pending', 'queued', 'running'].includes(job.status)) {
            throw new Error(`Cannot cancel job with status: ${job.status}`);
        }
        await this.updateJobStatus(jobId, 'cancelled');
        // Cancel pending items
        await this.pool.query('UPDATE batch_job_items SET status = $1 WHERE batch_job_id = $2 AND status = $3', ['cancelled', jobId, 'pending']);
        this.activeJobs.delete(jobId);
        this.emit('jobCancelled', jobId);
    }
    /**
     * Get batch job by ID
     */
    async getBatchJob(jobId) {
        const result = await this.pool.query('SELECT * FROM batch_jobs WHERE id = $1', [jobId]);
        return result.rows[0] || null;
    }
    /**
     * Get all batch jobs
     */
    async getBatchJobs(status, jobType, limit = 50, offset = 0) {
        let query = 'SELECT * FROM batch_jobs WHERE 1=1';
        const params = [];
        let paramIndex = 1;
        if (status) {
            query += ` AND status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }
        if (jobType) {
            query += ` AND job_type = $${paramIndex}`;
            params.push(jobType);
            paramIndex++;
        }
        query += ' ORDER BY created_at DESC LIMIT $' + paramIndex + ' OFFSET $' + (paramIndex + 1);
        params.push(limit, offset);
        const result = await this.pool.query(query, params);
        return result.rows;
    }
    /**
     * Get batch job items
     */
    async getBatchJobItems(jobId, status, limit = 100, offset = 0) {
        let query = 'SELECT * FROM batch_job_items WHERE batch_job_id = $1';
        const params = [jobId];
        let paramIndex = 2;
        if (status) {
            query += ` AND status = $${paramIndex}`;
            params.push(status);
            paramIndex++;
        }
        query += ' ORDER BY created_at ASC LIMIT $' + paramIndex + ' OFFSET $' + (paramIndex + 1);
        params.push(limit, offset);
        const result = await this.pool.query(query, params);
        return result.rows;
    }
    /**
     * Update job status
     */
    async updateJobStatus(jobId, status) {
        const query = `
      UPDATE batch_jobs 
      SET status = $1, ${status === 'running' ? 'started_at = NOW()' : ''}
      WHERE id = $2
    `;
        await this.pool.query(query, [status, jobId]);
    }
    /**
     * Update job progress
     */
    async updateJobProgress(jobId, progress) {
        const query = `
      UPDATE batch_jobs 
      SET progress = $1
      WHERE id = $2
    `;
        await this.pool.query(query, [progress, jobId]);
    }
    /**
     * Update item status
     */
    async updateItemStatus(itemId, status, errorMessage) {
        const query = `
      UPDATE batch_job_items 
      SET status = $1, ${status === 'processing' ? 'started_at = NOW()' : ''} 
          ${status === 'completed' || status === 'failed' ? ', completed_at = NOW()' : ''}
          ${errorMessage ? ', error_message = $2' : ''}
      WHERE id = $3
    `;
        const params = errorMessage ? [status, errorMessage, itemId] : [status, itemId];
        await this.pool.query(query, params);
    }
    /**
     * Update item result
     */
    async updateItemResult(itemId, result) {
        const query = `
      UPDATE batch_job_items 
      SET result = $1
      WHERE id = $2
    `;
        await this.pool.query(query, [result, itemId]);
    }
    /**
     * Start processing queue
     */
    startProcessing() {
        setInterval(async () => {
            if (this.activeJobs.size < this.maxConcurrentJobs && this.jobQueue.length > 0) {
                const jobId = this.jobQueue.shift();
                if (jobId) {
                    try {
                        await this.startBatchJob(jobId);
                        await this.processBatchJob(jobId);
                    }
                    catch (error) {
                        await this.failBatchJob(jobId, [error instanceof Error ? error.message : String(error)]);
                    }
                }
            }
            // Check for scheduled jobs
            await this.checkScheduledJobs();
        }, this.processingInterval);
    }
    /**
     * Check for scheduled jobs that should start
     */
    async checkScheduledJobs() {
        try {
            const query = `
        SELECT * FROM batch_jobs 
        WHERE status = 'pending' 
        AND scheduled_at <= NOW()
        ORDER BY priority DESC, created_at ASC
        LIMIT 5
      `;
            const result = await this.pool.query(query);
            for (const job of result.rows) {
                if (!this.jobQueue.includes(job.id) && !this.activeJobs.has(job.id)) {
                    this.jobQueue.push(job.id);
                    this.sortQueueByPriority();
                }
            }
        }
        catch (error) {
            // Silently handle database errors during startup
            console.warn('Batch processing service: Error checking scheduled jobs:', error);
        }
    }
    /**
     * Sort queue by priority
     */
    sortQueueByPriority() {
        this.jobQueue.sort((a, b) => b - a); // Higher priority first
    }
    /**
     * Get batch processing statistics
     */
    async getBatchStatistics() {
        const jobsQuery = 'SELECT * FROM batch_jobs';
        const jobsResult = await this.pool.query(jobsQuery);
        const jobs = jobsResult.rows;
        const itemsQuery = 'SELECT * FROM batch_job_items';
        const itemsResult = await this.pool.query(itemsQuery);
        const items = itemsResult.rows;
        const totalJobs = jobs.length;
        const pendingJobs = jobs.filter(j => j.status === 'pending').length;
        const queuedJobs = jobs.filter(j => j.status === 'queued').length;
        const runningJobs = jobs.filter(j => j.status === 'running').length;
        const completedJobs = jobs.filter(j => j.status === 'completed').length;
        const failedJobs = jobs.filter(j => j.status === 'failed').length;
        const cancelledJobs = jobs.filter(j => j.status === 'cancelled').length;
        const jobsByType = {
            data_cleaning: jobs.filter(j => j.job_type === 'data_cleaning').length,
            style_application: jobs.filter(j => j.job_type === 'style_application').length,
            bulk_import: jobs.filter(j => j.job_type === 'bulk_import').length,
            bulk_export: jobs.filter(j => j.job_type === 'bulk_export').length
        };
        const totalItems = items.length;
        const completedItems = items.filter(i => i.status === 'completed').length;
        const failedItems = items.filter(i => i.status === 'failed').length;
        const processingItems = items.filter(i => i.status === 'processing').length;
        // Calculate average processing time
        const completedJobsWithTime = jobs.filter(j => j.status === 'completed' && j.started_at && j.completed_at);
        const avgProcessingTime = completedJobsWithTime.length > 0
            ? completedJobsWithTime.reduce((sum, job) => {
                const started = new Date(job.started_at).getTime();
                const completed = new Date(job.completed_at).getTime();
                return sum + (completed - started);
            }, 0) / completedJobsWithTime.length / (1000 * 60) // Convert to minutes
            : 0;
        return {
            overview: {
                total_jobs: totalJobs,
                pending_jobs: pendingJobs,
                queued_jobs: queuedJobs,
                running_jobs: runningJobs,
                completed_jobs: completedJobs,
                failed_jobs: failedJobs,
                cancelled_jobs: cancelledJobs,
                success_rate: totalJobs > 0 ? (completedJobs / totalJobs * 100).toFixed(2) : 0,
                avg_processing_time_minutes: avgProcessingTime.toFixed(2),
                active_jobs: this.activeJobs.size,
                queued_jobs_count: this.jobQueue.length
            },
            by_type: jobsByType,
            items: {
                total_items: totalItems,
                completed_items: completedItems,
                failed_items: failedItems,
                processing_items: processingItems,
                item_success_rate: totalItems > 0 ? (completedItems / totalItems * 100).toFixed(2) : 0
            },
            recent_jobs: jobs.slice(0, 5).map(job => ({
                id: job.id,
                name: job.name,
                job_type: job.job_type,
                status: job.status,
                priority: job.priority,
                created_at: job.created_at,
                started_at: job.started_at,
                completed_at: job.completed_at
            }))
        };
    }
    /**
     * Retry failed batch job items
     */
    async retryFailedItems(jobId) {
        const failedItems = await this.getBatchJobItems(jobId, 'failed');
        for (const item of failedItems) {
            await this.updateItemStatus(item.id, 'pending');
            await this.updateItemResult(item.id, null);
        }
        this.emit('itemsRetried', jobId, failedItems.length);
        return failedItems.length;
    }
    /**
     * Pause batch job
     */
    async pauseBatchJob(jobId) {
        const job = await this.getBatchJob(jobId);
        if (!job)
            throw new Error('Batch job not found');
        if (job.status !== 'running') {
            throw new Error(`Cannot pause job with status: ${job.status}`);
        }
        await this.updateJobStatus(jobId, 'paused');
        this.activeJobs.delete(jobId);
        this.emit('jobPaused', jobId);
    }
    /**
     * Resume paused batch job
     */
    async resumeBatchJob(jobId) {
        const job = await this.getBatchJob(jobId);
        if (!job)
            throw new Error('Batch job not found');
        if (job.status !== 'paused') {
            throw new Error(`Cannot resume job with status: ${job.status}`);
        }
        await this.updateJobStatus(jobId, 'running');
        this.jobQueue.push(jobId);
        this.sortQueueByPriority();
        this.emit('jobResumed', jobId);
    }
}
exports.BatchProcessingService = BatchProcessingService;
//# sourceMappingURL=batchProcessingService.js.map