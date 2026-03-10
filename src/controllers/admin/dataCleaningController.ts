import { FastifyRequest, FastifyReply } from 'fastify';
import { DataCleaningService } from '../../services/admin/dataCleaningService';
import { Pool } from 'pg';
import { CleaningConfig } from '../../types/admin';

export class DataCleaningController {
  private dataCleaningService: DataCleaningService;

  constructor(pool: Pool) {
    this.dataCleaningService = new DataCleaningService(pool);
  }

  /**
   * Create a new data cleaning job
   */
  createCleaningJob = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const { jobId, cleaningType, config } = request.body as any;
      const userId = (request as any).user?.id || 1;

      // Validate input
      if (!cleaningType || !config) {
        reply.status(400).send({
          error: 'Bad Request',
          message: 'Missing required fields: cleaningType, config'
        });
        return;
      }

      const validTypes = ['duplicate_detection', 'geometry_validation', 'attribute_standardization'];
      if (!validTypes.includes(cleaningType)) {
        reply.status(400).send({
          error: 'Bad Request',
          message: `Invalid cleaning type. Must be one of: ${validTypes.join(', ')}`
        });
        return;
      }

      // Auto-generate jobId if not provided
      const finalJobId = jobId || await this.dataCleaningService.generateJobId();

      const cleaningJob = await this.dataCleaningService.createCleaningJob(
        finalJobId,
        cleaningType,
        config,
        userId
      );

