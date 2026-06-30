// Development Application API Routes (JavaScript/CommonJS)
// Handles all development application related endpoints.
//
// SECURITY (audit fix F1): every endpoint now requires a valid JWT. Reads are
// owner-scoped — a citizen only sees their own applications; staff see all.
// Status changes are staff-only and validated against an allow-list. Errors
// return a generic message (detail is logged server-side only) so DB/driver
// internals are never leaked to the client.

const { requireAuth, requireRole } = require('../middleware/jwtAuth')

// Council staff who may read every application and change status.
const STAFF_ROLES = [
  'admin', 'planner', 'planning_clerk', 'eo',
  'gis_officer', 'env_officer', 'building_inspector', 'surveyor',
]

// Legal application statuses. Anything else is rejected on PATCH.
const ALLOWED_STATUSES = [
  'draft', 'submitted', 'under_review', 'pending_payment',
  'more_info_required', 'approved', 'rejected', 'withdrawn',
]

const isStaff = (user) => !!user && STAFF_ROLES.includes(user.role)

async function developmentApplicationRoutes(fastify, options) {
  const authd = { preHandler: requireAuth(fastify) }
  const staffOnly = { preHandler: requireRole(fastify, STAFF_ROLES) }

  // Submit new development application (authenticated citizen).
  fastify.post('/development-applications', {
    ...authd,
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
        request.user.id,
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

      return reply.status(201).send({
        success: true,
        applicationId,
        message: 'Application submitted successfully',
        data: rows[0]
      })
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to submit application')
      return reply.status(500).send({ success: false, message: 'Failed to submit application' })
    }
  })

  // Get application by ID (owner or staff only).
  fastify.get('/development-applications/:id', authd, async (request, reply) => {
    try {
      const { id } = request.params
      const { rows } = await fastify.pg.query('SELECT * FROM development_applications WHERE id = $1', [id])
      if (rows.length === 0) {
        return reply.status(404).send({ success: false, message: 'Application not found' })
      }

      const app = rows[0]
      // 404 (not 403) for someone else's application so we don't leak existence.
      if (!isStaff(request.user) && String(app.user_id) !== String(request.user.id)) {
        return reply.status(404).send({ success: false, message: 'Application not found' })
      }

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
      fastify.log.error({ err: error }, 'Failed to get application')
      return reply.status(500).send({ success: false, message: 'Failed to load application' })
    }
  })

  // List applications. Citizens see only their own; staff see all.
  fastify.get('/development-applications', authd, async (request, reply) => {
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
      const where = []
      if (!isStaff(request.user)) {
        params.push(request.user.id)
        where.push(`user_id = $${params.length}`)
      }
      if (status) {
        params.push(status)
        where.push(`status = $${params.length}`)
      }
      if (where.length) query += ` WHERE ${where.join(' AND ')}`
      query += ` ORDER BY submitted_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
      params.push(limit, offset)

      const { rows } = await fastify.pg.query(query, params)
      return { success: true, data: rows, count: rows.length }
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to get applications')
      return reply.status(500).send({ success: false, message: 'Failed to load applications' })
    }
  })

  // Update application status (staff only, validated transition target).
  fastify.patch('/development-applications/:id/status', staffOnly, async (request, reply) => {
    try {
      const { id } = request.params
      const { status, notes } = request.body || {}

      if (!ALLOWED_STATUSES.includes(status)) {
        return reply.status(400).send({ success: false, message: 'Invalid status value' })
      }

      const upd = await fastify.pg.query(
        'UPDATE development_applications SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
        [status, id]
      )
      if (upd.rows.length === 0) {
        return reply.status(404).send({ success: false, message: 'Application not found' })
      }
      await fastify.pg.query(
        `INSERT INTO application_timeline (application_id, event_type, event_description, event_date, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [id, 'status_change', `Status changed to: ${status}${notes ? '. Notes: ' + notes : ''}`, new Date().toISOString()]
      )

      return { success: true, data: { status, notes }, message: 'Status updated successfully' }
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to update status')
      return reply.status(500).send({ success: false, message: 'Failed to update status' })
    }
  })

  // Helper: confirm the caller may see a given application.
  async function assertCanReadApplication(request, reply, id) {
    const { rows } = await fastify.pg.query('SELECT user_id FROM development_applications WHERE id = $1', [id])
    if (rows.length === 0) {
      reply.status(404).send({ success: false, message: 'Application not found' })
      return false
    }
    if (!isStaff(request.user) && String(rows[0].user_id) !== String(request.user.id)) {
      reply.status(404).send({ success: false, message: 'Application not found' })
      return false
    }
    return true
  }

  // Get application timeline (owner or staff).
  fastify.get('/development-applications/:id/timeline', authd, async (request, reply) => {
    try {
      const { id } = request.params
      if (!(await assertCanReadApplication(request, reply, id))) return
      const { rows } = await fastify.pg.query(
        'SELECT * FROM application_timeline WHERE application_id = $1 ORDER BY event_date DESC', [id]
      )
      return { success: true, data: rows }
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to get timeline')
      return reply.status(500).send({ success: false, message: 'Failed to load timeline' })
    }
  })

  // Add comment (owner or staff). Internal comments are staff-only.
  fastify.post('/development-applications/:id/comments', authd, async (request, reply) => {
    try {
      const { id } = request.params
      const { comment, isInternal } = request.body || {}
      if (!(await assertCanReadApplication(request, reply, id))) return
      const internal = isStaff(request.user) ? !!isInternal : false
      const { rows } = await fastify.pg.query(
        `INSERT INTO application_comments (application_id, comment_text, is_internal, author_id, created_at)
         VALUES ($1, $2, $3, $4, NOW()) RETURNING *`,
        [id, comment, internal, request.user.id]
      )
      return { success: true, data: rows[0], message: 'Comment added' }
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to add comment')
      return reply.status(500).send({ success: false, message: 'Failed to add comment' })
    }
  })

  // Get documents (owner or staff).
  fastify.get('/development-applications/:id/documents', authd, async (request, reply) => {
    try {
      const { id } = request.params
      if (!(await assertCanReadApplication(request, reply, id))) return
      const { rows } = await fastify.pg.query(
        'SELECT * FROM application_documents WHERE application_id = $1 ORDER BY uploaded_at DESC', [id]
      )
      return { success: true, data: rows }
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to get documents')
      return reply.status(500).send({ success: false, message: 'Failed to load documents' })
    }
  })

  // Calculate fees (authenticated).
  fastify.post('/development-applications/calculate-fees', authd, async (request, reply) => {
    try {
      const { selection, eligibility } = request.body || {}
      const baseFee = 500
      const areaFee = (selection?.area_hectares || 0) * 50
      const processingFee = 200
      return {
        success: true,
        data: { application: baseFee, planning: areaFee, processing: processingFee, total: baseFee + areaFee + processingFee }
      }
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to calculate fees')
      return reply.status(500).send({ success: false, message: 'Failed to calculate fees' })
    }
  })

  // Get application statistics (staff only — aggregate council data).
  fastify.get('/development-applications/stats', staffOnly, async (request, reply) => {
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
      fastify.log.error({ err: error }, 'Failed to get stats')
      return reply.status(500).send({ success: false, message: 'Failed to load statistics' })
    }
  })

  // Save draft (authenticated, owned by caller).
  fastify.post('/development-applications/drafts', authd, async (request, reply) => {
    try {
      const draftId = `DRAFT-${Date.now().toString().slice(-6)}`
      const { rows } = await fastify.pg.query(
        `INSERT INTO application_drafts (id, user_id, draft_data, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW()) RETURNING *`,
        [draftId, request.user.id, JSON.stringify(request.body)]
      )
      return { success: true, data: rows[0], message: 'Draft saved' }
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to save draft')
      return reply.status(500).send({ success: false, message: 'Failed to save draft' })
    }
  })

  // Get drafts (caller's own only).
  fastify.get('/development-applications/drafts', authd, async (request, reply) => {
    try {
      const { rows } = await fastify.pg.query(
        'SELECT * FROM application_drafts WHERE user_id = $1 ORDER BY updated_at DESC',
        [request.user.id]
      )
      return { success: true, data: rows, count: rows.length }
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to get drafts')
      return reply.status(500).send({ success: false, message: 'Failed to load drafts' })
    }
  })

  // Delete draft (caller's own only).
  fastify.delete('/development-applications/drafts/:id', authd, async (request, reply) => {
    try {
      const { id } = request.params
      const del = await fastify.pg.query(
        'DELETE FROM application_drafts WHERE id = $1 AND user_id = $2 RETURNING id',
        [id, request.user.id]
      )
      if (del.rows.length === 0) {
        return reply.status(404).send({ success: false, message: 'Draft not found' })
      }
      return { success: true, message: 'Draft deleted' }
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to delete draft')
      return reply.status(500).send({ success: false, message: 'Failed to delete draft' })
    }
  })

  // Get development types (reference data, authenticated).
  fastify.get('/development-applications/development-types', authd, async (request, reply) => {
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

  // Get zone requirements (reference data, authenticated).
  fastify.get('/development-applications/zone-requirements', authd, async (request, reply) => {
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
