import { FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
export declare class BatchProcessingController {
    private batchProcessingService;
    constructor(pool: Pool);
    /**
     * Create a new batch job
     */
    createBatchJob: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Add items to a batch job
     */
    addBatchJobItems: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get batch job by ID
     */
    getBatchJob: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get all batch jobs
     */
    getBatchJobs: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Start batch job
     */
    startBatchJob: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Cancel batch job
     */
    cancelBatchJob: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Pause batch job
     */
    pauseBatchJob: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Resume batch job
     */
    resumeBatchJob: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Retry failed batch job items
     */
    retryFailedItems: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get batch job items
     */
    getBatchJobItems: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get batch processing statistics
     */
    getBatchStatistics: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Create bulk import job
     */
    createBulkImportJob: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Create bulk export job
     */
    createBulkExportJob: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Create data cleaning job
     */
    createDataCleaningJob: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Create style application job
     */
    createStyleApplicationJob: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}
//# sourceMappingURL=batchProcessingController.d.ts.map