      reply.status(201).send({
        data: cleaningJob,
        message: 'Data cleaning job created successfully'
      });
    } catch (error) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to create data cleaning job'
      });
    }
  };

  /**
   * Start data cleaning process
   */
  startCleaningJob = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const { jobId } = request.params as any;
      
      const cleaningJob = await this.dataCleaningService.getCleaningJob(jobId);
      if (!cleaningJob) {
        reply.status(404).send({
          error: 'Not Found',
          message: 'Data cleaning job not found'
        });
        return;
      }

      if (cleaningJob.status !== 'pending') {
        reply.status(400).send({
          error: 'Bad Request',
          message: 'Job can only be started if status is pending'
        });
        return;
      }

      // Start the appropriate cleaning process
      switch (cleaningJob.cleaning_type) {
        case 'duplicate_detection':
          await this.dataCleaningService.detectDuplicates(jobId, cleaningJob.config as CleaningConfig);
          break;
        case 'geometry_validation':
          await this.dataCleaningService.validateGeometry(jobId, cleaningJob.config as CleaningConfig);
          break;
        case 'attribute_standardization':
          await this.dataCleaningService.standardizeAttributes(jobId, cleaningJob.config as CleaningConfig);
          break;
        default:
          reply.status(400).send({
            error: 'Bad Request',
            message: 'Unsupported cleaning type'
          });
          return;
      }

      reply.send({
        message: 'Data cleaning job started successfully'
      });
    } catch (error) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to start data cleaning job'
      });
    }
  };

  /**
   * Get data cleaning job by ID
   */
  getCleaningJob = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const { jobId } = request.params as any;
      
      const cleaningJob = await this.dataCleaningService.getCleaningJob(jobId);
      if (!cleaningJob) {
        reply.status(404).send({
          error: 'Not Found',
          message: 'Data cleaning job not found'
        });
        return;
      }

      reply.send({
        data: cleaningJob
      });
    } catch (error) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to get data cleaning job'
      });
    }
  };

  /**
   * Get all data cleaning jobs
   */
  getCleaningJobs = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const { limit = 50, offset = 0 } = request.query as any;
      
      const jobs = await this.dataCleaningService.getCleaningJobs(
        parseInt(limit),
        parseInt(offset)
      );

      reply.send({
        data: jobs,
        pagination: {
          limit: parseInt(limit),
          offset: parseInt(offset),
          total: jobs.length
        }
      });
    } catch (error) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to get data cleaning jobs'
      });
    }
  };

  /**
   * Get cleaning issues for a job
   */
  getCleaningIssues = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const { jobId } = request.params as any;
      
      const cleaningJob = await this.dataCleaningService.getCleaningJob(jobId);
      if (!cleaningJob) {
        reply.status(404).send({
          error: 'Not Found',
          message: 'Data cleaning job not found'
        });
        return;
      }

      const issues = await this.dataCleaningService.getCleaningIssues(jobId);

      reply.send({
        data: issues,
        summary: {
          total_issues: issues.length,
          by_severity: {
            critical: issues.filter(i => i.severity === 'critical').length,
            high: issues.filter(i => i.severity === 'high').length,
            medium: issues.filter(i => i.severity === 'medium').length,
            low: issues.filter(i => i.severity === 'low').length
          },
          by_type: {
            duplicate: issues.filter(i => i.issue_type === 'duplicate').length,
            invalid_geometry: issues.filter(i => i.issue_type === 'invalid_geometry').length,
            missing_attribute: issues.filter(i => i.issue_type === 'missing_attribute').length,
            inconsistent_format: issues.filter(i => i.issue_type === 'inconsistent_format').length
          },
          by_status: {
            pending: issues.filter(i => i.status === 'pending').length,
            reviewed: issues.filter(i => i.status === 'reviewed').length,
            fixed: issues.filter(i => i.status === 'fixed').length,
            ignored: issues.filter(i => i.status === 'ignored').length
          }
        }
      });
    } catch (error) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to get cleaning issues'
      });
    }
  };

  /**
   * Update cleaning issue status
   */
  updateCleaningIssueStatus = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const { issueId } = request.params as any;
      const { status } = request.body as any;
      
      const validStatuses = ['pending', 'reviewed', 'fixed', 'ignored'];
      if (!validStatuses.includes(status)) {
        reply.status(400).send({
          error: 'Bad Request',
          message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
        });
        return;
      }

      const updatedIssue = await this.dataCleaningService.updateCleaningIssueStatus(
        parseInt(issueId),
        status
      );

      reply.send({
        data: updatedIssue,
        message: 'Cleaning issue status updated successfully'
      });
    } catch (error) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to update cleaning issue status'
      });
    }
  };

  /**
   * Get cleaning statistics
   */
  getCleaningStatistics = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const jobs = await this.dataCleaningService.getCleaningJobs(1000, 0);
      
      const totalJobs = jobs.length;
      const completedJobs = jobs.filter(j => j.status === 'completed').length;
      const failedJobs = jobs.filter(j => j.status === 'failed').length;
      const runningJobs = jobs.filter(j => j.status === 'running').length;
      const pendingJobs = jobs.filter(j => j.status === 'pending').length;

      const jobsByType = {
        duplicate_detection: jobs.filter(j => j.cleaning_type === 'duplicate_detection').length,
        geometry_validation: jobs.filter(j => j.cleaning_type === 'geometry_validation').length,
        attribute_standardization: jobs.filter(j => j.cleaning_type === 'attribute_standardization').length
      };

      // Calculate total issues found
      const totalIssues = jobs.reduce((sum, job) => {
        const results = job.results as any;
        return sum + (results?.duplicates_found || 0);
      }, 0);

      reply.send({
        data: {
          overview: {
            total_jobs: totalJobs,
            completed_jobs: completedJobs,
            failed_jobs: failedJobs,
            running_jobs: runningJobs,
            pending_jobs: pendingJobs,
            success_rate: totalJobs > 0 ? (completedJobs / totalJobs * 100).toFixed(2) : 0
          },
          by_type: jobsByType,
          issues_found: totalIssues,
          recent_jobs: jobs.slice(0, 5).map(job => ({
            id: job.id,
            cleaning_type: job.cleaning_type,
            status: job.status,
            created_at: job.created_at,
            results: job.results
          }))
        }
      });
    } catch (error) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to get cleaning statistics'
      });
    }
  };

  /**
   * Delete cleaning job (and related issues)
   */
  deleteCleaningJob = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const { jobId } = request.params as any;
      
      const cleaningJob = await this.dataCleaningService.getCleaningJob(jobId);
      if (!cleaningJob) {
        reply.status(404).send({
          error: 'Not Found',
          message: 'Data cleaning job not found'
        });
        return;
      }

      // Only allow deletion of completed or failed jobs
      if (!['completed', 'failed'].includes(cleaningJob.status)) {
        reply.status(400).send({
          error: 'Bad Request',
          message: 'Can only delete completed or failed jobs'
        });
        return;
      }

      // Delete job and related issues (cascade should handle this)
      await this.dataCleaningService['pool'].query(
        'DELETE FROM data_cleaning_jobs WHERE id = $1',
        [jobId]
      );

      reply.send({
        message: 'Data cleaning job deleted successfully'
      });
    } catch (error) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Failed to delete data cleaning job'
      });
    }
  };
}
