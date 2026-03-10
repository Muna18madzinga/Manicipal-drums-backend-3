import { Pool } from 'pg';
import { BatchJob, BatchJobItem, BatchJobConfig } from '../../types/admin';
import { EventEmitter } from 'events';
export declare class BatchProcessingService extends EventEmitter {
    private pool;
    private activeJobs;
    private jobQueue;
    private maxConcurrentJobs;
    private processingInterval;
    constructor(pool: Pool);
    /**
     * Create a new batch job
     */
    createBatchJob(name: string, description: string, jobType: string, config: BatchJobConfig, priority?: number, scheduledAt?: Date, createdBy?: number): Promise<BatchJob>;
    /**
     * Add items to a batch job
     */
    addBatchJobItems(jobId: number, items: Array<{
        item_type: string;
        item_id: string;
        item_data: any;
    }>): Promise<BatchJobItem[]>;
    /**
     * Start batch job processing
     */
    startBatchJob(jobId: number): Promise<void>;
    /**
     * Process batch job items
     */
    processBatchJob(jobId: number): Promise<void>;
    /**
     * Process individual batch job item
     */
    private processBatchJobItem;
    /**
     * Process data cleaning item
     */
    private processDataCleaningItem;
    /**
     * Process style application item
     */
    private processStyleApplicationItem;
    /**
     * Process bulk import item
     */
    private processBulkImportItem;
    /**
     * Process bulk export item
     */
    private processBulkExportItem;
    /**
     * Complete batch job
     */
    completeBatchJob(jobId: number, results: any): Promise<void>;
    /**
     * Fail batch job
     */
    failBatchJob(jobId: number, errors: any[]): Promise<void>;
    /**
     * Cancel batch job
     */
    cancelBatchJob(jobId: number): Promise<void>;
    /**
     * Get batch job by ID
     */
    getBatchJob(jobId: number): Promise<BatchJob | null>;
    /**
     * Get all batch jobs
     */
    getBatchJobs(status?: string, jobType?: string, limit?: number, offset?: number): Promise<BatchJob[]>;
    /**
     * Get batch job items
     */
    getBatchJobItems(jobId: number, status?: string, limit?: number, offset?: number): Promise<BatchJobItem[]>;
    /**
     * Update job status
     */
    private updateJobStatus;
    /**
     * Update job progress
     */
    private updateJobProgress;
    /**
     * Update item status
     */
    private updateItemStatus;
    /**
     * Update item result
     */
    private updateItemResult;
    /**
     * Start processing queue
     */
    private startProcessing;
    /**
     * Check for scheduled jobs that should start
     */
    private checkScheduledJobs;
    /**
     * Sort queue by priority
     */
    private sortQueueByPriority;
    /**
     * Get batch processing statistics
     */
    getBatchStatistics(): Promise<any>;
    /**
     * Retry failed batch job items
     */
    retryFailedItems(jobId: number): Promise<number>;
    /**
     * Pause batch job
     */
    pauseBatchJob(jobId: number): Promise<void>;
    /**
     * Resume paused batch job
     */
    resumeBatchJob(jobId: number): Promise<void>;
}
//# sourceMappingURL=batchProcessingService.d.ts.map