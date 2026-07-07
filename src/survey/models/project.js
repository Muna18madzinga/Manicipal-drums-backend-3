import db from '../config/db.js'

export default {
  async findById(id) {
    const result = await db.query(
      'SELECT * FROM projects WHERE id = $1',
      [id]
    )
    return result.rows[0]
  },

  async findByUser(userId) {
    const result = await db.query(
      'SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    )
    return result.rows
  },

  async create({ name, userId, code = null, description = null }) {
    const result = await db.query(
      'INSERT INTO projects (name, user_id, code, description) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, userId, code, description]
    )
    return result.rows[0]
  },

  async update(id, { name, code, description }) {
    const result = await db.query(
      'UPDATE projects SET name = $1, code = $2, description = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
      [name, code, description, id]
    )
    return result.rows[0]
  },

  async delete(id) {
    await db.query('DELETE FROM projects WHERE id = $1', [id])
  }
}