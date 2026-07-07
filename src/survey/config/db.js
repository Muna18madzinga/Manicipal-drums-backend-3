import pg from 'pg'
import { config } from 'dotenv'

config()

// Connection pool against the shared vungu database. Survey Task Manager's
// shared tables live in the `survey` schema (migration 102); per-surveyor
// data lives in surveyor_<username> schemas created at runtime.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Maximum number of clients
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  options: '-c search_path=survey,public',
})

// Helper function to generate schema name from email/username
function generateSchemaName(identifier) {
  // Remove domain from email, convert to lowercase, replace non-alphanumeric with underscore
  const username = identifier.includes('@') ? identifier.split('@')[0] : identifier
  return 'surveyor_' + username.toLowerCase().replace(/[^a-z0-9]/g, '_')
}

// Get database pool with schema context for specific surveyor
function getSurveyorPool(schemaName) {
  // Validate schema name to prevent SQL injection
  // Must start with 'surveyor_' and contain only lowercase letters, numbers, and underscores
  if (!schemaName || !/^surveyor_[a-z0-9_]+$/.test(schemaName)) {
    throw new Error(`Invalid schema name format: ${schemaName}. Must match pattern: surveyor_[a-z0-9_]+`)
  }
  
  return {
    async query(sql, params) {
      const client = await pool.connect()
      try {
        // Set search path to surveyor schema + survey (shared survey data)
        // + public (vungu shared / PostGIS). Safe after validation above.
        await client.query(`SET search_path = ${schemaName}, survey, public`)
        const result = await client.query(sql, params)
        return result
      } finally {
        client.release()
      }
    },
    
    async connect() {
      const client = await pool.connect()
      // Set search path immediately on connect
      await client.query(`SET search_path = ${schemaName}, survey, public`)
      return client
    }
  }
}

// Create schema for new surveyor
async function createSurveyorSchema(identifier) {
  const schemaName = generateSchemaName(identifier)
  try {
    const result = await pool.query(
      'SELECT create_surveyor_schema($1) AS schema_name',
      [schemaName]
    )
    return result.rows[0].schema_name
  } catch (error) {
    console.error('Error creating surveyor schema:', error.message)
    throw error
  }
}

// Drop surveyor schema (with confirmation)
async function dropSurveyorSchema(identifier, confirmation) {
  const schemaName = generateSchemaName(identifier)
  try {
    await pool.query(
      'SELECT drop_surveyor_schema($1, $2)',
      [schemaName, confirmation]
    )
    return true
  } catch (error) {
    console.error('Error dropping surveyor schema:', error.message)
    throw error
  }
}

// Get schema statistics
async function getSurveyorSchemaStats(identifier) {
  const schemaName = generateSchemaName(identifier)
  try {
    const result = await pool.query(
      'SELECT * FROM get_surveyor_schema_stats($1)',
      [schemaName]
    )
    return result.rows
  } catch (error) {
    console.error('Error getting schema stats:', error.message)
    throw error
  }
}

// Export both the pool and helper functions
export default pool

export {
  pool,
  generateSchemaName,
  getSurveyorPool,
  createSurveyorSchema,
  dropSurveyorSchema,
  getSurveyorSchemaStats
}