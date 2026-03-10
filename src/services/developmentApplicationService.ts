// Development Application Backend Service
// Handles all development application business logic and database operations

import { Pool } from 'pg'

interface ApplicationData {
  selection: any
  eligibility: any
  formData: any
  documents: any[]
  fees?: any
  submittedAt?: string
  status?: string
  userId?: string
}

interface ApplicationFilters {
  startDate?: string
  endDate?: string
  status?: string
  limit?: number
  offset?: number
}

class DevelopmentApplicationService {
  private pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  // Submit new development application
  async submitApplication(applicationData: ApplicationData) {
    const client = await this.pool.connect()
    
    try {
      await client.query('BEGIN')
      
      // Generate application ID
      const applicationId = `DEV-${Date.now().toString().slice(-6)}`
      
      // Insert main application record
      const insertQuery = `
        INSERT INTO development_applications (
          id, user_id, selection_data, eligibility_data, form_data, 
          fees_data, status, submitted_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        RETURNING *
      `
      
      const values = [
        applicationId,
        applicationData.userId || 'anonymous',
        JSON.stringify(applicationData.selection),
        JSON.stringify(applicationData.eligibility),
        JSON.stringify(applicationData.formData),
        JSON.stringify(applicationData.fees || {}),
        applicationData.status || 'submitted',
        applicationData.submittedAt || new Date().toISOString()
      ]
      
      const result = await client.query(insertQuery, values)
      const application = result.rows[0]
      
      // Insert documents if any
      if (applicationData.documents && applicationData.documents.length > 0) {
        for (const doc of applicationData.documents) {
          const docQuery = `
            INSERT INTO application_documents (
              application_id, document_name, document_type, 
              file_size, file_url, uploaded_at
            ) VALUES ($1, $2, $3, $4, $5, NOW())
          `
          
          await client.query(docQuery, [
            applicationId,
            doc.name,
            doc.type,
            doc.size,
            doc.url || ''
          ])
        }
      }
      
      // Create initial timeline entry
      const timelineQuery = `
        INSERT INTO application_timeline (
          application_id, event_type, event_description, 
          event_date, created_at
        ) VALUES ($1, $2, $3, $4, NOW())
      `
      
      await client.query(timelineQuery, [
        applicationId,
        'submitted',
        'Application submitted successfully',
        new Date().toISOString()
      ])
      
      await client.query('COMMIT')
      
      console.log(`✅ Application ${applicationId} submitted successfully`)
      
      return {
        id: applicationId,
        ...application,
        documents: applicationData.documents
      }
      
    } catch (error) {
      await client.query('ROLLBACK')
      console.error('❌ Failed to submit application:', error)
      throw error
    } finally {
      client.release()
    }
  }

  // Get application by ID
  async getApplication(applicationId: string) {
    const client = await this.pool.connect()
    
    try {
      // Get main application data
      const appQuery = `
        SELECT * FROM development_applications 
        WHERE id = $1
      `
      
      const appResult = await client.query(appQuery, [applicationId])
      
      if (appResult.rows.length === 0) {
        throw new Error('Application not found')
      }
      
      const application = appResult.rows[0]
      
      // Get documents
      const docsQuery = `
        SELECT * FROM application_documents 
        WHERE application_id = $1 
        ORDER BY uploaded_at DESC
      `
      
      const docsResult = await client.query(docsQuery, [applicationId])
      
      // Get timeline
      const timelineQuery = `
        SELECT * FROM application_timeline 
        WHERE application_id = $1 
        ORDER BY event_date DESC
      `
      
      const timelineResult = await client.query(timelineQuery, [applicationId])
      
      return {
        ...application,
        selection: JSON.parse(application.selection_data),
        eligibility: JSON.parse(application.eligibility_data),
        formData: JSON.parse(application.form_data),
        fees: JSON.parse(application.fees_data || '{}'),
        documents: docsResult.rows,
        timeline: timelineResult.rows
      }
      
    } catch (error) {
      console.error(`❌ Failed to get application ${applicationId}:`, error)
      throw error
    } finally {
      client.release()
    }
  }

