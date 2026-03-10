const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres@localhost:5432/vungu_master_db'
});

async function testConnection() {
  try {
    const client = await pool.connect();
    console.log('Connected to database');
    
    const result = await client.query(`
      SELECT u.id, u.email, u.password_hash, u.full_name as name, u.status, 
             uo.role, o.name as organization_name
      FROM users u
      LEFT JOIN user_organizations uo ON u.id = uo.user_id
      LEFT JOIN organizations o ON uo.organization_id = o.id
      WHERE u.email = $1 AND u.status = 'active'
    `, ['admin@vungu.gov.zw']);
    
    console.log('Query result:', result.rows);
    client.release();
  } catch (error) {
    console.error('Database error:', error);
  } finally {
    await pool.end();
  }
}

testConnection();
