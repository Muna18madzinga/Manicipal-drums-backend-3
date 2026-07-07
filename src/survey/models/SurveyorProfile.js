import db from '../config/db.js'

class SurveyorProfile {
  /**
   * Create a new surveyor profile
   */
  static async create({ 
    userId, name, surveyorType, licenseNumber, registrationNumber, 
    studentNumber, firm, address, phone, institution, supervisorId 
  }) {
    const result = await db.query(
      `INSERT INTO surveyor_profiles (
        user_id, name, surveyor_type, license_number, registration_number,
        student_number, firm, address, phone, institution, supervisor_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [userId, name, surveyorType, licenseNumber, registrationNumber, 
       studentNumber, firm, address, phone, institution, supervisorId]
    )
    return result.rows[0]
  }

  /**
   * Get surveyor profile by user ID
   */
  static async findByUserId(userId) {
    const result = await db.query(
      `SELECT 
        p.*,
        supervisor.name as supervisor_name,
        supervisor.license_number as supervisor_license
      FROM surveyor_profiles p
      LEFT JOIN surveyor_profiles supervisor ON supervisor.id = p.supervisor_id
      WHERE p.user_id = $1`,
      [userId]
    )
    return result.rows[0]
  }

  /**
   * Get surveyor profile by ID
   */
  static async findById(id) {
    const result = await db.query(
      `SELECT 
        p.*,
        supervisor.name as supervisor_name,
        supervisor.license_number as supervisor_license
      FROM surveyor_profiles p
      LEFT JOIN surveyor_profiles supervisor ON supervisor.id = p.supervisor_id
      WHERE p.id = $1`,
      [id]
    )
    return result.rows[0]
  }

  /**
   * Get surveyor profile by license number
   */
  static async findByLicense(licenseNumber) {
    const result = await db.query(
      'SELECT * FROM surveyor_profiles WHERE license_number = $1',
      [licenseNumber]
    )
    return result.rows[0]
  }

  /**
   * Get all surveyor profiles
   */
  static async findAll() {
    const result = await db.query(
      `SELECT 
        p.*,
        u.email,
        supervisor.name as supervisor_name
      FROM surveyor_profiles p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN surveyor_profiles supervisor ON supervisor.id = p.supervisor_id
      ORDER BY p.name`
    )
    return result.rows
  }

  /**
   * Get surveyors by type
   */
  static async findByType(surveyorType) {
    const result = await db.query(
      `SELECT 
        p.*,
        u.email
      FROM surveyor_profiles p
      JOIN users u ON u.id = p.user_id
      WHERE p.surveyor_type = $1
      ORDER BY p.name`,
      [surveyorType]
    )
    return result.rows
  }

  /**
   * Get registered surveyors (for supervisor selection)
   */
  static async findRegisteredSurveyors() {
    return this.findByType('registered')
  }

  /**
   * Update surveyor profile
   */
  static async update(id, { 
    name, surveyorType, licenseNumber, registrationNumber,
    studentNumber, firm, address, phone, institution, supervisorId
  }) {
    const result = await db.query(
      `UPDATE surveyor_profiles 
       SET name = COALESCE($1, name),
           surveyor_type = COALESCE($2, surveyor_type),
           license_number = COALESCE($3, license_number),
           registration_number = COALESCE($4, registration_number),
           student_number = COALESCE($5, student_number),
           firm = COALESCE($6, firm),
           address = COALESCE($7, address),
           phone = COALESCE($8, phone),
           institution = COALESCE($9, institution),
           supervisor_id = COALESCE($10, supervisor_id),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $11
       RETURNING *`,
      [name, surveyorType, licenseNumber, registrationNumber, studentNumber,
       firm, address, phone, institution, supervisorId, id]
    )
    return result.rows[0]
  }

  /**
   * Delete surveyor profile
   */
  static async delete(id) {
    await db.query('DELETE FROM surveyor_profiles WHERE id = $1', [id])
  }

  /**
   * Get surveyor's projects
   */
  static async getProjects(profileId) {
    const result = await db.query(
      `SELECT * FROM survey_projects 
       WHERE surveyor_profile_id = $1 
       ORDER BY created_at DESC`,
      [profileId]
    )
    return result.rows
  }

  /**
   * Get students/trainees supervised by a surveyor
   */
  static async getSupervisees(profileId) {
    const result = await db.query(
      `SELECT 
        p.*,
        u.email
      FROM surveyor_profiles p
      JOIN users u ON u.id = p.user_id
      WHERE p.supervisor_id = $1
      ORDER BY p.name`,
      [profileId]
    )
    return result.rows
  }

  /**
   * Update schema_name for a surveyor profile
   */
  static async updateSchemaName(profileId, schemaName) {
    const result = await db.query(
      `UPDATE surveyor_profiles 
       SET schema_name = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [schemaName, profileId]
    )
    return result.rows[0]
  }

  /**
   * Get surveyor profile by schema name
   */
  static async findBySchemaName(schemaName) {
    const result = await db.query(
      `SELECT 
        p.*,
        supervisor.name as supervisor_name,
        supervisor.license_number as supervisor_license
      FROM surveyor_profiles p
      LEFT JOIN surveyor_profiles supervisor ON supervisor.id = p.supervisor_id
      WHERE p.schema_name = $1`,
      [schemaName]
    )
    return result.rows[0]
  }
}

export default SurveyorProfile
