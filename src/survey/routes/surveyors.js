import SurveyorProfile from '../models/SurveyorProfile.js'

export default async function surveyorRoutes(fastify, options) {
  // Get all surveyors (from surveyor_profiles table)
  fastify.get('/surveyors', async (request, reply) => {
    try {
      const surveyors = await SurveyorProfile.findAll()
      
      // Transform to match old API format for backwards compatibility
      const formattedSurveyors = surveyors.map(s => ({
        id: s.id,
        name: s.name,
        license_number: s.license_number || s.registration_number || s.student_number,
        firm: s.firm,
        address: s.address,
        phone: s.phone,
        email: s.email,
        is_active: true,
        created_at: s.created_at,
        updated_at: s.updated_at,
        surveyor_type: s.surveyor_type,
        supervisor_name: s.supervisor_name
      }))
      
      return { ok: true, surveyors: formattedSurveyors }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ ok: false, error: 'Failed to fetch surveyors' })
    }
  })

  // Get surveyor by ID
  fastify.get('/surveyors/:id', async (request, reply) => {
    try {
      const { id } = request.params
      const surveyor = await SurveyorProfile.findById(id)
      
      if (!surveyor) {
        return reply.code(404).send({ ok: false, error: 'Surveyor not found' })
      }
      
      // Transform to match old API format
      const formatted = {
        id: surveyor.id,
        name: surveyor.name,
        license_number: surveyor.license_number || surveyor.registration_number || surveyor.student_number,
        firm: surveyor.firm,
        address: surveyor.address,
        phone: surveyor.phone,
        email: surveyor.email,
        is_active: true,
        created_at: surveyor.created_at,
        updated_at: surveyor.updated_at,
        surveyor_type: surveyor.surveyor_type
      }
      
      return { ok: true, surveyor: formatted }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ ok: false, error: 'Failed to fetch surveyor' })
    }
  })

  // Create new surveyor (admin function - creates user + profile)
  fastify.post('/surveyors', async (request, reply) => {
    try {
      const { name, licenseNumber, firm, address, phone, email } = request.body
      
      if (!name) {
        return reply.code(400).send({ 
          ok: false, 
          error: 'Name is required' 
        })
      }

      // Check if license number already exists (if provided)
      if (licenseNumber) {
        const existing = await SurveyorProfile.findByLicense(licenseNumber)
        if (existing) {
          return reply.code(409).send({ 
            ok: false, 
            error: 'A surveyor with this license number already exists' 
          })
        }
      }

      // Note: This endpoint is for backwards compatibility
      // New users should register via /auth/register and /surveyor-profiles
      // This just creates a profile without a user account (not recommended)
      return reply.code(501).send({ 
        ok: false, 
        error: 'Please use the registration flow to create new surveyors' 
      })
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ ok: false, error: 'Failed to create surveyor' })
    }
  })

  // Update surveyor
  fastify.put('/surveyors/:id', async (request, reply) => {
    try {
      const { id } = request.params
      const { name, licenseNumber, firm, address, phone } = request.body

      const surveyor = await SurveyorProfile.update(id, {
        name,
        licenseNumber,
        firm,
        address,
        phone
      })

      if (!surveyor) {
        return reply.code(404).send({ ok: false, error: 'Surveyor not found' })
      }

      // Transform to match old API format
      const formatted = {
        id: surveyor.id,
        name: surveyor.name,
        license_number: surveyor.license_number || surveyor.registration_number || surveyor.student_number,
        firm: surveyor.firm,
        address: surveyor.address,
        phone: surveyor.phone,
        is_active: true,
        created_at: surveyor.created_at,
        updated_at: surveyor.updated_at
      }

      return { ok: true, surveyor: formatted }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ ok: false, error: 'Failed to update surveyor' })
    }
  })

  // Delete surveyor
  fastify.delete('/surveyors/:id', async (request, reply) => {
    try {
      const { id } = request.params
      
      // Check if surveyor exists
      const surveyor = await SurveyorProfile.findById(id)
      if (!surveyor) {
        return reply.code(404).send({ ok: false, error: 'Surveyor not found' })
      }
      
      await SurveyorProfile.delete(id)

      return { ok: true, message: 'Surveyor deleted successfully' }
    } catch (error) {
      fastify.log.error(error)
      return reply.code(500).send({ ok: false, error: 'Failed to delete surveyor' })
    }
  })
}