  // Get applications for user
  async getUserApplications(userId: string) {
    const client = await this.pool.connect()
    
    try {
      const query = `
        SELECT 
          id, status, submitted_at, updated_at,
          (selection_data->>'name_cfu') as parcel_name,
          (form_data->>'applicantName') as applicant_name,
          (fees_data->>'total') as total_fees
        FROM development_applications 
        WHERE user_id = $1 
        ORDER BY submitted_at DESC
      `
      
      const result = await client.query(query, [userId])
      
      return result.rows
      
    } catch (error) {
      console.error('❌ Failed to get user applications:', error)
      throw error
    } finally {
      client.release()
    }
  }

  // Update application status
  async updateApplicationStatus(applicationId: string, status: string, notes: string = '') {
    const client = await this.pool.connect()
    
    try {
      await client.query('BEGIN')
      
      // Update application status
      const updateQuery = `
        UPDATE development_applications 
        SET status = $1, updated_at = NOW() 
        WHERE id = $2
        RETURNING *
      `
      
      await client.query(updateQuery, [status, applicationId])
      
      // Add timeline entry
      const timelineQuery = `
        INSERT INTO application_timeline (
          application_id, event_type, event_description, 
          event_date, created_at
        ) VALUES ($1, $2, $3, $4, NOW())
      `
      
      await client.query(timelineQuery, [
        applicationId,
        'status_change',
        `Status changed to: ${status}${notes ? '. Notes: ' + notes : ''}`,
        new Date().toISOString()
      ])
      
      await client.query('COMMIT')
      
      console.log(`✅ Application ${applicationId} status updated to ${status}`)
      
      return { success: true, status, notes }
      
    } catch (error) {
      await client.query('ROLLBACK')
      console.error('❌ Failed to update application status:', error)
      throw error
    } finally {
      client.release()
    }
  }

  // Get application timeline
  async getApplicationTimeline(applicationId: string) {
    const client = await this.pool.connect()
    
    try {
      const query = `
        SELECT * FROM application_timeline 
        WHERE application_id = $1 
        ORDER BY event_date DESC
      `
      
      const result = await client.query(query, [applicationId])
      
      return result.rows
      
    } catch (error) {
      console.error('❌ Failed to get application timeline:', error)
      throw error
    } finally {
      client.release()
    }
  }

  // Add comment to application
  async addApplicationComment(applicationId: string, comment: string, isInternal: boolean = false) {
    const client = await this.pool.connect()
    
    try {
      const query = `
        INSERT INTO application_comments (
          application_id, comment_text, is_internal, created_at
        ) VALUES ($1, $2, $3, NOW())
        RETURNING *
      `
      
      const result = await client.query(query, [applicationId, comment, isInternal])
      
      console.log(`✅ Comment added to application ${applicationId}`)
      
      return result.rows[0]
      
    } catch (error) {
      console.error('❌ Failed to add application comment:', error)
      throw error
    } finally {
      client.release()
    }
  }

  // Upload document (mock implementation)
  async uploadDocument(applicationId: string, file: any, documentType: string) {
    const client = await this.pool.connect()
    
    try {
      // In a real implementation, you would:
      // 1. Save file to storage (S3, local filesystem, etc.)
      // 2. Generate URL for the file
      // 3. Store metadata in database
      
      const fileUrl = `/uploads/${applicationId}/${file.filename}`
      
      const query = `
        INSERT INTO application_documents (
          application_id, document_name, document_type, 
          file_size, file_url, uploaded_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING *
      `
      
      const result = await client.query(query, [
        applicationId,
        file.filename,
        documentType,
        file.size || 0,
        fileUrl
      ])
      
      console.log(`✅ Document uploaded for application ${applicationId}`)
      
      return result.rows[0]
      
    } catch (error) {
      console.error('❌ Failed to upload document:', error)
      throw error
    } finally {
      client.release()
    }
  }

  // Get application documents
  async getApplicationDocuments(applicationId: string) {
    const client = await this.pool.connect()
    
    try {
      const query = `
        SELECT * FROM application_documents 
        WHERE application_id = $1 
        ORDER BY uploaded_at DESC
      `
      
      const result = await client.query(query, [applicationId])
      
      return result.rows
      
    } catch (error) {
      console.error('❌ Failed to get application documents:', error)
      throw error
    } finally {
      client.release()
    }
  }

