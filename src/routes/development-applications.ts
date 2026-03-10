// Development Application API Routes
// Handles all development application related endpoints

import { FastifyRequest, FastifyReply } from 'fastify'
import { developmentApplicationService } from '../services/developmentApplication'

interface DevelopmentApplicationRequest extends FastifyRequest {
  body: any
  params: any
  query: any
}

// Development Application Routes
export async function developmentApplicationRoutes(fastify: any, options: any) {
  
  // Submit new development application
  fastify.post('/development-applications', {
    schema: {
      description: 'Submit a new development application',
      tags: ['development-applications'],
      body: {
        type: 'object',
        required: ['selection', 'eligibility', 'formData', 'documents'],
        properties: {
          selection: {
            type: 'object',
            description: 'Selected parcel information'
          },
          eligibility: {
            type: 'object',
            description: 'Eligibility analysis results'
          },
          formData: {
            type: 'object',
            description: 'Application form data'
          },
          documents: {
            type: 'array',
            description: 'Uploaded documents'
          },
          fees: {
            type: 'object',
            description: 'Calculated fees'
          }
        }
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            applicationId: { type: 'string' },
            message: { type: 'string' }
          }
        }
      }
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const applicationData = {
        ...request.body,
        submittedAt: new Date().toISOString(),
        status: 'submitted',
        userId: request.user?.id || 'anonymous'
      }

      const result = await developmentApplicationService.submitApplication(applicationData)
      
      return reply.status(201).send({
        success: true,
        applicationId: result.id,
        message: 'Application submitted successfully',
        data: result
      })
    } catch (error) {
      fastify.log.error('❌ Failed to submit application:', error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to submit application'
      })
    }
  })

  // Get application by ID
  fastify.get('/development-applications/:id', {
    schema: {
      description: 'Get development application by ID',
      tags: ['development-applications'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Application ID' }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object' }
          }
        }
      }
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params
      const application = await developmentApplicationService.getApplication(id)
      
      return reply.send({
        success: true,
        data: application
      })
    } catch (error) {
      fastify.log.error(`❌ Failed to get application ${request.params.id}:`, error)
      return reply.status(404).send({
        success: false,
        message: error.message || 'Application not found'
      })
    }
  })

  // Get applications for user
  fastify.get('/development-applications', {
    schema: {
      description: 'Get applications for authenticated user',
      tags: ['development-applications'],
      querystring: {
        type: 'object',
        properties: {
          userId: { type: 'string', description: 'User ID (optional, defaults to authenticated user)' },
          status: { type: 'string', description: 'Filter by status' },
          limit: { type: 'number', default: 50 },
          offset: { type: 'number', default: 0 }
        }
      }
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const userId = request.query.userId || request.user?.id
      if (!userId) {
        return reply.status(401).send({
          success: false,
          message: 'Authentication required'
        })
      }

      const applications = await developmentApplicationService.getUserApplications(userId)
      
      return reply.send({
        success: true,
        data: applications,
        count: applications.length
      })
    } catch (error) {
      fastify.log.error('❌ Failed to get user applications:', error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to get applications'
      })
    }
  })

  // Update application status
  fastify.patch('/development-applications/:id/status', {
    schema: {
      description: 'Update application status',
      tags: ['development-applications'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { 
            type: 'string', 
            enum: ['submitted', 'under_review', 'approved', 'rejected', 'requires_more_info']
          },
          notes: { type: 'string' }
        }
      }
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params
      const { status, notes } = request.body
      
      const result = await developmentApplicationService.updateApplicationStatus(id, status, notes)
      
      return reply.send({
        success: true,
        data: result,
        message: 'Application status updated successfully'
      })
    } catch (error) {
      fastify.log.error(`❌ Failed to update application status:`, error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to update application status'
      })
    }
  })

  // Get application timeline
  fastify.get('/development-applications/:id/timeline', {
    schema: {
      description: 'Get application timeline/history',
      tags: ['development-applications']
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params
      const timeline = await developmentApplicationService.getApplicationTimeline(id)
      
      return reply.send({
        success: true,
        data: timeline
      })
    } catch (error) {
      fastify.log.error(`❌ Failed to get application timeline:`, error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to get application timeline'
      })
    }
  })

  // Add comment to application
  fastify.post('/development-applications/:id/comments', {
    schema: {
      description: 'Add comment to application',
      tags: ['development-applications'],
      body: {
        type: 'object',
        required: ['comment'],
        properties: {
          comment: { type: 'string' },
          isInternal: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params
      const { comment, isInternal } = request.body
      
      const result = await developmentApplicationService.addApplicationComment(id, comment, isInternal)
      
      return reply.send({
        success: true,
        data: result,
        message: 'Comment added successfully'
      })
    } catch (error) {
      fastify.log.error(`❌ Failed to add application comment:`, error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to add comment'
      })
    }
  })

  // Upload document
  fastify.post('/development-applications/:id/documents', {
    schema: {
      description: 'Upload document for application',
      tags: ['development-applications'],
      consumes: ['multipart/form-data'],
      body: {
        type: 'object',
        required: ['file'],
        properties: {
          file: { type: 'string', format: 'binary' },
          documentType: { type: 'string' }
        }
      }
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params
      const file = request.body.file
      const documentType = request.body.documentType || 'general'
      
      const result = await developmentApplicationService.uploadDocument(id, file, documentType)
      
      return reply.send({
        success: true,
        data: result,
        message: 'Document uploaded successfully'
      })
    } catch (error) {
      fastify.log.error(`❌ Failed to upload document:`, error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to upload document'
      })
    }
  })

  // Get application documents
  fastify.get('/development-applications/:id/documents', {
    schema: {
      description: 'Get application documents',
      tags: ['development-applications']
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params
      const documents = await developmentApplicationService.getApplicationDocuments(id)
      
      return reply.send({
        success: true,
        data: documents
      })
    } catch (error) {
      fastify.log.error(`❌ Failed to get application documents:`, error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to get documents'
      })
    }
  })

  // Delete document
  fastify.delete('/development-applications/:id/documents/:documentId', {
    schema: {
      description: 'Delete application document',
      tags: ['development-applications']
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const { id, documentId } = request.params
      
      await developmentApplicationService.deleteDocument(id, documentId)
      
      return reply.send({
        success: true,
        message: 'Document deleted successfully'
      })
    } catch (error) {
      fastify.log.error(`❌ Failed to delete document:`, error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to delete document'
      })
    }
  })

  // Calculate fees
  fastify.post('/development-applications/calculate-fees', {
    schema: {
      description: 'Calculate application fees',
      tags: ['development-applications'],
      body: {
        type: 'object',
        required: ['selection', 'eligibility'],
        properties: {
          selection: { type: 'object' },
          eligibility: { type: 'object' },
          formData: { type: 'object' }
        }
      }
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const fees = await developmentApplicationService.calculateFees(request.body)
      
      return reply.send({
        success: true,
        data: fees
      })
    } catch (error) {
      fastify.log.error('❌ Failed to calculate fees:', error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to calculate fees'
      })
    }
  })

  // Get application statistics
  fastify.get('/development-applications/stats', {
    schema: {
      description: 'Get application statistics',
      tags: ['development-applications'],
      querystring: {
        type: 'object',
        properties: {
          startDate: { type: 'string', format: 'date' },
          endDate: { type: 'string', format: 'date' },
          status: { type: 'string' }
        }
      }
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const stats = await developmentApplicationService.getApplicationStats(request.query)
      
      return reply.send({
        success: true,
        data: stats
      })
    } catch (error) {
      fastify.log.error('❌ Failed to get application stats:', error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to get statistics'
      })
    }
  })

  // Export application
  fastify.get('/development-applications/:id/export', {
    schema: {
      description: 'Export application',
      tags: ['development-applications'],
      querystring: {
        type: 'object',
        properties: {
          format: { 
            type: 'string', 
            enum: ['pdf', 'json', 'csv'], 
            default: 'pdf' 
          }
        }
      }
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params
      const { format = 'pdf' } = request.query
      
      await developmentApplicationService.exportApplication(id, format)
      
      return reply.send({
        success: true,
        message: 'Application exported successfully'
      })
    } catch (error) {
      fastify.log.error(`❌ Failed to export application:`, error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to export application'
      })
    }
  })

  // Search applications
  fastify.get('/development-applications/search', {
    schema: {
      description: 'Search applications',
      tags: ['development-applications'],
      querystring: {
        type: 'object',
        required: ['q'],
        properties: {
          q: { type: 'string', description: 'Search query' },
          status: { type: 'string' },
          limit: { type: 'number', default: 20 },
          offset: { type: 'number', default: 0 }
        }
      }
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const results = await developmentApplicationService.searchApplications(
        request.query.q,
        request.query
      )
      
      return reply.send({
        success: true,
        data: results,
        count: results.length
      })
    } catch (error) {
      fastify.log.error('❌ Failed to search applications:', error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to search applications'
      })
    }
  })

  // Get development types
  fastify.get('/development-applications/development-types', {
    schema: {
      description: 'Get available development types',
      tags: ['development-applications']
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const types = await developmentApplicationService.getDevelopmentTypes()
      
      return reply.send({
        success: true,
        data: types
      })
    } catch (error) {
      fastify.log.error('❌ Failed to get development types:', error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to get development types'
      })
    }
  })

  // Get zone requirements
  fastify.get('/development-applications/zone-requirements', {
    schema: {
      description: 'Get zone-specific requirements',
      tags: ['development-applications'],
      querystring: {
        type: 'object',
        required: ['zone'],
        properties: {
          zone: { type: 'string', description: 'Zone name' }
        }
      }
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const { zone } = request.query
      const requirements = await developmentApplicationService.getZoneRequirements(zone)
      
      return reply.send({
        success: true,
        data: requirements
      })
    } catch (error) {
      fastify.log.error('❌ Failed to get zone requirements:', error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to get zone requirements'
      })
    }
  })

  // Save draft application
  fastify.post('/development-applications/drafts', {
    schema: {
      description: 'Save draft application',
      tags: ['development-applications'],
      body: {
        type: 'object',
        properties: {
          selection: { type: 'object' },
          eligibility: { type: 'object' },
          formData: { type: 'object' },
          documents: { type: 'array' }
        }
      }
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const draftData = {
        ...request.body,
        userId: request.user?.id || 'anonymous'
      }
      
      const result = await developmentApplicationService.saveDraft(draftData)
      
      return reply.send({
        success: true,
        data: result,
        message: 'Draft saved successfully'
      })
    } catch (error) {
      fastify.log.error('❌ Failed to save draft:', error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to save draft'
      })
    }
  })

  // Get drafts for user
  fastify.get('/development-applications/drafts', {
    schema: {
      description: 'Get draft applications for user',
      tags: ['development-applications']
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const userId = request.user?.id
      if (!userId) {
        return reply.status(401).send({
          success: false,
          message: 'Authentication required'
        })
      }

      const drafts = await developmentApplicationService.getDrafts(userId)
      
      return reply.send({
        success: true,
        data: drafts,
        count: drafts.length
      })
    } catch (error) {
      fastify.log.error('❌ Failed to get drafts:', error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to get drafts'
      })
    }
  })

  // Delete draft
  fastify.delete('/development-applications/drafts/:id', {
    schema: {
      description: 'Delete draft application',
      tags: ['development-applications']
    }
  }, async (request: DevelopmentApplicationRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params
      
      await developmentApplicationService.deleteDraft(id)
      
      return reply.send({
        success: true,
        message: 'Draft deleted successfully'
      })
    } catch (error) {
      fastify.log.error('❌ Failed to delete draft:', error)
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to delete draft'
      })
    }
  })
}

export default developmentApplicationRoutes
