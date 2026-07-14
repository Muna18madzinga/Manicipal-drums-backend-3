import bcrypt from 'bcryptjs'
import db from '../config/db.js'

// User model with database operations
export default {
  async findByEmail(email) {
    const result = await db.query(
      'SELECT * FROM users WHERE email = $1 LIMIT 1',
      [email]
    )
    return result.rows[0]
  },

  async create({ email, password, userType = 'registered_surveyor' }) {
    const salt = await bcrypt.genSalt(10)
    const hash = await bcrypt.hash(password, salt)

    const result = await db.query(
      'INSERT INTO users (email, password_hash, user_type) VALUES ($1, $2, $3) RETURNING id, email, user_type',
      [email, hash, userType]
    )
    return result.rows[0]
  },

  async verifyPassword(password, hash) {
    return bcrypt.compare(password, hash)
  }
}