  // Delete document
  async deleteDocument(applicationId: string, documentId: string) {
    const client = await this.pool.connect()
    
    try {
      const query = `
        DELETE FROM application_documents 
        WHERE id = $1 AND application_id = $2
      `
      
      const result = await client.query(query, [documentId, applicationId])
      
      if (result.rowCount === 0) {
        throw new Error('Document not found')
      }
      
      console.log(`✅ Document ${documentId} deleted from application ${applicationId}`)
      
      return true
      
    } catch (error) {
      console.error('❌ Failed to delete document:', error)
      throw error
    } finally {
      client.release()
    }
  }

  // Calculate fees
  async calculateFees(applicationData: ApplicationData) {
    try {
      const baseFee = 500
      const areaFee = (applicationData.selection?.area_hectares || 0) * 50
      const processingFee = 200
      
      const fees = {
        application: baseFee,
        planning: areaFee,
        processing: processingFee,
        total: baseFee + areaFee + processingFee
      }
      
      console.log(`💰 Fees calculated: $${fees.total}`)
      
      return fees
      
    } catch (error) {
      console.error('❌ Failed to calculate fees:', error)
      throw error
    }
  }

  // Get application statistics
  async getApplicationStats(filters: ApplicationFilters = {}) {
    const client = await this.pool.connect()
    
    try {
      let whereClause = 'WHERE 1=1'
      const params: any[] = []
      let paramIndex = 1
      
      if (filters.startDate) {
        whereClause += ` AND submitted_at >= $${paramIndex++}`
        params.push(filters.startDate)
      }
      
      if (filters.endDate) {
        whereClause += ` AND submitted_at <= $${paramIndex++}`
        params.push(filters.endDate)
      }
      
      if (filters.status) {
        whereClause += ` AND status = $${paramIndex++}`
        params.push(filters.status)
      }
      
      const query = `
        SELECT 
          COUNT(*) as total_applications,
          COUNT(CASE WHEN status = 'submitted' THEN 1 END) as submitted,
          COUNT(CASE WHEN status = 'under_review' THEN 1 END) as under_review,
          COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved,
          COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected,
          AVG(CAST(fees_data->>'total' AS DECIMAL)) as avg_fees
        FROM development_applications 
        ${whereClause}
      `
      
      const result = await client.query(query, params)
      
      return result.rows[0]
      
    } catch (error) {
      console.error('❌ Failed to get application stats:', error)
      throw error
    } finally {
      client.release()
    }
  }

  // Search applications
  async searchApplications(query: string, filters: any = {}) {
    const client = await this.pool.connect()
    
    try {
      let whereClause = 'WHERE 1=1'
      const params: any[] = []
      let paramIndex = 1
      
      // Search in various fields
      whereClause += ` AND (
        id ILIKE $${paramIndex++} OR
        form_data->>'applicantName' ILIKE $${paramIndex++} OR
        selection_data->>'name_cfu' ILIKE $${paramIndex++} OR
        selection_data->>'parcel_id' ILIKE $${paramIndex++}
      )`
      
      const searchPattern = `%${query}%`
      params.push(searchPattern, searchPattern, searchPattern, searchPattern)
      
      if (filters.status) {
        whereClause += ` AND status = $${paramIndex++}`
        params.push(filters.status)
      }
      
      const limit = filters.limit || 20
      const offset = filters.offset || 0
      
      const searchQuery = `
        SELECT 
          id, status, submitted_at, updated_at,
          (selection_data->>'name_cfu') as parcel_name,
          (form_data->>'applicantName') as applicant_name,
          (fees_data->>'total') as total_fees
        FROM development_applications 
        ${whereClause}
        ORDER BY submitted_at DESC
        LIMIT $${paramIndex++} OFFSET $${paramIndex++}
      `
      
      params.push(limit, offset)
      
      const result = await client.query(searchQuery, params)
      
      return result.rows
      
    } catch (error) {
      console.error('❌ Failed to search applications:', error)
      throw error
    } finally {
      client.release()
    }
  }

