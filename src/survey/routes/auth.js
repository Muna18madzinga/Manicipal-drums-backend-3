import User from '../models/user.js'
import SurveyorProfile from '../models/SurveyorProfile.js'
import db, { createSurveyorSchema } from '../config/db.js'

export default async function authRoutes(app) {
  // Current user
  app.get('/auth/me', {
    preHandler: [app.authenticate]
  }, async (request) => {
    const user = await User.findByEmail(request.user.email)
    
    // Fetch associated surveyor profile (if exists)
    const profile = await SurveyorProfile.findByUserId(user.id)
    
    return { 
      id: user.id, 
      email: user.email,
      user_type: user.user_type,
      profile: profile ? {
        id: profile.id,
        name: profile.name,
        surveyor_type: profile.surveyor_type,
        license_number: profile.license_number,
        registration_number: profile.registration_number,
        student_number: profile.student_number,
        firm: profile.firm,
        address: profile.address,
        phone: profile.phone,
        institution: profile.institution,
        schema_name: profile.schema_name,
        supervisor: profile.supervisor_id ? {
          id: profile.supervisor_id,
          name: profile.supervisor_name,
          license_number: profile.supervisor_license
        } : null
      } : null,
      created_at: user.created_at 
    }
  })

  // Create surveyor profile for current user
  app.post('/surveyor-profiles', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'surveyorType'],
        properties: {
          name: { type: 'string' },
          surveyorType: { type: 'string', enum: ['registered', 'in_training', 'technician', 'student'] },
          licenseNumber: { type: 'string' },
          registrationNumber: { type: 'string' },
          studentNumber: { type: 'string' },
          firm: { type: 'string' },
          address: { type: 'string' },
          phone: { type: 'string' },
          institution: { type: 'string' },
          supervisorId: { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    const user = await User.findByEmail(request.user.email)
    
    // Check if profile already exists
    const existing = await SurveyorProfile.findByUserId(user.id)
    if (existing) {
      return reply.code(409).send({ error: 'Profile already exists' })
    }

    const {
      name, surveyorType, licenseNumber, registrationNumber,
      studentNumber, firm, address, phone, institution, supervisorId
    } = request.body

    try {
      const profile = await SurveyorProfile.create({
        userId: user.id,
        name,
        surveyorType,
        licenseNumber,
        registrationNumber,
        studentNumber,
        firm,
        address,
        phone,
        institution,
        supervisorId
      })

      // Update user_type to match surveyor_type
      const userTypeMap = {
        'registered': 'registered_surveyor',
        'in_training': 'surveyor_in_training',
        'technician': 'technician',
        'student': 'student'
      }
      await db.query(
        'UPDATE users SET user_type = $1 WHERE id = $2',
        [userTypeMap[surveyorType], user.id]
      )

      // Create schema for surveyor (GitHub-like repository)
      try {
        const schemaName = await createSurveyorSchema(user.email)
        await SurveyorProfile.updateSchemaName(profile.id, schemaName)
        profile.schema_name = schemaName
        app.log.info(`Created schema ${schemaName} for surveyor ${user.email}`)
      } catch (schemaError) {
        app.log.error(`Failed to create schema for surveyor ${user.email}:`, schemaError.message)
        // Don't fail the entire request if schema creation fails
        // The schema can be created later manually
      }

      reply.code(201).send(profile)
    } catch (err) {
      app.log.error(err)
      if (err.code === '23505') { // Unique constraint violation
        return reply.code(409).send({ error: 'License or registration number already exists' })
      }
      throw err
    }
  })
}