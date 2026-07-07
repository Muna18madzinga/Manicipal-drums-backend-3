import db from '../config/db.js'

export default {
  async findById(id) {
    const result = await db.query(
      'SELECT * FROM layers WHERE id = $1',
      [id]
    )
    return result.rows[0]
  },

  async findByProject(projectId) {
    const result = await db.query(
      'SELECT * FROM layers WHERE project_id = $1 ORDER BY created_at DESC',
      [projectId]
    )
    return result.rows
  },

  async create({ name, projectId, layerType = 'generic', geomType = null, srid = null, params = null }) {
    const result = await db.query(
      'INSERT INTO layers (name, project_id, layer_type, geom_type, srid, params) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [name, projectId, layerType, geomType, srid, params]
    )
    return result.rows[0]
  },

  async update(id, { name, layerType, geomType, srid, params }) {
    const result = await db.query(
      'UPDATE layers SET name = $1, layer_type = $2, geom_type = $3, srid = $4, params = $5, updated_at = NOW() WHERE id = $6 RETURNING *',
      [name, layerType, geomType, srid, params, id]
    )
    return result.rows[0]
  },

  async delete(id) {
    await db.query('DELETE FROM layers WHERE id = $1', [id])
  }
}