  // Get development types
  async getDevelopmentTypes() {
    try {
      return [
        { id: 'residential-single', name: 'Single Family Residential', description: 'Single family dwelling' },
        { id: 'residential-multi', name: 'Multi-Family Residential', description: 'Apartment buildings, townhouses' },
        { id: 'commercial', name: 'Commercial', description: 'Retail, office buildings' },
        { id: 'industrial', name: 'Industrial', description: 'Factories, warehouses' },
        { id: 'agricultural', name: 'Agricultural', description: 'Farming, agricultural buildings' },
        { id: 'institutional', name: 'Institutional', description: 'Schools, hospitals, government buildings' },
        { id: 'recreational', name: 'Recreational', description: 'Parks, sports facilities' },
        { id: 'mixed-use', name: 'Mixed Use Development', description: 'Combination of uses' }
      ]
    } catch (error) {
      console.error('❌ Failed to get development types:', error)
      throw error
    }
  }

  // Get zone-specific requirements
  async getZoneRequirements(zoneName: string) {
    try {
      const zoneRequirements: Record<string, any> = {
        'Estates': {
          requiredDocuments: ['Architectural approval', 'Site plan', 'Building plans'],
          specialConditions: ['Must comply with estate architectural guidelines'],
          processingTime: '4-6 weeks'
        },
        'Conservation Areas': {
          requiredDocuments: ['Environmental impact assessment', 'Site plan', 'Building plans'],
          specialConditions: ['Environmental clearance required'],
          processingTime: '6-8 weeks'
        },
        'Irrigation Farming': {
          requiredDocuments: ['Water rights documentation', 'Site plan', 'Building plans'],
          specialConditions: ['Valid water rights required'],
          processingTime: '4-5 weeks'
        },
        'Urban Expansion': {
          requiredDocuments: ['Urban development permit', 'Site plan', 'Building plans'],
          specialConditions: ['Urban planning approval required'],
          processingTime: '5-7 weeks'
        }
      }
      
      return zoneRequirements[zoneName] || {
        requiredDocuments: ['Site plan', 'Building plans'],
        specialConditions: ['Standard requirements apply'],
        processingTime: '4-6 weeks'
      }
      
    } catch (error) {
      console.error('❌ Failed to get zone requirements:', error)
      throw error
    }
  }

  // Save draft application
  async saveDraft(draftData: ApplicationData) {
    const client = await this.pool.connect()
    
    try {
      const draftId = `DRAFT-${Date.now().toString().slice(-6)}`
      
      const query = `
        INSERT INTO application_drafts (
          id, user_id, draft_data, created_at, updated_at
        ) VALUES ($1, $2, $3, NOW(), NOW())
        RETURNING *
      `
      
      const result = await client.query(query, [
        draftId,
        draftData.userId || 'anonymous',
        JSON.stringify(draftData)
      ])
      
      console.log(`✅ Draft ${draftId} saved successfully`)
      
      return result.rows[0]
      
    } catch (error) {
      console.error('❌ Failed to save draft:', error)
      throw error
    } finally {
      client.release()
    }
  }

  // Get drafts for user
  async getDrafts(userId: string) {
    const client = await this.pool.connect()
    
    try {
      const query = `
        SELECT * FROM application_drafts 
        WHERE user_id = $1 
        ORDER BY updated_at DESC
      `
      
      const result = await client.query(query, [userId])
      
      return result.rows
      
    } catch (error) {
      console.error('❌ Failed to get drafts:', error)
      throw error
    } finally {
      client.release()
    }
  }

  // Delete draft
  async deleteDraft(draftId: string) {
    const client = await this.pool.connect()
    
    try {
      const query = `
        DELETE FROM application_drafts 
        WHERE id = $1
      `
      
      const result = await client.query(query, [draftId])
      
      if (result.rowCount === 0) {
        throw new Error('Draft not found')
      }
      
      console.log(`✅ Draft ${draftId} deleted successfully`)
      
      return true
      
    } catch (error) {
      console.error('❌ Failed to delete draft:', error)
      throw error
    } finally {
      client.release()
    }
  }

  // Export application (mock implementation)
  async exportApplication(applicationId: string, format: string) {
    try {
      // In a real implementation, this would generate PDF/JSON/CSV files
      console.log(`📄 Exporting application ${applicationId} as ${format}`)
      
      return {
        applicationId,
        format,
        exportedAt: new Date().toISOString(),
        downloadUrl: `/exports/${applicationId}.${format}`
      }
      
    } catch (error) {
      console.error('❌ Failed to export application:', error)
      throw error
    }
  }
}

export { DevelopmentApplicationService }
