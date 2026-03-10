import { Pool } from 'pg';
import { BaseService } from './baseService';
import { DataCleaningJob, CleaningIssue, CleaningConfig, CleaningResult } from '../../types/admin';
export declare class DataCleaningService extends BaseService {
    constructor(pool: Pool);
    /**
     * Validate service-specific tables
     */
    protected validateServiceTables(): Promise<void>;
    /**
     * Generate a unique job ID
     */
    generateJobId(): Promise<number>;
    /**
     * Create a new data cleaning job
     */
    createCleaningJob(jobId: number, cleaningType: string, config: CleaningConfig, createdBy: number): Promise<DataCleaningJob>;
    /**
     * Start data cleaning process
     */
    startCleaningJob(jobId: number): Promise<void>;
    /**
     * Complete data cleaning job
     */
    completeCleaningJob(jobId: number, results: CleaningResult, errors?: any[]): Promise<void>;
    /**
     * Fail data cleaning job
     */
    failCleaningJob(jobId: number, errors: any[]): Promise<void>;
    /**
     * Add cleaning issue
     */
    addCleaningIssue(jobId: number, issue: Omit<CleaningIssue, 'id' | 'created_at' | 'job_id'>): Promise<CleaningIssue>;
    /**
     * Get cleaning job by ID
     */
    getCleaningJob(jobId: number): Promise<DataCleaningJob | null>;
    /**
     * Get cleaning issues for a job
     */
    getCleaningIssues(jobId: number): Promise<CleaningIssue[]>;
    /**
     * Duplicate Detection Algorithm
     */
    detectDuplicates(jobId: number, config: CleaningConfig): Promise<void>;
    /**
     * Geometry Validation
     */
    validateGeometry(jobId: number, config: CleaningConfig): Promise<void>;
    /**
     * Attribute Standardization
     */
    standardizeAttributes(jobId: number, config: CleaningConfig): Promise<void>;
    /**
     * Check geometric similarity for duplicate detection
     */
    private checkGeometricDuplicate;
    /**
     * Check attribute similarity
     */
    private checkAttributeSimilarity;
    /**
     * Calculate string similarity (Levenshtein distance)
     */
    private calculateStringSimilarity;
    /**
     * Validate attribute format
     */
    private validateAttributeFormat;
    /**
     * Get all cleaning jobs
     */
    getCleaningJobs(limit?: number, offset?: number): Promise<DataCleaningJob[]>;
    /**
     * Update cleaning issue status
     */
    updateCleaningIssueStatus(issueId: number, status: string): Promise<CleaningIssue>;
}
//# sourceMappingURL=dataCleaningService.d.ts.map