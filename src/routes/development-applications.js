// Development Application API Routes (JavaScript/CommonJS)
// Handles all development application related endpoints

async function developmentApplicationRoutes(fastify, options) {

  // Submit new development application
  fastify.post('/development-applications', {
    schema: {
      description: 'Submit a new development application',
      tags: ['development-applications'],
      body: {
        type: 'object',
        required: ['selection', 'eligibility', 'formData'],
        properties: {
          selection: { type: 'object' },
          eligibility: { type: 'object' },
          formData: { type: 'object' },
          documents: { type: 'array' },
          fees: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { selection, eligibility, formData, documents, fees } = request.body
      const applicationId = `DEV-${Date.now().toString().slice(-6)}`

      const insertQuery = `
        INSERT INTO development_applications (
          id, user_id, selection_data, eligibility_data, form_data, 
          fees_data, status, submitted_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
        RETURNING *
      `
      const values = [
        applicationId,
        request.user?.id || 'anonymous',
        JSON.stringify(selection),
        JSON.stringify(eligibility),
        JSON.stringify(formData),
        JSON.stringify(fees || {}),
        'submitted',
        new Date().toISOString()
      ]

      const { rows } = await fastify.pg.query(insertQuery, values)

      // Create initial timeline entry
      await fastify.pg.query(
        `INSERT INTO application_timeline (application_id, event_type, event_description, event_date, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [applicationId, 'submitted', 'Application submitted successfully', new Date().toISOString()]
      )

      // Insert documents if any
      if (documents && documents.length > 0) {
        for (const doc of documents) {
          await fastify.pg.query(
            `INSERT INTO application_documents (application_id, document_name, document_type, file_size, file_url, uploaded_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [applicationId, doc.name, doc.type, doc.size, doc.url || '']
          )
        }
      }

      console.log(`✅ Application ${applicationId} submitted successfully`)
      return reply.status(201).send({
        success: true,
        applicationId,
        message: 'Application submitted successfully',
        data: rows[0]
      })
    } catch (error) {
      fastify.log.error('❌ Failed to submit application:', error)
      return reply.status(500).send({ success: false, message: error.message || 'Failed to submit application' })
    }
  })

  // Get application by ID
  fastify.get('/development-applications/:id', async (request, reply) => {
    try {
      const { id } = request.params
      const { rows } = await fastify.pg.query('SELECT * FROM development_applications WHERE id = $1', [id])
      if (rows.length === 0) {
        return reply.status(404).send({ success: false, message: 'Application not found' })
      }

      const app = rows[0]
      const docs = await fastify.pg.query('SELECT * FROM application_documents WHERE application_id = $1 ORDER BY uploaded_at DESC', [id])
      const timeline = await fastify.pg.query('SELECT * FROM application_timeline WHERE application_id = $1 ORDER BY event_date DESC', [id])

      return {
        success: true,
        data: {
          ...app,
          selection: typeof app.selection_data === 'string' ? JSON.parse(app.selection_data) : app.selection_data,
          eligibility: typeof app.eligibility_data === 'string' ? JSON.parse(app.eligibility_data) : app.eligibility_data,
          formData: typeof app.form_data === 'string' ? JSON.parse(app.form_data) : app.form_data,
          fees: typeof app.fees_data === 'string' ? JSON.parse(app.fees_data || '{}') : (app.fees_data || {}),
          documents: docs.rows,
          timeline: timeline.rows
        }
      }
    } catch (error) {
      fastify.log.error(`❌ Failed to get application:`, error)
      return reply.status(500).send({ success: false, message: error.message })
    }
  })

  // List applications (for authenticated user)
  fastify.get('/development-applications', async (request, reply) => {
    try {
      const { status, limit = 50, offset = 0 } = request.query || {}
      let query = `
        SELECT id, status, submitted_at, updated_at,
          selection_data->>'name_cfu' as parcel_name,
          form_data->>'applicantName' as applicant_name,
          fees_data->>'total' as total_fees
        FROM development_applications
      `
      const params = []
      if (status) {
        params.push(status)
        query += ` WHERE status = $${params.length}`
      }
      query += ` ORDER BY submitted_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
      params.push(limit, offset)

      const { rows } = await fastify.pg.query(query, params)
      return { success: true, data: rows, count: rows.length }
    } catch (error) {
      fastify.log.error('❌ Failed to get applications:', error)
      return reply.status(500).send({ success: false, message: error.message })
    }
  })

  // Update application status
  fastify.patch('/development-applications/:id/status', async (request, reply) => {
    try {
      const { id } = request.params
      const { status, notes } = request.body

      await fastify.pg.query('UPDATE development_applications SET status = $1, updated_at = NOW() WHERE id = $2', [status, id])
      await fastify.pg.query(
        `INSERT INTO application_timeline (application_id, event_type, event_description, event_date, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [id, 'status_change', `Status changed to: ${status}${notes ? '. Notes: ' + notes : ''}`, new Date().toISOString()]
      )

      console.log(`✅ Application ${id} status updated to ${status}`)
      return { success: true, data: { status, notes }, message: 'Status updated successfully' }
    } catch (error) {
      fastify.log.error('❌ Failed to update status:', error)
      return reply.status(500).send({ success: false, message: error.message })
    }
  })

  // Get application timeline
  fastify.get('/development-applications/:id/timeline', async (request, reply) => {
    try {
      const { id } = request.params
      const { rows } = await fastify.pg.query(
        'SELECT * FROM application_timeline WHERE application_id = $1 ORDER BY event_date DESC', [id]
      )
      return { success: true, data: rows }
    } catch (error) {
      fastify.log.error('❌ Failed to get timeline:', error)
      return reply.status(500).send({ success: false, message: error.message })
    }
  })

  // Add comment
  fastify.post('/development-applications/:id/comments', async (request, reply) => {
    try {
      const { id } = request.params
      const { comment, isInternal } = request.body
      const { rows } = await fastify.pg.query(
        `INSERT INTO application_comments (application_id, comment_text, is_internal, created_at)
         VALUES ($1, $2, $3, NOW()) RETURNING *`,
        [id, comment, isInternal || false]
      )
      return { success: true, data: rows[0], message: 'Comment added' }
    } catch (error) {
      fastify.log.error('❌ Failed to add comment:', error)
      return reply.status(500).send({ success: false, message: error.message })
    }
  })

  // Get documents
  fastify.get('/development-applications/:id/documents', async (request, reply) => {
    try {
      const { id } = request.params
      const { rows } = await fastify.pg.query(
        'SELECT * FROM application_documents WHERE application_id = $1 ORDER BY uploaded_at DESC', [id]
      )
      return { success: true, data: rows }
    } catch (error) {
      fastify.log.error('❌ Failed to get documents:', error)
      return reply.status(500).send({ success: false, message: error.message })
    }
  })

  // Calculate fees
  fastify.post('/development-applications/calculate-fees', async (request, reply) => {
    try {
      const { selection, eligibility } = request.body
      const baseFee = 500
      const areaFee = (selection?.area_hectares || 0) * 50
      const processingFee = 200
      return {
        success: true,
        data: { application: baseFee, planning: areaFee, processing: processingFee, total: baseFee + areaFee + processingFee }
      }
    } catch (error) {
      fastify.log.error('❌ Failed to calculate fees:', error)
      return reply.status(500).send({ success: false, message: error.message })
    }
  })

  // Get application statistics
  fastify.get('/development-applications/stats', async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN status = 'submitted' THEN 1 END) as submitted,
          COUNT(CASE WHEN status = 'under_review' THEN 1 END) as under_review,
          COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved,
          COUNT(CASE WHEN status = 'rejected' THEN 1 END) as rejected
        FROM development_applications
      `)
      return { success: true, data: rows[0] }
    } catch (error) {
      fastify.log.error('❌ Failed to get stats:', error)
      return reply.status(500).send({ success: false, message: error.message })
    }
  })

  // Save draft
  fastify.post('/development-applications/drafts', async (request, reply) => {
    try {
      const draftId = `DRAFT-${Date.now().toString().slice(-6)}`
      const { rows } = await fastify.pg.query(
        `INSERT INTO application_drafts (id, user_id, draft_data, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *`,
        [draftId, request.user?.id || 'anonymous', JSON.stringify(request.body)]
      )
      return { success: true, data: rows[0], message: 'Draft saved' }
    } catch (error) {
      fastify.log.error('❌ Failed to save draft:', error)
      return reply.status(500).send({ success: false, message: error.message })
    }
  })

  // Get drafts
  fastify.get('/development-applications/drafts', async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        'SELECT * FROM application_drafts ORDER BY updated_at DESC'
      )
      return { success: true, data: rows, count: rows.length }
    } catch (error) {
      fastify.log.error('❌ Failed to get drafts:', error)
      return reply.status(500).send({ success: false, message: error.message })
    }
  })

  // Delete draft
  fastify.delete('/development-applications/drafts/:id', async (request, reply) => {
    try {
      const { id } = request.params
      await fastify.pg.query('DELETE FROM application_drafts WHERE id = $1', [id])
      return { success: true, message: 'Draft deleted' }
    } catch (error) {
      fastify.log.error('❌ Failed to delete draft:', error)
      return reply.status(500).send({ success: false, message: error.message })
    }
  })

  // Get development types
  fastify.get('/development-applications/development-types', async (request, reply) => {
    return {
      success: true,
      data: [
        { id: 'residential-single', name: 'Single Family Residential', description: 'Single family dwelling' },
        { id: 'residential-multi', name: 'Multi-Family Residential', description: 'Apartment buildings, townhouses' },
        { id: 'commercial', name: 'Commercial', description: 'Retail, office buildings' },
        { id: 'industrial', name: 'Industrial', description: 'Factories, warehouses' },
        { id: 'agricultural', name: 'Agricultural', description: 'Farming, agricultural buildings' },
        { id: 'institutional', name: 'Institutional', description: 'Schools, hospitals, government buildings' },
        { id: 'recreational', name: 'Recreational', description: 'Parks, sports facilities' },
        { id: 'mixed-use', name: 'Mixed Use Development', description: 'Combination of uses' }
      ]
    }
  })

  // Get zone requirements
  fastify.get('/development-applications/zone-requirements', async (request, reply) => {
    const { zone } = request.query || {}
    const requirements = {
      'Estates': { requiredDocuments: ['Architectural approval', 'Site plan', 'Building plans'], processingTime: '4-6 weeks' },
      'Conservation Areas': { requiredDocuments: ['Environmental impact assessment', 'Site plan', 'Building plans'], processingTime: '6-8 weeks' },
      'Irrigation Farming': { requiredDocuments: ['Water rights documentation', 'Site plan', 'Building plans'], processingTime: '4-5 weeks' },
      'Urban Expansion': { requiredDocuments: ['Urban development permit', 'Site plan', 'Building plans'], processingTime: '5-7 weeks' }
    }
    return { success: true, data: requirements[zone] || { requiredDocuments: ['Site plan', 'Building plans'], processingTime: '4-6 weeks' } }
  })
}

module.exports = developmentApplicationRoutes
