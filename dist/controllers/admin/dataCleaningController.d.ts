import { FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
export declare class DataCleaningController {
    private dataCleaningService;
    constructor(pool: Pool);
    /**
     * Create a new data cleaning job
     */
    createCleaningJob: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Start data cleaning process
     */
    startCleaningJob: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get data cleaning job by ID
     */
    getCleaningJob: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get all data cleaning jobs
     */
    getCleaningJobs: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get cleaning issues for a job
     */
    getCleaningIssues: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Update cleaning issue status
     */
    updateCleaningIssueStatus: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Get cleaning statistics
     */
    getCleaningStatistics: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Delete cleaning job (and related issues)
     */
    deleteCleaningJob: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
}
//# sourceMappingURL=dataCleaningController.d.ts.map