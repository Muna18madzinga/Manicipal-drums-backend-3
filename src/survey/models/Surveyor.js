import db from '../config/db.js'

class Surveyor {
  /**
   * Create a new surveyor
   */
  static async create({ name, licenseNumber, firm, address, phone, email, userId }) {
    const result = await db.query(
      `INSERT INTO surveyors (name, license_number, firm, address, phone, email, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [name, licenseNumber, firm, address, phone, email, userId]
    )
    return result.rows[0]
  }

  /**
   * Get all surveyors (optionally filtered by user)
   */
  static async findAll(userId = null) {
    let query = 'SELECT * FROM surveyors WHERE is_active = true'
    const params = []
    
    if (userId) {
      query += ' AND user_id = $1'
      params.push(userId)
    }
    
    query += ' ORDER BY name ASC'
    
    const result = await db.query(query, params)
    return result.rows
  }

  /**
   * Get surveyor by ID
   */
  static async findById(id) {
    const result = await db.query(
      'SELECT * FROM surveyors WHERE id = $1',
      [id]
    )
    return result.rows[0]
  }

  /**
   * Get surveyor by license number
   */
  static async findByLicense(licenseNumber) {
    const result = await db.query(
      'SELECT * FROM surveyors WHERE license_number = $1',
      [licenseNumber]
    )
    return result.rows[0]
  }

  /**
   * Get surveyor by user ID
   */
  static async findByUserId(userId) {
    const result = await db.query(
      'SELECT * FROM surveyors WHERE user_id = $1 AND is_active = true',
      [userId]
    )
    return result.rows[0]
  }

  /**
   * Update surveyor
   */
  static async update(id, { name, licenseNumber, firm, address, phone, email }) {
    const result = await db.query(
      `UPDATE surveyors 
       SET name = COALESCE($1, name),
           license_number = COALESCE($2, license_number),
           firm = COALESCE($3, firm),
           address = COALESCE($4, address),
           phone = COALESCE($5, phone),
           email = COALESCE($6, email)
       WHERE id = $7
       RETURNING *`,
      [name, licenseNumber, firm, address, phone, email, id]
    )
    return result.rows[0]
  }

  /**
   * Soft delete surveyor
   */
  static async delete(id) {
    const result = await db.query(
      'UPDATE surveyors SET is_active = false WHERE id = $1 RETURNING *',
      [id]
    )
    return result.rows[0]
  }
}

export default Surveyor
