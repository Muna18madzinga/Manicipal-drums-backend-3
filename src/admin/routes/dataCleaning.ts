import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { DataCleaningController } from '../../controllers/admin/dataCleaningController';

export function createDataCleaningRoutes(server: FastifyInstance, pool: Pool) {
  const dataCleaningController = new DataCleaningController(pool);

  // Create a new data cleaning job
  server.post('/data-cleaning/jobs', {
    schema: {
      description: 'Create a new data cleaning job',
      tags: ['Data Cleaning'],
      body: {
        type: 'object',
        required: ['cleaningType', 'config'],
        properties: {
          jobId: { type: 'number' },
          cleaningType: { 
            type: 'string',
            enum: ['duplicate_detection', 'geometry_validation', 'attribute_standardization']
          },
          config: { type: 'object' }
        }
      }
    }
  }, dataCleaningController.createCleaningJob);

  // Start data cleaning process
  server.post('/data-cleaning/jobs/:jobId/start', {
    schema: {
      description: 'Start data cleaning process',
      tags: ['Data Cleaning'],
      params: {
        type: 'object',
        required: ['jobId'],
        properties: {
          jobId: { type: 'number' }
        }
      }
    }
  }, dataCleaningController.startCleaningJob);

  // Get data cleaning job by ID
  server.get('/data-cleaning/jobs/:jobId', {
    schema: {
      description: 'Get data cleaning job by ID',
      tags: ['Data Cleaning'],
      params: {
        type: 'object',
        required: ['jobId'],
        properties: {
          jobId: { type: 'number' }
        }
      }
    }
  }, dataCleaningController.getCleaningJob);

  // Get all data cleaning jobs
  server.get('/data-cleaning/jobs', {
    schema: {
      description: 'Get all data cleaning jobs',
      tags: ['Data Cleaning'],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 }
        }
      }
    }
  }, dataCleaningController.getCleaningJobs);

  // Get cleaning issues for a job
  server.get('/data-cleaning/jobs/:jobId/issues', {
    schema: {
      description: 'Get cleaning issues for a job',
      tags: ['Data Cleaning'],
      params: {
        type: 'object',
        required: ['jobId'],
        properties: {
          jobId: { type: 'number' }
        }
      }
    }
  }, dataCleaningController.getCleaningIssues);

  // Update cleaning issue status
  server.put('/data-cleaning/issues/:issueId/status', {
    schema: {
      description: 'Update cleaning issue status',
      tags: ['Data Cleaning'],
      params: {
        type: 'object',
        required: ['issueId'],
        properties: {
          issueId: { type: 'number' }
        }
      },
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { 
            type: 'string',
            enum: ['pending', 'reviewed', 'fixed', 'ignored']
          }
        }
      }
    }
  }, dataCleaningController.updateCleaningIssueStatus);

  // Get cleaning statistics
  server.get('/data-cleaning/statistics', {
    schema: {
      description: 'Get cleaning statistics',
      tags: ['Data Cleaning']
    }
  }, dataCleaningController.getCleaningStatistics);

  // Delete cleaning job
  server.delete('/data-cleaning/jobs/:jobId', {
    schema: {
      description: 'Delete data cleaning job',
      tags: ['Data Cleaning'],
      params: {
        type: 'object',
        required: ['jobId'],
        properties: {
          jobId: { type: 'number' }
        }
      }
    }
  }, dataCleaningController.deleteCleaningJob);
}
