import User from '../models/user.js'
import SurveyorProfile from '../models/SurveyorProfile.js'
import { getSurveyorPool } from '../config/db.js'

/**
 * Authentication decorator that adds schema context to requests
 * This should be used AFTER app.authenticate for routes that need schema isolation
 */
export async function authenticateWithSchema(request, reply) {
  try {
    // First verify JWT token (should be done by app.authenticate before this)
    if (!request.user || !request.user.email) {
      console.error('[Schema Auth] ❌ No user in request')
      return reply.code(401).send({ error: 'Unauthorized - no user in request' })
    }

    // Get user from database
    const user = await User.findByEmail(request.user.email)
    if (!user) {
      console.error(`[Schema Auth] ❌ User not found: ${request.user.email}`)
      return reply.code(401).send({ error: 'User not found' })
    }

    // Get surveyor profile
    const profile = await SurveyorProfile.findByUserId(user.id)
    if (!profile) {
      console.log('[Schema Auth] ⚠️ No surveyor profile - using public schema')
      request.surveyorSchema = null
      request.surveyorProfile = null
      request.db = null
      return
    }

    // Check if surveyor has a schema
    if (!profile.schema_name) {
      console.warn(`[Schema Auth] ⚠️ ${profile.name} has no schema - using public`)
      request.surveyorSchema = 'public'
      request.surveyorProfile = profile
      request.db = null
      return
    }

    // Attach schema context to request
    request.surveyorSchema = profile.schema_name
    request.surveyorProfile = profile
    request.db = getSurveyorPool(profile.schema_name)

    // Also attach for convenience
    request.user.profileId = profile.id
    request.user.schemaName = profile.schema_name

  } catch (error) {
    console.error('[Schema Auth] ❌ EXCEPTION:', error.message)
    request.log.error('Schema authentication error:', error)
    return reply.code(500).send({ error: 'Authentication error', details: error.message, stack: error.stack })
  }
}

/**
 * Optional decorator - doesn't fail if no schema, just adds context if available
 */
export async function attachSchemaIfAvailable(request, reply) {
  try {
    if (!request.user || !request.user.email) {
      return // No user, skip
    }

    const user = await User.findByEmail(request.user.email)
    if (!user) return

    const profile = await SurveyorProfile.findByUserId(user.id)
    if (!profile || !profile.schema_name) return

    // Attach schema context
    request.surveyorSchema = profile.schema_name
    request.surveyorProfile = profile
    request.db = getSurveyorPool(profile.schema_name)
    request.user.profileId = profile.id
    request.user.schemaName = profile.schema_name

  } catch (error) {
    request.log.error('Optional schema attachment error:', error)
    // Don't fail the request
  }
}

/**
 * Helper to check if request has schema context
 */
export function requireSchema(request, reply) {
  if (!request.surveyorSchema || !request.db) {
    return reply.code(400).send({ 
      error: 'Schema context required',
      message: 'This operation requires a surveyor profile with schema'
    })
  }
}
