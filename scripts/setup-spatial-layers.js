const { Pool } = require('pg')
const pool = new Pool({
  host: 'localhost', port: 5432,
  database: 'vungu_master_db_v1',
  user: 'postgres', password: 'cairo2025'
})

async function setup() {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS spatial_layers (
        id SERIAL PRIMARY KEY,
        table_name VARCHAR(255) UNIQUE NOT NULL,
        display_name VARCHAR(255) NOT NULL,
        geometry_type VARCHAR(50) DEFAULT 'point',
        description TEXT,
        style_config JSONB DEFAULT '{}',
        is_visible BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `)
    console.log('spatial_layers table created')

    const tables = await client.query(
      "SELECT f_table_name, type FROM geometry_columns WHERE f_table_schema = 'public'"
    )
    console.log('Found ' + tables.rows.length + ' PostGIS tables:')
    tables.rows.forEach(r => console.log('  - ' + r.f_table_name + ' (' + r.type + ')'))

    for (const row of tables.rows) {
      const t = (row.type || '').toLowerCase()
      const geomType = t.includes('point') ? 'point' : t.includes('line') ? 'line' : t.includes('polygon') ? 'polygon' : 'point'
      const displayName = row.f_table_name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      await client.query(
        `INSERT INTO spatial_layers (table_name, display_name, geometry_type, description, is_visible)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (table_name) DO UPDATE SET display_name = EXCLUDED.display_name, geometry_type = EXCLUDED.geometry_type`,
        [row.f_table_name, displayName, geomType, 'Auto-registered ' + geomType + ' layer']
      )
    }
    console.log('All PostGIS tables registered')

    const result = await client.query('SELECT table_name, display_name, geometry_type, is_visible FROM spatial_layers ORDER BY display_name')
    console.table(result.rows)
  } catch (err) {
    console.error('Error:', err.message)
  } finally {
    client.release()
    pool.end()
  }
}

setup()
